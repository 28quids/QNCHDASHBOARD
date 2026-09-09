/**
 * Registers a TikTok advertiser account as an integration connection and stores its token
 * encrypted.
 *
 * The token is verified against the API before anything is written, so a wrong app, a missing
 * advertiser assignment or a revoked token fails here with an explanation rather than half way
 * through a backfill.
 *
 *   npm run tiktok:connect                 # uses the advertiser in TIKTOK_ADVERTISER_ID
 *   npm run tiktok:connect -- --list       # show every advertiser this token can reach
 *
 * Required in .env.local: TIKTOK_ACCESS_TOKEN, TIKTOK_APP_ID, TIKTOK_APP_SECRET.
 * The app id and secret are needed only to list advertisers — TikTok scopes that call to the
 * app rather than to the token alone — and are never stored.
 */

import { connect, loadEnvFile, requireEnv } from "./lib/db.mjs";
import { encryptToken, CURRENT_KEY_VERSION } from "@/lib/connectors/crypto";
import { TikTokApiError, TikTokClient } from "@/lib/connectors/tiktok/client";
import { TIKTOK_API_VERSION, type TikTokAdvertiser, type TikTokList } from "@/lib/connectors/tiktok/types";

const listOnly = process.argv.includes("--list");

const env = loadEnvFile();
const accessToken = requireEnv("TIKTOK_ACCESS_TOKEN", env);
const appId = requireEnv("TIKTOK_APP_ID", env);
const appSecret = requireEnv("TIKTOK_APP_SECRET", env);
const encryptionKey = requireEnv("TOKEN_ENCRYPTION_KEY", env);
const organisationId = requireEnv("ORGANISATION_ID", env);
const requestedAdvertiser = env.TIKTOK_ADVERTISER_ID;

const client = new TikTokClient({ accessToken });

