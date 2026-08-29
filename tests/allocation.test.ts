import { describe, expect, it } from "vitest";
import { allocateOrder, allocateOrders, cm1Costs, totalComponents, type AllocationContext } from "../lib/financial/allocation";
import { dailyFixedCostsByBucket, dailyFixedPeriodAmount } from "../lib/financial/cost-resolution";
import { sum } from "../lib/financial/money";
import type { CostAssumptionRecord, OrderInput, VariantCostProfile } from "../lib/financial/domain";

const ORANGE_VARIANT = "variant-orange";
const LEMON_VARIANT = "variant-lemon";

const costProfiles: VariantCostProfile[] = [
  {
    variantId: ORANGE_VARIANT,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    productCogs: "7.07",
    packaging: "0.40",
    inboundFreight: "0.30",
    paymentProcessing: 0,
    fulfilment: 0,
    shipping: 0,
  },
  {
    variantId: LEMON_VARIANT,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    productCogs: "6.00",
    packaging: "0.40",
    inboundFreight: "0.30",
    paymentProcessing: 0,
    fulfilment: 0,
    shipping: 0,
  },
];

const assumptions: CostAssumptionRecord[] = [
  {
    assumptionKey: "outbound_shipping",
    financialBucket: "cm3",
    chargeBasis: "per_order",
    amount: "2.85",
    appliesTo: "all_orders",
    effectiveFrom: "2026-01-01",
  },
  {
    assumptionKey: "payment_processing",
    financialBucket: "cm1",
    chargeBasis: "percentage_of_revenue",
    amount: "1.75",
    appliesTo: "all_orders",
    effectiveFrom: "2026-01-01",
  },
];

const context: AllocationContext = { variantCostProfiles: costProfiles, costAssumptions: assumptions };

const singleLineOrder: OrderInput = {
  externalId: "order-1",
  customerId: "customer-1",
  businessDate: "2026-06-01",
  grossSales: "30.00",
  discounts: "3.00",
  shippingRevenue: "3.95",
  isNewCustomerOrder: true,
  lines: [
    {
      externalId: "line-1",
      variantId: ORANGE_VARIANT,
      sku: "ORANGE-30",
      quantity: 2,
      grossSales: "30.00",
      discounts: "3.00",
    },
  ],
};

