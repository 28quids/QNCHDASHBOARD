/**
 * Persists normalised Shopify data.
 *
 * This is the write half of the repository layer, and the piece `runSync` needs for its
 * `upsert` callback: without it a sync fetches, normalises and then discards.
 *
 * Two shapes are needed for every order, not one. `normaliseOrder` produces the engine's
 * VAT-exclusive management inputs and deliberately drops everything the calculation does not
 * use — the timestamp, the currency, the tax that was removed, the financial status. The
 * tables store source facts and need those back, so the raw node is mapped alongside the
 * normalised figures rather than one being derived from the other.
 *
 * Everything is upserted on the provider's external ID, so re-running a sync over the same
 * window rewrites rows instead of duplicating them.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { money, sum, ZERO, type DecimalInput } from "@/lib/financial/money";
import { toBusinessDate } from "@/lib/financial/dates";
import {
  normaliseOrderBatch,
  type ShopifyNormalisationOptions,
} from "@/lib/connectors/shopify/normalise";
import type { MoneyBag, ShopifyOrderNode, ShopifyRefundNode } from "@/lib/connectors/shopify/types";

export interface ShopifyRepositoryContext {
  organisationId: string;
}

/** Written to numeric(19, 4) columns, so figures are fixed at four decimal places. */
const amount = (value: DecimalInput): string => money(value).toFixed(4);
const bagAmount = (bag: MoneyBag): string => amount(bag.shopMoney.amount);

const distinct = <T>(values: readonly (T | null | undefined)[]): T[] =>
  Array.from(new Set(values.filter((value): value is T => value !== null && value !== undefined)));

export interface PersistOrderBatchResult {
  orders: number;
  orderLines: number;
  refunds: number;
  refundLines: number;
  customers: number;
  /**
   * Line items whose Shopify variant is not in `product_variants` yet, so the row was written
   * with a null variant_id. Reported rather than hidden: SKU-level reporting silently
   * under-counts until the product catalogue has been synced.
   */
  unresolvedVariants: number;
}

