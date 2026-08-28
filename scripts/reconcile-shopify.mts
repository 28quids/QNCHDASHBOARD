/**
 * Reconciles what was stored against what Shopify reports, for a window.
 *
 * Reports differences; it never adjusts a figure to close a gap. A backfill that "succeeded"
 * says only that no request failed — this is what says the numbers arrived intact.
 *
 *   npm run reconcile:shopify -- --created-since 2026-01-01
 */

import { connect, loadEnvFile, printTable, requireEnv } from "./lib/db.mjs";
import { decryptToken } from "@/lib/connectors/crypto";
import { ShopifyClient, fetchConnectionPage } from "@/lib/connectors/shopify/client";
import { ORDERS_QUERY, createdSinceQuery } from "@/lib/connectors/shopify/queries";
import { normaliseOrderBatch } from "@/lib/connectors/shopify/normalise";
import { money, sum, ZERO } from "@/lib/financial/money";
import type { ShopifyOrderNode } from "@/lib/connectors/shopify/types";

const argv = process.argv.slice(2);
const readOption = (name: string): string | null => {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] ?? null);
};
const createdSince = readOption("--created-since") ?? "2026-01-01";

const env = loadEnvFile();
const organisationId = requireEnv("ORGANISATION_ID", env);
const encryptionKey = requireEnv("TOKEN_ENCRYPTION_KEY", env);

const db = await connect();

try {
  const { rows: connectionRows } = await db.query(
    `select c.external_account_id, t.encrypted_refresh_token
     from public.integration_connections c
     join public.integration_tokens t on t.connection_id = c.id
     where c.organisation_id = $1 and c.provider = 'shopify' limit 1`,
    [organisationId],
  );
  if (connectionRows.length === 0) throw new Error("No Shopify connection registered.");

  const client = new ShopifyClient({
    shopDomain: connectionRows[0].external_account_id as string,
    accessToken: decryptToken(connectionRows[0].encrypted_refresh_token as Buffer, encryptionKey),
  });

  const { rows: orgRows } = await db.query(
    "select business_timezone from public.organisations where id = $1",
    [organisationId],
  );
  const businessTimezone = orgRows[0].business_timezone as string;

  // Source of truth: read Shopify again rather than trusting the earlier run's totals.
  const collected: ShopifyOrderNode[] = [];
  let cursor: string | null = null;
  do {
    const page: { nodes: ShopifyOrderNode[]; nextCursor: string | null } =
      await fetchConnectionPage<ShopifyOrderNode>(
        client,
        ORDERS_QUERY,
        { cursor, query: createdSinceQuery(createdSince), pageSize: 100 },
        (data) => data.orders,
      );
    collected.push(...page.nodes);
    cursor = page.nextCursor;
  } while (cursor !== null);

  const batch = normaliseOrderBatch(collected, { businessTimezone });
  const included = batch.orders.filter((order) => !order.isExcluded);

  // Compared across every order written, not just the ones the engine counts. The tables
  // store source facts including test and cancelled orders; excluding them on one side only
  // would show a difference that is really a definition mismatch.
  const provider = {
    orders: collected.length,
    grossSales: sum(batch.orders.map((order) => order.grossSales)),
    discounts: sum(batch.orders.map((order) => order.discounts)),
    shipping: sum(batch.orders.map((order) => order.shippingRevenue)),
    refunds: sum(batch.refunds.map((refund) => refund.amount)),
  };

  const excludedValue = sum(
    batch.orders.filter((order) => order.isExcluded).map((order) => order.grossSales),
  );

  const { rows: storedRows } = await db.query(
    `select count(*)::int as orders,
            coalesce(sum(gross_sales), 0) as gross_sales,
            coalesce(sum(discounts), 0) as discounts,
            coalesce(sum(shipping_revenue), 0) as shipping,
            coalesce(sum(refunds), 0) as refunds
     from public.shopify_orders
     where organisation_id = $1 and ordered_at >= $2::date`,
    [organisationId, createdSince],
  );
  const stored = storedRows[0];

  // Stored figures cover every order written, including the test and cancelled ones the
  // engine excludes, so those are compared separately rather than silently netted off.
  const excludedCount = batch.orders.length - included.length;

  const comparisons = [
    { metric: "orders fetched", shopify: provider.orders, stored: stored.orders },
    { metric: "gross sales", shopify: provider.grossSales, stored: stored.gross_sales },
    { metric: "discounts", shopify: provider.discounts, stored: stored.discounts },
    { metric: "shipping revenue", shopify: provider.shipping, stored: stored.shipping },
    { metric: "refunds", shopify: provider.refunds, stored: stored.refunds },
  ];

  const TOLERANCE = money("0.01");
  const rows = comparisons.map(({ metric, shopify, stored: storedValue }) => {
    const a = money(shopify as never);
    const b = money(storedValue as never);
    const difference = b.minus(a);
    return {
      metric,
      shopify: a.toFixed(metric === "orders fetched" ? 0 : 2),
      stored: b.toFixed(metric === "orders fetched" ? 0 : 2),
      difference: difference.toFixed(metric === "orders fetched" ? 0 : 2),
      status: difference.abs().lessThanOrEqualTo(TOLERANCE) ? "matched" : "UNMATCHED",
    };
  });

  console.log(`window: orders created since ${createdSince}\n`);
  printTable(rows);

  console.log(`\n${excludedCount} order(s) are test or cancelled and excluded from the engine's figures.`);
  console.log("Stored sums cover every written order, so gross sales differ by those orders' value.");

  // Internal consistency: order lines must sum back to their order.
  const { rows: driftRows } = await db.query(
    `select o.external_id,
            o.gross_sales as order_gross,
            coalesce(sum(l.gross_sales), 0) as line_gross
     from public.shopify_orders o
     left join public.shopify_order_lines l on l.order_id = o.id
     where o.organisation_id = $1
     group by o.id, o.external_id, o.gross_sales
     having abs(o.gross_sales - coalesce(sum(l.gross_sales), 0)) > 0.01
     limit 10`,
    [organisationId],
  );

  console.log("");
  if (driftRows.length === 0) {
    console.log("Every order's lines sum back to its order total.");
  } else {
    console.log(`${driftRows.length} order(s) where lines do not sum to the order total:`);
    printTable(driftRows);
  }

  // Internal consistency is not enough: lines can sum to an order total that is itself wrong.
  // This compares the assembled figure against what the customer was actually charged.
  console.log("");
  if (batch.totalMismatches.length === 0) {
    console.log("Every order's gross, discounts, shipping and tax add back to the total charged.");
  } else {
    console.log(`${batch.totalMismatches.length} order(s) do not add back to the total charged:`);
    printTable(
      batch.totalMismatches.slice(0, 20).map((mismatch) => ({
        order: mismatch.name,
        date: mismatch.businessDate,
        derived: mismatch.derived.toFixed(2),
        charged: mismatch.charged.toFixed(2),
        difference: mismatch.difference.toFixed(2),
      })),
    );
    process.exitCode = 1;
  }

  const unmatched = rows.filter((row) => row.status === "UNMATCHED");
  if (unmatched.length > 0) process.exitCode = 1;
  void ZERO;
} finally {
  await db.end();
}
