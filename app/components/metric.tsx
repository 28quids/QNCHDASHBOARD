import { UNAVAILABLE, type Change } from "@/lib/reporting/format";
import type { TargetStatus } from "@/lib/monitoring/targets";

export interface MetricProps {
  label: string;
  value: string;
  change?: Change;
  /** Secondary line, e.g. the target being measured against. */
  note?: string;
  status?: TargetStatus;
  /**
   * Set for metrics where an increase is bad — CAC, ad spend, refunds. Without it a rising
   * cost would be coloured green simply because the number went up.
   */
  higherIsWorse?: boolean;
}

export function Metric({ label, value, change, note, status, higherIsWorse }: MetricProps) {
  const unavailable = value === UNAVAILABLE;

  return (
    <div className={`metric${higherIsWorse ? " invert" : ""}`}>
      <div className="label">{label}</div>
      <div className={`value${unavailable ? " unavailable" : ""}`}>{value}</div>
      <div className="foot">
        {change ? <span className={`delta-${change.direction}`}>{change.label}</span> : null}
        {note ? <span>{note}</span> : null}
        {status ? <StatusPill status={status} /> : null}
      </div>
    </div>
  );
}

export function StatusPill({ status }: { status: TargetStatus }) {
  const label = status === "unavailable" ? "no data" : status;
  return <span className={`pill status-${status}`}>{label}</span>;
}
