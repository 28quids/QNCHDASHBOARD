import Decimal from "decimal.js";
import { allocateProportionally, money, sum, ZERO } from "./money";
import {
  assumptionMatchesLine,
  componentForAssumption,
  resolveAssumptions,
  resolveVariantUnitCosts,
  ZERO_UNIT_COSTS,
  type NamedCostComponent,
  type ResolvedVariantUnitCosts,
} from "./cost-resolution";
import type { CostAssumptionRecord, OrderInput, OrderLineInput, VariantCostProfile } from "./domain";

export type CostComponents = Record<NamedCostComponent, Decimal>;

const COMPONENT_KEYS: NamedCostComponent[] = [
  "productCogs",
  "packaging",
  "inboundFreight",
  "paymentProcessing",
  "otherVariableProductCosts",
  "fulfilment",
  "shipping",
  "shopifyAndVariableApps",
  "otherVariableOperatingCosts",
];

const CM1_COMPONENTS: NamedCostComponent[] = [
  "productCogs",
  "packaging",
  "inboundFreight",
  "paymentProcessing",
  "otherVariableProductCosts",
];

export function zeroComponents(): CostComponents {
  return Object.fromEntries(COMPONENT_KEYS.map((key) => [key, ZERO])) as CostComponents;
}

export function addComponents(target: CostComponents, source: CostComponents): CostComponents {
  const total = zeroComponents();
  for (const key of COMPONENT_KEYS) total[key] = target[key].plus(source[key]);
  return total;
}

export function totalComponents(components: CostComponents): Decimal {
  return sum(COMPONENT_KEYS.map((key) => components[key]));
}

export function cm1Costs(components: CostComponents): Decimal {
  return sum(CM1_COMPONENTS.map((key) => components[key]));
}

/** Variable operating costs charged between CM2 and CM3. */
export function cm3Costs(components: CostComponents): Decimal {
  return sum(COMPONENT_KEYS.filter((key) => !CM1_COMPONENTS.includes(key)).map((key) => components[key]));
}

export interface AllocatedLine {
  externalId: string;
  variantId: string | null;
  sku: string | null;
  quantity: number;
  grossSales: Decimal;
  discounts: Decimal;
  /** Share of customer-paid shipping attributed to this line, weighted by net merchandise value. */
  allocatedShippingRevenue: Decimal;
  netRevenue: Decimal;
  costs: CostComponents;
  /** Contribution before advertising, i.e. the CM1 share earned by this line. */
  contributionBeforeAds: Decimal;
}

export interface AllocatedOrder {
  externalId: string;
  customerId: string | null;
  businessDate: string;
  isNewCustomerOrder: boolean;
  grossSales: Decimal;
  discounts: Decimal;
  shippingRevenue: Decimal;
  netRevenue: Decimal;
  costs: CostComponents;
  lines: AllocatedLine[];
  /** Variants sold without an approved cost profile. Surfaced as a data-quality failure. */
  missingCostVariantIds: string[];
  /**
   * Lines with no variant at all, usually because the product no longer exists in the
   * catalogue. They carry revenue but can never carry a cost, so they inflate margin. Counted
   * separately from `missingCostVariantIds`, which is a variant that could be costed but has
   * not been — a fixable problem, where this one may not be.
   */
  unattributedLines: number;
  /** True when line values do not sum to the order header. Reported, never silently corrected. */
  lineTotalsDiverge: boolean;
}

export interface AllocationContext {
  variantCostProfiles: readonly VariantCostProfile[];
  costAssumptions: readonly CostAssumptionRecord[];
}

function unitCostsToComponents(unitCosts: ResolvedVariantUnitCosts, quantity: number): CostComponents {
  const components = zeroComponents();
  components.productCogs = unitCosts.productCogs.times(quantity);
  components.packaging = unitCosts.packaging.times(quantity);
  components.inboundFreight = unitCosts.inboundFreight.times(quantity);
  components.paymentProcessing = unitCosts.paymentProcessing.times(quantity);
  components.fulfilment = unitCosts.fulfilment.times(quantity);
  components.shipping = unitCosts.shipping.times(quantity);
  return components;
}

function lineNetMerchandise(line: OrderLineInput): Decimal {
  return money(line.grossSales).minus(line.discounts);
}

/**
 * Turns one order into per-line revenue and cost components.
 *
 * Order-level assumptions are spread across lines by net revenue so that SKU contribution
 * always adds back to the order figure. The order header remains authoritative for revenue;
 * a mismatch against the lines is flagged rather than reconciled away.
 */
