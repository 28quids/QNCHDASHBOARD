import { fetchWithRetry, HttpError } from "../http";
import { SHOPIFY_API_VERSION } from "./queries";
import type { GraphQlResponse } from "./types";

/**
 * Shopify GraphQL Admin API client.
 *
 * Shopify meters GraphQL by query cost against a leaky bucket rather than by request count,
 * so the client waits for the bucket to refill when the remaining budget runs low. That avoids
 * provoking throttling instead of merely reacting to it.
 */

export interface ShopifyClientOptions {
  shopDomain: string;
  accessToken: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Pause when fewer than this many cost points remain. */
  costFloor?: number;
}

export class ShopifyGraphQlError extends Error {
  constructor(readonly errors: { message: string }[]) {
    super(`Shopify GraphQL error: ${errors.map((error) => error.message).join("; ")}`);
    this.name = "ShopifyGraphQlError";
  }

  /**
   * True when the app's access token lacks a scope the query needs.
   *
   * Worth separating from every other GraphQL error because it is not a fault and no retry
   * fixes it: someone has to grant the scope and reinstall the app. Treated as a failure it
   * recurs on every sync forever, and a line that is always red is a line nobody reads.
   */
  get isMissingScope(): boolean {
    return this.errors.some((error) => /access denied|required access|access scope/i.test(error.message));
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ShopifyClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly costFloor: number;

  constructor(private readonly options: ShopifyClientOptions) {
    const version = options.apiVersion ?? SHOPIFY_API_VERSION;
    this.endpoint = `https://${options.shopDomain}/admin/api/${version}/graphql.json`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.costFloor = options.costFloor ?? 200;
  }

  async query<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await fetchWithRetry(
      () =>
        this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-shopify-access-token": this.options.accessToken,
          },
          body: JSON.stringify({ query: document, variables }),
        }),
      { sleep: this.sleep },
    );

    if (!response.ok) {
      throw new HttpError(response.status, this.endpoint, await response.text());
    }

    const payload = (await response.json()) as GraphQlResponse<T>;

    // A GraphQL error arrives with HTTP 200, so it must be checked explicitly.
    if (payload.errors?.length) throw new ShopifyGraphQlError(payload.errors);
    if (!payload.data) throw new ShopifyGraphQlError([{ message: "Response contained no data" }]);

    await this.respectCostBudget(payload);
    return payload.data;
  }

  /** Waits for the leaky bucket to refill when the remaining query budget is nearly spent. */
  private async respectCostBudget(payload: GraphQlResponse<unknown>): Promise<void> {
    const throttle = payload.extensions?.cost?.throttleStatus;
    if (!throttle || throttle.currentlyAvailable >= this.costFloor) return;

    const deficit = this.costFloor - throttle.currentlyAvailable;
    const waitMs = Math.ceil((deficit / Math.max(throttle.restoreRate, 1)) * 1000);
    await this.sleep(Math.min(waitMs, 10_000));
  }
}

export interface Connection<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}

/** Reads one page and returns it in the shape the sync runner expects. */
export async function fetchConnectionPage<T>(
  client: ShopifyClient,
  document: string,
  variables: Record<string, unknown>,
  select: (data: Record<string, Connection<T>>) => Connection<T>,
): Promise<{ nodes: T[]; nextCursor: string | null }> {
  const data = await client.query<Record<string, Connection<T>>>(document, variables);
  const connection = select(data);

  return {
    nodes: connection.nodes,
    nextCursor: connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null,
  };
}
