import Link from "next/link";
import { PolicyGate } from "../../components/policy-gate";
import { TrendChart } from "../../components/chart";
import { SaveReportForm, DeleteReportButton } from "./report-form";
import { parseReport, reportQuery, type ReportSearchParams } from "./query";
import { loadDashboard } from "@/lib/reporting/dashboard-data";
import { createReportingRepository } from "@/lib/reporting/reporting-repository";
import { createSavedReportRepository } from "@/lib/reporting/saved-reports";
import { buildPeriodSeries, REPORT_GRAINS, type ReportGrain } from "@/lib/reporting/series";
import { METRIC_CATALOGUE, metricDefinition } from "@/lib/monitoring/metric-catalogue";
import { TIMEFRAMES, type TimeframeKey } from "@/lib/reporting/timeframes";
import { formatByBasis, formatDateRange } from "@/lib/reporting/format";

export const dynamic = "force-dynamic";

/**
 * Custom reporting: choose metrics, a window and a grain, and get them as a table and a chart.
 *
 * Every bucket is computed by running the engine over that bucket, not by aggregating the
 * dashboard's figures. Most of these metrics do not sum — a month's CAC is not the sum of its
 * days' CACs, and MER is a ratio of two totals rather than a total of ratios — so adding them
 * up would produce numbers that look right and are not.
 *
 * The whole specification lives in the query string, which is what makes a report a shareable
 * link, and lets the CSV route render exactly what is on screen by parsing the same parameters
 * rather than reimplementing them.
 */
