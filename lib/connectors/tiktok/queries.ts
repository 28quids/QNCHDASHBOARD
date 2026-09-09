/**
 * Field sets and request parameters for the TikTok reporting API.
 *
 * Held in one place, as with Meta, so the exact request is reviewable rather than scattered.
 *
 * The metric list is split into two tiers, and that split is deliberate. TikTok rejects the
 * whole request with a single invalid-parameter error if any requested metric does not exist
 * for the account, and which conversion metrics exist depends on the advertiser's optimisation
 * goal and pixel setup. Requesting the union of everything useful would therefore fail
 * outright on some accounts and succeed on others.
 *
 *  - `CORE_METRICS` are the delivery figures every auction account reports. If these are
 *    refused, something is genuinely wrong and the sync should fail loudly.
 *  - `CONVERSION_METRICS` are the ecommerce figures. They are requested, and dropped on a
 *    rejection so that spend still imports — see `reportWithFallback`. What was dropped is
 *    reported rather than swallowed.
 *
 * None of these figures reach contribution maths. They are the platform's own attribution
 * claims, shown beside QNCH's figures and never inside them.
 */

import type { TikTokDataLevel, TikTokEntityLevel } from "./types";

export const CAMPAIGN_FIELDS = [
  "campaign_id",
  "campaign_name",
  "operation_status",
  "secondary_status",
  "modify_time",
];

export const ADGROUP_FIELDS = [...CAMPAIGN_FIELDS, "adgroup_id", "adgroup_name"];
export const AD_FIELDS = [...ADGROUP_FIELDS, "ad_id", "ad_name"];

export const CORE_METRICS = [
  "spend",
  "impressions",
  "reach",
  "frequency",
  "clicks",
  "ctr",
  "cpc",
  "cpm",
] as const;

export const CONVERSION_METRICS = [
  "conversion",
  "cost_per_conversion",
  "conversion_rate",
  "complete_payment",
  "complete_payment_roas",
  "total_complete_payment_rate",
  "value_per_complete_payment",
] as const;

export const ALL_METRICS: readonly string[] = [...CORE_METRICS, ...CONVERSION_METRICS];

/**
 * The attribution basis recorded alongside every row.
 *
 * TikTok applies the attribution window configured on the advertiser account rather than one
 * chosen per request, so unlike Meta there is no window to state. The key records that fact
 * explicitly: a stored figure whose basis is unknown cannot be compared with a later one, and
 * it must not collide with Meta's key in `ad_daily_metrics`.
 */
export const ATTRIBUTION_KEY = "tiktok_account_default";

/** Auction buying. Reservation campaigns would need their own data levels and are not in use. */
export const SERVICE_TYPE = "AUCTION";

const DATA_LEVEL: Record<TikTokEntityLevel | "advertiser", TikTokDataLevel> = {
  advertiser: "AUCTION_ADVERTISER",
  campaign: "AUCTION_CAMPAIGN",
  adgroup: "AUCTION_ADGROUP",
  ad: "AUCTION_AD",
};

/** The identifier dimension each level is grouped by, alongside the day. */
const ID_DIMENSION: Record<TikTokEntityLevel | "advertiser", string> = {
  advertiser: "advertiser_id",
  campaign: "campaign_id",
  adgroup: "adgroup_id",
  ad: "ad_id",
};

export const dataLevelFor = (level: TikTokEntityLevel | "advertiser"): TikTokDataLevel =>
  DATA_LEVEL[level];

export const idDimensionFor = (level: TikTokEntityLevel | "advertiser"): string =>
  ID_DIMENSION[level];

export interface ReportRequestOptions {
  advertiserId: string;
  since: string;
  until: string;
  level: TikTokEntityLevel | "advertiser";
  metrics?: readonly string[];
  page?: number;
  pageSize?: number;
}

/**
 * Parameters for a daily report request.
 *
 * `stat_time_day` in the dimensions is what makes the response one row per day. Without it
 * TikTok returns a single aggregate for the whole range, which cannot be attributed to a
 * business date — the same trap as omitting Meta's `time_increment`.
 */
export function reportParams(options: ReportRequestOptions): Record<string, string | string[] | number> {
  return {
    advertiser_id: options.advertiserId,
    report_type: "BASIC",
    service_type: SERVICE_TYPE,
    data_level: dataLevelFor(options.level),
    dimensions: [idDimensionFor(options.level), "stat_time_day"],
    metrics: [...(options.metrics ?? ALL_METRICS)],
    start_date: options.since,
    end_date: options.until,
    page: options.page ?? 1,
    page_size: options.pageSize ?? 200,
  };
}
