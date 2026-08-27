/**
 * Persists Meta advertising data.
 *
 * The load-bearing constraint is set by the reporting layer, not by Meta: `loadAdSpend` reads
 * only rows where `entity_id` is null, because campaign, ad set and ad rows repeat the same
 * spend at finer grain and summing every level would multiply advertising spend by the depth
 * of the hierarchy. So the account-level row is what the P&L consumes, and the entity rows
 * exist purely for the marketing breakdown.
 *
 * Everything is upserted on the natural key `ad_daily_metrics` already enforces, so
 * re-running a window rewrites those days rather than duplicating them. That matters more
 * here than for orders: Meta restates recent days as attribution settles, so the last week is
 * expected to be re-imported repeatedly and must converge rather than accumulate.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { ATTRIBUTION_KEY } from "@/lib/connectors/meta/queries";
import type { NormalisedMetaInsight } from "@/lib/connectors/meta/normalise";
import type { MetaAdAccount, MetaEntityLevel } from "@/lib/connectors/meta/types";

export interface MetaRepositoryContext {
  organisationId: string;
}

export interface PersistInsightsResult {
  rows: number;
  /**
   * Entity-level rows whose campaign, ad set or ad is not in `ad_entities` yet. They are
   * written against the account with a null entity rather than dropped, so their spend still
   * reaches the P&L even when the hierarchy sync has not caught up.
   */
  unresolvedEntities: number;
}

export interface EntityUpsert {
  externalId: string;
  level: MetaEntityLevel;
  parentExternalId: string | null;
  name: string | null;
  status: string | null;
  sourceUpdatedAt: string | null;
}

export function createMetaRepository(client: SupabaseClient, context: MetaRepositoryContext) {
  const { organisationId } = context;

  return {
    /** Upserts the ad account and returns its row id, which everything else hangs off. */
    async upsertAccount(account: MetaAdAccount): Promise<string> {
      const { data, error } = await client
        .from("ad_accounts")
        .upsert(
          {
            organisation_id: organisationId,
            platform: "meta",
            external_id: account.id,
            name: account.name,
            currency: account.currency,
            timezone: account.timezone_name,
          },
          { onConflict: "organisation_id,platform,external_id" },
        )
        .select("id")
        .single();

      if (error) throw error;
      return data.id as string;
    },

    async persistEntities(adAccountId: string, entities: readonly EntityUpsert[]): Promise<number> {
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
     * key so that adding one later — by placement or country — produces additional rows
     * rather than overwriting the unbroken totals the P&L reads.
     */
    async persistInsights(
      adAccountId: string,
      insights: readonly NormalisedMetaInsight[],
    ): Promise<PersistInsightsResult> {
      if (insights.length === 0) return { rows: 0, unresolvedEntities: 0 };

      const entityIds = await resolveEntities(adAccountId, insights);
      let unresolvedEntities = 0;

      const rows = insights.map((insight) => {
        let entityId: string | null = null;
        if (insight.entityExternalId) {
          entityId = entityIds.get(insight.entityExternalId) ?? null;
          if (entityId === null) unresolvedEntities += 1;
        }

        return {
          organisation_id: organisationId,
          ad_account_id: adAccountId,
          entity_id: entityId,
          metric_date: insight.metricDate,
          attribution_window: ATTRIBUTION_KEY,
          breakdown_key: "",
          spend: insight.spend,
          impressions: insight.impressions,
          reach: insight.reach,
          clicks: insight.clicks,
          landing_page_views: insight.landingPageViews,
          add_to_carts: insight.addToCarts,
          checkouts: insight.checkouts,
          purchases: insight.purchases,
          purchase_value: insight.purchaseValue,
          raw_metrics: insight.raw,
        };
      });

      const { error } = await client
        .from("ad_daily_metrics")
        .upsert(rows, {
          onConflict: "ad_account_id,entity_id,metric_date,attribution_window,breakdown_key",
        });
      if (error) throw error;

      return { rows: rows.length, unresolvedEntities };
    },
  };

  async function resolveEntities(
    adAccountId: string,
    insights: readonly NormalisedMetaInsight[],
  ): Promise<Map<string, string>> {
    const externalIds = [
      ...new Set(
        insights
          .map((insight) => insight.entityExternalId)
          .filter((id): id is string => id !== null),
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
