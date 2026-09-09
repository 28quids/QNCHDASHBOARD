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
import { decryptToken } from "./crypto";
import { runSync, type SyncOutcome } from "./sync-runner";
import { createSupabaseSyncStore } from "./supabase-sync-store";
import { ShopifyClient } from "./shopify/client";
import { buildShopifyOrdersSyncJob, buildShopifyVariantsSyncJob } from "./shopify/sync";
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
import { calculateAndPublish, type CalculationResult } from "@/lib/reporting/calculate";
import { addDays, toBusinessDate } from "@/lib/financial/dates";

/** Days republished on every run, to absorb late refunds and restated costs. */
const RECALCULATION_WINDOW_DAYS = 45;

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
  /** True when every sync succeeded or was skipped as already done. */
  allSucceeded: boolean;
}

interface ProviderConnection {
  id: string;
  provider: string;
  externalAccountId: string;
  token: string;
}

async function loadConnections(
  client: SupabaseClient,
  organisationId: string,
  encryptionKey: string,
): Promise<ProviderConnection[]> {
  const { data, error } = await client
    .from("integration_connections")
    .select("id, provider, external_account_id, status, integration_tokens(encrypted_refresh_token)")
    .eq("organisation_id", organisationId)
    .eq("status", "active");
  if (error) throw error;

  return (data ?? []).flatMap((row) => {
    const tokens = row.integration_tokens as unknown as { encrypted_refresh_token: string }[] | null;
    const encrypted = Array.isArray(tokens) ? tokens[0]?.encrypted_refresh_token : undefined;
    // A connection with no stored token cannot be used. Skipped rather than throwing, so one
    // half-configured provider does not block the rest of the refresh.
    if (!encrypted) return [];

    return [
      {
        id: row.id as string,
        provider: row.provider as string,
        externalAccountId: row.external_account_id as string,
        // Supabase returns bytea as a hex string over PostgREST, not as a Buffer.
        token: decryptToken(toBuffer(encrypted), encryptionKey),
      },
    ];
  });
}

/** PostgREST renders bytea as `\x<hex>`; pg would have given a Buffer directly. */
function toBuffer(value: string | Buffer): Buffer {
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.startsWith("\\x") ? value.slice(2) : value, "hex");
}

export async function refreshEverything(
  client: SupabaseClient,
  options: RefreshOptions,
): Promise<RefreshResult> {
  const startedAt = new Date().toISOString();
  const today = toBusinessDate(new Date(), options.businessTimezone);
  const discriminator = options.jobDiscriminator ?? startedAt.slice(0, 16);

  const store = createSupabaseSyncStore(client);
  const connections = await loadConnections(client, options.organisationId, options.encryptionKey);
  const syncs: RefreshResult["syncs"] = [];

  for (const connection of connections) {
    try {
      if (connection.provider === "shopify") {
        syncs.push(...(await refreshShopify(client, store, connection, options, today, discriminator)));
      } else if (connection.provider === "meta") {
        syncs.push(...(await refreshMeta(client, store, connection, options, today, discriminator)));
      } else if (connection.provider === "tiktok") {
        syncs.push(...(await refreshTikTok(client, store, connection, options, today, discriminator)));
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

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    today,
    syncs,
    calculation,
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

  return [
    { provider: "shopify", resource: "variants", outcome: variants },
    { provider: "shopify", resource: "orders", outcome: orders },
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
