import Decimal from "decimal.js";
import { addComponents, allocateOrders, cm1Costs, cm3Costs, zeroComponents, type AllocatedOrder, type AllocationContext, type CostComponents } from "./allocation";
import { componentForAssumption, dailyFixedCostsByBucket, resolveAssumptions, resolveVariantUnitCosts } from "./cost-resolution";
import { enumerateDates, type DateRange } from "./dates";
import { ratio, sum, ZERO } from "./money";
import { shouldReverseCogs, type FinancialPolicy } from "./policy";
import type { AdSpendInput, MappedExpenseInput, OrderInput, RefundInput } from "./domain";

export type DailyWarningCode =
  | "missing_variant_costs"
  | "line_totals_diverge"
  | "duplicated_cost_source"
  | "refund_without_original_order";

export interface DailyWarning {
  code: DailyWarningCode;
  detail: string;
}

export interface DailyFinancialRow {
  businessDate: string;
  grossSales: Decimal;
  discounts: Decimal;
  shippingRevenue: Decimal;
  refunds: Decimal;
  netRevenue: Decimal;
  costs: CostComponents;
  cm1: Decimal;
  cm1Margin: Decimal | null;
  metaAdSpend: Decimal;
  tiktokAdSpend: Decimal;
  otherAcquisitionSpend: Decimal;
  advertisingSpend: Decimal;
  cm2: Decimal;
  cm2Margin: Decimal | null;
  cm3: Decimal;
  cm3Margin: Decimal | null;
  fixedOperatingCosts: Decimal;
  operatingProfit: Decimal;
  operatingMargin: Decimal | null;
  orders: number;
  newCustomers: number;
  warnings: DailyWarning[];
}

export interface DailySeriesInput {
  range: DateRange;
  orders: readonly OrderInput[];
  refunds: readonly RefundInput[];
  adSpend: readonly AdSpendInput[];
  /** Costs taken from mapped Xero accounts. Additive to assumptions, never a replacement. */
  mappedExpenses: readonly MappedExpenseInput[];
  context: AllocationContext;
  policy: FinancialPolicy;
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(item);
    else grouped.set(key, [item]);
  }
  return grouped;
}

/**
 * Builds one row per date in the range, including days with no activity, so that a gap in
 * the data is visibly zero rather than silently absent from a chart.
 */
export function buildDailyFinancials(input: DailySeriesInput): DailyFinancialRow[] {
  const allocated = allocateOrders(input.orders, input.context);
  const ordersByDate = groupBy(allocated, (order) => order.businessDate);
  const orderDatesById = new Map(allocated.map((order) => [order.externalId, order.businessDate]));
  const refundsByDate = groupBy(input.refunds, (refund) => refund.processedBusinessDate);
  const adSpendByDate = groupBy(input.adSpend, (spend) => spend.businessDate);
  const expensesByDate = groupBy(input.mappedExpenses, (expense) => expense.businessDate);

  return enumerateDates(input.range.from, input.range.to).map((businessDate) =>
    buildDailyRow({
      businessDate,
      orders: ordersByDate.get(businessDate) ?? [],
      refunds: refundsByDate.get(businessDate) ?? [],
      adSpend: adSpendByDate.get(businessDate) ?? [],
      mappedExpenses: expensesByDate.get(businessDate) ?? [],
      orderDatesById,
      input,
    }),
  );
}

interface DailyRowInput {
  businessDate: string;
  orders: readonly AllocatedOrder[];
  refunds: readonly RefundInput[];
  adSpend: readonly AdSpendInput[];
  mappedExpenses: readonly MappedExpenseInput[];
  orderDatesById: ReadonlyMap<string, string>;
  input: DailySeriesInput;
}

