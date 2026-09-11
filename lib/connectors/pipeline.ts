/**
 * The full refresh: fetch from every connected provider, then recalculate and publish.
 *
 * This is what "resync" means. The nightly job previously only recalculated, which quietly
 * meant the dashboard could never show an order or a pound of spend that arrived after the
 * last manual backfill — it recomputed the same stored facts every night and reported success.
 *
 * One entry point shared by the cron route and the dashboard button, so a manual refresh and
 * an automatic one cannot drift apart.
 *
 * Providers run in sequence and a failure in one does not stop the others: Meta being down
 * must not prevent Shopify orders from importing. Every outcome is returned, so a partial
 * refresh is reported as partial rather than as success.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { bytesFromStored, decryptToken } from "./crypto";
import { runSync, type SyncOutcome } from "./sync-runner";
import { createSupabaseSyncStore } from "./supabase-sync-store";
import { ShopifyClient } from "./shopify/client";
import {
  buildShopifyOrdersSyncJob,
  buildShopifyPayoutsSyncJob,
  buildShopifyVariantsSyncJob,
} from "./shopify/sync";
import { MetaClient } from "./meta/client";
import { buildMetaHierarchySyncJob, buildMetaInsightsSyncJob, incrementalWindow } from "./meta/sync";
import { TikTokClient } from "./tiktok/client";
import {
  buildTikTokHierarchySyncJob,
  buildTikTokReportSyncJob,
  incrementalWindow as tiktokIncrementalWindow,
} from "./tiktok/sync";
import { createShopifyRepository } from "@/lib/repositories/shopify-repository";
import { createMetaRepository } from "@/lib/repositories/meta-repository";
import { createTikTokRepository } from "@/lib/repositories/tiktok-repository";
import { XeroClient } from "./xero/client";
import { createSupabaseXeroTokenStore } from "./xero/token-store";
import { normaliseBankSummary } from "./xero/normalise";
import {
  buildXeroAccountsSyncJob,
  buildXeroBankTransactionsSyncJob,
  buildXeroInvoicesSyncJob,
} from "./xero/sync";
import { createXeroRepository } from "@/lib/repositories/xero-repository";
import { calculateAndPublish, type CalculationResult } from "@/lib/reporting/calculate";
import { runReconciliation } from "@/lib/reporting/reconcile";
import { collectDataQuality, persistDataQuality } from "@/lib/reporting/data-quality-run";
import { exportToSheets, type SheetsExportResult } from "@/lib/reporting/sheets-export";
import type { ReconciliationSummary } from "@/lib/monitoring/reconciliation";
import { addDays, toBusinessDate } from "@/lib/financial/dates";

/** Days republished on every run, to absorb late refunds and restated costs. */
const RECALCULATION_WINDOW_DAYS = 45;

/**
 * Days reconciled on every run.
 *
 * Longer than the recalculation window on purpose. Settlements lag orders and advertising is
 * billed in arrears, so a short window is mostly timing difference and reports a discrepancy
 * every night. A month is long enough for the lag to wash out of both sides.
 */
const RECONCILIATION_WINDOW_DAYS = 30;

export interface RefreshOptions {
  organisationId: string;
  businessTimezone: string;
  encryptionKey: string;
  /**
   * Distinguishes this run from another. Re-running the same value is a deliberate no-op,
   * which is what makes a retried cron safe. Defaults to the current minute so a manual
   * refresh is never silently skipped, while a repeated cron on the same day is.
   */
  jobDiscriminator?: string;
}

export interface RefreshResult {
  startedAt: string;
  finishedAt: string;
  today: string;
  syncs: { provider: string; resource: string; outcome: SyncOutcome }[];
  calculation: CalculationResult | null;
  /**
   * What the independent sources disagreed about, or null when the checks could not run.
   *
   * A reconciliation failure never fails the refresh: the numbers still imported, and the
   * finding is the point. Suppressing it because the run "succeeded" is how a discrepancy goes
   * unnoticed for a quarter.
   */
  reconciliation: ReconciliationSummary | null;
  /** Number of data-quality results recorded, or null when collecting them failed. */
  dataQualityChecks: number | null;
  /** The Google Sheets export, or null when it is not configured or failed. */
  sheets: SheetsExportResult | null;
  /** True when every sync succeeded or was skipped as already done. */
  allSucceeded: boolean;
}

