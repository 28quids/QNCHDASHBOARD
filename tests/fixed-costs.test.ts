import { describe, expect, it } from "vitest";
import { dailyFixedPeriodAmount } from "../lib/financial/cost-resolution";
import { enumerateDates } from "../lib/financial/dates";
import { sum } from "../lib/financial/money";
import type { CostAssumptionRecord, PeriodUnit } from "../lib/financial/domain";

const assumption = (amount: string, periodUnit: PeriodUnit): CostAssumptionRecord => ({
  assumptionKey: "software",
  financialBucket: "fixed_operating",
  chargeBasis: "fixed_period",
  amount,
  appliesTo: "all_orders",
  effectiveFrom: "2020-01-01",
  periodUnit,
});

const totalOver = (record: CostAssumptionRecord, from: string, to: string) =>
  sum(enumerateDates(from, to).map((date) => dailyFixedPeriodAmount(record, date)));

describe("recurring cost spreading", () => {
  it("sums back to the approved amount over a 31-day month", () => {
    expect(totalOver(assumption("310.00", "month"), "2026-01-01", "2026-01-31").toString()).toBe("310");
  });

  it("sums back to the approved amount over a 28-day month", () => {
    expect(totalOver(assumption("310.00", "month"), "2026-02-01", "2026-02-28").toString()).toBe("310");
  });

  it("sums back over a leap February", () => {
    expect(totalOver(assumption("1000.00", "month"), "2024-02-01", "2024-02-29").toString()).toBe("1000");
  });

  it("handles an amount that does not divide cleanly", () => {
    expect(totalOver(assumption("1000.00", "month"), "2026-03-01", "2026-03-31").toString()).toBe("1000");
  });

  it("sums back over a Monday-to-Sunday week", () => {
    // 2026-06-01 is a Monday.
    expect(totalOver(assumption("100.00", "week"), "2026-06-01", "2026-06-07").toString()).toBe("100");
  });

  it("sums back over a full calendar year", () => {
    expect(totalOver(assumption("5000.00", "year"), "2026-01-01", "2026-12-31").toString()).toBe("5000");
  });

  it("charges a daily cost in full each day", () => {
    expect(dailyFixedPeriodAmount(assumption("12.34", "day"), "2026-05-05").toString()).toBe("12.34");
  });
});