function buildDailyRow(rowInput: DailyRowInput): DailyFinancialRow {
  const { businessDate, orders, refunds, adSpend, mappedExpenses, orderDatesById, input } = rowInput;
  const warnings: DailyWarning[] = [];

  const grossSales = sum(orders.map((order) => order.grossSales));
  const discounts = sum(orders.map((order) => order.discounts));
  const shippingRevenue = sum(orders.map((order) => order.shippingRevenue));
  const refundTotal = sum(refunds.map((refund) => refund.amount));
  const netRevenue = grossSales.minus(discounts).plus(shippingRevenue).minus(refundTotal);

  let costs = orders.reduce((total, order) => addComponents(total, order.costs), zeroComponents());
  costs = applyRefundCogsReversal(costs, refunds, orderDatesById, input, warnings);
  costs = applyMappedExpenses(costs, mappedExpenses, businessDate, input, warnings);

  collectOrderWarnings(orders, warnings);

  const cm1 = netRevenue.minus(cm1Costs(costs));
  const metaAdSpend = sum(adSpend.filter((spend) => spend.platform === "meta").map((spend) => spend.spend));
  const tiktokAdSpend = sum(adSpend.filter((spend) => spend.platform === "tiktok").map((spend) => spend.spend));
  const otherAcquisitionSpend = sum(
    mappedExpenses.filter((expense) => expense.bucket === "cm2").map((expense) => expense.amount),
  );
  const advertisingSpend = metaAdSpend.plus(tiktokAdSpend).plus(otherAcquisitionSpend);

  const cm2 = cm1.minus(advertisingSpend);
  const cm3 = cm2.minus(cm3Costs(costs));
  const fixedOperatingCosts = resolveFixedOperatingCosts(mappedExpenses, businessDate, input);
  const operatingProfit = cm3.minus(fixedOperatingCosts);

  return {
    businessDate,
    grossSales,
    discounts,
    shippingRevenue,
    refunds: refundTotal,
    netRevenue,
    costs,
    cm1,
    cm1Margin: ratio(cm1, netRevenue),
    metaAdSpend,
    tiktokAdSpend,
    otherAcquisitionSpend,
    advertisingSpend,
    cm2,
    cm2Margin: ratio(cm2, netRevenue),
    cm3,
    cm3Margin: ratio(cm3, netRevenue),
    fixedOperatingCosts,
    operatingProfit,
    operatingMargin: ratio(operatingProfit, netRevenue),
    orders: orders.length,
    newCustomers: orders.filter((order) => order.isNewCustomerOrder).length,
    warnings,
  };
}

/**
 * Reverses the stock value of refunded units, costed at the profile in force on the original
 * order date so the reversal matches the cost originally recognised.
 */
function applyRefundCogsReversal(
  costs: CostComponents,
  refunds: readonly RefundInput[],
  orderDatesById: ReadonlyMap<string, string>,
  input: DailySeriesInput,
  warnings: DailyWarning[],
): CostComponents {
  let reversal = ZERO;

  for (const refund of refunds) {
    if (!shouldReverseCogs(input.policy, refund.restocked)) continue;

    const originalDate = orderDatesById.get(refund.orderExternalId);
    if (!originalDate) {
      warnings.push({
        code: "refund_without_original_order",
        detail: `Refund ${refund.externalId} references order ${refund.orderExternalId}, which is not in range`,
      });
      continue;
    }

    const unitCosts = resolveVariantUnitCosts(input.context.variantCostProfiles, originalDate);
    for (const line of refund.lines ?? []) {
      const variantCosts = line.variantId ? unitCosts.get(line.variantId) : undefined;
      if (variantCosts) reversal = reversal.plus(variantCosts.productCogs.times(line.quantity));
    }
  }

  if (reversal.isZero()) return costs;
  const adjusted = { ...costs };
  adjusted.productCogs = adjusted.productCogs.minus(reversal);
  return adjusted;
}

/**
 * Adds mapped Xero costs to the same named lines the assumptions feed. When both sources
 * target one line on the same day the figure is still reported in full and flagged, because
 * silently dropping either source would hide a real cost.
 */
