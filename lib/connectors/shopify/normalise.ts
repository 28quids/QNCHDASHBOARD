import Decimal from "decimal.js";
import { toBusinessDate } from "@/lib/financial/dates";
import { money, sum, ZERO } from "@/lib/financial/money";
import type { OrderInput, OrderLineInput, RefundInput } from "@/lib/financial/domain";
import type {
  DiscountAllocation,
  MoneyBag,
  ShopifyOrderNode,
  ShopifyRefundNode,
  TaxLine,
} from "./types";

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

/**
 * What a discount actually took off this line.
 *
 * Order-level codes are apportioned across the lines they apply to and appear only here.
 * `discountedTotalSet` carries line-level discounts alone, so reading the discount from it
 * misses every cart-wide code and reports the full list price as revenue.
 */
const allocatedOf = (allocations: readonly DiscountAllocation[]): Decimal =>
  sum(allocations.map((allocation) => amountOf(allocation.allocatedAmountSet)));

/** Cancelled and test orders are excluded from management reporting. */
export const isExcludedOrder = (order: ShopifyOrderNode): boolean => order.test || order.cancelledAt !== null;

export function normaliseOrder(order: ShopifyOrderNode, options: ShopifyNormalisationOptions): OrderInput {
  const taxesIncluded = order.taxesIncluded;
  const businessDate = toBusinessDate(order.processedAt ?? order.createdAt, options.businessTimezone);

  const lines: OrderLineInput[] = order.lineItems.nodes.map((line) => {
    const lineTax = taxesIncluded ? taxOf(line.taxLines) : ZERO;
    const originalTotal = amountOf(line.originalTotalSet);
    const discount = allocatedOf(line.discountAllocations);
    const discountedTotal = originalTotal.minus(discount);

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
  // `totalShippingPriceSet` is charged shipping before any discount, so a free-shipping code
  // has to be taken off here or the order reports postage revenue it never collected.
  const shippingDiscount = sum(order.shippingLines.nodes.map((node) => allocatedOf(node.discountAllocations)));
  const shippingRevenue = amountOf(order.totalShippingPriceSet).minus(shippingDiscount).minus(shippingTax);

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

/** An order whose normalised parts do not add back to what Shopify charged for it. */
export interface OrderTotalMismatch {
  externalId: string;
  /** The order number as it appears in the Shopify admin, so it can be opened and compared. */
  name: string;
  businessDate: string;
  charged: Decimal;
  derived: Decimal;
  difference: Decimal;
}

/** A penny either way is rounding on an apportioned discount, not a modelling error. */
const TOTAL_TOLERANCE = money("0.01");

/**
 * Checks the normalised order against what the customer was actually charged.
 *
 * Revenue here is assembled from parts — line totals, apportioned discounts, shipping, tax —
 * and every one of those is a separate assumption about a Shopify field. This is the arithmetic
 * that says the assumptions hold: gross less discounts plus shipping plus tax is the order
 * total, or something is being read wrongly. Reading cart-level discounts from the wrong field
 * broke this identity on every discounted order while every individual figure still looked
 * plausible on its own.
 */
export function reconcileOrderTotal(
  order: ShopifyOrderNode,
  normalised: OrderInput,
): OrderTotalMismatch | null {
  const charged = amountOf(order.totalPriceSet);
  const derived = money(normalised.grossSales)
    .minus(money(normalised.discounts))
    .plus(money(normalised.shippingRevenue ?? ZERO))
    .plus(amountOf(order.totalTaxSet));
  const difference = derived.minus(charged);

  if (difference.abs().lessThanOrEqualTo(TOTAL_TOLERANCE)) return null;
  return {
    externalId: order.id,
    name: order.name,
    businessDate: normalised.businessDate,
    charged,
    derived,
    difference,
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
  const shippingLines = refund.refundShippingLines?.nodes ?? [];
  // Refunded shipping is taxed too. Counting only line tax would leave that VAT in the
  // refund and overstate the amount coming off net revenue.
  const refundedTax = sum([
    ...lines.map((line) => amountOf(line.totalTaxSet)),
    ...shippingLines.map((line) => amountOf(line.taxAmountSet)),
  ]);
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
  /**
   * Orders whose parts do not add back to what Shopify charged. Carried out of normalisation
   * rather than thrown, because one order the connector reads wrongly must not stop the rest
   * importing — but it must not pass silently either.
   */
  totalMismatches: OrderTotalMismatch[];
  /** Highest `updatedAt` seen, stored as the incremental sync watermark. */
  watermarkAt: string | null;
}

export function normaliseOrderBatch(
  nodes: readonly ShopifyOrderNode[],
  options: ShopifyNormalisationOptions,
): NormalisedShopifyBatch {
  const normalisedByExternalId = new Map(
    nodes.map((node) => [node.id, normaliseOrder(node, options)] as const),
  );
  const orders = assignNewCustomerFlags(
    [...normalisedByExternalId.values()],
    options.knownFirstOrderDates,
  );

  return {
    orders,
    refunds: nodes.flatMap((node) => normaliseRefunds(node, options)),
    totalMismatches: nodes.flatMap((node) => {
      const normalised = normalisedByExternalId.get(node.id);
      const mismatch = normalised ? reconcileOrderTotal(node, normalised) : null;
      return mismatch ? [mismatch] : [];
    }),
    watermarkAt: nodes.reduce<string | null>(
      (latest, node) => (latest === null || node.updatedAt > latest ? node.updatedAt : latest),
      null,
    ),
  };
}
