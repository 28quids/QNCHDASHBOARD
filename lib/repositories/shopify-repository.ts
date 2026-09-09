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
  type NormalisedPayout,
  type OrderTotalMismatch,
  type ShopifyNormalisationOptions,
} from "@/lib/connectors/shopify/normalise";
import type {
  MoneyBag,
  ShopifyOrderNode,
  ShopifyRefundNode,
  ShopifyVariantNode,
} from "@/lib/connectors/shopify/types";

export interface ShopifyRepositoryContext {
  organisationId: string;
}

/** Written to numeric(19, 4) columns, so figures are fixed at four decimal places. */
const amount = (value: DecimalInput): string => money(value).toFixed(4);
const bagAmount = (bag: MoneyBag): string => amount(bag.shopMoney.amount);

const distinct = <T>(values: readonly (T | null | undefined)[]): T[] =>
  Array.from(new Set(values.filter((value): value is T => value !== null && value !== undefined)));

export interface PersistVariantBatchResult {
  products: number;
  variants: number;
  inventorySnapshots: number;
  /** Variants Shopify returned with no product. They cannot be written: product_id is NOT NULL. */
  variantsWithoutProduct: number;
}

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
  /**
   * Orders whose gross, discounts, shipping and tax do not add back to the total Shopify
   * charged. Reported rather than rejected — the row is still worth having — but a non-empty
   * list means a money field is being read wrongly and every figure built on it is suspect.
   */
  totalMismatches: OrderTotalMismatch[];
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
     * Writes one page of the product catalogue.
     *
     * Must run before an order backfill. Order lines resolve their variant by looking it up
     * here, so syncing orders into an empty catalogue writes every line with a null
     * variant_id and no SKU-level reporting is possible.
     */
    async persistVariantBatch(
      nodes: readonly ShopifyVariantNode[],
      snapshotAt: string = new Date().toISOString(),
    ): Promise<PersistVariantBatchResult> {
      if (nodes.length === 0) {
        return { products: 0, variants: 0, inventorySnapshots: 0, variantsWithoutProduct: 0 };
      }

      // A variant row requires a product, so a variant Shopify returns without one cannot be
      // written. Counted rather than dropped silently.
      const withProduct = nodes.filter((node) => node.product !== null);
      const variantsWithoutProduct = nodes.length - withProduct.length;

      const productRows = [...new Map(withProduct.map((node) => [node.product!.id, node])).values()].map(
        (node) => ({
          organisation_id: organisationId,
          source: "shopify",
          external_id: node.product!.id,
          title: node.product!.title,
          status: node.product!.status,
          source_updated_at: node.updatedAt,
        }),
      );

      const { data: writtenProducts, error: productError } = await client
        .from("products")
        .upsert(productRows, { onConflict: "organisation_id,source,external_id" })
        .select("id, external_id");
      if (productError) throw productError;

      const productIds = new Map(
        (writtenProducts ?? []).map((row) => [row.external_id as string, row.id as string]),
      );

      const variantRows = withProduct.flatMap((node) => {
        const productId = productIds.get(node.product!.id);
        if (!productId) return [];
        return [
          {
            organisation_id: organisationId,
            product_id: productId,
            source: "shopify",
            external_id: node.id,
            sku: node.sku === "" ? null : node.sku,
            title: node.title,
            source_updated_at: node.updatedAt,
          },
        ];
      });

      const { data: writtenVariants, error: variantError } = await client
        .from("product_variants")
        .upsert(variantRows, { onConflict: "organisation_id,source,external_id" })
        .select("id, external_id");
      if (variantError) throw variantError;

      const variantIds = new Map(
        (writtenVariants ?? []).map((row) => [row.external_id as string, row.id as string]),
      );

      const inventoryRows = withProduct.flatMap((node) => {
        const variantId = variantIds.get(node.id);
        const levels = node.inventoryItem?.inventoryLevels.nodes ?? [];
        if (!variantId || levels.length === 0) return [];

        return levels.map((level) => {
          const quantityOf = (name: string) =>
            level.quantities.find((quantity) => quantity.name === name)?.quantity ?? 0;
          return {
            organisation_id: organisationId,
            variant_id: variantId,
            location_external_id: level.location.id,
            snapshot_at: snapshotAt,
            available_units: quantityOf("available"),
            units_on_order: quantityOf("incoming"),
            source_updated_at: node.updatedAt,
          };
        });
      });

      if (inventoryRows.length > 0) {
        const { error } = await client
          .from("inventory_snapshots")
          .upsert(inventoryRows, { onConflict: "organisation_id,variant_id,location_external_id,snapshot_at" });
        if (error) throw error;
      }

      return {
        products: productRows.length,
        variants: variantRows.length,
        inventorySnapshots: inventoryRows.length,
        variantsWithoutProduct,
      };
    },

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
        totalMismatches: [],
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
          // Stored so that everything reading orders back can apply the same exclusion rule
          // the normaliser applies here. Without them a test order re-enters the P&L.
          is_test: node.test,
          cancelled_at: node.cancelledAt,
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
        totalMismatches: batch.totalMismatches,
      };
    },

    /**
     * Writes settlement payouts.
     *
     * These feed reconciliation only — nothing in the contribution walk reads them. A payout is
     * money arriving in the bank days after the orders that produced it, so treating it as
     * revenue would report the same sale twice on two different dates.
     */
    async persistPayouts(payouts: readonly NormalisedPayout[]): Promise<number> {
      if (payouts.length === 0) return 0;

      const { error } = await client.from("shopify_payouts").upsert(
        payouts.map((payout) => ({
          organisation_id: organisationId,
          external_id: payout.externalId,
          payout_date: payout.payoutDate,
          status: payout.status,
          currency: payout.currency,
          charges: payout.charges,
          refunds: payout.refunds,
          adjustments: payout.adjustments,
          fees: payout.fees,
          net_amount: payout.netAmount,
          source_updated_at: payout.sourceUpdatedAt,
        })),
        { onConflict: "organisation_id,external_id" },
      );
      if (error) throw error;
      return payouts.length;
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
