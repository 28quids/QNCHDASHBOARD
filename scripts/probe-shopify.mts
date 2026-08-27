/**
 * Diagnostic probe against the connected Shopify store.
 *
 * Answers questions a backfill cannot: which scopes actually took effect, whether the
 * product catalogue is readable, and whether the gaps seen in old orders are also present
 * in recent ones. A field that is null because a product was deleted and a field that is
 * null because a scope is missing look identical in a single order — comparing old against
 * recent separates them.
 *
 *   npm run probe:shopify
 */

import { connect, loadEnvFile, requireEnv } from "./lib/db.mjs";
import { decryptToken } from "@/lib/connectors/crypto";
import { ShopifyClient } from "@/lib/connectors/shopify/client";
import { SHOPIFY_API_VERSION } from "@/lib/connectors/shopify/queries";

const env = loadEnvFile();
const organisationId = requireEnv("ORGANISATION_ID", env);
const encryptionKey = requireEnv("TOKEN_ENCRYPTION_KEY", env);

const db = await connect();
let shopDomain: string;
let accessToken: string;
try {
  const { rows } = await db.query(
    `select c.external_account_id, t.encrypted_refresh_token
     from public.integration_connections c
     join public.integration_tokens t on t.connection_id = c.id
     where c.organisation_id = $1 and c.provider = 'shopify'
     limit 1`,
    [organisationId],
  );
  if (rows.length === 0) throw new Error("No Shopify connection registered.");
  shopDomain = rows[0].external_account_id as string;
  accessToken = decryptToken(rows[0].encrypted_refresh_token as Buffer, encryptionKey);
} finally {
  await db.end();
}

const client = new ShopifyClient({ shopDomain, accessToken });

console.log(`store: ${shopDomain}`);
console.log(`api  : ${SHOPIFY_API_VERSION}\n`);

/** Runs a query and reports the error rather than throwing, so one failure does not end the probe. */
async function attempt<T>(label: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    console.log(`${label}: FAILED — ${(error as Error).message}`);
    return null;
  }
}

// 1. Is the product catalogue readable at all? -----------------------------------------
const catalogue = await attempt("product catalogue", () =>
  client.query<{
    productVariants: { nodes: { id: string; sku: string | null; product: { title: string } | null }[] };
    products: { nodes: { id: string }[] };
  }>(`{
    productVariants(first: 5) { nodes { id sku product { title } } }
    products(first: 5) { nodes { id } }
  }`),
);

if (catalogue) {
  const variants = catalogue.productVariants.nodes;
  console.log(`product catalogue : readable, ${variants.length} variant(s) in first page`);
  for (const variant of variants.slice(0, 5)) {
    console.log(`  ${variant.id}  sku=${variant.sku === "" ? "(empty)" : (variant.sku ?? "(null)")}  ${variant.product?.title ?? "(no product)"}`);
  }
  if (variants.length === 0) {
    console.log("  The store has no product variants. Order lines cannot resolve to a catalogue.");
  }
}

// 2. Do recent orders carry what old orders lack? --------------------------------------
// If recent orders have variants and old ones do not, the products were deleted. If
// neither does, the read_products scope never took effect.
const ORDER_SAMPLE = `
  query($q: String!) {
    orders(first: 10, query: $q, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        createdAt
        totalShippingPriceSet { shopMoney { amount } }
        totalTaxSet { shopMoney { amount } }
        taxesIncluded
        lineItems(first: 10) { nodes { sku variant { id } } }
      }
    }
  }`;

type OrderSample = {
  orders: {
    nodes: {
      id: string;
      createdAt: string;
      totalShippingPriceSet: { shopMoney: { amount: string } };
      totalTaxSet: { shopMoney: { amount: string } };
      taxesIncluded: boolean;
      lineItems: { nodes: { sku: string | null; variant: { id: string } | null }[] };
    }[];
  };
};

