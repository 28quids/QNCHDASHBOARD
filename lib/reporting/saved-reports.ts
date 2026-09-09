/**
 * Reading and writing saved custom reports.
 *
 * A saved report stores the *question* — which metrics, over what window, at what grain — and
 * never the figures. Opening one recomputes from the engine, so it reflects the costs approved
 * now. Storing the answers would produce a report that silently disagrees with the dashboard
 * the moment a cost is corrected.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DateRange } from "@/lib/financial/dates";
import { isKnownMetric } from "@/lib/monitoring/metric-catalogue";
import { isReportGrain, type ReportGrain } from "./series";
import { isTimeframeKey, type TimeframeKey } from "./timeframes";

export interface SavedReport {
  id: string;
  name: string;
  description: string | null;
  metricKeys: string[];
  grain: ReportGrain;
  /** A named timeframe that moves with today, or a fixed range. Exactly one is set. */
  timeframeKey: TimeframeKey | null;
  range: DateRange | null;
  /**
   * Metric keys the catalogue no longer defines.
   *
   * Surfaced rather than dropped: a column quietly disappearing from a saved report is how
   * someone comes to trust a total that no longer includes what they think it does.
   */
  unknownMetrics: string[];
  updatedAt: string;
}

export interface SavedReportDraft {
  name: string;
  description?: string | null;
  metricKeys: readonly string[];
  grain: ReportGrain;
  timeframeKey?: TimeframeKey | null;
  range?: DateRange | null;
}

/** Fails loudly on anything the report page could not render, rather than storing it. */
export function validateDraft(draft: SavedReportDraft): string[] {
  const problems: string[] = [];

  if (draft.name.trim() === "") problems.push("A report needs a name.");
  if (draft.metricKeys.length === 0) problems.push("Choose at least one metric.");
  if (draft.metricKeys.length > 20) problems.push("A report can carry at most 20 metrics.");
  if (!isReportGrain(draft.grain)) problems.push(`${draft.grain} is not a grain.`);

  const unknown = draft.metricKeys.filter((key) => !isKnownMetric(key));
  if (unknown.length > 0) problems.push(`Not a known metric: ${unknown.join(", ")}.`);

  const hasTimeframe = draft.timeframeKey != null;
  const hasRange = draft.range != null;
  if (hasTimeframe === hasRange) {
    problems.push("Choose either a named timeframe or a fixed date range, not both.");
  }
  if (hasTimeframe && !isTimeframeKey(draft.timeframeKey ?? undefined)) {
    problems.push(`${draft.timeframeKey} is not a timeframe.`);
  }
  if (hasRange && draft.range!.from > draft.range!.to) {
    problems.push("The range ends before it starts.");
  }

  return problems;
}

function toSavedReport(row: Record<string, unknown>): SavedReport {
  const metricKeys = (row.metric_keys as string[] | null) ?? [];

  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    metricKeys,
    grain: row.grain as ReportGrain,
    timeframeKey: (row.timeframe_key as TimeframeKey | null) ?? null,
    range:
      row.range_from && row.range_to
        ? { from: row.range_from as string, to: row.range_to as string }
        : null,
    unknownMetrics: metricKeys.filter((key) => !isKnownMetric(key)),
    updatedAt: row.updated_at as string,
  };
}

export function createSavedReportRepository(client: SupabaseClient, organisationId: string) {
  const COLUMNS = "id, name, description, metric_keys, grain, timeframe_key, range_from, range_to, updated_at";

  return {
    async list(): Promise<SavedReport[]> {
      const { data, error } = await client
        .from("saved_reports")
        .select(COLUMNS)
        .eq("organisation_id", organisationId)
        .order("name");
      if (error) throw error;
      return (data ?? []).map(toSavedReport);
    },

    async get(id: string): Promise<SavedReport | null> {
      const { data, error } = await client
        .from("saved_reports")
        .select(COLUMNS)
        .eq("organisation_id", organisationId)
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return data ? toSavedReport(data) : null;
    },

    /** Upserts on the name, so re-saving a report the owner has tweaked replaces it. */
    async save(draft: SavedReportDraft, createdBy: string | null): Promise<SavedReport> {
      const problems = validateDraft(draft);
      if (problems.length > 0) throw new Error(problems.join(" "));

      const { data, error } = await client
        .from("saved_reports")
        .upsert(
          {
            organisation_id: organisationId,
            name: draft.name.trim(),
            description: draft.description?.trim() || null,
            metric_keys: [...draft.metricKeys],
            grain: draft.grain,
            timeframe_key: draft.timeframeKey ?? null,
            range_from: draft.range?.from ?? null,
            range_to: draft.range?.to ?? null,
            created_by: createdBy,
          },
          { onConflict: "organisation_id,name" },
        )
        .select(COLUMNS)
        .single();
      if (error) throw error;
      return toSavedReport(data);
    },

    async remove(id: string): Promise<void> {
      const { error } = await client
        .from("saved_reports")
        .delete()
        .eq("organisation_id", organisationId)
        .eq("id", id);
      if (error) throw error;
    },
  };
}
