/**
 * Shapes returned by the TikTok Ads (Business) API, v1.3.
 *
 * Three things differ from Meta and drive the rest of this connector:
 *
 *  - **Every response is wrapped in an envelope** carrying its own `code`. A failure is
 *    reported with `code != 0` and HTTP 200, so the status line cannot be trusted alone.
 *  - **Paging is by page number**, not by cursor, and the totals arrive in `page_info`.
 *  - **A metric that is meaningless under the query is returned as the string `"-"`**, not as
 *    zero and not as null. Reading that as a number yields NaN, and coercing it to zero would
 *    report "TikTok measured nothing" as "TikTok measured none", which are different claims.
 */

/** Pinned rather than floating, for the same reason as the Graph API version. */
export const TIKTOK_API_VERSION = "v1.3";
export const TIKTOK_BASE_URL = "https://business-api.tiktok.com/open_api";

/** The value TikTok substitutes for a metric that does not apply to the query. */
export const NOT_APPLICABLE = "-";

export interface TikTokPageInfo {
  page: number;
  page_size: number;
  total_number: number;
  total_page: number;
}

export interface TikTokEnvelope<T> {
  /** Zero is success. Everything else is an error, whatever the HTTP status said. */
  code: number;
  message: string;
  request_id?: string;
  data?: T;
}

export interface TikTokList<T> {
  list: T[];
  page_info?: TikTokPageInfo;
}

export interface TikTokAdvertiser {
  advertiser_id: string;
  advertiser_name?: string;
  name?: string;
  currency?: string;
  timezone?: string;
  display_timezone?: string;
  status?: string;
}

/**
 * TikTok calls the middle tier an ad group where Meta calls it an ad set. The database stores
 * TikTok's own word — `ad_entities.level` accepts both — so a row is not silently relabelled
 * into another platform's vocabulary.
 */
export type TikTokEntityLevel = "campaign" | "adgroup" | "ad";

export interface TikTokCampaign {
  campaign_id: string;
  campaign_name?: string;
  operation_status?: string;
  secondary_status?: string;
  modify_time?: string;
}

export interface TikTokAdGroup {
  adgroup_id: string;
  adgroup_name?: string;
  campaign_id: string;
  operation_status?: string;
  secondary_status?: string;
  modify_time?: string;
}

export interface TikTokAd {
  ad_id: string;
  ad_name?: string;
  adgroup_id: string;
  campaign_id: string;
  operation_status?: string;
  secondary_status?: string;
  modify_time?: string;
}

/** `data_level` values for auction (non-reservation) buying, which is what QNCH runs. */
export type TikTokDataLevel =
  | "AUCTION_ADVERTISER"
  | "AUCTION_CAMPAIGN"
  | "AUCTION_ADGROUP"
  | "AUCTION_AD";

/**
 * One row of an integrated report.
 *
 * Dimensions and metrics arrive in separate objects rather than flattened, and every metric
 * value is a string — or `"-"`. Both are kept verbatim here and interpreted in `normalise`.
 */
export interface TikTokReportRow {
  dimensions: Record<string, string>;
  metrics: Record<string, string>;
}
