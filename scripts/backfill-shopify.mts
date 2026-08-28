/**
 * Runs a Shopify order backfill.
 *
 *   npm run backfill:shopify -- --dry-run     fetch one page, write nothing
 *   npm run backfill:shopify -- --dry-run --pages 3
 *   npm run backfill:shopify                  full backfill
 *   npm run backfill:shopify -- --since 2026-01-01
 *   npm run backfill:shopify -- --created-since 2026-01-01 --force   re-read after a fix
 *
 * Run through tsx. The library uses extensionless imports and the `@/` alias, which is
 * bundler-style resolution that Node's own ESM resolver does not implement — and its
 * strip-only TypeScript mode additionally rejects the parameter properties in
 * ShopifyClient. tsx handles both, so these scripts import exactly as the rest of the
 * codebase does.
 *
 * Start with --dry-run. It exercises the whole read path — auth, paging, normalisation —
 * and prints what the numbers come out as, without putting anything in the database. The
 * first contact with a real store is where assumptions about the data get tested, and a
 * dry run makes that cheap to look at and free to abandon.
 *
 * The credential is read from integration_tokens and decrypted in memory. It is never
 * printed and never written anywhere.
 */

import { createClient } from "@supabase/supabase-js";
import { connect, loadEnvFile, requireEnv } from "./lib/db.mjs";
import { decryptToken } from "@/lib/connectors/crypto";
import { ShopifyClient, fetchConnectionPage } from "@/lib/connectors/shopify/client";
import { ORDERS_QUERY, createdSinceQuery, updatedSinceQuery } from "@/lib/connectors/shopify/queries";
import { normaliseOrderBatch, type OrderTotalMismatch } from "@/lib/connectors/shopify/normalise";
import { buildShopifyOrdersSyncJob, buildShopifyVariantsSyncJob } from "@/lib/connectors/shopify/sync";
import { createSupabaseSyncStore } from "@/lib/connectors/supabase-sync-store";
import { runSync } from "@/lib/connectors/sync-runner";
import { createShopifyRepository } from "@/lib/repositories/shopify-repository";
import { sum } from "@/lib/financial/money";
import type { ShopifyOrderNode } from "@/lib/connectors/shopify/types";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const readOption = (name: string): string | null => {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] ?? null);
};
const since = readOption("--since");
const createdSince = readOption("--created-since");
const dryRunPages = Number(readOption("--pages") ?? 1);
const pageSize = Number(readOption("--page-size") ?? 50);

if (since && createdSince) {
  console.error("Pass either --since (updated_at) or --created-since, not both.");
  process.exit(1);
}

/** `created_at` bounds a period of trading; `updated_at` drives incremental resumption. */
const searchQuery = createdSince ? createdSinceQuery(createdSince) : updatedSinceQuery(since);
const windowLabel = createdSince ? `created since ${createdSince}` : (since ?? "(all history)");

const env = loadEnvFile();
const organisationId = requireEnv("ORGANISATION_ID", env);
const encryptionKey = requireEnv("TOKEN_ENCRYPTION_KEY", env);

/** Reads the stored connection and its decrypted token. */
async function loadConnection() {
  const db = await connect();
  try {
    const { rows } = await db.query(
      `select c.id, c.external_account_id, c.status, t.encrypted_refresh_token
       from public.integration_connections c
       join public.integration_tokens t on t.connection_id = c.id
       where c.organisation_id = $1 and c.provider = 'shopify'
       order by c.created_at
       limit 1`,
      [organisationId],
    );
    if (rows.length === 0) {
      throw new Error("No Shopify connection found. Run scripts/register-shopify-connection.mts first.");
    }
    const row = rows[0];
    const { rows: orgRows } = await db.query(
      "select business_timezone from public.organisations where id = $1",
      [organisationId],
    );
    return {
      connectionId: row.id as string,
      shopDomain: row.external_account_id as string,
      accessToken: decryptToken(row.encrypted_refresh_token as Buffer, encryptionKey),
      businessTimezone: orgRows[0].business_timezone as string,
    };
  } finally {
    await db.end();
  }
}

const connection = await loadConnection();
const client = new ShopifyClient({
  shopDomain: connection.shopDomain,
  accessToken: connection.accessToken,
});

console.log(`store     : ${connection.shopDomain}`);
console.log(`timezone  : ${connection.businessTimezone}`);
console.log(`window    : ${windowLabel}`);
console.log(`mode      : ${dryRun ? `dry run, up to ${dryRunPages} page(s)` : "write"}\n`);

