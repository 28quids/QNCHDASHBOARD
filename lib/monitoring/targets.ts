import Decimal from "decimal.js";
import { resolveAllEffective, type EffectiveDated } from "@/lib/financial/effective-dating";
import { money, type DecimalInput } from "@/lib/financial/money";

/**
 * Target evaluation. Every threshold comes from `metric_targets`, so nothing here decides what
 * "good" looks like — a target that has not been configured produces no judgement at all.
 */

export type AlertSeverity = "green" | "amber" | "red";
export type TargetStatus = AlertSeverity | "unavailable";
export type TargetComparison = "gte" | "lte" | "eq";

export interface MetricTarget extends EffectiveDated {
  metricKey: string;
  targetValue: DecimalInput;
  comparison: TargetComparison;
  /** Severity raised when this threshold is breached. */
  severity: Exclude<AlertSeverity, "green">;
}

export interface TargetEvaluation {
  metricKey: string;
  observed: Decimal | null;
  status: TargetStatus;
  /** The threshold that produced the status, if any was breached. */
  breachedTarget: MetricTarget | null;
  message: string;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { green: 0, amber: 1, red: 2 };

function isBreached(observed: Decimal, target: MetricTarget): boolean {
  const value = money(target.targetValue);
  switch (target.comparison) {
    case "gte":
      return observed.lessThan(value);
    case "lte":
      return observed.greaterThan(value);
    case "eq":
      return !observed.equals(value);
  }
}

function describe(target: MetricTarget): string {
  const wording = { gte: "at least", lte: "no more than", eq: "exactly" }[target.comparison];
  return `${target.metricKey} should be ${wording} ${money(target.targetValue).toString()}`;
}

/**
 * Evaluates one metric against every target in force, returning the most severe breach.
 *
 * A metric with no observed value is `unavailable`, never `green`: an absent number must not
 * read as a healthy one.
 */
export function evaluateMetric(
  metricKey: string,
  observed: Decimal | null,
  targets: readonly MetricTarget[],
  businessDate: string,
): TargetEvaluation {
  const applicable = resolveAllEffective(targets, businessDate).filter((target) => target.metricKey === metricKey);

  if (observed === null) {
    return {
      metricKey,
      observed: null,
      status: "unavailable",
      breachedTarget: null,
      message: `${metricKey} could not be calculated`,
    };
  }

  if (applicable.length === 0) {
    return { metricKey, observed, status: "green", breachedTarget: null, message: `${metricKey} has no configured target` };
  }

  const breaches = applicable.filter((target) => isBreached(observed, target));
  if (breaches.length === 0) {
    return { metricKey, observed, status: "green", breachedTarget: null, message: `${metricKey} is within target` };
  }

  const worst = breaches.reduce((current, target) =>
    SEVERITY_RANK[target.severity] > SEVERITY_RANK[current.severity] ? target : current,
  );

  return {
    metricKey,
    observed,
    status: worst.severity,
    breachedTarget: worst,
    message: `${describe(worst)}, but is ${observed.toString()}`,
  };
}

export function evaluateMetrics(
  observations: ReadonlyMap<string, Decimal | null>,
  targets: readonly MetricTarget[],
  businessDate: string,
): TargetEvaluation[] {
  return [...observations].map(([metricKey, observed]) => evaluateMetric(metricKey, observed, targets, businessDate));
}

/** The worst status across evaluations, used for the dashboard's overall health indicator. */
export function overallStatus(evaluations: readonly TargetEvaluation[]): TargetStatus {
  if (evaluations.some((evaluation) => evaluation.status === "red")) return "red";
  if (evaluations.some((evaluation) => evaluation.status === "amber")) return "amber";
  if (evaluations.some((evaluation) => evaluation.status === "unavailable")) return "unavailable";
  return "green";
}

/** Only the evaluations worth showing as alerts, most severe first. */
export function activeAlerts(evaluations: readonly TargetEvaluation[]): TargetEvaluation[] {
  return evaluations
    .filter((evaluation) => evaluation.status !== "green")
    .sort((a, b) => rank(b.status) - rank(a.status));
}

const rank = (status: TargetStatus): number => (status === "unavailable" ? 1.5 : SEVERITY_RANK[status]);
