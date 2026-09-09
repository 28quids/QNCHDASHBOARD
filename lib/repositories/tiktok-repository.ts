/**
 * Persists TikTok advertising data.
 *
 * The same load-bearing constraint applies as for Meta, and it is set by the reporting layer
 * rather than by the platform: `loadAdSpend` reads only rows whose `entity_id` is null,
 * because campaign, ad group and ad rows repeat the same spend at finer grain. Summing every
 * level would multiply advertising spend by the depth of the hierarchy, so the
 * advertiser-level row is what the P&L consumes and the entity rows exist purely for the
 * marketing breakdown.
 *
 * Rows carry TikTok's own attribution key, so a day can hold a Meta row and a TikTok row for
 * the same account without them colliding in the natural key.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { ATTRIBUTION_KEY } from "@/lib/connectors/tiktok/queries";
import type { NormalisedTikTokReport } from "@/lib/connectors/tiktok/normalise";
import type { TikTokAdvertiser, TikTokEntityLevel } from "@/lib/connectors/tiktok/types";

export interface TikTokRepositoryContext {
  organisationId: string;
}

export interface PersistReportsResult {
  rows: number;
  /**
   * Entity-level rows whose campaign, ad group or ad is not in `ad_entities` yet.
   *
   * These are **skipped**, not written. A null `entity_id` means "advertiser level", and the
   * advertiser row for that day already contains their spend — so writing them there would
   * count it twice. Their absence costs only breakdown detail; their presence corrupts the
   * total, which is the failure migration 0007 was written to repair for Meta.
   */
  skippedUnresolvedEntities: number;
}

export interface TikTokEntityUpsert {
  externalId: string;
  level: TikTokEntityLevel;
  parentExternalId: string | null;
  name: string | null;
  status: string | null;
  sourceUpdatedAt: string | null;
}

/** TikTok reports a timezone name on the advertiser; the field it uses has varied by version. */
const timezoneOf = (advertiser: TikTokAdvertiser): string | null =>
  advertiser.display_timezone ?? advertiser.timezone ?? null;

const nameOf = (advertiser: TikTokAdvertiser): string | null =>
  advertiser.advertiser_name ?? advertiser.name ?? null;

export function createTikTokRepository(client: SupabaseClient, context: TikTokRepositoryContext) {
  const { organisationId } = context;

  return {
    /** Upserts the ad account and returns its row id, which everything else hangs off. */
    async upsertAccount(advertiser: TikTokAdvertiser): Promise<string> {
      const { data, error } = await client
        .from("ad_accounts")
        .upsert(
          {
            organisation_id: organisationId,
            platform: "tiktok",
            external_id: advertiser.advertiser_id,
            name: nameOf(advertiser),
            currency: advertiser.currency ?? null,
            timezone: timezoneOf(advertiser),
          },
          { onConflict: "organisation_id,platform,external_id" },
        )
        .select("id")
        .single();

      if (error) throw error;
      return data.id as string;
    },

    async persistEntities(adAccountId: string, entities: readonly TikTokEntityUpsert[]): Promise<number> {
      if (entities.length === 0) return 0;

      const { error } = await client.from("ad_entities").upsert(
        entities.map((entity) => ({
          ad_account_id: adAccountId,
          external_id: entity.externalId,
          level: entity.level,
          parent_external_id: entity.parentExternalId,
          name: entity.name,
          status: entity.status,
          source_updated_at: entity.sourceUpdatedAt,
        })),
        { onConflict: "ad_account_id,external_id" },
      );
      if (error) throw error;
      return entities.length;
    },

    /**
     * Writes one batch of daily metrics.
     *
     * `breakdown_key` stays empty because no breakdown is requested. It exists in the unique
     * key so that adding one later — by placement or country — produces additional rows rather
     * than overwriting the unbroken totals the P&L reads.
     */
    async persistReports(
      adAccountId: string,
      reports: readonly NormalisedTikTokReport[],
    ): Promise<PersistReportsResult> {
      if (reports.length === 0) return { rows: 0, skippedUnresolvedEntities: 0 };

      const entityIds = await resolveEntities(adAccountId, reports);
      let skippedUnresolvedEntities = 0;

      const rows = reports.flatMap((report) => {
        let entityId: string | null = null;

        if (report.entityExternalId) {
          entityId = entityIds.get(report.entityExternalId) ?? null;
          if (entityId === null) {
            skippedUnresolvedEntities += 1;
            return [];
          }
        } else if (report.level !== "advertiser") {
          // A row below advertiser level that TikTok returned without its identifier. It
          // cannot be attributed, and the advertiser row covers it, so it is not written.
          skippedUnresolvedEntities += 1;
          return [];
        }

        return [{
          organisation_id: organisationId,
          ad_account_id: adAccountId,
          entity_id: entityId,
          metric_date: report.metricDate,
          attribution_window: ATTRIBUTION_KEY,
          breakdown_key: "",
          spend: report.spend,
          impressions: report.impressions,
          reach: report.reach,
          clicks: report.clicks,
          landing_page_views: report.landingPageViews,
          add_to_carts: report.addToCarts,
          checkouts: report.checkouts,
          purchases: report.purchases,
          purchase_value: report.purchaseValue,
          raw_metrics: report.raw,
        }];
      });

      if (rows.length === 0) return { rows: 0, skippedUnresolvedEntities };

      const { error } = await client.from("ad_daily_metrics").upsert(rows, {
        // Matches the `nulls not distinct` index from migration 0007, without which the
        // advertiser-level row inserts afresh on every sync instead of updating.
        onConflict: "ad_account_id,entity_id,metric_date,attribution_window,breakdown_key",
      });
      if (error) throw error;

      return { rows: rows.length, skippedUnresolvedEntities };
    },
  };

  async function resolveEntities(
    adAccountId: string,
    reports: readonly NormalisedTikTokReport[],
  ): Promise<Map<string, string>> {
    const externalIds = [
      ...new Set(
        reports.map((report) => report.entityExternalId).filter((id): id is string => id !== null),
      ),
    ];
    if (externalIds.length === 0) return new Map();

    const { data, error } = await client
      .from("ad_entities")
      .select("id, external_id")
      .eq("ad_account_id", adAccountId)
      .in("external_id", externalIds);
    if (error) throw error;

    return new Map((data ?? []).map((row) => [row.external_id as string, row.id as string]));
  }
}
