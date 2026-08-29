import { PolicyGate } from "../../components/policy-gate";
import { Metric } from "../../components/metric";
import { TimeframeSelector } from "../../components/timeframe-selector";
import { loadDashboard, loadFullHistory } from "@/lib/reporting/dashboard-data";
import {
  buildCustomerCohorts,
  DEFAULT_COHORT_WINDOWS,
  summariseCustomers,
} from "@/lib/financial/customers";
import { changeAgainst, count, gbp, percent, UNAVAILABLE } from "@/lib/reporting/format";

export const dynamic = "force-dynamic";

/**
 * Customer economics and realised cohorts.
 *
 * Cohorts are built from the whole order history, not the selected timeframe: a cohort is
 * defined by when a customer was acquired, so restricting it to the last 30 days would report
 * every customer as brand new.
 *
 * Revenue windows show realised revenue only, and an incomplete window is labelled rather
 * than shown as a low number — a cohort acquired last week has not had 90 days to repeat.
 */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ timeframe?: string }>;
}) {
  const load = await loadDashboard(searchParams);
  if (load.status === "not_approved") return <PolicyGate missing={load.missing} />;

  const { report, comparison, timeframe, today } = load;
  const now = summariseCustomers(report.allocated);
  const before = summariseCustomers(comparison.allocated);

  const history = await loadFullHistory(load);
  const cohorts = buildCustomerCohorts(history.allocated, today);

  return (
    <>
      <p className="eyebrow">QNCH · {timeframe.label.toUpperCase()}</p>
      <h1 className="title-sm">Customers</h1>
      <TimeframeSelector pathname="/customers" active={timeframe.key} range={timeframe.range} />

      <h2>In the period</h2>
      <div className="grid cols-4">
        <Metric
          label="New customers"
          value={count(now.newCustomers)}
          change={changeAgainst(now.newCustomers, before.newCustomers)}
        />
        <Metric
          label="Returning orders"
          value={count(now.returningOrders)}
          change={changeAgainst(now.returningOrders, before.returningOrders)}
        />
        <Metric
          label="Repeat order share"
          value={percent(now.repeatOrderShare)}
          change={changeAgainst(now.repeatOrderShare, before.repeatOrderShare)}
        />
        <Metric
          label="Orders per customer"
          value={now.ordersPerCustomer ? now.ordersPerCustomer.toFixed(2) : UNAVAILABLE}
        />
      </div>

      <div className="grid cols-4">
        <Metric label="New-customer revenue" value={gbp(now.newCustomerNetRevenue)} />
        <Metric label="Returning revenue" value={gbp(now.returningCustomerNetRevenue)} />
        <Metric label="AOV" value={gbp(now.averageOrderValue)} />
        <Metric label="New-customer AOV" value={gbp(now.newCustomerAverageOrderValue)} />
      </div>

      <section className="panel">
        <h2>Realised cohorts</h2>
        <p className="muted small" style={{ marginTop: "-0.5rem", marginBottom: "1.25rem" }}>
          Revenue actually received from each acquisition month, across the whole order
          history. No lifetime value is projected. A window still running is marked, because a
          young cohort has not had time to repeat and must not be read as underperforming.
        </p>
        <table>
          <thead>
            <tr>
              <th>Cohort</th>
              <th>Customers</th>
              <th>First-order revenue</th>
              {DEFAULT_COHORT_WINDOWS.map((days) => (
                <th key={days}>{days}-day</th>
              ))}
              <th>Revenue per customer</th>
            </tr>
          </thead>
          <tbody>
            {cohorts.map((cohort) => (
              <tr key={cohort.cohortMonth}>
                <td>{cohort.cohortMonth}</td>
                <td>{cohort.customers}</td>
                <td>{gbp(cohort.firstOrderRevenue)}</td>
                {cohort.windows.map((window) => (
                  <td key={window.days}>
                    {gbp(window.revenue)}
                    {window.isComplete ? null : (
                      <span className="muted small" title="This window has not fully elapsed">
                        {" "}
                        ·
                      </span>
                    )}
                  </td>
                ))}
                <td>{gbp(cohort.revenuePerCustomer)}</td>
              </tr>
            ))}
            {cohorts.length === 0 ? (
              <tr>
                <td colSpan={4 + DEFAULT_COHORT_WINDOWS.length} className="muted">
                  No customers acquired yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <p className="muted small" style={{ marginTop: "1rem" }}>
          · marks a window that has not fully elapsed for every customer in the cohort.
        </p>
      </section>
    </>
  );
}