interface ProviderConnection {
  id: string;
  provider: string;
  externalAccountId: string;
  token: string;
}

/** A connection that exists and cannot be used, with the reason, so it is reported not dropped. */
interface UnusableConnection {
  id: string;
  provider: string;
  reason: string;
}

/**
 * The stored ciphertext out of an embedded `integration_tokens` row.
 *
 * PostgREST decides an embed's cardinality from the constraints, and `connection_id` is both the
 * primary key of `integration_tokens` and a foreign key to `integration_connections` — so the
 * relationship is one-to-one and the embed arrives as an **object**, not an array of one.
 *
 * Handling only the array shape is how every connection came to be silently skipped: the guard
 * read `undefined`, concluded the connection had no token, and dropped it. Both shapes are
 * accepted here because the cardinality PostgREST infers is not something this code should be
 * betting on.
 */
export function readEncryptedToken(embedded: unknown): string | null {
  if (!embedded) return null;

  const row = Array.isArray(embedded) ? embedded[0] : embedded;
  const token = (row as { encrypted_refresh_token?: string } | undefined)?.encrypted_refresh_token;

  return typeof token === "string" && token.length > 0 ? token : null;
}

async function loadConnections(
  client: SupabaseClient,
  organisationId: string,
  encryptionKey: string,
): Promise<{ usable: ProviderConnection[]; unusable: UnusableConnection[] }> {
  const { data, error } = await client
    .from("integration_connections")
    .select("id, provider, external_account_id, status, integration_tokens(encrypted_refresh_token)")
    .eq("organisation_id", organisationId)
    .eq("status", "active");
  if (error) throw error;

  const usable: ProviderConnection[] = [];
  const unusable: UnusableConnection[] = [];

  for (const row of data ?? []) {
    const id = row.id as string;
    const provider = row.provider as string;
    const encrypted = readEncryptedToken(row.integration_tokens);

    if (!encrypted) {
      unusable.push({ id, provider, reason: "no stored token; re-run the connect script" });
      continue;
    }

    try {
      usable.push({
        id,
        provider,
        externalAccountId: row.external_account_id as string,
        token: decryptToken(bytesFromStored(encrypted), encryptionKey),
      });
    } catch {
      // Almost always TOKEN_ENCRYPTION_KEY differing from the one that encrypted it. Reported
      // rather than thrown, so one unreadable provider does not abandon the others — but
      // reported, because a refresh that quietly skipped a provider looks like a clean run.
      unusable.push({
        id,
        provider,
        reason: "stored token could not be decrypted; TOKEN_ENCRYPTION_KEY does not match the one that encrypted it",
      });
    }
  }

  return { usable, unusable };
}

