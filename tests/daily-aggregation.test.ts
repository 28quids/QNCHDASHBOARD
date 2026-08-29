import { describe, expect, it } from "vitest";
import { buildDailyFinancials, summariseByMonth, summariseDailyFinancials, type DailySeriesInput } from "../lib/financial/daily-aggregation";
import type { AllocationContext } from "../lib/financial/allocation";
import type { FinancialPolicy } from "../lib/financial/policy";
import type { CostAssumptionRecord, OrderInput, RefundInput, VariantCostProfile } from "../lib/financial/domain";

const VARIANT = "variant-orange";

const variantCostProfiles: VariantCostProfile[] = [
  {
    variantId: VARIANT,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    productCogs: "10.00",
    packaging: 0,
    inboundFreight: 0,
    paymentProcessing: 0,
    fulfilment: 0,
    shipping: 0,
  },
];

const costAssumptions: CostAssumptionRecord[] = [
  {
    assumptionKey: "salaries",
    financialBucket: "fixed_operating",
    chargeBasis: "fixed_period",
    amount: "310.00",
    appliesTo: "all_orders",
    effectiveFrom: "2026-01-01",
    periodUnit: "month",
  },
];

const context: AllocationContext = { variantCostProfiles, costAssumptions };

const policy: FinancialPolicy = {
  refundCogsReversal: "reverse_when_restocked",
  breakEvenContributionLevel: "cm3",
  businessTimezone: "Europe/London",
  inventoryAlertWindowDays: 7,
};

function order(overrides: Partial<OrderInput> & Pick<OrderInput, "externalId" | "businessDate">): OrderInput {
  return {
    customerId: "customer-1",
    grossSales: "100.00",
    discounts: "0.00",
    shippingRevenue: "0.00",
    isNewCustomerOrder: true,
    lines: [{ externalId: `${overrides.externalId}-l1`, variantId: VARIANT, sku: "ORANGE", quantity: 1, grossSales: "100.00", discounts: "0.00" }],
    ...overrides,
  };
}

function series(overrides: Partial<DailySeriesInput> = {}): DailySeriesInput {
  return {
    range: { from: "2026-01-01", to: "2026-01-03" },
    orders: [],
    refunds: [],
    adSpend: [],
    mappedExpenses: [],
    context,
    policy,
    ...overrides,
  };
}

