/**
 * Presentation formatting.
 *
 * Every helper renders a null as an explicit dash rather than a zero. A ratio with no
 * denominator, a margin on no revenue and a CAC with no acquisitions are all genuinely
 * unavailable, and showing them as 0 would read as a measured result.
 */

import type Decimal from "decimal.js";
import type { MetricBasis } from "@/lib/monitoring/metric-catalogue";

export const UNAVAILABLE = "—";

type Numeric = Decimal | number | null | undefined;

const toNumber = (value: Numeric): number | null => {
  if (value === null || value === undefined) return null;
  return typeof value === "number" ? value : value.toNumber();
};

export function gbp(value: Numeric, options: { decimals?: number } = {}): string {
  const numeric = toNumber(value);
  if (numeric === null) return UNAVAILABLE;
  const decimals = options.decimals ?? (Math.abs(numeric) >= 1000 ? 0 : 2);
  return numeric.toLocaleString("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Takes a ratio (0.42), renders a percentage (42.0%). */
export function percent(value: Numeric, decimals = 1): string {
  const numeric = toNumber(value);
  if (numeric === null) return UNAVAILABLE;
  return `${(numeric * 100).toFixed(decimals)}%`;
}

/** Multiples such as MER and ROAS, where "3.4x" reads more clearly than a percentage. */
export function multiple(value: Numeric, decimals = 2): string {
  const numeric = toNumber(value);
  if (numeric === null) return UNAVAILABLE;
  return `${numeric.toFixed(decimals)}x`;
}

export function count(value: number | null | undefined): string {
  if (value === null || value === undefined) return UNAVAILABLE;
  return value.toLocaleString("en-GB");
}

export function integerDays(value: Numeric): string {
  const numeric = toNumber(value);
  if (numeric === null) return UNAVAILABLE;
  return `${Math.floor(numeric)} days`;
}

/**
 * Renders a value the way its metric should be read.
 *
 * Kept beside the other formatters rather than in the report page, so the same metric is
 * formatted identically wherever it appears — a margin shown as a percentage on the dashboard
 * and as a raw ratio in a report would look like two different figures.
 */
export function formatByBasis(value: Numeric, basis: MetricBasis): string {
  switch (basis) {
    case "currency":
      return gbp(value);
    case "percentage":
      return percent(value);
    case "multiple":
      return multiple(value);
    case "days":
      return integerDays(value);
    case "count": {
      const numeric = toNumber(value);
      return numeric === null ? UNAVAILABLE : count(Math.round(numeric));
    }
  }
}

/** The same value unformatted, for a CSV a spreadsheet has to be able to read as a number. */
export function rawValue(value: Numeric): string {
  const numeric = toNumber(value);
  return numeric === null ? "" : String(numeric);
}

export interface Change {
  /** Proportional change against the comparison period, or null when it cannot be computed. */
  ratio: number | null;
  label: string;
  direction: "up" | "down" | "flat" | "unknown";
}

/**
 * Period-on-period change.
 *
 * A move from zero is reported as "new" rather than as an infinite percentage increase, and a
 * move to zero from zero is flat, not a 100% fall.
 */
export function changeAgainst(current: Numeric, previous: Numeric): Change {
  const now = toNumber(current);
  const before = toNumber(previous);

  if (now === null || before === null) return { ratio: null, label: UNAVAILABLE, direction: "unknown" };
  if (before === 0) {
    if (now === 0) return { ratio: 0, label: "no change", direction: "flat" };
    return { ratio: null, label: "new", direction: now > 0 ? "up" : "down" };
  }

  const ratio = (now - before) / Math.abs(before);
  if (Math.abs(ratio) < 0.0005) return { ratio, label: "no change", direction: "flat" };

  return {
    ratio,
    label: `${ratio > 0 ? "+" : ""}${(ratio * 100).toFixed(1)}%`,
    direction: ratio > 0 ? "up" : "down",
  };
}

export function formatDateRange(from: string, to: string): string {
  if (from === to) return formatDate(from);
  return `${formatDate(from)} – ${formatDate(to)}`;
}

export function formatDate(businessDate: string): string {
  const [year, month, day] = businessDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "3 minutes ago" for freshness reporting, where an absolute timestamp reads as noise. */
export function relativeTime(instant: string | null, now: Date = new Date()): string {
  if (!instant) return "never";
  const elapsed = now.getTime() - new Date(instant).getTime();
  if (Number.isNaN(elapsed)) return UNAVAILABLE;

  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
