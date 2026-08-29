/**
 * The timeframes every dashboard KPI supports, and the comparison window for each.
 *
 * Ranges are built from the business date in the organisation timezone, never from the
 * server's clock, so "today" means today in London regardless of where this runs.
 */

import {
  monthToDate,
  precedingRange,
  previousMonth,
  rangeEndingOn,
  sameRangeLastYear,
  yearToDate,
  addDays,
  type DateRange,
} from "@/lib/financial/dates";

export const TIMEFRAMES = {
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  mtd: "Month to date",
  "previous-month": "Previous month",
  ytd: "Year to date",
} as const;

export type TimeframeKey = keyof typeof TIMEFRAMES;

export const DEFAULT_TIMEFRAME: TimeframeKey = "30d";

export function isTimeframeKey(value: string | undefined): value is TimeframeKey {
  return value !== undefined && value in TIMEFRAMES;
}

export interface ResolvedTimeframe {
  key: TimeframeKey | "custom";
  label: string;
  range: DateRange;
  /** The equivalent preceding window, for period-on-period comparison. */
  comparison: DateRange;
  /** The same window a year earlier. Null where a year-on-year read would mislead. */
  lastYear: DateRange | null;
}

export function resolveTimeframe(key: TimeframeKey, today: string): ResolvedTimeframe {
  const range = rangeFor(key, today);
  return {
    key,
    label: TIMEFRAMES[key],
    range,
    comparison: key === "previous-month" ? previousMonth(range.from) : precedingRange(range),
    // Year to date is compared against the preceding period only. The same window last year
    // would run to today's date in a year that has already finished, which is not comparable.
    lastYear: key === "ytd" ? null : sameRangeLastYear(range),
  };
}

export function resolveCustomRange(range: DateRange): ResolvedTimeframe {
  return {
    key: "custom",
    label: `${range.from} to ${range.to}`,
    range,
    comparison: precedingRange(range),
    lastYear: sameRangeLastYear(range),
  };
}

function rangeFor(key: TimeframeKey, today: string): DateRange {
  switch (key) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const yesterday = addDays(today, -1);
      return { from: yesterday, to: yesterday };
    }
    case "7d":
      return rangeEndingOn(today, 7);
    case "30d":
      return rangeEndingOn(today, 30);
    case "mtd":
      return monthToDate(today);
    case "previous-month":
      return previousMonth(today);
    case "ytd":
      return yearToDate(today);
  }
}
