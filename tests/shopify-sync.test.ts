/**
 * End-to-end test of the Shopify order sync.
 *
 * Everything below the network is real: the sync runner, the Supabase-backed store, the
 * repository, normalisation and the GraphQL client. Only the HTTP call and Postgres are
 * faked. This is the path a backfill takes, so it is the one that has to hold together —
 * each part passing in isolation says nothing about whether they fit.
 */

import { describe, expect, it } from "vitest";
import { ShopifyClient } from "@/lib/connectors/shopify/client";
import { buildShopifyOrdersSyncJob } from "@/lib/connectors/shopify/sync";
import { createSupabaseSyncStore } from "@/lib/connectors/supabase-sync-store";
import { runSync } from "@/lib/connectors/sync-runner";
import { createShopifyRepository } from "@/lib/repositories/shopify-repository";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MoneyBag, ShopifyOrderNode } from "@/lib/connectors/shopify/types";
import { createFakeSupabase, type Row } from "./helpers/fake-supabase";

const ORGANISATION_ID = "org-1";
const CONNECTION_ID = "connection-1";
const bag = (amount: string): MoneyBag => ({ shopMoney: { amount, currencyCode: "GBP" } });

function orderNode(id: number, overrides: Partial<ShopifyOrderNode> = {}): ShopifyOrderNode {
  return {
    id: `gid://shopify/Order/${id}`,
    name: `#${1000 + id}`,
    createdAt: "2026-06-01T10:00:00Z",
    processedAt: "2026-06-01T10:00:00Z",
    updatedAt: `2026-06-0${id}T10:05:00Z`,
    cancelledAt: null,
    test: false,
    currencyCode: "GBP",
    taxesIncluded: true,
    displayFinancialStatus: "PAID",
    customer: { id: `gid://shopify/Customer/${id}` },
    totalDiscountsSet: bag("0.00"),
    totalShippingPriceSet: bag("3.95"),
    totalTaxSet: bag("5.66"),
    shippingLines: { nodes: [{ taxLines: [{ priceSet: bag("0.66") }] }] },
    lineItems: {
      nodes: [
        {
          id: `gid://shopify/LineItem/${id}`,
          quantity: 2,
          sku: "ORANGE-30",
          variant: { id: "gid://shopify/ProductVariant/1" },
          originalTotalSet: bag("30.00"),
          discountedTotalSet: bag("30.00"),
          taxLines: [{ priceSet: bag("5.00") }],
        },
      ],
    },
    refunds: [],
    ...overrides,
  };
}

/**
 * A fake Admin API serving a fixed set of orders in pages. Records every request so the
 * cursor handling can be asserted rather than assumed.
 */
function fakeShopify(pages: ShopifyOrderNode[][]) {
  const requests: Array<{ cursor: string | null; query: string }> = [];

  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      variables: { cursor: string | null; query: string };
    };
    requests.push({ cursor: body.variables.cursor, query: body.variables.query });

    const index = body.variables.cursor === null ? 0 : Number(body.variables.cursor);
    const nodes = pages[index] ?? [];
    const hasNextPage = index + 1 < pages.length;

    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          orders: {
            pageInfo: { hasNextPage, endCursor: hasNextPage ? String(index + 1) : null },
            nodes,
          },
        },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

function setup(pages: ShopifyOrderNode[][], seed: Record<string, Row[]> = {}) {
  const { fetchImpl, requests } = fakeShopify(pages);
  const { client: fakeDb, tables } = createFakeSupabase({
    product_variants: [
      { id: "variant-uuid-1", organisation_id: ORGANISATION_ID, external_id: "gid://shopify/ProductVariant/1" },
    ],
    integration_connections: [{ id: CONNECTION_ID, last_attempt_at: null, last_success_at: null }],
    ...seed,
  });
  const supabase = fakeDb as unknown as SupabaseClient;

  const job = buildShopifyOrdersSyncJob({
    client: new ShopifyClient({ shopDomain: "qnch.myshopify.com", accessToken: "token", fetchImpl }),
    repository: createShopifyRepository(supabase, { organisationId: ORGANISATION_ID }),
    connectionId: CONNECTION_ID,
    businessTimezone: "Europe/London",
    updatedSince: null,
    jobDiscriminator: "backfill-2026-06",
    pageSize: 2,
  });

  return { job, store: createSupabaseSyncStore(supabase), tables, requests };
}

