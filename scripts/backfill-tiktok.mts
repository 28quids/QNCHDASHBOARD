/**
 * Imports TikTok advertising data.
 *
 * The hierarchy syncs first, then reports at each level. That order matters: a report row
 * whose campaign is not yet in `ad_entities` is skipped, so it is missing from the breakdown
 * until the hierarchy catches up. Its spend still reaches the P&L, because the
 * advertiser-level row for that day already contains it.
 *
 *   npm run backfill:tiktok -- --dry-run           # fetch and report, write nothing
 *   npm run backfill:tiktok -- --since 2026-01-01
 *   npm run backfill:tiktok                        # incremental, covering the restatement window
 */

import { createClient } from "@supabase/supabase-js";
import { connect, loadEnvFile, printTable, requireEnv } from "./lib/db.mjs";
import { decryptToken } from "@/lib/connectors/crypto";
import { TikTokClient } from "@/lib/connectors/tiktok/client";
import { normaliseReports, totalSpend } from "@/lib/connectors/tiktok/normalise";
import {
  buildTikTokHierarchySyncJob,
  buildTikTokReportSyncJob,
  incrementalWindow,
  reportWithFallback,
} from "@/lib/connectors/tiktok/sync";
import type { TikTokEntityLevel } from "@/lib/connectors/tiktok/types";
import { createTikTokRepository } from "@/lib/repositories/tiktok-repository";
import { createSupabaseSyncStore } from "@/lib/connectors/supabase-sync-store";
import { runSync } from "@/lib/connectors/sync-runner";
import { toBusinessDate } from "@/lib/financial/dates";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const env = loadEnvFile();
const organisationId = requireEnv("ORGANISATION_ID", env);
const encryptionKey = requireEnv("TOKEN_ENCRYPTION_KEY", env);

const db = await connect();
let client: TikTokClient;
let connectionId: string;
let adAccountId: string;
let advertiserId: string;
let businessTimezone: string;

try {
  const { rows } = await db.query(
    `select c.id as connection_id, c.external_account_id, t.encrypted_refresh_token,
            a.id as ad_account_id, o.business_timezone
     from public.integration_connections c
     join public.integration_tokens t on t.connection_id = c.id
     join public.organisations o on o.id = c.organisation_id
     left join public.ad_accounts a
       on a.organisation_id = c.organisation_id and a.platform = 'tiktok'
      and a.external_id = c.external_account_id
     where c.organisation_id = $1 and c.provider = 'tiktok'
     limit 1`,
    [organisationId],
  );

  if (rows.length === 0) {
    console.error("No TikTok connection registered. Run: npm run tiktok:connect");
    process.exit(1);
  }
  if (!rows[0].ad_account_id) {
    console.error("The connection exists but no ad_accounts row does. Re-run: npm run tiktok:connect");
    process.exit(1);
  }

  connectionId = rows[0].connection_id;
  advertiserId = rows[0].external_account_id;
  adAccountId = rows[0].ad_account_id;
  businessTimezone = rows[0].business_timezone;
  client = new TikTokClient({
    accessToken: decryptToken(rows[0].encrypted_refresh_token as Buffer, encryptionKey),
  });
} finally {
  await db.end();
}

const today = toBusinessDate(new Date(), businessTimezone);
const incremental = incrementalWindow(today);
const since = flag("since") ?? incremental.since;
const until = flag("until") ?? today;

console.log(`TikTok ${advertiserId}  ${since} → ${until}`);
console.log(dryRun ? "Dry run: nothing will be written.\n" : "");

if (dryRun) {
  // One request at advertiser level, reported and discarded. Enough to prove the token, the
  // authorisation and the metric set without touching the database.
  const page = await reportWithFallback(client, {
    advertiserId,
    since,
    until,
    level: "advertiser",
    page: 1,
  });
  const rows = normaliseReports(page.rows, "advertiser");

  if (page.droppedMetrics.length > 0) {
    console.log(`This account does not report: ${page.droppedMetrics.join(", ")}`);
    console.log("Spend and delivery will import; those conversion columns will be empty.\n");
  }

  if (rows.length === 0) {
    console.log("TikTok returned no rows for this window. Either there was no spend, or the");
    console.log("advertiser was not active. Widen the window with --since to check.");
    process.exit(0);
  }

  printTable(
    rows.slice(0, 14).map((row) => ({
      date: row.metricDate,
      spend: row.spend,
      impressions: row.impressions,
      clicks: row.clicks,
      purchases: row.purchases ?? "—",
      value: row.purchaseValue ?? "—",
    })),
  );
  console.log(`\n${rows.length} day(s), total spend ${totalSpend(rows)}.`);
  console.log("Nothing written. Re-run without --dry-run to import.");
  process.exit(0);
}

const supabase = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL", env),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY", env),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const repository = createTikTokRepository(supabase, { organisationId });
const store = createSupabaseSyncStore(supabase);
const discriminator = `${since}_${until}`;

console.log("--- hierarchy ---");
const hierarchy = await runSync(
  buildTikTokHierarchySyncJob({
    client,
    repository,
    connectionId,
    advertiserId,
    adAccountId,
    jobDiscriminator: today,
  }),
  store,
);
console.log(`status: ${hierarchy.status}`);
if (hierarchy.status === "succeeded") console.log(`  ${hierarchy.written} campaign/ad group/ad rows`);
if (hierarchy.status === "failed") console.error(`  ${hierarchy.error.message}`);

// Advertiser level first: it is the row the P&L reads, so it must land even if a finer level fails.
const levels: (TikTokEntityLevel | "advertiser")[] = ["advertiser", "campaign", "adgroup", "ad"];

for (const level of levels) {
  console.log(`\n--- report: ${level} ---`);
  let unresolved = 0;
  let dropped: readonly string[] = [];

  const outcome = await runSync(
    buildTikTokReportSyncJob({
      client,
      repository,
      connectionId,
      advertiserId,
      adAccountId,
      since,
      until,
      level,
      jobDiscriminator: `${level}_${discriminator}`,
      onPagePersisted: (result) => {
        unresolved += result.skippedUnresolvedEntities;
        dropped = result.droppedMetrics;
        console.log(`  +${result.rows} rows`);
      },
    }),
    store,
  );

  console.log(`status: ${outcome.status}`);
  if (outcome.status === "succeeded") {
    console.log(`  pages ${outcome.pages}, received ${outcome.received}, written ${outcome.written}`);
    if (dropped.length > 0) {
      console.log(`  metrics this account does not report: ${dropped.join(", ")}`);
    }
    if (unresolved > 0) {
      console.log(`  ${unresolved} row(s) skipped: no synced entity. Spend is in the advertiser row.`);
    }
  }
  if (outcome.status === "failed") console.error(`  ${outcome.error.message}`);
}

console.log("\nNext: npm run calculate -- --from " + since + " --to " + until);
