import { describe, expect, it, vi } from "vitest";
import Decimal from "decimal.js";
import {
  buildAssertion,
  createTokenProvider,
  normalisePrivateKey,
  requestAccessToken,
} from "@/lib/connectors/google/auth";
import { SheetsClient } from "@/lib/connectors/google/sheets-client";
import {
  buildWorkbook,
  columnName,
  rangeFor,
  rectangular,
  wholeTabRange,
} from "@/lib/reporting/sheets-workbook";
import { writeWorkbook } from "@/lib/reporting/sheets-export";
import { generateKeyPairSync } from "node:crypto";
import { zeroComponents } from "@/lib/financial/allocation";
import type { ControlCentreReport } from "@/lib/reporting/report";

const d = (value: string | number) => new Decimal(value);
const noSleep = () => Promise.resolve();

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const CREDENTIALS = { clientEmail: "qnch@example.iam.gserviceaccount.com", privateKey };

function report(overrides: Partial<ControlCentreReport["summary"]> = {}): ControlCentreReport {
  return {
    range: { from: "2026-08-01", to: "2026-08-31" },
    daily: [
      {
        businessDate: "2026-08-01",
        grossSales: d(1000),
        discounts: d(50),
        shippingRevenue: d(20),
        refunds: d(30),
        netRevenue: d(940),
        costs: {
          ...zeroComponents(),
          productCogs: d(300),
          packaging: d(10),
          inboundFreight: d(5),
          paymentProcessing: d(20),
          fulfilment: d(30),
          shipping: d(40),
        },
        cm1: d(605),
        cm1Margin: d("0.6436"),
        metaAdSpend: d(200),
        tiktokAdSpend: d(50),
        otherAcquisitionSpend: d(0),
        advertisingSpend: d(250),
        cm2: d(355),
        cm2Margin: d("0.3777"),
        cm3: d(285),
        cm3Margin: d("0.3032"),
        fixedOperatingCosts: d(0),
        operatingProfit: d(285),
        operatingMargin: d("0.3032"),
        orders: 20,
        newCustomers: 12,
        warnings: [],
      },
    ],
    allocated: [],
    skus: [
      {
        variantId: "v-1",
        sku: "ORANGE-30",
        unitsSold: 40,
        orders: 20,
        grossSales: d(1000),
        discounts: d(50),
        netRevenue: d(950),
        costs: {
          ...zeroComponents(),
          productCogs: d(300),
          packaging: d(10),
          inboundFreight: d(5),
          paymentProcessing: d(20),
          fulfilment: d(30),
          shipping: d(40),
        },
        contributionBeforeAds: d(615),
        contributionMargin: d("0.6474"),
        contributionAfterVariableOperating: d(545),
        revenueShare: d(1),
        perUnit: { netSellingPrice: d("23.75"), productCogs: d("7.50"), contributionBeforeAds: d("15.375") },
      },
    ],
    warnings: [],
    summary: {
      from: "2026-08-01",
      to: "2026-08-31",
      grossSales: d(1000),
      discounts: d(50),
      shippingRevenue: d(20),
      refunds: d(30),
      netRevenue: d(940),
      cm1: d(605),
      cm1Margin: d("0.6436"),
      metaAdSpend: d(200),
      tiktokAdSpend: d(50),
      advertisingSpend: d(250),
      cm2: d(355),
      cm2Margin: d("0.3777"),
      cm3: d(285),
      cm3Margin: d("0.3032"),
      fixedOperatingCosts: d(0),
      operatingProfit: d(285),
      operatingMargin: d("0.3032"),
      orders: 20,
      newCustomers: 12,
      averageOrderValue: d(47),
      warnings: [],
      ...overrides,
    },
    marketing: {
      advertisingSpend: d(250),
      mer: d("3.76"),
      blendedCac: d("20.83"),
      newCustomerRoas: d("2.1"),
      contributionLevel: "cm1",
      maximumCac: d(30),
      breakEvenRoas: d("2.5"),
      cacHeadroom: d("9.17"),
      roasHeadroom: d("1.26"),
      isAcquisitionViable: true,
      platforms: [
        { platform: "meta", spend: d(200), attributedPurchases: 8, attributedCac: d(25), attributedRoas: d(3) },
        { platform: "tiktok", spend: d(50), attributedPurchases: null, attributedCac: null, attributedRoas: null },
      ],
    },
  } as ControlCentreReport;
}

