import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { changeAgainst, gbp, multiple, percent, relativeTime, UNAVAILABLE } from "@/lib/reporting/format";
import { DEFAULT_TIMEFRAME, isTimeframeKey, resolveTimeframe } from "@/lib/reporting/timeframes";

describe("formatting", () => {
  it("renders an unavailable figure as a dash, never as zero", () => {
    // A margin on no revenue, a CAC with no acquisitions and a ROAS with no spend are all
    // genuinely unknown. Showing 0 would read as a measured result.
    expect(gbp(null)).toBe(UNAVAILABLE);
    expect(percent(null)).toBe(UNAVAILABLE);
    expect(multiple(null)).toBe(UNAVAILABLE);
    expect(gbp(0)).toBe("£0.00");
  });

  it("drops pence on large figures and keeps them on small ones", () => {
    expect(gbp(new Decimal("12.5"))).toBe("£12.50");
    expect(gbp(new Decimal("12345.67"))).toBe("£12,346");
  });

  it("converts a ratio to a percentage", () => {
    expect(percent(new Decimal("0.4237"))).toBe("42.4%");
  });
});

describe("period-on-period change", () => {
  it("reports growth from zero as new rather than as an infinite increase", () => {
    expect(changeAgainst(500, 0)).toMatchObject({ label: "new", direction: "up" });
  });

  it("treats zero against zero as no change, not a total collapse", () => {
    expect(changeAgainst(0, 0)).toMatchObject({ label: "no change", direction: "flat" });
  });

  it("cannot judge a change when either side is unavailable", () => {
    expect(changeAgainst(null, 100)).toMatchObject({ direction: "unknown", ratio: null });
  });

  it("computes a proportional change against the previous period", () => {
    expect(changeAgainst(150, 100)).toMatchObject({ label: "+50.0%", direction: "up" });
    expect(changeAgainst(80, 100)).toMatchObject({ label: "-20.0%", direction: "down" });
  });

  /** A cost falling from -100 to -50 is an improvement; the sign must not invert the maths. */
  it("uses the magnitude of the previous value, so a negative base does not flip direction", () => {
    expect(changeAgainst(-50, -100).direction).toBe("up");
  });
});

describe("timeframes", () => {
  const today = "2026-08-27";

  it("defaults to a key that exists", () => {
    expect(isTimeframeKey(DEFAULT_TIMEFRAME)).toBe(true);
    expect(isTimeframeKey("last-decade")).toBe(false);
    expect(isTimeframeKey(undefined)).toBe(false);
  });

  it("builds an inclusive trailing window", () => {
    expect(resolveTimeframe("7d", today).range).toEqual({ from: "2026-08-21", to: today });
  });

  it("compares a trailing window against the window immediately before it", () => {
    const resolved = resolveTimeframe("7d", today);
    expect(resolved.comparison).toEqual({ from: "2026-08-14", to: "2026-08-20" });
  });

  it("compares a previous month against the month before that, not a rolling window", () => {
    const resolved = resolveTimeframe("previous-month", today);
    expect(resolved.range).toEqual({ from: "2026-07-01", to: "2026-07-31" });
    expect(resolved.comparison).toEqual({ from: "2026-06-01", to: "2026-06-30" });
  });

  /**
   * A completed year compared against a year-to-date window is not a like-for-like read, so
   * the comparison is deliberately withheld rather than shown misleadingly.
   */
  it("offers no year-on-year comparison for year to date", () => {
    expect(resolveTimeframe("ytd", today).lastYear).toBeNull();
    expect(resolveTimeframe("30d", today).lastYear).toEqual({ from: "2025-07-29", to: "2025-08-27" });
  });

  it("covers a single day for today and yesterday", () => {
    expect(resolveTimeframe("today", today).range).toEqual({ from: today, to: today });
    expect(resolveTimeframe("yesterday", today).range).toEqual({ from: "2026-08-26", to: "2026-08-26" });
  });
});

describe("freshness", () => {
  const now = new Date("2026-08-27T12:00:00.000Z");

  it("says never rather than showing a stale-looking timestamp", () => {
    expect(relativeTime(null, now)).toBe("never");
  });

  it("describes age in the largest sensible unit", () => {
    expect(relativeTime("2026-08-27T11:45:00.000Z", now)).toBe("15 min ago");
    expect(relativeTime("2026-08-27T09:00:00.000Z", now)).toBe("3 hours ago");
    expect(relativeTime("2026-08-25T12:00:00.000Z", now)).toBe("2 days ago");
  });
});
