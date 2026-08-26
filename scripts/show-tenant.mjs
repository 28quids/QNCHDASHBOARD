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
