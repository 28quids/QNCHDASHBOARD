import Decimal from "decimal.js";
import { assertBusinessDate, resolveAllEffective, resolveEffectiveByKey } from "./effective-dating";
import { allocateProportionally, money, ZERO } from "./money";
import type {
  CostAssumptionRecord,
  FinancialBucket,
  OrderLineInput,
  PeriodUnit,
  VariantCostProfile,
} from "./domain";

/**
 * Named P&L components an assumption can target. Assumption keys map onto a named line where
 * QNCH has one; anything else is reported in the "other" line for its approved bucket, so a
 * new cost can be added in settings without a code change and without being silently hidden.
 */
export type NamedCostComponent =
  | "productCogs"
  | "packaging"
  | "inboundFreight"
  | "paymentProcessing"
  | "otherVariableProductCosts"
  | "fulfilment"
  | "shipping"
  | "shopifyAndVariableApps"
  | "otherVariableOperatingCosts";

const ASSUMPTION_KEY_COMPONENTS: Record<string, NamedCostComponent> = {
  product_cogs: "productCogs",
  packaging: "packaging",
  inbound_freight: "inboundFreight",
  payment_processing: "paymentProcessing",
  fulfilment: "fulfilment",
  outbound_shipping: "shipping",
  shipping: "shipping",
  shopify_fees: "shopifyAndVariableApps",
  variable_apps: "shopifyAndVariableApps",
};

const BUCKET_FALLBACK_COMPONENTS: Partial<Record<FinancialBucket, NamedCostComponent>> = {
  cm1: "otherVariableProductCosts",
  cm3: "otherVariableOperatingCosts",
};

/** Where an assumption's value should be reported, or null when it is not a P&L order cost. */
export function componentForAssumption(assumption: CostAssumptionRecord): NamedCostComponent | null {
  return ASSUMPTION_KEY_COMPONENTS[assumption.assumptionKey] ?? BUCKET_FALLBACK_COMPONENTS[assumption.financialBucket] ?? null;
}

export interface ResolvedVariantUnitCosts {
  productCogs: Decimal;
  packaging: Decimal;
  inboundFreight: Decimal;
  paymentProcessing: Decimal;
  fulfilment: Decimal;
  shipping: Decimal;
}

export const ZERO_UNIT_COSTS: ResolvedVariantUnitCosts = {
  productCogs: ZERO,
  packaging: ZERO,
  inboundFreight: ZERO,
  paymentProcessing: ZERO,
  fulfilment: ZERO,
  shipping: ZERO,
};

/** The per-unit cost profile in force for each variant on the date. */
export function resolveVariantUnitCosts(
  profiles: readonly VariantCostProfile[],
  businessDate: string,
): Map<string, ResolvedVariantUnitCosts> {
  const resolved = resolveEffectiveByKey(profiles, businessDate, (profile) => profile.variantId);
  const costs = new Map<string, ResolvedVariantUnitCosts>();
  for (const [variantId, profile] of resolved) {
    costs.set(variantId, {
      productCogs: money(profile.productCogs),
      packaging: money(profile.packaging),
      inboundFreight: money(profile.inboundFreight),
      paymentProcessing: money(profile.paymentProcessing),
      fulfilment: money(profile.fulfilment),
      shipping: money(profile.shipping),
    });
  }
  return costs;
}

/** Variants with orders on the date but no approved cost profile. Their COGS cannot be trusted. */
export function findVariantsMissingCosts(
  lines: readonly OrderLineInput[],
  unitCosts: ReadonlyMap<string, ResolvedVariantUnitCosts>,
): string[] {
  const missing = new Set<string>();
  for (const line of lines) {
    if (line.variantId && !unitCosts.has(line.variantId)) missing.add(line.variantId);
  }
  return [...missing];
}

export function assumptionMatchesLine(assumption: CostAssumptionRecord, line: OrderLineInput): boolean {
  const target = assumption.appliesTo;
  if (target === "all_orders") return true;
  if (target.startsWith("sku:")) return line.sku === target.slice(4);
  if (target.startsWith("variant:")) return line.variantId === target.slice(8);
  return false;
}

export function assumptionMatchesOrder(assumption: CostAssumptionRecord, lines: readonly OrderLineInput[]): boolean {
  if (assumption.appliesTo === "all_orders") return true;
  return lines.some((line) => assumptionMatchesLine(assumption, line));
}

export interface ResolvedAssumptions {
  /** Applied while allocating individual orders. */
  orderLevel: CostAssumptionRecord[];
  /** Applied once per day, independent of order volume. */
  fixedPeriod: CostAssumptionRecord[];
}

export function resolveAssumptions(
  assumptions: readonly CostAssumptionRecord[],
  businessDate: string,
): ResolvedAssumptions {
  const effective = resolveAllEffective(assumptions, businessDate);
  return {
    orderLevel: effective.filter((assumption) => assumption.chargeBasis !== "fixed_period"),
    fixedPeriod: effective.filter((assumption) => assumption.chargeBasis === "fixed_period"),
  };
}

/** Where the date sits within its period, and how many days that period has. */
function periodPosition(unit: PeriodUnit, businessDate: string): { index: number; days: number } {
  const [year, month, day] = businessDate.split("-").map(Number);
  switch (unit) {
    case "day":
      return { index: 0, days: 1 };
    case "week": {
      // Monday-start weeks, so any Monday-to-Sunday week sums to the approved weekly amount.
      const isoWeekday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
      return { index: isoWeekday, days: 7 };
    }
    case "month":
      return { index: day - 1, days: new Date(Date.UTC(year, month, 0)).getUTCDate() };
    case "year": {
      const dayOfYear = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86_400_000);
      const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
      return { index: dayOfYear, days: isLeap ? 366 : 365 };
    }
  }
}

/**
 * The share of a recurring cost that falls on one day.
 *
 * Uses penny-exact allocation rather than plain division so that the daily values across a
 * period sum back to the approved amount: £310 over a 28-day February must total £310, not
 * £310.0000000000000000000000005.
 */
export function dailyFixedPeriodAmount(assumption: CostAssumptionRecord, businessDate: string): Decimal {
  assertBusinessDate(businessDate);
  const { index, days } = periodPosition(assumption.periodUnit ?? "month", businessDate);
  return allocateProportionally(assumption.amount, new Array<number>(days).fill(1))[index];
}

/** Total daily cost for each bucket from all `fixed_period` assumptions in force. */
export function dailyFixedCostsByBucket(
  assumptions: readonly CostAssumptionRecord[],
  businessDate: string,
): Map<FinancialBucket, Decimal> {
  const totals = new Map<FinancialBucket, Decimal>();
  for (const assumption of resolveAssumptions(assumptions, businessDate).fixedPeriod) {
    const current = totals.get(assumption.financialBucket) ?? ZERO;
    totals.set(assumption.financialBucket, current.plus(dailyFixedPeriodAmount(assumption, businessDate)));
  }
  return totals;
}