export function createShopifyRepository(client: SupabaseClient, context: ShopifyRepositoryContext) {
  const { organisationId } = context;

  /**
   * Upserts the customers referenced by this batch and returns Shopify GID → existing row.
   * Only the identity columns are written, so an existing row keeps its first_order_at and
   * orders_count — and `first_order_at` is read back, because it is what stops an
   * incremental sync from mislabelling a repeat order as an acquisition.
   */
  async function upsertCustomers(
    nodes: readonly ShopifyOrderNode[],
  ): Promise<Map<string, { id: string; firstOrderAt: string | null }>> {
    const externalIds = distinct(nodes.map((node) => node.customer?.id));
    if (externalIds.length === 0) return new Map();

    const { data, error } = await client
      .from("shopify_customers")
      .upsert(
        externalIds.map((external_id) => ({ organisation_id: organisationId, external_id })),
        { onConflict: "organisation_id,external_id" },
      )
      .select("id, external_id, first_order_at");

    if (error) throw error;
    return new Map(
      (data ?? []).map((row) => [
        row.external_id as string,
        { id: row.id as string, firstOrderAt: (row.first_order_at as string | null) ?? null },
      ]),
    );
  }

  /**
   * Advances `shopify_customers.first_order_at` when this batch contains an earlier order
   * than the one on record.
   *
   * A backfill walks orders by `updatedAt`, not by order date, so a customer's true first
   * order can arrive in any page — including after a later one has already been written.
   * Only moving the date backwards keeps the answer independent of page order.
   */
  async function advanceFirstOrderDates(
    nodes: readonly ShopifyOrderNode[],
    customers: ReadonlyMap<string, { id: string; firstOrderAt: string | null }>,
  ): Promise<void> {
    const earliest = new Map<string, string>();
    for (const node of nodes) {
      const externalId = node.customer?.id;
      // An excluded order is not an acquisition, so it must not set the first-order date.
      if (!externalId || node.test || node.cancelledAt !== null) continue;
      const orderedAt = node.processedAt ?? node.createdAt;
      const running = earliest.get(externalId);
      if (!running || orderedAt < running) earliest.set(externalId, orderedAt);
    }

    const updates = [...earliest.entries()].filter(([externalId, orderedAt]) => {
      const existing = customers.get(externalId)?.firstOrderAt;
      return !existing || orderedAt < existing;
    });

    for (const [externalId, orderedAt] of updates) {
      const { error } = await client
        .from("shopify_customers")
        .update({ first_order_at: orderedAt })
        .eq("organisation_id", organisationId)
        .eq("external_id", externalId);
      if (error) throw error;
    }
  }

  /**
   * Looks up existing variants only — it never creates them. A variant row requires a product,
   * and inventing a placeholder product from an order line would put a fake row in the
   * catalogue. Unmatched lines keep their SKU and get a null variant_id.
   */
  async function resolveVariants(nodes: readonly ShopifyOrderNode[]): Promise<Map<string, string>> {
    const externalIds = distinct([
      ...nodes.flatMap((node) => node.lineItems.nodes.map((line) => line.variant?.id)),
      ...nodes.flatMap((node) =>
        node.refunds.flatMap((refund) =>
          refund.refundLineItems.nodes.map((line) => line.lineItem?.variant?.id),
        ),
      ),
    ]);
    if (externalIds.length === 0) return new Map();

    const { data, error } = await client
      .from("product_variants")
      .select("id, external_id")
      .eq("organisation_id", organisationId)
      .in("external_id", externalIds);

    if (error) throw error;
    return new Map((data ?? []).map((row) => [row.external_id as string, row.id as string]));
  }

  return {
    /**
     * Writes one page of orders and everything hanging off them. Returns per-table counts so
     * a caller can report what a sync actually changed.
     */
    async persistOrderBatch(
      nodes: readonly ShopifyOrderNode[],
      options: ShopifyNormalisationOptions,
    ): Promise<PersistOrderBatchResult> {
      const empty: PersistOrderBatchResult = {
        orders: 0,
        orderLines: 0,
        refunds: 0,
        refundLines: 0,
        customers: 0,
        unresolvedVariants: 0,
      };
      if (nodes.length === 0) return empty;

      const customers = await upsertCustomers(nodes);

      // History already stored, so a sync of a recent window does not read a returning
      // customer's order as their first. An explicit map from the caller wins.
      const knownFirstOrderDates =
        options.knownFirstOrderDates ??
        new Map(
          [...customers]
            .filter(([, customer]) => customer.firstOrderAt !== null)
            .map(([externalId, customer]) => [
              externalId,
              toBusinessDate(customer.firstOrderAt as string, options.businessTimezone),
            ]),
        );

      const batch = normaliseOrderBatch(nodes, { ...options, knownFirstOrderDates });
      const normalisedByExternalId = new Map(batch.orders.map((order) => [order.externalId, order]));
      const nodesByExternalId = new Map(nodes.map((node) => [node.id, node]));

      const variantIds = await resolveVariants(nodes);
      let unresolvedVariants = 0;

      // Refund totals are stored on the order as well as on the refund, so a query against
      // orders alone still shows net position without joining.
      const refundedByOrder = new Map<string, DecimalInput>();
      for (const refund of batch.refunds) {
        const running = refundedByOrder.get(refund.orderExternalId) ?? ZERO;
        refundedByOrder.set(refund.orderExternalId, money(running).plus(money(refund.amount)));
      }

      const orderRows = nodes.map((node) => {
        const normalised = normalisedByExternalId.get(node.id);
        if (!normalised) throw new Error(`Order ${node.id} was not normalised`);
        return {
          organisation_id: organisationId,
          external_id: node.id,
          customer_id: node.customer ? (customers.get(node.customer.id)?.id ?? null) : null,
          order_number: node.name,
          currency: node.currencyCode,
          // Policy recognises an order on its processed date, falling back to creation.
          ordered_at: node.processedAt ?? node.createdAt,
          processed_at: node.processedAt,
          financial_status: node.displayFinancialStatus,
          gross_sales: amount(normalised.grossSales),
          discounts: amount(normalised.discounts),
          refunds: amount(refundedByOrder.get(node.id) ?? ZERO),
          tax: bagAmount(node.totalTaxSet),
          shipping_revenue: amount(normalised.shippingRevenue),
          source_updated_at: node.updatedAt,
        };
      });

      const { data: writtenOrders, error: orderError } = await client
        .from("shopify_orders")
        .upsert(orderRows, { onConflict: "organisation_id,external_id" })
        .select("id, external_id");
      if (orderError) throw orderError;

      const orderIds = new Map((writtenOrders ?? []).map((row) => [row.external_id as string, row.id as string]));

      const lineRows = batch.orders.flatMap((order) => {
        const orderId = orderIds.get(order.externalId);
        const node = nodesByExternalId.get(order.externalId);
        if (!orderId || !node) return [];

        return order.lines.map((line) => {
          const variantId = line.variantId ? (variantIds.get(line.variantId) ?? null) : null;
          if (line.variantId && variantId === null) unresolvedVariants += 1;
          return {
            organisation_id: organisationId,
            order_id: orderId,
            variant_id: variantId,
            external_id: line.externalId,
            sku: line.sku,
            quantity: line.quantity,
            gross_sales: amount(line.grossSales),
            discounts: amount(line.discounts),
            source_updated_at: node.updatedAt,
          };
        });
      });

      if (lineRows.length > 0) {
        const { error } = await client
          .from("shopify_order_lines")
          .upsert(lineRows, { onConflict: "organisation_id,external_id" });
        if (error) throw error;
      }

      const { refunds, refundLines } = await persistRefunds(nodes, orderIds, variantIds);
      await advanceFirstOrderDates(nodes, customers);

      return {
        orders: orderRows.length,
        orderLines: lineRows.length,
        refunds,
        refundLines,
        customers: customers.size,
        unresolvedVariants,
      };
    },
  };

  async function persistRefunds(
    nodes: readonly ShopifyOrderNode[],
    orderIds: ReadonlyMap<string, string>,
    variantIds: ReadonlyMap<string, string>,
  ): Promise<{ refunds: number; refundLines: number }> {
    const pairs = nodes.flatMap((node) => node.refunds.map((refund) => ({ node, refund })));
    if (pairs.length === 0) return { refunds: 0, refundLines: 0 };

    const refundRows = pairs.flatMap(({ node, refund }) => {
      const orderId = orderIds.get(node.id);
      if (!orderId) return [];

      const lines = refund.refundLineItems.nodes;
      const shippingLines = refund.refundShippingLines?.nodes ?? [];
      // Split so that subtotal + shipping + tax reconciles to total. Charging refunded
      // shipping to the subtotal would misstate the goods refunded.
      const tax = sum([
        ...lines.map((line) => money(line.totalTaxSet.shopMoney.amount)),
        ...shippingLines.map((line) => money(line.taxAmountSet.shopMoney.amount)),
      ]);
      const subtotal = sum(lines.map((line) => money(line.subtotalSet.shopMoney.amount)));
      const shipping = sum(shippingLines.map((line) => money(line.subtotalAmountSet.shopMoney.amount)));

      return [
        {
          organisation_id: organisationId,
          external_id: refund.id,
          order_id: orderId,
          // The processed date, which is what policy recognises a refund against.
          processed_at: refund.createdAt,
          subtotal: amount(subtotal),
          shipping: amount(shipping),
          tax: amount(tax),
          total: bagAmount(refund.totalRefundedSet),
          // Shopify reports restocking per line; the refund counts as restocked when any
          // line returned stock. The per-line flags below carry the detail.
          restocked: lines.some((line) => line.restockType !== "NO_RESTOCK"),
        },
      ];
    });

    if (refundRows.length === 0) return { refunds: 0, refundLines: 0 };

    const { data: writtenRefunds, error } = await client
      .from("shopify_refunds")
      .upsert(refundRows, { onConflict: "organisation_id,external_id" })
      .select("id, external_id");
    if (error) throw error;

    const refundIds = new Map((writtenRefunds ?? []).map((row) => [row.external_id as string, row.id as string]));
    const lineRows = pairs.flatMap(({ refund }) => buildRefundLines(refund, refundIds, variantIds));

    if (lineRows.length > 0) {
      const { error: lineError } = await client
        .from("shopify_refund_lines")
        .upsert(lineRows, { onConflict: "organisation_id,external_id" });
      if (lineError) throw lineError;
    }

    return { refunds: refundRows.length, refundLines: lineRows.length };
  }

  function buildRefundLines(
    refund: ShopifyRefundNode,
    refundIds: ReadonlyMap<string, string>,
    variantIds: ReadonlyMap<string, string>,
  ) {
    const refundId = refundIds.get(refund.id);
    if (!refundId) return [];

    return refund.refundLineItems.nodes.map((line, index) => ({
      organisation_id: organisationId,
      refund_id: refundId,
      order_line_id: null,
      variant_id: line.lineItem?.variant?.id ? (variantIds.get(line.lineItem.variant.id) ?? null) : null,
      // Shopify's refund line items carry no id of their own, so one is derived from the
      // refund and the line it refunds. The position is the fallback for a refund line whose
      // original line item has since been removed, which would otherwise collide.
      external_id: `${refund.id}:${line.lineItem?.id ?? `index-${index}`}`,
      quantity: line.quantity,
      subtotal: bagAmount(line.subtotalSet),
      restocked: line.restockType !== "NO_RESTOCK",
    }));
  }
}
