"use client";

import { useActionState } from "react";
import { saveReport, type SaveReportState } from "./actions";

/**
 * Saving the report currently on screen.
 *
 * The specification is carried in hidden fields taken from what the page actually rendered,
 * rather than re-read from the URL here, so what gets saved is unambiguously what was shown.
 */
export function SaveReportForm({
  metrics,
  grain,
  timeframeKey,
  range,
}: {
  metrics: readonly string[];
  grain: string;
  timeframeKey: string | null;
  range: { from: string; to: string } | null;
}) {
  const [state, action, pending] = useActionState<SaveReportState, FormData>(saveReport, { status: "idle" });

  return (
    <form action={action} className="report-save">
      {metrics.map((metric) => (
        <input key={metric} type="hidden" name="metric" value={metric} />
      ))}
      <input type="hidden" name="grain" value={grain} />
      {range ? (
        <>
          <input type="hidden" name="from" value={range.from} />
          <input type="hidden" name="to" value={range.to} />
        </>
      ) : (
        <input type="hidden" name="timeframe" value={timeframeKey ?? "30d"} />
      )}

      <label>
        <span className="label">Save this report as</span>
        <input name="name" placeholder="Monthly contribution" required maxLength={80} />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </button>

      {state.status !== "idle" && !pending ? (
        <p className={`small status-${state.status === "saved" ? "green" : "red"}`}>{state.message}</p>
      ) : null}
    </form>
  );
}

export function DeleteReportButton({ id, name }: { id: string; name: string }) {
  const [state, action, pending] = useActionState<SaveReportState, FormData>(
    (previous, form) => import("./actions").then((module) => module.deleteReport(previous, form)),
    { status: "idle" },
  );

  return (
    <form action={action} style={{ display: "inline" }}>
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="link-button" disabled={pending} aria-label={`Delete ${name}`}>
        {pending ? "…" : "delete"}
      </button>
      {state.status === "error" ? <span className="small status-red"> {state.message}</span> : null}
    </form>
  );
}
