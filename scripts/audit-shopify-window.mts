/**
 * Explains, order by order, why the dashboard's figure for a window differs from Shopify's.
 *
 * Comparing the dashboard against Shopify Analytics and finding a gap is common and usually is
 * not a fault — the two measure deliberately different things — but "usually not a fault" is
 * useless without knowing which this one is. This lists every order Shopify has in the window,
 * says whether the dashboard counted it and why not if it did not, and then walks the money from
 * Shopify's total to the dashboard's net revenue a line at a time.
 *
 *   npm run audit:shopify                     # the tool's "last 7 days"
 *   npm run audit:shopify -- --days 30
 *   npm run audit:shopify -- --from 2026-09-01 --to 2026-09-07
 *
 * Four differences account for nearly every gap, and all four are visible below:
 *
 *   1. The window. The dashboard's "last 7 days" is today and the six before it. Shopify
 *      Analytics' "last 7 days" normally means the seven *completed* days and excludes today,
 *      so the two windows are a day apart and never contain the same orders.
 *   2. Exclusions. Test and cancelled orders are source facts that management reporting drops.
 *   3. VAT. The dashboard reports VAT-exclusive; Shopify's headline total sales is not.
 *   4. Refunds. The dashboard recognises a refund on the day it was processed.
 */

import { connect, loadEnvFile, printTable, requireEnv } from "./lib/db.mjs";
import { decryptToken } from "@/lib/connectors/crypto";
import { ShopifyClient, fetchConnectionPage } from "@/lib/connectors/shopify/client";
import { ORDERS_QUERY, createdSinceQuery } from "@/lib/connectors/shopify/queries";
import { normaliseOrderBatch } from "@/lib/connectors/shopify/normalise";
import { money, sum, ZERO } from "@/lib/financial/money";
import { addDays, toBusinessDate } from "@/lib/financial/dates";
import type { ShopifyOrderNode } from "@/lib/connectors/shopify/types";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const env = loadEnvFile();
const organisationId = requireEnv("ORGANISATION_ID", env);
const encryptionKey = requireEnv("TOKEN_ENCRYPTION_KEY", env);

const db = await connect();

