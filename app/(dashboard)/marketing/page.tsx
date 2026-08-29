import { PolicyGate } from "../../components/policy-gate";
import { Metric } from "../../components/metric";
import { TrendChart } from "../../components/chart";
import { TimeframeSelector } from "../../components/timeframe-selector";
import { loadDashboard } from "@/lib/reporting/dashboard-data";
import { changeAgainst, gbp, multiple, UNAVAILABLE } from "@/lib/reporting/format";

export const dynamic = "force-dynamic";

/**
 * Acquisition economics.
 *
 * Platform-reported ROAS is shown, but in its own table and labelled as the platform's own
 * attribution claim. It is never mixed into MER, CAC or the break-even figures, which are
 * measured from QNCH orders and QNCH contribution.
 */
export default async function MarketingPage({
  searchParams,
}: {
  searchParams: Promise<{ timeframe?: string }>;
}) {
  const load = await loadDashboard(searchParams);
  if (load.status === "not_approved") return <PolicyGate missing={load.missing} />;

  const { report, comparison, timeframe } = load;
  const marketing = report.marketing;
  const noSpend = marketing.advertisingSpend.isZero();

  const spendSeries = report.daily.map((row) => ({
    date: row.businessDate,
    value: row.advertisingSpend.toNumber(),
  }));

  return (
    <>
      <p className="eyebrow">QNCH · {timeframe.label.toUpperCase()}</p>
      <h1 className="title-sm">Marketing</h1>
      <TimeframeSelector pathname="/marketing" active={timeframe.key} range={timeframe.range} />

      {noSpend ? (
        <div className="banner">
          <h3>No advertising spend recorded in this period</h3>
          <p className="muted">
            Meta and TikTok are not connected, so acquisition efficiency cannot be measured.
            Maximum CAC and break-even ROAS below are still valid — they come from QNCH
            contribution, not from spend.
          </p>
        </div>
      ) : null}

      <h2>QNCH-measured</h2>
      <div className="grid cols-4">
        <Metric
          label="Ad spend"
          value={gbp(marketing.advertisingSpend)}
          change={changeAgainst(marketing.advertisingSpend, comparison.marketing.advertisingSpend)}
          higherIsWorse
        />
        <Metric
          label="MER"
          value={multiple(marketing.mer)}
          note="net revenue ÷ ad spend"
          change={changeAgainst(marketing.mer, comparison.marketing.mer)}
        />
        <Metric
          label="Blended CAC"
          value={gbp(marketing.blendedCac)}
          note="spend ÷ new customers"
          change={changeAgainst(marketing.blendedCac, comparison.marketing.blendedCac)}
          higherIsWorse
        />
        <Metric
          label="New-customer ROAS"
          value={multiple(marketing.newCustomerRoas)}
          note="first-order revenue ÷ spend"
        />
      </div>

      <h2>Break-even</h2>
      <div className="grid cols-4">
        <Metric
          label={`Maximum CAC (${marketing.contributionLevel.toUpperCase()})`}
          value={gbp(marketing.maximumCac)}
          note="contribution available per acquisition"
        />
        <Metric label="Break-even ROAS" value={multiple(marketing.breakEvenRoas)} />
        <Metric
          label="CAC headroom"
          value={gbp(marketing.cacHeadroom)}
          note={marketing.cacHeadroom ? "maximum less actual" : "no acquisitions in period"}
        />
        <Metric
          label="Acquisition viable"
          value={
            marketing.isAcquisitionViable === null
              ? UNAVAILABLE
              : marketing.isAcquisitionViable
                ? "Yes"
                : "No"
          }
          status={
            marketing.isAcquisitionViable === null
              ? "unavailable"
              : marketing.isAcquisitionViable
                ? "green"
                : "red"
          }
        />
      </div>

      <section className="panel">
        <h2>Platform-attributed</h2>
        <p className="muted small" style={{ marginTop: "-0.5rem", marginBottom: "1.25rem" }}>
          Each platform&apos;s own attribution claim. Shown for comparison only — these figures
          double-count customers claimed by more than one platform, which is why QNCH
          profitability is measured blended above.
        </p>
        <table>
          <thead>
            <tr>
              <th>Platform</th>
              <th>Spend</th>
              <th>Attributed purchases</th>
              <th>Attributed CAC</th>
              <th>Attributed ROAS</th>
            </tr>
          </thead>
          <tbody>
            {marketing.platforms.map((platform) => (
              <tr key={platform.platform}>
                <td style={{ textTransform: "capitalize" }}>{platform.platform}</td>
                <td>{gbp(platform.spend)}</td>
                <td>{platform.attributedPurchases ?? UNAVAILABLE}</td>
                <td>{gbp(platform.attributedCac)}</td>
                <td>{multiple(platform.attributedRoas)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Ad spend by day</h2>
        <TrendChart series={spendSeries} colour="var(--amber)" label="Advertising spend by day" />
      </section>
    </>
  );
}
