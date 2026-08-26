import { describe, expect, it } from "vitest";
import { allocateOrders, type AllocationContext } from "../lib/financial/allocation";
import { buildInventoryPositions, isSnapshotStale, totalInventoryValue, unitsSoldByVariant } from "../lib/financial/inventory";
import { buildCashPosition, cashBalanceSeries, commitmentsByCategory, dailyCashFlow } from "../lib/financial/cash";
import type { OrderInput, VariantCostProfile } from "../lib/financial/domain";

const ORANGE = "variant-orange";

const variantCostProfiles: VariantCostProfile[] = [
  { variantId: ORANGE, effectiveFrom: "2026-01-01", effectiveTo: null, productCogs: "7.00", packaging: "0.50", inboundFreight: "0.50", paymentProcessing: 0, fulfilment: 0, shipping: 0 },
];

const context: AllocationContext = { variantCostProfiles, costAssumptions: [] };

/** Ten units a day for thirty days, ending on the as-of date. */
const orders = allocateOrders(
  Array.from({ length: 30 }, (_, offset) => {
    const day = String(offset + 1).padStart(2, "0");
    return {
      externalId: `o-${day}`,
      customerId: `c-${day}`,
      businessDate: `2026-06-${day}`,
      grossSales: "200.00",
      discounts: "0.00",
      shippingRevenue: "0.00",
      isNewCustomerOrder: true,
      lines: [{ externalId: `l-${day}`, variantId: ORANGE, sku: "ORANGE", quantity: 10, grossSales: "200.00", discounts: "0.00" }],
    } satisfies OrderInput;
  }),
  context,
);

describe("inventory model", () => {
  const asOf = "2026-06-30";

  it("counts units sold in a window", () => {
    expect(unitsSoldByVariant(orders, { from: "2026-06-24", to: "2026-06-30" }).get(ORANGE)).toBe(70);
    expect(unitsSoldByVariant(orders, { from: "2026-06-01", to: "2026-06-30" }).get(ORANGE)).toBe(300);
  });

  it("calculates days of stock from the approved sales window", () => {
    // The brief's worked example: 300 units at 10 a day is 30 days of cover.
    const [position] = buildInventoryPositions({
      positions: [{ variantId: ORANGE, sku: "ORANGE", availableUnits: 300 }],
      orders,
      variantCostProfiles,
      asOf,
      alertWindowDays: 7,
    });
    expect(position.averageDailySales7.toString()).toBe("10");
    expect(position.averageDailySales30.toString()).toBe("10");
    expect(position.daysOfStockRemaining?.toString()).toBe("30");
  });

  it("reports cover as unavailable when nothing is selling", () => {
    const [position] = buildInventoryPositions({
      positions: [{ variantId: ORANGE, sku: "ORANGE", availableUnits: 300 }],
      orders: [],
      variantCostProfiles,
      asOf,
      alertWindowDays: 7,
    });
    expect(position.daysOfStockRemaining).toBeNull();
    expect(position.needsReorder).toBe(false);
  });

  it("flags a reorder when cover will not outlast the supplier lead time", () => {
    const [position] = buildInventoryPositions({
      positions: [{ variantId: ORANGE, sku: "ORANGE", availableUnits: 200, supplierLeadTimeDays: 25 }],
      orders,
      variantCostProfiles,
      asOf,
      alertWindowDays: 7,
    });
    expect(position.daysOfStockRemaining?.toString()).toBe("20");
    expect(position.needsReorder).toBe(true);
  });

  it("flags a reorder when stock is at the reorder point", () => {
    const [position] = buildInventoryPositions({
      positions: [{ variantId: ORANGE, sku: "ORANGE", availableUnits: 100, reorderPointUnits: 100 }],
      orders,
      variantCostProfiles,
      asOf,
      alertWindowDays: 7,
    });
    expect(position.needsReorder).toBe(true);
  });

  it("values stock at approved landed cost", () => {
    const positions = buildInventoryPositions({
      positions: [{ variantId: ORANGE, sku: "ORANGE", availableUnits: 300, unitsOnOrder: 500 }],
      orders,
      variantCostProfiles,
      asOf,
      alertWindowDays: 7,
    });
    // 300 units at £7.00 + £0.50 + £0.50 landed.
    expect(positions[0].inventoryValue?.toString()).toBe("2400");
    expect(positions[0].unitsOnOrder.toString()).toBe("500");
    expect(totalInventoryValue(positions).value.toString()).toBe("2400");
  });

  it("refuses to value stock with no approved cost profile", () => {
    const positions = buildInventoryPositions({
      positions: [{ variantId: "unmapped", sku: "NEW", availableUnits: 100 }],
      orders,
      variantCostProfiles,
      asOf,
      alertWindowDays: 7,
    });
    expect(positions[0].inventoryValue).toBeNull();
    expect(totalInventoryValue(positions).variantsMissingCost).toEqual(["unmapped"]);
  });

  it("uses the 30-day window when that is the approved alert basis", () => {
    const recentOnly = orders.filter((order) => order.businessDate >= "2026-06-24");
    const [position] = buildInventoryPositions({
      positions: [{ variantId: ORANGE, sku: "ORANGE", availableUnits: 300 }],
      orders: recentOnly,
      variantCostProfiles,
      asOf,
      alertWindowDays: 30,
    });
    // 70 units over 30 days rather than over 7.
    expect(position.averageDailySales30.toFixed(4)).toBe("2.3333");
    expect(position.daysOfStockRemaining?.toFixed(2)).toBe("128.57");
  });

  it("treats a missing or old snapshot as stale", () => {
    const [fresh] = buildInventoryPositions({
      positions: [{ variantId: ORANGE, sku: "ORANGE", availableUnits: 10, snapshotAt: "2026-06-30T06:00:00Z" }],
      orders,
      variantCostProfiles,
      asOf,
      alertWindowDays: 7,
    });
    expect(isSnapshotStale(fresh, asOf)).toBe(false);

    const [stale] = buildInventoryPositions({
      positions: [{ variantId: ORANGE, sku: "ORANGE", availableUnits: 10, snapshotAt: "2026-06-20T06:00:00Z" }],
      orders,
      variantCostProfiles,
      asOf,
      alertWindowDays: 7,
    });
    expect(isSnapshotStale(stale, asOf)).toBe(true);
  });
});

