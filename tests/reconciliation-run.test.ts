import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runReconciliation } from "@/lib/reporting/reconcile";
import { collectDataQuality, persistDataQuality } from "@/lib/reporting/data-quality-run";
import { reconcileAdvertisingSpend } from "@/lib/monitoring/reconciliation";
import { normalisePayout } from "@/lib/connectors/shopify/normalise";
import { createFakeSupabase, type Row } from "./helpers/fake-supabase";

const ORGANISATION = "org-1";
const RANGE = { from: "2026-08-01", to: "2026-08-31" };
const TIMEZONE = "Europe/London";

const as = (supabase: ReturnType<typeof createFakeSupabase>["client"]) => supabase as unknown as SupabaseClient;

function seed(overrides: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    shopify_orders: [],
    shopify_payouts: [],
    ad_daily_metrics: [],
    ad_accounts: [],
    expense_mapping_rules: [],
    xero_bank_transactions: [],
    xero_bank_transaction_lines: [],
    xero_bank_balances: [],
    reconciliation_results: [],
    data_quality_results: [],
    integration_connections: [],
    business_settings: [],
    ...overrides,
  };
}

describe("normalising a payout", () => {
  const node = {
    id: "gid://shopify/ShopifyPaymentsPayout/1",
    issuedAt: "2026-08-05T09:00:00Z",
    status: "PAID",
    net: { amount: "950.00", currencyCode: "GBP" },
    summary: {
      chargesGross: { amount: "1000.00" },
      chargesFee: { amount: "30.00" },
      refundsFeeGross: { amount: "20.00" },
      refundsFee: { amount: "0.00" },
      adjustmentsGross: { amount: "0.00" },
      adjustmentsFee: { amount: "0.00" },
    },
  };

  it("dates the payout by the business day it was issued", () => {
    expect(normalisePayout(node, TIMEZONE).payoutDate).toBe("2026-08-05");
  });

  it("sums the fees across charges, refunds and adjustments", () => {
    expect(normalisePayout(node, TIMEZONE).fees).toBe("30.0000");
  });

  /**
   * A shop whose API version lacks the summary fields falls back to a document without them.
   * The net amount is always present and is what the reconciliation compares.
   */
  it("keeps the net amount when the breakdown was unavailable", () => {
    const result = normalisePayout({ ...node, summary: undefined }, TIMEZONE);

    expect(result.netAmount).toBe("950.0000");
    expect(result.charges).toBe("0.0000");
  });
});

describe("running the reconciliation", () => {
  it("records a result for every check it could run", async () => {
    const { client: supabase, tables } = createFakeSupabase(seed());

    const summary = await runReconciliation(as(supabase), {
      organisationId: ORGANISATION,
      businessTimezone: TIMEZONE,
      range: RANGE,
    });

    expect(summary.results.length).toBeGreaterThan(0);
    expect(tables.reconciliation_results.length).toBe(summary.results.length);
  });

  /**
   * "The two agree" and "one of them is missing" must never look the same. With no bank balance
   * reported at all, the check is not applicable rather than a perfect match on zero.
   */
  it("reports a missing source as not applicable rather than as a match", async () => {
    const { client: supabase } = createFakeSupabase(seed());

    const summary = await runReconciliation(as(supabase), {
      organisationId: ORGANISATION,
      businessTimezone: TIMEZONE,
      range: RANGE,
    });

    const balance = summary.results.find((result) => result.reconciliationKey === "cash.bank_balance");
    expect(balance?.status).toBe("not_applicable");
  });

  /**
   * The processor settles what the customer actually paid, VAT and shipping included. Comparing
   * a VAT-exclusive management figure against a bank figure would report the VAT as a
   * discrepancy in every period.
   */
  it("compares what customers were charged, not net revenue", async () => {
    const { client: supabase } = createFakeSupabase(
      seed({
        shopify_orders: [
          {
            id: "o-1",
            organisation_id: ORGANISATION,
            ordered_at: "2026-08-05T10:00:00Z",
            is_test: false,
            cancelled_at: null,
            gross_sales: "1000.00",
            discounts: "100.00",
            shipping_revenue: "50.00",
            tax: "190.00",
          },
        ],
        shopify_payouts: [
          {
            id: "p-1",
            organisation_id: ORGANISATION,
            payout_date: "2026-08-08",
            charges: "1140.00",
            refunds: "0.00",
            fees: "30.00",
            net_amount: "1110.00",
          },
        ],
      }),
    );

    const summary = await runReconciliation(as(supabase), {
      organisationId: ORGANISATION,
      businessTimezone: TIMEZONE,
      range: RANGE,
    });

    const payouts = summary.results.find((result) => result.reconciliationKey === "revenue.shopify_payouts");
    // 1000 - 100 + 50 + 190 = 1140, matching the payout gross of charges less refunds.
    expect(payouts?.sourceAValue?.toString()).toBe("1140");
    expect(payouts?.status).toBe("matched");
  });

  /** A payout imported without its breakdown still has a gross: its net plus its fees. */
  it("recovers a payout gross from net plus fees when the breakdown is absent", async () => {
    const { client: supabase } = createFakeSupabase(
      seed({
        shopify_payouts: [
          {
            id: "p-1",
            organisation_id: ORGANISATION,
            payout_date: "2026-08-08",
            charges: "0.00",
            refunds: "0.00",
            fees: "30.00",
            net_amount: "1110.00",
          },
        ],
      }),
    );

    const summary = await runReconciliation(as(supabase), {
      organisationId: ORGANISATION,
      businessTimezone: TIMEZONE,
      range: RANGE,
    });

    const payouts = summary.results.find((result) => result.reconciliationKey === "revenue.shopify_payouts");
    expect(payouts?.sourceBValue?.toString()).toBe("1140");
  });

  /** Re-running must restate the finding rather than appending an indistinguishable second row. */
  it("upserts a repeated run rather than duplicating the finding", async () => {
    const { client: supabase, tables } = createFakeSupabase(seed());
    const options = { organisationId: ORGANISATION, businessTimezone: TIMEZONE, range: RANGE };

    await runReconciliation(as(supabase), options);
    const afterFirst = tables.reconciliation_results.length;
    await runReconciliation(as(supabase), options);

    expect(tables.reconciliation_results.length).toBe(afterFirst);
  });
});

