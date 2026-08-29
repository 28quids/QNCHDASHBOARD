import { PolicyGate } from "../components/policy-gate";
import { Metric } from "../components/metric";
import { TrendChart } from "../components/chart";
import { TimeframeSelector } from "../components/timeframe-selector";
import { loadDashboard } from "@/lib/reporting/dashboard-data";
import { changeAgainst, count, gbp, multiple, percent } from "@/lib/reporting/format";

export const dynamic = "force-dynamic";

/**
 * The executive view. It answers, in order: are we growing, is acquisition efficient, does
 * each order make money, is the company profitable, and is anything going wrong.
 *
 * Net profit is shown but will read as unavailable until fixed costs are configured or Xero
 * is mapped. That is deliberate — CM3 relabelled as profit would be a misstatement.
 */
export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ timeframe?: string }>;
}) {
  const load = await loadDashboard(searchParams);
  if (load.status === "not_approved") return <PolicyGate missing={load.missing} />;

  const { report, comparison, timeframe } = load;
  const now = report.summary;
  const before = comparison.summary;

  const revenueSeries = report.daily.map((row) => ({
    date: row.businessDate,
    value: row.netRevenue.toNumber(),
  }));
  const cm3Series = report.daily.map((row) => ({
    date: row.businessDate,
    value: row.cm3.toNumber(),
  }));

  const hasFixedCosts = !now.fixedOperatingCosts.isZero();

  return (
    <>
      <p className="eyebrow">QNCH · {timeframe.label.toUpperCase()}</p>
      <h1 className="title-sm">Overview</h1>
      <TimeframeSelector pathname="/" active={timeframe.key} range={timeframe.range} />

      <h2>Trading</h2>
      <div className="grid cols-4">
        <Metric
          label="Net revenue"
          value={gbp(now.netRevenue)}
          change={changeAgainst(now.netRevenue, before.netRevenue)}
          note="vs previous period"
        />
        <Metric
          label="Orders"
          value={count(now.orders)}
          change={changeAgainst(now.orders, before.orders)}
        />
        <Metric
          label="AOV"
          value={gbp(now.averageOrderValue)}
          change={changeAgainst(now.averageOrderValue, before.averageOrderValue)}
        />
        <Metric
          label="New customers"
          value={count(now.newCustomers)}
          change={changeAgainst(now.newCustomers, before.newCustomers)}
        />
      </div>

      <h2>Contribution</h2>
      <div className="grid cols-4">
        <Metric
          label="CM1"
          value={gbp(now.cm1)}
          note={percent(now.cm1Margin)}
          change={changeAgainst(now.cm1, before.cm1)}
        />
        <Metric
          label="CM2"
          value={gbp(now.cm2)}
          note={percent(now.cm2Margin)}
          change={changeAgainst(now.cm2, before.cm2)}
        />
        <Metric
          label="CM3"
          value={gbp(now.cm3)}
          note={percent(now.cm3Margin)}
          change={changeAgainst(now.cm3, before.cm3)}
        />
        <Metric
          label="Operating profit"
          value={hasFixedCosts ? gbp(now.operatingProfit) : "—"}
          note={hasFixedCosts ? percent(now.operatingMargin) : "no fixed costs configured"}
          change={hasFixedCosts ? changeAgainst(now.operatingProfit, before.operatingProfit) : undefined}
        />
      </div>

      <h2>Acquisition</h2>
      <div className="grid cols-4">
        <Metric
          label="Ad spend"
          value={gbp(report.marketing.advertisingSpend)}
          change={changeAgainst(report.marketing.advertisingSpend, comparison.marketing.advertisingSpend)}
          higherIsWorse
        />
        <Metric
          label="MER"
          value={multiple(report.marketing.mer)}
          note="net revenue per £1 spend"
          change={changeAgainst(report.marketing.mer, comparison.marketing.mer)}
        />
        <Metric
          label="Blended CAC"
          value={gbp(report.marketing.blendedCac)}
          change={changeAgainst(report.marketing.blendedCac, comparison.marketing.blendedCac)}
          higherIsWorse
        />
        <Metric
          label={`Maximum CAC (${report.marketing.contributionLevel.toUpperCase()})`}
          value={gbp(report.marketing.maximumCac)}
          note={
            report.marketing.cacHeadroom
              ? `${gbp(report.marketing.cacHeadroom)} headroom`
              : "no acquisitions in period"
          }
        />
      </div>

      <section className="panel">
        <h2>Net revenue by day</h2>
        <TrendChart series={revenueSeries} label="Net revenue by day" />
      </section>

      <section className="panel">
        <h2>CM3 by day</h2>
        <TrendChart series={cm3Series} colour="var(--green)" label="CM3 by day" />
      </section>

      {report.warnings.length > 0 ? (
        <section className="panel">
          <h2>Warnings</h2>
          <ul className="alerts">
            {report.warnings.map((warning) => (
              <li key={`${warning.code}:${warning.detail}`}>
                <span className="pill status-amber">{warning.code.replace(/_/g, " ")}</span>
                <span className="muted small">{warning.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
