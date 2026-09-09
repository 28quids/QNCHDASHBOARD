/**
 * The subset of the Shopify GraphQL Admin API that QNCH consumes.
 *
 * The REST Admin API is legacy as of October 2024 and new integrations must use GraphQL, so
 * this connector is GraphQL-only.
 */

export interface Money {
  amount: string;
  currencyCode: string;
}

export interface MoneyBag {
  shopMoney: Money;
}

export interface TaxLine {
  priceSet: MoneyBag;
}

/**
 * One discount apportioned onto a line or shipping line.
 *
 * This is the only field that accounts for an order-level discount code. `discountedTotalSet`
 * carries line-level discounts alone, so a cart-wide code leaves it equal to the original
 * price and the discount disappears from revenue entirely.
 */
export interface DiscountAllocation {
  allocatedAmountSet: MoneyBag;
}

export interface ShopifyLineItemNode {
  id: string;
  quantity: number;
  sku: string | null;
  variant: { id: string } | null;
  /** Quantity times the original unit price, before discounts. */
  originalTotalSet: MoneyBag;
  discountAllocations: DiscountAllocation[];
  taxLines: TaxLine[];
}

export interface ShopifyRefundLineItemNode {
  quantity: number;
  /** NO_RESTOCK, CANCEL, RETURN or LEGACY_RESTOCK. Only NO_RESTOCK leaves stock unreturned. */
  restockType: string;
  lineItem: { id: string; sku: string | null; variant: { id: string } | null } | null;
  subtotalSet: MoneyBag;
  totalTaxSet: MoneyBag;
}

/** Shipping refunded alongside the goods. Carried separately from the line items. */
export interface ShopifyRefundShippingLineNode {
  subtotalAmountSet: MoneyBag;
  taxAmountSet: MoneyBag;
}

export interface ShopifyRefundNode {
  id: string;
  /** When the refund was processed. This is the date policy recognises it against. */
  createdAt: string;
  totalRefundedSet: MoneyBag;
  refundLineItems: { nodes: ShopifyRefundLineItemNode[] };
  /**
   * Optional because `totalRefundedSet` already includes refunded shipping. Without it the
   * shipping portion is invisible, so a refund's parts do not sum back to its total.
   */
  refundShippingLines?: { nodes: ShopifyRefundShippingLineNode[] };
}

export interface ShopifyOrderNode {
  id: string;
  name: string;
  createdAt: string;
  processedAt: string | null;
  updatedAt: string;
  cancelledAt: string | null;
  test: boolean;
  currencyCode: string;
  /** True when displayed prices already include VAT, which UK DTC stores commonly use. */
  taxesIncluded: boolean;
  displayFinancialStatus: string | null;
  customer: { id: string } | null;
  totalDiscountsSet: MoneyBag;
  /** What the customer was charged. Used to check the parts sum back to the whole. */
  totalPriceSet: MoneyBag;
  /** Shipping charged, before any shipping discount. */
  totalShippingPriceSet: MoneyBag;
  totalTaxSet: MoneyBag;
  shippingLines: { nodes: { taxLines: TaxLine[]; discountAllocations: DiscountAllocation[] }[] };
  lineItems: { nodes: ShopifyLineItemNode[] };
  refunds: ShopifyRefundNode[];
}

export interface ShopifyVariantNode {
  id: string;
  sku: string | null;
  title: string | null;
  updatedAt: string;
  product: { id: string; title: string; status: string } | null;
  inventoryItem?: {
    inventoryLevels: {
      nodes: { quantities: { name: string; quantity: number }[]; location: { id: string } }[];
    };
  };
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface GraphQlResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number;
      throttleStatus: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number };
    };
  };
}

/**
 * A Shopify Payments payout.
 *
 * `summary` is optional because the detailed breakdown is requested on a best-effort basis:
 * a field name absent from the shop's API version fails the whole GraphQL query, so the sync
 * falls back to a document without it. The net amount is what the reconciliation needs; the
 * breakdown only explains a difference it has already found.
 */
export interface ShopifyPayoutNode {
  id: string;
  issuedAt: string;
  status: string;
  net: Money;
  summary?: {
    chargesGross?: { amount: string };
    chargesFee?: { amount: string };
    refundsFeeGross?: { amount: string };
    refundsFee?: { amount: string };
    adjustmentsGross?: { amount: string };
    adjustmentsFee?: { amount: string };
  };
}
