/**
 * Tests for the Shopify write-side repository.
 *
 * The risks here are not arithmetic — normalisation is tested separately. They are mapping
 * risks: writing a business date into a timestamp column, losing the fields normalisation
 * drops, failing to resolve a Shopify GID to a row id, and duplicating rows when a sync is
 * re-run over a window it has already covered.
 */

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createShopifyRepository } from "@/lib/repositories/shopify-repository";
import type { MoneyBag, ShopifyOrderNode, ShopifyVariantNode } from "@/lib/connectors/shopify/types";
import { createFakeSupabase, type Row } from "./helpers/fake-supabase";

const ORGANISATION_ID = "org-1";
const options = { businessTimezone: "Europe/London" };
const bag = (amount: string): MoneyBag => ({ shopMoney: { amount, currencyCode: "GBP" } });

/** A £30 order: 2 units at £15 including 20% VAT, plus £3.95 shipping including VAT. */
function order(overrides: Partial<ShopifyOrderNode> = {}): ShopifyOrderNode {
  return {
    id: "gid://shopify/Order/1",
    name: "#1001",
    createdAt: "2026-06-01T10:00:00Z",
    processedAt: "2026-06-01T10:00:00Z",
    updatedAt: "2026-06-01T10:05:00Z",
    cancelledAt: null,
    test: false,
    currencyCode: "GBP",
    taxesIncluded: true,
    displayFinancialStatus: "PAID",
    customer: { id: "gid://shopify/Customer/1" },
    totalDiscountsSet: bag("0.00"),
    totalShippingPriceSet: bag("3.95"),
    totalTaxSet: bag("5.66"),
    shippingLines: { nodes: [{ taxLines: [{ priceSet: bag("0.66") }] }] },
    lineItems: {
      nodes: [
        {
          id: "gid://shopify/LineItem/1",
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

const refundedOrder = () =>
  order({
    refunds: [
      {
        id: "gid://shopify/Refund/1",
        createdAt: "2026-06-14T16:30:00Z",
        totalRefundedSet: bag("18.00"),
        refundLineItems: {
          nodes: [
            {
              quantity: 1,
              restockType: "RETURN",
              lineItem: {
                id: "gid://shopify/LineItem/1",
                sku: "ORANGE-30",
                variant: { id: "gid://shopify/ProductVariant/1" },
              },
              subtotalSet: bag("15.00"),
              totalTaxSet: bag("3.00"),
            },
          ],
        },
      },
    ],
  });

function setup(seed: Record<string, Row[]> = {}) {
  const { client, tables } = createFakeSupabase(seed);
  const repository = createShopifyRepository(client as unknown as SupabaseClient, {
    organisationId: ORGANISATION_ID,
  });
  return { repository, tables };
}

/** A variant already in the catalogue, so order lines can resolve to it. */
const knownVariant = {
  product_variants: [
    { id: "variant-uuid-1", organisation_id: ORGANISATION_ID, external_id: "gid://shopify/ProductVariant/1" },
  ],
};

describe("persistOrderBatch", () => {
  it("writes VAT-exclusive figures alongside the source fields normalisation drops", async () => {
    const { repository, tables } = setup(knownVariant);

    await repository.persistOrderBatch([order()], options);

    expect(tables.shopify_orders).toHaveLength(1);
    expect(tables.shopify_orders[0]).toMatchObject({
      external_id: "gid://shopify/Order/1",
      order_number: "#1001",
      currency: "GBP",
      financial_status: "PAID",
      // VAT stripped: £30 inc VAT is £25 net, £3.95 shipping is £3.29 net.
      gross_sales: "25.0000",
      shipping_revenue: "3.2900",
      // The tax that was removed is retained rather than discarded.
      tax: "5.6600",
    });
  });

  it("stores a timestamp in ordered_at, not the business date", async () => {
    // The engine works in business dates; the table is timestamptz. Writing "2026-06-01"
    // into it would silently lose the time and shift the row for any non-UTC timezone.
    const { repository, tables } = setup(knownVariant);

    await repository.persistOrderBatch([order()], options);

    expect(tables.shopify_orders[0].ordered_at).toBe("2026-06-01T10:00:00Z");
  });

  it("falls back to createdAt when Shopify reports no processed date", async () => {
    const { repository, tables } = setup(knownVariant);

    await repository.persistOrderBatch([order({ processedAt: null })], options);

    expect(tables.shopify_orders[0].ordered_at).toBe("2026-06-01T10:00:00Z");
    expect(tables.shopify_orders[0].processed_at).toBeNull();
  });

  it("resolves the Shopify customer GID to the customer row id", async () => {
    const { repository, tables } = setup(knownVariant);

    await repository.persistOrderBatch([order()], options);

    expect(tables.shopify_customers).toHaveLength(1);
    expect(tables.shopify_orders[0].customer_id).toBe(tables.shopify_customers[0].id);
  });

  it("writes a guest order with a null customer rather than failing", async () => {
    const { repository, tables } = setup(knownVariant);

    await repository.persistOrderBatch([order({ customer: null })], options);

    expect(tables.shopify_orders[0].customer_id).toBeNull();
    expect(tables.shopify_customers ?? []).toHaveLength(0);
  });

  it("resolves a known variant on the order line", async () => {
    const { repository, tables } = setup(knownVariant);

    const result = await repository.persistOrderBatch([order()], options);

    expect(tables.shopify_order_lines[0].variant_id).toBe("variant-uuid-1");
    expect(result.unresolvedVariants).toBe(0);
  });

  it("reports unresolved variants instead of inventing a catalogue row", async () => {
    // Orders are commonly synced before products. The line keeps its SKU and a null
    // variant_id, and the count surfaces that SKU reporting is incomplete until the
    // catalogue is synced.
    const { repository, tables } = setup();

    const result = await repository.persistOrderBatch([order()], options);

    expect(tables.shopify_order_lines[0].variant_id).toBeNull();
    expect(tables.shopify_order_lines[0].sku).toBe("ORANGE-30");
    expect(result.unresolvedVariants).toBe(1);
    expect(tables.product_variants ?? []).toHaveLength(0);
  });

  it("re-running the same batch rewrites rows rather than duplicating them", async () => {
    const { repository, tables } = setup(knownVariant);

    await repository.persistOrderBatch([refundedOrder()], options);
    await repository.persistOrderBatch([refundedOrder()], options);

    expect(tables.shopify_orders).toHaveLength(1);
    expect(tables.shopify_order_lines).toHaveLength(1);
    expect(tables.shopify_refunds).toHaveLength(1);
    expect(tables.shopify_refund_lines).toHaveLength(1);
    expect(tables.shopify_customers).toHaveLength(1);
  });

  it("returns per-table counts for what was written", async () => {
    const { repository } = setup(knownVariant);

    const result = await repository.persistOrderBatch([refundedOrder()], options);

    expect(result).toEqual({
      orders: 1,
      orderLines: 1,
      refunds: 1,
      refundLines: 1,
      customers: 1,
      unresolvedVariants: 0,
    });
  });

  it("does nothing on an empty page", async () => {
    const { repository, tables } = setup();

    const result = await repository.persistOrderBatch([], options);

    expect(result.orders).toBe(0);
    expect(tables.shopify_orders ?? []).toHaveLength(0);
  });
});

describe("persistVariantBatch", () => {
  const variantNode = (overrides: Partial<ShopifyVariantNode> = {}): ShopifyVariantNode => ({
    id: "gid://shopify/ProductVariant/1",
    sku: "0001",
    title: "Real Orange",
    updatedAt: "2026-08-01T10:00:00Z",
    product: { id: "gid://shopify/Product/1", title: "QNCH Real Fruit Electrolytes", status: "ACTIVE" },
    inventoryItem: {
      inventoryLevels: {
        nodes: [
          {
            location: { id: "gid://shopify/Location/1" },
            quantities: [
              { name: "available", quantity: 420 },
              { name: "incoming", quantity: 1000 },
            ],
          },
        ],
      },
    },
    ...overrides,
  });

  it("writes the product before the variant that depends on it", async () => {
    const { repository, tables } = setup();

    const result = await repository.persistVariantBatch([variantNode()]);

    expect(tables.products).toHaveLength(1);
    expect(tables.product_variants[0].product_id).toBe(tables.products[0].id);
    expect(result).toMatchObject({ products: 1, variants: 1 });
  });

  it("writes one product for several variants of it", async () => {
    const { repository, tables } = setup();

    await repository.persistVariantBatch([
      variantNode(),
      variantNode({ id: "gid://shopify/ProductVariant/2", sku: "0002", title: "Real Lemon" }),
    ]);

    expect(tables.products).toHaveLength(1);
    expect(tables.product_variants).toHaveLength(2);
  });

  it("normalises an empty SKU to null rather than storing a blank", async () => {
    // The live store returns "" for variants with no SKU. Stored as-is it would read as a
    // real SKU that happens to be empty, and would group with every other blank.
    const { repository, tables } = setup();

    await repository.persistVariantBatch([variantNode({ sku: "" })]);

    expect(tables.product_variants[0].sku).toBeNull();
  });

  it("reports variants with no product instead of dropping them silently", async () => {
    const { repository, tables } = setup();

    const result = await repository.persistVariantBatch([variantNode({ product: null })]);

    expect(result.variantsWithoutProduct).toBe(1);
    expect(tables.product_variants ?? []).toHaveLength(0);
  });

  it("records available and incoming stock per location", async () => {
    const { repository, tables } = setup();

    await repository.persistVariantBatch([variantNode()], "2026-08-26T00:00:00Z");

    expect(tables.inventory_snapshots[0]).toMatchObject({
      location_external_id: "gid://shopify/Location/1",
      snapshot_at: "2026-08-26T00:00:00Z",
      available_units: 420,
      units_on_order: 1000,
    });
  });

  it("uses one snapshot instant across a paged run", async () => {
    // Two pages of the same sync must not produce two snapshots dated milliseconds apart,
    // or stock cover would be computed against a split view of the same moment.
    const { repository, tables } = setup();
    const snapshotAt = "2026-08-26T00:00:00Z";

    await repository.persistVariantBatch([variantNode()], snapshotAt);
    await repository.persistVariantBatch(
      [variantNode({ id: "gid://shopify/ProductVariant/2", sku: "0002" })],
      snapshotAt,
    );

    expect(new Set(tables.inventory_snapshots.map((row) => row.snapshot_at)).size).toBe(1);
  });

  it("lets order lines resolve once the catalogue is synced", async () => {
    // The ordering that matters: catalogue first, then orders.
    const { repository, tables } = setup();

    await repository.persistVariantBatch([variantNode()]);
    const result = await repository.persistOrderBatch([order()], options);

    expect(result.unresolvedVariants).toBe(0);
    expect(tables.shopify_order_lines[0].variant_id).toBe(tables.product_variants[0].id);
  });

  it("does nothing on an empty page", async () => {
    const { repository } = setup();
    expect(await repository.persistVariantBatch([])).toMatchObject({ products: 0, variants: 0 });
  });
});

describe("persistOrderBatch first-order dates", () => {
  const CUSTOMER = "gid://shopify/Customer/1";

  it("records the first order date for a customer not seen before", async () => {
    const { repository, tables } = setup(knownVariant);

    await repository.persistOrderBatch([order()], options);

    expect(tables.shopify_customers[0].first_order_at).toBe("2026-06-01T10:00:00Z");
    expect(tables.shopify_orders[0].external_id).toBe("gid://shopify/Order/1");
  });

  it("moves the first order date backwards but never forwards", async () => {
    // A backfill pages by updatedAt, not order date, so an earlier order can arrive after a
    // later one. Only moving backwards makes the result independent of page order.
    const { repository, tables } = setup(knownVariant);

    await repository.persistOrderBatch([order()], options);
    await repository.persistOrderBatch(
      [order({ id: "gid://shopify/Order/2", processedAt: "2026-07-01T10:00:00Z" })],
      options,
    );
    expect(tables.shopify_customers[0].first_order_at).toBe("2026-06-01T10:00:00Z");

    await repository.persistOrderBatch(
      [order({ id: "gid://shopify/Order/0", processedAt: "2026-01-15T09:00:00Z" })],
      options,
    );
    expect(tables.shopify_customers[0].first_order_at).toBe("2026-01-15T09:00:00Z");
  });

  it("does not let a test or cancelled order become the acquisition", async () => {
    const { repository, tables } = setup(knownVariant);

    await repository.persistOrderBatch(
      [order({ id: "gid://shopify/Order/9", processedAt: "2026-01-01T09:00:00Z", test: true })],
      options,
    );

    expect(tables.shopify_customers[0].first_order_at ?? null).toBeNull();
  });

  it("marks a genuine first order as an acquisition", async () => {
    const { repository, tables } = setup(knownVariant);

    await repository.persistOrderBatch([order()], options);

    expect(tables.shopify_orders[0].external_id).toBe("gid://shopify/Order/1");
    expect(tables.shopify_customers[0].first_order_at).toBe("2026-06-01T10:00:00Z");
  });

  it("does not re-acquire a customer whose earlier history is already stored", async () => {
    // The failure this guards against: syncing a recent window in isolation sees only one
    // order for the customer, concludes it is their first, and inflates new-customer counts
    // and CAC. The stored first_order_at is what prevents that.
    const { repository, tables } = setup({
      ...knownVariant,
      shopify_customers: [
        {
          id: "customer-uuid-1",
          organisation_id: ORGANISATION_ID,
          external_id: CUSTOMER,
          first_order_at: "2025-11-02T12:00:00Z",
        },
      ],
    });

    await repository.persistOrderBatch(
      [order({ id: "gid://shopify/Order/77", processedAt: "2026-06-01T10:00:00Z" })],
      options,
    );

    // The stored history wins, so the June order is not treated as the acquisition.
    expect(tables.shopify_customers[0].first_order_at).toBe("2025-11-02T12:00:00Z");
    expect(tables.shopify_customers).toHaveLength(1);
  });
});

describe("persistOrderBatch refunds", () => {
  it("recognises a refund on its processed timestamp, not the order date", async () => {
    // Approved policy recognises a refund on the date it was processed. The refund here is
    // two weeks after the order, so using the order date would move it into the wrong month.
    const { repository, tables } = setup(knownVariant);

    await repository.persistOrderBatch([refundedOrder()], options);

    expect(tables.shopify_refunds[0].processed_at).toBe("2026-06-14T16:30:00Z");
    expect(tables.shopify_orders[0].ordered_at).toBe("2026-06-01T10:00:00Z");
  });

  it("splits the refund into net subtotal and tax", async () => {
    const { repository, tables } = setup(knownVariant);

    await repository.persistOrderBatch([refundedOrder()], options);

    expect(tables.shopify_refunds[0]).toMatchObject({
      total: "18.0000",
      subtotal: "15.0000",
      tax: "3.0000",
    });
  });

  it("splits out refunded shipping so the parts sum back to the total", async () => {
    // £18 of goods (£15 + £3 VAT) plus £4.74 of shipping (£3.95 + £0.79 VAT) = £22.74.
    // Before refundShippingLines was requested, the £4.74 was invisible and subtotal + tax
    // came to £18 against a total of £22.74 — a silent £4.74 hole in the refund.
    const node = refundedOrder();
    node.refunds[0].totalRefundedSet = bag("22.74");
    node.refunds[0].refundShippingLines = {
      nodes: [{ subtotalAmountSet: bag("3.95"), taxAmountSet: bag("0.79") }],
    };
    const { repository, tables } = setup(knownVariant);

    await repository.persistOrderBatch([node], options);

    const refund = tables.shopify_refunds[0];
    expect(refund).toMatchObject({
      subtotal: "15.0000",
      shipping: "3.9500",
      tax: "3.7900",
      total: "22.7400",
    });
    const parts = ["subtotal", "shipping", "tax"].reduce(
      (running, key) => running + Number(refund[key as keyof typeof refund]),
      0,
    );
    expect(parts.toFixed(2)).toBe(Number(refund.total).toFixed(2));
  });

  it("takes refunded shipping VAT off the amount that hits net revenue", async () => {
    // The engine's refund amount is VAT-exclusive. Counting only line tax would leave the
    // £0.79 shipping VAT in the figure and overstate the revenue reversal.
    const node = refundedOrder();
    node.refunds[0].totalRefundedSet = bag("22.74");
    node.refunds[0].refundShippingLines = {
      nodes: [{ subtotalAmountSet: bag("3.95"), taxAmountSet: bag("0.79") }],
    };
    const { repository, tables } = setup(knownVariant);

    await repository.persistOrderBatch([node], options);

    // £22.74 total less £3.79 of VAT = £18.95 net.
    expect(tables.shopify_orders[0].refunds).toBe("18.9500");
  });

  it("records the refund total against the order", async () => {
    // £18 refunded including £3 VAT, so £15 comes off net revenue.
    const { repository, tables } = setup(knownVariant);

    await repository.persistOrderBatch([refundedOrder()], options);

    expect(tables.shopify_orders[0].refunds).toBe("15.0000");
  });

  it("marks a restocked refund, since that drives whether stock cost reverses", async () => {
    const { repository, tables } = setup(knownVariant);

    await repository.persistOrderBatch([refundedOrder()], options);

    expect(tables.shopify_refunds[0].restocked).toBe(true);
    expect(tables.shopify_refund_lines[0].restocked).toBe(true);
  });

  it("treats a NO_RESTOCK refund as not restocked", async () => {
    const node = refundedOrder();
    node.refunds[0].refundLineItems.nodes[0].restockType = "NO_RESTOCK";
    const { repository, tables } = setup(knownVariant);

    await repository.persistOrderBatch([node], options);

    expect(tables.shopify_refunds[0].restocked).toBe(false);
    expect(tables.shopify_refund_lines[0].restocked).toBe(false);
  });

  it("derives a stable external id for refund lines, which Shopify does not give one", async () => {
    const { repository, tables } = setup(knownVariant);

    await repository.persistOrderBatch([refundedOrder()], options);

    expect(tables.shopify_refund_lines[0].external_id).toBe(
      "gid://shopify/Refund/1:gid://shopify/LineItem/1",
    );
  });

  it("keeps two refund lines on one refund apart when their line item is missing", async () => {
    // A refund line whose original line item has been removed has nothing to key on, so the
    // position is used. Without it both lines would collide on one external id and the
    // second would overwrite the first.
    const node = refundedOrder();
    const orphan = {
      quantity: 1,
      restockType: "NO_RESTOCK",
      lineItem: null,
      subtotalSet: bag("5.00"),
      totalTaxSet: bag("1.00"),
    };
    node.refunds[0].refundLineItems.nodes = [orphan, { ...orphan, subtotalSet: bag("7.00") }];
    const { repository, tables } = setup(knownVariant);

    await repository.persistOrderBatch([node], options);

    expect(tables.shopify_refund_lines).toHaveLength(2);
    expect(tables.shopify_refund_lines.map((row) => row.external_id)).toEqual([
      "gid://shopify/Refund/1:index-0",
      "gid://shopify/Refund/1:index-1",
    ]);
  });
});