describe("cash position", () => {
  const movements = Array.from({ length: 30 }, (_, offset) => ({
    businessDate: `2026-06-${String(offset + 1).padStart(2, "0")}`,
    amount: "-100.00",
    category: "operating",
  }));

  const base = {
    asOf: "2026-06-30",
    bankBalance: "10000.00",
    commitments: [
      { dueDate: "2026-07-05", category: "vat", amount: "2000.00" },
      { dueDate: "2026-07-20", category: "supplier", amount: "1500.00" },
      { dueDate: "2026-12-01", category: "supplier", amount: "5000.00" },
    ],
    movements,
    commitmentHorizonDays: 30,
    burnWindowDays: 30,
  };

  it("counts only commitments inside the horizon against available cash", () => {
    const position = buildCashPosition(base);
    expect(position.committedCash.toString()).toBe("3500");
    expect(position.totalCommitments.toString()).toBe("8500");
    expect(position.availableCash.toString()).toBe("6500");
  });

  it("measures burn from actual bank movements", () => {
    const position = buildCashPosition(base);
    expect(position.netCashFlow.toString()).toBe("-3000");
    expect(position.averageDailyBurn?.toString()).toBe("100");
    expect(position.runwayDays?.toString()).toBe("65");
    expect(position.projectedZeroCashDate).toBe("2026-09-03");
  });

  it("reports no runway when cash is growing", () => {
    const position = buildCashPosition({
      ...base,
      movements: movements.map((movement) => ({ ...movement, amount: "250.00" })),
    });
    expect(position.netCashFlow.toString()).toBe("7500");
    expect(position.averageDailyBurn).toBeNull();
    expect(position.runwayDays).toBeNull();
    expect(position.projectedZeroCashDate).toBeNull();
  });

  it("reports zero runway when commitments already exceed the balance", () => {
    const position = buildCashPosition({ ...base, bankBalance: "1000.00" });
    expect(position.availableCash.toString()).toBe("-2500");
    expect(position.runwayDays?.toString()).toBe("0");
  });

  it("keeps inventory value out of available cash", () => {
    const position = buildCashPosition({ ...base, inventoryValue: "2400.00" });
    expect(position.inventoryValue?.toString()).toBe("2400");
    expect(position.availableCash.toString()).toBe("6500");
  });

  it("builds a daily cash flow and running balance", () => {
    const range = { from: "2026-06-28", to: "2026-06-30" };
    expect(dailyCashFlow(movements, range).size).toBe(3);
    const series = cashBalanceSeries("1000.00", movements, range);
    expect(series.map((point) => point.balance.toString())).toEqual(["900", "800", "700"]);
  });

  it("groups commitments by category", () => {
    const byCategory = commitmentsByCategory(base.commitments);
    expect(byCategory.get("supplier")?.toString()).toBe("6500");
    expect(byCategory.get("vat")?.toString()).toBe("2000");
  });
});
