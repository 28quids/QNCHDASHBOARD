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

export interface ShopifyLineItemNode {
  id: string;
  quantity: number;
  sku: string | null;
  variant: { id: string } | null;
  /** Quantity times the original unit price, before discounts. */
  originalTotalSet: MoneyBag;
  discountedTotalSet: MoneyBag;
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

export interface ShopifyRefundNode {
  id: string;
  /** When the refund was processed. This is the date policy recognises it against. */
  createdAt: string;
  totalRefundedSet: MoneyBag;
  refundLineItems: { nodes: ShopifyRefundLineItemNode[] };
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
  totalShippingPriceSet: MoneyBag;
  totalTaxSet: MoneyBag;
  shippingLines: { nodes: { taxLines: TaxLine[] }[] };
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
