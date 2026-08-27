/**
 * Shapes returned by the Meta Marketing API.
 *
 * Every numeric field arrives as a string, including spend and impressions. They are kept as
 * strings here and converted with Decimal at the point of use, so a currency amount never
 * passes through a JavaScript float.
 */

/** Pinned rather than floating. A new version can change field semantics without warning. */
export const GRAPH_API_VERSION = "v26.0";

export interface MetaPaging {
  cursors?: { before?: string; after?: string };
  /** Absent on the final page. Its presence, not the cursor's, is what ends paging. */
  next?: string;
}

export interface MetaListResponse<T> {
  data: T[];
  paging?: MetaPaging;
}

export interface MetaErrorBody {
  error?: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

export interface MetaAdAccount {
  id: string;
  account_id: string;
  name: string;
  currency: string;
  timezone_name: string;
  account_status: number;
}

export type MetaEntityLevel = "campaign" | "adset" | "ad";

export interface MetaCampaign {
  id: string;
  name: string;
  status: string;
  effective_status?: string;
  updated_time?: string;
}

export interface MetaAdSet extends MetaCampaign {
  campaign_id: string;
}

export interface MetaAd extends MetaCampaign {
  adset_id: string;
  campaign_id: string;
}

/**
 * One row of the insights response.
 *
 * Conversion counts do not have their own fields; they arrive inside `actions`, keyed by an
 * action type, with the monetary equivalents in `action_values`.
 */
export interface MetaActionEntry {
  action_type: string;
  value: string;
}

export interface MetaInsightRow {
  date_start: string;
  date_stop: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  inline_link_clicks?: string;
  cpm?: string;
  cpc?: string;
  ctr?: string;
  frequency?: string;
  actions?: MetaActionEntry[];
  action_values?: MetaActionEntry[];
  /** Present only when the request asked for a level below the account. */
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
}
