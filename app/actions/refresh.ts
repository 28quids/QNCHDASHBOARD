"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth/current-user";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getServerEnvironment } from "@/lib/env";
import { refreshEverything } from "@/lib/connectors/pipeline";

export interface RefreshState {
  status: "idle" | "ok" | "partial" | "error";
  message?: string;
  detail?: string[];
}

/**
 * Runs the same refresh the nightly cron runs, on demand.
 *
 * `requireSession` is called first and is not decorative: a Server Action is a public HTTP
 * endpoint, so without it anyone who could reach the deployment could trigger provider syncs.
 * Only after the caller is established does this switch to the service-role client, which the
 * connectors need to write tables no browser session is permitted to touch.
 */
export async function refreshNow(): Promise<RefreshState> {
  const session = await requireSession();
  const environment = getServerEnvironment();

  try {
    const result = await refreshEverything(createSupabaseAdminClient(), {
      organisationId: session.organisationId,
      businessTimezone: session.businessTimezone,
      encryptionKey: environment.TOKEN_ENCRYPTION_KEY,
      // Minute-resolution, so pressing the button twice genuinely re-runs rather than being
      // skipped as an already-succeeded job — which is what someone pressing it expects.
      jobDiscriminator: `manual_${new Date().toISOString().slice(0, 16)}`,
    });

    const detail = result.syncs.map((sync) => {
      const written =
        sync.outcome.status === "succeeded" ? ` (${sync.outcome.written} rows)` : "";
      const error = sync.outcome.status === "failed" ? `: ${sync.outcome.error.message}` : "";
      return `${sync.provider} ${sync.resource} — ${sync.outcome.status}${written}${error}`;
    });

    if (result.calculation?.status === "not_approved") {
      return {
        status: "partial",
        message: "Data refreshed, but figures were not published: the financial policy is not approved.",
        detail: [...detail, ...result.calculation.missing],
      };
    }

    // Every page reads on request, so the whole dashboard reflects the new data.
    revalidatePath("/", "layout");

    // Surfaced beside the sync outcomes, and never treated as a failure of the refresh: an
    // unmatched source is a finding about the business, not a fault in the job that found it.
    const unmatched = result.reconciliation?.unmatched ?? [];
    if (unmatched.length > 0) {
      detail.push(
        `reconciliation — ${unmatched.length} unmatched: ${unmatched.map((check) => check.reconciliationKey).join(", ")}`,
      );
    }

    // "Nothing ran" is not "everything succeeded". An empty sync list means no provider is
    // connected — or every connection was unusable — and reporting that as a clean refresh is
    // how a dashboard comes to show data that stopped updating a fortnight ago.
    if (result.syncs.length === 0) {
      return {
        status: "partial",
        message: "Nothing was synced: no provider is connected. Figures below are unchanged.",
        detail,
      };
    }

    return {
      status: result.allSucceeded ? "ok" : "partial",
      message: result.allSucceeded
        ? `Refreshed at ${new Date(result.finishedAt).toLocaleTimeString("en-GB")}.`
        : "Some providers failed. The figures below cover whatever did arrive.",
      detail,
    };
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    return { status: "error", message: `Refresh failed: ${error.message}` };
  }
}
