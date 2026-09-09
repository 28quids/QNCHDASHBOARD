"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth/current-user";
import { createSavedReportRepository, validateDraft } from "@/lib/reporting/saved-reports";
import { isReportGrain } from "@/lib/reporting/series";
import { isTimeframeKey } from "@/lib/reporting/timeframes";

export interface SaveReportState {
  status: "idle" | "saved" | "error";
  message?: string;
}

/**
 * Saves the report currently on screen.
 *
 * Everything is re-validated here rather than trusted from the form. A server action is a public
 * endpoint: the browser is where the form was rendered, not where the rules live.
 */
export async function saveReport(_previous: SaveReportState, form: FormData): Promise<SaveReportState> {
  const session = await requireSession();

  const grain = String(form.get("grain") ?? "");
  const timeframeKey = String(form.get("timeframe") ?? "");
  const from = String(form.get("from") ?? "");
  const to = String(form.get("to") ?? "");

  const draft = {
    name: String(form.get("name") ?? ""),
    description: String(form.get("description") ?? ""),
    metricKeys: form.getAll("metric").map(String),
    grain: isReportGrain(grain) ? grain : "month",
    // A fixed range and a named timeframe are mutually exclusive: a report meant to answer
    // "how are the last 30 days" must keep moving rather than freezing to the 30 days it was
    // created in, and one pinned to a quarter must not drift off it.
    timeframeKey: from && to ? null : isTimeframeKey(timeframeKey) ? timeframeKey : "30d",
    range: from && to ? { from, to } : null,
  } as const;

  const problems = validateDraft(draft);
  if (problems.length > 0) return { status: "error", message: problems.join(" ") };

  try {
    const repository = createSavedReportRepository(session.client, session.organisationId);
    const saved = await repository.save(draft, session.user.id);
    revalidatePath("/reports");
    return { status: "saved", message: `Saved "${saved.name}".` };
  } catch (error) {
    // Row-level security refuses the write for a viewer, which is a permission answer rather
    // than a fault, so it is reported as one instead of as a crash.
    return {
      status: "error",
      message: `Could not save: ${(error as Error).message}. Viewers cannot save reports.`,
    };
  }
}

export async function deleteReport(_previous: SaveReportState, form: FormData): Promise<SaveReportState> {
  const session = await requireSession();
  const id = String(form.get("id") ?? "");
  if (!id) return { status: "error", message: "No report to delete." };

  try {
    await createSavedReportRepository(session.client, session.organisationId).remove(id);
    revalidatePath("/reports");
    return { status: "saved", message: "Report deleted." };
  } catch (error) {
    return { status: "error", message: `Could not delete: ${(error as Error).message}` };
  }
}
