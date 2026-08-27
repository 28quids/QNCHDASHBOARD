import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createReportingRepository } from "@/lib/reporting/reporting-repository";
import { buildReport } from "@/lib/reporting/report";
import { createDailyFinancialsWriter } from "@/lib/reporting/persist";
import type { FinancialPolicy } from "@/lib/financial/policy";
import { createFakeSupabase, type Row } from "./helpers/fake-supabase";

const ORGANISATION = "org-1";
const TIMEZONE = "Europe/London";

const POLICY: FinancialPolicy = {
  refundCogsReversal: "reverse_when_restocked",
  breakEvenContributionLevel: "cm3",
  businessTimezone: TIMEZONE,
  inventoryAlertWindowDays: 7,
};

const APPROVED_DECISIONS: Row[] = [
  {
    organisation_id: ORGANISATION,
    decision_key: "refund_cogs_reversal",
    decision_value: { rule: "reverse_when_restocked" },
    status: "approved",
  },
  {
    organisation_id: ORGANISATION,
    decision_key: "break_even_definition",
    decision_value: { contributionLevel: "cm3" },
    status: "approved",
  },
];

const APPROVED_SETTINGS: Row = {
  organisation_id: ORGANISATION,
  financial_policy_status: "approved",
  vat_treatment: "exclusive",
  inventory_sales_window_days: 7,
};

/** One £40 order of two units, on 2026-06-10, by a first-time customer. */
function baseSeed(overrides: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    business_settings: [APPROVED_SETTINGS],
    financial_policy_decisions: APPROVED_DECISIONS,
    variant_cost_profiles: [
      {
        organisation_id: ORGANISATION,
        variant_id: "variant-1",
        effective_from: "2026-01-01",
        effective_to: null,
        product_cogs: "7.0700",
        packaging: "0",
        inbound_freight: "0",
        payment_processing: "0",
        fulfilment: "0",
        shipping: "0",
      },
    ],
    cost_assumptions: [
      {
        organisation_id: ORGANISATION,
        assumption_key: "outbound_shipping",
        financial_bucket: "cm3",
        charge_basis: "per_order",
        amount: "2.8500",
        applies_to: "all_orders",
        effective_from: "2026-01-01",
        effective_to: null,
        period_unit: null,
      },
    ],
    shopify_customers: [
      { id: "customer-1", organisation_id: ORGANISATION, first_order_at: "2026-06-10T09:00:00.000Z" },
    ],
    shopify_orders: [
      {
        id: "order-row-1",
        organisation_id: ORGANISATION,
        external_id: "gid://shopify/Order/1",
        customer_id: "customer-1",
        ordered_at: "2026-06-10T09:00:00.000Z",
        gross_sales: "40.0000",
        discounts: "0.0000",
        shipping_revenue: "0.0000",
        is_test: false,
        cancelled_at: null,
      },
    ],
    shopify_order_lines: [
      {
        id: "line-row-1",
        organisation_id: ORGANISATION,
        order_id: "order-row-1",
        external_id: "gid://shopify/LineItem/1",
        variant_id: "variant-1",
        sku: "0001",
        quantity: 2,
        gross_sales: "40.0000",
        discounts: "0.0000",
      },
    ],
    ...overrides,
  };
}

function repositoryFor(seed: Record<string, Row[]>) {
  const { client, tables } = createFakeSupabase(seed);
  return {
    tables,
    repository: createReportingRepository(client as unknown as SupabaseClient, {
      organisationId: ORGANISATION,
      businessTimezone: TIMEZONE,
    }),
    client,
  };
}

