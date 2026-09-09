/**
 * Service-account authentication for the Google APIs.
 *
 * A service account rather than OAuth, because this runs unattended: there is nobody to consent
 * in a browser at 03:00. The account signs a short-lived JWT with its private key and exchanges
 * it for an access token, which is the two-legged flow Google documents for server-to-server use.
 *
 * Implemented directly rather than by pulling in `googleapis`. That package is tens of megabytes
 * for what is one signature and one POST, and every dependency in a codebase holding financial
 * credentials is a dependency whose supply chain has to be trusted.
 *
 * **The private key is a credential.** It never reaches a browser, is never logged, and is read
 * only from the environment — the same rule as every provider token here, except that this one
 * cannot be encrypted at rest in the database because it is what bootstraps access in the first
 * place.
 */

import { createSign } from "node:crypto";
import { fetchWithRetry, HttpError } from "../http";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/** Write access to spreadsheets, and nothing else. Drive is not requested. */
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

/** Google rejects an assertion valid for longer than an hour. */
const TOKEN_LIFETIME_SECONDS = 3600;

export interface ServiceAccountCredentials {
  clientEmail: string;
  privateKey: string;
}

export interface GoogleAuthOptions {
  credentials: ServiceAccountCredentials;
  scope?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const base64Url = (value: string | Buffer): string =>
  (typeof value === "string" ? Buffer.from(value) : value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/**
 * Restores a PEM key that has passed through an environment variable.
 *
 * A `.env` file cannot hold a real newline, so the key is almost always stored with `\n` written
 * out literally. Signing with it unrepaired fails with an opaque "error:0909006C" from OpenSSL,
 * which says nothing about the actual cause.
 */
export function normalisePrivateKey(key: string): string {
  const restored = key.replace(/\\n/g, "\n").trim();

  if (!restored.includes("BEGIN") || !restored.includes("PRIVATE KEY")) {
    throw new Error(
      "GOOGLE_PRIVATE_KEY does not look like a PEM private key. Copy the whole `private_key` value from the service-account JSON, including the BEGIN and END lines.",
    );
  }
  return restored;
}

/** The signed assertion exchanged for an access token. */
export function buildAssertion(options: GoogleAuthOptions): string {
  const issuedAt = Math.floor((options.now ?? Date.now)() / 1000);

  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: options.credentials.clientEmail,
      scope: options.scope ?? SHEETS_SCOPE,
      aud: TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + TOKEN_LIFETIME_SECONDS,
    }),
  );

  const signature = createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .sign(normalisePrivateKey(options.credentials.privateKey));

  return `${header}.${claims}.${base64Url(signature)}`;
}

export interface GoogleAccessToken {
  accessToken: string;
  /** Epoch milliseconds at which the token stops being accepted. */
  expiresAt: number;
}

export async function requestAccessToken(options: GoogleAuthOptions): Promise<GoogleAccessToken> {
  const now = (options.now ?? Date.now)();
  const fetchImpl = options.fetchImpl ?? fetch;

  const response = await fetchWithRetry(
    () =>
      fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: GRANT_TYPE, assertion: buildAssertion(options) }),
      }),
    { sleep: options.sleep },
  );

  const body = await response.text();
  if (!response.ok) {
    // `invalid_grant` here almost always means the machine's clock is wrong or the key was
    // revoked, neither of which a retry fixes. Saying so beats a bare 400.
    const hint = body.includes("invalid_grant")
      ? " The assertion was rejected: check the system clock and that the key has not been revoked."
      : "";
    throw new HttpError(response.status, TOKEN_URL, `${body}${hint}`);
  }

  const payload = JSON.parse(body) as { access_token: string; expires_in: number };
  return { accessToken: payload.access_token, expiresAt: now + payload.expires_in * 1000 };
}

/**
 * A token provider that caches until shortly before expiry.
 *
 * Google issues a fresh token on every request without complaint, but an export writing a dozen
 * ranges would otherwise sign and exchange a dozen times for no reason.
 */
export function createTokenProvider(options: GoogleAuthOptions): () => Promise<string> {
  let cached: GoogleAccessToken | null = null;

  return async () => {
    const now = (options.now ?? Date.now)();
    if (cached && cached.expiresAt - 60_000 > now) return cached.accessToken;

    cached = await requestAccessToken(options);
    return cached.accessToken;
  };
}