const workbookInput = (overrides = {}) => ({
  report: report(),
  generatedAt: "2026-09-01T03:00:00.000Z",
  today: "2026-09-01",
  ...overrides,
});

describe("service-account authentication", () => {
  /**
   * A .env file cannot hold a real newline, so the key almost always arrives with \\n written
   * out. Signing with it unrepaired fails with an opaque OpenSSL error saying nothing useful.
   */
  it("restores newlines that an environment variable flattened", () => {
    const flattened = privateKey.replace(/\n/g, "\\n");

    expect(normalisePrivateKey(flattened)).toBe(privateKey.trim());
  });

  it("rejects a value that is not a PEM key, with a message that says what to paste", () => {
    expect(() => normalisePrivateKey("not-a-key")).toThrow(/private_key/);
  });

  it("signs an assertion carrying the account, the scope and an expiry", () => {
    const assertion = buildAssertion({ credentials: CREDENTIALS, now: () => 1_700_000_000_000 });
    const [header, claims, signature] = assertion.split(".");

    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(claims, "base64url").toString());
    expect(payload).toMatchObject({
      iss: CREDENTIALS.clientEmail,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
    });
    expect(payload.exp - payload.iat).toBe(3600);
    expect(signature.length).toBeGreaterThan(0);
  });

  it("explains an invalid_grant rather than reporting a bare 400", async () => {
    const impl = vi.fn(
      async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    ) as unknown as typeof fetch;

    await expect(
      requestAccessToken({ credentials: CREDENTIALS, fetchImpl: impl, sleep: noSleep }),
    ).rejects.toThrow(/system clock/);
  });

  /** Every exchange costs a signature and a round trip; a dozen ranges should not need a dozen. */
  it("caches a token until shortly before it expires", async () => {
    const impl = vi.fn(
      async () => new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 }),
    );
    let clock = 1_000_000;
    const provider = createTokenProvider({
      credentials: CREDENTIALS,
      fetchImpl: impl as unknown as typeof fetch,
      sleep: noSleep,
      now: () => clock,
    });

    expect(await provider()).toBe("token");
    clock += 60_000;
    expect(await provider()).toBe("token");
    expect(impl).toHaveBeenCalledTimes(1);

    // Past expiry, a fresh token is fetched rather than a stale one reused.
    clock += 3_600_000;
    await provider();
    expect(impl).toHaveBeenCalledTimes(2);
  });
});

describe("A1 ranges", () => {
  it("names columns beyond Z", () => {
    expect(columnName(1)).toBe("A");
    expect(columnName(26)).toBe("Z");
    expect(columnName(27)).toBe("AA");
    expect(columnName(52)).toBe("AZ");
  });

  /** `03_DAILY_P&L!A1` is rejected by the API; the quoted form is not. */
  it("quotes a sheet name containing an ampersand", () => {
    expect(wholeTabRange("03_DAILY_P&L")).toBe("'03_DAILY_P&L'");
    expect(rangeFor({ title: "03_DAILY_P&L", rows: [["a", "b"]] })).toBe("'03_DAILY_P&L'!A1:B1");
  });

  it("sizes the range to the widest row", () => {
    expect(rangeFor({ title: "X", rows: [["a"], ["a", "b", "c"]] })).toBe("'X'!A1:C2");
  });

  /**
   * A ragged row is written short rather than blanked, leaving whatever was in the cells beyond
   * it — so yesterday's values would survive in the columns today's export no longer reaches.
   */
  it("pads every row to the same width", () => {
    expect(rectangular([["a"], ["a", "b"]])).toEqual([
      ["a", null],
      ["a", "b"],
    ]);
  });
});

