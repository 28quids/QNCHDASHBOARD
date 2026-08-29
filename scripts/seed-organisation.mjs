/**
 * Creates the QNCH organisation and its business settings row.
 *
 * Every table in the schema is keyed on organisation_id, so nothing can be written until
 * this row exists. Safe to run repeatedly: it creates the organisation only if there is
 * none with the same name, and leaves an existing settings row untouched.
 *
 * The policy fields on business_settings are deliberately left null and the status left at
 * 'draft'. Items 1-13 of docs/financial-policy-decision-register.md are not yet approved,
 * and a null reads as "not decided" everywhere in the engine, whereas a guessed default
 * would read as an approved decision nobody made.
 *
 *   node scripts/seed-organisation.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ORGANISATION_NAME = "QNCH";
const REPORTING_CURRENCY = "GBP";
const BUSINESS_TIMEZONE = "Europe/London";

function connectionString() {
  const line = readFileSync(join(ROOT, ".env.local"), "utf8")
    .split("\n")
    .find((candidate) => candidate.trim().startsWith("SUPABASE_DB_URL="));
  if (!line) throw new Error("SUPABASE_DB_URL not found in .env.local");
  return line.trim().slice("SUPABASE_DB_URL=".length).trim();
}

const client = new pg.Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  await client.query("begin");

  const existing = await client.query("select id, name from public.organisations where name = $1", [
    ORGANISATION_NAME,
  ]);

  let organisationId;
  if (existing.rows.length > 0) {
    organisationId = existing.rows[0].id;
    console.log(`Organisation "${ORGANISATION_NAME}" already exists: ${organisationId}`);
  } else {
    const created = await client.query(
      `insert into public.organisations (name, reporting_currency, business_timezone)
       values ($1, $2, $3)
       returning id`,
      [ORGANISATION_NAME, REPORTING_CURRENCY, BUSINESS_TIMEZONE],
    );
    organisationId = created.rows[0].id;
    console.log(`Created organisation "${ORGANISATION_NAME}": ${organisationId}`);
    console.log(`  reporting currency : ${REPORTING_CURRENCY}`);
    console.log(`  business timezone  : ${BUSINESS_TIMEZONE}`);
  }

  const settings = await client.query(
    `insert into public.business_settings (organisation_id)
     values ($1)
     on conflict (organisation_id) do nothing
     returning organisation_id`,
    [organisationId],
  );

  console.log(
    settings.rows.length > 0
      ? "Created business_settings (financial_policy_status = draft)"
      : "business_settings already exists — left unchanged",
  );

  await client.query("commit");

  const status = await client.query(
    `select financial_policy_status, vat_treatment, new_customer_definition, inventory_sales_window_days
     from public.business_settings where organisation_id = $1`,
    [organisationId],
  );

  console.log("\nCurrent policy state:");
  for (const [key, value] of Object.entries(status.rows[0])) {
    console.log(`  ${key.padEnd(28)} ${value ?? "(not decided)"}`);
  }

  console.log(`\nORGANISATION_ID=${organisationId}`);
  console.log("Add that to .env.local so the connector workers know which tenant to write to.");
} catch (error) {
  await client.query("rollback");
  console.error(`Failed, rolled back: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