export default async function ReportsPage({ searchParams }: { searchParams: Promise<ReportSearchParams> }) {
  const params = await searchParams;

  // The timeframe on this page comes from the report, not from the shared selector, so the
  // loader is asked for its default and its range is not used.
  const load = await loadDashboard({});
  if (load.status === "not_approved") return <PolicyGate missing={load.missing} />;

  const { session, policy, today } = load;
  const specification = parseReport(params, today);

  const repository = createReportingRepository(session.client, {
    organisationId: session.organisationId,
    businessTimezone: session.businessTimezone,
  });

  const [facts, saved] = await Promise.all([
    repository.loadFacts(specification.timeframe.range, policy),
    createSavedReportRepository(session.client, session.organisationId).list(),
  ]);

  const series = buildPeriodSeries({
    facts,
    range: specification.timeframe.range,
    grain: specification.grain,
    metrics: specification.metrics,
  });

  const definitions = specification.metrics.map((key) => metricDefinition(key)!);

  // The first metric drives the chart. Charting several at once would put a percentage and a
  // pound figure on one axis, where the smaller series flattens into the baseline.
  const chartMetric = definitions[0];
  const chartSeries = series.map((period) => ({
    date: period.range.from,
    value: period.values.get(chartMetric.key)?.toNumber() ?? 0,
  }));

  const exportQuery = reportQuery({
    metrics: specification.metrics,
    grain: specification.grain,
    timeframeKey: specification.isCustomRange ? null : specification.timeframe.key,
    range: specification.isCustomRange ? specification.timeframe.range : null,
  });

  return (
    <>
      <p className="eyebrow">QNCH · CUSTOM REPORT</p>
      <h1 className="title-sm">Reports</h1>

      <form method="get" className="report-builder">
        <fieldset>
          <legend>Metrics</legend>
          <div className="metric-picker">
            {METRIC_CATALOGUE.map((metric) => (
              <label key={metric.key} title={metric.description}>
                <input
                  type="checkbox"
                  name="metric"
                  value={metric.key}
                  defaultChecked={specification.metrics.includes(metric.key)}
                />
                <span>{metric.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="report-controls">
          <label>
            <span className="label">Grain</span>
            <select name="grain" defaultValue={specification.grain}>
              {(Object.keys(REPORT_GRAINS) as ReportGrain[]).map((grain) => (
                <option key={grain} value={grain}>
                  {REPORT_GRAINS[grain]}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="label">Timeframe</span>
            <select name="timeframe" defaultValue={specification.isCustomRange ? "30d" : specification.timeframe.key}>
              {(Object.keys(TIMEFRAMES) as TimeframeKey[]).map((key) => (
                <option key={key} value={key}>
                  {TIMEFRAMES[key]}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="label">From</span>
            <input type="date" name="from" defaultValue={specification.isCustomRange ? specification.timeframe.range.from : ""} />
          </label>
          <label>
            <span className="label">To</span>
            <input type="date" name="to" defaultValue={specification.isCustomRange ? specification.timeframe.range.to : ""} />
          </label>

          <button type="submit">Run report</button>
        </div>
        <p className="muted small">
          Filling in both dates overrides the timeframe. Leave them empty for a window that keeps
          moving with today, which is what a saved report normally wants.
        </p>
      </form>

      {specification.rejectedMetrics.length > 0 ? (
        <div className="banner red">
          <h3>Some metrics were not recognised</h3>
          <p className="muted">
            {specification.rejectedMetrics.join(", ")} — not in the metric catalogue, so they were
            left out rather than shown as empty columns.
          </p>
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <h2>{chartMetric.label}</h2>
          <a href={`/api/reports/export?${exportQuery}`} className="link-button">
            Download CSV
          </a>
        </div>
        <p className="muted small" style={{ marginTop: "-0.5rem", marginBottom: "1.25rem" }}>
          {formatDateRange(specification.timeframe.range.from, specification.timeframe.range.to)} ·{" "}
          {REPORT_GRAINS[specification.grain].toLowerCase()} · {chartMetric.description}
        </p>
        <TrendChart series={chartSeries} label={`${chartMetric.label} by period`} />
      </section>

      <section className="panel">
        <h2>Figures</h2>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Period</th>
                {definitions.map((metric) => (
                  <th key={metric.key} title={metric.description}>
                    {metric.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {series.map((period) => (
                <tr key={period.key}>
                  <td>{period.label}</td>
                  {definitions.map((metric) => (
                    <td key={metric.key}>{formatByBasis(period.values.get(metric.key) ?? null, metric.basis)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          A dash is a figure that could not be calculated for that period — no acquisitions, no
          revenue to take a margin of — rather than a measured zero. Cash and stock are positions
          at an instant rather than activity over a window, so they read as unavailable here and
          are shown live on their own pages.
        </p>
      </section>

      <section className="panel">
        <h2>Saved reports</h2>
        <SaveReportForm
          metrics={specification.metrics}
          grain={specification.grain}
          timeframeKey={specification.isCustomRange ? null : specification.timeframe.key}
          range={specification.isCustomRange ? specification.timeframe.range : null}
        />

        {saved.length === 0 ? (
          <p className="muted small">
            None yet. A saved report stores the question — which metrics, what window, what grain —
            and recomputes from the engine each time it is opened, so it always reflects the costs
            approved now rather than a snapshot from when it was saved.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Metrics</th>
                <th>Window</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {saved.map((report) => (
                <tr key={report.id}>
                  <td>
                    <Link
                      href={`/reports?${reportQuery({
                        metrics: report.metricKeys.filter((key) => !report.unknownMetrics.includes(key)),
                        grain: report.grain,
                        timeframeKey: report.timeframeKey,
                        range: report.range,
                        savedReportId: report.id,
                      })}`}
                    >
                      {report.name}
                    </Link>
                    {report.unknownMetrics.length > 0 ? (
                      <>
                        <br />
                        <span className="small status-amber">
                          {report.unknownMetrics.length} metric(s) no longer exist and are omitted
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td className="muted small">{report.metricKeys.length}</td>
                  <td className="muted small">
                    {report.range
                      ? formatDateRange(report.range.from, report.range.to)
                      : (TIMEFRAMES[report.timeframeKey as TimeframeKey] ?? "—")}
                    {" · "}
                    {REPORT_GRAINS[report.grain].toLowerCase()}
                  </td>
                  <td>
                    <DeleteReportButton id={report.id} name={report.name} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
