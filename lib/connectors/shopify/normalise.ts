import Decimal from "decimal.js";
import { toBusinessDate } from "@/lib/financial/dates";
import { money, sum, ZERO } from "@/lib/financial/money";
import type { OrderInput, OrderLineInput, RefundInput } from "@/lib/financial/domain";
import type { MoneyBag, ShopifyOrderNode, ShopifyRefundNode, TaxLine } from "./types";

/**
 * Turns Shopify GraphQL orders into the engine's VAT-exclusive management inputs.
 *
 * QNCH reports VAT-exclusive. When the store displays tax-inclusive prices, the tax lines
 * Shopify returns are subtracted here so that revenue never carries VAT into margin. When the
 * store is tax-exclusive the amounts already exclude VAT and are used unchanged.
 */

export interface ShopifyNormalisationOptions {
  businessTimezone: string;
  /**
   * Earliest known order date per customer, from data already stored. Supplied so that an
   * incremental sync of a recent window does not mislabel a returning customer as new.
   */
  knownFirstOrderDates?: ReadonlyMap<string, string>;
}

const amountOf = (bag: MoneyBag): Decimal => money(bag.shopMoney.amount);
const taxOf = (taxLines: readonly TaxLine[]): Decimal => sum(taxLines.map((line) => amountOf(line.priceSet)));

/** Cancelled and test orders are excluded from management reporting. */
export const isExcludedOrder = (order: ShopifyOrderNode): boolean => order.test || order.cancelledAt !== null;

export function normaliseOrder(order: ShopifyOrderNode, options: ShopifyNormalisationOptions): OrderInput {
  const taxesIncluded = order.taxesIncluded;
  const businessDate = toBusinessDate(order.processedAt ?? order.createdAt, options.businessTimezone);

  const lines: OrderLineInput[] = order.lineItems.nodes.map((line) => {
    const lineTax = taxesIncluded ? taxOf(line.taxLines) : ZERO;
    const discountedTotal = amountOf(line.discountedTotalSet);
    const originalTotal = amountOf(line.originalTotalSet);
    const discount = originalTotal.minus(discountedTotal);

    // Tax is charged on the discounted amount, so removing it from the gross figure requires
    // scaling the tax back up to the pre-discount base. With no discount the two are equal.
    const grossTax = discountedTotal.isZero() ? lineTax : lineTax.times(originalTotal).div(discountedTotal);

    return {
      externalId: line.id,
      variantId: line.variant?.id ?? null,
      sku: line.sku,
      quantity: line.quantity,
      grossSales: originalTotal.minus(grossTax),
      discounts: discount.minus(taxesIncluded ? grossTax.minus(lineTax) : ZERO),
    };
  });

  const shippingTax = taxesIncluded ? taxOf(order.shippingLines.nodes.flatMap((node) => node.taxLines)) : ZERO;
  const shippingRevenue = amountOf(order.totalShippingPriceSet).minus(shippingTax);

  const grossSales = sum(lines.map((line) => line.grossSales));
  const discounts = sum(lines.map((line) => line.discounts));

  return {
    externalId: order.id,
    customerId: order.customer?.id ?? null,
    businessDate,
    grossSales,
    discounts,
    shippingRevenue,
    lines,
    isNewCustomerOrder: false,
    isExcluded: isExcludedOrder(order),
  };
}

/**
 * Refunds recognised on their processed date, with the original-order link retained.
 * A refund is only treated as restocked when Shopify says stock actually came back.
 */
export function normaliseRefunds(order: ShopifyOrderNode, options: ShopifyNormalisationOptions): RefundInput[] {
  return order.refunds.map((refund) => normaliseRefund(order, refund, options));
}

function normaliseRefund(
  order: ShopifyOrderNode,
  refund: ShopifyRefundNode,
  options: ShopifyNormalisationOptions,
): RefundInput {
  const lines = refund.refundLineItems.nodes;
  const refundedTax = sum(lines.map((line) => amountOf(line.totalTaxSet)));
  const total = amountOf(refund.totalRefundedSet);

  return {
    externalId: refund.id,
    orderExternalId: order.id,
    processedBusinessDate: toBusinessDate(refund.createdAt, options.businessTimezone),
    // Refund totals always include tax, regardless of how the store displays prices.
    amount: total.minus(refundedTax),
    restocked: lines.some((line) => line.restockType !== "NO_RESTOCK"),
    lines: lines.map((line) => ({
      variantId: line.lineItem?.variant?.id ?? null,
      sku: line.lineItem?.sku ?? null,
      quantity: line.quantity,
      amount: amountOf(line.subtotalSet),
    })),
  };
}

/**
 * Marks each customer's first eligible order as their acquisition.
 *
 * Shopify's own order count is a lifetime total and cannot say whether a historical order was
 * that customer's first, so this is derived from order dates instead. History already stored is
 * passed in via `knownFirstOrderDates` so an incremental sync does not mislabel a repeat order.
 */
export function assignNewCustomerFlags(
  orders: readonly OrderInput[],
  knownFirstOrderDates: ReadonlyMap<string, string> = new Map(),
): OrderInput[] {
  const firstDates = new Map(knownFirstOrderDates);

  for (const order of orders) {
    if (!order.customerId || order.isExcluded) continue;
    const existing = firstDates.get(order.customerId);
    if (!existing || order.businessDate < existing) firstDates.set(order.customerId, order.businessDate);
  }

  // A customer can have several orders on their first day; only the earliest external ID counts.
  const claimed = new Set<string>();
  return [...orders]
    .sort((a, b) => a.businessDate.localeCompare(b.businessDate) || a.externalId.localeCompare(b.externalId))
    .map((order) => {
      if (!order.customerId || order.isExcluded) return { ...order, isNewCustomerOrder: false };

      const isFirst = firstDates.get(order.customerId) === order.businessDate && !claimed.has(order.customerId);
      if (isFirst) claimed.add(order.customerId);
      return { ...order, isNewCustomerOrder: isFirst };
    });
}

export interface NormalisedShopifyBatch {
  orders: OrderInput[];
  refunds: RefundInput[];
  /** Highest `updatedAt` seen, stored as the incremental sync watermark. */
  watermarkAt: string | null;
}

export function normaliseOrderBatch(
  nodes: readonly ShopifyOrderNode[],
  options: ShopifyNormalisationOptions,
): NormalisedShopifyBatch {
  const orders = assignNewCustomerFlags(
    nodes.map((node) => normaliseOrder(node, options)),
    options.knownFirstOrderDates,
  );

  return {
    orders,
    refunds: nodes.flatMap((node) => normaliseRefunds(node, options)),
    watermarkAt: nodes.reduce<string | null>(
      (latest, node) => (latest === null || node.updatedAt > latest ? node.updatedAt : latest),
      null,
    ),
  };
}
