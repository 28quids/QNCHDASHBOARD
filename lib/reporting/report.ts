/**
 * Composes the loaded facts into the figures the control centre presents.
 *
 * Everything here is assembly. The contribution walk, the marketing maths and the SKU
 * economics all live in `lib/financial`; this module's only job is to hand each of them the
 * right slice of one consistent set of facts, so that the P&L, the CAC and the per-SKU view
 * can never disagree about the same period.
 */

import { allocateOrders, contributionBeforeAds, type AllocatedOrder } from "@/lib/financial/allocation";
import {
  buildDailyFinancials,
  summariseDailyFinancials,
  type DailyFinancialRow,
  type DailyFinancialSummary,
  type DailyWarning,
  type DailyWarningCode,
} from "@/lib/financial/daily-aggregation";
import type { DateRange } from "@/lib/financial/dates";
import { calculateMarketingPeriod, type MarketingPeriodResult } from "@/lib/financial/marketing";
import { sum, ZERO } from "@/lib/financial/money";
import { buildSkuUnitEconomics, type SkuUnitEconomics } from "@/lib/financial/unit-economics";
import type { ReportingFacts } from "./reporting-repository";

export interface ControlCentreReport {
  range: DateRange;
  daily: DailyFinancialRow[];
  summary: DailyFinancialSummary;
  marketing: MarketingPeriodResult;
  skus: SkuUnitEconomics[];
  /**
   * Orders in the range with their costs allocated. Exposed so customer and cohort reporting
   * works from the same allocation as the P&L rather than computing a second one that could
   * disagree with it.
   */
  allocated: AllocatedOrder[];
  /** Deduplicated across the period, so one missing cost profile is reported once, not daily. */
  warnings: DailyWarning[];
}

export function buildReport(facts: ReportingFacts): ControlCentreReport {
  const daily = buildDailyFinancials({
    range: facts.range,
    orders: facts.orders,
    refunds: facts.refunds,
    adSpend: facts.adSpend,
    mappedExpenses: facts.mappedExpenses,
    context: facts.context,
    policy: facts.policy,
  });

  const summary = summariseDailyFinancials(daily);

  // Orders outside the range are loaded so refunds can find their original cost basis. They
  // must not reach the SKU or acquisition figures, which report on the range itself.
  const allocated = allocateOrders(facts.orders, facts.context).filter(
    (order) => order.businessDate >= facts.range.from && order.businessDate <= facts.range.to,
  );

  return {
    range: facts.range,
    daily,
    summary,
    marketing: buildMarketing(facts, summary, allocated),
    skus: buildSkuUnitEconomics(allocated),
    allocated,
    warnings: deduplicateWarnings(summary.warnings),
  };
}

function buildMarketing(
  facts: ReportingFacts,
  summary: DailyFinancialSummary,
  allocated: readonly AllocatedOrder[],
): MarketingPeriodResult {
  const level = facts.policy.breakEvenContributionLevel;
  const acquisitions = allocated.filter((order) => order.isNewCustomerOrder);

  const spendFor = (platform: "meta" | "tiktok") =>
    sum(facts.adSpend.filter((spend) => spend.platform === platform).map((spend) => spend.spend));

  const attributedFor = (platform: "meta" | "tiktok") => {
    const rows = facts.adSpend.filter((spend) => spend.platform === platform);
    const purchases = rows.reduce((total, row) => total + (row.attributedPurchases ?? 0), 0);
    const hasValue = rows.some((row) => row.attributedPurchaseValue !== undefined);
    return {
      // Absent, not zero: a platform that reported nothing must not read as zero conversions.
      attributedPurchases: rows.some((row) => row.attributedPurchases !== undefined) ? purchases : undefined,
      attributedPurchaseValue: hasValue
        ? sum(rows.map((row) => row.attributedPurchaseValue ?? ZERO))
        : undefined,
    };
  };

  return calculateMarketingPeriod({
    netRevenue: summary.netRevenue,
    newCustomerNetRevenue: sum(acquisitions.map((order) => order.netRevenue)),
    newCustomerContributionBeforeAds: sum(acquisitions.map((order) => contributionBeforeAds(order, level))),
    newCustomers: acquisitions.length,
    contributionLevel: level,
    platforms: (["meta", "tiktok"] as const).map((platform) => ({
      platform,
      spend: spendFor(platform),
      ...attributedFor(platform),
    })),
    otherAcquisitionSpend: sum(
      facts.mappedExpenses.filter((expense) => expense.bucket === "cm2").map((expense) => expense.amount),
    ),
  });
}

/**
 * One warning per distinct cause for the whole period.
 *
 * A warning raised every day otherwise buries the others under it. Two kinds need different
 * treatment: a warning about a fixed thing — a variant with no cost profile — repeats
 * identically and is deduplicated, while a warning that counts something differs every day
 * and is summed into a single period total instead.
 */
function deduplicateWarnings(warnings: readonly DailyWarning[]): DailyWarning[] {
  const counted = new Map<DailyWarningCode, number>();
  const seen = new Map<string, DailyWarning>();

  for (const warning of warnings) {
    if (warning.count !== undefined) {
      counted.set(warning.code, (counted.get(warning.code) ?? 0) + warning.count);
      continue;
    }
    const key = `${warning.code}:${warning.detail}`;
    if (!seen.has(key)) seen.set(key, warning);
  }

  const totals = [...counted].map(([code, count]) => ({
    code,
    count,
    detail: PERIOD_WARNING_DETAIL[code](count),
  }));

  return [...totals, ...seen.values()];
}

const PERIOD_WARNING_DETAIL: Record<DailyWarningCode, (count: number) => string> = {
  unattributed_order_lines: (count) =>
    `${count} order line(s) in this period have no product variant, so they carry revenue but no cost and overstate margin`,
  missing_variant_costs: (count) => `${count} line(s) sold a variant with no approved cost profile`,
  line_totals_diverge: (count) => `${count} order(s) have lines that do not sum to the header`,
  duplicated_cost_source: (count) => `${count} cost(s) are charged by both an assumption and a Xero mapping`,
  refund_without_original_order: (count) => `${count} refund(s) reference an order that is not in range`,
};
