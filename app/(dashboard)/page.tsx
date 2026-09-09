import { PolicyGate } from "../components/policy-gate";
import { Metric, StatusPill } from "../components/metric";
import { TrendChart } from "../components/chart";
import { TimeframeSelector } from "../components/timeframe-selector";
import { loadDashboard, loadFullHistory } from "@/lib/reporting/dashboard-data";
import { createOperationsRepository } from "@/lib/reporting/operations-repository";
import { createReportingRepository } from "@/lib/reporting/reporting-repository";
import { assessHealth, lowestCover, metricLabel } from "@/lib/reporting/alerts";
import { buildCashPosition } from "@/lib/financial/cash";
import { buildInventoryPositions, totalInventoryValue } from "@/lib/financial/inventory";
import { rangeEndingOn } from "@/lib/financial/dates";
import {
  changeAgainst,
  count,
  gbp,
  integerDays,
  multiple,
  percent,
  UNAVAILABLE,
} from "@/lib/reporting/format";

export const dynamic = "force-dynamic";

const BURN_WINDOW_DAYS = 90;
const COMMITMENT_HORIZON_DAYS = 30;

/**
 * The executive view. It answers, in order: are we growing, is acquisition efficient, does
 * each order make money, is the company profitable, how much cash is there, and is anything
 * going wrong.
 *
 * Net profit is shown but will read as unavailable until fixed costs are configured or Xero
 * is mapped. That is deliberate — CM3 relabelled as profit would be a misstatement.
 *
 * The health status comes entirely from `metric_targets`. Nothing here decides what good looks
 * like, and an organisation with no targets configured reads as "no targets set" rather than
 * as green: a dashboard that says everything is fine because nothing was ever measured is
 * worse than one that admits it is not judging.
 */
export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ timeframe?: string }>;
}) {
  const load = await loadDashboard(searchParams);
  if (load.status === "not_approved") return <PolicyGate missing={load.missing} />;

  const { report, comparison, timeframe, session, policy, today, targets } = load;
  const now = report.summary;
  const before = comparison.summary;

  const operations = createOperationsRepository(session.client, session.organisationId);
  const reporting = createReportingRepository(session.client, {
    organisationId: session.organisationId,
    businessTimezone: session.businessTimezone,
  });

  const burnWindow = rangeEndingOn(today, BURN_WINDOW_DAYS);
  const [cash, stockPositions, history, context] = await Promise.all([
    operations.loadCash(burnWindow),
    operations.loadInventoryPositions(today),
    loadFullHistory(load),
    reporting.loadAllocationContext(),
  ]);

  const inventory = buildInventoryPositions({
    positions: stockPositions,
    orders: history.allocated,
    variantCostProfiles: context.variantCostProfiles,
    asOf: today,
    alertWindowDays: policy.inventoryAlertWindowDays,
  });
  const inventoryValue = totalInventoryValue(inventory).value;
  const hasBankBalance = cash.bankBalance !== null;

  const cashPosition = buildCashPosition({
    asOf: today,
    bankBalance: cash.bankBalance ?? 0,
    commitments: cash.commitments,
    movements: cash.movements,
    commitmentHorizonDays: COMMITMENT_HORIZON_DAYS,
    burnWindowDays: BURN_WINDOW_DAYS,
    inventoryValue,
  });

  // Judged at the end of the period shown, not today, so restating a past period uses the
  // target that was in force then.
  const health = assessHealth(
    { report, cash: cashPosition, hasReportedBankBalance: hasBankBalance, inventory },
    targets,
    timeframe.range.to,
  );

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

      <div className={`banner${health.status === "red" ? " red" : ""}`}>
        <h3>
          <StatusPill status={health.status} />{" "}
          {!health.hasTargets
            ? "No targets configured"
            : health.alerts.length === 0
              ? "Every configured target is being met"
              : `${health.alerts.length} target${health.alerts.length === 1 ? "" : "s"} needs attention`}
        </h3>
        <p className="muted">
          {health.hasTargets
            ? "Status comes from the thresholds configured in metric targets, and from nothing else."
            : "Nothing is being judged, which is not the same as everything being healthy. Set thresholds with npm run seed:targets."}
        </p>
      </div>

      {health.alerts.length > 0 ? (
        <section className="panel">
          <h2>Alerts</h2>
          <ul className="alerts">
            {health.alerts.map((alert) => (
              <li key={alert.metricKey}>
                <StatusPill status={alert.status} />
                <span>
                  <strong>{metricLabel(alert.metricKey)}</strong>
                  <br />
                  <span className="muted small">{alert.message}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <h2>Trading</h2>
      <div className="grid cols-4">
        <Metric
          label="Net revenue"
          value={gbp(now.netRevenue)}
          change={changeAgainst(now.netRevenue, before.netRevenue)}
          note={health.noteOf("net_revenue") ?? "vs previous period"}
          status={health.statusOf("net_revenue")}
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
          note={health.noteOf("average_order_value")}
          status={health.statusOf("average_order_value")}
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
          note={health.noteOf("cm3_margin") ?? percent(now.cm3Margin)}
          change={changeAgainst(now.cm3, before.cm3)}
          status={health.statusOf("cm3_margin")}
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
          note={health.noteOf("mer") ?? "net revenue per £1 spend"}
          change={changeAgainst(report.marketing.mer, comparison.marketing.mer)}
          status={health.statusOf("mer")}
        />
        <Metric
          label="Blended CAC"
          value={gbp(report.marketing.blendedCac)}
          note={health.noteOf("blended_cac")}
          change={changeAgainst(report.marketing.blendedCac, comparison.marketing.blendedCac)}
          status={health.statusOf("blended_cac")}
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

      <h2>Cash and stock</h2>
      <div className="grid cols-4">
        <Metric
          label="Bank balance"
          value={hasBankBalance ? gbp(cashPosition.bankBalance) : UNAVAILABLE}
          note={health.noteOf("cash_balance") ?? (hasBankBalance ? "as Xero reports it" : "no reported balance")}
          status={health.statusOf("cash_balance")}
        />
        <Metric
          label="Available cash"
          value={hasBankBalance ? gbp(cashPosition.availableCash) : UNAVAILABLE}
          note={health.noteOf("available_cash") ?? `less ${COMMITMENT_HORIZON_DAYS}-day commitments`}
          status={health.statusOf("available_cash")}
        />
        <Metric
          label="Inventory value"
          value={gbp(inventoryValue)}
          note="cash already spent, not available"
        />
        <Metric
          label="Lowest stock cover"
          value={integerDays(lowestCover(inventory))}
          note={health.noteOf("minimum_inventory_days") ?? "days on the tightest SKU"}
          status={health.statusOf("minimum_inventory_days")}
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
