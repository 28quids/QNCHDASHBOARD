import { describe, expect, it } from "vitest";
import { allocateOrders, type AllocationContext } from "../lib/financial/allocation";
import { buildCustomerCohorts, ordersInRange, summariseAcquisition, summariseCustomers } from "../lib/financial/customers";
import { buildSkuUnitEconomics } from "../lib/financial/unit-economics";
import { sum } from "../lib/financial/money";
import type { OrderInput, VariantCostProfile } from "../lib/financial/domain";

const ORANGE = "variant-orange";
const LEMON = "variant-lemon";

const context: AllocationContext = {
  variantCostProfiles: [
    { variantId: ORANGE, effectiveFrom: "2026-01-01", effectiveTo: null, productCogs: "6.00", packaging: "1.00", inboundFreight: 0, paymentProcessing: 0, fulfilment: "2.00", shipping: 0 },
    { variantId: LEMON, effectiveFrom: "2026-01-01", effectiveTo: null, productCogs: "4.00", packaging: "1.00", inboundFreight: 0, paymentProcessing: 0, fulfilment: "2.00", shipping: 0 },
  ] satisfies VariantCostProfile[],
  costAssumptions: [],
};

function order(
  externalId: string,
  customerId: string,
  businessDate: string,
  isNewCustomerOrder: boolean,
  lines: { variantId: string; sku: string; quantity: number; grossSales: string }[],
): OrderInput {
  const grossSales = lines.reduce((total, line) => total + Number(line.grossSales), 0).toFixed(2);
  return {
    externalId,
    customerId,
    businessDate,
    grossSales,
    discounts: "0.00",
    shippingRevenue: "0.00",
    isNewCustomerOrder,
    lines: lines.map((line, index) => ({
      externalId: `${externalId}-l${index}`,
      variantId: line.variantId,
      sku: line.sku,
      quantity: line.quantity,
      grossSales: line.grossSales,
      discounts: "0.00",
    })),
  };
}

const orders = allocateOrders(
  [
    order("o1", "c1", "2026-01-05", true, [{ variantId: ORANGE, sku: "ORANGE", quantity: 2, grossSales: "40.00" }]),
    order("o2", "c1", "2026-02-10", false, [{ variantId: ORANGE, sku: "ORANGE", quantity: 1, grossSales: "20.00" }]),
    order("o3", "c2", "2026-01-20", true, [{ variantId: LEMON, sku: "LEMON", quantity: 1, grossSales: "15.00" }]),
    order("o4", "c3", "2026-02-01", true, [
      { variantId: ORANGE, sku: "ORANGE", quantity: 1, grossSales: "20.00" },
      { variantId: LEMON, sku: "LEMON", quantity: 1, grossSales: "15.00" },
    ]),
  ],
  context,
);

describe("customer economics", () => {
  it("splits new and returning revenue", () => {
    const summary = summariseCustomers(orders);
    expect(summary.orders).toBe(4);
    expect(summary.newCustomers).toBe(3);
    expect(summary.returningOrders).toBe(1);
    expect(summary.newCustomerNetRevenue.toString()).toBe("90");
    expect(summary.returningCustomerNetRevenue.toString()).toBe("20");
    expect(summary.netRevenue.toString()).toBe("110");
  });

  it("derives AOV and orders per customer", () => {
    const summary = summariseCustomers(orders);
    expect(summary.averageOrderValue?.toString()).toBe("27.5");
    expect(summary.newCustomerAverageOrderValue?.toString()).toBe("30");
    expect(summary.distinctCustomers).toBe(3);
    expect(summary.ordersPerCustomer?.toFixed(4)).toBe("1.3333");
  });

  it("reports repeat behaviour by order and by customer", () => {
    const summary = summariseCustomers(orders);
    expect(summary.repeatOrderShare?.toString()).toBe("0.25");
    expect(summary.repeatCustomerRate?.toFixed(4)).toBe("0.3333");
  });

  it("returns nulls for an empty period rather than zero-division artefacts", () => {
    const summary = summariseCustomers([]);
    expect(summary.averageOrderValue).toBeNull();
    expect(summary.ordersPerCustomer).toBeNull();
    expect(summary.repeatCustomerRate).toBeNull();
  });

  it("measures acquisition from first orders only", () => {
    const acquisition = summariseAcquisition(orders, "cm1");
    expect(acquisition.newCustomers).toBe(3);
    expect(acquisition.newCustomerNetRevenue.toString()).toBe("90");
    // 90 revenue less £31 of COGS and packaging on the 3 ORANGE and 2 LEMON units sold.
    expect(acquisition.newCustomerContributionBeforeAds.toString()).toBe("59");
  });

  it("measures acquisition contribution after variable operating costs at CM3 level", () => {
    const acquisition = summariseAcquisition(orders, "cm3");
    // The same first orders, now also less £2 per unit fulfilment across 5 units.
    expect(acquisition.newCustomerContributionBeforeAds.toString()).toBe("49");
  });

  it("restricts a summary to a reporting window", () => {
    const january = summariseCustomers(ordersInRange(orders, { from: "2026-01-01", to: "2026-01-31" }));
    expect(january.orders).toBe(2);
    expect(january.netRevenue.toString()).toBe("55");
  });
});

