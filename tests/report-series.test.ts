import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { bucketRanges, buildPeriodSeries, narrowFacts, isReportGrain } from "@/lib/reporting/series";
import { parseReport, reportQuery } from "../app/(dashboard)/reports/query";
import { validateDraft } from "@/lib/reporting/saved-reports";
import { startOfWeek } from "@/lib/financial/dates";
import type { ReportingFacts } from "@/lib/reporting/reporting-repository";

const TODAY = "2026-08-31";

describe("bucketing a range", () => {
  it("returns one bucket per day at a daily grain", () => {
    expect(bucketRanges({ from: "2026-08-01", to: "2026-08-03" }, "day")).toHaveLength(3);
  });

  it("groups into weeks starting on Monday", () => {
    const buckets = bucketRanges({ from: "2026-08-01", to: "2026-08-16" }, "week");

    expect(buckets[0].key).toBe(startOfWeek("2026-08-01"));
    expect(buckets.every((bucket) => bucket.label.startsWith("w/c "))).toBe(true);
  });

  /**
   * A month clipped by the range is genuinely partial. Labelling it as the whole month would
   * make it look comparable with the full ones beside it in the same table.
   */
  it("labels a clipped month by its dates rather than as the whole month", () => {
    const buckets = bucketRanges({ from: "2026-08-10", to: "2026-09-30" }, "month");

    expect(buckets[0].label).toBe("2026-08-10 to 2026-08-31");
    expect(buckets[1].label).toBe("2026-09");
  });

  it("clips every bucket to the range", () => {
    const buckets = bucketRanges({ from: "2026-08-10", to: "2026-09-05" }, "month");

    expect(buckets[0].range).toEqual({ from: "2026-08-10", to: "2026-08-31" });
    expect(buckets[1].range).toEqual({ from: "2026-09-01", to: "2026-09-05" });
  });

  it("collapses to a single bucket for the whole period", () => {
    expect(bucketRanges({ from: "2026-08-01", to: "2026-08-31" }, "total")).toHaveLength(1);
  });
});

describe("narrowing facts to a bucket", () => {
  const facts = {
    range: { from: "2026-08-01", to: "2026-08-31" },
    orders: [{ externalId: "o-1" }],
    refunds: [{ processedBusinessDate: "2026-08-20" }],
    adSpend: [
      { platform: "meta", businessDate: "2026-08-01", spend: "100" },
      { platform: "meta", businessDate: "2026-08-20", spend: "200" },
    ],
    mappedExpenses: [
      { businessDate: "2026-08-01", bucket: "cm2", amount: "10", category: "affiliate" },
      { businessDate: "2026-08-20", bucket: "cm2", amount: "20", category: "affiliate" },
    ],
    context: {},
    policy: {},
  } as unknown as ReportingFacts;

  /**
   * The marketing calculation sums ad spend without reference to the range, so leaving it
   * unfiltered would report the whole report's spend against every single bucket.
   */
  it("filters advertising spend and mapped expenses to the bucket", () => {
    const narrowed = narrowFacts(facts, { from: "2026-08-01", to: "2026-08-05" });

    expect(narrowed.adSpend).toHaveLength(1);
    expect(narrowed.mappedExpenses).toHaveLength(1);
  });

  /**
   * Orders are not filtered: the engine emits rows only for dates in range anyway, and it needs
   * orders from outside it to find the original cost basis of a refund.
   */
  it("leaves orders and refunds alone", () => {
    const narrowed = narrowFacts(facts, { from: "2026-08-01", to: "2026-08-05" });

    expect(narrowed.orders).toHaveLength(1);
    expect(narrowed.refunds).toHaveLength(1);
    expect(narrowed.range).toEqual({ from: "2026-08-01", to: "2026-08-05" });
  });
});

describe("building a period series", () => {
  const emptyFacts = {
    range: { from: "2026-08-01", to: "2026-08-02" },
    orders: [],
    refunds: [],
    adSpend: [],
    mappedExpenses: [],
    context: { variantCostProfiles: [], costAssumptions: [], policy: {} },
    policy: {
      refundCogsReversal: "reverse_when_restocked",
      breakEvenContributionLevel: "cm1",
      inventoryAlertWindowDays: 30,
    },
  } as unknown as ReportingFacts;

  it("produces one row per bucket carrying only the requested metrics", () => {
    const series = buildPeriodSeries({
      facts: emptyFacts,
      range: { from: "2026-08-01", to: "2026-08-02" },
      grain: "day",
      metrics: ["net_revenue", "mer"],
    });

    expect(series).toHaveLength(2);
    expect([...series[0].values.keys()]).toEqual(["net_revenue", "mer"]);
  });

  /**
   * A period with nothing in it has zero revenue but no MER — there is no spend to divide by.
   * Reporting that as zero would read as advertising that returned nothing.
   */
  it("reports an uncalculable metric as null rather than zero", () => {
    const series = buildPeriodSeries({
      facts: emptyFacts,
      range: { from: "2026-08-01", to: "2026-08-01" },
      grain: "day",
      metrics: ["net_revenue", "mer", "blended_cac"],
    });

    expect(series[0].values.get("net_revenue")).toBeInstanceOf(Decimal);
    expect(series[0].values.get("mer")).toBeNull();
    expect(series[0].values.get("blended_cac")).toBeNull();
  });

  /** Cash and stock are positions at an instant, not activity over a window. */
  it("leaves position metrics unavailable in a period series", () => {
    const series = buildPeriodSeries({
      facts: emptyFacts,
      range: { from: "2026-08-01", to: "2026-08-01" },
      grain: "day",
      metrics: ["cash_balance", "minimum_inventory_days"],
    });

    expect(series[0].values.get("cash_balance")).toBeNull();
    expect(series[0].values.get("minimum_inventory_days")).toBeNull();
  });
});