describe("Shopify order sync, end to end", () => {
  it("pages through the API and persists every order", async () => {
    const { job, store, tables } = setup([[orderNode(1), orderNode(2)], [orderNode(3)]]);

    const outcome = await runSync(job, store);

    expect(outcome.status).toBe("succeeded");
    expect(outcome).toMatchObject({ pages: 2, received: 3, written: 3 });
    expect(tables.shopify_orders).toHaveLength(3);
    expect(tables.shopify_order_lines).toHaveLength(3);
    expect(tables.shopify_customers).toHaveLength(3);
  });

  it("follows the cursor from one page to the next", async () => {
    const { job, store, requests } = setup([[orderNode(1), orderNode(2)], [orderNode(3)]]);

    await runSync(job, store);

    expect(requests.map((request) => request.cursor)).toEqual([null, "1"]);
  });

  it("stores the highest updatedAt as the resumable watermark", async () => {
    const { job, store, tables } = setup([[orderNode(1), orderNode(2)], [orderNode(3)]]);

    await runSync(job, store);

    expect(tables.sync_cursors).toHaveLength(1);
    expect(tables.sync_cursors[0]).toMatchObject({
      connection_id: CONNECTION_ID,
      resource_name: "orders",
      // Null once the last page is read, so a resume does not re-page from the middle.
      cursor_value: null,
      watermark_at: "2026-06-03T10:05:00Z",
    });
  });

  it("records the run and marks the connection healthy", async () => {
    const { job, store, tables } = setup([[orderNode(1)]]);

    await runSync(job, store);

    expect(tables.sync_runs[0]).toMatchObject({
      job_key: "shopify:orders:backfill-2026-06",
      status: "succeeded",
      records_received: 1,
      records_written: 1,
    });
    expect(tables.integration_connections[0].last_success_at).not.toBeNull();
  });

  it("re-running the same job is a no-op rather than a duplicate import", async () => {
    const { job, store, tables } = setup([[orderNode(1), orderNode(2)]]);

    await runSync(job, store);
    const second = await runSync(job, store);

    expect(second).toMatchObject({ status: "skipped", reason: "already_succeeded" });
    expect(tables.shopify_orders).toHaveLength(2);
  });

  it("writes VAT-exclusive revenue through the whole path", async () => {
    // £30 inc VAT of goods and £3.95 inc VAT of shipping arrive as £25 and £3.29.
    const { job, store, tables } = setup([[orderNode(1)]]);

    await runSync(job, store);

    expect(tables.shopify_orders[0]).toMatchObject({
      gross_sales: "25.0000",
      shipping_revenue: "3.2900",
      tax: "5.6600",
    });
  });

  it("records the failure and does not mark the connection successful when the API errors", async () => {
    const { job, store, tables } = setup([[orderNode(1)]]);
    job.fetchPage = async () => {
      throw new Error("503 from Shopify");
    };

    const outcome = await runSync(job, store);

    expect(outcome.status).toBe("failed");
    expect(tables.sync_runs[0]).toMatchObject({ status: "failed", error_message: "503 from Shopify" });
    expect(tables.integration_connections[0].last_success_at).toBeNull();
    expect(tables.integration_connections[0].last_attempt_at).not.toBeNull();
  });

  it("resumes from a stored cursor instead of restarting", async () => {
    const { job, store, requests } = setup([[orderNode(1), orderNode(2)], [orderNode(3)]], {
      sync_cursors: [
        {
          connection_id: CONNECTION_ID,
          resource_name: "orders",
          cursor_value: "1",
          watermark_at: "2026-06-02T10:05:00Z",
        },
      ],
    });

    await runSync(job, store);

    // Starts at the stored cursor, so the first page is not fetched again.
    expect(requests.map((request) => request.cursor)).toEqual(["1"]);
  });
});
