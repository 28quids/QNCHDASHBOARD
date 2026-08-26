/**
 * Registers the Shopify store as an integration connection and stores its access token
 * encrypted.
 *
 * The token is verified against the Admin API before anything is written, so a typo or a
 * missing scope fails here rather than half way through a backfill. It is read from
 * .env.local and never printed.
 *
 *   node scripts/register-shopify-connection.mts
 *
 * Run with Node 23, which strips TypeScript natively — this imports the real encryptToken
 * rather than reimplementing AES-256-GCM in a second place where it could drift. The .mts
 * extension marks the file as ESM without forcing "type": "module" onto the package, which
 * would change how every other .js file in the project is interpreted.
 */

import { connect, loadEnvFile, requireEnv } from "./lib/db.mjs";
import { encryptToken, CURRENT_KEY_VERSION } from "../lib/connectors/crypto.ts";
import { SHOPIFY_API_VERSION } from "../lib/connectors/shopify/queries.ts";

const env = loadEnvFile();
const shopDomain = requireEnv("SHOPIFY_SHOP_DOMAIN", env);
const accessToken = requireEnv("SHOPIFY_ADMIN_TOKEN", env);
const encryptionKey = requireEnv("TOKEN_ENCRYPTION_KEY", env);
const organisationId = requireEnv("ORGANISATION_ID", env);

/**
 * Shopify's API credentials page shows several secrets together and they are easy to
 * confuse. Only `shpat_` is the Admin API access token; the others authenticate nothing
 * against the Admin API and produce an opaque 401.
 */
const TOKEN_PREFIXES: Record<string, string> = {
  shpss_: "the API secret key, used for OAuth and webhook signatures",
  shpca_: "a custom app credential, not the Admin API access token",
  shppa_: "a legacy private app password",
};

if (!accessToken.startsWith("shpat_")) {
  const matched = Object.entries(TOKEN_PREFIXES).find(([prefix]) => accessToken.startsWith(prefix));
  console.error("SHOPIFY_ADMIN_TOKEN does not look like an Admin API access token.");
  console.error(`  expected a value beginning shpat_, got ${accessToken.slice(0, 6)}...`);
  if (matched) console.error(`  ${accessToken.slice(0, 6)} is ${matched[1]}.`);
  console.error("\nIn the Shopify admin: Settings > Apps and sales channels > Develop apps >");
  console.error("your app > API credentials. Take the value under 'Admin API access token',");
  console.error("not the one under 'API key and secret key'. If that section shows no token,");
  console.error("the app has not been installed yet — click 'Install app' first.");
  process.exit(1);
}

/** The myshopify host only. A storefront domain or a pasted URL will not authenticate. */
if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shopDomain)) {
  console.error(`SHOPIFY_SHOP_DOMAIN should be the myshopify.com host, got "${shopDomain}".`);
  console.error("  Expected something like qnch.myshopify.com — no https://, no trailing slash.");
  process.exit(1);
}