/** Reports what the token can actually see, which is the fastest way to diagnose a scope gap. */
async function listAdvertisers(): Promise<TikTokAdvertiser[]> {
  try {
    const data = await client.get<TikTokList<TikTokAdvertiser>>("oauth2/advertiser/get/", {
      app_id: appId,
      secret: appSecret,
    });
    return data.list ?? [];
  } catch (error) {
    if (error instanceof TikTokApiError && error.isAuthFailure) {
      console.error(`TikTok rejected the token: ${error.message}\n`);
      console.error("Common causes, in the order they usually bite:");
      console.error("  1. TIKTOK_APP_ID / TIKTOK_APP_SECRET belong to a different app than the");
      console.error("     one the token was issued for. The three must match.");
      console.error("  2. The advertiser account was never authorised for the app. Re-run the");
      console.error("     authorisation link from the TikTok developer portal and approve it.");
      console.error("  3. The token was revoked, which happens when the authorising user loses");
      console.error("     access to the advertiser account.");
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Currency and timezone, which the advertiser list does not carry.
 *
 * Requested separately and treated as optional: without them the connection is still usable,
 * but the mismatch warnings below cannot be made, so a failure here is reported rather than
 * silently producing a connection that looks fully checked.
 */
async function advertiserDetail(advertiserId: string): Promise<TikTokAdvertiser | null> {
  try {
    const data = await client.get<TikTokList<TikTokAdvertiser>>("advertiser/info/", {
      advertiser_ids: [advertiserId],
      fields: ["advertiser_id", "advertiser_name", "currency", "display_timezone", "status"],
    });
    return data.list?.[0] ?? null;
  } catch (error) {
    console.warn(`Could not read advertiser detail: ${(error as Error).message}`);
    console.warn("Currency and timezone will be stored empty and cannot be checked here.\n");
    return null;
  }
}

const advertisers = await listAdvertisers();

if (advertisers.length === 0) {
  console.error("The token is valid but can see no advertiser accounts.\n");
  console.error("The advertiser has not been authorised for this app. In TikTok Ads Manager,");
  console.error("open the authorisation link generated in the developer portal for this app,");
  console.error("sign in as a user with access to the advertiser, and approve it.");
  console.error("\nAuthorising the *app* is not the same as being assigned to the *advertiser*;");
  console.error("both are needed.");
  process.exit(1);
}

if (listOnly || !requestedAdvertiser) {
  console.log(`TikTok Business API ${TIKTOK_API_VERSION}. Advertisers this token can reach:\n`);
  for (const advertiser of advertisers) {
    console.log(`  ${advertiser.advertiser_id.padEnd(24)} ${advertiser.advertiser_name ?? advertiser.name ?? ""}`);
  }
  if (!requestedAdvertiser) {
    console.log("\nSet TIKTOK_ADVERTISER_ID in .env.local to the id you want, then re-run.");
  }
  process.exit(0);
}

const listed = advertisers.find((candidate) => candidate.advertiser_id === requestedAdvertiser);
if (!listed) {
  console.error(`TIKTOK_ADVERTISER_ID ${requestedAdvertiser} is not among the advertisers this token can reach.`);
  console.error(`Available: ${advertisers.map((candidate) => candidate.advertiser_id).join(", ")}`);
  process.exit(1);
}

const detail = await advertiserDetail(requestedAdvertiser);
const advertiser: TikTokAdvertiser = { ...listed, ...(detail ?? {}) };
const name = advertiser.advertiser_name ?? advertiser.name ?? requestedAdvertiser;
const currency = advertiser.currency ?? null;
const timezone = advertiser.display_timezone ?? advertiser.timezone ?? null;

const db = await connect();

try {
  const { rows: orgRows } = await db.query(
    "select name, reporting_currency, business_timezone from public.organisations where id = $1",
    [organisationId],
  );
  if (orgRows.length === 0) throw new Error(`ORGANISATION_ID ${organisationId} matches no organisation`);
  const organisation = orgRows[0];

  // A currency mismatch would silently mix another currency into a sterling P&L. Reported, not
  // corrected: converting it here would invent an exchange rate nobody approved.
  if (currency && currency !== organisation.reporting_currency) {
    console.warn(
      `WARNING: the advertiser reports ${currency} but QNCH reports in ${organisation.reporting_currency}.`,
    );
    console.warn("Spend will be stored in the advertiser's currency and will not be converted.\n");
  }

  // Reports are dated in the advertiser's timezone. If that differs from the business
  // timezone, a day's spend lines up against a different day's revenue.
  if (timezone && timezone !== organisation.business_timezone) {
    console.warn(
      `WARNING: the advertiser is set to ${timezone} but QNCH reports in ${organisation.business_timezone}.`,
    );
    console.warn("Daily spend will be attributed to the advertiser's day, not the business day.\n");
  }

  await db.query("begin");

  const { rows: connectionRows } = await db.query(
    `insert into public.integration_connections
       (organisation_id, provider, external_account_id, display_name, status, scopes, last_success_at)
     values ($1, 'tiktok', $2, $3, 'active', $4, null)
     on conflict (organisation_id, provider, external_account_id)
     do update set display_name = excluded.display_name, status = 'active', scopes = excluded.scopes
     returning id`,
    [organisationId, requestedAdvertiser, name, ["ads_read"]],
  );
  const connectionId = connectionRows[0].id;

  await db.query(
    `insert into public.integration_tokens (connection_id, encrypted_refresh_token, key_version)
     values ($1, $2, $3)
     on conflict (connection_id)
     do update set encrypted_refresh_token = excluded.encrypted_refresh_token,
                   key_version = excluded.key_version,
                   updated_at = now()`,
    [connectionId, encryptToken(accessToken, encryptionKey), CURRENT_KEY_VERSION],
  );

  await db.query(
    `insert into public.ad_accounts (organisation_id, platform, external_id, name, currency, timezone)
     values ($1, 'tiktok', $2, $3, $4, $5)
     on conflict (organisation_id, platform, external_id)
     do update set name = excluded.name, currency = excluded.currency, timezone = excluded.timezone`,
    [organisationId, requestedAdvertiser, name, currency, timezone],
  );

  await db.query("commit");

  console.log(`Connected ${name} (${requestedAdvertiser}) to ${organisation.name}.`);
  console.log(`  currency  ${currency ?? "unknown"}`);
  console.log(`  timezone  ${timezone ?? "unknown"}`);
  console.log("\nToken stored encrypted. Next: npm run backfill:tiktok -- --since 2026-01-01");
} catch (error) {
  await db.query("rollback").catch(() => {});
  console.error(`Failed, rolled back: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
