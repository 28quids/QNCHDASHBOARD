/**
 * Builds the runnable TikTok syncs.
 *
 * The shape mirrors Meta: a hierarchy job, then one report job per level, with the
 * advertiser-level rows being what the P&L reads and the finer levels feeding the marketing
 * breakdown only. Two differences are TikTok's own.
 *
 * **Paging is by page number.** `runSync`'s cursor is opaque to it, so the page number is
 * carried through it as a string. The report states `total_page`, so the last page is known
 * rather than inferred from an empty result.
 *
 * **A metric TikTok does not recognise fails the whole request.** Which conversion metrics an
 * account reports depends on its optimisation goal and pixel, so the request degrades once to
 * the core delivery metrics rather than importing nothing. What was dropped is reported, not
 * swallowed: spend that arrived without conversions is a materially different import.
 */

import { buildJobKey, type SyncJob, type SyncPage } from "../sync-runner";
import { TikTokApiError, type TikTokClient } from "./client";
import { normaliseReports, type NormalisedTikTokReport } from "./normalise";
import {
  ADGROUP_FIELDS,
  AD_FIELDS,
  ALL_METRICS,
  CAMPAIGN_FIELDS,
  CORE_METRICS,
  reportParams,
} from "./queries";
import type {
  TikTokAd,
  TikTokAdGroup,
  TikTokCampaign,
  TikTokEntityLevel,
  TikTokList,
  TikTokReportRow,
} from "./types";
import type { createTikTokRepository, TikTokEntityUpsert } from "@/lib/repositories/tiktok-repository";
import { addDays } from "@/lib/financial/dates";

/**
 * Days of already-imported history re-fetched on an incremental run.
 *
 * TikTok's own documentation puts reporting latency at around eleven hours and conversions
 * continue to settle after that, so a sync that only ever fetched yesterday would freeze the
 * first and lowest figure reported. The upsert makes re-importing converge.
 */
export const RESTATEMENT_WINDOW_DAYS = 7;

export function incrementalWindow(today: string, days = RESTATEMENT_WINDOW_DAYS): { since: string; until: string } {
  return { since: addDays(today, -days), until: today };
}

export interface ReportPage {
  rows: TikTokReportRow[];
  totalPages: number;
  /** Metrics TikTok refused, which this request therefore went without. */
  droppedMetrics: readonly string[];
}

/**
 * Requests one page of a report, degrading to the core metrics if TikTok refuses the full set.
 *
 * The retry happens once and only for an invalid-parameter error. An auth failure or a
 * transient fault is re-thrown, because dropping metrics would not fix either and would turn
 * a clear failure into a quietly diminished import.
 */
export async function reportWithFallback(
  client: TikTokClient,
  options: {
    advertiserId: string;
    since: string;
    until: string;
    level: TikTokEntityLevel | "advertiser";
    page: number;
    pageSize?: number;
  },
): Promise<ReportPage> {
  const request = async (metrics: readonly string[]): Promise<TikTokList<TikTokReportRow>> =>
    client.get<TikTokList<TikTokReportRow>>("report/integrated/get/", reportParams({ ...options, metrics }));

  try {
    const data = await request(ALL_METRICS);
    return { rows: data.list ?? [], totalPages: data.page_info?.total_page ?? 1, droppedMetrics: [] };
  } catch (error) {
    if (!(error instanceof TikTokApiError) || !error.isInvalidParameter) throw error;

    const data = await request(CORE_METRICS);
    return {
      rows: data.list ?? [],
      totalPages: data.page_info?.total_page ?? 1,
      droppedMetrics: ALL_METRICS.filter((metric) => !CORE_METRICS.includes(metric as never)),
    };
  }
}

export interface TikTokReportSyncOptions {
  client: TikTokClient;
  repository: ReturnType<typeof createTikTokRepository>;
  connectionId: string;
  /** The numeric advertiser identifier. */
  advertiserId: string;
  /** Row id of the account in `ad_accounts`. */
  adAccountId: string;
  since: string;
  until: string;
  /**
   * Advertiser level feeds the P&L; the finer levels feed the marketing breakdown only.
   * Summing across levels would multiply spend, which is why the reporting layer reads the
   * advertiser rows.
   */
  level: TikTokEntityLevel | "advertiser";
  jobDiscriminator: string;
  pageSize?: number;
  onPagePersisted?: (result: {
    rows: number;
    skippedUnresolvedEntities: number;
    droppedMetrics: readonly string[];
  }) => void;
}

