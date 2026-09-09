import { fetchWithRetry, HttpError } from "../http";
import { currentAccessToken, type XeroOAuthOptions, type XeroTokenStore } from "./oauth";
import {
  XERO_API_BASE,
  XERO_CONNECTIONS_URL,
  type XeroConnection,
  type XeroListResponse,
  type XeroReportsResponse,
} from "./types";

/**
 * Xero Accounting API client.
 *
 * Every request resolves a fresh access token through `currentAccessToken`, so a sync that
 * runs longer than the thirty-minute token lifetime refreshes mid-run rather than failing at
 * an arbitrary point. The tenant is sent as a header: one authorisation can cover several
 * organisations, and omitting it returns another organisation's data rather than an error.
 *
 * Rate limits are 60 calls a minute and 5,000 a day per tenant. Xero reports the remaining
 * budget in headers and answers a breach with 429 and `Retry-After`; the shared retry layer
 * honours that, and this client slows down before provoking it, since a daily-limit breach is
 * measured in hours rather than seconds.
 */

export interface XeroClientOptions extends XeroOAuthOptions {
  tenantId: string;
  store: XeroTokenStore;
  baseUrl?: string;
  /** Pause when fewer than this many calls remain in the minute budget. */
  minuteFloor?: number;
}

export class XeroClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minuteFloor: number;

  constructor(private readonly options: XeroClientOptions) {
    this.baseUrl = options.baseUrl ?? XERO_API_BASE;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.minuteFloor = options.minuteFloor ?? 5;
  }

  private async request(url: string, ifModifiedSince?: string | null): Promise<Response> {
    const accessToken = await currentAccessToken(this.options.store, this.options);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Xero-tenant-id": this.options.tenantId,
      Accept: "application/json",
    };
    // Xero wants an HTTP date here. An ISO instant is accepted, and is what the watermark holds.
    if (ifModifiedSince) headers["If-Modified-Since"] = ifModifiedSince;

    const response = await fetchWithRetry(() => this.fetchImpl(url, { headers }), { sleep: this.sleep });
    await this.respectRateLimit(response);
    return response;
  }

  /**
   * Reads one page of a collection endpoint.
   *
   * `If-Modified-Since` bounds an incremental read to records changed since the watermark,
   * which is what keeps a nightly sync from re-reading the whole ledger.
   */
  async list(
    resource: "Accounts" | "BankTransactions" | "Invoices",
    params: Record<string, string | number> = {},
    ifModifiedSince?: string | null,
  ): Promise<XeroListResponse> {
    const url = new URL(`${this.baseUrl}/${resource}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

    const response = await this.request(url.toString(), ifModifiedSince);

    // 304 is the correct, expected answer to a conditional request when nothing changed. It is
    // not an error and must not be parsed as one — the body is empty.
    if (response.status === 304) return {};

    return this.readJson<XeroListResponse>(response, url.toString());
  }

  /** Reads a report. Reports are not paged and take a date range rather than a page number. */
  async report(name: string, params: Record<string, string> = {}): Promise<XeroReportsResponse> {
    const url = new URL(`${this.baseUrl}/Reports/${name}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const response = await this.request(url.toString());
    return this.readJson<XeroReportsResponse>(response, url.toString());
  }

  /**
   * The organisations this authorisation covers.
   *
   * Lives on a different host from the Accounting API and takes no tenant header, because it
   * is what tells you which tenants exist in the first place.
   */
  static async connections(store: XeroTokenStore, options: XeroOAuthOptions): Promise<XeroConnection[]> {
    const accessToken = await currentAccessToken(store, options);
    const fetchImpl = options.fetchImpl ?? fetch;

    const response = await fetchWithRetry(
      () =>
        fetchImpl(XERO_CONNECTIONS_URL, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        }),
      { sleep: options.sleep },
    );

    const body = await response.text();
    if (!response.ok) throw new HttpError(response.status, XERO_CONNECTIONS_URL, body);

    return JSON.parse(body) as XeroConnection[];
  }

  private async readJson<T>(response: Response, url: string): Promise<T> {
    const body = await response.text();
    if (!response.ok) throw new HttpError(response.status, url, body);

    try {
      return JSON.parse(body) as T;
    } catch {
      throw new HttpError(response.status, url, body);
    }
  }

  /**
   * Slows down as the minute budget runs out.
   *
   * Reacting only to a 429 is enough for the per-minute limit, which resets quickly. It is not
   * enough for the daily one: `X-Rate-Limit-Problem: day` means the tenant is locked out until
   * midnight UTC, and no amount of backing off afterwards recovers the run.
   */
  private async respectRateLimit(response: Response): Promise<void> {
    if (response.headers.get("x-rate-limit-problem") === "day") {
      throw new Error("Xero daily API limit reached for this tenant; the remaining sync is abandoned");
    }

    const remaining = Number(response.headers.get("x-minlimit-remaining"));
    if (Number.isFinite(remaining) && remaining <= this.minuteFloor) {
      // The minute window is rolling, so a short pause is enough to let it recover.
      await this.sleep(5_000);
    }
  }
}
