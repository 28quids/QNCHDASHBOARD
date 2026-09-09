/**
 * Reading a report specification out of the URL.
 *
 * The report is entirely described by its query string, which is what makes a report shareable
 * as a link and bookmarkable, and lets the CSV route render exactly what the page shows by
 * parsing the same parameters rather than by reimplementing them.
 */

import type { DateRange } from "@/lib/financial/dates";
import { isKnownMetric, METRIC_CATALOGUE } from "@/lib/monitoring/metric-catalogue";
import { isReportGrain, type ReportGrain } from "@/lib/reporting/series";
import {
  isTimeframeKey,
  resolveCustomRange,
  resolveTimeframe,
  type ResolvedTimeframe,
  type TimeframeKey,
} from "@/lib/reporting/timeframes";

export type ReportSearchParams = Record<string, string | string[] | undefined>;

/** The metrics a report opens with when none was chosen, kept short enough to read at a glance. */
const DEFAULT_METRICS = ["net_revenue", "cm3_margin", "blended_cac", "mer"];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ReportSpecification {
  metrics: string[];
  grain: ReportGrain;
  timeframe: ResolvedTimeframe;
  /** Metric keys that were asked for and are not in the catalogue, so they can be reported. */
  rejectedMetrics: string[];
  /** True when the window came from explicit dates rather than a named timeframe. */
  isCustomRange: boolean;
  savedReportId: string | null;
}

const asArray = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * Parses the query string into a report.
 *
 * Anything unrecognised is dropped and reported rather than silently coerced. A mistyped metric
 * that quietly disappears leaves a report that looks complete and is missing a column.
 */
export function parseReport(params: ReportSearchParams, today: string): ReportSpecification {
  const requested = asArray(params.metric);
  const known = requested.filter(isKnownMetric);
  const rejectedMetrics = requested.filter((metric) => !isKnownMetric(metric));

  const grainParam = single(params.grain);
  const grain: ReportGrain = isReportGrain(grainParam) ? grainParam : "month";

  const from = single(params.from);
  const to = single(params.to);
  const hasCustomRange = ISO_DATE.test(from ?? "") && ISO_DATE.test(to ?? "") && (from as string) <= (to as string);

  const timeframeParam = single(params.timeframe);
  const timeframeKey: TimeframeKey = isTimeframeKey(timeframeParam) ? timeframeParam : "30d";

  return {
    // Deduplicated, and ordered as the catalogue orders them so two reports asking for the same
    // metrics always render their columns in the same order.
    metrics: orderByCatalogue(known.length > 0 ? [...new Set(known)] : DEFAULT_METRICS),
    grain,
    timeframe: hasCustomRange
      ? resolveCustomRange({ from: from as string, to: to as string } satisfies DateRange)
      : resolveTimeframe(timeframeKey, today),
    rejectedMetrics,
    isCustomRange: hasCustomRange,
    savedReportId: single(params.saved) ?? null,
  };
}

function orderByCatalogue(metrics: readonly string[]): string[] {
  const order = new Map(METRIC_CATALOGUE.map((metric, index) => [metric.key, index]));
  return [...metrics].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/** Rebuilds the query string for a report, so a saved one can be opened as a link. */
export function reportQuery(specification: {
  metrics: readonly string[];
  grain: ReportGrain;
  timeframeKey?: string | null;
  range?: DateRange | null;
  savedReportId?: string | null;
}): string {
  const params = new URLSearchParams();
  for (const metric of specification.metrics) params.append("metric", metric);
  params.set("grain", specification.grain);

  if (specification.range) {
    params.set("from", specification.range.from);
    params.set("to", specification.range.to);
  } else if (specification.timeframeKey) {
    params.set("timeframe", specification.timeframeKey);
  }
  if (specification.savedReportId) params.set("saved", specification.savedReportId);

  return params.toString();
}
