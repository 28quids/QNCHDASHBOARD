import { describe, expect, it } from "vitest";
import { calculateBreakEvenEconomics, calculateDailyFinancials, calculateInventoryDays } from "../lib/financial/calculations";

describe("financial calculations", () => {
  it("calculates net revenue and CM1 through operating profit", () => {
    const result = calculateDailyFinancials({
      grossSales: 100,
      discounts: 10,
      refundsAndReturns: 5,
      productCogs: 25,
      packaging: 5,
      inboundFreight: 2,
      paymentProcessing: 3,
      otherVariableProductCosts: 0,
      metaAdSpend: 20,
      tikTokAdSpend: 10,
      otherAcquisitionSpend: 0,
      fulfilment: 4,
      shipping: 6,
      shopifyAndVariableApps: 1,
      otherVariableOperatingCosts: 0,
      fixedOperatingCosts: 5,
      newCustomers: 2,
    });

    expect(result.netRevenue.toString()).toBe("85");
    expect(result.cm1.toString()).toBe("50");
    expect(result.cm2.toString()).toBe("20");
    expect(result.cm3.toString()).toBe("9");
    expect(result.operatingProfit.toString()).toBe("4");
    expect(result.blendedCac?.toString()).toBe("15");
    expect(result.mer?.toString()).toBe("2.833333333333333333333333333");
  });

  it("returns unavailable ratios when their denominators are zero", () => {
    const result = calculateDailyFinancials({
      grossSales: 0, discounts: 0, refundsAndReturns: 0, productCogs: 0, packaging: 0,
      inboundFreight: 0, paymentProcessing: 0, otherVariableProductCosts: 0, metaAdSpend: 0,
      tikTokAdSpend: 0, otherAcquisitionSpend: 0, fulfilment: 0, shipping: 0,
      shopifyAndVariableApps: 0, otherVariableOperatingCosts: 0, fixedOperatingCosts: 0,
    });
    expect(result.mer).toBeNull();
    expect(result.cm1Margin).toBeNull();
    expect(result.blendedCac).toBeNull();
  });

  it("calculates break-even CAC from approved contribution and customer basis", () => {
    const result = calculateBreakEvenEconomics({
      approvedContribution: 500,
      eligibleNewCustomers: 25,
      averageNewCustomerNetRevenue: 80,
      contributionLevel: "cm3",
    });
    expect(result.maximumCac?.toString()).toBe("20");
    expect(result.breakEvenRoas?.toString()).toBe("4");
  });

  it("calculates inventory days without manufacturing a value for zero sales", () => {
    expect(calculateInventoryDays(300, 10)?.toString()).toBe("30");
    expect(calculateInventoryDays(300, 0)).toBeNull();
  });
});
