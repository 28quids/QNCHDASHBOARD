/**
 * Builds the runnable Meta syncs.
 *
 * Insights are fetched a whole window at a time rather than paged by cursor like Shopify,
 * because a daily insights response for one account is small and Meta's paging is over rows,
 * not over time. The window itself is the unit of work, so the job key is the window.
 *
 * **Recent days are deliberately re-imported.** Meta restates conversions for up to a week as
 * attribution settles, so a sync that only ever fetched yesterday would freeze the first,
 * lowest figure Meta reported. `incrementalWindow` reaches back over that period, and the
 * upsert makes re-importing converge rather than accumulate.
 */

import { buildJobKey, type SyncJob, type SyncPage } from "../sync-runner";
import { MetaClient } from "./client";
import { normaliseInsights, type NormalisedMetaInsight } from "./normalise";
import { AD_FIELDS, ADSET_FIELDS, CAMPAIGN_FIELDS, insightParams } from "./queries";
import type { MetaAd, MetaAdSet, MetaCampaign, MetaEntityLevel, MetaInsightRow } from "./types";
import type { createMetaRepository, EntityUpsert } from "@/lib/repositories/meta-repository";
import { addDays } from "@/lib/financial/dates";

/** Days of already-imported history re-fetched on an incremental run, to catch restatements. */
export const RESTATEMENT_WINDOW_DAYS = 7;

export function incrementalWindow(today: string, days = RESTATEMENT_WINDOW_DAYS): { since: string; until: string } {
  return { since: addDays(today, -days), until: today };
}

export interface MetaInsightsSyncOptions {
  client: MetaClient;
  repository: ReturnType<typeof createMetaRepository>;
  connectionId: string;
  /** The `act_<id>` account identifier. */
  accountExternalId: string;
  /** Row id of the account in `ad_accounts`. */
  adAccountId: string;
  since: string;
  until: string;
  /**
   * Account level feeds the P&L; the finer levels feed the marketing breakdown only. Summing
   * across levels would multiply spend, which is why the reporting layer reads account rows.
   */
  level: MetaEntityLevel | "account";
  jobDiscriminator: string;
  onPagePersisted?: (result: { rows: number; unresolvedEntities: number }) => void;
}

export function buildMetaInsightsSyncJob(options: MetaInsightsSyncOptions): SyncJob<NormalisedMetaInsight> {
  const resource = `insights:${options.level}`;

  return {
    provider: "meta",
    resourceName: resource,
    connectionId: options.connectionId,
    jobKey: buildJobKey("meta", resource, options.jobDiscriminator),

    async fetchPage(cursor: string | null): Promise<SyncPage<NormalisedMetaInsight>> {
      // The cursor is Meta's absolute `paging.next` URL, which already carries every
      // parameter. Reissuing them alongside it would be ignored at best and conflicting at worst.
      const page = cursor
        ? await options.client.get<MetaInsightRow>(cursor)
        : await options.client.get<MetaInsightRow>(
            `${options.accountExternalId}/insights`,
            insightParams({ since: options.since, until: options.until, level: options.level }),
          );

      return {
        records: normaliseInsights(page.data, options.level),
        nextCursor: page.paging?.next ?? null,
        // Insights carry no update timestamp, so the window end is the watermark. It is what
        // an incremental run reaches back from, not a claim that nothing changed before it.
        watermarkAt: `${options.until}T00:00:00.000Z`,
      };
    },

    async upsert(records: NormalisedMetaInsight[]): Promise<number> {
      const result = await options.repository.persistInsights(options.adAccountId, records);
      options.onPagePersisted?.(result);
      return result.rows;
    },
  };
}

export interface MetaHierarchySyncOptions {
  client: MetaClient;
  repository: ReturnType<typeof createMetaRepository>;
  connectionId: string;
  accountExternalId: string;
  adAccountId: string;
  jobDiscriminator: string;
}

/**
 * Syncs campaigns, ad sets and ads.
 *
 * Run before the entity-level insight syncs. An insight row whose entity is not in
 * `ad_entities` is written against the account with a null entity, so its spend still reaches
 * the P&L, but it cannot be attributed to a campaign in the breakdown.
 */
export function buildMetaHierarchySyncJob(options: MetaHierarchySyncOptions): SyncJob<EntityUpsert> {
  return {
    provider: "meta",
    resourceName: "entities",
    connectionId: options.connectionId,
    jobKey: buildJobKey("meta", "entities", options.jobDiscriminator),

    async fetchPage(): Promise<SyncPage<EntityUpsert>> {
      const [campaigns, adSets, ads] = await Promise.all([
        options.client.getAll<MetaCampaign>(`${options.accountExternalId}/campaigns`, {
          fields: CAMPAIGN_FIELDS,
          limit: "200",
        }),
        options.client.getAll<MetaAdSet>(`${options.accountExternalId}/adsets`, {
          fields: ADSET_FIELDS,
          limit: "200",
        }),
        options.client.getAll<MetaAd>(`${options.accountExternalId}/ads`, {
          fields: AD_FIELDS,
          limit: "200",
        }),
      ]);

      const records: EntityUpsert[] = [
        ...campaigns.map((campaign) => toEntity(campaign, "campaign", null)),
        ...adSets.map((adSet) => toEntity(adSet, "adset", adSet.campaign_id)),
        ...ads.map((ad) => toEntity(ad, "ad", ad.adset_id)),
      ];

      // getAll already followed paging to the end, so this is the only page.
      return { records, nextCursor: null };
    },

    async upsert(records: EntityUpsert[]): Promise<number> {
      // Parents before children, so a parent_external_id always refers to a row that exists.
      const ordered: MetaEntityLevel[] = ["campaign", "adset", "ad"];
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

function toEntity(
  node: MetaCampaign,
  level: MetaEntityLevel,
  parentExternalId: string | null,
): EntityUpsert {
  return {
    externalId: node.id,
    level,
    parentExternalId,
    name: node.name ?? null,
    // `effective_status` accounts for a parent being paused; `status` alone would show an ad
    // as active inside a stopped campaign.
    status: node.effective_status ?? node.status ?? null,
    sourceUpdatedAt: node.updated_time ?? null,
  };
}
