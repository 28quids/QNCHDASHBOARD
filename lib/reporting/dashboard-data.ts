import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toBusinessDate, type DateRange } from "@/lib/financial/dates";
import type { FinancialPolicy } from "@/lib/financial/policy";
import type { MetricTarget } from "@/lib/monitoring/targets";
import { requireSession, type DashboardSession } from "@/lib/auth/current-user";
import { buildReport, type ControlCentreReport } from "./report";
import { createReportingRepository } from "./reporting-repository";
import {
  DEFAULT_TIMEFRAME,
  isTimeframeKey,
  resolveTimeframe,
  type ResolvedTimeframe,
} from "./timeframes";

/**
 * The shared loader behind every dashboard page.
 *
 * Figures are computed on read rather than served from `daily_financials`. That guarantees the
 * dashboard always reflects the costs approved *now*: a corrected COGS shows up immediately
 * instead of waiting for the nightly job. `daily_financials` remains the published, versioned
 * record — what was reported at the time — which is what Google Sheets and any restatement
 * audit read. The data-quality page shows both, so a divergence is visible rather than assumed
 * away.
 */

export interface DashboardData {
  session: DashboardSession;
  timeframe: ResolvedTimeframe;
  today: string;
  report: ControlCentreReport;
  /** The same figures for the preceding window, for period-on-period comparison. */
  comparison: ControlCentreReport;
  policy: FinancialPolicy;
  /** Configured thresholds. Empty when none have been set, which is not the same as healthy. */
  targets: MetricTarget[];
}

export type DashboardLoad =
  | { status: "not_approved"; session: DashboardSession; missing: string[] }
  | ({ status: "ready" } & DashboardData);

export async function loadDashboard(
  searchParams: Promise<{ timeframe?: string }> | { timeframe?: string } = {},
): Promise<DashboardLoad> {
  const session = await requireSession();
  const params = await searchParams;

  const repository = createReportingRepository(session.client, {
    organisationId: session.organisationId,
    businessTimezone: session.businessTimezone,
  });

  const policy = await repository.loadPolicy();
  if (policy.status === "not_approved") {
    return { status: "not_approved", session, missing: policy.missing };
  }

  const today = toBusinessDate(new Date(), session.businessTimezone);
  const key = isTimeframeKey(params.timeframe) ? params.timeframe : DEFAULT_TIMEFRAME;
  const timeframe = resolveTimeframe(key, today);

  const [report, comparison, targets] = await Promise.all([
    loadRange(repository, timeframe.range, policy.policy),
    loadRange(repository, timeframe.comparison, policy.policy),
    repository.loadMetricTargets(),
  ]);

  return { status: "ready", session, timeframe, today, report, comparison, policy: policy.policy, targets };
}

async function loadRange(
  repository: ReturnType<typeof createReportingRepository>,
  range: DateRange,
  policy: FinancialPolicy,
): Promise<ControlCentreReport> {
  return buildReport(await repository.loadFacts(range, policy));
}

/**
 * The whole order history, for reporting that is not bounded by the selected timeframe.
 *
 * Cohorts need this: a cohort is defined by when a customer was acquired, so building them
 * from a 30-day window would report every customer as newly acquired that month.
 *
 * The range starts at the earliest order rather than at a fixed date, so it stays correct
 * without anyone remembering to move a hard-coded year.
 */
export async function loadFullHistory(
  data: { session: DashboardSession; policy: FinancialPolicy; today: string },
): Promise<ControlCentreReport> {
  const repository = createReportingRepository(data.session.client, {
    organisationId: data.session.organisationId,
    businessTimezone: data.session.businessTimezone,
  });

  const { data: earliest, error } = await data.session.client
    .from("shopify_orders")
    .select("ordered_at")
    .eq("organisation_id", data.session.organisationId)
    .eq("is_test", false)
    .is("cancelled_at", null)
    .order("ordered_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;

  const from = earliest
    ? toBusinessDate(earliest.ordered_at as string, data.session.businessTimezone)
    : data.today;

  return loadRange(repository, { from, to: data.today }, data.policy);
}

/** Convenience for pages that need a second client-side query beyond the report. */
export type DashboardClient = SupabaseClient;