describe("loadPolicy", () => {
  it("returns the approved policy when every required decision is recorded", async () => {
    const { repository } = repositoryFor(baseSeed());

    const result = await repository.loadPolicy();

    expect(result).toEqual({ status: "approved", policy: POLICY });
  });

  it("names the outstanding decision rather than falling back to a default", async () => {
    const { repository } = repositoryFor(
      baseSeed({
        financial_policy_decisions: APPROVED_DECISIONS.filter(
          (row) => row.decision_key !== "refund_cogs_reversal",
        ),
      }),
    );

    const result = await repository.loadPolicy();

    expect(result.status).toBe("not_approved");
    expect(result).toMatchObject({ missing: ["refund cost reversal (register item 11)"] });
  });

  it("refuses a draft policy even when every decision exists", async () => {
    const { repository } = repositoryFor(
      baseSeed({
        business_settings: [{ ...APPROVED_SETTINGS, financial_policy_status: "draft" }],
      }),
    );

    const result = await repository.loadPolicy();

    expect(result.status).toBe("not_approved");
    expect(result).toMatchObject({
      missing: ["business_settings.financial_policy_status is still draft"],
    });
  });

  it("does not treat a decision still in draft as approved", async () => {
    const { repository } = repositoryFor(
      baseSeed({
        financial_policy_decisions: APPROVED_DECISIONS.map((row) =>
          row.decision_key === "break_even_definition" ? { ...row, status: "draft" } : row,
        ),
      }),
    );

    const result = await repository.loadPolicy();

    expect(result).toMatchObject({
      status: "not_approved",
      missing: ["break-even contribution level (register item 7)"],
    });
  });
});

describe("loadFacts", () => {
  it("shapes stored orders into engine inputs with their lines attached", async () => {
    const { repository } = repositoryFor(baseSeed());

    const facts = await repository.loadFacts({ from: "2026-06-01", to: "2026-06-30" }, POLICY);

    expect(facts.orders).toHaveLength(1);
    expect(facts.orders[0]).toMatchObject({
      externalId: "gid://shopify/Order/1",
      businessDate: "2026-06-10",
      isNewCustomerOrder: true,
    });
    expect(facts.orders[0].lines).toHaveLength(1);
    expect(facts.orders[0].lines[0]).toMatchObject({ variantId: "variant-1", quantity: 2 });
  });

  it("excludes test and cancelled orders from the P&L", async () => {
    const seed = baseSeed();
    seed.shopify_orders.push(
      { ...seed.shopify_orders[0], id: "order-row-2", external_id: "test", is_test: true },
      { ...seed.shopify_orders[0], id: "order-row-3", external_id: "cancelled", cancelled_at: "2026-06-11T00:00:00.000Z" },
    );
    const { repository } = repositoryFor(seed);

    const facts = await repository.loadFacts({ from: "2026-06-01", to: "2026-06-30" }, POLICY);

    expect(facts.orders.map((order) => order.externalId)).toEqual(["gid://shopify/Order/1"]);
  });

  /**
   * The reason business dates are computed in TypeScript rather than filtered in SQL. This
   * order is 30 June in UTC but 1 July in London, and belongs to July's P&L.
   */
  it("assigns an order to its business day, not its UTC day", async () => {
    const seed = baseSeed();
    seed.shopify_orders[0].ordered_at = "2026-06-30T23:30:00.000Z";
    const { repository } = repositoryFor(seed);

    const june = await repository.loadFacts({ from: "2026-06-01", to: "2026-06-30" }, POLICY);
    const july = await repository.loadFacts({ from: "2026-07-01", to: "2026-07-31" }, POLICY);

    expect(june.orders).toHaveLength(0);
    expect(july.orders.map((order) => order.businessDate)).toEqual(["2026-07-01"]);
  });

  it("treats a repeat order as returning, using the customer's stored first-order date", async () => {
    const seed = baseSeed();
    // The customer was acquired in January; only this later order is in the window.
    seed.shopify_customers[0].first_order_at = "2026-01-05T09:00:00.000Z";
    const { repository } = repositoryFor(seed);

    const facts = await repository.loadFacts({ from: "2026-06-01", to: "2026-06-30" }, POLICY);

    expect(facts.orders[0].isNewCustomerOrder).toBe(false);
  });

  it("loads the original order behind a refund even when it falls outside the range", async () => {
    const seed = baseSeed({
      shopify_refunds: [
        {
          id: "refund-row-1",
          organisation_id: ORGANISATION,
          external_id: "gid://shopify/Refund/1",
          order_id: "order-row-1",
          processed_at: "2026-08-05T10:00:00.000Z",
          total: "24.00",
          tax: "4.00",
          restocked: true,
        },
      ],
      shopify_refund_lines: [
        {
          id: "refund-line-1",
          organisation_id: ORGANISATION,
          refund_id: "refund-row-1",
          variant_id: "variant-1",
          quantity: 1,
          subtotal: "20.00",
        },
      ],
    });
    const { repository } = repositoryFor(seed);

    // August window: the June order is outside it, but the refund needs its cost basis.
    const facts = await repository.loadFacts({ from: "2026-08-01", to: "2026-08-31" }, POLICY);

    expect(facts.refunds).toHaveLength(1);
    expect(facts.refunds[0].orderExternalId).toBe("gid://shopify/Order/1");
    expect(facts.orders.map((order) => order.externalId)).toContain("gid://shopify/Order/1");

    const report = buildReport(facts);
    // The original order is loaded for costing only; it must not add revenue to August.
    expect(report.summary.grossSales.toNumber()).toBe(0);
    expect(report.warnings.map((warning) => warning.code)).not.toContain("refund_without_original_order");
  });

  it("takes VAT off a stored refund total, which is recorded inclusive", async () => {
    const seed = baseSeed({
      shopify_refunds: [
        {
          id: "refund-row-1",
          organisation_id: ORGANISATION,
          external_id: "gid://shopify/Refund/1",
          order_id: "order-row-1",
          processed_at: "2026-06-15T10:00:00.000Z",
          total: "24.00",
          tax: "4.00",
          restocked: false,
        },
      ],
    });
    const { repository } = repositoryFor(seed);

    const facts = await repository.loadFacts({ from: "2026-06-01", to: "2026-06-30" }, POLICY);

    expect(facts.refunds[0].amount.toString()).toBe("20");
  });
});

