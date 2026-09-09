import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TikTokApiError, TikTokClient } from "@/lib/connectors/tiktok/client";
import { normaliseReport, normaliseReports, totalSpend } from "@/lib/connectors/tiktok/normalise";
import { ATTRIBUTION_KEY, CORE_METRICS, reportParams } from "@/lib/connectors/tiktok/queries";
import {
  buildTikTokReportSyncJob,
  incrementalWindow,
  reportWithFallback,
} from "@/lib/connectors/tiktok/sync";
import { createTikTokRepository } from "@/lib/repositories/tiktok-repository";
import { runSync } from "@/lib/connectors/sync-runner";
import { createSupabaseSyncStore } from "@/lib/connectors/supabase-sync-store";
import { createFakeSupabase, type Row } from "./helpers/fake-supabase";
import type { TikTokReportRow } from "@/lib/connectors/tiktok/types";

const ORGANISATION = "org-1";
const ACCOUNT_ROW = "ad-account-tiktok";
const ADVERTISER = "700000000000";

const noSleep = () => Promise.resolve();

/** Builds a fetch that returns each queued envelope in turn. */
function fakeFetch(bodies: unknown[]) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string | URL) => {
    calls.push(String(url));
    const body = bodies.shift() ?? { code: 0, message: "OK", data: { list: [] } };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const envelope = (data: unknown) => ({ code: 0, message: "OK", request_id: "r1", data });

const REPORT: TikTokReportRow = {
  dimensions: { advertiser_id: ADVERTISER, stat_time_day: "2026-08-01 00:00:00" },
  metrics: {
    spend: "212.40",
    impressions: "54000",
    reach: "41000",
    clicks: "980",
    ctr: "1.81",
    cpc: "0.21",
    cpm: "3.93",
    complete_payment: "17",
    complete_payment_roas: "2.5",
    conversion: "31",
  },
};

describe("normalising a report row", () => {
  it("maps spend and delivery onto the stored columns", () => {
    const result = normaliseReport(REPORT, "advertiser");

    expect(result.metricDate).toBe("2026-08-01");
    expect(result.spend).toBe("212.4000");
    expect(result.impressions).toBe(54_000);
    expect(result.clicks).toBe(980);
    expect(result.entityExternalId).toBeNull();
  });

  /**
   * TikTok substitutes "-" for a metric that is meaningless under the query, typically because
   * the ad groups underneath optimise for different goals. Reading it as a number gives NaN;
   * coercing it to zero would report "not measured" as "measured as none".
   */
  it("treats the '-' placeholder as absent rather than as zero", () => {
    const row: TikTokReportRow = {
      dimensions: REPORT.dimensions,
      metrics: { spend: "10.00", complete_payment: "-", reach: "-", conversion: "-" },
    };
    const result = normaliseReport(row, "advertiser");

    expect(result.purchases).toBeNull();
    expect(result.reach).toBeNull();
  });

  it("prefers the payment count over the broader conversion count", () => {
    expect(normaliseReport(REPORT, "advertiser").purchases).toBe(17);
  });

  it("falls back to the conversion count when no payment metric is present", () => {
    const row: TikTokReportRow = {
      dimensions: REPORT.dimensions,
      metrics: { spend: "10.00", conversion: "31" },
    };

    expect(normaliseReport(row, "advertiser").purchases).toBe(31);
  });

  /**
   * ROAS is defined as value over spend, so this recovers the value exactly rather than
   * estimating it. Which of the two an account reports varies, so both paths are needed.
   */
  it("derives conversion value from ROAS when the value itself is not reported", () => {
    expect(normaliseReport(REPORT, "advertiser").purchaseValue).toBe("531.0000");
  });

  it("prefers a reported conversion value over the derivation", () => {
    const row: TikTokReportRow = {
      dimensions: REPORT.dimensions,
      metrics: { ...REPORT.metrics, total_complete_payment_value: "600.00" },
    };

    expect(normaliseReport(row, "advertiser").purchaseValue).toBe("600.0000");
  });

  /** Spend of zero makes the ROAS identity say nothing, so nothing is invented from it. */
  it("does not derive a value when there was no spend", () => {
    const row: TikTokReportRow = {
      dimensions: REPORT.dimensions,
      metrics: { spend: "0", complete_payment_roas: "2.5" },
    };

    expect(normaliseReport(row, "advertiser").purchaseValue).toBeNull();
  });

  it("carries the entity id at a level below the advertiser", () => {
    const row: TikTokReportRow = {
      dimensions: { campaign_id: "c-9", adgroup_id: "g-4", stat_time_day: "2026-08-01 00:00:00" },
      metrics: REPORT.metrics,
    };

    expect(normaliseReport(row, "campaign").entityExternalId).toBe("c-9");
    expect(normaliseReport(row, "adgroup").entityExternalId).toBe("g-4");
  });

  it("keeps the raw row so an unmodelled metric is still recoverable", () => {
    expect(normaliseReport(REPORT, "advertiser").raw).toEqual(REPORT);
  });

  /** A row with no day cannot be attributed to a business date, so it is dropped, not dated. */
  it("discards a row with no usable date", () => {
    const undated: TikTokReportRow = { dimensions: { advertiser_id: ADVERTISER }, metrics: { spend: "5" } };

    expect(normaliseReports([REPORT, undated], "advertiser")).toHaveLength(1);
  });

  it("totals spend without float drift", () => {
    const rows = normaliseReports(
      [REPORT, { ...REPORT, metrics: { ...REPORT.metrics, spend: "0.10" } }, { ...REPORT, metrics: { ...REPORT.metrics, spend: "0.20" } }],
      "advertiser",
    );

    expect(totalSpend(rows)).toBe("212.70");
  });
});

describe("report request parameters", () => {
  /**
   * Without stat_time_day TikTok returns one aggregate for the whole range, which cannot be
   * attributed to a business date and would collapse a backfill into a single figure.
   */
  it("groups by day", () => {
    const params = reportParams({ advertiserId: ADVERTISER, since: "2026-08-01", until: "2026-08-07", level: "advertiser" });

    expect(params.dimensions).toContain("stat_time_day");
    expect(params.data_level).toBe("AUCTION_ADVERTISER");
  });

  it("asks for the identifying dimension of the level being requested", () => {
    const ad = reportParams({ advertiserId: ADVERTISER, since: "a", until: "b", level: "ad" });

    expect(ad.dimensions).toContain("ad_id");
    expect(ad.data_level).toBe("AUCTION_AD");
  });
});

describe("the client", () => {
  /** TikTok returns errors with HTTP 200, so parsing without checking would read one as empty. */
  it("raises an error returned alongside a 200 response", async () => {
    const { impl } = fakeFetch([{ code: 40105, message: "Access token is invalid" }]);
    const client = new TikTokClient({ accessToken: "token", fetchImpl: impl, sleep: noSleep });

    await expect(client.get("campaign/get/")).rejects.toThrow(TikTokApiError);
  });

  it("identifies an authentication failure so a caller can prompt a reconnect", async () => {
    const { impl } = fakeFetch([{ code: 40105, message: "expired" }]);
    const client = new TikTokClient({ accessToken: "token", fetchImpl: impl, sleep: noSleep });

    await expect(client.get("campaign/get/")).rejects.toMatchObject({ isAuthFailure: true });
  });

  it("sends the token as a header rather than in the query string", async () => {
    const impl = vi.fn(async () => new Response(JSON.stringify(envelope({ list: [] })), { status: 200 }));
    const client = new TikTokClient({
      accessToken: "super-secret-token",
      fetchImpl: impl as unknown as typeof fetch,
      sleep: noSleep,
    });

    await client.get("campaign/get/", { advertiser_id: ADVERTISER });

    const [url, init] = impl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain("super-secret-token");
    expect((init.headers as Record<string, string>)["Access-Token"]).toBe("super-secret-token");
  });

  it("sends array parameters as JSON, which is the only form the API reads", async () => {
    const { impl, calls } = fakeFetch([envelope({ list: [] })]);
    const client = new TikTokClient({ accessToken: "t", fetchImpl: impl, sleep: noSleep });

    await client.get("report/integrated/get/", { metrics: ["spend", "clicks"] });

    expect(decodeURIComponent(calls[0])).toContain('metrics=["spend","clicks"]');
  });

  it("pages a list endpoint to the page count the response states", async () => {
    const { impl } = fakeFetch([
      envelope({ list: [{ campaign_id: "1" }], page_info: { page: 1, page_size: 1, total_number: 2, total_page: 2 } }),
      envelope({ list: [{ campaign_id: "2" }], page_info: { page: 2, page_size: 1, total_number: 2, total_page: 2 } }),
    ]);
    const client = new TikTokClient({ accessToken: "t", fetchImpl: impl, sleep: noSleep });

    const all = await client.getAll<{ campaign_id: string }>("campaign/get/", { advertiser_id: ADVERTISER }, 1);

    expect(all.map((item) => item.campaign_id)).toEqual(["1", "2"]);
  });
});

describe("degrading when a metric is refused", () => {
  /**
   * Which conversion metrics exist depends on the account's optimisation goal and pixel, and
   * TikTok fails the whole request if one is unknown. Importing spend without conversions
   * beats importing nothing — provided the caller is told what was lost.
   */
  it("retries with the core metrics and reports what was dropped", async () => {
    const { impl, calls } = fakeFetch([
      { code: 40002, message: "Invalid metrics: complete_payment_roas" },
      envelope({ list: [REPORT], page_info: { page: 1, page_size: 200, total_number: 1, total_page: 1 } }),
    ]);
    const client = new TikTokClient({ accessToken: "t", fetchImpl: impl, sleep: noSleep });

    const result = await reportWithFallback(client, {
      advertiserId: ADVERTISER,
      since: "2026-08-01",
      until: "2026-08-01",
      level: "advertiser",
      page: 1,
    });

    expect(result.rows).toHaveLength(1);
    expect(result.droppedMetrics).toContain("complete_payment_roas");
    expect(decodeURIComponent(calls[1])).toContain(JSON.stringify([...CORE_METRICS]));
  });

  /** Dropping metrics would not fix an expired token, and would hide the real cause. */
  it("does not retry an authentication failure", async () => {
    const { impl } = fakeFetch([{ code: 40105, message: "expired" }]);
    const client = new TikTokClient({ accessToken: "t", fetchImpl: impl, sleep: noSleep });

    await expect(
      reportWithFallback(client, {
        advertiserId: ADVERTISER,
        since: "2026-08-01",
        until: "2026-08-01",
        level: "advertiser",
        page: 1,
      }),
    ).rejects.toMatchObject({ isAuthFailure: true });
  });
});

describe("the report sync", () => {
  function seed(): Record<string, Row[]> {
    return {
      ad_accounts: [
        { id: ACCOUNT_ROW, organisation_id: ORGANISATION, platform: "tiktok", external_id: ADVERTISER },
      ],
      integration_connections: [{ id: "connection-1", organisation_id: ORGANISATION, provider: "tiktok" }],
      ad_entities: [],
      ad_daily_metrics: [],
      sync_runs: [],
      sync_cursors: [],
    };
  }

  function job(supabase: SupabaseClient, impl: typeof fetch, level: "advertiser" | "campaign" = "advertiser") {
    return buildTikTokReportSyncJob({
      client: new TikTokClient({ accessToken: "t", fetchImpl: impl, sleep: noSleep }),
      repository: createTikTokRepository(supabase, { organisationId: ORGANISATION }),
      connectionId: "connection-1",
      advertiserId: ADVERTISER,
      adAccountId: ACCOUNT_ROW,
      since: "2026-08-01",
      until: "2026-08-02",
      level,
      jobDiscriminator: "test",
    });
  }

  it("writes advertiser-level rows with a null entity, which is what the P&L reads", async () => {
    const { client: supabase, tables } = createFakeSupabase(seed());
    const second: TikTokReportRow = {
      dimensions: { ...REPORT.dimensions, stat_time_day: "2026-08-02 00:00:00" },
      metrics: REPORT.metrics,
    };
    const { impl } = fakeFetch([
      envelope({ list: [REPORT, second], page_info: { page: 1, page_size: 200, total_number: 2, total_page: 1 } }),
    ]);

    const outcome = await runSync(job(supabase as unknown as SupabaseClient, impl), createSupabaseSyncStore(supabase as unknown as SupabaseClient));

    expect(outcome.status).toBe("succeeded");
    expect(tables.ad_daily_metrics).toHaveLength(2);
    expect(tables.ad_daily_metrics[0].entity_id).toBeNull();
    expect(tables.ad_daily_metrics[0].attribution_window).toBe(ATTRIBUTION_KEY);
  });

  /**
   * The advertiser row for the day already carries this spend. Writing an unresolved entity
   * row with a null entity_id would file it as a second advertiser row and double the total —
   * the failure migration 0007 exists to repair for Meta.
   */
  it("skips an entity row whose campaign has not been synced rather than filing it as account level", async () => {
    const { client: supabase, tables } = createFakeSupabase(seed());
    const row: TikTokReportRow = {
      dimensions: { campaign_id: "not-synced", stat_time_day: "2026-08-01 00:00:00" },
      metrics: REPORT.metrics,
    };
    const { impl } = fakeFetch([
      envelope({ list: [row], page_info: { page: 1, page_size: 200, total_number: 1, total_page: 1 } }),
    ]);

    await runSync(job(supabase as unknown as SupabaseClient, impl, "campaign"), createSupabaseSyncStore(supabase as unknown as SupabaseClient));

    expect(tables.ad_daily_metrics).toHaveLength(0);
  });

  /** Re-importing a settled window must converge on one row per day, not accumulate rows. */
  it("upserts rather than duplicating when the same window is re-imported", async () => {
    const { client: supabase, tables } = createFakeSupabase(seed());
    const store = createSupabaseSyncStore(supabase as unknown as SupabaseClient);

    const first = fakeFetch([
      envelope({ list: [REPORT], page_info: { page: 1, page_size: 200, total_number: 1, total_page: 1 } }),
    ]);
    await runSync(job(supabase as unknown as SupabaseClient, first.impl), store);

    const restated: TikTokReportRow = {
      dimensions: REPORT.dimensions,
      metrics: { ...REPORT.metrics, complete_payment: "22" },
    };
    const second = fakeFetch([
      envelope({ list: [restated], page_info: { page: 1, page_size: 200, total_number: 1, total_page: 1 } }),
    ]);
    const outcome = await runSync(
      { ...job(supabase as unknown as SupabaseClient, second.impl), jobKey: "tiktok:report:advertiser:second" },
      store,
    );

    expect(outcome.status).toBe("succeeded");
    expect(tables.ad_daily_metrics).toHaveLength(1);
    expect(tables.ad_daily_metrics[0].purchases).toBe(22);
  });

  it("pages the report and stops at the stated page count", async () => {
    const { client: supabase, tables } = createFakeSupabase(seed());
    const second: TikTokReportRow = {
      dimensions: { ...REPORT.dimensions, stat_time_day: "2026-08-02 00:00:00" },
      metrics: REPORT.metrics,
    };
    const { impl } = fakeFetch([
      envelope({ list: [REPORT], page_info: { page: 1, page_size: 1, total_number: 2, total_page: 2 } }),
      envelope({ list: [second], page_info: { page: 2, page_size: 1, total_number: 2, total_page: 2 } }),
    ]);

    const outcome = await runSync(job(supabase as unknown as SupabaseClient, impl), createSupabaseSyncStore(supabase as unknown as SupabaseClient));

    expect(outcome).toMatchObject({ status: "succeeded", pages: 2 });
    expect(tables.ad_daily_metrics).toHaveLength(2);
  });
});

describe("the incremental window", () => {
  /** TikTok settles conversions over several days, so a one-day window would freeze them low. */
  it("reaches back over the restatement period", () => {
    expect(incrementalWindow("2026-08-10")).toEqual({ since: "2026-08-03", until: "2026-08-10" });
  });
});
