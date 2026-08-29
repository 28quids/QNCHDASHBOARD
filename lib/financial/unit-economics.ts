import Decimal from "decimal.js";
import { cm1Costs, cm3Costs, zeroComponents, type AllocatedOrder, type CostComponents } from "./allocation";
import { ratio, sum, ZERO } from "./money";

/**
 * SKU-level economics, built from the same allocated orders as the P&L so that summing every
 * SKU returns the company figure. Nothing here is modelled independently of the P&L.
 */

export interface SkuUnitEconomics {
  variantId: string | null;
  sku: string | null;
  unitsSold: number;
  orders: number;
  grossSales: Decimal;
  discounts: Decimal;
  netRevenue: Decimal;
  costs: CostComponents;
  /** Contribution after product costs but before advertising. */
  contributionBeforeAds: Decimal;
  contributionMargin: Decimal | null;
  /** Contribution after variable operating costs, still before advertising. */
  contributionAfterVariableOperating: Decimal;
  revenueShare: Decimal | null;
  perUnit: {
    netSellingPrice: Decimal | null;
    productCogs: Decimal | null;
    contributionBeforeAds: Decimal | null;
  };
}

/**
 * Aggregates allocated order lines by variant.
 *
 * Advertising is deliberately absent: QNCH does not attribute media spend to a SKU, so a
 * per-SKU CM2 or CM3 would be an invented allocation rather than a measurement.
 */
export function buildSkuUnitEconomics(orders: readonly AllocatedOrder[]): SkuUnitEconomics[] {
  const byVariant = new Map<string, SkuUnitEconomics & { orderIds: Set<string> }>();

  for (const order of orders) {
    for (const line of order.lines) {
      const key = line.variantId ?? `sku:${line.sku ?? "unknown"}`;
      const entry =
        byVariant.get(key) ??
        ({
          variantId: line.variantId,
          sku: line.sku,
          unitsSold: 0,
          orders: 0,
          grossSales: ZERO,
          discounts: ZERO,
          netRevenue: ZERO,
          costs: zeroComponents(),
          contributionBeforeAds: ZERO,
          contributionMargin: null,
          contributionAfterVariableOperating: ZERO,
          revenueShare: null,
          perUnit: { netSellingPrice: null, productCogs: null, contributionBeforeAds: null },
          orderIds: new Set<string>(),
        } satisfies SkuUnitEconomics & { orderIds: Set<string> });

      entry.unitsSold += line.quantity;
      entry.grossSales = entry.grossSales.plus(line.grossSales);
      entry.discounts = entry.discounts.plus(line.discounts);
      entry.netRevenue = entry.netRevenue.plus(line.netRevenue);
      entry.costs = addInto(entry.costs, line.costs);
      entry.orderIds.add(order.externalId);
      byVariant.set(key, entry);
    }
  }

  const totalRevenue = sum([...byVariant.values()].map((entry) => entry.netRevenue));

  return [...byVariant.values()]
    .map(({ orderIds, ...entry }) => {
      const contributionBeforeAds = entry.netRevenue.minus(cm1Costs(entry.costs));
      const units = entry.unitsSold;
      return {
        ...entry,
        orders: orderIds.size,
        contributionBeforeAds,
        contributionMargin: ratio(contributionBeforeAds, entry.netRevenue),
        contributionAfterVariableOperating: contributionBeforeAds.minus(cm3Costs(entry.costs)),
        revenueShare: ratio(entry.netRevenue, totalRevenue),
        perUnit: {
          netSellingPrice: units > 0 ? entry.netRevenue.div(units) : null,
          productCogs: units > 0 ? entry.costs.productCogs.div(units) : null,
          contributionBeforeAds: units > 0 ? contributionBeforeAds.div(units) : null,
        },
      };
    })
    .sort((a, b) => b.netRevenue.comparedTo(a.netRevenue));
}

function addInto(target: CostComponents, source: CostComponents): CostComponents {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof CostComponents)[]) {
    result[key] = target[key].plus(source[key]);
  }
  return result;
}