describe("buildReport", () => {
  it("produces the contribution walk from stored facts", async () => {
    const { repository } = repositoryFor(baseSeed());
    const facts = await repository.loadFacts({ from: "2026-06-10", to: "2026-06-10" }, POLICY);

    const report = buildReport(facts);

    expect(report.daily).toHaveLength(1);
    const day = report.daily[0];
    expect(day.netRevenue.toNumber()).toBe(40);
    // Two units at £7.07.
    expect(day.costs.productCogs.toNumber()).toBeCloseTo(14.14, 2);
    expect(day.cm1.toNumber()).toBeCloseTo(25.86, 2);
    // No advertising, so CM2 equals CM1; then £2.85 shipping.
    expect(day.cm2.toNumber()).toBeCloseTo(25.86, 2);
    expect(day.cm3.toNumber()).toBeCloseTo(23.01, 2);
  });

  it("reports every date in the range, so a quiet day reads as zero rather than missing", async () => {
    const { repository } = repositoryFor(baseSeed());
    const facts = await repository.loadFacts({ from: "2026-06-09", to: "2026-06-11" }, POLICY);

    const report = buildReport(facts);

    expect(report.daily.map((row) => row.businessDate)).toEqual(["2026-06-09", "2026-06-10", "2026-06-11"]);
    expect(report.daily[0].netRevenue.toNumber()).toBe(0);
  });

  it("reports a missing cost profile once for the period, not once per day", async () => {
    const { repository } = repositoryFor(baseSeed({ variant_cost_profiles: [] }));
    const facts = await repository.loadFacts({ from: "2026-06-01", to: "2026-06-30" }, POLICY);

    const report = buildReport(facts);

    expect(report.warnings.filter((warning) => warning.code === "missing_variant_costs")).toHaveLength(1);
  });

  it("leaves CAC unavailable rather than zero when nothing was spent on advertising", async () => {
    const { repository } = repositoryFor(baseSeed());
    const facts = await repository.loadFacts({ from: "2026-06-10", to: "2026-06-10" }, POLICY);

    const report = buildReport(facts);

    expect(report.marketing.advertisingSpend.toNumber()).toBe(0);
    expect(report.marketing.mer).toBeNull();
    // One customer was acquired, so maximum CAC is knowable even with no spend.
    expect(report.marketing.blendedCac?.toNumber()).toBe(0);
    expect(report.marketing.maximumCac?.toNumber()).toBeCloseTo(23.01, 2);
  });

  it("builds SKU economics that sum back to the period revenue", async () => {
    const { repository } = repositoryFor(baseSeed());
    const facts = await repository.loadFacts({ from: "2026-06-01", to: "2026-06-30" }, POLICY);

    const report = buildReport(facts);

    expect(report.skus).toHaveLength(1);
    expect(report.skus[0].sku).toBe("0001");
    expect(report.skus[0].unitsSold).toBe(2);
    expect(report.skus[0].netRevenue.toNumber()).toBe(report.summary.netRevenue.toNumber());
  });
});

