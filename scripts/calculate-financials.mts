/**
 * Runs the financial engine over stored data and publishes the result.
 *
 * Start with `--dry-run`. It prints the whole contribution walk without writing anything, so
 * the figures can be checked against the Shopify admin before they are published anywhere.
 *
 *   npm run calculate -- --dry-run
 *   npm run calculate -- --from 2026-01-01 --to 2026-08-26
 *   npm run calculate                        # defaults to the last 30 days, and writes
 */

import { createClient } from "@supabase/supabase-js";
import { calculateAndPublish } from "@/lib/reporting/calculate";
import { addDays, toBusinessDate } from "@/lib/financial/dates";
import { loadEnvFile, requireEnv } from "./lib/db.mjs";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const env = loadEnvFile();
const organisationId = requireEnv("ORGANISATION_ID", env);
const client = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL", env),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY", env),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const { data: organisation, error } = await client
  .from("organisations")
  .select("name, business_timezone")
  .eq("id", organisationId)
  .maybeSingle();
if (error) throw error;
if (!organisation) throw new Error(`ORGANISATION_ID ${organisationId} does not match any organisation`);

const businessTimezone = organisation.business_timezone as string;
const today = toBusinessDate(new Date(), businessTimezone);
const range = { from: flag("from") ?? addDays(today, -29), to: flag("to") ?? today };

console.log(`${organisation.name}  ${range.from} → ${range.to}  (${businessTimezone})`);
console.log(dryRun ? "Dry run: nothing will be written.\n" : "");

const result = await calculateAndPublish(client, {
  organisationId,
  businessTimezone,
  range,
  dryRun,
});

if (result.status === "not_approved") {
  console.error("Financial policy is not approved, so nothing was calculated.\n");
  for (const item of result.missing) console.error(`  outstanding: ${item}`);
  console.error("\nRun `npm run seed:policy` once the decisions are agreed.");
  process.exit(1);
}

const { summary, marketing, skus, warnings } = result.report;
const gbp = (value: { toFixed: (dp: number) => string }) => `£${Number(value.toFixed(2)).toLocaleString("en-GB", { minimumFractionDigits: 2 })}`;
const pct = (value: { times: (n: number) => { toFixed: (dp: number) => string } } | null) =>
  value === null ? "     n/a" : `${value.times(100).toFixed(1)}%`.padStart(8);
const line = (label: string, value: string, margin = "") =>
  console.log(`  ${label.padEnd(28)}${value.padStart(14)}  ${margin}`);

console.log("--- contribution walk ---");
line("Gross sales", gbp(summary.grossSales));
line("Discounts", `-${gbp(summary.discounts)}`);
line("Shipping revenue", gbp(summary.shippingRevenue));
line("Refunds", `-${gbp(summary.refunds)}`);
line("Net revenue", gbp(summary.netRevenue));
console.log("");
line("CM1", gbp(summary.cm1), pct(summary.cm1Margin));
line("Advertising", `-${gbp(summary.advertisingSpend)}`);
line("CM2", gbp(summary.cm2), pct(summary.cm2Margin));
line("CM3", gbp(summary.cm3), pct(summary.cm3Margin));
line("Fixed operating", `-${gbp(summary.fixedOperatingCosts)}`);
line("Operating profit", gbp(summary.operatingProfit), pct(summary.operatingMargin));

console.log("\n--- trading ---");
line("Orders", String(summary.orders));
line("New customers", String(summary.newCustomers));
line("AOV", summary.averageOrderValue ? gbp(summary.averageOrderValue) : "n/a");

console.log("\n--- acquisition ---");
line("Ad spend", gbp(marketing.advertisingSpend));
line("MER", marketing.mer ? `${marketing.mer.toFixed(2)}x` : "n/a");
line("Blended CAC", marketing.blendedCac ? gbp(marketing.blendedCac) : "n/a");
line(`Maximum CAC (${marketing.contributionLevel})`, marketing.maximumCac ? gbp(marketing.maximumCac) : "n/a");
line("CAC headroom", marketing.cacHeadroom ? gbp(marketing.cacHeadroom) : "n/a");

if (skus.length > 0) {
  console.log("\n--- SKUs ---");
  for (const sku of skus) {
    line(sku.sku ?? sku.variantId ?? "(unattributed)", gbp(sku.netRevenue), `${sku.unitsSold} units`);
  }
}

if (warnings.length > 0) {
  console.log("\n--- warnings ---");
  for (const warning of warnings) console.log(`  ${warning.code}: ${warning.detail}`);
}

if (result.published) {
  console.log(
    `\nPublished ${result.published.dates} days as calculation version ${result.published.version}.`,
  );
} else {
  console.log("\nDry run — daily_financials was not written.");
}
