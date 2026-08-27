/**
 * Read-only report of tenant state: the organisation, its unapproved policy settings, its
 * provider connections, and how much data has landed.
 *
 * Confirms that ORGANISATION_ID in .env.local points at a row that actually exists, which
 * is the difference between a sync writing to the intended tenant and failing on a foreign
 * key at the first insert.
 *
 *   node scripts/show-tenant.mjs
 */

import { connect, loadEnvFile, printTable } from "./lib/db.mjs";

const env = loadEnvFile();
const client = await connect();

try {
  console.log("--- organisations ---");
  const organisations = await client.query(
    "select id, name, reporting_currency, business_timezone from public.organisations order by name",
  );
  printTable(organisations.rows);

  const configured = env.ORGANISATION_ID;
  console.log("");
  if (!configured) {
    console.log("ORGANISATION_ID is not set in .env.local.");
  } else if (organisations.rows.some((row) => row.id === configured)) {
    console.log(`ORGANISATION_ID ${configured} resolves to an existing organisation.`);
  } else {
    console.log(`ORGANISATION_ID ${configured} does NOT match any organisation row.`);
    process.exitCode = 1;
  }

  console.log("\n--- business_settings ---");
  const settings = await client.query(`
    select financial_policy_status as policy_status,
           coalesce(vat_treatment, '(not decided)') as vat_treatment,
           coalesce(new_customer_definition, '(not decided)') as new_customer,
           coalesce(inventory_sales_window_days::text, '(not decided)') as inventory_window
    from public.business_settings
  `);
  printTable(settings.rows);

  console.log("\n--- integration_connections ---");
  const connections = await client.query(
    "select provider, external_account_id, status, last_success_at from public.integration_connections order by provider",
  );
  printTable(connections.rows);

  console.log("\n--- catalogue ---");
  const variants = await client.query(`
    select v.external_id, coalesce(v.sku, '(no sku)') as sku, coalesce(v.title, p.title) as title, v.active
    from public.product_variants v
    join public.products p on p.id = v.product_id
    order by sku
  `);
  printTable(variants.rows);

  // The window costs must be dated from. Applying today's approved cost to trading that
  // predates it would restate history against an assumption nobody approved at the time.
  console.log("\n--- trading window ---");
  const window = await client.query(`
    select to_char(min(ordered_at at time zone o.business_timezone), 'YYYY-MM-DD') as first_order,
           to_char(max(ordered_at at time zone o.business_timezone), 'YYYY-MM-DD') as last_order,
           count(*) as orders,
           count(distinct customer_id) as customers
    from public.shopify_orders s
    cross join (select business_timezone from public.organisations limit 1) o
  `);
  printTable(window.rows);

  // What the engine will actually count, versus everything that was imported. A backfill
  // reporting "285 written" says only that 285 rows arrived, not that 285 are reportable.
  console.log("\n--- orders by month ---");
  const byMonth = await client.query(
    `select to_char(ordered_at at time zone o.business_timezone, 'YYYY-MM') as month,
            count(*) as imported,
            count(*) filter (where s.is_test) as test,
            count(*) filter (where s.cancelled_at is not null) as cancelled,
            count(*) filter (where not s.is_test and s.cancelled_at is null) as reportable
     from public.shopify_orders s
     cross join (select business_timezone from public.organisations limit 1) o
     where s.organisation_id = $1
     group by 1 order by 1`,
    [configured],
  );
  printTable(byMonth.rows);

  const totals = byMonth.rows.reduce(
    (running, row) => ({
      imported: running.imported + Number(row.imported),
      test: running.test + Number(row.test),
      cancelled: running.cancelled + Number(row.cancelled),
      reportable: running.reportable + Number(row.reportable),
    }),
    { imported: 0, test: 0, cancelled: 0, reportable: 0 },
  );
  console.log(
    `\n  ${totals.imported} imported = ${totals.reportable} reportable + ${totals.test} test + ${totals.cancelled} cancelled`,
  );

  console.log("\n--- orders by financial status ---");
  const byStatus = await client.query(
    `select coalesce(financial_status, '(none)') as financial_status, count(*) as orders
     from public.shopify_orders where organisation_id = $1
     group by 1 order by 2 desc`,
    [configured],
  );
  printTable(byStatus.rows);

  console.log("\n--- row counts ---");
  const counts = await client.query(`
    select table_name,
           (xpath(
             '/row/c/text()',
             query_to_xml('select count(*) as c from public.' || quote_ident(table_name), false, true, '')
           ))[1]::text::bigint as rows
    from (values
      ('shopify_orders'), ('shopify_order_lines'), ('shopify_customers'),
      ('shopify_refunds'), ('shopify_refund_lines'), ('shopify_payouts'),
      ('products'), ('product_variants'), ('variant_cost_profiles'),
      ('cost_assumptions'), ('daily_financials'), ('sync_runs')
    ) as t(table_name)
    where to_regclass('public.' || quote_ident(table_name)) is not null
    order by table_name
  `);
  printTable(counts.rows);
} finally {
  await client.end();
}