if (dryRun) {
  let cursor: string | null = null;
  let page = 0;
  const collected: ShopifyOrderNode[] = [];

  do {
    // Annotated because `cursor` is both an input here and assigned from the result, which
    // TypeScript reads as a circular inference.
    const result: { nodes: ShopifyOrderNode[]; nextCursor: string | null } = await fetchConnectionPage<ShopifyOrderNode>(
      client,
      ORDERS_QUERY,
      { cursor, query: searchQuery, pageSize },
      (data) => data.orders,
    );
    page += 1;
    collected.push(...result.nodes);
    console.log(`page ${page}: ${result.nodes.length} order(s)`);
    cursor = result.nextCursor;
  } while (cursor !== null && page < dryRunPages);

  if (collected.length === 0) {
    console.log("\nNo orders returned.");
    console.log("If the store has orders older than 60 days, this is what a missing");
    console.log("read_all_orders scope looks like: a clean response containing nothing.");
    process.exit(0);
  }

  const batch = normaliseOrderBatch(collected, { businessTimezone: connection.businessTimezone });
  const included = batch.orders.filter((order) => !order.isExcluded);

  const dates = included.map((order) => order.businessDate).sort();
  const grossSales = sum(included.map((order) => order.grossSales));
  const discounts = sum(included.map((order) => order.discounts));
  const shipping = sum(included.map((order) => order.shippingRevenue));
  const refunds = sum(batch.refunds.map((refund) => refund.amount));
  const netRevenue = grossSales.minus(discounts).plus(shipping).minus(refunds);

  console.log(`\nfetched          : ${collected.length} order(s)`);
  console.log(`excluded         : ${batch.orders.length - included.length} (test or cancelled)`);
  console.log(`date range       : ${dates[0] ?? "n/a"} to ${dates[dates.length - 1] ?? "n/a"}`);
  console.log(`new customers    : ${included.filter((order) => order.isNewCustomerOrder).length}`);
  console.log(`refunds          : ${batch.refunds.length}`);
  console.log("\nVAT-exclusive, for the orders fetched above only:");
  console.log(`  gross sales    : ${grossSales.toFixed(2)}`);
  console.log(`  discounts      : ${discounts.toFixed(2)}`);
  console.log(`  shipping       : ${shipping.toFixed(2)}`);
  console.log(`  refunds        : ${refunds.toFixed(2)}`);
  console.log(`  net revenue    : ${netRevenue.toFixed(2)}`);

  const allLines = included.flatMap((order) => order.lines);
  const missingVariant = allLines.filter((line) => line.variantId === null);
  const missingSku = allLines.filter((line) => line.sku === null || line.sku === "");
  if (missingVariant.length > 0) {
    console.log(
      `\n${missingVariant.length} of ${allLines.length} line(s) have no variant id — SKU reporting would be incomplete.`,
    );
  }
  if (missingSku.length > 0) {
    console.log(`${missingSku.length} of ${allLines.length} line(s) have no SKU.`);
  }

  const withShipping = collected.filter((node) => Number(node.totalShippingPriceSet.shopMoney.amount) > 0);
  console.log(`${withShipping.length} of ${collected.length} order(s) charged shipping at source.`);

  // Dumps what Shopify actually returned, so an unexpected figure can be traced to the
  // payload rather than guessed at. The query requests no personal data — a customer is
  // only ever an id.
  if (argv.includes("--sample")) {
    const count = Number(readOption("--sample") ?? 1);
    console.log(`\n--- raw payload, first ${count} order(s) ---`);
    console.log(JSON.stringify(collected.slice(0, count), null, 2));
  }

  const zeroLines = included.filter((order) => order.lines.length === 0);
  if (zeroLines.length > 0) {
    console.log(`${zeroLines.length} order(s) have no line items.`);
  }

  // The arithmetic that says the money fields are being read correctly. A dry run is exactly
  // where this belongs: it is cheaper to find a misread field here than in published margin.
  if (batch.totalMismatches.length > 0) {
    console.log(`\n${batch.totalMismatches.length} order(s) do not add back to what Shopify charged:`);
    for (const mismatch of batch.totalMismatches.slice(0, 10)) {
      console.log(
        `  ${mismatch.name} ${mismatch.businessDate}: derived ${mismatch.derived.toFixed(2)} vs charged ` +
          `${mismatch.charged.toFixed(2)} (${mismatch.difference.toFixed(2)})`,
      );
    }
    console.log("A positive difference means revenue is being overstated.");
  } else {
    console.log("\nEvery order's parts add back to the total Shopify charged.");
  }

  console.log("\nNothing was written. Re-run without --dry-run to persist.");
  process.exit(0);
}

const supabase = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL", env),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY", env),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const repository = createShopifyRepository(supabase, { organisationId });
const store = createSupabaseSyncStore(supabase);

