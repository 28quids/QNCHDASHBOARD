/**
 * Builds the runnable Shopify order sync.
 *
 * This is where the three halves meet: the client pages the Admin API, the repository
 * writes what comes back, and `runSync` handles claiming, cursors and outcomes. Until this
 * existed, a sync could fetch and normalise but had nowhere to put the result.
 */

import { fetchConnectionPage, type ShopifyClient } from "./client";
import { ORDERS_QUERY, VARIANTS_QUERY, createdSinceQuery, updatedSinceQuery } from "./queries";
import type { ShopifyOrderNode, ShopifyVariantNode } from "./types";
import { buildJobKey, type SyncJob, type SyncPage } from "../sync-runner";
import type {
  createShopifyRepository,
  PersistOrderBatchResult,
  PersistVariantBatchResult,
} from "@/lib/repositories/shopify-repository";

/** Shopify caps `first` at 250, and a large page costs more against the query budget. */
const DEFAULT_PAGE_SIZE = 50;

export interface ShopifyOrdersSyncOptions {
  client: ShopifyClient;
  repository: ReturnType<typeof createShopifyRepository>;
  connectionId: string;
  businessTimezone: string;
  /**
   * Lower bound on `updatedAt`. Null reads the whole order history, which is what a first
   * backfill wants. Incremental runs pass the previous watermark.
   */
  updatedSince: string | null;
  /**
   * Lower bound on `createdAt`, for bounding a backfill to a period of trading. Takes
   * precedence over `updatedSince` when set, because the two cannot both be applied: an old
   * order edited inside an `updatedAt` window would otherwise be pulled in with it.
   */
  createdSince?: string | null;
  /**
   * Distinguishes this run from another over a different window. Re-running the same
   * discriminator is a deliberate no-op — that is what makes a retried cron safe.
   */
  jobDiscriminator: string;
  pageSize?: number;
  /** Called after each page is written, for progress reporting. */
  onPagePersisted?: (result: PersistOrderBatchResult) => void;
}

export function buildShopifyOrdersSyncJob(options: ShopifyOrdersSyncOptions): SyncJob<ShopifyOrderNode> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const searchQuery = options.createdSince
    ? createdSinceQuery(options.createdSince)
    : updatedSinceQuery(options.updatedSince);

  return {
    provider: "shopify",
    resourceName: "orders",
    connectionId: options.connectionId,
    jobKey: buildJobKey("shopify", "orders", options.jobDiscriminator),

    async fetchPage(cursor: string | null): Promise<SyncPage<ShopifyOrderNode>> {
      const { nodes, nextCursor } = await fetchConnectionPage<ShopifyOrderNode>(
        options.client,
        ORDERS_QUERY,
        { cursor, query: searchQuery, pageSize },
        (data) => data.orders,
      );

      return {
        records: nodes,
        nextCursor,
        // Orders are sorted by UPDATED_AT, but the watermark is taken as a maximum rather
        // than from the last node, so an unexpected ordering cannot move it backwards.
        watermarkAt: nodes.reduce<string | null>(
          (latest, node) => (latest === null || node.updatedAt > latest ? node.updatedAt : latest),
          null,
        ),
      };
    },

    async upsert(records: ShopifyOrderNode[]): Promise<number> {
      const result = await options.repository.persistOrderBatch(records, {
        businessTimezone: options.businessTimezone,
      });
      options.onPagePersisted?.(result);
      // Orders written, so it stays comparable with records_received on the same run.
      return result.orders;
    },
  };
}

export interface ShopifyVariantsSyncOptions {
  client: ShopifyClient;
  repository: ReturnType<typeof createShopifyRepository>;
  connectionId: string;
  /**
   * Distinguishes this run. The catalogue has no incremental filter, so this is normally
   * dated — a re-sync on a later day is a different job, a repeat on the same day is not.
   */
  jobDiscriminator: string;
  pageSize?: number;
  /** One instant for the whole run, so a paged sync produces one inventory snapshot. */
  snapshotAt?: string;
  onPagePersisted?: (result: PersistVariantBatchResult) => void;
}

/**
 * Builds the product catalogue sync.
 *
 * Run this before an order backfill. Order lines resolve their variant against
 * `product_variants`, so an empty catalogue means every line is written unattributed.
 */
export function buildShopifyVariantsSyncJob(
  options: ShopifyVariantsSyncOptions,
): SyncJob<ShopifyVariantNode> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const snapshotAt = options.snapshotAt ?? new Date().toISOString();

  return {
    provider: "shopify",
    resourceName: "variants",
    connectionId: options.connectionId,
    jobKey: buildJobKey("shopify", "variants", options.jobDiscriminator),

    async fetchPage(cursor: string | null): Promise<SyncPage<ShopifyVariantNode>> {
      const { nodes, nextCursor } = await fetchConnectionPage<ShopifyVariantNode>(
        options.client,
        VARIANTS_QUERY,
        { cursor, pageSize },
        (data) => data.productVariants,
      );

      return {
        records: nodes,
        nextCursor,
        watermarkAt: nodes.reduce<string | null>(
          (latest, node) => (latest === null || node.updatedAt > latest ? node.updatedAt : latest),
          null,
        ),
      };
    },

    async upsert(records: ShopifyVariantNode[]): Promise<number> {
      const result = await options.repository.persistVariantBatch(records, snapshotAt);
      options.onPagePersisted?.(result);
      return result.variants;
    },
  };
}