describe("building the workbook", () => {
  it("produces the numbered tabs", () => {
    const titles = buildWorkbook(workbookInput()).map((tab) => tab.title);

    expect(titles).toContain("00_DASHBOARD");
    expect(titles).toContain("03_DAILY_P&L");
    expect(titles).toContain("14_DATA_QUALITY");
  });

  /** A column of "£1,234" sums to nothing, which defeats the point of a spreadsheet. */
  it("writes figures as numbers, not as formatted text", () => {
    const daily = buildWorkbook(workbookInput()).find((tab) => tab.title === "03_DAILY_P&L")!;

    expect(daily.rows[1][5]).toBe(940);
    expect(typeof daily.rows[1][5]).toBe("number");
  });

  /** CM3 relabelled as profit would be a misstatement, not an approximation. */
  it("leaves operating profit blank until fixed costs are configured", () => {
    const dashboard = buildWorkbook(workbookInput()).find((tab) => tab.title === "00_DASHBOARD")!;
    const row = dashboard.rows.find((cells) => cells[0] === "Operating profit")!;

    expect(row[1]).toBeNull();
    expect(row[3]).toBe("no fixed costs configured");
  });

  it("reports the balance as absent when none was reported", () => {
    const cash = buildWorkbook(workbookInput()).find((tab) => tab.title === "09_CASH")!;

    expect(cash.rows.some((row) => String(row[0]).includes("No bank balance"))).toBe(true);
  });

  /**
   * A platform's attributed ROAS is its own measurement of its own performance. Placing it
   * beside QNCH's figures without saying so is how a 4x platform ROAS gets read as a 4x result.
   */
  it("labels the platform figures as attribution claims", () => {
    const marketing = buildWorkbook(workbookInput()).find((tab) => tab.title === "05_MARKETING")!;

    expect(marketing.rows.some((row) => String(row[0]).includes("never used in contribution"))).toBe(true);
  });

  it("rolls the daily rows up by month through the engine", () => {
    const monthly = buildWorkbook(workbookInput()).find((tab) => tab.title === "04_MONTHLY_P&L")!;

    expect(monthly.rows[1][0]).toBe("2026-08");
    expect(monthly.rows[1][4]).toBe(940);
  });

  /** Dropping unattributed lines would make the SKU rows silently fail to sum to the P&L. */
  it("labels an unattributed SKU rather than omitting it", () => {
    const withUnattributed = report();
    withUnattributed.skus = [{ ...withUnattributed.skus[0], sku: null }];

    const tab = buildWorkbook(workbookInput({ report: withUnattributed })).find(
      (candidate) => candidate.title === "02_UNIT_ECONOMICS",
    )!;

    expect(tab.rows[1][0]).toBe("(unattributed)");
  });
});

