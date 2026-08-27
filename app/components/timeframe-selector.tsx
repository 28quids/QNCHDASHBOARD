import Link from "next/link";
import { TIMEFRAMES, type TimeframeKey } from "@/lib/reporting/timeframes";
import { formatDateRange } from "@/lib/reporting/format";
import type { DateRange } from "@/lib/financial/dates";

export function TimeframeSelector({
  pathname,
  active,
  range,
}: {
  pathname: string;
  active: TimeframeKey | "custom";
  range: DateRange;
}) {
  return (
    <>
      <div className="timeframes">
        {(Object.keys(TIMEFRAMES) as TimeframeKey[]).map((key) => (
          <Link
            key={key}
            href={`${pathname}?timeframe=${key}`}
            aria-current={key === active ? "true" : undefined}
          >
            {TIMEFRAMES[key]}
          </Link>
        ))}
      </div>
      <p className="muted small" style={{ marginTop: "-1.25rem", marginBottom: "2rem" }}>
        {formatDateRange(range.from, range.to)}
      </p>
    </>
  );
}
