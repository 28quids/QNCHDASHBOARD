/**
 * Period series for custom reporting.
 *
 * A custom report asks for arbitrary metrics over arbitrary buckets, and the only safe way to
 * produce them is to run the same engine over each bucket rather than to aggregate the
 * dashboard's figures. Most metrics do not sum: a month's CAC is not the sum of its days' CACs,
 * a quarter's margin is not the sum of its months' margins, and MER is a ratio of two totals
 * rather than a total of ratios. Adding them up produces numbers that look right and are not.
 *
 * So each bucket gets its own `buildReport` over the same loaded facts, narrowed to that
 * bucket's dates, and the observation builder values every catalogued metric from it. That also
 * means a report and the dashboard can never disagree about what a metric means — they compute
 * it with the same code.
 */

import type Decimal from "decimal.js";
import { enumerateDates, monthKey, startOfWeek, type DateRange } from "@/lib/financial/dates";
import { buildObservations } from "./alerts";
import { buildReport } from "./report";
import type { ReportingFacts } from "./reporting-repository";

export type ReportGrain = "day" | "week" | "month" | "total";

export const REPORT_GRAINS: Record<ReportGrain, string> = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
  total: "Whole period",
};

export const isReportGrain = (value: string | undefined): value is ReportGrain =>
  value !== undefined && value in REPORT_GRAINS;

export interface SeriesPeriod {
  /** Sort key and identity: the ISO date the bucket starts, or the month for a monthly grain. */
  key: string;
  label: string;
  range: DateRange;
  /** One entry per requested metric, null where it could not be calculated for this bucket. */
  values: Map<string, Decimal | null>;
}

/**
 * Groups the dates of a range into buckets.
 *
 * Buckets are clipped to the range, so a report that starts mid-month reports that month from
 * the day it starts rather than silently including days before it. A partial bucket is
 * therefore genuinely partial, which is the honest answer — labelling it as a whole month would
 * make it look comparable with the full ones beside it.
 */
export function bucketRanges(range: DateRange, grain: ReportGrain): { key: string; label: string; range: DateRange }[] {
  if (grain === "total") {
    return [{ key: range.from, label: `${range.from} to ${range.to}`, range }];
  }

  const buckets = new Map<string, { from: string; to: string }>();

  for (const date of enumerateDates(range.from, range.to)) {
    const key = grain === "day" ? date : grain === "week" ? startOfWeek(date) : monthKey(date);
    const existing = buckets.get(key);
    if (existing) existing.to = date;
    else buckets.set(key, { from: date, to: date });
  }

  return [...buckets].map(([key, bounds]) => ({
    key,
    label: labelFor(key, bounds, grain),
    range: { from: bounds.from, to: bounds.to },
  }));
}

function labelFor(key: string, bounds: { from: string; to: string }, grain: ReportGrain): string {
  if (grain === "day") return key;
  if (grain === "month") {
    // A month clipped by the range is labelled by its dates, so a part-month is never shown as
    // if it were the whole one.
    const wholeMonth = bounds.from.endsWith("-01") && bounds.to.slice(0, 7) === key;
    return wholeMonth && isMonthEnd(bounds.to) ? key : `${bounds.from} to ${bounds.to}`;
  }
  return `w/c ${bounds.from}`;
}

function isMonthEnd(date: string): boolean {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(8, 10) === "01";
}

/**
 * Narrows loaded facts to one bucket.
 *
 * Orders and refunds are deliberately **not** filtered: the engine already emits rows only for
 * dates inside the range, and it needs orders from outside it to find the original cost basis
 * of a refund. Advertising spend and mapped expenses are filtered, because the marketing
 * calculation sums them without reference to the range and would otherwise report the whole
 * report's spend against a single bucket.
 */
export function narrowFacts(facts: ReportingFacts, range: DateRange): ReportingFacts {
  const inRange = (businessDate: string) => businessDate >= range.from && businessDate <= range.to;

  return {
    ...facts,
    range,
    adSpend: facts.adSpend.filter((spend) => inRange(spend.businessDate)),
    mappedExpenses: facts.mappedExpenses.filter((expense) => inRange(expense.businessDate)),
  };
}

export interface PeriodSeriesInput {
  facts: ReportingFacts;
  range: DateRange;
  grain: ReportGrain;
  /** Metric keys, from the shared catalogue. */
  metrics: readonly string[];
}

/**
 * Builds one row per bucket, each carrying the requested metrics.
 *
 * Cash and inventory are absent from a period series on purpose: both are positions at an
 * instant rather than activity over a window, so "cash in July" is not a figure the way "CM3 in
 * July" is. They are reported as null here and shown live on their own pages.
 */
export function buildPeriodSeries(input: PeriodSeriesInput): SeriesPeriod[] {
  return bucketRanges(input.range, input.grain).map((bucket) => {
    const report = buildReport(narrowFacts(input.facts, bucket.range));
    const observations = buildObservations({ report });

    return {
      key: bucket.key,
      label: bucket.label,
      range: bucket.range,
      values: new Map(input.metrics.map((metric) => [metric, observations.get(metric) ?? null])),
    };
  });
}
