import { describe, expect, it } from "vitest";
import { allocateProportionally, ratio, sum } from "../lib/financial/money";

const asStrings = (values: { toString(): string }[]) => values.map((value) => value.toString());

describe("money helpers", () => {
  it("returns null instead of dividing by zero", () => {
    expect(ratio(10, 0)).toBeNull();
    expect(ratio(10, 4)?.toString()).toBe("2.5");
  });

  it("sums an empty list to zero", () => {
    expect(sum([]).toString()).toBe("0");
  });

  it("allocates without losing or inventing pennies", () => {
    const parts = allocateProportionally("10.00", [1, 1, 1]);
    expect(asStrings(parts)).toEqual(["3.34", "3.33", "3.33"]);
    expect(sum(parts).toString()).toBe("10");
  });

  it("weights allocation by the supplied basis", () => {
    const parts = allocateProportionally("100.00", ["75.00", "25.00"]);
    expect(asStrings(parts)).toEqual(["75", "25"]);
  });

  it("spreads evenly when there is no weighting basis", () => {
    const parts = allocateProportionally("9.00", [0, 0]);
    expect(asStrings(parts)).toEqual(["4.5", "4.5"]);
    expect(sum(parts).toString()).toBe("9");
  });

  it("handles negative totals such as refunds", () => {
    const parts = allocateProportionally("-10.00", [1, 1, 1]);
    expect(sum(parts).toString()).toBe("-10");
  });

  it("returns no parts for no weights", () => {
    expect(allocateProportionally("10.00", [])).toEqual([]);
  });
});
