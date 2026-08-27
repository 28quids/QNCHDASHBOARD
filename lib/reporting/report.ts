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
 * One warning per distinct cause. A missing cost profile otherwise repeats on every day of the
 * range, which buries the other warnings under it.
 */
function deduplicateWarnings(warnings: readonly DailyWarning[]): DailyWarning[] {
  const seen = new Map<string, DailyWarning>();
  for (const warning of warnings) {
    const key = `${warning.code}:${warning.detail}`;
    if (!seen.has(key)) seen.set(key, warning);
  }
  return [...seen.values()];
}
