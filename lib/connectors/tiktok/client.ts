import { fetchWithRetry, HttpError } from "../http";
import {
  TIKTOK_API_VERSION,
  TIKTOK_BASE_URL,
  type TikTokEnvelope,
  type TikTokList,
} from "./types";

/**
 * TikTok Ads API client.
 *
 * Like Meta, TikTok reports failures inside a 200 response, so the envelope's `code` is
 * checked before anything else. Unlike Meta, paging is by page number and the response states
 * how many pages exist, so `getAll` counts rather than follows a cursor.
 *
 * The token is sent in the `Access-Token` header rather than in the query string, which keeps
 * it out of any URL that might be logged or included in an error message.
 */

export interface TikTokClientOptions {
  accessToken: string;
  apiVersion?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** TikTok error codes this connector distinguishes. Everything else is treated as transient. */
const AUTH_CODES = new Set([40001, 40100, 40101, 40102, 40105, 40110]);
const INVALID_PARAM_CODES = new Set([40002]);

export class TikTokApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly requestId?: string,
  ) {
    super(`TikTok API error ${code}: ${message}`);
    this.name = "TikTokApiError";
  }

  /** An expired, revoked or wrongly scoped token, as opposed to a transient fault. */
  get isAuthFailure(): boolean {
    return AUTH_CODES.has(this.code);
  }

  /**
   * A parameter TikTok refused. Almost always a metric or field name that does not exist for
   * this account, which is recoverable by asking for less — see `reportWithFallback`.
   */
  get isInvalidParameter(): boolean {
    return INVALID_PARAM_CODES.has(this.code);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TikTokClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: TikTokClientOptions) {
    this.baseUrl = `${options.baseUrl ?? TIKTOK_BASE_URL}/${options.apiVersion ?? TIKTOK_API_VERSION}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Issues one GET and unwraps the envelope.
   *
   * Array-valued parameters — `metrics`, `dimensions`, `fields` — are sent as JSON, which is
   * what the API expects. Sending them as repeated keys returns an empty result rather than
   * an error, so it fails silently.
   */
  async get<T>(path: string, params: Record<string, string | string[] | number> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\//, "")}`);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, Array.isArray(value) ? JSON.stringify(value) : String(value));
    }

    const response = await fetchWithRetry(
      () =>
        this.fetchImpl(url.toString(), {
          headers: { "Access-Token": this.options.accessToken, "Content-Type": "application/json" },
        }),
      { sleep: this.sleep },
    );

    const body = await response.text();

    let payload: TikTokEnvelope<T>;
    try {
      payload = JSON.parse(body) as TikTokEnvelope<T>;
    } catch {
      throw new HttpError(response.status, url.toString(), body);
    }

    // Checked before the status: TikTok returns application errors with a 200.
    if (payload.code !== 0) {
      throw new TikTokApiError(payload.code, payload.message, payload.request_id);
    }
    if (!response.ok) throw new HttpError(response.status, url.toString(), body);

    if (payload.data === undefined) {
      throw new Error(`TikTok returned code 0 with no data for ${path}`);
    }
    return payload.data;
  }

  /**
   * Reads every page of a list endpoint.
   *
   * `total_page` is authoritative and is re-read on each response, because a list can grow
   * between requests. The loop still carries its own ceiling: a `total_page` that never
   * shrinks would otherwise page forever.
   */
  async getAll<T>(
    path: string,
    params: Record<string, string | string[] | number> = {},
    pageSize = 100,
    maxPages = 200,
  ): Promise<T[]> {
    const collected: T[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const data = await this.get<TikTokList<T>>(path, { ...params, page, page_size: pageSize });
      collected.push(...(data.list ?? []));
      totalPages = data.page_info?.total_page ?? 1;
      page += 1;

      if (page > maxPages && page <= totalPages) {
        throw new Error(`${path} exceeded ${maxPages} pages without completing`);
      }
    } while (page <= totalPages);

    return collected;
  }
}
