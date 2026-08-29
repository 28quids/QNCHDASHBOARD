import { describe, expect, it } from "vitest";
import { assertBusinessDate, resolveAllEffective, resolveEffective, resolveEffectiveByKey } from "../lib/financial/effective-dating";

const record = (effectiveFrom: string, effectiveTo: string | null, label: string) => ({ effectiveFrom, effectiveTo, label });

describe("effective dating", () => {
  const history = [
    record("2026-01-01", "2026-03-31", "opening"),
    record("2026-04-01", null, "current"),
  ];

  it("selects the version in force on the date", () => {
    expect(resolveEffective(history, "2026-02-15")?.label).toBe("opening");
    expect(resolveEffective(history, "2026-08-01")?.label).toBe("current");
  });

  it("includes the boundary dates", () => {
    expect(resolveEffective(history, "2026-03-31")?.label).toBe("opening");
    expect(resolveEffective(history, "2026-04-01")?.label).toBe("current");
  });

  it("returns null before anything was approved rather than guessing", () => {
    expect(resolveEffective(history, "2025-12-31")).toBeNull();
  });

  it("prefers the latest start when versions overlap", () => {
    const overlapping = [record("2026-01-01", null, "old"), record("2026-05-01", null, "restated")];
    expect(resolveEffective(overlapping, "2026-06-01")?.label).toBe("restated");
  });

  it("returns every stacking record in force", () => {
    const stacked = [record("2026-01-01", null, "a"), record("2026-02-01", null, "b")];
    expect(resolveAllEffective(stacked, "2026-03-01").map((item) => item.label)).toEqual(["a", "b"]);
  });

  it("resolves each key independently", () => {
    const perSku = [
      { ...record("2026-01-01", null, "sku-a-v1"), sku: "A" },
      { ...record("2026-06-01", null, "sku-a-v2"), sku: "A" },
      { ...record("2026-01-01", null, "sku-b-v1"), sku: "B" },
    ];
    const resolved = resolveEffectiveByKey(perSku, "2026-07-01", (item) => item.sku);
    expect(resolved.get("A")?.label).toBe("sku-a-v2");
    expect(resolved.get("B")?.label).toBe("sku-b-v1");
  });

  it("rejects a date that is not a business date", () => {
    expect(() => assertBusinessDate("01/02/2026")).toThrow(/YYYY-MM-DD/);
  });
});