// The catalogue goes first. Order lines resolve their variant against product_variants, so
// running orders into an empty catalogue writes every line unattributed — and the order job
// key would then be marked succeeded, so a corrective re-run would be skipped.
if (!argv.includes("--skip-catalogue")) {
  console.log("--- product catalogue ---");
  const catalogueTotals = { products: 0, variants: 0, inventorySnapshots: 0, variantsWithoutProduct: 0 };

  const catalogueOutcome = await runSync(
    buildShopifyVariantsSyncJob({
      client,
      repository,
      connectionId: connection.connectionId,
      jobDiscriminator: new Date().toISOString().slice(0, 10),
      pageSize,
      onPagePersisted: (result) => {
        catalogueTotals.products += result.products;
        catalogueTotals.variants += result.variants;
        catalogueTotals.inventorySnapshots += result.inventorySnapshots;
        catalogueTotals.variantsWithoutProduct += result.variantsWithoutProduct;
      },
    }),
    store,
  );

  console.log(`status: ${catalogueOutcome.status}`);
  if (catalogueOutcome.status === "failed") {
    console.log(`  ${catalogueOutcome.error.message}`);
    console.log("\nStopping: orders would be written with no variant attribution.");
    process.exit(1);
  }
  console.log(`  products ${catalogueTotals.products}, variants ${catalogueTotals.variants}`);
  console.log(`  inventory snapshots ${catalogueTotals.inventorySnapshots}`);
  if (catalogueTotals.variantsWithoutProduct > 0) {
    console.log(`  ${catalogueTotals.variantsWithoutProduct} variant(s) had no product and were not written.`);
  }
  console.log("");
}

console.log("--- orders ---");
const totals = { orders: 0, orderLines: 0, refunds: 0, customers: 0, unresolvedVariants: 0 };
const totalMismatches: OrderTotalMismatch[] = [];

// Re-running the same discriminator is deliberately a no-op: that is what makes a retried
// cron safe. But a connector fix has to be able to restate history it already imported, and
// inventing a slightly different --created-since to dodge the job key would misdescribe the
// window that ran. `--force` says so honestly, in the job key itself.
const baseDiscriminator = `backfill-${createdSince ? `created-${createdSince}` : (since ?? "all")}`;
const discriminator = argv.includes("--force")
  ? `${baseDiscriminator}-force-${new Date().toISOString().replace(/[:.]/g, "-")}`
  : baseDiscriminator;

if (argv.includes("--force")) {
  console.log("Forcing a re-read. Orders upsert on their Shopify id, so this restates rather");
  console.log("than duplicates — use it after a connector fix, not for routine runs.\n");
}

const job = buildShopifyOrdersSyncJob({
  client,
  repository,
  connectionId: connection.connectionId,
  businessTimezone: connection.businessTimezone,
  updatedSince: since,
  createdSince,
  jobDiscriminator: discriminator,
  pageSize,
  onPagePersisted: (result) => {
    totals.orders += result.orders;
    totals.orderLines += result.orderLines;
    totals.refunds += result.refunds;
    totals.customers += result.customers;
    totals.unresolvedVariants += result.unresolvedVariants;
    totalMismatches.push(...result.totalMismatches);
    process.stdout.write(`  +${result.orders} orders (${totals.orders} total)\n`);
  },
});

const outcome = await runSync(job, store);

console.log(`\nstatus: ${outcome.status}`);
if (outcome.status === "skipped") {
  console.log("This job key already succeeded. Pass --force to re-read the same window.");
} else if (outcome.status === "failed") {
  console.log(`  ${outcome.error.message}`);
  console.log(`  pages ${outcome.pages}, received ${outcome.received}, written ${outcome.written}`);
  process.exitCode = 1;
} else {
  console.log(`  pages ${outcome.pages}, received ${outcome.received}, written ${outcome.written}`);
}

console.log(`\norders written   : ${totals.orders}`);
console.log(`order lines      : ${totals.orderLines}`);
console.log(`refunds          : ${totals.refunds}`);
console.log(`customers seen   : ${totals.customers}`);
if (totals.unresolvedVariants > 0) {
  console.log(`\n${totals.unresolvedVariants} line(s) written with no variant id.`);
  console.log("SKU-level reporting is incomplete until the product catalogue is synced.");
}

// Written, then reported. Withholding the rows would lose the orders as well as the warning;
// exiting non-zero is what stops a mismatch being mistaken for a clean run.
if (totalMismatches.length > 0) {
  console.log(`\n${totalMismatches.length} order(s) do not add back to what Shopify charged:`);
  for (const mismatch of totalMismatches.slice(0, 10)) {
    console.log(
      `  ${mismatch.name} ${mismatch.businessDate}: derived ${mismatch.derived.toFixed(2)} vs charged ` +
        `${mismatch.charged.toFixed(2)} (${mismatch.difference.toFixed(2)})`,
    );
  }
  console.log("These rows are written but a money field is being read wrongly. Do not publish.");
  process.exitCode = 1;
}