function summarise(label: string, sample: OrderSample | null) {
  if (!sample) return;
  const orders = sample.orders.nodes;
  if (orders.length === 0) {
    console.log(`\n${label}: no orders returned`);
    return;
  }
  const lines = orders.flatMap((order) => order.lineItems.nodes);
  const withVariant = lines.filter((line) => line.variant !== null).length;
  const withSku = lines.filter((line) => line.sku !== null && line.sku !== "").length;
  const withShipping = orders.filter((o) => Number(o.totalShippingPriceSet.shopMoney.amount) > 0).length;
  const withTax = orders.filter((o) => Number(o.totalTaxSet.shopMoney.amount) > 0).length;

  console.log(`\n${label}`);
  console.log(`  orders          : ${orders.length}  (${orders[orders.length - 1].createdAt.slice(0, 10)} to ${orders[0].createdAt.slice(0, 10)})`);
  console.log(`  lines           : ${lines.length}`);
  console.log(`  with variant    : ${withVariant} / ${lines.length}`);
  console.log(`  with sku        : ${withSku} / ${lines.length}`);
  console.log(`  charging shipping: ${withShipping} / ${orders.length}`);
  console.log(`  charging tax    : ${withTax} / ${orders.length}`);
  console.log(`  taxesIncluded   : ${orders.filter((o) => o.taxesIncluded).length} / ${orders.length}`);
}

const recentCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
summarise(
  `most recent orders (created_at >= ${recentCutoff})`,
  await attempt("recent orders", () => client.query<OrderSample>(ORDER_SAMPLE, { q: `created_at:>='${recentCutoff}'` })),
);
summarise(
  "oldest orders",
  await attempt("old orders", () => client.query<OrderSample>(ORDER_SAMPLE, { q: "created_at:<'2024-06-01'" })),
);

// 3. How much history is there in total? -----------------------------------------------
const counts = await attempt("order count", () =>
  client.query<{ ordersCount: { count: number; precision: string } }>(
    `{ ordersCount { count precision } }`,
  ),
);
if (counts) {
  console.log(`\ntotal orders in store: ${counts.ordersCount.count} (${counts.ordersCount.precision})`);
}

// 4. Where does the history actually sit? ----------------------------------------------
// A monthly histogram makes a relaunch or a dormant period obvious, which decides how far
// back a backfill is worth running.
if (process.argv.includes("--timeline")) {
  const TIMELINE = `
    query($cursor: String) {
      orders(first: 250, after: $cursor, sortKey: CREATED_AT) {
        pageInfo { hasNextPage endCursor }
        nodes {
          createdAt
          lineItems(first: 5) { nodes { variant { id } } }
        }
      }
    }`;

  type TimelinePage = {
    orders: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: { createdAt: string; lineItems: { nodes: { variant: { id: string } | null }[] } }[];
    };
  };

  const months = new Map<string, { orders: number; linesWithVariant: number; lines: number }>();
  let cursor: string | null = null;
  let total = 0;

  do {
    const page: TimelinePage = await client.query<TimelinePage>(TIMELINE, { cursor });
    for (const node of page.orders.nodes) {
      const month = node.createdAt.slice(0, 7);
      const entry = months.get(month) ?? { orders: 0, linesWithVariant: 0, lines: 0 };
      entry.orders += 1;
      for (const line of node.lineItems.nodes) {
        entry.lines += 1;
        if (line.variant !== null) entry.linesWithVariant += 1;
      }
      months.set(month, entry);
      total += 1;
    }
    cursor = page.orders.pageInfo.hasNextPage ? page.orders.pageInfo.endCursor : null;
  } while (cursor !== null);

  console.log(`\n--- orders by month (${total} total) ---`);
  console.log("  month    orders  lines resolving to a variant");
  for (const [month, entry] of [...months.entries()].sort()) {
    const bar = "#".repeat(Math.min(entry.orders, 40));
    const resolved = entry.lines === 0 ? "n/a" : `${entry.linesWithVariant}/${entry.lines}`;
    console.log(`  ${month}  ${String(entry.orders).padStart(5)}  ${resolved.padStart(7)}  ${bar}`);
  }
}
