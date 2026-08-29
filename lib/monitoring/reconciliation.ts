import Decimal from "decimal.js";
import type { DateRange } from "@/lib/financial/dates";
import { money, sum, type DecimalInput } from "@/lib/financial/money";

/**
 * Reconciliation between independent sources.
 *
 * A difference is always reported. Nothing here adjusts, rounds away or forces a match: an
 * unexplained gap between Shopify, the platforms and Xero is a finding, not a bug to hide.
 */

export type ReconciliationStatus = "matched" | "within_tolerance" | "unmatched" | "needs_review" | "not_applicable";

export interface ReconciliationSource {
  label: string;
  value: DecimalInput | null;
}

export interface ReconciliationInput {
  reconciliationKey: string;
  period: DateRange;
  sourceA: ReconciliationSource;
  sourceB: ReconciliationSource;
  /** Absolute difference treated as acceptable, e.g. rounding or timing. */
  tolerance?: DecimalInput;
}

export interface ReconciliationResult {
  reconciliationKey: string;
  period: DateRange;
  sourceALabel: string;
  sourceBLabel: string;
  sourceAValue: Decimal | null;
  sourceBValue: Decimal | null;
  difference: Decimal | null;
  /** Difference as a share of source A, for judging materiality. */
  differenceRate: Decimal | null;
  tolerance: Decimal;
  status: ReconciliationStatus;
  message: string;
}

export function reconcile(input: ReconciliationInput): ReconciliationResult {
  const tolerance = money(input.tolerance ?? 0);
  const base = {
    reconciliationKey: input.reconciliationKey,
    period: input.period,
    sourceALabel: input.sourceA.label,
    sourceBLabel: input.sourceB.label,
    tolerance,
  };

  if (input.sourceA.value === null || input.sourceB.value === null) {
    return {
      ...base,
      sourceAValue: input.sourceA.value === null ? null : money(input.sourceA.value),
      sourceBValue: input.sourceB.value === null ? null : money(input.sourceB.value),
      difference: null,
      differenceRate: null,
      status: "not_applicable",
      message: `Cannot reconcile: ${input.sourceA.value === null ? input.sourceA.label : input.sourceB.label} has no value`,
    };
  }

  const sourceAValue = money(input.sourceA.value);
  const sourceBValue = money(input.sourceB.value);
  const difference = sourceAValue.minus(sourceBValue);
  const magnitude = difference.abs();

  const status: ReconciliationStatus = magnitude.isZero()
    ? "matched"
    : magnitude.lessThanOrEqualTo(tolerance)
      ? "within_tolerance"
      : "unmatched";

  return {
    ...base,
    sourceAValue,
    sourceBValue,
    difference,
    differenceRate: sourceAValue.isZero() ? null : difference.div(sourceAValue),
    status,
    message:
      status === "matched"
        ? `${input.sourceA.label} matches ${input.sourceB.label}`
        : `${input.sourceA.label} ${sourceAValue.toString()} vs ${input.sourceB.label} ${sourceBValue.toString()} (difference ${difference.toString()})`,
  };
}

export interface DatedAmount {
  businessDate: string;
  amount: DecimalInput;
}

const totalInRange = (entries: readonly DatedAmount[], period: DateRange): Decimal =>
  sum(
    entries
      .filter((entry) => entry.businessDate >= period.from && entry.businessDate <= period.to)
      .map((entry) => entry.amount),
  );

/**
 * Platform-reported spend against the money that actually left the bank.
 * Billing lags mean a tolerance is expected; a persistent gap is not.
 */
export function reconcilePlatformSpend(
  platform: "meta" | "tiktok",
  platformSpend: readonly DatedAmount[],
  accountingSpend: readonly DatedAmount[],
  period: DateRange,
  tolerance: DecimalInput = 0,
): ReconciliationResult {
  return reconcile({
    reconciliationKey: `ad_spend.${platform}`,
    period,
    sourceA: { label: `${platform} reported spend`, value: totalInRange(platformSpend, period) },
    sourceB: { label: "Xero recorded spend", value: totalInRange(accountingSpend, period) },
    tolerance,
  });
}

/** Shopify order revenue against processor settlements for the same period. */
export function reconcileShopifyPayouts(
  shopifyRevenue: readonly DatedAmount[],
  payouts: readonly DatedAmount[],
  period: DateRange,
  tolerance: DecimalInput = 0,
): ReconciliationResult {
  return reconcile({
    reconciliationKey: "revenue.shopify_payouts",
    period,
    sourceA: { label: "Shopify reported revenue", value: totalInRange(shopifyRevenue, period) },
    sourceB: { label: "Payment processor settlements", value: totalInRange(payouts, period) },
    tolerance,
  });
}

/** The bank balance QNCH's own model implies against the balance Xero reports. */
export function reconcileBankBalance(
  modelledBalance: DecimalInput | null,
  xeroBalance: DecimalInput | null,
  period: DateRange,
  tolerance: DecimalInput = 0,
): ReconciliationResult {
  return reconcile({
    reconciliationKey: "cash.bank_balance",
    period,
    sourceA: { label: "Calculated balance", value: modelledBalance },
    sourceB: { label: "Xero bank balance", value: xeroBalance },
    tolerance,
  });
}

export interface ReconciliationSummary {
  status: ReconciliationStatus;
  unmatched: ReconciliationResult[];
  results: ReconciliationResult[];
  /** Total unexplained difference across all unmatched checks. */
  totalUnmatchedDifference: Decimal;
}

export function summariseReconciliation(results: readonly ReconciliationResult[]): ReconciliationSummary {
  const unmatched = results.filter((result) => result.status === "unmatched");
  const notApplicable = results.filter((result) => result.status === "not_applicable");

  return {
    status: unmatched.length > 0 ? "unmatched" : notApplicable.length > 0 ? "needs_review" : "matched",
    unmatched,
    results: [...results],
    totalUnmatchedDifference: sum(unmatched.map((result) => (result.difference as Decimal).abs())),
  };
}