describe("reconciling advertising in total", () => {
  /**
   * A total that matches can still hide two platforms wrong in opposite directions, which is
   * why the per-platform checks run as well where the accounts allow it.
   */
  it("compares the platforms' claim against the ledger", () => {
    const result = reconcileAdvertisingSpend(
      [{ businessDate: "2026-08-05", amount: "1000" }],
      [{ businessDate: "2026-08-05", amount: "900" }],
      RANGE,
      50,
    );

    expect(result.status).toBe("unmatched");
    expect(result.difference?.toString()).toBe("100");
  });

  it("accepts a difference inside the tolerance as timing rather than as a finding", () => {
    const result = reconcileAdvertisingSpend(
      [{ businessDate: "2026-08-05", amount: "1000" }],
      [{ businessDate: "2026-08-05", amount: "980" }],
      RANGE,
      50,
    );

    expect(result.status).toBe("within_tolerance");
  });
});

describe("collecting data quality", () => {
  /**
   * A provider that has never been connected is a failure, not an omission. Leaving it out would
   * make a dashboard missing three of its four sources look healthy.
   */
  it("reports every provider, connected or not", async () => {
    const { client: supabase } = createFakeSupabase(seed());

    const results = await collectDataQuality(as(supabase), {
      organisationId: ORGANISATION,
      businessTimezone: TIMEZONE,
      today: "2026-08-31",
    });

    for (const provider of ["shopify", "meta", "tiktok", "xero"]) {
      expect(results.some((result) => result.checkKey === `sync_freshness.${provider}`)).toBe(true);
    }
  });

  /** A revoked Xero authorisation needs a human. No retry will clear it, so it is a failure. */
  it("treats a connection needing reauthorisation as failed, not succeeded", async () => {
    const { client: supabase } = createFakeSupabase(
      seed({
        integration_connections: [
          {
            id: "c-1",
            organisation_id: ORGANISATION,
            provider: "xero",
            status: "needs_reauth",
            last_success_at: new Date().toISOString(),
            last_attempt_at: new Date().toISOString(),
          },
        ],
      }),
    );

    const results = await collectDataQuality(as(supabase), {
      organisationId: ORGANISATION,
      businessTimezone: TIMEZONE,
      today: "2026-08-31",
    });

    expect(results.find((result) => result.checkKey === "sync_freshness.xero")?.status).toBe("fail");
  });

  /** An end-dated mapping does not cover today's spend; counting it would report a gap as covered. */
  it("ignores an expired mapping when checking coverage", async () => {
    const { client: supabase } = createFakeSupabase(
      seed({
        expense_mapping_rules: [
          { id: "r-1", organisation_id: ORGANISATION, xero_account_id: "a-1", effective_to: "2026-01-01" },
        ],
        xero_bank_transaction_lines: [
          { id: "l-1", organisation_id: ORGANISATION, xero_account_id: "a-1", line_amount: "10" },
        ],
      }),
    );

    const results = await collectDataQuality(as(supabase), {
      organisationId: ORGANISATION,
      businessTimezone: TIMEZONE,
      today: "2026-08-31",
    });

    expect(results.find((result) => result.checkKey === "xero.mapping")?.status).toBe("warn");
  });

  it("records the latest result per check rather than appending a log", async () => {
    const { client: supabase, tables } = createFakeSupabase(seed());
    const results = await collectDataQuality(as(supabase), {
      organisationId: ORGANISATION,
      businessTimezone: TIMEZONE,
      today: "2026-08-31",
    });

    await persistDataQuality(as(supabase), ORGANISATION, results);
    await persistDataQuality(as(supabase), ORGANISATION, results);

    expect(tables.data_quality_results.length).toBe(results.length);
  });
});

