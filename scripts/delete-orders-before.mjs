/**
 * Deletes imported orders placed before a cutoff date.
 *
 * For when trading history belongs to a previous business and should not appear in QNCH
 * reporting at all. Leaving it in place and merely uncosted is the worse option: it reports
 * 100% contribution margin on revenue whose products no longer exist in the catalogue, and
 * silently inflates every all-time figure.
 *
 * Order lines, refunds and refund lines are removed by the foreign keys, which cascade.
 * Two things do not cascade and are handled explicitly:
 *
 *  - `shopify_customers.first_order_at` would still point at a deleted order, so a customer
 *    who bought from the old business and again from QNCH would read as returning rather
 *    than as an acquisition. It is reset to their earliest surviving order.
 *  - Customers left with no orders at all are removed, so they cannot be counted.
 *
 * This is destructive and cannot be undone from inside the application. Re-running the
 * Shopify backfill would bring the orders back, so the cutoff is the durable decision, not
 * this script.
 *
 *   node scripts/delete-orders-before.mjs 2025-08-01 --dry-run
 *   node scripts/delete-orders-before.mjs 2025-08-01
 */

import { connect, loadEnvFile, printTable, requireEnv } from "./lib/db.mjs";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const cutoff = argv.find((argument) => /^\d{4}-\d{2}-\d{2}$/.test(argument));

if (!cutoff) {
  console.error("Usage: node scripts/delete-orders-before.mjs <YYYY-MM-DD> [--dry-run]");
  console.error("Deletes every order placed strictly before that date.");
  process.exit(1);
}

const env = loadEnvFile();
const organisationId = requireEnv("ORGANISATION_ID", env);
const client = await connect();

try {
  const { rows: orgRows } = await client.query(
    "select name, business_timezone from public.organisations where id = $1",
    [organisationId],
  );
  if (orgRows.length === 0) throw new Error(`ORGANISATION_ID ${organisationId} matches no organisation`);
  const timezone = orgRows[0].business_timezone;

  // The cutoff is a business date, so it is compared in the organisation timezone. Comparing
  // in UTC would move orders placed late on the last evening across the boundary.
  const scope = `(s.ordered_at at time zone $2)::date < $3::date`;

  const preview = await client.query(
    `select to_char(ordered_at at time zone $2, 'YYYY') as year,
            count(*) as orders,
            sum(gross_sales)::numeric(19,2) as gross_sales
     from public.shopify_orders s
     where s.organisation_id = $1 and ${scope}
     group by 1 order by 1`,
    [organisationId, timezone, cutoff],
  );

  const affected = preview.rows.reduce((total, row) => total + Number(row.orders), 0);

  console.log(`${orgRows[0].name} — deleting orders placed before ${cutoff} (${timezone})\n`);

  if (affected === 0) {
    console.log("No orders fall before the cutoff. Nothing to do.");
    process.exit(0);
  }

  printTable(preview.rows);

  const related = await client.query(
    `select
       (select count(*) from public.shopify_order_lines l
         join public.shopify_orders s on s.id = l.order_id
         where s.organisation_id = $1 and ${scope}) as order_lines,
       (select count(*) from public.shopify_refunds r
         join public.shopify_orders s on s.id = r.order_id
         where s.organisation_id = $1 and ${scope}) as refunds`,
    [organisationId, timezone, cutoff],
  );
  console.log("\nRemoved by cascade:");
  printTable(related.rows);

  const orphans = await client.query(
    `select count(*) as customers_left_with_no_orders
     from public.shopify_customers c
     where c.organisation_id = $1
       and not exists (
         select 1 from public.shopify_orders s
         where s.customer_id = c.id and not (${scope})
       )
       and exists (select 1 from public.shopify_orders s where s.customer_id = c.id)`,
    [organisationId, timezone, cutoff],
  );
  printTable(orphans.rows);

  if (dryRun) {
    console.log("\nDry run — nothing deleted.");
    process.exit(0);
  }

  await client.query("begin");

  const deleted = await client.query(
    `delete from public.shopify_orders s
     where s.organisation_id = $1 and ${scope}`,
    [organisationId, timezone, cutoff],
  );

  // Re-derive acquisition dates from what survives. A stale first_order_at pointing at a
  // deleted order would make a genuine new customer read as returning, understating CAC.
  const rebased = await client.query(
    `update public.shopify_customers c
     set first_order_at = earliest.first_order_at
     from (
       select customer_id, min(ordered_at) as first_order_at
       from public.shopify_orders
       where organisation_id = $1 and customer_id is not null
         and not is_test and cancelled_at is null
       group by customer_id
     ) as earliest
     where c.id = earliest.customer_id
       and c.organisation_id = $1
       and c.first_order_at is distinct from earliest.first_order_at`,
    [organisationId],
  );

  const removedCustomers = await client.query(
    `delete from public.shopify_customers c
     where c.organisation_id = $1
       and not exists (select 1 from public.shopify_orders s where s.customer_id = c.id)`,
    [organisationId],
  );

  await client.query("commit");

  console.log(`\nDeleted ${deleted.rowCount} order(s).`);
  console.log(`Rebased first_order_at for ${rebased.rowCount} customer(s).`);
  console.log(`Removed ${removedCustomers.rowCount} customer(s) with no remaining orders.`);

  const remaining = await client.query(
    `select to_char(min(ordered_at at time zone $2), 'YYYY-MM-DD') as first_order,
            to_char(max(ordered_at at time zone $2), 'YYYY-MM-DD') as last_order,
            count(*) as orders
     from public.shopify_orders where organisation_id = $1`,
    [organisationId, timezone],
  );
  console.log("\n--- remaining ---");
  printTable(remaining.rows);

  const costFrom = await client.query(
    `select min(effective_from)::text as costs_effective_from from public.variant_cost_profiles where organisation_id = $1`,
    [organisationId],
  );
  const firstOrder = remaining.rows[0].first_order;
  const effectiveFrom = costFrom.rows[0].costs_effective_from;

  console.log("");
  if (effectiveFrom && firstOrder && effectiveFrom > firstOrder) {
    console.log(
      `WARNING: costs take effect ${effectiveFrom} but the earliest remaining order is ${firstOrder}.\n` +
        `Trading before ${effectiveFrom} will report no cost of goods. Re-run: npm run seed:policy`,
    );
    process.exitCode = 1;
  } else {
    console.log(`Costs take effect ${effectiveFrom}, on or before the earliest remaining order ${firstOrder}.`);
  }

  console.log("\ndaily_financials still holds figures calculated from the deleted orders.");
  console.log("Republish with: npm run calculate -- --from " + firstOrder + " --to <today>");
} catch (error) {
  await client.query("rollback").catch(() => {});
  console.error(`Failed, rolled back: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
