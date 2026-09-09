/**
 * Authorises Xero and stores the connection.
 *
 * Xero is the only provider here that needs a human in a browser: there is no equivalent of a
 * system user token, so someone with access to the organisation has to consent once. This
 * script opens a loopback listener to catch the redirect, so the one-time code never has to be
 * copied by hand — and accepts `--code` for the case where a loopback redirect is not usable.
 *
 *   npm run xero:connect                  # full flow, listening for the redirect
 *   npm run xero:connect -- --code <code> # exchange a code captured another way
 *   npm run xero:connect -- --status      # what is currently connected
 *
 * Required in .env.local: XERO_CLIENT_ID, XERO_CLIENT_SECRET.
 * Add `http://localhost:5478/callback` as a redirect URI on the Xero app, or set
 * XERO_REDIRECT_URI to whatever you registered instead.
 *
 * **The refresh token this stores is single use.** Every sync rotates it. Restoring an old
 * database backup therefore restores a spent token, and the connection has to be made again —
 * that is Xero's design, not a fault here.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { connect, loadEnvFile, requireEnv } from "./lib/db.mjs";
import { encryptToken, CURRENT_KEY_VERSION } from "@/lib/connectors/crypto";
import { XeroClient } from "@/lib/connectors/xero/client";
import {
  authorisationUrl,
  exchangeAuthorisationCode,
  type XeroTokens,
} from "@/lib/connectors/xero/oauth";
import { XERO_SCOPES } from "@/lib/connectors/xero/types";

const argv = process.argv.slice(2);
const statusOnly = argv.includes("--status");
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const env = loadEnvFile();
const organisationId = requireEnv("ORGANISATION_ID", env);

if (statusOnly) {
  const db = await connect();
  try {
    const { rows } = await db.query(
      `select c.external_account_id, c.display_name, c.status, c.last_success_at,
              t.access_token_expires_at
       from public.integration_connections c
       left join public.integration_tokens t on t.connection_id = c.id
       where c.organisation_id = $1 and c.provider = 'xero'`,
      [organisationId],
    );
    if (rows.length === 0) {
      console.log("No Xero connection. Run: npm run xero:connect");
    }
    for (const row of rows) {
      console.log(`${row.display_name ?? "(unnamed)"}  tenant ${row.external_account_id}`);
      console.log(`  status        ${row.status}`);
      console.log(`  last success  ${row.last_success_at ?? "never"}`);
      console.log(`  access token  expires ${row.access_token_expires_at ?? "unknown"}`);
    }
  } finally {
    await db.end();
  }
  process.exit(0);
}

const clientId = requireEnv("XERO_CLIENT_ID", env);
const clientSecret = requireEnv("XERO_CLIENT_SECRET", env);
const encryptionKey = requireEnv("TOKEN_ENCRYPTION_KEY", env);
const redirectUri = env.XERO_REDIRECT_URI ?? "http://localhost:5478/callback";

const oauth = { clientId, clientSecret };

/**
 * Waits for Xero to redirect back with the code.
 *
 * `state` is generated per run and checked on return. It is what stops a code from an
 * unrelated authorisation being accepted by a listener that happens to be running.
 */
async function captureCode(state: string): Promise<string> {
  const url = new URL(redirectUri);
  const port = Number(url.port || 80);

  return new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      const incoming = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (incoming.pathname !== url.pathname) {
        response.writeHead(404).end();
        return;
      }

      const code = incoming.searchParams.get("code");
      const returnedState = incoming.searchParams.get("state");
      const error = incoming.searchParams.get("error");

      const finish = (message: string) => {
        response.writeHead(200, { "Content-Type": "text/plain" }).end(message);
        server.close();
      };

      if (error) {
        finish(`Authorisation failed: ${error}. You can close this tab.`);
        reject(new Error(`Xero returned ${error}`));
        return;
      }
      if (returnedState !== state) {
        finish("State mismatch. You can close this tab.");
        reject(new Error("The redirect carried a different state than this run issued"));
        return;
      }
      if (!code) {
        finish("No code in the redirect. You can close this tab.");
        reject(new Error("The redirect carried no authorisation code"));
        return;
      }

      finish("QNCH is connected to Xero. You can close this tab.");
      resolve(code);
    });

    server.on("error", reject);
    server.listen(port, () => {
      console.log(`Listening on ${redirectUri} for the redirect.\n`);
    });
  });
}

