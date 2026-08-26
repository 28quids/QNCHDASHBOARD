import type { DecimalInput } from "./money";
import type { EffectiveDated } from "./effective-dating";

/**
 * Canonical management inputs. These are already normalised to the approved QNCH policy:
 * VAT-exclusive amounts, business-timezone dates, and refunds carrying their processed date.
 * Normalisation is a connector responsibility; nothing in this layer re-interprets raw payloads.
 */

export type FinancialBucket = "cm1" | "cm2" | "cm3" | "fixed_operating" | "cash_only";
export type CostChargeBasis = "per_order" | "per_unit" | "percentage_of_revenue" | "fixed_period";
export type PeriodUnit = "day" | "week" | "month" | "year";

/** Which contribution line a per-unit variant cost belongs to. Fixed by the approved CM map. */
export const VARIANT_COST_BUCKETS = {
  productCogs: "cm1",
  packaging: "cm1",
  inboundFreight: "cm1",
  paymentProcessing: "cm1",
  fulfilment: "cm3",
  shipping: "cm3",
} as const satisfies Record<string, FinancialBucket>;

export type VariantCostComponent = keyof typeof VARIANT_COST_BUCKETS;

/**
 * Per-unit standard landed costs for one variant, effective from a date.
 * Order-level and percentage-based costs live in `CostAssumptionRecord` instead; a component
 * set here should be left at zero when an order-level assumption already covers it, so that
 * the same cost is never counted twice.
 */
export interface VariantCostProfile extends EffectiveDated {
  variantId: string;
  productCogs: DecimalInput;
  packaging: DecimalInput;
  inboundFreight: DecimalInput;
  paymentProcessing: DecimalInput;
  fulfilment: DecimalInput;
  shipping: DecimalInput;
}

/**
 * A configurable business assumption. `amount` is currency for per_order/per_unit/fixed_period
 * and a percentage (1.75 meaning 1.75%) for percentage_of_revenue.
 *
 * `appliesTo` is `all_orders`, `sku:<sku>` or `variant:<variantId>`.
 */
export interface CostAssumptionRecord extends EffectiveDated {
  assumptionKey: string;
  financialBucket: FinancialBucket;
  chargeBasis: CostChargeBasis;
  amount: DecimalInput;
  appliesTo: string;
  periodUnit?: PeriodUnit | null;
}

export interface OrderLineInput {
  externalId: string;
  variantId: string | null;
  sku: string | null;
  quantity: number;
  /** VAT-exclusive merchandise value before line discounts. */
  grossSales: DecimalInput;
  discounts: DecimalInput;
}

export interface OrderInput {
  externalId: string;
  customerId: string | null;
  /** Date the order counts against, already converted to the business timezone. */
  businessDate: string;
  grossSales: DecimalInput;
  discounts: DecimalInput;
  /** Shipping charged to the customer. Part of revenue, kept separately identifiable. */
  shippingRevenue: DecimalInput;
  lines: OrderLineInput[];
  isNewCustomerOrder: boolean;
  /** Test and cancelled orders are excluded from management reporting. */
  isExcluded?: boolean;
}

export interface RefundLineInput {
  variantId: string | null;
  sku: string | null;
  quantity: number;
  amount: DecimalInput;
}

/** Recognised on the processed-refund date, retaining the original-order link. */
export interface RefundInput {
  externalId: string;
  orderExternalId: string;
  processedBusinessDate: string;
  amount: DecimalInput;
  restocked: boolean;
  lines?: RefundLineInput[];
}

export interface AdSpendInput {
  platform: "meta" | "tiktok";
  businessDate: string;
  spend: DecimalInput;
  /** Platform-attributed figures. Never mixed into QNCH contribution maths. */
  attributedPurchases?: number;
  attributedPurchaseValue?: DecimalInput;
}

/** A cost taken from mapped Xero accounts rather than an assumption. */
export interface MappedExpenseInput {
  businessDate: string;
  bucket: FinancialBucket;
  amount: DecimalInput;
  category: string;
}

export interface AllocatedCostBreakdown {
  productCogs: DecimalInput;
  packaging: DecimalInput;
  inboundFreight: DecimalInput;
  paymentProcessing: DecimalInput;
  otherVariableProductCosts: DecimalInput;
  fulfilment: DecimalInput;
  shipping: DecimalInput;
  shopifyAndVariableApps: DecimalInput;
  otherVariableOperatingCosts: DecimalInput;
}
