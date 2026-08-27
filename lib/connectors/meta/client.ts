import { fetchWithRetry, HttpError } from "../http";
import { GRAPH_API_VERSION, type MetaErrorBody, type MetaListResponse } from "./types";

/**
 * Meta Graph API client.
 *
 * Two behaviours that differ from the Shopify client and matter here:
 *
 *  - **Errors arrive as HTTP 200 with an `error` object**, as well as with real status codes.
 *    Parsing the body without checking that would treat an error as an empty result set, and
 *    a sync would report success having imported nothing.
 *
 *  - **Rate limiting is reported in a header, not the body.** `x-business-use-case-usage`
 *    carries the percentage of the hourly budget consumed. Backing off as it approaches the
 *    limit avoids provoking the block rather than merely reacting to it — once Meta throttles
 *    an ad account the pause is measured in hours.
 */

export interface MetaClientOptions {
  accessToken: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Pause when this percentage of the hourly budget has been consumed. */
  usageCeiling?: number;
}

export class MetaApiError extends Error {
  constructor(
    readonly code: number,
    readonly subcode: number | undefined,
    message: string,
  ) {
    super(`Meta API error ${code}${subcode ? `/${subcode}` : ""}: ${message}`);
    this.name = "MetaApiError";
  }

  /** An expired, revoked or insufficiently scoped token, as opposed to a transient fault. */
  get isAuthFailure(): boolean {
    return this.code === 190 || this.code === 102 || this.code === 200;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class MetaClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly usageCeiling: number;

  constructor(private readonly options: MetaClientOptions) {
    this.baseUrl = `https://graph.facebook.com/${options.apiVersion ?? GRAPH_API_VERSION}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.usageCeiling = options.usageCeiling ?? 75;
  }

  /**
   * Reads one page.
   *
   * `pathOrNextUrl` accepts either a path or the absolute `paging.next` URL Meta returns,
   * because that URL already carries the cursor and every original parameter. Rebuilding it
   * by hand is how a paged sync silently changes its own query part-way through.
   */
  async get<T>(pathOrNextUrl: string, params: Record<string, string> = {}): Promise<MetaListResponse<T>> {
    const url = pathOrNextUrl.startsWith("https://")
      ? new URL(pathOrNextUrl)
      : new URL(`${this.baseUrl}/${pathOrNextUrl.replace(/^\//, "")}`);

    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("access_token", this.options.accessToken);

    const response = await fetchWithRetry(() => this.fetchImpl(url.toString()), { sleep: this.sleep });
    const body = await response.text();

    let payload: MetaListResponse<T> & MetaErrorBody;
    try {
      payload = JSON.parse(body) as MetaListResponse<T> & MetaErrorBody;
    } catch {
      throw new HttpError(response.status, redact(url), body);
    }

    // Checked before the status, because Meta returns errors with a 200 as well as with 4xx.
    if (payload.error) {
      throw new MetaApiError(payload.error.code, payload.error.error_subcode, payload.error.message);
    }
    if (!response.ok) throw new HttpError(response.status, redact(url), body);

    await this.respectUsageBudget(response);
    return payload;
  }

  /** Follows `paging.next` to the end, so a caller never has to assemble a cursor itself. */
  async getAll<T>(path: string, params: Record<string, string> = {}, maxPages = 200): Promise<T[]> {
    const collected: T[] = [];
    let next: string | null = path;
    let pageParams = params;
    let pages = 0;

    while (next !== null) {
      const page: MetaListResponse<T> = await this.get<T>(next, pageParams);
      collected.push(...page.data);
      pages += 1;

      // The next URL carries every original parameter, so they must not be sent again.
      next = page.paging?.next ?? null;
      pageParams = {};

      if (pages >= maxPages && next !== null) {
        throw new Error(`${path} exceeded ${maxPages} pages without completing`);
      }
    }
    return collected;
  }

  /**
   * Waits when the hourly budget is nearly spent.
   *
   * Meta reports usage per business use case as a percentage. Exceeding it blocks the ad
   * account for up to an hour, which is far more costly than pausing here.
   */
  private async respectUsageBudget(response: Response): Promise<void> {
    const header = response.headers.get("x-business-use-case-usage");
    if (!header) return;

    let highest = 0;
    try {
      const usage = JSON.parse(header) as Record<
        string,
        { call_count?: number; total_cputime?: number; total_time?: number; estimated_time_to_regain_access?: number }[]
      >;
      for (const entries of Object.values(usage)) {
        for (const entry of entries) {
          highest = Math.max(highest, entry.call_count ?? 0, entry.total_cputime ?? 0, entry.total_time ?? 0);
          // Meta states outright how long until the block lifts; honour it rather than guess.
          if (entry.estimated_time_to_regain_access) {
            await this.sleep(Math.min(entry.estimated_time_to_regain_access * 60_000, 60_000));
            return;
          }
        }
      }
    } catch {
      return;
    }

    if (highest >= this.usageCeiling) await this.sleep(5_000);
  }
}

/** Keeps the access token out of any error message or log line. */
function redact(url: URL): string {
  const copy = new URL(url.toString());
  copy.searchParams.set("access_token", "REDACTED");
  return copy.toString();
}
