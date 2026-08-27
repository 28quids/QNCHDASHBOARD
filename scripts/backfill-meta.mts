/**
 * Imports Meta advertising data.
 *
 * The hierarchy syncs first, then insights at each level. That order matters: an insight row
 * whose campaign is not yet in `ad_entities` is written against the account with a null
 * entity, so its spend still reaches the P&L but cannot be attributed in the breakdown.
 *
 *   npm run backfill:meta -- --dry-run           # fetch and report, write nothing
 *   npm run backfill:meta -- --since 2026-01-01
 *   npm run backfill:meta                        # incremental, covering the restatement window
 */

import { createClient } from "@supabase/supabase-js";
import { connect, loadEnvFile, printTable, requireEnv } from "./lib/db.mjs";
import { decryptToken } from "@/lib/connectors/crypto";
import { MetaClient } from "@/lib/connectors/meta/client";
import { normaliseInsights, totalSpend } from "@/lib/connectors/meta/normalise";
import { insightParams } from "@/lib/connectors/meta/queries";
import {
  buildMetaHierarchySyncJob,
  buildMetaInsightsSyncJob,
  incrementalWindow,
} from "@/lib/connectors/meta/sync";
import type { MetaEntityLevel, MetaInsightRow } from "@/lib/connectors/meta/types";
import { createMetaRepository } from "@/lib/repositories/meta-repository";
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
let client: MetaClient;
let connectionId: string;
let adAccountId: string;
let accountExternalId: string;
let businessTimezone: string;

try {
  const { rows } = await db.query(
    `select c.id as connection_id, c.external_account_id, t.encrypted_refresh_token,
            a.id as ad_account_id, o.business_timezone
     from public.integration_connections c
     join public.integration_tokens t on t.connection_id = c.id
     join public.organisations o on o.id = c.organisation_id
     left join public.ad_accounts a
       on a.organisation_id = c.organisation_id and a.platform = 'meta'
      and a.external_id = c.external_account_id
     where c.organisation_id = $1 and c.provider = 'meta'
     limit 1`,
    [organisationId],
  );

  if (rows.length === 0) {
    console.error("No Meta connection registered. Run: npm run meta:connect");
    process.exit(1);
  }
  if (!rows[0].ad_account_id) {
    console.error("The connection exists but no ad_accounts row does. Re-run: npm run meta:connect");
    process.exit(1);
  }

  connectionId = rows[0].connection_id;
  accountExternalId = rows[0].external_account_id;
  adAccountId = rows[0].ad_account_id;
  businessTimezone = rows[0].business_timezone;
  client = new MetaClient({ accessToken: decryptToken(rows[0].encrypted_refresh_token as Buffer, encryptionKey) });
} finally {
  await db.end();
}

const today = toBusinessDate(new Date(), businessTimezone);
const incremental = incrementalWindow(today);
const since = flag("since") ?? incremental.since;
const until = flag("until") ?? today;

console.log(`Meta ${accountExternalId}  ${since} → ${until}`);
console.log(dryRun ? "Dry run: nothing will be written.\n" : "");

if (dryRun) {
  // One request at account level, reported and discarded. Enough to prove the token, the
  // scopes and the field set without touching the database.
  const page = await client.get<MetaInsightRow>(
    `${accountExternalId}/insights`,
    insightParams({ since, until, level: "account" }),
  );
  const rows = normaliseInsights(page.data, "account");

  if (rows.length === 0) {
    console.log("Meta returned no rows for this window. Either there was no spend, or the");
    console.log("account was not active. Widen the window with --since to check.");
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

const repository = createMetaRepository(supabase, { organisationId });
const store = createSupabaseSyncStore(supabase);
const discriminator = `${since}_${until}`;

console.log("--- hierarchy ---");
const hierarchy = await runSync(
  buildMetaHierarchySyncJob({
    client,
    repository,
    connectionId,
    accountExternalId,
    adAccountId,
    jobDiscriminator: today,
  }),
  store,
);
console.log(`status: ${hierarchy.status}`);
if (hierarchy.status === "succeeded") console.log(`  ${hierarchy.written} campaign/ad set/ad rows`);
if (hierarchy.status === "failed") console.error(`  ${hierarchy.error.message}`);

// Account level first: it is the row the P&L reads, so it must land even if a finer level fails.
const levels: (MetaEntityLevel | "account")[] = ["account", "campaign", "adset", "ad"];

for (const level of levels) {
  console.log(`\n--- insights: ${level} ---`);
  let unresolved = 0;

  const outcome = await runSync(
    buildMetaInsightsSyncJob({
      client,
      repository,
      connectionId,
      accountExternalId,
      adAccountId,
      since,
      until,
      level,
      jobDiscriminator: `${level}_${discriminator}`,
      onPagePersisted: (result) => {
        unresolved += result.unresolvedEntities;
        console.log(`  +${result.rows} rows`);
      },
    }),
    store,
  );

  console.log(`status: ${outcome.status}`);
  if (outcome.status === "succeeded") {
    console.log(`  pages ${outcome.pages}, received ${outcome.received}, written ${outcome.written}`);
    if (unresolved > 0) {
      console.log(`  ${unresolved} row(s) could not be attributed to a synced entity`);
    }
  }
  if (outcome.status === "failed") console.error(`  ${outcome.error.message}`);
}

console.log("\nNext: npm run calculate -- --from " + since + " --to " + until);
