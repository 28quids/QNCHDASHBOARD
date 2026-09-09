/**
 * Collecting and recording the data-quality checks.
 *
 * One collector, shared by the page that shows the checks and the job that runs overnight, so a
 * failure the dashboard reports and one the cron records can never be different failures. The
 * checks themselves stay pure in `lib/monitoring/data-quality.ts`; this fetches what they need.
 *
 * Results are written to `data_quality_results` so a failure has a history: a Meta sync that has
 * been broken for a week is a different problem from one that broke this morning, and a page
 * that only ever shows the current moment cannot tell them apart.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  checkAdAccountTimezone,
  checkDateCoverage,
  checkExpenseMappingCoverage,
  checkFinancialPolicyApproved,
  checkSyncFreshness,
  checkVariantCostCoverage,
  type DataQualityResult,
  type IntegrationProvider,
  type SyncState,
} from "@/lib/monitoring/data-quality";
import type { VariantCostProfile } from "@/lib/financial/domain";
import { addDays } from "@/lib/financial/dates";

/**
 * Every provider is checked, connected or not.
 *
 * A provider that has never been connected is reported as failing rather than omitted. Omitting
 * it would make a dashboard missing three of its four sources look healthy, which is the precise
 * failure this page exists to prevent.
 */
export const ALL_PROVIDERS: IntegrationProvider[] = ["shopify", "meta", "tiktok", "xero"];

/** A sync older than this is stale. A daily job that has not run in a day and a half has failed. */
export const MAXIMUM_SYNC_AGE_HOURS = 36;

/**
 * Days of advertising checked for gaps.
 *
 * Yesterday is excluded from the window: platforms report with a lag of several hours, so the
 * most recent day is legitimately absent for part of every morning and flagging it would make
 * the check cry wolf daily.
 */
export const AD_COVERAGE_WINDOW_DAYS = 30;

export interface DataQualityContext {
  organisationId: string;
  businessTimezone: string;
  today: string;
  /** Variants actually sold, so an unused SKU with no cost is not reported as a gap. */
  soldVariantIds?: Iterable<string>;
  variantCostProfiles?: readonly VariantCostProfile[];
  now?: Date;
}

export async function collectDataQuality(
  client: SupabaseClient,
  context: DataQualityContext,
): Promise<DataQualityResult[]> {
  const { organisationId } = context;

  const [
    { data: connections, error: connectionError },
    { data: settings, error: settingsError },
    { data: adAccounts, error: adAccountError },
    { data: rules, error: ruleError },
    { data: activity, error: activityError },
    { data: adDates, error: adDateError },
  ] = await Promise.all([
    client
      .from("integration_connections")
      .select("provider, status, last_success_at, last_attempt_at")
      .eq("organisation_id", organisationId),
    client
      .from("business_settings")
      .select("financial_policy_status")
      .eq("organisation_id", organisationId)
      .maybeSingle(),
    client.from("ad_accounts").select("platform, external_id, timezone").eq("organisation_id", organisationId),
    client
      .from("expense_mapping_rules")
      .select("xero_account_id, effective_to")
      .eq("organisation_id", organisationId),
    client
      .from("xero_bank_transaction_lines")
      .select("xero_account_id")
      .eq("organisation_id", organisationId)
      .not("xero_account_id", "is", null),
    client
      .from("ad_daily_metrics")
      .select("metric_date")
      .eq("organisation_id", organisationId)
      .gte("metric_date", addDays(context.today, -AD_COVERAGE_WINDOW_DAYS))
      .lte("metric_date", addDays(context.today, -2)),
  ]);
  if (connectionError) throw connectionError;
  if (settingsError) throw settingsError;
  if (adAccountError) throw adAccountError;
  if (ruleError) throw ruleError;
  if (activityError) throw activityError;
  if (adDateError) throw adDateError;

  const byProvider = new Map((connections ?? []).map((row) => [row.provider as string, row]));

  const syncStates: SyncState[] = ALL_PROVIDERS.map((provider) => {
    const connection = byProvider.get(provider);
    return {
      provider,
      lastSuccessAt: (connection?.last_success_at as string | null) ?? null,
      lastAttemptAt: (connection?.last_attempt_at as string | null) ?? null,
      // `needs_reauth` is a failure that no retry will clear, so it must not read as succeeded.
      lastStatus:
        connection?.status === "failed" || connection?.status === "needs_reauth"
          ? "failed"
          : connection
            ? "succeeded"
            : null,
    };
  });

  const results: DataQualityResult[] = [
    checkFinancialPolicyApproved(
      (settings?.financial_policy_status as "draft" | "approved" | undefined) ?? "draft",
    ),
    ...checkSyncFreshness(syncStates, context.now ?? new Date(), MAXIMUM_SYNC_AGE_HOURS),
    checkAdAccountTimezone(
      (adAccounts ?? []).map((row) => ({
        platform: row.platform as string,
        externalId: row.external_id as string,
        timezone: (row.timezone as string | null) ?? null,
      })),
      context.businessTimezone,
    ),
    checkExpenseMappingCoverage(
      (activity ?? []).map((row) => row.xero_account_id as string),
      // Only rules still in force. An end-dated mapping does not cover today's spend, and
      // counting it would report a gap as covered.
      (rules ?? [])
        .filter((row) => row.effective_to === null || (row.effective_to as string) >= context.today)
        .map((row) => row.xero_account_id as string),
    ),
  ];

  /*
   * A gap in advertising is a missing day of spend the P&L will silently report as zero, which
   * looks like a day of free revenue. Orders are deliberately not checked the same way: a day
   * with no orders is normal for a brand of this size, and flagging it would be noise.
   *
   * Only checked once some advertising exists — an organisation not running ads has no gap.
   */
  if ((adDates ?? []).length > 0) {
    results.push(
      checkDateCoverage(
        "advertising.coverage",
        (adDates ?? []).map((row) => row.metric_date as string),
        { from: addDays(context.today, -AD_COVERAGE_WINDOW_DAYS), to: addDays(context.today, -2) },
      ),
    );
  }

  // Cost coverage is only meaningful once the caller has loaded the orders that were sold. The
  // check is omitted rather than passed when it could not be run.
  if (context.soldVariantIds && context.variantCostProfiles) {
    results.push(
      checkVariantCostCoverage(context.soldVariantIds, context.variantCostProfiles, context.today),
    );
  }

  return results;
}

/**
 * Records the latest result per check.
 *
 * Upserted rather than appended, so the table answers "is this check passing now" rather than
 * accumulating a log in which a stale pass sits indistinguishably beside a current one.
 */
export async function persistDataQuality(
  client: SupabaseClient,
  organisationId: string,
  results: readonly DataQualityResult[],
): Promise<number> {
  if (results.length === 0) return 0;

  const { error } = await client.from("data_quality_results").upsert(
    results.map((result) => ({
      organisation_id: organisationId,
      check_key: result.checkKey,
      severity: result.severity,
      status: result.status,
      observed_value: result.observed ?? null,
      checked_at: new Date().toISOString(),
    })),
    { onConflict: "organisation_id,check_key" },
  );
  if (error) throw error;
  return results.length;
}