export async function refreshEverything(
  client: SupabaseClient,
  options: RefreshOptions,
): Promise<RefreshResult> {
  const startedAt = new Date().toISOString();
  const today = toBusinessDate(new Date(), options.businessTimezone);
  const discriminator = options.jobDiscriminator ?? startedAt.slice(0, 16);

  const store = createSupabaseSyncStore(client);
  const { usable, unusable } = await loadConnections(client, options.organisationId, options.encryptionKey);
  const syncs: RefreshResult["syncs"] = [];

  // A connection that exists and cannot be used is a failure of this run, not an absence. It was
  // previously dropped in silence, which made a refresh that synced nothing report success.
  for (const connection of unusable) {
    syncs.push({
      provider: connection.provider,
      resource: "connection",
      outcome: {
        status: "failed",
        jobKey: `${connection.provider}:connection`,
        pages: 0,
        received: 0,
        written: 0,
        error: new Error(connection.reason),
      },
    });
  }

  for (const connection of usable) {
    try {
      if (connection.provider === "shopify") {
        syncs.push(...(await refreshShopify(client, store, connection, options, today, discriminator)));
      } else if (connection.provider === "meta") {
        syncs.push(...(await refreshMeta(client, store, connection, options, today, discriminator)));
      } else if (connection.provider === "tiktok") {
        syncs.push(...(await refreshTikTok(client, store, connection, options, today, discriminator)));
      } else if (connection.provider === "xero") {
        syncs.push(...(await refreshXero(client, store, connection, options, today, discriminator)));
      }
    } catch (caught) {
      // A provider that throws outside runSync — a bad token, a missing account row — is
      // recorded as a failed outcome so the refresh reports it rather than losing it.
      const error = caught instanceof Error ? caught : new Error(String(caught));
      syncs.push({
        provider: connection.provider,
        resource: "connection",
        outcome: { status: "failed", jobKey: `${connection.provider}:setup`, pages: 0, received: 0, written: 0, error },
      });
    }
  }

  // Recalculated even when a sync failed, so the dashboard still reflects whatever did
  // arrive. The data-quality page is what says a provider is stale.
  const calculation = await calculateAndPublish(client, {
    organisationId: options.organisationId,
    businessTimezone: options.businessTimezone,
    range: { from: addDays(today, -(RECALCULATION_WINDOW_DAYS - 1)), to: today },
  });

  // Reconciliation and data quality run after the recalculation and never block it. Both are
  // observations about the data rather than steps that produce it, so a failure to make an
  // observation must not discard the import that was just completed.
  const reconciliationWindow = { from: addDays(today, -(RECONCILIATION_WINDOW_DAYS - 1)), to: today };

  const reconciliation = await runReconciliation(client, {
    organisationId: options.organisationId,
    businessTimezone: options.businessTimezone,
    range: reconciliationWindow,
  }).catch((error: unknown) => {
    console.error(`Reconciliation failed: ${(error as Error).message}`);
    return null;
  });

  const dataQualityChecks = await collectDataQuality(client, {
    organisationId: options.organisationId,
    businessTimezone: options.businessTimezone,
    today,
  })
    .then((results) => persistDataQuality(client, options.organisationId, results))
    .catch((error: unknown) => {
      console.error(`Data-quality collection failed: ${(error as Error).message}`);
      return null;
    });

  // Last, and never allowed to fail the run. The canonical data is already in Supabase; the
  // workbook is a copy of it, and a copy that could not be written must not discard the import
  // that produced it.
  const sheets = await exportWorkbook(client, options, today).catch((error: unknown) => {
    console.error(`Sheets export failed: ${(error as Error).message}`);
    return null;
  });

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    today,
    syncs,
    calculation,
    reconciliation,
    dataQualityChecks,
    sheets,
    allSucceeded: syncs.every((sync) => sync.outcome.status !== "failed"),
  };
}

async function refreshShopify(
  client: SupabaseClient,
  store: ReturnType<typeof createSupabaseSyncStore>,
  connection: ProviderConnection,
  options: RefreshOptions,
  today: string,
  discriminator: string,
): Promise<RefreshResult["syncs"]> {
  const shopify = new ShopifyClient({
    shopDomain: connection.externalAccountId,
    accessToken: connection.token,
  });
  const repository = createShopifyRepository(client, { organisationId: options.organisationId });

  // Catalogue first. Order lines resolve their variant against `product_variants`, so running
  // orders into a stale catalogue writes new SKUs unattributed.
  const variants = await runSync(
    buildShopifyVariantsSyncJob({
      client: shopify,
      repository,
      connectionId: connection.id,
      jobDiscriminator: discriminator,
    }),
    store,
  );

  // Bounded by updatedAt, not createdAt, so an old order edited today — refunded, say — is
  // picked up. The stored cursor is what makes this incremental rather than a full re-read.
  const previousWatermark = await store.getCursor(connection.id, "orders");
  const orders = await runSync(
    buildShopifyOrdersSyncJob({
      client: shopify,
      repository,
      connectionId: connection.id,
      businessTimezone: options.businessTimezone,
      updatedSince: previousWatermark ? null : addDays(today, -30),
      jobDiscriminator: discriminator,
    }),
    store,
  );

  // Settlements, for the revenue reconciliation. Nothing in the contribution walk reads them:
  // a payout is money arriving days after the orders that produced it, so counting it as
  // revenue would report the same sale twice on two different dates.
  const payouts = await runSync(
    buildShopifyPayoutsSyncJob({
      client: shopify,
      repository,
      connectionId: connection.id,
      businessTimezone: options.businessTimezone,
      jobDiscriminator: discriminator,
    }),
    store,
  );

  return [
    { provider: "shopify", resource: "variants", outcome: variants },
    { provider: "shopify", resource: "orders", outcome: orders },
    { provider: "shopify", resource: "payouts", outcome: payouts },
  ];
}

