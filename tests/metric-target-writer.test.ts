import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createMetricTargetWriter,
  enteredValue,
  storedValue,
} from "@/lib/settings/metric-targets";
import { metricDefinition } from "@/lib/monitoring/metric-catalogue";

const ORGANISATION = "org-1";

/** A client that records the RPC it was asked to make, and can be made to refuse. */
function fakeClient(error: { message: string } | null = null) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data: null, error };
    }),
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const writerFor = (error: { message: string } | null = null) => {
  const { client, calls } = fakeClient(error);
  return { writer: createMetricTargetWriter(client, ORGANISATION), calls };
};

describe("converting what a person typed", () => {
  /**
   * A 15% margin stores as 0.15 and a 3x MER stores as 3. Both look plausible in a table, so
   * collapsing them would produce a target out by a hundredfold that reads as reasonable.
   */
  it("stores a percentage as a ratio and a multiple as itself", () => {
    expect(storedValue(metricDefinition("cm3_margin")!, 15)).toBe(0.15);
    expect(storedValue(metricDefinition("mer")!, 3)).toBe(3);
    expect(storedValue(metricDefinition("blended_cac")!, 22)).toBe(22);
  });

  it("round-trips back into the form that set it", () => {
    for (const [key, typed] of [["cm3_margin", 15], ["mer", 3], ["blended_cac", 22]] as const) {
      const definition = metricDefinition(key)!;
      expect(enteredValue(definition, storedValue(definition, typed))).toBeCloseTo(typed);
    }
  });
});

describe("setting a target", () => {
  it("goes through the atomic function rather than two writes", async () => {
    const { writer, calls } = writerFor();

    await writer.set({ metricKey: "cm3_margin", enteredValue: 15, severity: "red" });

    expect(calls[0].name).toBe("set_metric_target");
    expect(calls[0].args).toMatchObject({
      p_organisation_id: ORGANISATION,
      p_metric_key: "cm3_margin",
      p_target_value: 0.15,
      p_severity: "red",
    });
  });

  /** A ceiling on CAC and a floor on margin follow from the metric; offering the choice invites
   *  setting one backwards, and a backwards target fires constantly or never. */
  it("derives the comparison from the metric rather than accepting one", async () => {
    const { writer, calls } = writerFor();

    await writer.set({ metricKey: "cm3_margin", enteredValue: 15, severity: "amber" });
    await writer.set({ metricKey: "blended_cac", enteredValue: 22, severity: "amber" });

    expect(calls[0].args.p_comparison).toBe("gte");
    expect(calls[1].args.p_comparison).toBe("lte");
  });

  /** Dating the change from today is what stops it restating periods already reported. */
  it("applies from today unless told otherwise", async () => {
    const { writer, calls } = writerFor();

    await writer.set({ metricKey: "mer", enteredValue: 3, severity: "amber" });

    expect(calls[0].args.p_effective_from).toBe(new Date().toISOString().slice(0, 10));
  });

  it("refuses a metric nothing evaluates, rather than storing a target that never fires", async () => {
    const { writer, calls } = writerFor();

    const result = await writer.set({ metricKey: "made_up", enteredValue: 1, severity: "amber" });

    expect(result.status).toBe("rejected");
    expect(calls).toHaveLength(0);
  });

  it("refuses a value that is not a number", async () => {
    const { writer } = writerFor();

    expect(await writer.set({ metricKey: "mer", enteredValue: Number.NaN, severity: "amber" })).toMatchObject({
      status: "rejected",
    });
  });

  /** RLS refuses by returning an error. That is a permission answer, not a fault. */
  it("reports a row-level security refusal as a permission answer", async () => {
    const { writer } = writerFor({ message: 'new row violates row-level security policy for table "metric_targets"' });

    const result = await writer.set({ metricKey: "mer", enteredValue: 3, severity: "amber" });

    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(/owner or finance administrator/);
  });
});

describe("clearing a target", () => {
  /** End-dated, not deleted: deleting would change what a past period was reported against. */
  it("end-dates rather than deleting", async () => {
    const { writer, calls } = writerFor();

    const result = await writer.clear("cm3_margin");

    expect(calls[0].name).toBe("clear_metric_target");
    expect(calls[0].args.p_effective_to).toBe(new Date().toISOString().slice(0, 10));
    expect(result.message).toMatch(/keep the target they were reported against/);
  });

  it("refuses an unknown metric", async () => {
    const { writer, calls } = writerFor();

    expect(await writer.clear("made_up")).toMatchObject({ status: "rejected" });
    expect(calls).toHaveLength(0);
  });
});