describe("daily financial aggregation", () => {
  it("emits a row for every date in the range, including days with no activity", () => {
    const rows = buildDailyFinancials(series({ orders: [order({ externalId: "o1", businessDate: "2026-01-02" })] }));
    expect(rows.map((row) => row.businessDate)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
    expect(rows[0].netRevenue.toString()).toBe("0");
    expect(rows[0].orders).toBe(0);
    expect(rows[1].orders).toBe(1);
  });

  it("derives net revenue from gross sales less discounts and refunds", () => {
    // The brief's worked example: 100 gross, 10 discount, 5 refund => 85 net.
    const rows = buildDailyFinancials(
      series({
        orders: [order({ externalId: "o1", businessDate: "2026-01-01", grossSales: "100.00", discounts: "10.00" })],
        refunds: [
          { externalId: "r1", orderExternalId: "o1", processedBusinessDate: "2026-01-01", amount: "5.00", restocked: false },
        ],
      }),
    );
    expect(rows[0].netRevenue.toString()).toBe("85");
  });

  it("recognises a refund on its processed date, not the original order date", () => {
    const rows = buildDailyFinancials(
      series({
        orders: [order({ externalId: "o1", businessDate: "2026-01-01" })],
        refunds: [
          { externalId: "r1", orderExternalId: "o1", processedBusinessDate: "2026-01-03", amount: "20.00", restocked: false },
        ],
      }),
    );
    expect(rows[0].netRevenue.toString()).toBe("100");
    expect(rows[2].refunds.toString()).toBe("20");
    expect(rows[2].netRevenue.toString()).toBe("-20");
  });

  it("reverses stock cost only when the refund policy says so", () => {
    const restocked: RefundInput = {
      externalId: "r1",
      orderExternalId: "o1",
      processedBusinessDate: "2026-01-01",
      amount: "100.00",
      restocked: true,
      lines: [{ variantId: VARIANT, sku: "ORANGE", quantity: 1, amount: "100.00" }],
    };
    const base = series({ orders: [order({ externalId: "o1", businessDate: "2026-01-01" })], refunds: [restocked] });

    expect(buildDailyFinancials(base)[0].costs.productCogs.toString()).toBe("0");
    expect(
      buildDailyFinancials({ ...base, policy: { ...policy, refundCogsReversal: "never_reverse" } })[0].costs.productCogs.toString(),
    ).toBe("10");
    expect(
      buildDailyFinancials({
        ...base,
        refunds: [{ ...restocked, restocked: false }],
        policy: { ...policy, refundCogsReversal: "always_reverse" },
      })[0].costs.productCogs.toString(),
    ).toBe("0");
  });

  it("warns when a refund has no original order in range instead of dropping it", () => {
    const rows = buildDailyFinancials(
      series({
        refunds: [
          {
            externalId: "r1",
            orderExternalId: "missing",
            processedBusinessDate: "2026-01-01",
            amount: "10.00",
            restocked: true,
            lines: [{ variantId: VARIANT, sku: "ORANGE", quantity: 1, amount: "10.00" }],
          },
        ],
      }),
    );
    expect(rows[0].refunds.toString()).toBe("10");
    expect(rows[0].warnings.map((warning) => warning.code)).toContain("refund_without_original_order");
  });

  it("separates Meta and TikTok spend and totals advertising", () => {
    const rows = buildDailyFinancials(
      series({
        orders: [order({ externalId: "o1", businessDate: "2026-01-01" })],
        adSpend: [
          { platform: "meta", businessDate: "2026-01-01", spend: "30.00" },
          { platform: "tiktok", businessDate: "2026-01-01", spend: "20.00" },
        ],
      }),
    );
    expect(rows[0].metaAdSpend.toString()).toBe("30");
    expect(rows[0].tiktokAdSpend.toString()).toBe("20");
    expect(rows[0].advertisingSpend.toString()).toBe("50");
    expect(rows[0].cm2.toString()).toBe("40");
  });

  it("walks revenue through CM1, CM2, CM3 and operating profit", () => {
    const rows = buildDailyFinancials(
      series({
        orders: [order({ externalId: "o1", businessDate: "2026-01-01" })],
        adSpend: [{ platform: "meta", businessDate: "2026-01-01", spend: "30.00" }],
        mappedExpenses: [{ businessDate: "2026-01-01", bucket: "cm3", amount: "5.00", category: "carrier" }],
      }),
    );
    const row = rows[0];
    expect(row.netRevenue.toString()).toBe("100");
    expect(row.cm1.toString()).toBe("90");
    expect(row.cm2.toString()).toBe("60");
    expect(row.cm3.toString()).toBe("55");
    expect(row.fixedOperatingCosts.toString()).toBe("10");
    expect(row.operatingProfit.toString()).toBe("45");
  });

  it("treats mapped acquisition costs as advertising rather than an operating cost", () => {
    const rows = buildDailyFinancials(
      series({
        orders: [order({ externalId: "o1", businessDate: "2026-01-01" })],
        mappedExpenses: [{ businessDate: "2026-01-01", bucket: "cm2", amount: "15.00", category: "affiliate" }],
      }),
    );
    expect(rows[0].otherAcquisitionSpend.toString()).toBe("15");
    expect(rows[0].advertisingSpend.toString()).toBe("15");
    expect(rows[0].cm2.toString()).toBe("75");
  });

  it("excludes cash-only costs from the P&L", () => {
    const rows = buildDailyFinancials(
      series({
        orders: [order({ externalId: "o1", businessDate: "2026-01-01" })],
        mappedExpenses: [{ businessDate: "2026-01-01", bucket: "cash_only", amount: "500.00", category: "vat" }],
      }),
    );
    expect(rows[0].operatingProfit.toString()).toBe("80");
  });

  it("reports margins as null when there is no revenue to divide by", () => {
    const rows = buildDailyFinancials(series());
    expect(rows[0].cm1Margin).toBeNull();
    expect(rows[0].operatingMargin).toBeNull();
  });

  it("counts new customers separately from total orders", () => {
    const rows = buildDailyFinancials(
      series({
        orders: [
          order({ externalId: "o1", businessDate: "2026-01-01" }),
          order({ externalId: "o2", businessDate: "2026-01-01", isNewCustomerOrder: false }),
        ],
      }),
    );
    expect(rows[0].orders).toBe(2);
    expect(rows[0].newCustomers).toBe(1);
  });

  it("surfaces missing cost profiles as a warning on the day", () => {
    const rows = buildDailyFinancials(
      series({
        orders: [
          order({
            externalId: "o1",
            businessDate: "2026-01-01",
            lines: [{ externalId: "l1", variantId: "unmapped", sku: "NEW", quantity: 1, grossSales: "100.00", discounts: "0.00" }],
          }),
        ],
      }),
    );
    expect(rows[0].warnings.map((warning) => warning.code)).toContain("missing_variant_costs");
  });
});

describe("period summaries", () => {
  const rows = buildDailyFinancials(
    series({
      range: { from: "2026-01-01", to: "2026-02-28" },
      orders: [
        order({ externalId: "o1", businessDate: "2026-01-10" }),
        order({ externalId: "o2", businessDate: "2026-01-20" }),
        order({ externalId: "o3", businessDate: "2026-02-05" }),
      ],
      adSpend: [{ platform: "meta", businessDate: "2026-01-10", spend: "25.00" }],
    }),
  );

  it("totals a series and derives AOV", () => {
    const summary = summariseDailyFinancials(rows);
    expect(summary.netRevenue.toString()).toBe("300");
    expect(summary.orders).toBe(3);
    expect(summary.averageOrderValue?.toString()).toBe("100");
    expect(summary.from).toBe("2026-01-01");
    expect(summary.to).toBe("2026-02-28");
  });

  it("reports AOV as null when there are no orders", () => {
    expect(summariseDailyFinancials([]).averageOrderValue).toBeNull();
  });

  it("splits into calendar months with the full monthly fixed cost in each", () => {
    const byMonth = summariseByMonth(rows);
    expect([...byMonth.keys()]).toEqual(["2026-01", "2026-02"]);
    expect(byMonth.get("2026-01")?.netRevenue.toString()).toBe("200");
    // 310 per month spread daily then re-summed must return the approved monthly amount.
    expect(byMonth.get("2026-01")?.fixedOperatingCosts.toString()).toBe("310");
    expect(byMonth.get("2026-02")?.fixedOperatingCosts.toString()).toBe("310");
  });
});
