import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  currentAccessToken,
  exchangeAuthorisationCode,
  XeroAuthError,
  type XeroTokens,
  type XeroTokenStore,
} from "@/lib/connectors/xero/oauth";
import { XeroClient } from "@/lib/connectors/xero/client";
import {
  normaliseAccount,
  normaliseBankSummary,
  normaliseBankTransaction,
  normaliseInvoice,
  parseXeroDate,
  parseXeroInstant,
  totalMovement,
} from "@/lib/connectors/xero/normalise";
import {
  buildXeroBankTransactionsSyncJob,
  buildXeroInvoicesSyncJob,
} from "@/lib/connectors/xero/sync";
import { createXeroRepository } from "@/lib/repositories/xero-repository";
import { runSync } from "@/lib/connectors/sync-runner";
import { createSupabaseSyncStore } from "@/lib/connectors/supabase-sync-store";
import { createFakeSupabase, type Row } from "./helpers/fake-supabase";
import type { XeroBankTransaction } from "@/lib/connectors/xero/types";

const ORGANISATION = "org-1";
const TIMEZONE = "Europe/London";
const noSleep = () => Promise.resolve();

const OAUTH = { clientId: "client", clientSecret: "secret", sleep: noSleep };

/** A store that records what it was asked to save, and can be made to fail on save. */
function fakeStore(initial: XeroTokens, options: { failOnSave?: boolean } = {}) {
  let tokens = initial;
  const saved: XeroTokens[] = [];
  let reauthReason: string | null = null;

  const store: XeroTokenStore = {
    load: async () => tokens,
    save: async (next) => {
      if (options.failOnSave) throw new Error("database unavailable");
      saved.push(next);
      tokens = next;
    },
    markNeedsReauth: async (reason) => {
      reauthReason = reason;
    },
  };
  return { store, saved, get reauthReason() { return reauthReason; } };
}

