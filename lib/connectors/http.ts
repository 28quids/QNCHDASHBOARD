/**
 * Shared HTTP behaviour for provider APIs: retries, backoff and rate-limit handling.
 *
 * `fetch` and `sleep` are injectable so retry behaviour is unit-tested without real delays
 * or network access.
 */

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests to make jitter deterministic. */
  random?: () => number;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`${status} from ${url}: ${body.slice(0, 500)}`);
    this.name = "HttpError";
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Honours `Retry-After` in both its seconds and HTTP-date forms. */
export function retryAfterMs(response: Response, now: number): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** Exponential backoff with full jitter, so parallel workers do not retry in lockstep. */
export function backoffDelayMs(attempt: number, options: RetryOptions, random: () => number): number {
  const exponential = Math.min(options.baseDelayMs * 2 ** (attempt - 1), options.maxDelayMs);
  return Math.floor(random() * exponential);
}

export async function fetchWithRetry(
  request: () => Promise<Response>,
  options: Partial<RetryOptions> = {},
): Promise<Response> {
  const settings = { ...DEFAULT_RETRY, ...options };
  const sleep = settings.sleep ?? defaultSleep;
  const random = settings.random ?? Math.random;

  let lastError: unknown;

  for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await request();
    } catch (error) {
      // Network-level failure: retry unless this was the final attempt.
      lastError = error;
      if (attempt === settings.maxAttempts) break;
      await sleep(backoffDelayMs(attempt, settings, random));
      continue;
    }

    if (response.ok || !RETRYABLE_STATUSES.has(response.status)) return response;

    if (attempt === settings.maxAttempts) {
      throw new HttpError(response.status, response.url, await safeBody(response));
    }

    const wait = retryAfterMs(response, Date.now()) ?? backoffDelayMs(attempt, settings, random);
    await sleep(Math.min(wait, settings.maxDelayMs));
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function safeBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable body>";
  }
}

/** Throws on a non-2xx response, so callers do not silently parse an error body as data. */
export async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new HttpError(response.status, response.url, await safeBody(response));
  return (await response.json()) as T;
}
