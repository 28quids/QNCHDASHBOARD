import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { activeAlerts, evaluateMetric, evaluateMetrics, overallStatus, type MetricTarget } from "../lib/monitoring/targets";
import {
  checkDateCoverage,
  checkExpenseMappingCoverage,
  checkFinancialPolicyApproved,
  checkSyncFreshness,
  checkVariantCostCoverage,
  summariseDataQuality,
  type SyncState,
} from "../lib/monitoring/data-quality";
import {
  reconcile,
  reconcileBankBalance,
  reconcilePlatformSpend,
  reconcileShopifyPayouts,
  summariseReconciliation,
} from "../lib/monitoring/reconciliation";
import type { VariantCostProfile } from "../lib/financial/domain";

const targets: MetricTarget[] = [
  { metricKey: "blended_cac", targetValue: "35.00", comparison: "lte", severity: "amber", effectiveFrom: "2026-01-01" },
  { metricKey: "blended_cac", targetValue: "50.00", comparison: "lte", severity: "red", effectiveFrom: "2026-01-01" },
  { metricKey: "cm3_margin", targetValue: "0.20", comparison: "gte", severity: "red", effectiveFrom: "2026-01-01" },
];

describe("target evaluation", () => {
  it("passes a metric inside every threshold", () => {
    expect(evaluateMetric("blended_cac", new Decimal("30"), targets, "2026-06-01").status).toBe("green");
  });

  it("raises the configured severity when a threshold is breached", () => {
    expect(evaluateMetric("blended_cac", new Decimal("40"), targets, "2026-06-01").status).toBe("amber");
  });

  it("reports the most severe breach when several thresholds fail", () => {
    const evaluation = evaluateMetric("blended_cac", new Decimal("60"), targets, "2026-06-01");
    expect(evaluation.status).toBe("red");
    expect(evaluation.breachedTarget?.targetValue).toBe("50.00");
  });

  it("handles a minimum-style target", () => {
    expect(evaluateMetric("cm3_margin", new Decimal("0.10"), targets, "2026-06-01").status).toBe("red");
    expect(evaluateMetric("cm3_margin", new Decimal("0.25"), targets, "2026-06-01").status).toBe("green");
  });

  it("never reports a missing value as healthy", () => {
    const evaluation = evaluateMetric("blended_cac", null, targets, "2026-06-01");
    expect(evaluation.status).toBe("unavailable");
    expect(evaluation.message).toMatch(/could not be calculated/);
  });

  it("makes no judgement when no target is configured", () => {
    const evaluation = evaluateMetric("mer", new Decimal("1.2"), targets, "2026-06-01");
    expect(evaluation.status).toBe("green");
    expect(evaluation.message).toMatch(/no configured target/);
  });

  it("ignores targets that are not yet effective", () => {
    expect(evaluateMetric("blended_cac", new Decimal("60"), targets, "2025-06-01").status).toBe("green");
  });

  it("summarises many metrics into one status and an ordered alert list", () => {
    const evaluations = evaluateMetrics(
      new Map([
        ["blended_cac", new Decimal("40")],
        ["cm3_margin", new Decimal("0.05")],
        ["mer", null],
      ]),
      targets,
      "2026-06-01",
    );
    expect(overallStatus(evaluations)).toBe("red");
    expect(activeAlerts(evaluations).map((alert) => alert.status)).toEqual(["red", "unavailable", "amber"]);
  });
});

