/**
 * Field sets and request parameters for the Marketing API.
 *
 * Held here rather than inline so that the exact set of fields requested is reviewable in one
 * place. A field removed in a future API version fails loudly at this boundary rather than
 * quietly producing nulls somewhere downstream.
 */

import type { MetaEntityLevel } from "./types";

export const ACCOUNT_FIELDS = ["id", "account_id", "name", "currency", "timezone_name", "account_status"].join(",");

export const CAMPAIGN_FIELDS = ["id", "name", "status", "effective_status", "updated_time"].join(",");
export const ADSET_FIELDS = [...CAMPAIGN_FIELDS.split(","), "campaign_id"].join(",");
export const AD_FIELDS = [...CAMPAIGN_FIELDS.split(","), "adset_id", "campaign_id"].join(",");

const INSIGHT_FIELDS = [
  "spend",
  "impressions",
  "reach",
  "frequency",
  "clicks",
  "inline_link_clicks",
  "cpm",
  "cpc",
  "ctr",
  "actions",
  "action_values",
];

/**
 * The attribution setting requested, recorded alongside every row.
 *
 * Meta's default changed over time, so it is stated explicitly: a stored figure whose
 * attribution window is unknown cannot be compared with a later one. This value is written
 * into `ad_daily_metrics.attribution_window`, so changing it here produces new rows rather
 * than overwriting figures measured on the old basis.
 */
export const ATTRIBUTION_WINDOWS = ["7d_click", "1d_view"] as const;
export const ATTRIBUTION_KEY = ATTRIBUTION_WINDOWS.join(",");

const LEVEL_FIELDS: Record<MetaEntityLevel, string[]> = {
  campaign: ["campaign_id"],
  adset: ["adset_id", "campaign_id"],
  ad: ["ad_id", "adset_id", "campaign_id"],
};

export interface InsightRequestOptions {
  since: string;
  until: string;
  level: MetaEntityLevel | "account";
  limit?: number;
}

/**
 * Parameters for a daily insights request.
 *
 * `time_increment=1` is what makes the response one row per day. Without it Meta returns a
 * single aggregated row for the whole range, which cannot be attributed to a business date
 * and would silently collapse a backfill into one figure.
 */
export function insightParams(options: InsightRequestOptions): Record<string, string> {
  const fields =
    options.level === "account"
      ? INSIGHT_FIELDS
      : [...INSIGHT_FIELDS, ...LEVEL_FIELDS[options.level]];

  return {
    level: options.level,
    time_increment: "1",
    time_range: JSON.stringify({ since: options.since, until: options.until }),
    action_attribution_windows: JSON.stringify(ATTRIBUTION_WINDOWS),
    fields: fields.join(","),
    limit: String(options.limit ?? 500),
  };
}
