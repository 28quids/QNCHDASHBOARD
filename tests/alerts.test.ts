import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { assessHealth, buildObservations, lowestCover, metricLabel } from "@/lib/reporting/alerts";
import { comparisonFor, METRIC_CATALOGUE, metricDefinition } from "@/lib/monitoring/metric-catalogue";
import type { MetricTarget } from "@/lib/monitoring/targets";
import type { ControlCentreReport } from "@/lib/reporting/report";
import type { CashPosition } from "@/lib/financial/cash";
import type { InventoryPosition } from "@/lib/financial/inventory";

const d = (value: string | number) => new Decimal(value);

function report(overrides: Partial<ControlCentreReport["summary"]> = {}, marketing: Partial<ControlCentreReport["marketing"]> = {}): ControlCentreReport {
  return {
    range: { from: "2026-08-01", to: "2026-08-31" },
    daily: [],
    allocated: [],
    skus: [],
    warnings: [],
    summary: {
      from: "2026-08-01",
      to: "2026-08-31",
      grossSales: d(10_000),
      discounts: d(0),
      shippingRevenue: d(0),
      refunds: d(500),
      netRevenue: d(9_500),
      cm1: d(5_000),
      cm1Margin: d("0.5263"),
      metaAdSpend: d(2_000),
      tiktokAdSpend: d(500),
      advertisingSpend: d(2_500),
      cm2: d(2_500),
      cm2Margin: d("0.2632"),
      cm3: d(1_800),
      cm3Margin: d("0.1895"),
      fixedOperatingCosts: d(0),
      operatingProfit: d(1_800),
      operatingMargin: d("0.1895"),
      orders: 200,
      newCustomers: 120,
      averageOrderValue: d("47.50"),
      warnings: [],
      ...overrides,
    } as ControlCentreReport["summary"],
    marketing: {
      advertisingSpend: d(2_500),
      mer: d("3.8"),
      blendedCac: d("20.83"),
      newCustomerRoas: d("2.1"),
      contributionLevel: "cm1",
      maximumCac: d("30.00"),
      breakEvenRoas: d("2.5"),
      cacHeadroom: d("9.17"),
      roasHeadroom: d("1.3"),
      isAcquisitionViable: true,
      platforms: [
        { platform: "meta", spend: d(2_000), attributedPurchases: 80, attributedCac: d(25), attributedRoas: d(3) },
        { platform: "tiktok", spend: d(500), attributedPurchases: null, attributedCac: null, attributedRoas: null },
      ],
      ...marketing,
    } as ControlCentreReport["marketing"],
  } as ControlCentreReport;
}

const target = (overrides: Partial<MetricTarget> & Pick<MetricTarget, "metricKey" | "targetValue">): MetricTarget => ({
  comparison: "gte",
  severity: "amber",
  effectiveFrom: "2020-01-01",
  effectiveTo: null,
  ...overrides,
});

describe("the metric catalogue", () => {
  /**
   * A target stored against a key nothing observes never fires, which is indistinguishable
   * from one that is always met. The catalogue is what stops that being possible.
   */
  it("has an observation for every metric it lists", () => {
    const observations = buildObservations({ report: report() });

    for (const metric of METRIC_CATALOGUE) {
      expect(observations.has(metric.key), `${metric.key} is catalogued but not observed`).toBe(true);
    }
  });

  it("derives the comparison from the metric rather than leaving it to be stated", () => {
    expect(comparisonFor(metricDefinition("cm3_margin")!)).toBe("gte");
    expect(comparisonFor(metricDefinition("blended_cac")!)).toBe("lte");
  });

  it("labels a metric for display, falling back to the key", () => {
    expect(metricLabel("blended_cac")).toBe("Blended CAC");
    expect(metricLabel("something_else")).toBe("something_else");
  });
});

