/**
 * Records supplier lead time and reorder points per variant.
 *
 * Without a lead time no reorder alert can fire at all. `isReorderNeeded` flags a variant when
 * its days of cover fall to or below the lead time — the point at which ordering today still
 * arrives before stock runs out. With the field empty that comparison never runs, so a SKU
 * heading for a stockout looks fine right up until it is one.
 *
 * A reorder point in units is optional and left null by default. The lead-time rule adapts to
 * how fast a SKU is actually selling; a fixed unit threshold does not, and setting both means
 * whichever triggers first wins.
 *
 *   node scripts/seed-inventory-settings.mjs --lead-time 28
 *   node scripts/seed-inventory-settings.mjs --lead-time 28 --sku 0001 --reorder-point 150
 *   node scripts/seed-inventory-settings.mjs --list
 */

import { connect, loadEnvFile, printTable, requireEnv } from "./lib/db.mjs";

const argv = process.argv.slice(2);
const listOnly = argv.includes("--list");
const flag = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const leadTime = flag("lead-time");
const reorderPoint = flag("reorder-point");
const sku = flag("sku");
const supplier = flag("supplier");

if (!listOnly && leadTime === undefined) {
  console.error("Usage: node scripts/seed-inventory-settings.mjs --lead-time <days> [--sku X] [--reorder-point N]");
  console.error("       node scripts/seed-inventory-settings.mjs --list");
  process.exit(1);
}
if (!listOnly && !Number.isInteger(Number(leadTime))) {
  console.error(`--lead-time must be a whole number of days, got "${leadTime}".`);
  process.exit(1);
}

const env = loadEnvFile();
const organisationId = requireEnv("ORGANISATION_ID", env);
const client = await connect();

try {
  if (listOnly) {
    const current = await client.query(
      `select coalesce(v.sku, v.external_id) as variant,
              s.supplier_lead_time_days as lead_time_days,
              coalesce(s.reorder_point_units::text, '(none)') as reorder_point,
              coalesce(s.supplier_name, '(unnamed)') as supplier,
              s.effective_from::text
       from public.product_variants v
       left join public.variant_inventory_settings s
         on s.variant_id = v.id and s.effective_to is null
       where v.organisation_id = $1
       order by variant`,
      [organisationId],
    );
    console.log("--- inventory settings ---");
    printTable(current.rows);
    process.exit(0);
  }

  const variants = await client.query(
    `select id, coalesce(sku, external_id) as label from public.product_variants
     where organisation_id = $1 and ($2::text is null or sku = $2)`,
    [organisationId, sku ?? null],
  );
  if (variants.rows.length === 0) {
    console.error(sku ? `No variant with SKU "${sku}".` : "No product variants. Run the Shopify catalogue sync first.");
    process.exit(1);
  }

  // Dated from first trade so the setting resolves on any as-of date the engine is asked
  // about, rather than only on dates after it happened to be entered.
  const firstTrade = await client.query(
    `select coalesce(to_char(min(ordered_at), 'YYYY-MM-DD'), to_char(now(), 'YYYY-MM-DD')) as from_date
     from public.shopify_orders where organisation_id = $1`,
    [organisationId],
  );
  const effectiveFrom = firstTrade.rows[0].from_date;

  await client.query("begin");

  for (const variant of variants.rows) {
    await client.query(
      `insert into public.variant_inventory_settings
         (organisation_id, variant_id, reorder_point_units, supplier_lead_time_days, supplier_name, effective_from)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (variant_id, effective_from)
       do update set reorder_point_units = excluded.reorder_point_units,
                     supplier_lead_time_days = excluded.supplier_lead_time_days,
                     supplier_name = coalesce(excluded.supplier_name, variant_inventory_settings.supplier_name),
                     updated_at = now()`,
      [
        organisationId,
        variant.id,
        reorderPoint === undefined ? null : Number(reorderPoint),
        Number(leadTime),
        supplier ?? null,
        effectiveFrom,
      ],
    );
  }

  await client.query("commit");

  console.log(`Set a ${leadTime}-day supplier lead time on ${variants.rows.length} variant(s), effective ${effectiveFrom}.`);
  if (reorderPoint !== undefined) console.log(`Reorder point: ${reorderPoint} units.`);
  console.log("\nA variant is now flagged for reorder when its days of cover fall to or below");
  console.log(`${leadTime} days — the point at which ordering today still beats the stockout.`);

  const check = await client.query(
    `select coalesce(v.sku, v.external_id) as variant, s.supplier_lead_time_days as lead_time_days,
            coalesce(s.reorder_point_units::text, '(none)') as reorder_point
     from public.variant_inventory_settings s
     join public.product_variants v on v.id = s.variant_id
     where s.organisation_id = $1 and s.effective_to is null order by variant`,
    [organisationId],
  );
  console.log("");
  printTable(check.rows);
} catch (error) {
  await client.query("rollback").catch(() => {});
  console.error(`Failed, rolled back: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
