/**
 * Setting and clearing metric targets from the application.
 *
 * The CLI (`npm run seed:targets`) and this do the same two things, and both go through the
 * same database function so they cannot diverge on the part that matters: a target is versioned
 * by `effective_from`, so replacing one is an end-date plus an insert, and those must happen
 * together or a metric is briefly unjudged or briefly judged twice.
 *
 * Everything here runs as the signed-in user. `metric_targets` carries a `finance_admin_manage`
 * policy, so an operator or viewer attempting this is refused by the database rather than by a
 * check in the page that could be forgotten.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  comparisonFor,
  metricDefinition,
  type MetricDefinition,
} from "@/lib/monitoring/metric-catalogue";

export type TargetSeverity = "amber" | "red";

export interface TargetInput {
  metricKey: string;
  /** As a person would type it: 15 for a 15% margin, 3 for a 3x MER, 22 for a £22 CAC. */
  enteredValue: number;
  severity: TargetSeverity;
  /** Defaults to today, so a change does not silently restate periods already reported. */
  effectiveFrom?: string;
}

/**
 * The value as stored, from the value as typed.
 *
 * A percentage is stored as a ratio and a multiple is not: 15% becomes 0.15 while 3x stays 3.
 * Both are ratios in the loose sense and both look plausible in a table, so getting this wrong
 * produces a target that is out by a hundredfold and reads as reasonable — which is why the
 * conversion lives here and in the CLI rather than in anyone's head.
 */
export function storedValue(definition: MetricDefinition, enteredValue: number): number {
  return definition.basis === "percentage" ? enteredValue / 100 : enteredValue;
}

/** The inverse, for showing a stored target back in the form that set it. */
export function enteredValue(definition: MetricDefinition, stored: number): number {
  return definition.basis === "percentage" ? stored * 100 : stored;
}

export interface TargetWriteResult {
  status: "saved" | "cleared" | "rejected";
  message: string;
}

export function createMetricTargetWriter(client: SupabaseClient, organisationId: string) {
  const today = () => new Date().toISOString().slice(0, 10);

  return {
    async set(input: TargetInput): Promise<TargetWriteResult> {
      const definition = metricDefinition(input.metricKey);
      if (!definition) {
        return { status: "rejected", message: `${input.metricKey} is not a metric that is evaluated.` };
      }
      if (!Number.isFinite(input.enteredValue)) {
        return { status: "rejected", message: "Enter a number." };
      }
      if (input.severity !== "amber" && input.severity !== "red") {
        return { status: "rejected", message: "Severity must be amber or red." };
      }

      const { error } = await client.rpc("set_metric_target", {
        p_organisation_id: organisationId,
        p_metric_key: input.metricKey,
        p_target_value: storedValue(definition, input.enteredValue),
        // Derived, never supplied: a target on CAC is a ceiling and one on margin is a floor,
        // and letting either be chosen is an opportunity to set one backwards.
        p_comparison: comparisonFor(definition),
        p_severity: input.severity,
        p_effective_from: input.effectiveFrom ?? today(),
      });

      if (error) return { status: "rejected", message: refusalMessage(error.message) };
      return { status: "saved", message: `${definition.label} target saved.` };
    },

    async clear(metricKey: string): Promise<TargetWriteResult> {
      const definition = metricDefinition(metricKey);
      if (!definition) return { status: "rejected", message: `${metricKey} is not a known metric.` };

      const { error } = await client.rpc("clear_metric_target", {
        p_organisation_id: organisationId,
        p_metric_key: metricKey,
        p_effective_to: today(),
      });

      if (error) return { status: "rejected", message: refusalMessage(error.message) };
      return {
        status: "cleared",
        message: `${definition.label} is no longer judged. Periods before today keep the target they were reported against.`,
      };
    },
  };
}

/**
 * Row-level security refuses a write by returning an error, not by throwing something special.
 * Reported as a permission answer rather than as a fault, because that is what it is.
 */
function refusalMessage(message: string): string {
  return /row-level security|permission denied/i.test(message)
    ? "Only an owner or finance administrator can change targets."
    : `Could not save: ${message}`;
}