try {
  const { rows: connectionRows } = await db.query(
    `select c.external_account_id, t.encrypted_refresh_token, o.business_timezone
     from public.integration_connections c
     join public.integration_tokens t on t.connection_id = c.id
     join public.organisations o on o.id = c.organisation_id
     where c.organisation_id = $1 and c.provider = 'shopify' limit 1`,
    [organisationId],
  );
  if (connectionRows.length === 0) throw new Error("No Shopify connection registered.");

  const businessTimezone = connectionRows[0].business_timezone as string;
  const today = toBusinessDate(new Date(), businessTimezone);

  const days = Number(flag("days") ?? 7);
  const to = flag("to") ?? today;
  const from = flag("from") ?? addDays(to, -(days - 1));

  const client = new ShopifyClient({
    shopDomain: connectionRows[0].external_account_id as string,
    accessToken: decryptToken(connectionRows[0].encrypted_refresh_token as Buffer, encryptionKey),
  });

  console.log(`Window as the dashboard defines it: ${from} to ${to} inclusive, in ${businessTimezone}.`);
  console.log("Shopify Analytics' \"last 7 days\" usually excludes today — check you are comparing");
  console.log("the same days before reading anything below as a discrepancy.\n");

  // Fetched a day wide on each side, then filtered exactly on the business date. An order placed
  // at 00:30 BST is the previous day in UTC, and filtering in UTC alone would move it.
  const collected: ShopifyOrderNode[] = [];
  let cursor: string | null = null;
  do {
    const page: { nodes: ShopifyOrderNode[]; nextCursor: string | null } =
      await fetchConnectionPage<ShopifyOrderNode>(
        client,
        ORDERS_QUERY,
        { cursor, query: createdSinceQuery(addDays(from, -1)), pageSize: 100 },
        (data) => data.orders,
      );
    collected.push(...page.nodes);
    cursor = page.nextCursor;
  } while (cursor !== null);

  const batch = normaliseOrderBatch(collected, { businessTimezone });
  const inWindow = batch.orders.filter((order) => order.businessDate >= from && order.businessDate <= to);

  const byExternalId = new Map(collected.map((node) => [node.id, node]));

  const { rows: storedRows } = await db.query(
    `select external_id from public.shopify_orders where organisation_id = $1`,
    [organisationId],
  );
  const stored = new Set(storedRows.map((row) => row.external_id as string));

  /**
   * Why the dashboard did or did not count this order. Exactly one reason, in priority order.
   *
   * Read from Shopify's own node rather than from the normalised order, which carries only a
   * combined `isExcluded` flag — "test" and "cancelled" are different answers to the question
   * being asked here, and collapsing them would leave the useful half out.
   */
  const verdictFor = (order: (typeof inWindow)[number]): string => {
    if (!stored.has(order.externalId)) return "NOT IMPORTED";

    const node = byExternalId.get(order.externalId);
    if (node?.test) return "excluded: test";
    if (node?.cancelledAt) return "excluded: cancelled";
    return "counted";
  };

  printTable(
    inWindow.map((order) => {
      const node = byExternalId.get(order.externalId);
      return {
        order: node?.name ?? order.externalId.split("/").pop(),
        date: order.businessDate,
        "shopify total": money(node?.totalPriceSet.shopMoney.amount ?? 0).toFixed(2),
        "net (ex VAT)": money(order.grossSales)
          .minus(money(order.discounts))
          .plus(money(order.shippingRevenue))
          .toFixed(2),
        verdict: verdictFor(order),
      };
    }),
  );

  const counted = inWindow.filter((order) => verdictFor(order) === "counted");
  const missing = inWindow.filter((order) => verdictFor(order) === "NOT IMPORTED");
  const excluded = inWindow.filter((order) => verdictFor(order).startsWith("excluded"));

  const totalCharged = sum(
    inWindow.map((order) => money(byExternalId.get(order.externalId)?.totalPriceSet.shopMoney.amount ?? 0)),
  );

  // The walk from what Shopify shows to what the dashboard shows. Every step is a definition
  // rather than an adjustment, which is the point: a gap is only a fault once these are removed.
  const excludedCharged = sum(
    excluded.map((order) => money(byExternalId.get(order.externalId)?.totalPriceSet.shopMoney.amount ?? 0)),
  );
  const missingCharged = sum(
    missing.map((order) => money(byExternalId.get(order.externalId)?.totalPriceSet.shopMoney.amount ?? 0)),
  );
  const countedCharged = totalCharged.minus(excludedCharged).minus(missingCharged);
  const countedNet = counted.reduce(
    (total, order) =>
      total.plus(money(order.grossSales)).minus(money(order.discounts)).plus(money(order.shippingRevenue)),
    ZERO,
  );

  console.log(`\nShopify has ${inWindow.length} order(s) in this window, totalling ${totalCharged.toFixed(2)} charged.\n`);

  printTable([
    { step: "Shopify total charged (inc VAT)", orders: inWindow.length, amount: totalCharged.toFixed(2) },
    { step: "less test and cancelled", orders: -excluded.length, amount: excludedCharged.negated().toFixed(2) },
    { step: "less orders NOT IMPORTED", orders: -missing.length, amount: missingCharged.negated().toFixed(2) },
    { step: "= charged, as counted", orders: counted.length, amount: countedCharged.toFixed(2) },
    { step: "less VAT (dashboard is ex-VAT)", orders: "", amount: countedNet.minus(countedCharged).toFixed(2) },
    { step: "= dashboard net revenue", orders: counted.length, amount: countedNet.toFixed(2) },
  ]);

  console.log("\nRefunds are not in this walk. The dashboard recognises a refund on the day it was");
  console.log("processed, so one against an older order reduces today's net revenue without");
  console.log("appearing among today's orders.");

  if (missing.length > 0) {
    console.log(`\n${missing.length} order(s) are in Shopify and not in the database. That is a real gap.`);
    console.log("Re-run the import for the window:");
    console.log(`  npm run backfill:shopify -- --created-since ${from} --force`);
  } else {
    console.log("\nEvery order Shopify has in this window is imported. Any remaining difference is");
    console.log("a definition difference, not missing data.");
  }
} catch (error) {
  console.error(`Failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
