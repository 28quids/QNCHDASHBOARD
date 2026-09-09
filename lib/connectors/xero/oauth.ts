/**
 * Xero OAuth 2.0, and the one rule that matters more than the rest of this connector.
 *
 * **A refresh token is single use.** Exchanging it returns a new refresh token and invalidates
 * the one that was used. If the new value is not stored, the connection is gone: not expired,
 * not retryable, gone — reconnecting requires a human consenting in a browser. So the store is
 * written *before* the new access token is handed to any caller, and a failure to store is
 * raised rather than swallowed. Losing the write while continuing to sync would leave a
 * connection that works for thirty minutes and then dies with no record of why.
 *
 * A refresh token also expires after sixty days of disuse, so a tenant left unsynced over a
 * long pause needs reconnecting. The status recorded on failure is what tells the
 * data-quality page which of the two happened.
 */

import { fetchWithRetry, HttpError } from "../http";
import { XERO_AUTHORIZE_URL, XERO_SCOPES, XERO_TOKEN_URL, type XeroTokenResponse } from "./types";

export interface XeroTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO instant at which the access token stops being accepted. */
  expiresAt: string;
}

/**
 * Where tokens live between refreshes.
 *
 * An interface rather than a Supabase call so the rotation rule can be tested without a
 * database, which is the only way to prove the store is written before the token is used.
 */
export interface XeroTokenStore {
  load: () => Promise<XeroTokens>;
  save: (tokens: XeroTokens) => Promise<void>;
  /** Called when Xero refuses the refresh token, so the connection can be marked for reauth. */
  markNeedsReauth?: (reason: string) => Promise<void>;
}

export interface XeroOAuthOptions {
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Refresh this long before expiry, so a request cannot start on a token that expires mid-flight. */
  refreshSkewMs?: number;
}

export class XeroAuthError extends Error {
  constructor(
    message: string,
    /** True when the refresh token itself was rejected, which needs a human to reconnect. */
    readonly needsReauth: boolean,
  ) {
    super(message);
    this.name = "XeroAuthError";
  }
}

const DEFAULT_SKEW_MS = 60_000;

/** HTTP Basic, which is how Xero authenticates the client on the token endpoint. */
const basicAuth = (clientId: string, clientSecret: string): string =>
  `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;

/** The consent URL a human opens once, to authorise QNCH's app against their organisation. */
export function authorisationUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(XERO_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", XERO_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

function toTokens(payload: XeroTokenResponse, now: number): XeroTokens {
  if (!payload.refresh_token) {
    // Without a refresh token the connection is good for thirty minutes and then dead. That is
    // almost always a missing `offline_access` scope, and it must not be stored as if it worked.
    throw new XeroAuthError(
      "Xero returned no refresh token. The authorisation is missing the offline_access scope.",
      true,
    );
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: new Date(now + payload.expires_in * 1000).toISOString(),
  };
}

async function postToken(
  body: URLSearchParams,
  options: XeroOAuthOptions,
): Promise<XeroTokenResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;

  const response = await fetchWithRetry(
    () =>
      fetchImpl(XERO_TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: basicAuth(options.clientId, options.clientSecret),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      }),
    { sleep: options.sleep },
  );

  const text = await response.text();
  if (!response.ok) {
    // `invalid_grant` means the refresh token was already used, revoked, or older than sixty
    // days. Retrying cannot fix any of those, so it is distinguished from a transient fault.
    const needsReauth = text.includes("invalid_grant") || response.status === 400;
    throw new XeroAuthError(`Xero token endpoint returned ${response.status}: ${text.slice(0, 300)}`, needsReauth);
  }

  try {
    return JSON.parse(text) as XeroTokenResponse;
  } catch {
    throw new HttpError(response.status, XERO_TOKEN_URL, text);
  }
}

/** Exchanges the one-time authorisation code from the consent redirect for the first tokens. */
export async function exchangeAuthorisationCode(
  code: string,
  redirectUri: string,
  options: XeroOAuthOptions,
): Promise<XeroTokens> {
  const payload = await postToken(
    new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    options,
  );
  return toTokens(payload, (options.now ?? Date.now)());
}

/**
 * Returns a usable access token, refreshing and persisting first if the stored one is spent.
 *
 * The order here is the whole point: refresh, **save**, then return. A caller can never hold a
 * token whose rotation has not been recorded.
 */
export async function currentAccessToken(
  store: XeroTokenStore,
  options: XeroOAuthOptions,
): Promise<string> {
  const now = (options.now ?? Date.now)();
  const skew = options.refreshSkewMs ?? DEFAULT_SKEW_MS;
  const stored = await store.load();

  if (Date.parse(stored.expiresAt) - skew > now) return stored.accessToken;

  let payload: XeroTokenResponse;
  try {
    payload = await postToken(
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: stored.refreshToken }),
      options,
    );
  } catch (error) {
    if (error instanceof XeroAuthError && error.needsReauth) {
      await store.markNeedsReauth?.(error.message);
    }
    throw error;
  }

  const refreshed = toTokens(payload, now);

  // Before the token is returned, never after. A save that fails must surface as a failed sync,
  // because the alternative is a rotated token that only exists in this process's memory.
  await store.save(refreshed);
  return refreshed.accessToken;
}
