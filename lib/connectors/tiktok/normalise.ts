import { money, ZERO } from "@/lib/financial/money";
import { NOT_APPLICABLE, type TikTokEntityLevel, type TikTokReportRow } from "./types";
import { idDimensionFor } from "./queries";

/**
 * Turns a report row into the columns `ad_daily_metrics` stores.
 *
 * Two TikTok behaviours are handled here and nowhere else:
 *
 *  - **`"-"` means the metric does not apply to this query**, typically because the ad groups
 *    underneath optimise for different goals. It becomes null, never zero: "not measured" and
 *    "measured as none" are different facts, and the nullable columns exist to keep them apart.
 *
 *  - **Field availability varies by account.** A metric TikTok did not return is absent from
 *    the object rather than null, so every read goes through a candidate list and falls back
 *    to null. That is what lets the connector survive an account whose pixel reports a
 *    different subset without a code change, and the whole row is kept in `raw_metrics` so
 *    anything not modelled here is still recoverable.
 */

/** Metric names read for each column, most specific first. */
const METRIC_PRIORITY = {
  purchases: ["complete_payment", "conversion"],
  purchaseValue: ["total_complete_payment_value", "complete_payment_value", "total_purchase_value"],
  addToCarts: ["total_add_to_cart", "add_to_cart", "onsite_add_to_cart"],
  checkouts: ["total_initiate_checkout", "initiate_checkout", "onsite_initiate_checkout"],
  landingPageViews: ["total_landing_page_view", "landing_page_view", "onsite_page_view"],
} as const;

export type MetricColumn = keyof typeof METRIC_PRIORITY;

/** True for a value TikTok returned but marked inapplicable, or did not return at all. */
const isAbsent = (value: string | undefined): boolean =>
  value === undefined || value === "" || value.trim() === NOT_APPLICABLE;

/** The first present metric in priority order, as a number. Null when none applies. */
export function readMetric(metrics: Record<string, string>, column: MetricColumn): number | null {
  for (const name of METRIC_PRIORITY[column]) {
    const value = metrics[name];
    if (isAbsent(value)) continue;

    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.round(parsed);
  }
  return null;
}

/** As `readMetric`, but kept in Decimal so a money value never passes through a float. */
export function readMoney(metrics: Record<string, string>, column: MetricColumn): string | null {
  for (const name of METRIC_PRIORITY[column]) {
    const value = metrics[name];
    if (isAbsent(value)) continue;

    const parsed = money(value);
    if (parsed.isFinite()) return parsed.toFixed(4);
  }
  return null;
}

const decimal = (value: string | undefined): string => {
  if (isAbsent(value)) return ZERO.toFixed(4);
  const parsed = money(value as string);
  return parsed.isFinite() ? parsed.toFixed(4) : ZERO.toFixed(4);
};

const integer = (value: string | undefined): number => {
  if (isAbsent(value)) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
};

const optionalInteger = (value: string | undefined): number | null => {
  if (isAbsent(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
};

export interface NormalisedTikTokReport {
  metricDate: string;
  /** Null for the advertiser-level row, which is the row the P&L reads. */
  entityExternalId: string | null;
  level: TikTokEntityLevel | "advertiser";
  spend: string;
  impressions: number;
  reach: number | null;
  clicks: number;
  landingPageViews: number | null;
  addToCarts: number | null;
  checkouts: number | null;
  purchases: number | null;
  purchaseValue: string | null;
  /** The untouched row, so a metric not modelled here is still recoverable. */
  raw: TikTokReportRow;
}

/**
 * Conversion value, taken directly when TikTok reports it and otherwise derived from ROAS.
 *
 * The derivation is exact rather than an estimate — ROAS is defined as value over spend, so
 * value is spend times ROAS — and it is worth doing because which of the two an account
 * reports varies. It is skipped when spend is zero, where the identity says nothing.
 */
function purchaseValue(metrics: Record<string, string>, spend: string): string | null {
  const reported = readMoney(metrics, "purchaseValue");
  if (reported !== null) return reported;

  const roas = metrics.complete_payment_roas;
  if (isAbsent(roas)) return null;

  const parsedRoas = money(roas);
  const parsedSpend = money(spend);
  if (!parsedRoas.isFinite() || parsedSpend.isZero()) return null;

  return parsedSpend.times(parsedRoas).toFixed(4);
}

/**
 * `stat_time_day` arrives as `YYYY-MM-DD HH:MM:SS` in the advertiser account's own timezone.
 * The date part is used as the business date directly, exactly as Meta's `date_start` is:
 * converting a value that was never a real instant would shift spend between days.
 */
export function normaliseReport(
  row: TikTokReportRow,
  level: TikTokEntityLevel | "advertiser",
): NormalisedTikTokReport {
  const metrics = row.metrics ?? {};
  const dimensions = row.dimensions ?? {};
  const spend = decimal(metrics.spend);

  return {
    metricDate: (dimensions.stat_time_day ?? "").slice(0, 10),
    entityExternalId: level === "advertiser" ? null : (dimensions[idDimensionFor(level)] ?? null),
    level,
    spend,
    impressions: integer(metrics.impressions),
    reach: optionalInteger(metrics.reach),
    clicks: integer(metrics.clicks),
    landingPageViews: readMetric(metrics, "landingPageViews"),
    addToCarts: readMetric(metrics, "addToCarts"),
    checkouts: readMetric(metrics, "checkouts"),
    purchases: readMetric(metrics, "purchases"),
    purchaseValue: purchaseValue(metrics, spend),
    raw: row,
  };
}

/**
 * Normalises a page, discarding rows with no usable date.
 *
 * A row without `stat_time_day` cannot be attributed to a business day, and writing it with an
 * empty date would either fail the insert or land on an arbitrary one. Dropping it keeps the
 * rest of the page importable; the count is reported by the sync.
 */
export function normaliseReports(
  rows: readonly TikTokReportRow[],
  level: TikTokEntityLevel | "advertiser",
): NormalisedTikTokReport[] {
  return rows
    .map((row) => normaliseReport(row, level))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.metricDate));
}

/** Total spend across rows, for reporting what a sync actually imported. */
export function totalSpend(rows: readonly NormalisedTikTokReport[]): string {
  return rows.reduce((total, row) => total.plus(row.spend), ZERO).toFixed(2);
}