describe("advertising date coverage", () => {
  const today = "2026-08-31";

  const spendOn = (dates: readonly string[]): Row[] =>
    dates.map((date, index) => ({
      id: `m-${index}`,
      organisation_id: ORGANISATION,
      metric_date: date,
      entity_id: null,
      spend: "10.00",
    }));

  /**
   * A missing day of spend enters the P&L as zero, which reads as a day of free revenue. That
   * is exactly the failure the check exists to catch.
   */
  it("fails when a day of advertising is missing", async () => {
    const { client: supabase } = createFakeSupabase(
      seed({ ad_daily_metrics: spendOn(["2026-08-20", "2026-08-22"]) }),
    );

    const results = await collectDataQuality(as(supabase), {
      organisationId: ORGANISATION,
      businessTimezone: TIMEZONE,
      today,
    });

    expect(results.find((result) => result.checkKey === "advertising.coverage")?.status).toBe("fail");
  });

  /** An organisation not running ads has no gap to report. */
  it("is omitted entirely when there is no advertising at all", async () => {
    const { client: supabase } = createFakeSupabase(seed());

    const results = await collectDataQuality(as(supabase), {
      organisationId: ORGANISATION,
      businessTimezone: TIMEZONE,
      today,
    });

    expect(results.some((result) => result.checkKey === "advertising.coverage")).toBe(false);
  });

  /**
   * Platforms report with a lag of several hours, so the most recent day is legitimately absent
   * for part of every morning. Including it would make the check cry wolf daily.
   */
  it("excludes the most recent days, which the platforms have not settled yet", async () => {
    const complete: string[] = [];
    for (let offset = 30; offset >= 2; offset -= 1) {
      const date = new Date(Date.UTC(2026, 7, 31));
      date.setUTCDate(date.getUTCDate() - offset);
      complete.push(date.toISOString().slice(0, 10));
    }

    const { client: supabase } = createFakeSupabase(seed({ ad_daily_metrics: spendOn(complete) }));

    const results = await collectDataQuality(as(supabase), {
      organisationId: ORGANISATION,
      businessTimezone: TIMEZONE,
      today,
    });

    expect(results.find((result) => result.checkKey === "advertising.coverage")?.status).toBe("pass");
  });
});

describe("a source that does not exist yet", () => {
  /**
   * Zero and absent are different answers. An unconnected provider contributes no rows, and
   * totalling no rows gives zero — which reads as "this source says nothing was spent" rather
   * than "there is no source". The first sends someone looking for missing money; the second is
   * a setup step not yet done.
   */
  it("reports advertising as not applicable when no acquisition account is mapped", async () => {
    const { client: supabase } = createFakeSupabase(
      seed({
        ad_accounts: [{ id: "acct-1", organisation_id: ORGANISATION, platform: "meta", external_id: "act_1" }],
        ad_daily_metrics: [
          {
            id: "m-1",
            organisation_id: ORGANISATION,
            ad_account_id: "acct-1",
            entity_id: null,
            metric_date: "2026-08-05",
            spend: "610.65",
          },
        ],
      }),
    );

    const summary = await runReconciliation(as(supabase), {
      organisationId: ORGANISATION,
      businessTimezone: TIMEZONE,
      range: RANGE,
    });

    const total = summary.results.find((result) => result.reconciliationKey === "ad_spend.total");
    expect(total?.status).toBe("not_applicable");
    // The platform side is still reported, so the figure is visible without being called a gap.
    expect(total?.sourceAValue?.toString()).toBe("610.65");
    expect(total?.sourceBValue).toBeNull();
  });

  /** Never-synced payouts are not a period in which nothing settled. */
  it("reports settlements as not applicable when no payout has ever been imported", async () => {
    const { client: supabase } = createFakeSupabase(
      seed({
        shopify_orders: [
          {
            id: "o-1",
            organisation_id: ORGANISATION,
            ordered_at: "2026-08-05T10:00:00Z",
            is_test: false,
            cancelled_at: null,
            gross_sales: "565.80",
            discounts: "0.00",
            shipping_revenue: "0.00",
            tax: "0.00",
          },
        ],
      }),
    );

    const summary = await runReconciliation(as(supabase), {
      organisationId: ORGANISATION,
      businessTimezone: TIMEZONE,
      range: RANGE,
    });

    const payouts = summary.results.find((result) => result.reconciliationKey === "revenue.shopify_payouts");
    expect(payouts?.status).toBe("not_applicable");
  });

  /** An overall status of "needs review" is not "matched": something could not be checked. */
  it("summarises an unreconcilable check as needing review rather than as matched", async () => {
    const { client: supabase } = createFakeSupabase(seed());

    const summary = await runReconciliation(as(supabase), {
      organisationId: ORGANISATION,
      businessTimezone: TIMEZONE,
      range: RANGE,
    });

    expect(summary.status).toBe("needs_review");
  });
});