function tokenResponse(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("parsing Xero dates", () => {
  /**
   * Xero serialises dates the .NET way rather than as ISO strings. Parsing only one form leaves
   * an Invalid Date that reaches the database as null, so a transaction loses its day silently.
   */
  it("reads the .NET serialisation", () => {
    expect(parseXeroInstant("/Date(1476316800000+0000)/")).toBe("2016-10-13T00:00:00.000Z");
  });

  it("reads an ISO string, which the same fields sometimes carry", () => {
    expect(parseXeroInstant("2026-08-01T09:30:00Z")).toBe("2026-08-01T09:30:00.000Z");
  });

  /**
   * The milliseconds are already a UTC epoch and the trailing offset only says which timezone
   * the value was displayed in. Applying it would move the instant by that offset.
   */
  it("ignores the display offset rather than shifting the instant by it", () => {
    expect(parseXeroInstant("/Date(1476316800000+1300)/")).toBe(parseXeroInstant("/Date(1476316800000+0000)/"));
  });

  it("returns null for a missing or unparseable value rather than an invalid date", () => {
    expect(parseXeroInstant(undefined)).toBeNull();
    expect(parseXeroInstant("not a date")).toBeNull();
  });

  /** A payment made late on the 1st in London must not be reported on the 31st. */
  it("converts to the business day rather than to the UTC one", () => {
    expect(parseXeroDate("/Date(1685574000000+0000)/", "Europe/London")).toBe("2023-06-01");
  });
});

describe("normalising accounts", () => {
  it("keeps the bank account type, which is what the cash model filters on", () => {
    const result = normaliseAccount({
      AccountID: "a-1",
      Name: "Tide Current",
      Type: "BANK",
      Class: "ASSET",
      BankAccountType: "BANK",
      Status: "ACTIVE",
    });

    expect(result).toMatchObject({ externalId: "a-1", bankAccountType: "BANK", accountClass: "ASSET" });
  });

  /** Xero sends an empty string where a non-bank account has no type; that is not a value. */
  it("treats an empty bank account type as absent", () => {
    expect(normaliseAccount({ AccountID: "a-2", Name: "Software", BankAccountType: "" }).bankAccountType).toBeNull();
  });
});

describe("normalising bank transactions", () => {
  const transaction: XeroBankTransaction = {
    BankTransactionID: "t-1",
    Type: "SPEND",
    Status: "AUTHORISED",
    Date: "/Date(1785542400000+0000)/",
    Reference: "Meta Platforms",
    Total: 1200,
    SubTotal: 1000,
    TotalTax: 200,
    IsReconciled: true,
    BankAccount: { AccountID: "bank-1" },
    Contact: { Name: "Meta" },
    LineItems: [{ AccountID: "expense-1", AccountCode: "400", LineAmount: 1000, TaxAmount: 200 }],
  };

  it("separates the bank account from the expense account", () => {
    const result = normaliseBankTransaction(transaction, TIMEZONE);

    expect(result.bankAccountExternalId).toBe("bank-1");
    expect(result.accountExternalId).toBe("expense-1");
  });

  /**
   * A payment split across two expense accounts cannot be charged to either without putting
   * the whole amount in one bucket. The header carries no account and the lines hold the detail.
   */
  it("leaves the header account unset when the lines span several accounts", () => {
    const split = {
      ...transaction,
      LineItems: [
        { AccountID: "expense-1", LineAmount: 600 },
        { AccountID: "expense-2", LineAmount: 400 },
      ],
    };
    const result = normaliseBankTransaction(split, TIMEZONE);

    expect(result.accountExternalId).toBeNull();
    expect(result.lines).toHaveLength(2);
  });

  /**
   * The cash model signs on SPEND alone. Storing the raw type would make a SPEND-TRANSFER
   * count as money coming in.
   */
  it("collapses the transfer variants onto their direction", () => {
    expect(normaliseBankTransaction({ ...transaction, Type: "SPEND-TRANSFER" }, TIMEZONE).direction).toBe("SPEND");
    expect(normaliseBankTransaction({ ...transaction, Type: "RECEIVE-OVERPAYMENT" }, TIMEZONE).direction).toBe(
      "RECEIVE",
    );
    // The original is kept, so the collapse is auditable rather than lossy.
    expect(normaliseBankTransaction({ ...transaction, Type: "SPEND-TRANSFER" }, TIMEZONE).rawType).toBe(
      "SPEND-TRANSFER",
    );
  });

  it("nets spend against receipts without float drift", () => {
    const rows = [
      normaliseBankTransaction({ ...transaction, Total: 0.1 }, TIMEZONE),
      normaliseBankTransaction({ ...transaction, BankTransactionID: "t-2", Type: "RECEIVE", Total: 0.2 }, TIMEZONE),
    ];

    expect(totalMovement(rows)).toBe("0.10");
  });
});

describe("normalising invoices", () => {
  /** A credit note stored as a bill would inflate what QNCH appears to owe. */
  it("drops instruments that are not a bill or a sales invoice", () => {
    expect(normaliseInvoice({ InvoiceID: "i-1", Type: "ACCPAYCREDIT", Date: "/Date(1785542400000+0000)/" }, TIMEZONE)).toBeNull();
  });

  it("keeps bills and sales invoices with their amounts due", () => {
    const result = normaliseInvoice(
      {
        InvoiceID: "i-2",
        Type: "ACCPAY",
        Date: "/Date(1785542400000+0000)/",
        DueDate: "/Date(1788134400000+0000)/",
        Total: 500,
        AmountDue: 500,
        AmountPaid: 0,
        CurrencyCode: "GBP",
      },
      TIMEZONE,
    );

    expect(result).toMatchObject({ invoiceType: "ACCPAY", amountDue: "500.0000", amountPaid: "0.0000" });
  });

  /** An undated invoice cannot be placed on a cash timeline, and the column is not nullable. */
  it("drops an invoice with no date", () => {
    expect(normaliseInvoice({ InvoiceID: "i-3", Type: "ACCPAY" }, TIMEZONE)).toBeNull();
  });
});

describe("reading the bank summary report", () => {
  const report = {
    Reports: [
      {
        ReportName: "Bank Summary",
        Rows: [
          { RowType: "Header", Cells: [{ Value: "Bank Accounts" }, { Value: "Opening Balance" }] },
          {
            RowType: "Section",
            Rows: [
              {
                RowType: "Row",
                Cells: [
                  { Value: "Tide Current", Attributes: [{ Value: "bank-1", Id: "accountID" }] },
                  { Value: "1000.00" },
                  { Value: "5000.00" },
                  { Value: "3000.00" },
                  { Value: "3000.00" },
                ],
              },
              {
                RowType: "SummaryRow",
                Cells: [{ Value: "Total" }, { Value: "1000.00" }, { Value: "5000.00" }, { Value: "3000.00" }, { Value: "3000.00" }],
              },
            ],
          },
        ],
      },
    ],
  };

  it("takes the closing balance and the account it belongs to", () => {
    expect(normaliseBankSummary(report)).toEqual([
      { accountExternalId: "bank-1", closingBalance: "3000.0000", cashReceived: "5000.0000", cashSpent: "3000.0000" },
    ]);
  });

  /** The summary row carries no account id; counted as one it would double the balance. */
  it("ignores the header and the total row", () => {
    expect(normaliseBankSummary(report)).toHaveLength(1);
  });
});

describe("the refresh token rotation", () => {
  const expired: XeroTokens = {
    accessToken: "old-access",
    refreshToken: "refresh-1",
    expiresAt: new Date(1_000).toISOString(),
  };

  it("reuses a stored access token that has not expired", async () => {
    const impl = tokenResponse({});
    const { store, saved } = fakeStore({
      accessToken: "still-good",
      refreshToken: "refresh-1",
      expiresAt: new Date(10_000_000).toISOString(),
    });

    const token = await currentAccessToken(store, { ...OAUTH, fetchImpl: impl, now: () => 5_000_000 });

    expect(token).toBe("still-good");
    // Every rotation consumes one of a finite chain, so an unnecessary refresh is a real cost.
    expect(impl).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  /**
   * The single most dangerous behaviour in this connector. Xero invalidates the refresh token
   * that was used, so a rotated token that is not stored disconnects the tenant permanently.
   */
  it("persists the rotated refresh token before returning the access token", async () => {
    const impl = tokenResponse({ access_token: "new-access", refresh_token: "refresh-2", expires_in: 1800 });
    const { store, saved } = fakeStore(expired);

    const token = await currentAccessToken(store, { ...OAUTH, fetchImpl: impl, now: () => 2_000 });

    expect(token).toBe("new-access");
    expect(saved).toEqual([
      { accessToken: "new-access", refreshToken: "refresh-2", expiresAt: new Date(2_000 + 1_800_000).toISOString() },
    ]);
  });

  it("fails the call when the rotated token cannot be stored", async () => {
    const impl = tokenResponse({ access_token: "new-access", refresh_token: "refresh-2", expires_in: 1800 });
    const { store } = fakeStore(expired, { failOnSave: true });

    await expect(
      currentAccessToken(store, { ...OAUTH, fetchImpl: impl, now: () => 2_000 }),
    ).rejects.toThrow("database unavailable");
  });

  /**
   * A response with no refresh token means the authorisation lacked offline_access. Storing it
   * produces a connection that works for thirty minutes and then dies with no explanation.
   */
  it("refuses a token response that carries no refresh token", async () => {
    const impl = tokenResponse({ access_token: "new-access", expires_in: 1800 });
    const { store } = fakeStore(expired);

    await expect(currentAccessToken(store, { ...OAUTH, fetchImpl: impl, now: () => 2_000 })).rejects.toThrow(
      /offline_access/,
    );
  });

  /** invalid_grant means the token was already used, revoked or too old; retrying cannot help. */
  it("marks the connection for reauthorisation when the refresh token is rejected", async () => {
    const impl = tokenResponse({ error: "invalid_grant" }, 400);
    const fake = fakeStore(expired);

    await expect(
      currentAccessToken(fake.store, { ...OAUTH, fetchImpl: impl, now: () => 2_000 }),
    ).rejects.toBeInstanceOf(XeroAuthError);
    expect(fake.reauthReason).toContain("invalid_grant");
  });

  it("exchanges the authorisation code for the first token pair", async () => {
    const impl = tokenResponse({ access_token: "a", refresh_token: "r", expires_in: 1800 });

    const tokens = await exchangeAuthorisationCode("code", "https://example.test/callback", {
      ...OAUTH,
      fetchImpl: impl,
      now: () => 0,
    });

    expect(tokens).toMatchObject({ accessToken: "a", refreshToken: "r" });
  });
});

describe("the client", () => {
  function client(impl: typeof fetch, tokens?: Partial<XeroTokens>) {
    const { store } = fakeStore({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      ...tokens,
    });
    return new XeroClient({ ...OAUTH, tenantId: "tenant-1", store, fetchImpl: impl });
  }

  it("sends the tenant header, without which another organisation's data is returned", async () => {
    const impl = vi.fn(async () => new Response(JSON.stringify({ Accounts: [] }), { status: 200 }));
    await client(impl as unknown as typeof fetch).list("Accounts");

    const [, init] = impl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Xero-tenant-id"]).toBe("tenant-1");
  });

  /** 304 is the correct answer to a conditional request when nothing changed, not a failure. */
  it("treats a 304 as an empty result rather than parsing an empty body", async () => {
    // 304 is a null-body status, so the body must be null and not an empty string.
    const impl = vi.fn(async () => new Response(null, { status: 304 }));

    await expect(
      client(impl as unknown as typeof fetch).list("BankTransactions", {}, "2026-08-01T00:00:00Z"),
    ).resolves.toEqual({});
  });

  /**
   * A per-minute breach recovers in seconds. A daily one locks the tenant out until midnight,
   * so continuing to hammer it wastes the rest of the run for nothing.
   */
  it("abandons the run when the daily limit is reached", async () => {
    const impl = vi.fn(
      async () =>
        new Response(JSON.stringify({ Accounts: [] }), {
          status: 200,
          headers: { "X-Rate-Limit-Problem": "day" },
        }),
    );

    await expect(client(impl as unknown as typeof fetch).list("Accounts")).rejects.toThrow(/daily API limit/);
  });
});

describe("the bank transaction sync", () => {
  function seed(): Record<string, Row[]> {
    return {
      integration_connections: [{ id: "connection-1", organisation_id: ORGANISATION, provider: "xero" }],
      xero_accounts: [
        { id: "row-bank", organisation_id: ORGANISATION, external_id: "bank-1", name: "Tide" },
        { id: "row-expense", organisation_id: ORGANISATION, external_id: "expense-1", name: "Advertising" },
      ],
      xero_bank_transactions: [],
      xero_bank_transaction_lines: [],
      xero_invoices: [],
      sync_runs: [],
      sync_cursors: [],
    };
  }

  const transaction = (id: string, overrides: Partial<XeroBankTransaction> = {}): XeroBankTransaction => ({
    BankTransactionID: id,
    Type: "SPEND",
    Status: "AUTHORISED",
    Date: "/Date(1785542400000+0000)/",
    Total: 1200,
    SubTotal: 1000,
    TotalTax: 200,
    BankAccount: { AccountID: "bank-1" },
    LineItems: [{ AccountID: "expense-1", AccountCode: "400", LineAmount: 1000, TaxAmount: 200 }],
    ...overrides,
  });

  function pages(bodies: unknown[]) {
    return vi.fn(async () => {
      const body = bodies.shift() ?? { BankTransactions: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
  }

  function job(supabase: SupabaseClient, impl: typeof fetch) {
    const { store } = fakeStore({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    return buildXeroBankTransactionsSyncJob({
      client: new XeroClient({ ...OAUTH, tenantId: "tenant-1", store, fetchImpl: impl }),
      repository: createXeroRepository(supabase, { organisationId: ORGANISATION }),
      connectionId: "connection-1",
      businessTimezone: TIMEZONE,
      modifiedSince: null,
      runStartedAt: "2026-08-10T03:00:00.000Z",
      jobDiscriminator: "test",
    });
  }

  it("writes the transaction with its bank and expense accounts resolved", async () => {
    const { client: supabase, tables } = createFakeSupabase(seed());
    const impl = pages([
      { BankTransactions: [transaction("t-1")], pagination: { page: 1, pageSize: 100, pageCount: 1, itemCount: 1 } },
    ]);

    const outcome = await runSync(
      job(supabase as unknown as SupabaseClient, impl),
      createSupabaseSyncStore(supabase as unknown as SupabaseClient),
    );

    expect(outcome.status).toBe("succeeded");
    expect(tables.xero_bank_transactions).toHaveLength(1);
    expect(tables.xero_bank_transactions[0]).toMatchObject({
      xero_account_id: "row-expense",
      bank_xero_account_id: "row-bank",
      transaction_type: "SPEND",
      transaction_date: "2026-08-01",
    });
  });

  it("stores the lines, which is where a split transaction's cost lives", async () => {
    const { client: supabase, tables } = createFakeSupabase(seed());
    const split = transaction("t-2", {
      LineItems: [
        { AccountID: "expense-1", LineAmount: 600 },
        { AccountID: "expense-1", LineAmount: 400 },
      ],
    });
    const impl = pages([
      { BankTransactions: [split], pagination: { page: 1, pageSize: 100, pageCount: 1, itemCount: 1 } },
    ]);

    await runSync(
      job(supabase as unknown as SupabaseClient, impl),
      createSupabaseSyncStore(supabase as unknown as SupabaseClient),
    );

    expect(tables.xero_bank_transaction_lines).toHaveLength(2);
    expect(tables.xero_bank_transaction_lines.map((row) => row.line_number)).toEqual([1, 2]);
  });

  it("pages to the stated page count", async () => {
    const { client: supabase, tables } = createFakeSupabase(seed());
    const impl = pages([
      { BankTransactions: [transaction("t-1")], pagination: { page: 1, pageSize: 100, pageCount: 2, itemCount: 2 } },
      { BankTransactions: [transaction("t-2")], pagination: { page: 2, pageSize: 100, pageCount: 2, itemCount: 2 } },
    ]);

    const outcome = await runSync(
      job(supabase as unknown as SupabaseClient, impl),
      createSupabaseSyncStore(supabase as unknown as SupabaseClient),
    );

    expect(outcome).toMatchObject({ status: "succeeded", pages: 2 });
    expect(tables.xero_bank_transactions).toHaveLength(2);
  });

  /** Re-reading an already-imported window must restate rather than duplicate. */
  it("upserts on the Xero id so a re-read does not duplicate", async () => {
    const { client: supabase, tables } = createFakeSupabase(seed());
    const store = createSupabaseSyncStore(supabase as unknown as SupabaseClient);

    await runSync(
      job(
        supabase as unknown as SupabaseClient,
        pages([{ BankTransactions: [transaction("t-1")], pagination: { page: 1, pageSize: 100, pageCount: 1, itemCount: 1 } }]),
      ),
      store,
    );
    await runSync(
      {
        ...job(
          supabase as unknown as SupabaseClient,
          pages([
            {
              BankTransactions: [transaction("t-1", { Total: 1500 })],
              pagination: { page: 1, pageSize: 100, pageCount: 1, itemCount: 1 },
            },
          ]),
        ),
        jobKey: "xero:bank_transactions:second",
      },
      store,
    );

    expect(tables.xero_bank_transactions).toHaveLength(1);
    expect(tables.xero_bank_transactions[0].total).toBe("1500.0000");
  });
});

describe("the invoice sync", () => {
  /**
   * A page made entirely of credit notes is still a full page. Paging on what survived
   * normalisation rather than on what Xero returned would stop the sync there.
   */
  it("pages on what Xero returned, not on what survived normalisation", async () => {
    const { client: supabase, tables } = createFakeSupabase({
      integration_connections: [{ id: "connection-1", organisation_id: ORGANISATION, provider: "xero" }],
      xero_invoices: [],
      sync_runs: [],
      sync_cursors: [],
    });

    const creditNotes = Array.from({ length: 100 }, (_, index) => ({
      InvoiceID: `c-${index}`,
      Type: "ACCPAYCREDIT",
      Date: "/Date(1785542400000+0000)/",
    }));
    const bodies: unknown[] = [
      { Invoices: creditNotes, pagination: { page: 1, pageSize: 100, pageCount: 2, itemCount: 101 } },
      {
        Invoices: [{ InvoiceID: "i-1", Type: "ACCPAY", Date: "/Date(1785542400000+0000)/", Total: 10, AmountDue: 10 }],
        pagination: { page: 2, pageSize: 100, pageCount: 2, itemCount: 101 },
      },
    ];
    const impl = vi.fn(async () => new Response(JSON.stringify(bodies.shift() ?? { Invoices: [] }), { status: 200 }));

    const { store } = fakeStore({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const outcome = await runSync(
      buildXeroInvoicesSyncJob({
        client: new XeroClient({
          ...OAUTH,
          tenantId: "tenant-1",
          store,
          fetchImpl: impl as unknown as typeof fetch,
        }),
        repository: createXeroRepository(supabase as unknown as SupabaseClient, { organisationId: ORGANISATION }),
        connectionId: "connection-1",
        businessTimezone: TIMEZONE,
        modifiedSince: null,
        runStartedAt: "2026-08-10T03:00:00.000Z",
        jobDiscriminator: "test",
      }),
      createSupabaseSyncStore(supabase as unknown as SupabaseClient),
    );

    expect(outcome).toMatchObject({ status: "succeeded", pages: 2 });
    expect(tables.xero_invoices).toHaveLength(1);
  });
});
