import { money, ZERO } from "@/lib/financial/money";
import type { MetaActionEntry, MetaEntityLevel, MetaInsightRow } from "./types";

/**
 * Turns an insights row into the columns `ad_daily_metrics` stores.
 *
 * Conversion counts have no fields of their own. They arrive inside `actions`, keyed by an
 * action type, with monetary equivalents in `action_values`. Which key to read is a real
 * decision, not a lookup:
 *
 *  - `purchase` counts a conversion attributed to the pixel *and* any offline or app event.
 *  - `omni_purchase` is Meta's deduplicated cross-channel figure.
 *  - `offsite_conversion.fb_pixel_purchase` counts only the website pixel.
 *
 * For a Shopify store selling through one website, the pixel figure is the one comparable
 * with QNCH orders, so it is preferred and the broader keys are fallbacks. All three are
 * kept in `raw_metrics` so the choice can be revisited without re-importing.
 *
 * None of this reaches contribution maths. These are the platform's attribution claims,
 * reported beside QNCH figures and never inside them.
 */

/** Action types read for each column, most specific first. */
const ACTION_PRIORITY = {
  purchases: ["offsite_conversion.fb_pixel_purchase", "purchase", "omni_purchase"],
  addToCarts: ["offsite_conversion.fb_pixel_add_to_cart", "add_to_cart", "omni_add_to_cart"],
  checkouts: [
    "offsite_conversion.fb_pixel_initiate_checkout",
    "initiate_checkout",
    "omni_initiated_checkout",
  ],
  landingPageViews: ["landing_page_view"],
} as const;

export type ActionColumn = keyof typeof ACTION_PRIORITY;

/**
 * The first action type present, in priority order. Returns null rather than zero when none
 * is present: a campaign that reported no purchases at all is different from one Meta did
 * not measure, and `ad_daily_metrics` stores those columns nullable for exactly that reason.
 */
export function readAction(entries: readonly MetaActionEntry[] | undefined, column: ActionColumn): number | null {
  if (!entries || entries.length === 0) return null;

  for (const actionType of ACTION_PRIORITY[column]) {
    const match = entries.find((entry) => entry.action_type === actionType);
    if (match) {
      const parsed = Number(match.value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export function readActionValue(
  entries: readonly MetaActionEntry[] | undefined,
  column: ActionColumn,
): string | null {
  if (!entries || entries.length === 0) return null;

  for (const actionType of ACTION_PRIORITY[column]) {
    const match = entries.find((entry) => entry.action_type === actionType);
    if (match) {
      const parsed = money(match.value ?? 0);
      if (parsed.isFinite()) return parsed.toFixed(4);
    }
  }
  return null;
}

const integer = (value: string | undefined): number => {
  if (value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
};

const optionalInteger = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
};

export interface NormalisedMetaInsight {
  metricDate: string;
  /** Null for the account-level row, which is the row the P&L reads. */
  entityExternalId: string | null;
  level: MetaEntityLevel | "account";
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
  raw: MetaInsightRow;
}

/**
 * `date_start` is already a date in the ad account's own timezone, so it is used as the
 * business date directly. Converting it would shift spend between days against a timestamp
 * that was never a timestamp.
 */
export function normaliseInsight(row: MetaInsightRow, level: MetaEntityLevel | "account"): NormalisedMetaInsight {
  const entityExternalId =
    level === "ad" ? (row.ad_id ?? null)
    : level === "adset" ? (row.adset_id ?? null)
    : level === "campaign" ? (row.campaign_id ?? null)
    : null;

  return {
    metricDate: row.date_start,
    entityExternalId,
    level,
    spend: money(row.spend ?? 0).toFixed(4),
    impressions: integer(row.impressions),
    reach: optionalInteger(row.reach),
    // Meta's `clicks` counts every click; `inline_link_clicks` counts clicks to the site.
    // The site figure is the one comparable with sessions, so it is preferred where present.
    clicks: integer(row.inline_link_clicks ?? row.clicks),
    landingPageViews: readAction(row.actions, "landingPageViews"),
    addToCarts: readAction(row.actions, "addToCarts"),
    checkouts: readAction(row.actions, "checkouts"),
    purchases: readAction(row.actions, "purchases"),
    purchaseValue: readActionValue(row.action_values, "purchases"),
    raw: row,
  };
}

export function normaliseInsights(
  rows: readonly MetaInsightRow[],
  level: MetaEntityLevel | "account",
): NormalisedMetaInsight[] {
  return rows.map((row) => normaliseInsight(row, level));
}

/**
 * Total spend across rows, for reporting what a sync actually imported.
 * Kept in Decimal so a reconciliation figure never accumulates float error.
 */
export function totalSpend(rows: readonly NormalisedMetaInsight[]): string {
  return rows.reduce((total, row) => total.plus(row.spend), ZERO).toFixed(2);
}
