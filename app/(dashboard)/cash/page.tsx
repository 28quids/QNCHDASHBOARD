import { PolicyGate } from "../../components/policy-gate";
import { Metric } from "../../components/metric";
import { TrendChart } from "../../components/chart";
import { loadDashboard, loadFullHistory } from "@/lib/reporting/dashboard-data";
import { createOperationsRepository } from "@/lib/reporting/operations-repository";
import { createReportingRepository } from "@/lib/reporting/reporting-repository";
import { buildCashPosition, cashBalanceSeries, commitmentsByCategory } from "@/lib/financial/cash";
import { buildInventoryPositions, totalInventoryValue } from "@/lib/financial/inventory";
import { rangeEndingOn } from "@/lib/financial/dates";
import { formatDate, gbp, integerDays, UNAVAILABLE } from "@/lib/reporting/format";

export const dynamic = "force-dynamic";

const BURN_WINDOW_DAYS = 90;
const COMMITMENT_HORIZON_DAYS = 30;

/**
 * Cash, kept strictly separate from profit.
 *
 * Operating profit is not shown on this page at all, and inventory value is reported beside
 * the balance rather than inside it. Stock is cash that has already been spent; treating the
 * two as interchangeable is the specific error the brief asks the system to prevent.
 */
export default async function CashPage() {
  const load = await loadDashboard();
  if (load.status === "not_approved") return <PolicyGate missing={load.missing} />;

  const { session, policy, today } = load;
  const operations = createOperationsRepository(session.client, session.organisationId);
  const reporting = createReportingRepository(session.client, {
    organisationId: session.organisationId,
    businessTimezone: session.businessTimezone,
  });

  const burnWindow = rangeEndingOn(today, BURN_WINDOW_DAYS);
  const [cash, positions, history, context] = await Promise.all([
    operations.loadCash(burnWindow),
    operations.loadInventoryPositions(today),
    loadFullHistory(load),
    reporting.loadAllocationContext(),
  ]);

  const inventoryValue = totalInventoryValue(
    buildInventoryPositions({
      positions,
      orders: history.allocated,
      variantCostProfiles: context.variantCostProfiles,
      asOf: today,
      alertWindowDays: policy.inventoryAlertWindowDays,
    }),
  ).value;

  const connected = cash.bankBalance !== null;

  const position = buildCashPosition({
    asOf: today,
    bankBalance: cash.bankBalance ?? 0,
    commitments: cash.commitments,
    movements: cash.movements,
    commitmentHorizonDays: COMMITMENT_HORIZON_DAYS,
    burnWindowDays: BURN_WINDOW_DAYS,
    inventoryValue,
  });

  const balanceSeries = cashBalanceSeries(0, cash.movements, burnWindow).map((point) => ({
    date: point.businessDate,
    value: point.balance.toNumber(),
  }));

  return (
    <>
      <p className="eyebrow">QNCH · AS AT {today}</p>
      <h1 className="title-sm">Cash</h1>

      {!connected ? (
        <div className="banner red">
          <h3>Xero is not connected</h3>
          <p className="muted">
            No bank account is available, so the cash position cannot be reported. The figures
            below would be a running total of imported transactions, which is not a reconciled
            balance — so they are withheld rather than shown as if they were.
          </p>
          <p className="muted">
            Inventory value is still shown, because it comes from Shopify stock and approved
            costs. It is cash already spent, not cash available.
          </p>
        </div>
      ) : null}

      <div className="grid cols-4">
        <Metric
          label="Bank balance"
          value={connected ? gbp(position.bankBalance) : UNAVAILABLE}
          note={connected ? "reconciled" : "Xero not connected"}
        />
        <Metric
          label="Available cash"
          value={connected ? gbp(position.availableCash) : UNAVAILABLE}
          note={`less commitments due in ${COMMITMENT_HORIZON_DAYS} days`}
        />
        <Metric
          label="Committed"
          value={gbp(position.committedCash)}
          note={`${position.upcomingCommitments.length} due`}
          higherIsWorse
        />
        <Metric
          label="Runway"
          value={connected ? integerDays(position.runwayDays) : UNAVAILABLE}
          note={
            connected && position.averageDailyBurn === null
              ? "cash positive over the window"
              : `at ${gbp(position.averageDailyBurn)}/day`
          }
        />
      </div>

      <div className="grid cols-3">
        <Metric
          label="Inventory value"
          value={gbp(position.inventoryValue)}
          note="cash converted into stock"
        />
        <Metric
          label={`Net cash flow (${BURN_WINDOW_DAYS}d)`}
          value={connected ? gbp(position.netCashFlow) : UNAVAILABLE}
        />
        <Metric
          label="Projected zero cash"
          value={position.projectedZeroCashDate ? formatDate(position.projectedZeroCashDate) : UNAVAILABLE}
        />
      </div>

      <section className="panel">
        <h2>Commitments</h2>
        <table>
          <thead>
            <tr>
              <th>Category</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {[...commitmentsByCategory(cash.commitments)].map(([category, amount]) => (
              <tr key={category}>
                <td>{category}</td>
                <td>{gbp(amount)}</td>
              </tr>
            ))}
            {cash.commitments.length === 0 ? (
              <tr>
                <td colSpan={2} className="muted">
                  No commitments recorded. Supplier bills arrive with the Xero connector;
                  anything else can be entered manually.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      {connected ? (
        <section className="panel">
          <h2>Cumulative cash movement</h2>
          <p className="muted small" style={{ marginTop: "-0.5rem", marginBottom: "1.25rem" }}>
            Movement over the burn window, starting from zero. This is the shape of the change,
            not the account balance.
          </p>
          <TrendChart series={balanceSeries} variant="line" label="Cumulative cash movement" />
        </section>
      ) : null}
    </>
  );
}