const state = randomUUID();
let tokens: XeroTokens;

const providedCode = flag("code");
if (providedCode) {
  tokens = await exchangeAuthorisationCode(providedCode, redirectUri, oauth);
} else {
  console.log("Open this URL, sign in, and choose the organisation to connect:\n");
  console.log(authorisationUrl(clientId, redirectUri, state));
  console.log(`\nScopes requested: ${XERO_SCOPES.join(" ")}`);
  console.log("All read-only apart from offline_access, which is what keeps the connection alive.\n");

  tokens = await exchangeAuthorisationCode(await captureCode(state), redirectUri, oauth);
}

// A store that never rotates: the tokens were just issued, so nothing needs refreshing yet, and
// a save here would write them twice.
const transientStore = {
  load: async () => tokens,
  save: async () => {},
};

const connections = await XeroClient.connections(transientStore, oauth);
if (connections.length === 0) {
  console.error("The authorisation succeeded but covers no organisations.");
  console.error("Re-run it and make sure an organisation is selected on the consent screen.");
  process.exit(1);
}

const requested = flag("tenant") ?? env.XERO_TENANT_ID;
const tenant =
  connections.length === 1 ? connections[0] : connections.find((candidate) => candidate.tenantId === requested);

if (!tenant) {
  console.log("This authorisation covers several organisations:\n");
  for (const candidate of connections) {
    console.log(`  ${candidate.tenantId}  ${candidate.tenantName ?? candidate.tenantType}`);
  }
  console.error("\nRe-run with --tenant <id> to choose one. The authorisation was not stored,");
  console.error("so it must be repeated — a refresh token is single use and this one is now spent.");
  process.exit(1);
}

const db = await connect();

try {
  const { rows: orgRows } = await db.query("select name from public.organisations where id = $1", [organisationId]);
  if (orgRows.length === 0) throw new Error(`ORGANISATION_ID ${organisationId} matches no organisation`);

  await db.query("begin");

  const { rows: connectionRows } = await db.query(
    `insert into public.integration_connections
       (organisation_id, provider, external_account_id, display_name, status, scopes, last_success_at)
     values ($1, 'xero', $2, $3, 'active', $4, null)
     on conflict (organisation_id, provider, external_account_id)
     do update set display_name = excluded.display_name, status = 'active', scopes = excluded.scopes
     returning id`,
    [organisationId, tenant.tenantId, tenant.tenantName ?? tenant.tenantType, [...XERO_SCOPES]],
  );
  const connectionId = connectionRows[0].id;

  await db.query(
    `insert into public.integration_tokens
       (connection_id, encrypted_refresh_token, encrypted_access_token, access_token_expires_at, key_version)
     values ($1, $2, $3, $4, $5)
     on conflict (connection_id)
     do update set encrypted_refresh_token = excluded.encrypted_refresh_token,
                   encrypted_access_token = excluded.encrypted_access_token,
                   access_token_expires_at = excluded.access_token_expires_at,
                   key_version = excluded.key_version,
                   updated_at = now()`,
    [
      connectionId,
      encryptToken(tokens.refreshToken, encryptionKey),
      encryptToken(tokens.accessToken, encryptionKey),
      tokens.expiresAt,
      CURRENT_KEY_VERSION,
    ],
  );

  await db.query("commit");

  console.log(`\nConnected ${tenant.tenantName ?? tenant.tenantId} to ${orgRows[0].name}.`);
  console.log("Tokens stored encrypted.\n");
  console.log("Next:");
  console.log("  npm run backfill:xero -- --dry-run");
  console.log("  npm run backfill:xero -- --since 2026-01-01");
  console.log("  npm run map:xero            # assign accounts to contribution buckets");
} catch (error) {
  await db.query("rollback").catch(() => {});
  console.error(`Failed, rolled back: ${(error as Error).message}`);
  console.error("The authorisation is spent, so re-run the connect from the start.");
  process.exitCode = 1;
} finally {
  await db.end();
}
