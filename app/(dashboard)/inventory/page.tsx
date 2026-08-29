import { PolicyGate } from "../../components/policy-gate";
import { Metric } from "../../components/metric";
import { loadDashboard, loadFullHistory } from "@/lib/reporting/dashboard-data";
import { createOperationsRepository } from "@/lib/reporting/operations-repository";
import { createReportingRepository } from "@/lib/reporting/reporting-repository";
import {
  buildInventoryPositions,
  isSnapshotStale,
  totalInventoryValue,
} from "@/lib/financial/inventory";
import { count, gbp, integerDays, relativeTime, UNAVAILABLE } from "@/lib/reporting/format";

export const dynamic = "force-dynamic";

/**
 * Stock cover measured against QNCH's own sales.
 *
 * Both the 7- and 30-day run rates are shown, as approved policy asks, but cover and the
 * reorder flag are evaluated on the 7-day window that policy nominated for alerting. A
 * variant with no approved cost profile shows no inventory value rather than a value of zero.
 */
export default async function InventoryPage() {
  const load = await loadDashboard();
  if (load.status === "not_approved") return <PolicyGate missing={load.missing} />;

  const { session, policy, today } = load;
  const operations = createOperationsRepository(session.client, session.organisationId);
  const reporting = createReportingRepository(session.client, {
    organisationId: session.organisationId,
    businessTimezone: session.businessTimezone,
  });

  // Cover is measured against recent trading, which is not the selected timeframe.
  const [positions, history, context] = await Promise.all([
    operations.loadInventoryPositions(today),
    loadFullHistory(load),
    reporting.loadAllocationContext(),
  ]);

  const inventory = buildInventoryPositions({
    positions,
    orders: history.allocated,
    variantCostProfiles: context.variantCostProfiles,
    asOf: today,
    alertWindowDays: policy.inventoryAlertWindowDays,
  });

  const { value, variantsMissingCost } = totalInventoryValue(inventory);
  const needingReorder = inventory.filter((position) => position.needsReorder);
  const stale = inventory.filter((position) => isSnapshotStale(position, today));

  return (
    <>
      <p className="eyebrow">QNCH · AS AT {today}</p>
      <h1 className="title-sm">Inventory</h1>

      {stale.length > 0 ? (
        <div className="banner">
          <h3>Stock figures are not current</h3>
          <p className="muted">
            {stale.length} of {inventory.length} variant{inventory.length === 1 ? "" : "s"} have a
            snapshot older than a day. Cover below is calculated from stock that may already
            have moved. Re-run the Shopify catalogue sync.
          </p>
        </div>
      ) : null}

      <div className="grid cols-4">
        <Metric label="Variants tracked" value={count(inventory.length)} />
        <Metric
          label="Needing reorder"
          value={count(needingReorder.length)}
          status={needingReorder.length > 0 ? "red" : "green"}
          higherIsWorse
        />
        <Metric
          label="Inventory value"
          value={variantsMissingCost.length === inventory.length ? UNAVAILABLE : gbp(value)}
          note="cash held as stock"
        />
        <Metric
          label="Alert window"
          value={`${policy.inventoryAlertWindowDays} days`}
          note="approved basis for cover"
        />
      </div>

      <section className="panel">
        <h2>Stock position</h2>
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Available</th>
              <th>On order</th>
              <th>Sold 7d</th>
              <th>Sold 30d</th>
              <th>Daily rate 7d</th>
              <th>Daily rate 30d</th>
              <th>Cover</th>
              <th>Value</th>
              <th>Snapshot</th>
            </tr>
          </thead>
          <tbody>
            {inventory.map((position) => (
              <tr key={position.variantId}>
                <td>
                  {position.sku ?? <span className="muted">(no sku)</span>}
                  {position.needsReorder ? (
                    <span className="pill status-red" style={{ marginLeft: "0.5rem" }}>
                      reorder
                    </span>
                  ) : null}
                </td>
                <td>{position.availableUnits.toFixed(0)}</td>
                <td>{position.unitsOnOrder.toFixed(0)}</td>
                <td>{position.unitsSoldLast7Days}</td>
                <td>{position.unitsSoldLast30Days}</td>
                <td>{position.averageDailySales7.toFixed(2)}</td>
                <td>{position.averageDailySales30.toFixed(2)}</td>
                <td>{integerDays(position.daysOfStockRemaining)}</td>
                <td>{gbp(position.inventoryValue)}</td>
                <td>{relativeTime(position.snapshotAt)}</td>
              </tr>
            ))}
            {inventory.length === 0 ? (
              <tr>
                <td colSpan={10} className="muted">
                  No inventory snapshots. Run the Shopify catalogue sync.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>

        {variantsMissingCost.length > 0 ? (
          <p className="muted small" style={{ marginTop: "1.25rem" }}>
            {variantsMissingCost.length} variant{variantsMissingCost.length === 1 ? " has" : "s have"}{" "}
            no approved cost profile, so their stock is excluded from the inventory value above
            rather than valued at zero.
          </p>
        ) : null}
      </section>
    </>
  );
}
