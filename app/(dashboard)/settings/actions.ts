"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth/current-user";
import { createMetricTargetWriter, type TargetWriteResult } from "@/lib/settings/metric-targets";

export type TargetActionState = TargetWriteResult | { status: "idle"; message?: string };

/**
 * Saves or clears one metric's target.
 *
 * Everything is re-read from the form and re-validated here rather than trusted: a Server
 * Action is a public HTTP endpoint, and the browser is where the form was rendered, not where
 * the rules live. The database has the final say either way — `metric_targets` is restricted to
 * owners and finance administrators by policy, so a viewer who posted this directly is refused
 * by Postgres rather than by anything this file remembered to check.
 */
export async function saveTarget(
  _previous: TargetActionState,
  form: FormData,
): Promise<TargetActionState> {
  const session = await requireSession();
  const writer = createMetricTargetWriter(session.client, session.organisationId);

  const metricKey = String(form.get("metricKey") ?? "");
  const intent = String(form.get("intent") ?? "save");

  if (intent === "clear") {
    const result = await writer.clear(metricKey);
    if (result.status !== "rejected") revalidatePath("/", "layout");
    return result;
  }

  const raw = String(form.get("value") ?? "").trim();
  if (raw === "") {
    return { status: "rejected", message: "Enter a value, or use Stop judging to remove the target." };
  }

  const severity = String(form.get("severity") ?? "amber");

  const result = await writer.set({
    metricKey,
    enteredValue: Number(raw),
    severity: severity === "red" ? "red" : "amber",
  });

  // Every page evaluates targets on read, so the whole dashboard reflects the change at once.
  if (result.status !== "rejected") revalidatePath("/", "layout");
  return result;
}