export function allocateOrder(order: OrderInput, context: AllocationContext): AllocatedOrder {
  const { orderLevel } = resolveAssumptions(context.costAssumptions, order.businessDate);
  const unitCosts = resolveVariantUnitCosts(context.variantCostProfiles, order.businessDate);

  const grossSales = money(order.grossSales);
  const discounts = money(order.discounts);
  const shippingRevenue = money(order.shippingRevenue);
  const netRevenue = grossSales.minus(discounts).plus(shippingRevenue);

  const merchandisePerLine = order.lines.map(lineNetMerchandise);
  const shippingPerLine = order.lines.length > 0 ? allocateProportionally(shippingRevenue, merchandisePerLine) : [];
  const netRevenuePerLine = merchandisePerLine.map((value, index) => value.plus(shippingPerLine[index]));

  const lines: AllocatedLine[] = order.lines.map((line, index) => {
    const costs = unitCostsToComponents(unitCosts.get(line.variantId ?? "") ?? ZERO_UNIT_COSTS, line.quantity);
    return {
      externalId: line.externalId,
      variantId: line.variantId,
      sku: line.sku,
      quantity: line.quantity,
      grossSales: money(line.grossSales),
      discounts: money(line.discounts),
      allocatedShippingRevenue: shippingPerLine[index],
      netRevenue: netRevenuePerLine[index],
      costs,
      contributionBeforeAds: ZERO,
    };
  });

  applyOrderLevelAssumptions(order, orderLevel, lines, netRevenuePerLine);

  const orderCosts =
    lines.length > 0
      ? lines.reduce((total, line) => addComponents(total, line.costs), zeroComponents())
      : orderCostsWithoutLines(order, orderLevel, netRevenue);

  for (const line of lines) {
    line.contributionBeforeAds = line.netRevenue.minus(cm1Costs(line.costs));
  }

  const missingCostVariantIds = [
    ...new Set(order.lines.filter((line) => line.variantId && !unitCosts.has(line.variantId)).map((line) => line.variantId as string)),
  ];

  return {
    externalId: order.externalId,
    customerId: order.customerId,
    businessDate: order.businessDate,
    isNewCustomerOrder: order.isNewCustomerOrder,
    grossSales,
    discounts,
    shippingRevenue,
    netRevenue,
    costs: orderCosts,
    lines,
    missingCostVariantIds,
    unattributedLines: order.lines.filter((line) => line.variantId === null).length,
    lineTotalsDiverge:
      order.lines.length > 0 && !sum(merchandisePerLine).equals(grossSales.minus(discounts)),
  };
}

function applyOrderLevelAssumptions(
  order: OrderInput,
  assumptions: readonly CostAssumptionRecord[],
  lines: AllocatedLine[],
  netRevenuePerLine: readonly Decimal[],
): void {
  if (lines.length === 0) return;

  for (const assumption of assumptions) {
    const component = componentForAssumption(assumption);
    if (!component) continue;

    const matching = order.lines.map((line) => assumptionMatchesLine(assumption, line));
    if (!matching.some(Boolean)) continue;

    const amount = money(assumption.amount);
    switch (assumption.chargeBasis) {
      case "per_order": {
        // Charged once for the order, then shared over the lines it applies to.
        const weights = netRevenuePerLine.map((value, index) => (matching[index] ? value : ZERO));
        const shares = allocateProportionally(amount, weights);
        lines.forEach((line, index) => {
          if (matching[index]) line.costs[component] = line.costs[component].plus(shares[index]);
        });
        break;
      }
      case "per_unit": {
        lines.forEach((line, index) => {
          if (matching[index]) line.costs[component] = line.costs[component].plus(amount.times(line.quantity));
        });
        break;
      }
      case "percentage_of_revenue": {
        const rate = amount.div(100);
        lines.forEach((line, index) => {
          if (matching[index]) line.costs[component] = line.costs[component].plus(line.netRevenue.times(rate));
        });
        break;
      }
      case "fixed_period":
        break;
    }
  }
}

/** Orders without line detail still carry their order-level costs, charged against the header. */
function orderCostsWithoutLines(
  order: OrderInput,
  assumptions: readonly CostAssumptionRecord[],
  netRevenue: Decimal,
): CostComponents {
  const costs = zeroComponents();
  for (const assumption of assumptions) {
    const component = componentForAssumption(assumption);
    if (!component || assumption.appliesTo !== "all_orders") continue;

    const amount = money(assumption.amount);
    if (assumption.chargeBasis === "per_order") {
      costs[component] = costs[component].plus(amount);
    } else if (assumption.chargeBasis === "percentage_of_revenue") {
      costs[component] = costs[component].plus(netRevenue.times(amount.div(100)));
    }
  }
  return costs;
}

/**
 * Contribution an order generated before any advertising was deducted, at the given level.
 * This is the figure that determines how much QNCH can afford to pay to acquire the order.
 */
export function contributionBeforeAds(order: AllocatedOrder, level: "cm1" | "cm3"): Decimal {
  const costs = level === "cm1" ? cm1Costs(order.costs) : cm1Costs(order.costs).plus(cm3Costs(order.costs));
  return order.netRevenue.minus(costs);
}

/** Excluded orders (test, cancelled) never reach the management P&L. */
export function allocateOrders(orders: readonly OrderInput[], context: AllocationContext): AllocatedOrder[] {
  return orders.filter((order) => !order.isExcluded).map((order) => allocateOrder(order, context));
}