export function buildTikTokReportSyncJob(
  options: TikTokReportSyncOptions,
): SyncJob<NormalisedTikTokReport> {
  const resource = `report:${options.level}`;
  let droppedMetrics: readonly string[] = [];

  return {
    provider: "tiktok",
    resourceName: resource,
    connectionId: options.connectionId,
    jobKey: buildJobKey("tiktok", resource, options.jobDiscriminator),

    async fetchPage(cursor: string | null): Promise<SyncPage<NormalisedTikTokReport>> {
      // A stored cursor from an interrupted run is a page number. It is validated rather than
      // trusted: a malformed value would otherwise request page NaN and read nothing.
      const parsed = cursor === null ? 1 : Number(cursor);
      const page = Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;

      const result = await reportWithFallback(options.client, {
        advertiserId: options.advertiserId,
        since: options.since,
        until: options.until,
        level: options.level,
        page,
        pageSize: options.pageSize,
      });
      droppedMetrics = result.droppedMetrics;

      return {
        records: normaliseReports(result.rows, options.level),
        nextCursor: page < result.totalPages ? String(page + 1) : null,
        // Reports carry no update timestamp, so the window end is the watermark. It is what an
        // incremental run reaches back from, not a claim that nothing changed before it.
        watermarkAt: `${options.until}T00:00:00.000Z`,
      };
    },

    async upsert(records: NormalisedTikTokReport[]): Promise<number> {
      const result = await options.repository.persistReports(options.adAccountId, records);
      options.onPagePersisted?.({ ...result, droppedMetrics });
      return result.rows;
    },
  };
}

export interface TikTokHierarchySyncOptions {
  client: TikTokClient;
  repository: ReturnType<typeof createTikTokRepository>;
  connectionId: string;
  advertiserId: string;
  adAccountId: string;
  jobDiscriminator: string;
}

/**
 * Syncs campaigns, ad groups and ads.
 *
 * Run before the entity-level report syncs. A report row whose entity is not in `ad_entities`
 * is skipped, so the breakdown loses that row until the hierarchy catches up. Its spend is not
 * lost — the advertiser-level row for that day already contains it.
 */
export function buildTikTokHierarchySyncJob(
  options: TikTokHierarchySyncOptions,
): SyncJob<TikTokEntityUpsert> {
  return {
    provider: "tiktok",
    resourceName: "entities",
    connectionId: options.connectionId,
    jobKey: buildJobKey("tiktok", "entities", options.jobDiscriminator),

    async fetchPage(): Promise<SyncPage<TikTokEntityUpsert>> {
      const advertiser = { advertiser_id: options.advertiserId };

      const [campaigns, adGroups, ads] = await Promise.all([
        options.client.getAll<TikTokCampaign>("campaign/get/", { ...advertiser, fields: CAMPAIGN_FIELDS }),
        options.client.getAll<TikTokAdGroup>("adgroup/get/", { ...advertiser, fields: ADGROUP_FIELDS }),
        options.client.getAll<TikTokAd>("ad/get/", { ...advertiser, fields: AD_FIELDS }),
      ]);

      const records: TikTokEntityUpsert[] = [
        ...campaigns.map((campaign) => ({
          externalId: campaign.campaign_id,
          level: "campaign" as const,
          parentExternalId: null,
          name: campaign.campaign_name ?? null,
          status: statusOf(campaign),
          sourceUpdatedAt: campaign.modify_time ?? null,
        })),
        ...adGroups.map((adGroup) => ({
          externalId: adGroup.adgroup_id,
          level: "adgroup" as const,
          parentExternalId: adGroup.campaign_id,
          name: adGroup.adgroup_name ?? null,
          status: statusOf(adGroup),
          sourceUpdatedAt: adGroup.modify_time ?? null,
        })),
        ...ads.map((ad) => ({
          externalId: ad.ad_id,
          level: "ad" as const,
          parentExternalId: ad.adgroup_id,
          name: ad.ad_name ?? null,
          status: statusOf(ad),
          sourceUpdatedAt: ad.modify_time ?? null,
        })),
      ];

      // getAll already paged to the end, so this is the only page.
      return { records, nextCursor: null };
    },

    async upsert(records: TikTokEntityUpsert[]): Promise<number> {
      // Parents before children, so a parent_external_id always refers to a row that exists.
      const ordered: TikTokEntityLevel[] = ["campaign", "adgroup", "ad"];
      let written = 0;
      for (const level of ordered) {
        written += await options.repository.persistEntities(
          options.adAccountId,
          records.filter((record) => record.level === level),
        );
      }
      return written;
    },
  };
}

/**
 * `secondary_status` accounts for a parent being paused or the ad being in review;
 * `operation_status` alone reports an ad as enabled inside a stopped campaign.
 */
function statusOf(node: { operation_status?: string; secondary_status?: string }): string | null {
  return node.secondary_status ?? node.operation_status ?? null;
}
