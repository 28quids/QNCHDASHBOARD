/**
 * The calculation job: stored facts in, published financials out.
 *
 * One entry point shared by the nightly cron route and the operational script, so a figure
 * produced by hand is produced by exactly the same code path as a figure produced overnight.
 *
 * It refuses to publish anything while the financial policy is unapproved. That refusal is
 * the point: an empty `daily_financials` reads as "not calculated yet", whereas a table full
 * of rows computed without approved costs reads as profit.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DateRange } from "@/lib/financial/dates";
import { buildReport, type ControlCentreReport } from "./report";
import { createDailyFinancialsWriter, CALCULATION_VERSION } from "./persist";
import { createReportingRepository } from "./reporting-repository";

export interface CalculationOptions {
  organisationId: string;
  businessTimezone: string;
  range: DateRange;
  version?: string;
  /** Computes the figures and reports them without writing. Used by `--dry-run`. */
  dryRun?: boolean;
}

export type CalculationResult =
  | { status: "not_approved"; missing: string[] }
  | {
      status: "calculated";
      report: ControlCentreReport;
      published: { version: string; dates: number; rowsWritten: number } | null;
    };

export async function calculateAndPublish(
  client: SupabaseClient,
  options: CalculationOptions,
): Promise<CalculationResult> {
  const repository = createReportingRepository(client, {
    organisationId: options.organisationId,
    businessTimezone: options.businessTimezone,
  });

  const policy = await repository.loadPolicy();
  if (policy.status === "not_approved") {
    return { status: "not_approved", missing: policy.missing };
  }

  const facts = await repository.loadFacts(options.range, policy.policy);
  const report = buildReport(facts);

  if (options.dryRun) return { status: "calculated", report, published: null };

  const writer = createDailyFinancialsWriter(client, options.organisationId);
  const published = await writer.publish(report.daily, options.version ?? CALCULATION_VERSION);

  return { status: "calculated", report, published };
}
