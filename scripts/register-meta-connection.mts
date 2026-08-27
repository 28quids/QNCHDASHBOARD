/**
 * Registers a Meta ad account as an integration connection and stores its token encrypted.
 *
 * The token is verified against the Graph API before anything is written, so a missing scope
 * or an app that is not in the business portfolio fails here with an explanation rather than
 * half way through a backfill.
 *
 * Uses a System User token, not a user token. A user token expires every 60 days and breaks
 * whenever the person who issued it loses access to the business portfolio; a system user
 * token belongs to the business and does not expire.
 *
 *   npm run meta:connect                 # uses the account in META_AD_ACCOUNT_ID
 *   npm run meta:connect -- --list       # show every ad account the token can reach
 */

import { connect, loadEnvFile, requireEnv } from "./lib/db.mjs";
import { encryptToken, CURRENT_KEY_VERSION } from "@/lib/connectors/crypto";
import { MetaApiError, MetaClient } from "@/lib/connectors/meta/client";
import { ACCOUNT_FIELDS } from "@/lib/connectors/meta/queries";
import { GRAPH_API_VERSION, type MetaAdAccount } from "@/lib/connectors/meta/types";

const listOnly = process.argv.includes("--list");

const env = loadEnvFile();
const accessToken = requireEnv("META_ACCESS_TOKEN", env);
const encryptionKey = requireEnv("TOKEN_ENCRYPTION_KEY", env);
const organisationId = requireEnv("ORGANISATION_ID", env);
const requestedAccount = env.META_AD_ACCOUNT_ID;

const client = new MetaClient({ accessToken });

/** Reports what the token can actually see, which is the fastest way to diagnose a scope gap. */
async function listAccounts(): Promise<MetaAdAccount[]> {
  try {
    return await client.getAll<MetaAdAccount>("me/adaccounts", { fields: ACCOUNT_FIELDS, limit: "100" });
  } catch (error) {
    if (error instanceof MetaApiError && error.isAuthFailure) {
      console.error(`Meta rejected the token: ${error.message}\n`);
      console.error("Common causes, in the order they usually bite:");
      console.error("  1. The app is not in the business portfolio. Business settings >");
      console.error("     Accounts > Apps > Add, then re-generate the system user token.");
      console.error("  2. The system user has no access to the ad account. Business settings >");
      console.error("     Users > System users > your user > Assign assets > Ad accounts.");
      console.error("  3. The token was generated without the ads_read permission.");
      process.exit(1);
    }
    throw error;
  }
}

const accounts = await listAccounts();

if (accounts.length === 0) {
  console.error("The token is valid but can see no ad accounts.");
  console.error("Assign the ad account to the system user: Business settings > Users >");
  console.error("System users > your user > Assign assets > Ad accounts > Manage campaigns.");
  process.exit(1);
}

if (listOnly || !requestedAccount) {
  console.log(`Graph API ${GRAPH_API_VERSION}. Ad accounts this token can reach:\n`);
  for (const account of accounts) {
    console.log(`  ${account.id.padEnd(24)} ${account.name}`);
    console.log(`  ${" ".repeat(24)} ${account.currency}, ${account.timezone_name}`);
  }
  if (!requestedAccount) {
    console.log("\nSet META_AD_ACCOUNT_ID in .env.local to the act_... id you want, then re-run.");
  }
  process.exit(0);
}

const account = accounts.find((candidate) => candidate.id === requestedAccount);
if (!account) {
  console.error(`META_AD_ACCOUNT_ID ${requestedAccount} is not among the accounts this token can reach.`);
  console.error(`Available: ${accounts.map((candidate) => candidate.id).join(", ")}`);
  process.exit(1);
}

const db = await connect();

try {
  const { rows: orgRows } = await db.query(
    "select name, reporting_currency, business_timezone from public.organisations where id = $1",
    [organisationId],
  );
  if (orgRows.length === 0) throw new Error(`ORGANISATION_ID ${organisationId} matches no organisation`);
  const organisation = orgRows[0];

  // A currency mismatch would silently mix euros into a sterling P&L. Reported, not corrected:
  // converting it here would invent an exchange rate nobody approved.
  if (account.currency !== organisation.reporting_currency) {
    console.warn(
      `WARNING: the ad account reports ${account.currency} but QNCH reports in ${organisation.reporting_currency}.`,
    );
    console.warn("Spend will be stored in the ad account's currency and will not be converted.\n");
  }

  // Insights are dated in the ad account's timezone. If that differs from the business
  // timezone, a day's spend lines up against a different day's revenue.
  if (account.timezone_name !== organisation.business_timezone) {
    console.warn(
      `WARNING: the ad account is set to ${account.timezone_name} but QNCH reports in ${organisation.business_timezone}.`,
    );
    console.warn("Daily spend will be attributed to the ad account's day, not the business day.\n");
  }

  await db.query("begin");

  const { rows: connectionRows } = await db.query(
    `insert into public.integration_connections
       (organisation_id, provider, external_account_id, display_name, status, scopes, last_success_at)
     values ($1, 'meta', $2, $3, 'active', $4, null)
     on conflict (organisation_id, provider, external_account_id)
     do update set display_name = excluded.display_name, status = 'active', scopes = excluded.scopes
     returning id`,
    [organisationId, account.id, account.name, ["ads_read"]],
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
     values ($1, 'meta', $2, $3, $4, $5)
     on conflict (organisation_id, platform, external_id)
     do update set name = excluded.name, currency = excluded.currency, timezone = excluded.timezone`,
    [organisationId, account.id, account.name, account.currency, account.timezone_name],
  );

  await db.query("commit");

  console.log(`Connected ${account.name} (${account.id}) to ${organisation.name}.`);
  console.log(`  currency  ${account.currency}`);
  console.log(`  timezone  ${account.timezone_name}`);
  console.log("\nToken stored encrypted. Next: npm run backfill:meta -- --since 2026-01-01");
} catch (error) {
  await db.query("rollback").catch(() => {});
  console.error(`Failed, rolled back: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
