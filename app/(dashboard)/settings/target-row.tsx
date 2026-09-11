"use client";

import { useActionState } from "react";
import { saveTarget, type TargetActionState } from "./actions";
import type { MetricBasis } from "@/lib/monitoring/metric-catalogue";

/** The unit shown beside the input, so 15 cannot be mistaken for 15% or £15. */
const UNIT: Record<MetricBasis, string> = {
  currency: "£",
  percentage: "%",
  multiple: "x",
  days: "days",
  count: "",
};

export function TargetRow({
  metricKey,
  label,
  description,
  basis,
  direction,
  currentValue,
  currentSeverity,
}: {
  metricKey: string;
  label: string;
  description: string;
  basis: MetricBasis;
  direction: "higher_is_better" | "lower_is_better";
  currentValue: number | null;
  currentSeverity: "amber" | "red" | null;
}) {
  const [state, action, pending] = useActionState<TargetActionState, FormData>(saveTarget, {
    status: "idle",
  });

  const unit = UNIT[basis];

  return (
    <tr>
      <td>
        <strong>{label}</strong>
        <br />
        <span className="muted small">{description}</span>
        {state.status !== "idle" && !pending ? (
          <>
            <br />
            <span className={`small status-${state.status === "rejected" ? "red" : "green"}`}>
              {state.message}
            </span>
          </>
        ) : null}
      </td>

      <td className="muted small">
        {/* Stated rather than chosen: a ceiling on CAC and a floor on margin are properties of
            the metric, and offering the choice is an opportunity to set one backwards. */}
        {direction === "higher_is_better" ? "at least" : "no more than"}
      </td>

      <td>
        <form action={action} className="target-form">
          <input type="hidden" name="metricKey" value={metricKey} />
          <div className="target-input">
            {unit === "£" ? <span className="unit">£</span> : null}
            <input
              name="value"
              type="number"
              step="any"
              inputMode="decimal"
              defaultValue={currentValue ?? ""}
              placeholder="—"
              aria-label={`${label} target`}
            />
            {unit && unit !== "£" ? <span className="unit">{unit}</span> : null}
          </div>

          <select name="severity" defaultValue={currentSeverity ?? "amber"} aria-label={`${label} severity`}>
            <option value="amber">Amber</option>
            <option value="red">Red</option>
          </select>

          <button type="submit" name="intent" value="save" disabled={pending}>
            {pending ? "…" : "Save"}
          </button>
          {currentValue !== null ? (
            <button type="submit" name="intent" value="clear" className="link-button" disabled={pending}>
              Stop judging
            </button>
          ) : null}
        </form>
      </td>
    </tr>
  );
}
