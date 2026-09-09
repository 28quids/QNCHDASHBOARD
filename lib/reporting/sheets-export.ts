/**
 * The export itself: build the workbook, make sure the tabs exist, write them, protect them.
 *
 * Google Sheets is a presentation surface, never a source of truth. Supabase holds the canonical
 * history; this writes a readable copy of it. Nothing is ever read back — a one-way export means
 * a stray edit in the spreadsheet can confuse a reader but can never reach the financial model.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createTokenProvider, type ServiceAccountCredentials } from "@/lib/connectors/google/auth";
import { SheetsClient } from "@/lib/connectors/google/sheets-client";
import {
  buildWorkbook,
  rangeFor,
  rectangular,
  wholeTabRange,
  type SheetTab,
  type WorkbookInput,
} from "./sheets-workbook";
import { createReportingRepository } from "./reporting-repository";
import { createOperationsRepository } from "./operations-repository";
import { buildCashPosition } from "@/lib/financial/cash";
import { buildInventoryPositions, totalInventoryValue } from "@/lib/financial/inventory";
import { buildReport } from "./report";
import { collectDataQuality } from "./data-quality-run";
import { rangeEndingOn, type DateRange } from "@/lib/financial/dates";
import { money } from "@/lib/financial/money";
import type Decimal from "decimal.js";
import { evaluateMetrics } from "@/lib/monitoring/targets";
import { buildObservations } from "./alerts";

const BURN_WINDOW_DAYS = 90;
const COMMITMENT_HORIZON_DAYS = 30;

export interface SheetsExportOptions {
  organisationId: string;
  businessTimezone: string;
  today: string;
  range: DateRange;
  spreadsheetId: string;
  credentials: ServiceAccountCredentials;
  fetchImpl?: typeof fetch;
}

export type SheetsExportResult =
  | { status: "not_approved"; missing: string[] }
  | { status: "exported"; tabs: string[]; cellsWritten: number; created: string[] };

/**
 * Gathers everything the workbook shows and writes it.
 *
 * Deliberately assembled from the same repositories and the same engine the dashboard uses, so
 * a figure in the spreadsheet and the same figure on screen cannot come from different code.
 */
export async function exportToSheets(
  client: SupabaseClient,
  options: SheetsExportOptions,
): Promise<SheetsExportResult> {
  const repository = createReportingRepository(client, {
    organisationId: options.organisationId,
    businessTimezone: options.businessTimezone,
  });

  const policy = await repository.loadPolicy();
  // The same refusal the calculation makes. A workbook full of figures computed without approved
  // costs reads as profit, where an empty one reads as "not calculated yet".
  if (policy.status === "not_approved") return { status: "not_approved", missing: policy.missing };

  const operations = createOperationsRepository(client, options.organisationId);
  const burnWindow = rangeEndingOn(options.today, BURN_WINDOW_DAYS);

  const [facts, targets, cash, stockPositions, context, dataQuality, { data: reconciliations }] =
    await Promise.all([
      repository.loadFacts(options.range, policy.policy),
      repository.loadMetricTargets(),
      operations.loadCash(burnWindow),
      operations.loadInventoryPositions(options.today),
      repository.loadAllocationContext(),
      collectDataQuality(client, {
        organisationId: options.organisationId,
        businessTimezone: options.businessTimezone,
        today: options.today,
      }),
      client
        .from("reconciliation_results")
        .select("reconciliation_key, source_a_value, source_b_value, difference, status")
        .eq("organisation_id", options.organisationId)
        .order("period_end", { ascending: false })
        .limit(10),
    ]);

  const report = buildReport(facts);

  // Cohorts and stock cover need the whole trading history, not the exported window: a variant's
  // rate of sale over the last week is what says whether it is about to run out.
  const history = buildReport(
    await repository.loadFacts({ from: earliestDate(options.range, options.today), to: options.today }, policy.policy),
  );

  const inventory = buildInventoryPositions({
    positions: stockPositions,
    orders: history.allocated,
    variantCostProfiles: context.variantCostProfiles,
    asOf: options.today,
    alertWindowDays: policy.policy.inventoryAlertWindowDays,
  });

  const hasReportedBankBalance = cash.bankBalance !== null;
  const cashPosition = buildCashPosition({
    asOf: options.today,
    bankBalance: cash.bankBalance ?? 0,
    commitments: cash.commitments,
    movements: cash.movements,
    commitmentHorizonDays: COMMITMENT_HORIZON_DAYS,
    burnWindowDays: BURN_WINDOW_DAYS,
    inventoryValue: totalInventoryValue(inventory).value,
  });

  const input: WorkbookInput = {
    report,
    generatedAt: new Date().toISOString(),
    today: options.today,
    cash: cashPosition,
    hasReportedBankBalance,
    inventory,
    dataQuality,
    reconciliation: (reconciliations ?? []).map((row) => ({
      reconciliationKey: row.reconciliation_key as string,
      sourceAValue: numeric(row.source_a_value),
      sourceBValue: numeric(row.source_b_value),
      difference: numeric(row.difference),
      status: row.status as string,
    })),
    targets: evaluateMetrics(
      buildObservations({ report, cash: cashPosition, hasReportedBankBalance, inventory }),
      targets,
      options.range.to,
    ),
  };

  return writeWorkbook(buildWorkbook(input), options);
}

/** PostgREST returns numerics as strings; the workbook wants Decimals or nothing. */
function numeric(value: unknown): Decimal | null {
  if (value === null || value === undefined) return null;
  const parsed = money(value as string);
  return parsed.isFinite() ? parsed : null;
}

/** A history window wide enough for stock cover, without pretending to know the first order. */
function earliestDate(range: DateRange, today: string): string {
  return range.from < today ? range.from : today;
}

export async function writeWorkbook(
  tabs: readonly SheetTab[],
  options: SheetsExportOptions,
): Promise<SheetsExportResult> {
  const sheets = new SheetsClient({
    spreadsheetId: options.spreadsheetId,
    accessToken: createTokenProvider({ credentials: options.credentials, fetchImpl: options.fetchImpl }),
    fetchImpl: options.fetchImpl,
  });

  const existing = await sheets.listSheets();
  const existingTitles = new Set(existing.map((sheet) => sheet.title));
  const created = tabs.map((tab) => tab.title).filter((title) => !existingTitles.has(title));

  await sheets.addSheets(created);

  // Cleared before writing. A shorter export would otherwise leave last night's rows below this
  // one, which is worse than no export at all: the stale rows look like current data.
  await sheets.clearRanges(tabs.map((tab) => wholeTabRange(tab.title)));

  const cellsWritten = await sheets.updateValues(
    tabs.map((tab) => ({ range: rangeFor(tab), values: rectangular(tab.rows) })),
  );

  // Protection is added once per tab, not on every run, or a nightly export would stack another
  // protected range every night until the workbook became unusable.
  const afterCreate = created.length > 0 ? await sheets.listSheets() : existing;
  const idsByTitle = new Map(afterCreate.map((sheet) => [sheet.title, sheet.sheetId]));
  const alreadyProtected = await sheets.listProtectedSheetIds();

  await sheets.protectSheets(
    tabs
      .map((tab) => idsByTitle.get(tab.title))
      .filter((id): id is number => id !== undefined && !alreadyProtected.has(id)),
    "Imported from the QNCH control centre. Edits here are overwritten on the next export.",
  );

  return { status: "exported", tabs: tabs.map((tab) => tab.title), cellsWritten, created };
}