describe("data quality", () => {
  const now = new Date("2026-06-30T08:00:00Z");

  it("passes a connector that synced recently", () => {
    const states: SyncState[] = [{ provider: "shopify", lastSuccessAt: "2026-06-30T06:00:00Z", lastAttemptAt: "2026-06-30T06:00:00Z", lastStatus: "succeeded" }];
    expect(checkSyncFreshness(states, now, 24)[0].status).toBe("pass");
  });

  it("fails a connector whose last run failed, and shows the last success", () => {
    const states: SyncState[] = [{ provider: "meta", lastSuccessAt: "2026-06-29T06:00:00Z", lastAttemptAt: "2026-06-30T06:00:00Z", lastStatus: "failed" }];
    const result = checkSyncFreshness(states, now, 24)[0];
    expect(result.status).toBe("fail");
    expect(result.message).toContain("2026-06-29T06:00:00Z");
  });

  it("warns when data is older than the freshness window", () => {
    const states: SyncState[] = [{ provider: "xero", lastSuccessAt: "2026-06-27T06:00:00Z", lastAttemptAt: "2026-06-27T06:00:00Z", lastStatus: "succeeded" }];
    expect(checkSyncFreshness(states, now, 24)[0].status).toBe("warn");
  });

  it("fails a connector that has never succeeded", () => {
    const states: SyncState[] = [{ provider: "tiktok", lastSuccessAt: null, lastAttemptAt: null, lastStatus: null }];
    expect(checkSyncFreshness(states, now, 24)[0].status).toBe("fail");
  });

  it("detects missing dates rather than treating them as zero", () => {
    const range = { from: "2026-06-01", to: "2026-06-05" };
    expect(checkDateCoverage("ads.coverage", ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"], range).status).toBe("pass");
    const gap = checkDateCoverage("ads.coverage", ["2026-06-01", "2026-06-05"], range);
    expect(gap.status).toBe("fail");
    expect(gap.observed?.missingCount).toBe(3);
  });

  it("detects variants sold without an approved cost", () => {
    const profiles: VariantCostProfile[] = [
      { variantId: "a", effectiveFrom: "2026-01-01", effectiveTo: null, productCogs: "1", packaging: 0, inboundFreight: 0, paymentProcessing: 0, fulfilment: 0, shipping: 0 },
    ];
    expect(checkVariantCostCoverage(["a"], profiles, "2026-06-01").status).toBe("pass");
    expect(checkVariantCostCoverage(["a", "b"], profiles, "2026-06-01").observed?.unmapped).toEqual(["b"]);
  });

  it("warns about unmapped Xero accounts with activity", () => {
    expect(checkExpenseMappingCoverage(["acc-1"], ["acc-1"]).status).toBe("pass");
    expect(checkExpenseMappingCoverage(["acc-1", "acc-2"], ["acc-1"]).status).toBe("warn");
  });

  it("treats a draft financial policy as a blocking failure", () => {
    expect(checkFinancialPolicyApproved("draft").status).toBe("fail");
    expect(checkFinancialPolicyApproved("approved").status).toBe("pass");
  });

  it("marks the dashboard untrustworthy while any check fails", () => {
    const summary = summariseDataQuality([checkFinancialPolicyApproved("draft"), checkExpenseMappingCoverage(["a"], ["a"])]);
    expect(summary.status).toBe("fail");
    expect(summary.severity).toBe("red");
    expect(summary.isTrustworthy).toBe(false);
    expect(summary.failing).toHaveLength(1);
  });

  it("is trustworthy only when everything passes", () => {
    expect(summariseDataQuality([checkFinancialPolicyApproved("approved")]).isTrustworthy).toBe(true);
  });
});

describe("reconciliation", () => {
  const period = { from: "2026-06-01", to: "2026-06-30" };

  it("matches identical sources", () => {
    const result = reconcile({
      reconciliationKey: "test",
      period,
      sourceA: { label: "A", value: "100.00" },
      sourceB: { label: "B", value: "100.00" },
    });
    expect(result.status).toBe("matched");
    expect(result.difference?.toString()).toBe("0");
  });

  it("accepts a difference inside tolerance without hiding it", () => {
    const result = reconcile({
      reconciliationKey: "test",
      period,
      sourceA: { label: "A", value: "100.00" },
      sourceB: { label: "B", value: "99.50" },
      tolerance: "1.00",
    });
    expect(result.status).toBe("within_tolerance");
    expect(result.difference?.toString()).toBe("0.5");
  });

  it("reports an unmatched difference rather than forcing a match", () => {
    const result = reconcile({
      reconciliationKey: "test",
      period,
      sourceA: { label: "Shopify", value: "1000.00" },
      sourceB: { label: "Xero", value: "900.00" },
      tolerance: "10.00",
    });
    expect(result.status).toBe("unmatched");
    expect(result.difference?.toString()).toBe("100");
    expect(result.differenceRate?.toString()).toBe("0.1");
    expect(result.message).toContain("difference 100");
  });

  it("declines to reconcile when a source is unavailable", () => {
    const result = reconcile({
      reconciliationKey: "test",
      period,
      sourceA: { label: "A", value: "100.00" },
      sourceB: { label: "B", value: null },
    });
    expect(result.status).toBe("not_applicable");
    expect(result.difference).toBeNull();
  });

  it("reconciles platform spend against the accounting record for the period only", () => {
    const result = reconcilePlatformSpend(
      "meta",
      [
        { businessDate: "2026-06-10", amount: "500.00" },
        { businessDate: "2026-07-01", amount: "999.00" },
      ],
      [{ businessDate: "2026-06-12", amount: "500.00" }],
      period,
      "5.00",
    );
    expect(result.status).toBe("matched");
    expect(result.sourceAValue?.toString()).toBe("500");
  });

  it("reconciles Shopify revenue against settlements", () => {
    const result = reconcileShopifyPayouts(
      [{ businessDate: "2026-06-10", amount: "1000.00" }],
      [{ businessDate: "2026-06-13", amount: "970.00" }],
      period,
      "10.00",
    );
    expect(result.status).toBe("unmatched");
    expect(result.difference?.toString()).toBe("30");
  });

  it("reconciles the bank balance", () => {
    expect(reconcileBankBalance("5000.00", "5000.00", period).status).toBe("matched");
    expect(reconcileBankBalance(null, "5000.00", period).status).toBe("not_applicable");
  });

  it("summarises many checks and totals the unexplained difference", () => {
    const summary = summariseReconciliation([
      reconcile({ reconciliationKey: "a", period, sourceA: { label: "A", value: "100" }, sourceB: { label: "B", value: "80" } }),
      reconcile({ reconciliationKey: "b", period, sourceA: { label: "A", value: "50" }, sourceB: { label: "B", value: "65" } }),
      reconcile({ reconciliationKey: "c", period, sourceA: { label: "A", value: "10" }, sourceB: { label: "B", value: "10" } }),
    ]);
    expect(summary.status).toBe("unmatched");
    expect(summary.unmatched).toHaveLength(2);
    expect(summary.totalUnmatchedDifference.toString()).toBe("35");
  });

  it("needs review when a source was unavailable but nothing conflicts", () => {
    const summary = summariseReconciliation([
      reconcile({ reconciliationKey: "a", period, sourceA: { label: "A", value: null }, sourceB: { label: "B", value: "80" } }),
    ]);
    expect(summary.status).toBe("needs_review");
  });
});
