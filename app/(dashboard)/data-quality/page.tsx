import { requireSession } from "@/lib/auth/current-user";
import { createReportingRepository } from "@/lib/reporting/reporting-repository";
import { loadFullHistory } from "@/lib/reporting/dashboard-data";
import { summariseDataQuality } from "@/lib/monitoring/data-quality";
import {
  ALL_PROVIDERS,
  collectDataQuality,
} from "@/lib/reporting/data-quality-run";
import { toBusinessDate } from "@/lib/financial/dates";
import { formatDateRange, gbp, relativeTime } from "@/lib/reporting/format";
import { StatusPill } from "../../components/metric";
import { RefreshButton } from "../../components/refresh-button";

export const dynamic = "force-dynamic";

/**
 * Whether the numbers on the other pages can be trusted today.
 *
 * The checks come from the same collector the nightly job runs, so a failure shown here and one
 * recorded overnight can never be different failures.
 *
 * A provider that has never been connected is reported as failing, not omitted. Omitting it
 * would make a dashboard missing three of its four data sources look healthy, which is the
 * precise failure this page exists to prevent.
 */
export default async function DataQualityPage() {
  const session = await requireSession();
  const today = toBusinessDate(new Date(), session.businessTimezone);

  const repository = createReportingRepository(session.client, {
    organisationId: session.organisationId,
    businessTimezone: session.businessTimezone,
  });

  const [{ data: connections }, { data: published }, { data: reconciliations }, policy, context] =
    await Promise.all([
      session.client
        .from("integration_connections")
        .select("provider, status, last_success_at, last_attempt_at")
        .eq("organisation_id", session.organisationId),
      session.client
        .from("daily_financials")
        .select("business_date, calculation_version, calculated_at")
        .eq("organisation_id", session.organisationId)
        .eq("is_current", true)
        .order("business_date", { ascending: false })
        .limit(1),
      session.client
        .from("reconciliation_results")
        .select("reconciliation_key, period_start, period_end, source_a_value, source_b_value, difference, tolerance, status, notes, created_at")
        .eq("organisation_id", session.organisationId)
        .order("period_end", { ascending: false })
        .limit(20),
      repository.loadPolicy(),
      repository.loadAllocationContext(),
    ]);

  const byProvider = new Map((connections ?? []).map((row) => [row.provider as string, row]));

  // Cost coverage can only be checked once the policy allows the engine to run at all, so the
  // orders it needs are loaded only in that case.
  const sold =
    policy.status === "approved"
      ? await loadFullHistory({ session, policy: policy.policy, today }).then((history) =>
          history.allocated.flatMap((order) =>
            order.lines.map((line) => line.variantId).filter((id): id is string => id !== null),
          ),
        )
      : undefined;

  const results = await collectDataQuality(session.client, {
    organisationId: session.organisationId,
    businessTimezone: session.businessTimezone,
    today,
    soldVariantIds: sold,
    variantCostProfiles: sold ? context.variantCostProfiles : undefined,
  });

  const summary = summariseDataQuality(results);
  const latestPublished = published?.[0];

  return (
    <>
      <p className="eyebrow">QNCH · AS AT {today}</p>
      <h1 className="title-sm">Data quality</h1>

      <RefreshButton />

      <div className={`banner${summary.severity === "red" ? " red" : ""}`}>
        <h3>
          {summary.isTrustworthy
            ? "Figures are current"
            : `${summary.failing.length} failing, ${summary.warning.length} warning`}
        </h3>
        <p className="muted">
          {summary.isTrustworthy
            ? "Every check passed. The figures on the other pages reflect current data."
            : "Figures elsewhere in the dashboard are built on the data below. Treat them accordingly."}
        </p>
      </div>

      <section className="panel">
        <h2>Checks</h2>
        <ul className="alerts">
          {summary.results.map((result) => (
            <li key={result.checkKey}>
              <StatusPill status={result.severity} />
              <span>
                <strong>{result.checkKey}</strong>
                <br />
                <span className="muted small">{result.message}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>Connections</h2>
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Status</th>
              <th>Last success</th>
              <th>Last attempt</th>
            </tr>
          </thead>
          <tbody>
            {ALL_PROVIDERS.map((provider) => {
              const connection = byProvider.get(provider);
              return (
                <tr key={provider}>
                  <td style={{ textTransform: "capitalize" }}>{provider}</td>
                  <td>
                    {connection ? (
                      (connection.status as string)
                    ) : (
                      <span className="status-red">not connected</span>
                    )}
                  </td>
                  <td>{relativeTime((connection?.last_success_at as string | null) ?? null)}</td>
                  <td>{relativeTime((connection?.last_attempt_at as string | null) ?? null)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Reconciliation</h2>
        <p className="muted small" style={{ marginTop: "-0.5rem", marginBottom: "1.25rem" }}>
          Independent sources compared against each other. A difference is reported, never
          adjusted away: an unexplained gap between Shopify, the platforms and Xero is a finding
          about the business rather than a bug to hide. Timing differences are expected —
          settlements lag orders and advertising is billed in arrears — which is what the
          tolerance allows for.
        </p>
        {(reconciliations ?? []).length === 0 ? (
          <p className="muted small">
            No checks have run yet. They run with every refresh, and need both sides of a
            comparison to exist — payouts need Shopify Payments, and spend needs Xero mapped.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Check</th>
                <th>Period</th>
                <th>Source A</th>
                <th>Source B</th>
                <th>Difference</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {(reconciliations ?? []).map((row) => (
                <tr key={`${row.reconciliation_key}:${row.period_start}:${row.period_end}`}>
                  <td>{String(row.reconciliation_key)}</td>
                  <td className="muted small">
                    {formatDateRange(row.period_start as string, row.period_end as string)}
                  </td>
                  <td>{gbp(numberOrNull(row.source_a_value))}</td>
                  <td>{gbp(numberOrNull(row.source_b_value))}</td>
                  <td>{gbp(numberOrNull(row.difference))}</td>
                  <td>
                    <StatusPill status={reconciliationSeverity(String(row.status))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Published figures</h2>
        <p className="muted small" style={{ marginTop: "-0.5rem", marginBottom: "1.25rem" }}>
          The dashboard calculates on read, so it always reflects the costs approved now.
          <code>daily_financials</code> is the separate published record — what was reported at
          the time — used for restatement audit and the Sheets export. A stale publication here
          does not mean the dashboard is stale.
        </p>
        <table>
          <tbody>
            <tr>
              <td>Latest published date</td>
              <td>{latestPublished ? (latestPublished.business_date as string) : "never published"}</td>
            </tr>
            <tr>
              <td>Calculation version</td>
              <td>{latestPublished ? (latestPublished.calculation_version as string) : "—"}</td>
            </tr>
            <tr>
              <td>Calculated</td>
              <td>{relativeTime((latestPublished?.calculated_at as string | null) ?? null)}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </>
  );
}

const numberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/**
 * How a reconciliation status should read as a health colour.
 *
 * `not_applicable` is amber rather than green: it means one side of the comparison could not be
 * read at all, and a check that could not run must never look like one that passed.
 */
function reconciliationSeverity(status: string): "green" | "amber" | "red" | "unavailable" {
  if (status === "matched" || status === "within_tolerance") return "green";
  if (status === "unmatched") return "red";
  return "amber";
}
