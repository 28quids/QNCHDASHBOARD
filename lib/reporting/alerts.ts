/**
 * Turns a report into the observations targets are judged against.
 *
 * The evaluation itself lives in `lib/monitoring/targets.ts` and decides nothing about what
 * "good" looks like — every threshold comes from `metric_targets`. This module's only job is to
 * say what each metric key is currently worth, and to be honest about the ones it cannot value.
 *
 * **Absent is never zero here.** A metric with no observation is reported as `unavailable`
 * rather than green, because a dashboard that reads "all clear" when the underlying figure
 * could not be calculated is worse than one that admits it does not know.
 */

import type Decimal from "decimal.js";
import type { CashPosition } from "@/lib/financial/cash";
import type { InventoryPosition } from "@/lib/financial/inventory";
import { ratio } from "@/lib/financial/money";
import {
  activeAlerts,
  evaluateMetrics,
  overallStatus,
  type MetricTarget,
  type TargetEvaluation,
  type TargetStatus,
} from "@/lib/monitoring/targets";
import { metricDefinition } from "@/lib/monitoring/metric-catalogue";
import type { ControlCentreReport } from "./report";

export interface ObservationSources {
  report: ControlCentreReport;
  /** Present only on pages that load it. Cash metrics are unavailable without it. */
  cash?: CashPosition | null;
  /** Whether a bank balance was actually reported, as opposed to defaulted to zero. */
  hasReportedBankBalance?: boolean;
  inventory?: readonly InventoryPosition[] | null;
}

/**
 * The current value of every metric in the catalogue, or null where it cannot be calculated.
 *
 * Every key is present in the map even when its value is null. That is deliberate: a key that
 * is simply missing produces no evaluation at all, so a configured target would silently never
 * be checked, which is indistinguishable from it passing.
 */
export function buildObservations(sources: ObservationSources): Map<string, Decimal | null> {
  const { summary, marketing } = sources.report;

  const platform = (name: "meta" | "tiktok") =>
    marketing.platforms.find((candidate) => candidate.platform === name) ?? null;

  const observations = new Map<string, Decimal | null>([
    ["net_revenue", summary.netRevenue],
    ["average_order_value", summary.averageOrderValue],
    // Against gross sales, not net: measuring refunds against revenue they have already been
    // deducted from would understate the rate on a heavily refunded period.
    ["refund_rate", ratio(summary.refunds, summary.grossSales)],
    ["cm1_margin", summary.cm1Margin],
    ["cm2_margin", summary.cm2Margin],
    ["cm3_margin", summary.cm3Margin],
    // Null rather than CM3 relabelled: operating margin without fixed costs is not a margin.
    ["operating_margin", summary.fixedOperatingCosts.isZero() ? null : summary.operatingMargin],
    ["blended_cac", marketing.blendedCac],
    ["mer", marketing.mer],
    ["cac_headroom", marketing.cacHeadroom],
    ["roas_headroom", marketing.roasHeadroom],
    ["meta_cac", platform("meta")?.attributedCac ?? null],
    ["tiktok_cac", platform("tiktok")?.attributedCac ?? null],
    ["meta_roas", platform("meta")?.attributedRoas ?? null],
    ["tiktok_roas", platform("tiktok")?.attributedRoas ?? null],
  ]);

  // Cash is only observable where a balance was genuinely reported. `buildCashPosition` is
  // given zero when none was, so reading its output blindly would judge an unknown balance
  // against a minimum-cash target and raise a red alert about a figure nobody has.
  const cashKnown = sources.cash != null && sources.hasReportedBankBalance === true;
  observations.set("cash_balance", cashKnown ? sources.cash!.bankBalance : null);
  observations.set("available_cash", cashKnown ? sources.cash!.availableCash : null);
  observations.set("cash_runway_days", cashKnown ? sources.cash!.runwayDays : null);

  observations.set("minimum_inventory_days", lowestCover(sources.inventory));

  return observations;
}

/**
 * Days of cover on the SKU closest to running out.
 *
 * Variants with no cover figure are skipped rather than treated as zero: nothing is selling, so
 * the SKU is not about to stock out, and counting it as zero days would make the whole check
 * fire permanently on a discontinued line.
 */
export function lowestCover(positions: readonly InventoryPosition[] | null | undefined): Decimal | null {
  if (!positions || positions.length === 0) return null;

  const covers = positions
    .map((position) => position.daysOfStockRemaining)
    .filter((cover): cover is Decimal => cover !== null);

  if (covers.length === 0) return null;
  return covers.reduce((lowest, cover) => (cover.lessThan(lowest) ? cover : lowest));
}

export interface HealthAssessment {
  status: TargetStatus;
  /** Everything not green, most severe first. */
  alerts: TargetEvaluation[];
  evaluations: TargetEvaluation[];
  /** The evaluation for one metric, for a status pill beside its figure. */
  statusOf: (metricKey: string) => TargetStatus | undefined;
  /** A human sentence for one metric, or undefined where no target applies. */
  noteOf: (metricKey: string) => string | undefined;
  /** True when no target has been configured at all, which is not the same as healthy. */
  hasTargets: boolean;
}

/**
 * Evaluates the configured targets against the period's figures.
 *
 * `businessDate` is the end of the period rather than today, so restating a past period is
 * judged against the target that was in force then rather than against the current one.
 */
export function assessHealth(
  sources: ObservationSources,
  targets: readonly MetricTarget[],
  businessDate: string,
): HealthAssessment {
  const observations = buildObservations(sources);
  const configured = new Set(targets.map((target) => target.metricKey));

  const evaluations = evaluateMetrics(observations, targets, businessDate);
  const byKey = new Map(evaluations.map((evaluation) => [evaluation.metricKey, evaluation]));

  return {
    // An unconfigured metric evaluates green, so a dashboard with no targets at all would
    // otherwise report perfect health. That is reported as unavailable instead.
    status: configured.size === 0 ? "unavailable" : overallStatus(evaluations.filter((e) => configured.has(e.metricKey))),
    alerts: activeAlerts(evaluations.filter((evaluation) => configured.has(evaluation.metricKey))),
    evaluations,
    hasTargets: configured.size > 0,

    statusOf: (metricKey) => (configured.has(metricKey) ? byKey.get(metricKey)?.status : undefined),

    noteOf: (metricKey) => {
      if (!configured.has(metricKey)) return undefined;
      const evaluation = byKey.get(metricKey);
      if (!evaluation) return undefined;

      const definition = metricDefinition(metricKey);
      const target = evaluation.breachedTarget;
      if (!target) return evaluation.status === "unavailable" ? "not calculable" : "within target";

      const wording = target.comparison === "gte" ? "target ≥" : target.comparison === "lte" ? "target ≤" : "target";
      const value =
        definition?.basis === "ratio"
          ? `${(Number(target.targetValue) * 100).toFixed(1)}%`
          : String(target.targetValue);
      return `${wording} ${value}`;
    },
  };
}

/** The label a metric key is shown under, falling back to the key when it is not catalogued. */
export const metricLabel = (metricKey: string): string => metricDefinition(metricKey)?.label ?? metricKey;
