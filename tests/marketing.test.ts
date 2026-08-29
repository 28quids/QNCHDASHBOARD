import { describe, expect, it } from "vitest";
import { calculateMarketingPeriod, type MarketingPeriodInput } from "../lib/financial/marketing";

function marketing(overrides: Partial<MarketingPeriodInput> = {}): MarketingPeriodInput {
  return {
    netRevenue: "10000.00",
    newCustomerNetRevenue: "4000.00",
    newCustomerContributionBeforeAds: "1750.00",
    newCustomers: 50,
    contributionLevel: "cm3",
    platforms: [
      { platform: "meta", spend: "1500.00", attributedPurchases: 40, attributedPurchaseValue: "5200.00" },
      { platform: "tiktok", spend: "1000.00", attributedPurchases: 20, attributedPurchaseValue: "2400.00" },
    ],
    ...overrides,
  };
}

describe("marketing economics", () => {
  it("calculates MER from net revenue and total advertising spend", () => {
    // The brief's worked example: 10,000 revenue over 2,500 spend is 4.0x.
    expect(calculateMarketingPeriod(marketing()).mer?.toString()).toBe("4");
  });

  it("calculates blended CAC from QNCH new customers, not platform attribution", () => {
    // 2,500 spend over 50 new customers is £50.
    expect(calculateMarketingPeriod(marketing()).blendedCac?.toString()).toBe("50");
  });

  it("matches the brief's CAC example", () => {
    const result = calculateMarketingPeriod(
      marketing({ platforms: [{ platform: "meta", spend: "1000.00" }], newCustomers: 50 }),
    );
    expect(result.blendedCac?.toString()).toBe("20");
  });

  it("includes non-platform acquisition spend in blended figures", () => {
    const result = calculateMarketingPeriod(marketing({ otherAcquisitionSpend: "500.00" }));
    expect(result.advertisingSpend.toString()).toBe("3000");
    expect(result.blendedCac?.toString()).toBe("60");
  });

  it("derives maximum CAC from first-order contribution before advertising", () => {
    // 1,750 of contribution across 50 new customers is £35 available per customer.
    expect(calculateMarketingPeriod(marketing()).maximumCac?.toString()).toBe("35");
  });

  it("derives break-even ROAS from QNCH unit economics", () => {
    // Average new-customer revenue £80 over £35 maximum CAC.
    const result = calculateMarketingPeriod(marketing());
    expect(result.breakEvenRoas?.toFixed(4)).toBe("2.2857");
  });

  it("reports negative headroom when acquisition is losing money", () => {
    const result = calculateMarketingPeriod(marketing());
    // Paying £50 for a customer worth £35 of contribution.
    expect(result.cacHeadroom?.toString()).toBe("-15");
    expect(result.isAcquisitionViable).toBe(false);
  });

  it("reports positive headroom when acquisition is viable", () => {
    const result = calculateMarketingPeriod(
      marketing({ platforms: [{ platform: "meta", spend: "1000.00" }], newCustomerContributionBeforeAds: "1750.00" }),
    );
    expect(result.cacHeadroom?.toString()).toBe("15");
    expect(result.roasHeadroom?.greaterThan(0)).toBe(true);
    expect(result.isAcquisitionViable).toBe(true);
  });

  it("keeps platform-attributed figures separate from blended figures", () => {
    const result = calculateMarketingPeriod(marketing());
    const meta = result.platforms.find((platform) => platform.platform === "meta");
    expect(meta?.attributedRoas?.toFixed(4)).toBe("3.4667");
    expect(meta?.attributedCac?.toString()).toBe("37.5");
    // Platforms between them claim 60 purchases; QNCH measured 50 new customers.
    expect(result.blendedCac?.toString()).toBe("50");
  });

  it("reports platform metrics as unavailable when the platform returned no attribution", () => {
    const result = calculateMarketingPeriod(marketing({ platforms: [{ platform: "tiktok", spend: "500.00" }] }));
    expect(result.platforms[0].attributedCac).toBeNull();
    expect(result.platforms[0].attributedRoas).toBeNull();
  });

  it("returns nulls rather than dividing by zero when there is no spend or no customers", () => {
    const noSpend = calculateMarketingPeriod(marketing({ platforms: [], otherAcquisitionSpend: 0 }));
    expect(noSpend.mer).toBeNull();
    expect(noSpend.blendedCac?.toString()).toBe("0");

    const noCustomers = calculateMarketingPeriod(marketing({ newCustomers: 0 }));
    expect(noCustomers.blendedCac).toBeNull();
    expect(noCustomers.maximumCac).toBeNull();
    expect(noCustomers.breakEvenRoas).toBeNull();
    expect(noCustomers.isAcquisitionViable).toBeNull();
  });

  it("records which contribution level the break-even figures were measured at", () => {
    expect(calculateMarketingPeriod(marketing({ contributionLevel: "cm1" })).contributionLevel).toBe("cm1");
  });
});