async function refreshMeta(
  client: SupabaseClient,
  store: ReturnType<typeof createSupabaseSyncStore>,
  connection: ProviderConnection,
  options: RefreshOptions,
  today: string,
  discriminator: string,
): Promise<RefreshResult["syncs"]> {
  const adAccountId = await findAdAccount(client, options.organisationId, "meta", connection.externalAccountId);

  const meta = new MetaClient({ accessToken: connection.token });
  const repository = createMetaRepository(client, { organisationId: options.organisationId });
  const window = incrementalWindow(today);

  const hierarchy = await runSync(
    buildMetaHierarchySyncJob({
      client: meta,
      repository,
      connectionId: connection.id,
      accountExternalId: connection.externalAccountId,
      adAccountId,
      jobDiscriminator: discriminator,
    }),
    store,
  );

  const outcomes: RefreshResult["syncs"] = [
    { provider: "meta", resource: "entities", outcome: hierarchy },
  ];

  // Account level is what the P&L reads, so it runs first and must land even if a finer
  // level fails. The finer levels only feed the marketing breakdown.
  for (const level of ["account", "campaign", "adset", "ad"] as const) {
    const outcome = await runSync(
      buildMetaInsightsSyncJob({
        client: meta,
        repository,
        connectionId: connection.id,
        accountExternalId: connection.externalAccountId,
        adAccountId,
        since: window.since,
        until: window.until,
        level,
        jobDiscriminator: `${level}_${discriminator}`,
      }),
      store,
    );
    outcomes.push({ provider: "meta", resource: `insights:${level}`, outcome });
  }

  return outcomes;
}

async function refreshTikTok(
  client: SupabaseClient,
  store: ReturnType<typeof createSupabaseSyncStore>,
  connection: ProviderConnection,
  options: RefreshOptions,
  today: string,
  discriminator: string,
): Promise<RefreshResult["syncs"]> {
  const adAccountId = await findAdAccount(client, options.organisationId, "tiktok", connection.externalAccountId);

  const tiktok = new TikTokClient({ accessToken: connection.token });
  const repository = createTikTokRepository(client, { organisationId: options.organisationId });
  const window = tiktokIncrementalWindow(today);

  const hierarchy = await runSync(
    buildTikTokHierarchySyncJob({
      client: tiktok,
      repository,
      connectionId: connection.id,
      advertiserId: connection.externalAccountId,
      adAccountId,
      jobDiscriminator: discriminator,
    }),
    store,
  );

  const outcomes: RefreshResult["syncs"] = [
    { provider: "tiktok", resource: "entities", outcome: hierarchy },
  ];

  // Advertiser level is what the P&L reads, so it runs first and must land even if a finer
  // level fails. The finer levels only feed the marketing breakdown.
  for (const level of ["advertiser", "campaign", "adgroup", "ad"] as const) {
    const outcome = await runSync(
      buildTikTokReportSyncJob({
        client: tiktok,
        repository,
        connectionId: connection.id,
        advertiserId: connection.externalAccountId,
        adAccountId,
        since: window.since,
        until: window.until,
        level,
        jobDiscriminator: `${level}_${discriminator}`,
      }),
      store,
    );
    outcomes.push({ provider: "tiktok", resource: `report:${level}`, outcome });
  }

  return outcomes;
}

/**
 * The `ad_accounts` row a connection refers to.
 *
 * Absent means the connect script was never run to completion, and every metric written
 * against a guessed id would be unreadable. Throwing here is caught by the caller and reported
 * as a failed provider rather than losing the run.
 */
async function findAdAccount(
  client: SupabaseClient,
  organisationId: string,
  platform: "meta" | "tiktok",
  externalId: string,
): Promise<string> {
  const { data, error } = await client
    .from("ad_accounts")
    .select("id")
    .eq("organisation_id", organisationId)
    .eq("platform", platform)
    .eq("external_id", externalId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`No ad_accounts row for ${platform} ${externalId}`);

  return data.id as string;
}

/**
 * Xero: chart of accounts, bank transactions, bills, then the reported bank balance.
 *
 * The account sync runs first and the rest depend on it — a transaction resolves its bank and
 * expense accounts against `xero_accounts`, so running into an empty chart writes rows that
 * are visible in cash and invisible in the P&L.
 *
 * The bank balance is fetched last and outside `runSync`, because it is a report rather than a
 * collection: there is nothing to page, nothing to upsert incrementally and no cursor to
 * advance. It is still recorded as an outcome so a failure is visible rather than assumed.
 */