describe("customer cohorts", () => {
  it("groups customers by their acquisition month", () => {
    const cohorts = buildCustomerCohorts(orders, "2026-12-31", [30]);
    expect(cohorts.map((cohort) => cohort.cohortMonth)).toEqual(["2026-01", "2026-02"]);
    expect(cohorts[0].customers).toBe(2);
    expect(cohorts[1].customers).toBe(1);
  });

  it("counts realised revenue inside the window from each customer's own first order", () => {
    const cohorts = buildCustomerCohorts(orders, "2026-12-31", [30, 60]);
    const january = cohorts[0];
    expect(january.firstOrderRevenue.toString()).toBe("55");
    // c1 repeats on 10 February, 36 days after their 5 January first order.
    expect(january.windows[0].revenue.toString()).toBe("55");
    expect(january.windows[1].revenue.toString()).toBe("75");
  });

  it("marks a window incomplete when it has not elapsed for the whole cohort", () => {
    const cohorts = buildCustomerCohorts(orders, "2026-02-15", [30, 180]);
    const january = cohorts.find((cohort) => cohort.cohortMonth === "2026-01");
    // The 20 January customer has not yet had 30 days by 15 February.
    expect(january?.windows[0].isComplete).toBe(false);
    expect(january?.windows[1].isComplete).toBe(false);

    const settled = buildCustomerCohorts(orders, "2026-08-01", [30]);
    expect(settled.find((cohort) => cohort.cohortMonth === "2026-01")?.windows[0].isComplete).toBe(true);
  });

  it("reports realised revenue per customer", () => {
    const cohorts = buildCustomerCohorts(orders, "2026-12-31", [30]);
    expect(cohorts[0].revenuePerCustomer?.toString()).toBe("37.5");
  });
});

describe("SKU unit economics", () => {
  const skus = buildSkuUnitEconomics(orders);

  it("aggregates units, revenue and orders per SKU", () => {
    const orange = skus.find((sku) => sku.sku === "ORANGE");
    expect(orange?.unitsSold).toBe(4);
    expect(orange?.netRevenue.toString()).toBe("80");
    expect(orange?.orders).toBe(3);
  });

  it("sums back to the company revenue figure", () => {
    expect(sum(skus.map((sku) => sku.netRevenue)).toString()).toBe("110");
  });

  it("reports contribution before advertising and its margin", () => {
    const orange = skus.find((sku) => sku.sku === "ORANGE");
    // 80 revenue less 24 COGS and 4 packaging.
    expect(orange?.contributionBeforeAds.toString()).toBe("52");
    expect(orange?.contributionMargin?.toString()).toBe("0.65");
    // Then less £2 per unit fulfilment.
    expect(orange?.contributionAfterVariableOperating.toString()).toBe("44");
  });

  it("reports per-unit economics", () => {
    const lemon = skus.find((sku) => sku.sku === "LEMON");
    expect(lemon?.perUnit.netSellingPrice?.toString()).toBe("15");
    expect(lemon?.perUnit.productCogs?.toString()).toBe("4");
    expect(lemon?.perUnit.contributionBeforeAds?.toString()).toBe("10");
  });

  it("reports revenue share and orders SKUs by revenue", () => {
    expect(skus[0].sku).toBe("ORANGE");
    expect(sum(skus.map((sku) => sku.revenueShare ?? 0)).toString()).toBe("1");
  });

  it("returns nothing for a period with no order lines", () => {
    expect(buildSkuUnitEconomics([])).toEqual([]);
  });
});
