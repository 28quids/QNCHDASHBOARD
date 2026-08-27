import { PolicyGate } from "../../components/policy-gate";
import { TimeframeSelector } from "../../components/timeframe-selector";
import { loadDashboard } from "@/lib/reporting/dashboard-data";
import { cm3Costs } from "@/lib/financial/allocation";
import { gbp, percent, UNAVAILABLE } from "@/lib/reporting/format";

export const dynamic = "force-dynamic";

/**
 * SKU economics.
 *
 * There is deliberately no per-SKU CM2 or CM3 including advertising. QNCH does not attribute
 * media spend to a SKU, so those columns would be an allocation invented by this page rather
 * than a measurement. Reporting stops at contribution before advertising.
 */
export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ timeframe?: string }>;
}) {
  const load = await loadDashboard(searchParams);
  if (load.status === "not_approved") return <PolicyGate missing={load.missing} />;

  const { report, timeframe } = load;
  const unattributed = report.skus.filter((sku) => sku.variantId === null);

  return (
    <>
      <p className="eyebrow">QNCH · {timeframe.label.toUpperCase()}</p>
      <h1 className="title-sm">Products</h1>
      <TimeframeSelector pathname="/products" active={timeframe.key} range={timeframe.range} />

      {unattributed.length > 0 ? (
        <div className="banner">
          <h3>Some sales are not attributed to a variant</h3>
          <p className="muted">
            {unattributed.length} line group{unattributed.length === 1 ? "" : "s"} could not be
            matched to the product catalogue, so their costs are missing and their contribution
            is overstated. Re-run the catalogue sync before the order sync.
          </p>
        </div>
      ) : null}

      <section className="panel">
        <h2>Contribution by SKU</h2>
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Units</th>
              <th>Orders</th>
              <th>Net revenue</th>
              <th>Share</th>
              <th>COGS</th>
              <th>Contribution before ads</th>
              <th>Margin</th>
            </tr>
          </thead>
          <tbody>
            {report.skus.map((sku) => (
              <tr key={sku.variantId ?? sku.sku ?? "unattributed"}>
                <td>{sku.sku ?? <span className="muted">(unattributed)</span>}</td>
                <td>{sku.unitsSold}</td>
                <td>{sku.orders}</td>
                <td>{gbp(sku.netRevenue)}</td>
                <td>{percent(sku.revenueShare)}</td>
                <td>{gbp(sku.costs.productCogs)}</td>
                <td>{gbp(sku.contributionBeforeAds)}</td>
                <td>{percent(sku.contributionMargin)}</td>
              </tr>
            ))}
            {report.skus.length === 0 ? (
              <tr>
                <td colSpan={8} className="muted">
                  No sales in this period.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Unit economics</h2>
        <p className="muted small" style={{ marginTop: "-0.5rem", marginBottom: "1.25rem" }}>
          Per unit sold, averaged over the period. Discounts and shipping are already reflected
          in the net selling price.
        </p>
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Net selling price</th>
              <th>Product COGS</th>
              <th>Contribution before ads</th>
              <th>Variable operating</th>
              <th>Contribution after variable ops</th>
            </tr>
          </thead>
          <tbody>
            {report.skus.map((sku) => (
              <tr key={sku.variantId ?? sku.sku ?? "unattributed"}>
                <td>{sku.sku ?? <span className="muted">(unattributed)</span>}</td>
                <td>{gbp(sku.perUnit.netSellingPrice)}</td>
                <td>{gbp(sku.perUnit.productCogs)}</td>
                <td>{gbp(sku.perUnit.contributionBeforeAds)}</td>
                <td>
                  {sku.unitsSold > 0 ? gbp(cm3Costs(sku.costs).div(sku.unitsSold)) : UNAVAILABLE}
                </td>
                <td>
                  {sku.unitsSold > 0
                    ? gbp(sku.contributionAfterVariableOperating.div(sku.unitsSold))
                    : UNAVAILABLE}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