describe("publishing daily financials", () => {
  it("writes one current row per date", async () => {
    const { repository, client, tables } = repositoryFor(baseSeed());
    const facts = await repository.loadFacts({ from: "2026-06-10", to: "2026-06-11" }, POLICY);
    const writer = createDailyFinancialsWriter(client as unknown as SupabaseClient, ORGANISATION);

    const result = await writer.publish(buildReport(facts).daily, "v1");

    expect(result).toMatchObject({ version: "v1", dates: 2 });
    expect(tables.daily_financials).toHaveLength(2);
    expect(tables.daily_financials.every((row) => row.is_current)).toBe(true);
    expect(Number(tables.daily_financials[0].net_revenue)).toBe(40);
  });

  it("stands the previous version down when a period is restated", async () => {
    const { repository, client, tables } = repositoryFor(baseSeed());
    const facts = await repository.loadFacts({ from: "2026-06-10", to: "2026-06-10" }, POLICY);
    const writer = createDailyFinancialsWriter(client as unknown as SupabaseClient, ORGANISATION);
    const rows = buildReport(facts).daily;

    await writer.publish(rows, "v1");
    await writer.publish(rows, "v2");

    // Both versions retained for audit, but exactly one claims to be current.
    expect(tables.daily_financials).toHaveLength(2);
    expect(tables.daily_financials.filter((row) => row.is_current)).toHaveLength(1);
    expect(tables.daily_financials.find((row) => row.is_current)?.calculation_version).toBe("v2");
  });

  it("leaves dates outside the published window untouched", async () => {
    const { repository, client, tables } = repositoryFor(baseSeed());
    const writer = createDailyFinancialsWriter(client as unknown as SupabaseClient, ORGANISATION);

    const june = await repository.loadFacts({ from: "2026-06-09", to: "2026-06-11" }, POLICY);
    await writer.publish(buildReport(june).daily, "v1");

    const oneDay = await repository.loadFacts({ from: "2026-06-10", to: "2026-06-10" }, POLICY);
    await writer.publish(buildReport(oneDay).daily, "v2");

    expect(tables.daily_financials.filter((row) => row.is_current)).toHaveLength(3);
    const current = new Map(
      tables.daily_financials
        .filter((row) => row.is_current)
        .map((row) => [row.business_date, row.calculation_version]),
    );
    expect(current.get("2026-06-09")).toBe("v1");
    expect(current.get("2026-06-10")).toBe("v2");
    expect(current.get("2026-06-11")).toBe("v1");
  });
});
