/**
 * Runs a Shopify order backfill.
 *
 *   node scripts/backfill-shopify.mts --dry-run     fetch one page, write nothing
 *   node scripts/backfill-shopify.mts --dry-run --pages 3
 *   node scripts/backfill-shopify.mts               full backfill
 *   node scripts/backfill-shopify.mts --since 2026-01-01
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
import { decryptToken } from "../lib/connectors/crypto.ts";
import { ShopifyClient, fetchConnectionPage } from "../lib/connectors/shopify/client.ts";
import { ORDERS_QUERY, updatedSinceQuery } from "../lib/connectors/shopify/queries.ts";
import { normaliseOrderBatch } from "../lib/connectors/shopify/normalise.ts";
import { buildShopifyOrdersSyncJob } from "../lib/connectors/shopify/sync.ts";
import { createSupabaseSyncStore } from "../lib/connectors/supabase-sync-store.ts";
import { runSync } from "../lib/connectors/sync-runner.ts";
import { createShopifyRepository } from "../lib/repositories/shopify-repository.ts";
import { money, sum } from "../lib/financial/money.ts";
import type { ShopifyOrderNode } from "../lib/connectors/shopify/types.ts";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const readOption = (name: string): string | null => {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] ?? null);
};
const since = readOption("--since");
const dryRunPages = Number(readOption("--pages") ?? 1);
const pageSize = Number(readOption("--page-size") ?? 50);

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
console.log(`since     : ${since ?? "(all history)"}`);
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
      { cursor, query: updatedSinceQuery(since), pageSize },
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

  const missingVariant = included.flatMap((order) => order.lines).filter((line) => line.variantId === null);
  if (missingVariant.length > 0) {
    console.log(`\n${missingVariant.length} line(s) have no variant id — SKU reporting would be incomplete.`);
  }

  const zeroLines = included.filter((order) => order.lines.length === 0);
  if (zeroLines.length > 0) {
    console.log(`${zeroLines.length} order(s) have no line items.`);
  }

  console.log("\nNothing was written. Re-run without --dry-run to persist.");
  process.exit(0);
}

const supabase = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL", env),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY", env),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const totals = { orders: 0, orderLines: 0, refunds: 0, customers: 0, unresolvedVariants: 0 };

const job = buildShopifyOrdersSyncJob({
  client,
  repository: createShopifyRepository(supabase, { organisationId }),
  connectionId: connection.connectionId,
  businessTimezone: connection.businessTimezone,
  updatedSince: since,
  // Re-running the same discriminator is deliberately a no-op. Change it to force a re-read.
  jobDiscriminator: `backfill-${since ?? "all"}`,
  pageSize,
  onPagePersisted: (result) => {
    totals.orders += result.orders;
    totals.orderLines += result.orderLines;
    totals.refunds += result.refunds;
    totals.customers += result.customers;
    totals.unresolvedVariants += result.unresolvedVariants;
    process.stdout.write(`  +${result.orders} orders (${totals.orders} total)\n`);
  },
});

const outcome = await runSync(job, createSupabaseSyncStore(supabase));

console.log(`\nstatus: ${outcome.status}`);
if (outcome.status === "skipped") {
  console.log("This job key already succeeded. Pass a different --since to run a new window.");
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