/** Confirms the token works and reports what the store says about itself. */
async function verifyToken(): Promise<{ name: string; domain: string; currency: string; timezone: string }> {
  const response = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-shopify-access-token": accessToken },
    body: JSON.stringify({
      query: `{ shop { name myshopifyDomain currencyCode ianaTimezone } }`,
    }),
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(`Shopify rejected the token (HTTP ${response.status}). Check it was copied in full.`);
  }
  if (!response.ok) {
    throw new Error(`Shopify returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const payload = (await response.json()) as {
    data?: { shop?: { name: string; myshopifyDomain: string; currencyCode: string; ianaTimezone: string } };
    errors?: { message: string }[];
  };

  if (payload.errors?.length) throw new Error(payload.errors.map((e) => e.message).join("; "));
  if (!payload.data?.shop) throw new Error("Shopify returned no shop data.");

  const shop = payload.data.shop;
  return {
    name: shop.name,
    domain: shop.myshopifyDomain,
    currency: shop.currencyCode,
    timezone: shop.ianaTimezone,
  };
}

/**
 * Checks whether the token can read orders older than 60 days.
 *
 * `read_orders` only ever exposes the last 60 days. Historical backfill needs
 * `read_all_orders`, which Shopify grants on request. Without it a backfill appears to
 * succeed and silently returns nothing before that window.
 */
async function checkHistoricalOrderAccess(): Promise<{ reachable: boolean; detail: string }> {
  const cutoff = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const response = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-shopify-access-token": accessToken },
    body: JSON.stringify({
      query: `query($q: String!) { orders(first: 1, query: $q) { nodes { id createdAt } } }`,
      variables: { q: `created_at:<'${cutoff}'` },
    }),
  });

  const payload = (await response.json()) as {
    data?: { orders?: { nodes: { id: string; createdAt: string }[] } };
    errors?: { message: string }[];
  };

  if (payload.errors?.length) {
    return { reachable: false, detail: payload.errors.map((e) => e.message).join("; ") };
  }
  const nodes = payload.data?.orders?.nodes ?? [];
  return nodes.length > 0
    ? { reachable: true, detail: `read an order from ${nodes[0].createdAt.slice(0, 10)}` }
    : { reachable: false, detail: `no order returned from before ${cutoff}` };
}

const shop = await verifyToken();
console.log("Token accepted by Shopify.");
console.log(`  store    : ${shop.name}`);
console.log(`  domain   : ${shop.domain}`);
console.log(`  currency : ${shop.currency}`);
console.log(`  timezone : ${shop.timezone}`);

const client = await connect();

try {
  const organisation = await client.query(
    "select name, reporting_currency, business_timezone from public.organisations where id = $1",
    [organisationId],
  );
  if (organisation.rows.length === 0) {
    throw new Error(`ORGANISATION_ID ${organisationId} does not exist.`);
  }
  const { reporting_currency, business_timezone } = organisation.rows[0];

  // A mismatch here misdates every order and misstates every figure, so it is reported
  // rather than silently reconciled to one side or the other.
  if (reporting_currency !== shop.currency) {
    console.log(
      `\nWARNING currency mismatch: organisation is ${reporting_currency}, Shopify reports ${shop.currency}.`,
    );
  }
  if (business_timezone !== shop.timezone) {
    console.log(
      `\nWARNING timezone mismatch: organisation is ${business_timezone}, Shopify reports ${shop.timezone}.`,
    );
    console.log("        Business dates are derived from the organisation timezone, not Shopify's.");
  }

  await client.query("begin");

  const connection = await client.query(
    `insert into public.integration_connections
       (organisation_id, provider, external_account_id, display_name, status, scopes)
     values ($1, 'shopify', $2, $3, 'active', $4)
     on conflict (organisation_id, provider, external_account_id)
       do update set display_name = excluded.display_name, status = 'active', updated_at = now()
     returning id`,
    [organisationId, shop.domain, shop.name, []],
  );
  const connectionId = connection.rows[0].id;

  // Shopify custom apps issue one permanent token and no refresh token, but
  // encrypted_refresh_token is NOT NULL — the column assumes an OAuth refresh flow. The
  // durable credential is stored there, which is what a re-auth would replace.
  const ciphertext = encryptToken(accessToken, encryptionKey, CURRENT_KEY_VERSION);

  await client.query(
    `insert into public.integration_tokens
       (connection_id, encrypted_refresh_token, key_version, updated_at)
     values ($1, $2, $3, now())
     on conflict (connection_id)
       do update set encrypted_refresh_token = excluded.encrypted_refresh_token,
                     key_version = excluded.key_version,
                     updated_at = now()`,
    [connectionId, ciphertext, CURRENT_KEY_VERSION],
  );

  await client.query("commit");

  console.log(`\nConnection registered: ${connectionId}`);
  console.log(`Token stored encrypted (${ciphertext.length} bytes, key version ${CURRENT_KEY_VERSION}).`);
  console.log(`\nCONNECTION_ID=${connectionId}`);

  const history = await checkHistoricalOrderAccess();
  console.log("\nHistorical order access:");
  if (history.reachable) {
    console.log(`  OK — ${history.detail}`);
  } else {
    console.log(`  LIMITED — ${history.detail}`);
    console.log("  The read_orders scope only exposes the last 60 days. A full backfill needs");
    console.log("  read_all_orders, which Shopify grants on request from the app's API access page.");
    console.log("  Without it a backfill will appear to succeed and quietly return nothing older.");
  }
} catch (error) {
  await client.query("rollback");
  console.error(`\nFailed, rolled back: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
