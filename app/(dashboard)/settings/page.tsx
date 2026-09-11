import { requireSession } from "@/lib/auth/current-user";
import { createReportingRepository } from "@/lib/reporting/reporting-repository";
import { METRIC_CATALOGUE } from "@/lib/monitoring/metric-catalogue";
import { enteredValue } from "@/lib/settings/metric-targets";
import { resolveAllEffective } from "@/lib/financial/effective-dating";
import { toBusinessDate } from "@/lib/financial/dates";
import { TargetRow } from "./target-row";

export const dynamic = "force-dynamic";

/**
 * Where the thresholds the dashboard judges against are set.
 *
 * Nothing in the code decides what good looks like for QNCH; every threshold lives in
 * `metric_targets` and every one of them is set here. A metric with no target produces no
 * judgement at all, which is why the dashboard reports "no targets configured" rather than green
 * — an unmeasured business is not a healthy one.
 *
 * Changes take effect from today and leave earlier periods judged against whatever was in force
 * at the time. That is deliberate: restating a past month against a target set this morning
 * would rewrite what was reported, and the point of dating targets is that it cannot.
 */
export default async function SettingsPage() {
  const session = await requireSession();
  const today = toBusinessDate(new Date(), session.businessTimezone);

  const repository = createReportingRepository(session.client, {
    organisationId: session.organisationId,
    businessTimezone: session.businessTimezone,
  });

  const targets = await repository.loadMetricTargets();
  const inForce = new Map(
    resolveAllEffective([...targets], today).map((target) => [target.metricKey, target]),
  );

  const configured = inForce.size;

  return (
    <>
      <p className="eyebrow">QNCH · SETTINGS</p>
      <h1 className="title-sm">Targets</h1>

      <div className={`banner${configured === 0 ? " red" : ""}`}>
        <h3>
          {configured === 0
            ? "Nothing is being judged"
            : `${configured} of ${METRIC_CATALOGUE.length} metrics have a target`}
        </h3>
        <p className="muted">
          The dashboard&rsquo;s green, amber and red comes from here and from nowhere else. A
          metric with no target is never flagged, which is not the same as it being healthy —
          so a dashboard with no targets at all reports that it is not judging, rather than
          reporting that everything is fine.
        </p>
        <p className="muted">
          Saving applies from today. Periods already reported keep the target they were judged
          against, and &ldquo;Stop judging&rdquo; end-dates a target rather than deleting it, for
          the same reason.
        </p>
      </div>

      <section className="panel">
        <h2>Thresholds</h2>
        <p className="muted small" style={{ marginTop: "-0.5rem", marginBottom: "1.25rem" }}>
          Enter percentages as percentages — 15 means 15%, not 0.15. Multiples read as they are
          written: 3 means 3x. Whether a target is a floor or a ceiling follows from the metric
          and is not a choice: more margin is better, less CAC is better.
        </p>

        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Metric</th>
                <th>Should be</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {METRIC_CATALOGUE.map((metric) => {
                const target = inForce.get(metric.key);
                return (
                  <TargetRow
                    key={metric.key}
                    metricKey={metric.key}
                    label={metric.label}
                    description={metric.description}
                    basis={metric.basis}
                    direction={metric.direction}
                    currentValue={target ? enteredValue(metric, Number(target.targetValue)) : null}
                    currentSeverity={target ? (target.severity as "amber" | "red") : null}
                  />
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="muted small">
          Amber means attention; red means action. Only an owner or finance administrator can
          change these — an operator or viewer is refused by the database, not by this page.
        </p>
      </section>
    </>
  );
}
