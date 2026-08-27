import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MetaApiError, MetaClient } from "@/lib/connectors/meta/client";
import { normaliseInsight, readAction, totalSpend } from "@/lib/connectors/meta/normalise";
import { insightParams, ATTRIBUTION_KEY } from "@/lib/connectors/meta/queries";
import { buildMetaInsightsSyncJob, incrementalWindow } from "@/lib/connectors/meta/sync";
import { createMetaRepository } from "@/lib/repositories/meta-repository";
import { runSync } from "@/lib/connectors/sync-runner";
import { createSupabaseSyncStore } from "@/lib/connectors/supabase-sync-store";
import { createFakeSupabase, type Row } from "./helpers/fake-supabase";
import type { MetaInsightRow } from "@/lib/connectors/meta/types";

const ORGANISATION = "org-1";
const ACCOUNT_ROW = "ad-account-1";

const noSleep = () => Promise.resolve();

/** Builds a fetch that returns each queued body in turn. */
function fakeFetch(bodies: unknown[], headers: Record<string, string> = {}) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string | URL) => {
    calls.push(String(url));
    const body = bodies.shift() ?? { data: [] };
    return new Response(JSON.stringify(body), { status: 200, headers });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const INSIGHT: MetaInsightRow = {
  date_start: "2026-08-01",
  date_stop: "2026-08-01",
  spend: "125.50",
  impressions: "10000",
  reach: "8000",
  clicks: "300",
  inline_link_clicks: "220",
  actions: [
    { action_type: "landing_page_view", value: "180" },
    { action_type: "offsite_conversion.fb_pixel_add_to_cart", value: "40" },
    { action_type: "offsite_conversion.fb_pixel_initiate_checkout", value: "20" },
    { action_type: "offsite_conversion.fb_pixel_purchase", value: "12" },
    { action_type: "omni_purchase", value: "19" },
  ],
  action_values: [
    { action_type: "offsite_conversion.fb_pixel_purchase", value: "540.25" },
    { action_type: "omni_purchase", value: "890.00" },
  ],
};

describe("normalising insights", () => {
  it("maps spend and impressions onto the stored columns", () => {
    const result = normaliseInsight(INSIGHT, "account");

    expect(result.metricDate).toBe("2026-08-01");
    expect(result.spend).toBe("125.5000");
    expect(result.impressions).toBe(10_000);
    expect(result.entityExternalId).toBeNull();
  });

  /**
   * Meta reports both a pixel figure and a wider deduplicated one. For a single Shopify
   * store the pixel figure is the one comparable with QNCH orders, so taking the larger
   * `omni_purchase` would overstate the platform's attributed performance.
   */
  it("prefers the pixel purchase count over the broader omni figure", () => {
    const result = normaliseInsight(INSIGHT, "account");

    expect(result.purchases).toBe(12);
    expect(result.purchaseValue).toBe("540.2500");
  });

  it("falls back to the broader figure when the pixel action is absent", () => {
    const entries = [{ action_type: "omni_purchase", value: "19" }];

    expect(readAction(entries, "purchases")).toBe(19);
  });

  /** Absent is not zero: a campaign Meta did not measure differs from one that sold nothing. */
  it("returns null for a conversion Meta did not report", () => {
    const result = normaliseInsight({ date_start: "2026-08-01", date_stop: "2026-08-01", spend: "10" }, "account");

    expect(result.purchases).toBeNull();
    expect(result.purchaseValue).toBeNull();
    expect(result.addToCarts).toBeNull();
    // Spend and impressions are genuinely zero when missing, so they are not nullable.
    expect(result.impressions).toBe(0);
  });

  it("prefers link clicks over total clicks, being the figure comparable with sessions", () => {
    expect(normaliseInsight(INSIGHT, "account").clicks).toBe(220);
  });

  it("keeps the raw row so an unmodelled metric is still recoverable", () => {
    expect(normaliseInsight(INSIGHT, "account").raw).toEqual(INSIGHT);
  });

  it("carries the entity id at a level below the account", () => {
    const row = { ...INSIGHT, campaign_id: "23847", adset_id: "9911" };

    expect(normaliseInsight(row, "campaign").entityExternalId).toBe("23847");
    expect(normaliseInsight(row, "adset").entityExternalId).toBe("9911");
  });

  it("totals spend without float drift", () => {
    const rows = [INSIGHT, { ...INSIGHT, spend: "0.10" }, { ...INSIGHT, spend: "0.20" }].map((row) =>
      normaliseInsight(row, "account"),
    );

    expect(totalSpend(rows)).toBe("125.80");
  });
});

describe("insight request parameters", () => {
  /**
   * Without time_increment Meta returns one aggregated row for the whole range, which cannot
   * be attributed to a business date and would collapse a backfill into a single figure.
   */
  it("requests one row per day", () => {
    expect(insightParams({ since: "2026-08-01", until: "2026-08-07", level: "account" })).toMatchObject({
      time_increment: "1",
      level: "account",
    });
  });

  it("states the attribution window explicitly rather than relying on the default", () => {
    const params = insightParams({ since: "2026-08-01", until: "2026-08-07", level: "account" });

    expect(JSON.parse(params.action_attribution_windows)).toEqual(["7d_click", "1d_view"]);
  });

  it("asks for the identifying field of the level being requested", () => {
    expect(insightParams({ since: "a", until: "b", level: "ad" }).fields).toContain("ad_id");
    expect(insightParams({ since: "a", until: "b", level: "account" }).fields).not.toContain("ad_id");
  });
});

describe("the client", () => {
  /** Meta returns errors with HTTP 200, so parsing without checking would read one as empty. */
  it("raises an error returned alongside a 200 response", async () => {
    const { impl } = fakeFetch([{ error: { message: "Invalid OAuth token", type: "OAuthException", code: 190 } }]);
    const client = new MetaClient({ accessToken: "token", fetchImpl: impl, sleep: noSleep });

    await expect(client.get("act_1/insights")).rejects.toThrow(MetaApiError);
  });

  it("identifies an authentication failure so a caller can prompt a reconnect", async () => {
    const { impl } = fakeFetch([{ error: { message: "expired", type: "OAuthException", code: 190 } }]);
    const client = new MetaClient({ accessToken: "token", fetchImpl: impl, sleep: noSleep });

    await expect(client.get("act_1/insights")).rejects.toMatchObject({ isAuthFailure: true });
  });

  it("follows paging to the end and does not resend the original parameters", async () => {
    const { impl, calls } = fakeFetch([
      { data: [{ id: "1" }], paging: { next: "https://graph.facebook.com/v26.0/act_1/ads?after=abc" } },
      { data: [{ id: "2" }] },
    ]);
    const client = new MetaClient({ accessToken: "token", fetchImpl: impl, sleep: noSleep });

    const all = await client.getAll<{ id: string }>("act_1/ads", { fields: "id", limit: "2" });

    expect(all.map((item) => item.id)).toEqual(["1", "2"]);
    expect(calls[0]).toContain("fields=id");
    // The next URL already carries the original query; re-adding it risks conflicting values.
    expect(calls[1]).toContain("after=abc");
  });

  it("keeps the access token out of error messages", async () => {
    const { impl } = fakeFetch([]);
    const failing = vi.fn(async () => new Response("upstream exploded", { status: 400 }));
    const client = new MetaClient({
      accessToken: "super-secret-token",
      fetchImpl: failing as unknown as typeof fetch,
      sleep: noSleep,
    });
    void impl;

    await expect(client.get("act_1/insights")).rejects.toThrow(/REDACTED/);
    await expect(client.get("act_1/insights")).rejects.not.toThrow(/super-secret-token/);
  });
});

describe("the insights sync", () => {
  function seed(): Record<string, Row[]> {
    return {
      ad_accounts: [
        { id: ACCOUNT_ROW, organisation_id: ORGANISATION, platform: "meta", external_id: "act_1" },
      ],
      integration_connections: [{ id: "connection-1", organisation_id: ORGANISATION, provider: "meta" }],
      ad_entities: [],
      ad_daily_metrics: [],
      sync_runs: [],
      sync_cursors: [],
    };
  }

  it("writes account-level rows with a null entity, which is what the P&L reads", async () => {
    const { client: supabase, tables } = createFakeSupabase(seed());
    const { impl } = fakeFetch([{ data: [INSIGHT, { ...INSIGHT, date_start: "2026-08-02", date_stop: "2026-08-02" }] }]);

    const job = buildMetaInsightsSyncJob({
      client: new MetaClient({ accessToken: "token", fetchImpl: impl, sleep: noSleep }),
      repository: createMetaRepository(supabase as unknown as SupabaseClient, { organisationId: ORGANISATION }),
      connectionId: "connection-1",
      accountExternalId: "act_1",
      adAccountId: ACCOUNT_ROW,
      since: "2026-08-01",
      until: "2026-08-02",
      level: "account",
      jobDiscriminator: "2026-08-02",
    });

    const outcome = await runSync(job, createSupabaseSyncStore(supabase as unknown as SupabaseClient));

    expect(outcome.status).toBe("succeeded");
    expect(tables.ad_daily_metrics).toHaveLength(2);
    expect(tables.ad_daily_metrics.every((row) => row.entity_id === null)).toBe(true);
    expect(tables.ad_daily_metrics[0].attribution_window).toBe(ATTRIBUTION_KEY);
  });

  /**
   * Meta restates conversions for days already imported as attribution settles, so the same
   * window is re-fetched deliberately. It has to converge on the newest figure, not add to
   * the old one.
   */
  it("rewrites a day rather than duplicating it when a window is re-imported", async () => {
    const { client: supabase, tables } = createFakeSupabase(seed());
    const repository = createMetaRepository(supabase as unknown as SupabaseClient, {
      organisationId: ORGANISATION,
    });

    await repository.persistInsights(ACCOUNT_ROW, [normaliseInsight(INSIGHT, "account")]);
    await repository.persistInsights(ACCOUNT_ROW, [
      normaliseInsight({ ...INSIGHT, spend: "130.00" }, "account"),
    ]);

    expect(tables.ad_daily_metrics).toHaveLength(1);
    expect(tables.ad_daily_metrics[0].spend).toBe("130.0000");
  });

  /**
   * A null entity_id means "account level", and the account row for that day already carries
   * this spend. Writing an unresolved campaign row with a null entity filed it in the same
   * bucket and the P&L counted the spend twice — it read £8,145 against £5,133 of real spend.
   */
  it("skips an entity row whose campaign has not been synced, rather than filing it as account level", async () => {
    const { client: supabase, tables } = createFakeSupabase(seed());
    const repository = createMetaRepository(supabase as unknown as SupabaseClient, {
      organisationId: ORGANISATION,
    });

    const result = await repository.persistInsights(ACCOUNT_ROW, [
      normaliseInsight({ ...INSIGHT, campaign_id: "not-synced-yet" }, "campaign"),
    ]);

    expect(result).toMatchObject({ rows: 0, skippedUnresolvedEntities: 1 });
    expect(tables.ad_daily_metrics).toHaveLength(0);
  });

  it("does not let a skipped entity row disturb the account row for the same day", async () => {
    const { client: supabase, tables } = createFakeSupabase(seed());
    const repository = createMetaRepository(supabase as unknown as SupabaseClient, {
      organisationId: ORGANISATION,
    });

    await repository.persistInsights(ACCOUNT_ROW, [normaliseInsight(INSIGHT, "account")]);
    await repository.persistInsights(ACCOUNT_ROW, [
      normaliseInsight({ ...INSIGHT, campaign_id: "not-synced-yet" }, "campaign"),
    ]);

    // Exactly one row, carrying the account-level figure and nothing added on top of it.
    expect(tables.ad_daily_metrics).toHaveLength(1);
    expect(tables.ad_daily_metrics[0].spend).toBe("125.5000");
  });

  it("resolves an entity that has already been synced", async () => {
    const withEntity = seed();
    withEntity.ad_entities = [
      { id: "entity-1", ad_account_id: ACCOUNT_ROW, external_id: "23847", level: "campaign" },
    ];
    const { client: supabase, tables } = createFakeSupabase(withEntity);
    const repository = createMetaRepository(supabase as unknown as SupabaseClient, {
      organisationId: ORGANISATION,
    });

    const result = await repository.persistInsights(ACCOUNT_ROW, [
      normaliseInsight({ ...INSIGHT, campaign_id: "23847" }, "campaign"),
    ]);

    expect(result.skippedUnresolvedEntities).toBe(0);
    expect(tables.ad_daily_metrics[0].entity_id).toBe("entity-1");
  });

  it("is a no-op when the same window has already succeeded", async () => {
    const { client: supabase } = createFakeSupabase(seed());
    const store = createSupabaseSyncStore(supabase as unknown as SupabaseClient);
    const repository = createMetaRepository(supabase as unknown as SupabaseClient, {
      organisationId: ORGANISATION,
    });

    const build = () =>
      buildMetaInsightsSyncJob({
        client: new MetaClient({
          accessToken: "token",
          fetchImpl: fakeFetch([{ data: [INSIGHT] }]).impl,
          sleep: noSleep,
        }),
        repository,
        connectionId: "connection-1",
        accountExternalId: "act_1",
        adAccountId: ACCOUNT_ROW,
        since: "2026-08-01",
        until: "2026-08-01",
        level: "account",
        jobDiscriminator: "2026-08-01",
      });

    await runSync(build(), store);
    const second = await runSync(build(), store);

    expect(second).toMatchObject({ status: "skipped", reason: "already_succeeded" });
  });
});

describe("incremental window", () => {
  it("reaches back over the restatement period rather than fetching only yesterday", () => {
    expect(incrementalWindow("2026-08-27")).toEqual({ since: "2026-08-20", until: "2026-08-27" });
  });
});