function applyMappedExpenses(
  costs: CostComponents,
  expenses: readonly MappedExpenseInput[],
  businessDate: string,
  input: DailySeriesInput,
  warnings: DailyWarning[],
): CostComponents {
  const adjusted = { ...costs };
  const assumptionComponents = new Set(
    resolveAssumptions(input.context.costAssumptions, businessDate)
      .orderLevel.map(componentForAssumption)
      .filter((component): component is NonNullable<typeof component> => component !== null),
  );

  for (const expense of expenses) {
    if (expense.bucket === "cm2" || expense.bucket === "fixed_operating" || expense.bucket === "cash_only") continue;

    const component = expense.bucket === "cm1" ? "otherVariableProductCosts" : "otherVariableOperatingCosts";
    adjusted[component] = adjusted[component].plus(expense.amount);

    if (assumptionComponents.has(component)) {
      warnings.push({
        code: "duplicated_cost_source",
        detail: `${expense.category} is charged by both an assumption and a mapped Xero account on ${businessDate}`,
      });
    }
  }

  return adjusted;
}

function resolveFixedOperatingCosts(
  expenses: readonly MappedExpenseInput[],
  businessDate: string,
  input: DailySeriesInput,
): Decimal {
  const fromAssumptions = dailyFixedCostsByBucket(input.context.costAssumptions, businessDate).get("fixed_operating") ?? ZERO;
  const fromXero = sum(expenses.filter((expense) => expense.bucket === "fixed_operating").map((expense) => expense.amount));
  return fromAssumptions.plus(fromXero);
}

function collectOrderWarnings(orders: readonly AllocatedOrder[], warnings: DailyWarning[]): void {
  const missingVariants = new Set(orders.flatMap((order) => order.missingCostVariantIds));
  if (missingVariants.size > 0) {
    warnings.push({
      code: "missing_variant_costs",
      detail: `No approved cost profile for variants: ${[...missingVariants].join(", ")}`,
    });
  }

  const diverging = orders.filter((order) => order.lineTotalsDiverge).map((order) => order.externalId);
  if (diverging.length > 0) {
    warnings.push({ code: "line_totals_diverge", detail: `Line totals do not match the header for: ${diverging.join(", ")}` });
  }
}

/** Sums a daily series into a single period total, for a dashboard timeframe or a monthly P&L. */
export function summariseDailyFinancials(rows: readonly DailyFinancialRow[]) {
  const netRevenue = sum(rows.map((row) => row.netRevenue));
  const advertisingSpend = sum(rows.map((row) => row.advertisingSpend));
  const cm1 = sum(rows.map((row) => row.cm1));
  const cm2 = sum(rows.map((row) => row.cm2));
  const cm3 = sum(rows.map((row) => row.cm3));
  const operatingProfit = sum(rows.map((row) => row.operatingProfit));
  const orders = rows.reduce((total, row) => total + row.orders, 0);
  const newCustomers = rows.reduce((total, row) => total + row.newCustomers, 0);

  return {
    from: rows.at(0)?.businessDate ?? null,
    to: rows.at(-1)?.businessDate ?? null,
    grossSales: sum(rows.map((row) => row.grossSales)),
    discounts: sum(rows.map((row) => row.discounts)),
    shippingRevenue: sum(rows.map((row) => row.shippingRevenue)),
    refunds: sum(rows.map((row) => row.refunds)),
    netRevenue,
    cm1,
    cm1Margin: ratio(cm1, netRevenue),
    metaAdSpend: sum(rows.map((row) => row.metaAdSpend)),
    tiktokAdSpend: sum(rows.map((row) => row.tiktokAdSpend)),
    advertisingSpend,
    cm2,
    cm2Margin: ratio(cm2, netRevenue),
    cm3,
    cm3Margin: ratio(cm3, netRevenue),
    fixedOperatingCosts: sum(rows.map((row) => row.fixedOperatingCosts)),
    operatingProfit,
    operatingMargin: ratio(operatingProfit, netRevenue),
    orders,
    newCustomers,
    averageOrderValue: orders > 0 ? netRevenue.div(orders) : null,
    warnings: rows.flatMap((row) => row.warnings),
  };
}

export type DailyFinancialSummary = ReturnType<typeof summariseDailyFinancials>;

/** Recomputes a summary's money fields from an explicit list, used by the monthly P&L view. */
export function summariseByMonth(rows: readonly DailyFinancialRow[]): Map<string, DailyFinancialSummary> {
  const byMonth = groupBy(rows, (row) => row.businessDate.slice(0, 7));
  return new Map([...byMonth].map(([month, monthRows]) => [month, summariseDailyFinancials(monthRows)]));
}