async function refreshXero(
  client: SupabaseClient,
  store: ReturnType<typeof createSupabaseSyncStore>,
  connection: ProviderConnection,
  options: RefreshOptions,
  today: string,
  discriminator: string,
): Promise<RefreshResult["syncs"]> {
  const environment = xeroEnvironment();
  if (!environment) {
    throw new Error("XERO_CLIENT_ID and XERO_CLIENT_SECRET are not configured");
  }

  const xero = new XeroClient({
    clientId: environment.clientId,
    clientSecret: environment.clientSecret,
    // For Xero the external account id *is* the tenant id: one authorisation can cover several
    // organisations, and the tenant is what picks between them.
    tenantId: connection.externalAccountId,
    store: createSupabaseXeroTokenStore(client, {
      connectionId: connection.id,
      encryptionKey: options.encryptionKey,
    }),
  });
  const repository = createXeroRepository(client, { organisationId: options.organisationId });
  const runStartedAt = new Date().toISOString();

  const shared = { client: xero, repository, connectionId: connection.id, jobDiscriminator: discriminator };

  const accounts = await runSync(buildXeroAccountsSyncJob(shared), store);
  const outcomes: RefreshResult["syncs"] = [{ provider: "xero", resource: "accounts", outcome: accounts }];

  // The previous watermark, which is what makes this incremental. Absent on a first run, which
  // then reads the whole ledger — correct, and only expensive once.
  const transactionWatermark = await store.getCursor(connection.id, "bank_transactions");
  outcomes.push({
    provider: "xero",
    resource: "bank_transactions",
    outcome: await runSync(
      buildXeroBankTransactionsSyncJob({
        ...shared,
        businessTimezone: options.businessTimezone,
        modifiedSince: transactionWatermark,
        runStartedAt,
      }),
      store,
    ),
  });

  const invoiceWatermark = await store.getCursor(connection.id, "invoices");
  outcomes.push({
    provider: "xero",
    resource: "invoices",
    outcome: await runSync(
      buildXeroInvoicesSyncJob({
        ...shared,
        businessTimezone: options.businessTimezone,
        modifiedSince: invoiceWatermark,
        runStartedAt,
      }),
      store,
    ),
  });

  outcomes.push({
    provider: "xero",
    resource: "bank_balances",
    outcome: await syncBankBalances(xero, repository, today, discriminator),
  });

  return outcomes;
}

/**
 * The closing balance per bank account, from Xero's Bank Summary report.
 *
 * Without this the cash page has no balance at all: a running total of imported movements is
 * not one, and presenting it as one is the specific error the brief asks the system to avoid.
 */
async function syncBankBalances(
  client: XeroClient,
  repository: ReturnType<typeof createXeroRepository>,
  today: string,
  discriminator: string,
): Promise<SyncOutcome> {
  const jobKey = `xero:bank_balances:${discriminator}`;

  try {
    const report = await client.report("BankSummary", { fromDate: today, toDate: today });
    const balances = normaliseBankSummary(report);
    const written = await repository.persistBankBalances(balances, today);

    return { status: "succeeded", jobKey, pages: 1, received: balances.length, written };
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    return { status: "failed", jobKey, pages: 1, received: 0, written: 0, error };
  }
}

/**
 * Xero's app credentials, which unlike the other providers are not stored per connection.
 *
 * They identify QNCH's own OAuth application rather than the tenant, so they belong in the
 * environment. Returns null rather than throwing, so the caller reports a misconfigured Xero
 * as one failed provider instead of aborting the whole refresh.
 */
function xeroEnvironment(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Days of the P&L written into the workbook. Long enough to read a quarter's shape. */
const SHEETS_WINDOW_DAYS = 90;

/**
 * Writes the Google Sheets workbook, when it is configured.
 *
 * Returns null rather than throwing when the credentials are absent: an organisation that has
 * not set up Sheets is not in an error state, and reporting one would bury the refreshes that
 * did work under a failure about an optional surface.
 */
async function exportWorkbook(
  client: SupabaseClient,
  options: RefreshOptions,
  today: string,
): Promise<SheetsExportResult | null> {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!spreadsheetId || !clientEmail || !privateKey) return null;

  return exportToSheets(client, {
    organisationId: options.organisationId,
    businessTimezone: options.businessTimezone,
    today,
    range: { from: addDays(today, -(SHEETS_WINDOW_DAYS - 1)), to: today },
    spreadsheetId,
    credentials: { clientEmail, privateKey },
  });
}
