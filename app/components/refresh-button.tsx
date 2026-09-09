"use client";

import { useActionState } from "react";
import { refreshNow, type RefreshState } from "../actions/refresh";

/**
 * Triggers the same refresh the nightly job runs.
 *
 * The outcome per provider is shown rather than a single tick. A refresh where Shopify
 * succeeded and Meta failed is not a success, and reporting it as one is how a dashboard ends
 * up quietly showing yesterday's spend against today's revenue.
 */
export function RefreshButton() {
  const [state, action, pending] = useActionState<RefreshState, FormData>(
    async () => refreshNow(),
    { status: "idle" },
  );

  return (
    <div className="refresh">
      <form action={action}>
        <button type="submit" disabled={pending}>
          {pending ? "Refreshing…" : "Refresh now"}
        </button>
      </form>

      {pending ? (
        <p className="muted small">
          Fetching from every connected provider, then recalculating. This usually takes under a minute.
        </p>
      ) : null}

      {state.status !== "idle" && !pending ? (
        <div className={`refresh-result status-${statusColour(state.status)}`}>
          <p className="small">{state.message}</p>
          {state.detail && state.detail.length > 0 ? (
            <ul className="small muted">
              {state.detail.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function statusColour(status: RefreshState["status"]): string {
  if (status === "ok") return "green";
  if (status === "partial") return "amber";
  return "red";
}
