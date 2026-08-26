/**
 * Builds the runnable Shopify order sync.
 *
 * This is where the three halves meet: the client pages the Admin API, the repository
 * writes what comes back, and `runSync` handles claiming, cursors and outcomes. Until this
 * existed, a sync could fetch and normalise but had nowhere to put the result.
 */

import { fetchConnectionPage, type ShopifyClient } from "./client";
import { ORDERS_QUERY, updatedSinceQuery } from "./queries";
import type { ShopifyOrderNode } from "./types";
import { buildJobKey, type SyncJob, type SyncPage } from "../sync-runner";
import type { createShopifyRepository, PersistOrderBatchResult } from "@/lib/repositories/shopify-repository";

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

  return {
    provider: "shopify",
    resourceName: "orders",
    connectionId: options.connectionId,
    jobKey: buildJobKey("shopify", "orders", options.jobDiscriminator),

    async fetchPage(cursor: string | null): Promise<SyncPage<ShopifyOrderNode>> {
      const { nodes, nextCursor } = await fetchConnectionPage<ShopifyOrderNode>(
        options.client,
        ORDERS_QUERY,
        { cursor, query: updatedSinceQuery(options.updatedSince), pageSize },
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
