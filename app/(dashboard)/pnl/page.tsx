import { PolicyGate } from "../../components/policy-gate";
import { TimeframeSelector } from "../../components/timeframe-selector";
import { loadDashboard } from "@/lib/reporting/dashboard-data";
import type Decimal from "decimal.js";
import { summariseByMonth } from "@/lib/financial/daily-aggregation";
import { addComponents, cm3Costs, zeroComponents } from "@/lib/financial/allocation";
import { formatDate, gbp, percent } from "@/lib/reporting/format";

export const dynamic = "force-dynamic";

/**
 * The contribution walk in full, and the same figures by month.
 *
 * Cost lines are itemised rather than rolled into a single "costs" figure, because the whole
 * point of the CM1/CM2/CM3 split is being able to see which cost moved.
 */
export default async function ProfitAndLossPage({
  searchParams,
}: {
  searchParams: Promise<{ timeframe?: string }>;
}) {
  const load = await loadDashboard(searchParams);
  if (load.status === "not_approved") return <PolicyGate missing={load.missing} />;

  const { report, timeframe } = load;
  const summary = report.summary;
  const costs = report.daily.reduce((total, row) => addComponents(total, row.costs), zeroComponents());

  const byMonth = [...summariseByMonth(report.daily)].sort(([a], [b]) => a.localeCompare(b));

  return (
    <>
      <p className="eyebrow">QNCH · {timeframe.label.toUpperCase()}</p>
      <h1 className="title-sm">Profit &amp; loss</h1>
      <TimeframeSelector pathname="/pnl" active={timeframe.key} range={timeframe.range} />

      <section className="panel">
        <h2>Contribution walk</h2>
        <table>
          <tbody>
            <Row label="Gross sales" value={summary.grossSales} />
            <Row label="Discounts" value={summary.discounts} negate indent />
            <Row label="Shipping charged to customers" value={summary.shippingRevenue} indent />
            <Row label="Refunds" value={summary.refunds} negate indent />
            <Row label="Net revenue" value={summary.netRevenue} className="subtotal" />

            <Row label="Product COGS" value={costs.productCogs} negate indent />
            <Row label="Packaging" value={costs.packaging} negate indent />
            <Row label="Inbound freight" value={costs.inboundFreight} negate indent />
            <Row label="Payment processing" value={costs.paymentProcessing} negate indent />
            <Row label="Other variable product" value={costs.otherVariableProductCosts} negate indent />
            <Row label="CM1" value={summary.cm1} margin={summary.cm1Margin} className="subtotal" />

            <Row label="Meta" value={summary.metaAdSpend} negate indent />
            <Row label="TikTok" value={summary.tiktokAdSpend} negate indent />
            <Row
              label="Other acquisition"
              value={summary.advertisingSpend.minus(summary.metaAdSpend).minus(summary.tiktokAdSpend)}
              negate
              indent
            />
            <Row label="CM2" value={summary.cm2} margin={summary.cm2Margin} className="subtotal" />

            <Row label="Fulfilment" value={costs.fulfilment} negate indent />
            <Row label="Carrier shipping" value={costs.shipping} negate indent />
            <Row label="Shopify and variable apps" value={costs.shopifyAndVariableApps} negate indent />
            <Row label="Other variable operating" value={costs.otherVariableOperatingCosts} negate indent />
            <Row label="CM3" value={summary.cm3} margin={summary.cm3Margin} className="subtotal" />

            <Row label="Fixed operating costs" value={summary.fixedOperatingCosts} negate indent />
            <Row
              label="Operating profit"
              value={summary.operatingProfit}
              margin={summary.operatingMargin}
              className="total"
            />
          </tbody>
        </table>

        {summary.fixedOperatingCosts.isZero() ? (
          <p className="muted small" style={{ marginTop: "1.25rem" }}>
            No fixed operating costs are configured for this period, so operating profit equals
            CM3. Record them as assumptions or map Xero accounts before reading this line as
            net profit.
          </p>
        ) : null}
      </section>

      <section className="panel">
        <h2>By month</h2>
        <table>
          <thead>
            <tr>
              <th>Month</th>
              <th>Net revenue</th>
              <th>CM1</th>
              <th>CM2</th>
              <th>CM3</th>
              <th>CM3 %</th>
              <th>Orders</th>
              <th>New customers</th>
            </tr>
          </thead>
          <tbody>
            {byMonth.map(([month, values]) => (
              <tr key={month}>
                <td>{month}</td>
                <td>{gbp(values.netRevenue)}</td>
                <td>{gbp(values.cm1)}</td>
                <td>{gbp(values.cm2)}</td>
                <td>{gbp(values.cm3)}</td>
                <td>{percent(values.cm3Margin)}</td>
                <td>{values.orders}</td>
                <td>{values.newCustomers}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>By day</h2>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Net revenue</th>
              <th>COGS</th>
              <th>CM1</th>
              <th>Ad spend</th>
              <th>CM2</th>
              <th>Variable ops</th>
              <th>CM3</th>
              <th>Orders</th>
            </tr>
          </thead>
          <tbody>
            {report.daily.map((row) => (
              <tr key={row.businessDate}>
                <td>{formatDate(row.businessDate)}</td>
                <td>{gbp(row.netRevenue)}</td>
                <td>{gbp(row.costs.productCogs)}</td>
                <td>{gbp(row.cm1)}</td>
                <td>{gbp(row.advertisingSpend)}</td>
                <td>{gbp(row.cm2)}</td>
                <td>{gbp(cm3Costs(row.costs))}</td>
                <td>{gbp(row.cm3)}</td>
                <td>{row.orders}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

/** `negate` renders a cost as the negative it is in the walk, without storing it that way. */
function Row({
  label,
  value,
  margin,
  negate,
  indent,
  className,
}: {
  label: string;
  value: Decimal;
  margin?: Decimal | null;
  negate?: boolean;
  indent?: boolean;
  className?: string;
}) {
  return (
    <tr className={className}>
      <td className={indent ? "indent" : undefined}>{label}</td>
      <td>{gbp(negate ? value.negated() : value)}</td>
      <td>{margin === undefined ? "" : percent(margin)}</td>
    </tr>
  );
}