describe("writing the workbook", () => {
  function fakeSheets(existing: { sheetId: number; title: string }[]) {
    const calls: { url: string; body: unknown }[] = [];

    const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      // The token request sends form-encoded data, not JSON, so the parse is guarded rather
      // than assumed — throwing here would look like a network failure and trigger real backoff.
      let body: unknown = null;
      try {
        body = init?.body ? JSON.parse(String(init.body)) : null;
      } catch {
        body = String(init?.body);
      }
      calls.push({ url: target, body });

      if (target.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
      }
      if (target.includes("values:batchUpdate")) {
        return new Response(JSON.stringify({ totalUpdatedCells: 42 }), { status: 200 });
      }
      if (target.includes("protectedRanges")) {
        return new Response(JSON.stringify({ sheets: existing.map((sheet) => ({ properties: sheet })) }), {
          status: 200,
        });
      }
      if (init?.method === "POST") return new Response(JSON.stringify({}), { status: 200 });

      return new Response(JSON.stringify({ sheets: existing.map((sheet) => ({ properties: sheet })) }), {
        status: 200,
      });
    });

    return { impl: impl as unknown as typeof fetch, calls };
  }

  const options = {
    organisationId: "org-1",
    businessTimezone: "Europe/London",
    today: "2026-09-01",
    range: { from: "2026-08-01", to: "2026-08-31" },
    spreadsheetId: "sheet-1",
    credentials: CREDENTIALS,
  };

  it("creates only the tabs the workbook does not already have", async () => {
    const { impl, calls } = fakeSheets([{ sheetId: 1, title: "00_DASHBOARD" }]);

    const result = await writeWorkbook(
      [
        { title: "00_DASHBOARD", rows: [["a"]] },
        { title: "09_CASH", rows: [["b"]] },
      ],
      { ...options, fetchImpl: impl },
    );

    expect(result).toMatchObject({ status: "exported", created: ["09_CASH"] });
    const addSheet = calls.find((call) => call.body && JSON.stringify(call.body).includes("addSheet"));
    expect(JSON.stringify(addSheet?.body)).toContain("09_CASH");
    expect(JSON.stringify(addSheet?.body)).not.toContain("00_DASHBOARD");
  });

  /**
   * A shorter export must not leave last night's rows underneath it. Stale rows that look like
   * current data are worse than no export at all.
   */
  it("clears each tab before rewriting it", async () => {
    const { impl, calls } = fakeSheets([{ sheetId: 1, title: "00_DASHBOARD" }]);

    await writeWorkbook([{ title: "00_DASHBOARD", rows: [["a"]] }], { ...options, fetchImpl: impl });

    const clear = calls.find((call) => call.url.includes("values:batchClear"));
    expect(JSON.stringify(clear?.body)).toContain("'00_DASHBOARD'");
  });

  /**
   * Under USER_ENTERED a SKU like `-ORANGE` becomes a formula error and a code like `1-2`
   * becomes a date, which silently corrupts imported data.
   */
  it("writes values raw rather than letting Sheets interpret them", async () => {
    const { impl, calls } = fakeSheets([{ sheetId: 1, title: "00_DASHBOARD" }]);

    await writeWorkbook([{ title: "00_DASHBOARD", rows: [["-ORANGE"]] }], { ...options, fetchImpl: impl });

    const update = calls.find((call) => call.url.includes("values:batchUpdate"));
    expect((update?.body as { valueInputOption: string }).valueInputOption).toBe("RAW");
  });

  /** Adding a protection every night would make the workbook unusable within a month. */
  it("does not re-protect a tab that is already protected", async () => {
    const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      if (target.includes("values:batchUpdate")) {
        return new Response(JSON.stringify({ totalUpdatedCells: 1 }), { status: 200 });
      }
      if (target.includes("protectedRanges")) {
        return new Response(
          JSON.stringify({
            sheets: [{ properties: { sheetId: 1, title: "00_DASHBOARD" }, protectedRanges: [{ range: { sheetId: 1 } }] }],
          }),
          { status: 200 },
        );
      }
      if (init?.method === "POST") return new Response("{}", { status: 200 });
      return new Response(
        JSON.stringify({ sheets: [{ properties: { sheetId: 1, title: "00_DASHBOARD" } }] }),
        { status: 200 },
      );
    });

    await writeWorkbook([{ title: "00_DASHBOARD", rows: [["a"]] }], {
      ...options,
      fetchImpl: impl as unknown as typeof fetch,
    });

    const calls = impl.mock.calls.map(([, init]) => (init?.body ? String(init.body) : ""));
    expect(calls.some((body) => body.includes("addProtectedRange"))).toBe(false);
  });

  /** 403 here is nearly always the workbook not being shared, which is invisible from GCP. */
  it("says what a 403 usually means", async () => {
    const impl = vi.fn(async (url: string | URL) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      return new Response("forbidden", { status: 403 });
    }) as unknown as typeof fetch;

    await expect(
      writeWorkbook([{ title: "00_DASHBOARD", rows: [["a"]] }], { ...options, fetchImpl: impl }),
    ).rejects.toThrow(/Share the spreadsheet with the service-account/);
  });
});

describe("the sheets client", () => {
  it("does nothing when asked to write no ranges", async () => {
    const impl = vi.fn() as unknown as typeof fetch;
    const client = new SheetsClient({
      spreadsheetId: "s",
      accessToken: async () => "t",
      fetchImpl: impl,
    });

    expect(await client.updateValues([])).toBe(0);
    expect(impl).not.toHaveBeenCalled();
  });
});