describe("order allocation", () => {
  it("builds net revenue from merchandise, discounts and customer shipping", () => {
    const allocated = allocateOrder(singleLineOrder, context);
    expect(allocated.netRevenue.toString()).toBe("30.95");
    expect(allocated.shippingRevenue.toString()).toBe("3.95");
  });

  it("applies per-unit variant costs by quantity", () => {
    const { costs } = allocateOrder(singleLineOrder, context);
    expect(costs.productCogs.toString()).toBe("14.14");
    expect(costs.packaging.toString()).toBe("0.8");
    expect(costs.inboundFreight.toString()).toBe("0.6");
  });

  it("charges a per-order assumption exactly once", () => {
    const { costs } = allocateOrder(singleLineOrder, context);
    expect(costs.shipping.toString()).toBe("2.85");
  });

  it("charges percentage assumptions against net revenue including shipping", () => {
    const { costs } = allocateOrder(singleLineOrder, context);
    // 1.75% of 30.95
    expect(costs.paymentProcessing.toString()).toBe("0.541625");
  });

  it("keeps line contribution reconcilable with the order", () => {
    const allocated = allocateOrder(singleLineOrder, context);
    expect(sum(allocated.lines.map((line) => line.netRevenue)).toString()).toBe(allocated.netRevenue.toString());
    expect(sum(allocated.lines.map((line) => line.costs.shipping)).toString()).toBe(allocated.costs.shipping.toString());
  });

  it("splits order-level costs across multiple SKUs by net revenue", () => {
    const multiLine: OrderInput = {
      ...singleLineOrder,
      externalId: "order-2",
      grossSales: "40.00",
      discounts: "0.00",
      shippingRevenue: "0.00",
      lines: [
        { externalId: "l1", variantId: ORANGE_VARIANT, sku: "ORANGE-30", quantity: 1, grossSales: "30.00", discounts: "0.00" },
        { externalId: "l2", variantId: LEMON_VARIANT, sku: "LEMON-10", quantity: 1, grossSales: "10.00", discounts: "0.00" },
      ],
    };
    const allocated = allocateOrder(multiLine, context);
    expect(allocated.lines.map((line) => line.costs.shipping.toString())).toEqual(["2.14", "0.71"]);
    expect(allocated.costs.shipping.toString()).toBe("2.85");
    expect(allocated.costs.productCogs.toString()).toBe("13.07");
  });

  it("flags variants sold without an approved cost profile", () => {
    const unknownSku: OrderInput = {
      ...singleLineOrder,
      externalId: "order-3",
      lines: [{ externalId: "l1", variantId: "variant-new", sku: "NEW", quantity: 1, grossSales: "10.00", discounts: "0.00" }],
    };
    const allocated = allocateOrder(unknownSku, context);
    expect(allocated.missingCostVariantIds).toEqual(["variant-new"]);
    expect(allocated.costs.productCogs.toString()).toBe("0");
  });

  it("flags divergence between line values and the order header", () => {
    const mismatched: OrderInput = { ...singleLineOrder, externalId: "order-4", grossSales: "99.00" };
    expect(allocateOrder(mismatched, context).lineTotalsDiverge).toBe(true);
    expect(allocateOrder(singleLineOrder, context).lineTotalsDiverge).toBe(false);
  });

  it("ignores cost profiles that were not yet effective", () => {
    const earlyOrder: OrderInput = { ...singleLineOrder, businessDate: "2025-12-31" };
    const allocated = allocateOrder(earlyOrder, context);
    expect(allocated.missingCostVariantIds).toEqual([ORANGE_VARIANT]);
  });

  it("still charges order-level costs when line detail is absent", () => {
    const headerOnly: OrderInput = { ...singleLineOrder, externalId: "order-5", lines: [] };
    const allocated = allocateOrder(headerOnly, context);
    expect(allocated.lines).toEqual([]);
    expect(allocated.costs.shipping.toString()).toBe("2.85");
    expect(totalComponents(allocated.costs).greaterThan(0)).toBe(true);
  });

  it("excludes test and cancelled orders from the management P&L", () => {
    const orders: OrderInput[] = [singleLineOrder, { ...singleLineOrder, externalId: "order-test", isExcluded: true }];
    expect(allocateOrders(orders, context).map((order) => order.externalId)).toEqual(["order-1"]);
  });

  it("reports CM1 costs separately from CM3 costs", () => {
    const allocated = allocateOrder(singleLineOrder, context);
    expect(cm1Costs(allocated.costs).toString()).toBe("16.081625");
    expect(allocated.lines[0].contributionBeforeAds.toString()).toBe("14.868375");
  });
});

describe("fixed period costs", () => {
  const salary: CostAssumptionRecord = {
    assumptionKey: "salaries",
    financialBucket: "fixed_operating",
    chargeBasis: "fixed_period",
    amount: "3100.00",
    appliesTo: "all_orders",
    effectiveFrom: "2026-01-01",
    periodUnit: "month",
  };

  it("spreads a monthly cost across the true length of that month", () => {
    expect(dailyFixedPeriodAmount(salary, "2026-01-15").toString()).toBe("100");
    expect(dailyFixedPeriodAmount({ ...salary, amount: "2800.00" }, "2026-02-10").toString()).toBe("100");
  });

  it("handles leap years", () => {
    const yearly: CostAssumptionRecord = { ...salary, amount: "366.00", periodUnit: "year" };
    expect(dailyFixedPeriodAmount(yearly, "2024-05-01").toString()).toBe("1");
    expect(dailyFixedPeriodAmount({ ...yearly, amount: "365.00" }, "2026-05-01").toString()).toBe("1");
  });

  it("totals daily fixed costs by bucket", () => {
    const buckets = dailyFixedCostsByBucket([salary, { ...salary, assumptionKey: "software", amount: "310.00" }], "2026-01-15");
    expect(buckets.get("fixed_operating")?.toString()).toBe("110");
  });

  it("excludes assumptions that have expired", () => {
    const expired: CostAssumptionRecord = { ...salary, effectiveTo: "2026-01-31" };
    expect(dailyFixedCostsByBucket([expired], "2026-02-15").size).toBe(0);
  });
});