describe("building observations", () => {
  /** Refunds are measured against gross, not net, which they have already been taken out of. */
  it("measures the refund rate against gross sales", () => {
    const observations = buildObservations({ report: report() });

    expect(observations.get("refund_rate")?.toFixed(4)).toBe("0.0500");
  });

  /** CM3 relabelled as operating margin would be a misstatement, not an approximation. */
  it("reports operating margin as unavailable until fixed costs are configured", () => {
    expect(buildObservations({ report: report() }).get("operating_margin")).toBeNull();
    expect(
      buildObservations({ report: report({ fixedOperatingCosts: d(1_000) }) }).get("operating_margin"),
    ).not.toBeNull();
  });

  /**
   * The cash model is handed zero when no balance was reported, so reading its output blindly
   * would judge a balance nobody has against a minimum-cash target and raise a false red.
   */
  it("reports cash as unavailable when no bank balance was reported", () => {
    const cash = { bankBalance: d(0), availableCash: d(0), runwayDays: null } as CashPosition;

    const observations = buildObservations({ report: report(), cash, hasReportedBankBalance: false });

    expect(observations.get("cash_balance")).toBeNull();
    expect(observations.get("available_cash")).toBeNull();
  });

  it("reports cash when a balance was genuinely reported", () => {
    const cash = { bankBalance: d(12_000), availableCash: d(9_000), runwayDays: d(90) } as CashPosition;

    const observations = buildObservations({ report: report(), cash, hasReportedBankBalance: true });

    expect(observations.get("cash_balance")?.toString()).toBe("12000");
  });

  it("carries the platform figures separately from the blended ones", () => {
    const observations = buildObservations({ report: report() });

    expect(observations.get("meta_cac")?.toString()).toBe("25");
    // TikTok reported no attributed purchases, which is absent rather than zero.
    expect(observations.get("tiktok_cac")).toBeNull();
  });
});

describe("the lowest stock cover", () => {
  const position = (days: Decimal | null): InventoryPosition => ({ daysOfStockRemaining: days }) as InventoryPosition;

  it("takes the tightest SKU", () => {
    expect(lowestCover([position(d(40)), position(d(12)), position(d(90))])?.toString()).toBe("12");
  });

  /** A discontinued line sells nothing, so zero days would make the check fire permanently. */
  it("skips variants with no cover figure rather than treating them as zero", () => {
    expect(lowestCover([position(null), position(d(40))])?.toString()).toBe("40");
    expect(lowestCover([position(null)])).toBeNull();
  });
});

describe("assessing health", () => {
  /**
   * A dashboard that reports green because nothing was ever measured is worse than one that
   * says it is not judging.
   */
  it("reports unavailable rather than green when no target is configured", () => {
    const health = assessHealth({ report: report() }, [], "2026-08-31");

    expect(health.status).toBe("unavailable");
    expect(health.hasTargets).toBe(false);
    expect(health.alerts).toHaveLength(0);
  });

  it("raises an alert for a breached target, most severe first", () => {
    const health = assessHealth({ report: report() }, [
      target({ metricKey: "cm3_margin", targetValue: "0.25", severity: "amber" }),
      target({ metricKey: "blended_cac", targetValue: "15", comparison: "lte", severity: "red" }),
    ], "2026-08-31");

    expect(health.status).toBe("red");
    expect(health.alerts.map((alert) => alert.metricKey)).toEqual(["blended_cac", "cm3_margin"]);
  });

  it("is green when every configured target is met", () => {
    const health = assessHealth({ report: report() }, [
      target({ metricKey: "cm3_margin", targetValue: "0.10" }),
      target({ metricKey: "blended_cac", targetValue: "30", comparison: "lte" }),
    ], "2026-08-31");

    expect(health.status).toBe("green");
    expect(health.alerts).toHaveLength(0);
  });

  /**
   * An unmet target on a metric that could not be calculated must not read as met. It is the
   * absence of a judgement, not a passing one.
   */
  it("reports a configured target on an uncalculable metric as unavailable", () => {
    const health = assessHealth({ report: report() }, [
      target({ metricKey: "operating_margin", targetValue: "0.10" }),
    ], "2026-08-31");

    expect(health.status).toBe("unavailable");
    expect(health.statusOf("operating_margin")).toBe("unavailable");
  });

  /** Restating a past period must use the target that was in force then. */
  it("judges against the target effective on the period end, not today", () => {
    const targets = [
      target({ metricKey: "cm3_margin", targetValue: "0.10", effectiveFrom: "2020-01-01", effectiveTo: "2026-07-31" }),
      target({ metricKey: "cm3_margin", targetValue: "0.30", effectiveFrom: "2026-08-01" }),
    ];

    expect(assessHealth({ report: report() }, targets, "2026-07-15").status).toBe("green");
    expect(assessHealth({ report: report() }, targets, "2026-08-31").status).toBe("amber");
  });

  it("shows no status for a metric with no configured target", () => {
    const health = assessHealth({ report: report() }, [target({ metricKey: "cm3_margin", targetValue: "0.10" })], "2026-08-31");

    expect(health.statusOf("mer")).toBeUndefined();
    expect(health.noteOf("mer")).toBeUndefined();
  });

  /** A margin target of 0.15 must read as 15%, not as 0.15 of a percent. */
  it("renders a ratio target as a percentage", () => {
    const health = assessHealth({ report: report() }, [
      target({ metricKey: "cm3_margin", targetValue: "0.25" }),
    ], "2026-08-31");

    expect(health.noteOf("cm3_margin")).toBe("target ≥ 25.0%");
  });
});