describe("parsing a report from the query string", () => {
  it("keeps known metrics and reports the rest rather than dropping them silently", () => {
    const specification = parseReport({ metric: ["net_revenue", "not_a_metric"] }, TODAY);

    expect(specification.metrics).toEqual(["net_revenue"]);
    expect(specification.rejectedMetrics).toEqual(["not_a_metric"]);
  });

  it("orders columns by the catalogue so two identical reports render alike", () => {
    const a = parseReport({ metric: ["mer", "net_revenue"] }, TODAY);
    const b = parseReport({ metric: ["net_revenue", "mer"] }, TODAY);

    expect(a.metrics).toEqual(b.metrics);
  });

  it("deduplicates a metric asked for twice", () => {
    expect(parseReport({ metric: ["mer", "mer"] }, TODAY).metrics).toEqual(["mer"]);
  });

  it("falls back to a readable default when nothing was chosen", () => {
    expect(parseReport({}, TODAY).metrics.length).toBeGreaterThan(0);
    expect(parseReport({}, TODAY).grain).toBe("month");
  });

  it("prefers an explicit date range over a named timeframe", () => {
    const specification = parseReport({ timeframe: "7d", from: "2026-01-01", to: "2026-03-31" }, TODAY);

    expect(specification.isCustomRange).toBe(true);
    expect(specification.timeframe.range).toEqual({ from: "2026-01-01", to: "2026-03-31" });
  });

  /** A half-filled or backwards range must not silently become a window nobody asked for. */
  it("ignores an incomplete or backwards date range", () => {
    expect(parseReport({ from: "2026-01-01" }, TODAY).isCustomRange).toBe(false);
    expect(parseReport({ from: "2026-03-31", to: "2026-01-01" }, TODAY).isCustomRange).toBe(false);
  });

  it("round-trips through the query string it builds", () => {
    const original = parseReport({ metric: ["net_revenue", "mer"], grain: "week", timeframe: "7d" }, TODAY);
    const query = reportQuery({
      metrics: original.metrics,
      grain: original.grain,
      timeframeKey: original.timeframe.key,
    });

    const round = parseReport(Object.fromEntries(paramsOf(query)), TODAY);
    expect(round.metrics).toEqual(original.metrics);
    expect(round.grain).toBe("week");
    expect(round.timeframe.range).toEqual(original.timeframe.range);
  });

  it("recognises only the grains the series builder implements", () => {
    expect(isReportGrain("week")).toBe(true);
    expect(isReportGrain("fortnight")).toBe(false);
  });
});

describe("validating a saved report", () => {
  const draft = {
    name: "Monthly contribution",
    metricKeys: ["net_revenue", "cm3_margin"],
    grain: "month" as const,
    timeframeKey: "30d" as const,
    range: null,
  };

  it("accepts a well-formed draft", () => {
    expect(validateDraft(draft)).toEqual([]);
  });

  it("rejects an unknown metric rather than storing a column that renders empty", () => {
    expect(validateDraft({ ...draft, metricKeys: ["made_up"] }).join(" ")).toContain("made_up");
  });

  /**
   * A report meant to answer "how are the last 30 days" must keep moving; one pinned to a
   * quarter must not drift. Carrying both would leave which one wins to whoever reads it next.
   */
  it("requires exactly one of a timeframe and a fixed range", () => {
    expect(validateDraft({ ...draft, range: { from: "2026-01-01", to: "2026-03-31" } })).not.toEqual([]);
    expect(validateDraft({ ...draft, timeframeKey: null })).not.toEqual([]);
  });

  it("rejects an unnamed report and one with no metrics", () => {
    expect(validateDraft({ ...draft, name: "  " })).not.toEqual([]);
    expect(validateDraft({ ...draft, metricKeys: [] })).not.toEqual([]);
  });
});

/** URLSearchParams collapses repeated keys, so metrics are gathered back into an array. */
function paramsOf(query: string): [string, string | string[]][] {
  const params = new URLSearchParams(query);
  return [...new Set(params.keys())].map((key) => {
    const values = params.getAll(key);
    return [key, values.length > 1 ? values : values[0]];
  });
}
