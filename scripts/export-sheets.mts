/**
 * Writes the Google Sheets workbook.
 *
 * The same code path the nightly job uses, so a workbook produced by hand and one produced
 * overnight cannot differ.
 *
 *   npm run export:sheets                                  # last 90 days
 *   npm run export:sheets -- --from 2026-01-01 --to 2026-08-31
 *   npm run export:sheets -- --dry-run                      # build the tabs, write nothing
 *
 * Required in .env.local: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY,
 * GOOGLE_SHEETS_SPREADSHEET_ID.
 *
 * The service account has no access to anything by default. **Share the spreadsheet with its
 * email address as an Editor** — that step is invisible from the Google Cloud console and is the
 * usual cause of a 403 here.
 */

import { createClient } from "@supabase/supabase-js";
import { connect, loadEnvFile, printTable, requireEnv } from "./lib/db.mjs";
import { exportToSheets } from "@/lib/reporting/sheets-export";
import { buildWorkbook } from "@/lib/reporting/sheets-workbook";
import { buildReport } from "@/lib/reporting/report";
import { createReportingRepository } from "@/lib/reporting/reporting-repository";
import { addDays, toBusinessDate } from "@/lib/financial/dates";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const env = loadEnvFile();
const organisationId = requireEnv("ORGANISATION_ID", env);

const db = await connect();
let businessTimezone: string;
try {
  const { rows } = await db.query("select business_timezone from public.organisations where id = $1", [
    organisationId,
  ]);
  if (rows.length === 0) throw new Error(`ORGANISATION_ID ${organisationId} matches no organisation`);
  businessTimezone = rows[0].business_timezone;
} finally {
  await db.end();
}

const today = toBusinessDate(new Date(), businessTimezone);
const range = { from: flag("from") ?? addDays(today, -89), to: flag("to") ?? today };

const supabase = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL", env),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY", env),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

console.log(`Sheets export  ${range.from} → ${range.to}`);

if (dryRun) {
  const repository = createReportingRepository(supabase, { organisationId, businessTimezone });
  const policy = await repository.loadPolicy();

  if (policy.status === "not_approved") {
    console.error("The financial policy is not approved, so nothing would be exported.");
    for (const missing of policy.missing) console.error(`  outstanding: ${missing}`);
    process.exit(1);
  }

  const report = buildReport(await repository.loadFacts(range, policy.policy));
  const tabs = buildWorkbook({ report, generatedAt: new Date().toISOString(), today });

  printTable(tabs.map((tab) => ({ tab: tab.title, rows: tab.rows.length })));
  console.log("\nNothing written. Re-run without --dry-run to export.");
  process.exit(0);
}

const result = await exportToSheets(supabase, {
  organisationId,
  businessTimezone,
  today,
  range,
  spreadsheetId: requireEnv("GOOGLE_SHEETS_SPREADSHEET_ID", env),
  credentials: {
    clientEmail: requireEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL", env),
    privateKey: requireEnv("GOOGLE_PRIVATE_KEY", env),
  },
});

if (result.status === "not_approved") {
  console.error("Nothing exported: the financial policy is not approved.");
  for (const missing of result.missing) console.error(`  outstanding: ${missing}`);
  process.exit(1);
}

console.log(`Wrote ${result.cellsWritten} cells across ${result.tabs.length} tab(s).`);
if (result.created.length > 0) console.log(`  created: ${result.created.join(", ")}`);
console.log("\nTabs are protected with a warning, not a lock: an accidental edit is what this");
console.log("guards against, and a hard lock would shut the owner out of their own workbook.");
