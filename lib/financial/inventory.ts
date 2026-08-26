import Decimal from "decimal.js";
import type { AllocatedOrder } from "./allocation";
import { resolveVariantUnitCosts } from "./cost-resolution";
import { daysBetween, rangeEndingOn, type DateRange } from "./dates";
import { money, ZERO, type DecimalInput } from "./money";
import type { VariantCostProfile } from "./domain";

/**
 * Stock cover measured against QNCH's own sales, not a supplier forecast.
 *
 * Inventory value is reported so that cash tied up in stock is visible next to the bank
 * balance; it is never added to the cash position.
 */

export interface VariantInventoryInput {
  variantId: string;
  sku: string | null;
  availableUnits: DecimalInput;
  unitsOnOrder?: DecimalInput;
  expectedDeliveryDate?: string | null;
  reorderPointUnits?: DecimalInput | null;
  supplierLeadTimeDays?: number | null;
  snapshotAt?: string | null;
}

export interface InventoryPosition {
  variantId: string;
  sku: string | null;
  availableUnits: Decimal;
  unitsOnOrder: Decimal;
  unitsSoldLast7Days: number;
  unitsSoldLast30Days: number;
  averageDailySales7: Decimal;
  averageDailySales30: Decimal;
  /** Days of cover on the sales window QNCH approved for alerting. Null when nothing is selling. */
  daysOfStockRemaining: Decimal | null;
  alertWindowDays: number;
  reorderPointUnits: Decimal | null;
  supplierLeadTimeDays: number | null;
  expectedDeliveryDate: string | null;
  /** True when stock will not survive the supplier lead time, or is under the reorder point. */
  needsReorder: boolean;
  /** Null when the variant has no approved cost profile, rather than valuing stock at zero. */
  inventoryValue: Decimal | null;
  snapshotAt: string | null;
}

export function unitsSoldByVariant(orders: readonly AllocatedOrder[], range: DateRange): Map<string, number> {
  const units = new Map<string, number>();
  for (const order of orders) {
    if (order.businessDate < range.from || order.businessDate > range.to) continue;
    for (const line of order.lines) {
      if (!line.variantId) continue;
      units.set(line.variantId, (units.get(line.variantId) ?? 0) + line.quantity);
    }
  }
  return units;
}

export interface InventoryModelInput {
  positions: readonly VariantInventoryInput[];
  orders: readonly AllocatedOrder[];
  variantCostProfiles: readonly VariantCostProfile[];
  asOf: string;
  /** Sales window used for the primary stock-out alert, from approved policy. */
  alertWindowDays: number;
}

export function buildInventoryPositions(input: InventoryModelInput): InventoryPosition[] {
  const last7 = rangeEndingOn(input.asOf, 7);
  const last30 = rangeEndingOn(input.asOf, 30);
  const sold7 = unitsSoldByVariant(input.orders, last7);
  const sold30 = unitsSoldByVariant(input.orders, last30);
  const unitCosts = resolveVariantUnitCosts(input.variantCostProfiles, input.asOf);

  return input.positions
    .map((position) => {
      const availableUnits = money(position.availableUnits);
      const unitsSoldLast7Days = sold7.get(position.variantId) ?? 0;
      const unitsSoldLast30Days = sold30.get(position.variantId) ?? 0;
      const averageDailySales7 = new Decimal(unitsSoldLast7Days).div(7);
      const averageDailySales30 = new Decimal(unitsSoldLast30Days).div(30);

      const alertRate = input.alertWindowDays === 30 ? averageDailySales30 : averageDailySales7;
      const daysOfStockRemaining = alertRate.isZero() ? null : availableUnits.div(alertRate);

      const reorderPointUnits = position.reorderPointUnits == null ? null : money(position.reorderPointUnits);
      const leadTime = position.supplierLeadTimeDays ?? null;
      const landedCost = unitCosts.get(position.variantId);

      return {
        variantId: position.variantId,
        sku: position.sku,
        availableUnits,
        unitsOnOrder: money(position.unitsOnOrder ?? 0),
        unitsSoldLast7Days,
        unitsSoldLast30Days,
        averageDailySales7,
        averageDailySales30,
        daysOfStockRemaining,
        alertWindowDays: input.alertWindowDays,
        reorderPointUnits,
        supplierLeadTimeDays: leadTime,
        expectedDeliveryDate: position.expectedDeliveryDate ?? null,
        needsReorder: isReorderNeeded(availableUnits, reorderPointUnits, daysOfStockRemaining, leadTime),
        inventoryValue: landedCost
          ? availableUnits.times(landedCost.productCogs.plus(landedCost.packaging).plus(landedCost.inboundFreight))
          : null,
        snapshotAt: position.snapshotAt ?? null,
      };
    })
    .sort(compareByUrgency);
}

function isReorderNeeded(
  availableUnits: Decimal,
  reorderPointUnits: Decimal | null,
  daysOfStockRemaining: Decimal | null,
  supplierLeadTimeDays: number | null,
): boolean {
  if (reorderPointUnits && availableUnits.lessThanOrEqualTo(reorderPointUnits)) return true;
  if (daysOfStockRemaining && supplierLeadTimeDays !== null) {
    return daysOfStockRemaining.lessThanOrEqualTo(supplierLeadTimeDays);
  }
  return false;
}

/** Lowest cover first, so the variant closest to a stock-out heads the list. */
function compareByUrgency(a: InventoryPosition, b: InventoryPosition): number {
  if (a.daysOfStockRemaining === null) return b.daysOfStockRemaining === null ? 0 : 1;
  if (b.daysOfStockRemaining === null) return -1;
  return a.daysOfStockRemaining.comparedTo(b.daysOfStockRemaining);
}

/** Total cash currently held as stock. Reported beside cash, never inside it. */
export function totalInventoryValue(positions: readonly InventoryPosition[]): {
  value: Decimal;
  variantsMissingCost: string[];
} {
  let value = ZERO;
  const variantsMissingCost: string[] = [];
  for (const position of positions) {
    if (position.inventoryValue) value = value.plus(position.inventoryValue);
    else variantsMissingCost.push(position.variantId);
  }
  return { value, variantsMissingCost };
}

/** Flags a stock snapshot that is too old to be trusted on today's dashboard. */
export function isSnapshotStale(position: InventoryPosition, asOf: string, maximumAgeDays = 1): boolean {
  if (!position.snapshotAt) return true;
  return daysBetween(position.snapshotAt.slice(0, 10), asOf) > maximumAgeDays;
}
