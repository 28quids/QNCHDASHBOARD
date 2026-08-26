import { describe, expect, it } from "vitest";
import {
  assignNewCustomerFlags,
  isExcludedOrder,
  normaliseOrder,
  normaliseOrderBatch,
  normaliseRefunds,
} from "../lib/connectors/shopify/normalise";
import { sum } from "../lib/financial/money";
import type { MoneyBag, ShopifyOrderNode } from "../lib/connectors/shopify/types";
import type { OrderInput } from "../lib/financial/domain";

const options = { businessTimezone: "Europe/London" };
const bag = (amount: string): MoneyBag => ({ shopMoney: { amount, currencyCode: "GBP" } });

/** A £30 order: 2 units at £15 including 20% VAT, plus £3.95 shipping including VAT. */
function taxInclusiveOrder(overrides: Partial<ShopifyOrderNode> = {}): ShopifyOrderNode {
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

describe("Shopify order normalisation", () => {
  it("strips VAT when the store displays tax-inclusive prices", () => {
    const order = normaliseOrder(taxInclusiveOrder(), options);
    expect(order.grossSales.toString()).toBe("25");
    expect(order.shippingRevenue.toString()).toBe("3.29");
  });

  it("leaves amounts untouched when the store is tax-exclusive", () => {
    const order = normaliseOrder(
      taxInclusiveOrder({ taxesIncluded: false, totalTaxSet: bag("6.66") }),
      options,
    );
    expect(order.grossSales.toString()).toBe("30");
    expect(order.shippingRevenue.toString()).toBe("3.95");
  });

  it("separates discounts from merchandise value", () => {
    // £30 list, £6 discount, VAT charged on the £24 actually paid.
    const order = normaliseOrder(
      taxInclusiveOrder({
        totalDiscountsSet: bag("6.00"),
        lineItems: {
          nodes: [
            {
              id: "gid://shopify/LineItem/1",
              quantity: 2,
              sku: "ORANGE-30",
              variant: { id: "gid://shopify/ProductVariant/1" },
              originalTotalSet: bag("30.00"),
              discountedTotalSet: bag("24.00"),
              taxLines: [{ priceSet: bag("4.00") }],
            },
          ],
        },
      }),
      options,
    );
    // Ex-VAT list price £25, ex-VAT discount £5, so ex-VAT net merchandise is £20.
    expect(order.grossSales.toString()).toBe("25");
    expect(order.discounts.toString()).toBe("5");
  });

  it("maps line items with their variant and quantity", () => {
    const order = normaliseOrder(taxInclusiveOrder(), options);
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0]).toMatchObject({
      variantId: "gid://shopify/ProductVariant/1",
      sku: "ORANGE-30",
      quantity: 2,
    });
  });

  it("keeps order and line totals reconcilable", () => {
    const order = normaliseOrder(taxInclusiveOrder(), options);
    expect(sum(order.lines.map((line) => line.grossSales)).toString()).toBe(order.grossSales.toString());
  });

  it("dates the order in the business timezone, not UTC", () => {
    // 23:30 UTC on 30 June is 00:30 on 1 July in London.
    const order = normaliseOrder(taxInclusiveOrder({ processedAt: "2026-06-30T23:30:00Z" }), options);
    expect(order.businessDate).toBe("2026-07-01");
  });

  it("falls back to the created date when an order was never processed", () => {
    const order = normaliseOrder(taxInclusiveOrder({ processedAt: null, createdAt: "2026-05-04T09:00:00Z" }), options);
    expect(order.businessDate).toBe("2026-05-04");
  });

  it("excludes test and cancelled orders", () => {
    expect(isExcludedOrder(taxInclusiveOrder({ test: true }))).toBe(true);
    expect(isExcludedOrder(taxInclusiveOrder({ cancelledAt: "2026-06-02T00:00:00Z" }))).toBe(true);
    expect(isExcludedOrder(taxInclusiveOrder())).toBe(false);
    expect(normaliseOrder(taxInclusiveOrder({ test: true }), options).isExcluded).toBe(true);
  });

  it("handles a guest order with no customer", () => {
    expect(normaliseOrder(taxInclusiveOrder({ customer: null }), options).customerId).toBeNull();
  });
});

describe("Shopify refund normalisation", () => {
  const refunded = taxInclusiveOrder({
    refunds: [
      {
        id: "gid://shopify/Refund/1",
        createdAt: "2026-06-10T12:00:00Z",
        totalRefundedSet: bag("18.00"),
        refundLineItems: {
          nodes: [
            {
              quantity: 1,
              restockType: "RETURN",
              lineItem: { id: "gid://shopify/LineItem/1", sku: "ORANGE-30", variant: { id: "gid://shopify/ProductVariant/1" } },
              subtotalSet: bag("15.00"),
              totalTaxSet: bag("3.00"),
            },
          ],
        },
      },
    ],
  });

  it("recognises the refund on its processed date", () => {
    const [refund] = normaliseRefunds(refunded, options);
    expect(refund.processedBusinessDate).toBe("2026-06-10");
    expect(refund.orderExternalId).toBe("gid://shopify/Order/1");
  });

  it("reports the refund net of VAT", () => {
    const [refund] = normaliseRefunds(refunded, options);
    expect(refund.amount.toString()).toBe("15");
  });

  it("marks the refund as restocked only when stock actually returned", () => {
    expect(normaliseRefunds(refunded, options)[0].restocked).toBe(true);

    const noRestock = taxInclusiveOrder({
      refunds: [
        {
          ...refunded.refunds[0],
          refundLineItems: {
            nodes: [{ ...refunded.refunds[0].refundLineItems.nodes[0], restockType: "NO_RESTOCK" }],
          },
        },
      ],
    });
    expect(normaliseRefunds(noRestock, options)[0].restocked).toBe(false);
  });

  it("keeps refunded line detail so stock cost can be reversed", () => {
    const [refund] = normaliseRefunds(refunded, options);
    expect(refund.lines).toEqual([
      { variantId: "gid://shopify/ProductVariant/1", sku: "ORANGE-30", quantity: 1, amount: expect.anything() },
    ]);
  });

  it("returns nothing for an order with no refunds", () => {
    expect(normaliseRefunds(taxInclusiveOrder(), options)).toEqual([]);
  });
});

describe("new customer assignment", () => {
  const order = (externalId: string, customerId: string | null, businessDate: string): OrderInput => ({
    externalId,
    customerId,
    businessDate,
    grossSales: "10.00",
    discounts: "0.00",
    shippingRevenue: "0.00",
    lines: [],
    isNewCustomerOrder: false,
  });

  it("marks only the earliest order for each customer", () => {
    const flagged = assignNewCustomerFlags([
      order("o2", "c1", "2026-02-01"),
      order("o1", "c1", "2026-01-01"),
      order("o3", "c2", "2026-01-15"),
    ]);
    expect(flagged.filter((item) => item.isNewCustomerOrder).map((item) => item.externalId)).toEqual(["o1", "o3"]);
  });

  it("marks one order when a customer ordered twice on their first day", () => {
    const flagged = assignNewCustomerFlags([order("o1", "c1", "2026-01-01"), order("o2", "c1", "2026-01-01")]);
    expect(flagged.filter((item) => item.isNewCustomerOrder)).toHaveLength(1);
  });

  it("does not mislabel a repeat order as new during an incremental sync", () => {
    const flagged = assignNewCustomerFlags(
      [order("o5", "c1", "2026-06-01")],
      new Map([["c1", "2025-11-02"]]),
    );
    expect(flagged[0].isNewCustomerOrder).toBe(false);
  });

  it("never marks a guest or excluded order as an acquisition", () => {
    const flagged = assignNewCustomerFlags([
      order("o1", null, "2026-01-01"),
      { ...order("o2", "c9", "2026-01-01"), isExcluded: true },
    ]);
    expect(flagged.every((item) => !item.isNewCustomerOrder)).toBe(true);
  });
});

describe("order batch normalisation", () => {
  it("returns orders, refunds and the sync watermark together", () => {
    const batch = normaliseOrderBatch(
      [
        taxInclusiveOrder(),
        taxInclusiveOrder({
          id: "gid://shopify/Order/2",
          updatedAt: "2026-06-02T09:00:00Z",
          customer: { id: "gid://shopify/Customer/2" },
          refunds: [
            {
              id: "gid://shopify/Refund/9",
              createdAt: "2026-06-05T00:00:00Z",
              totalRefundedSet: bag("12.00"),
              refundLineItems: { nodes: [] },
            },
          ],
        }),
      ],
      options,
    );

    expect(batch.orders).toHaveLength(2);
    expect(batch.refunds).toHaveLength(1);
    expect(batch.watermarkAt).toBe("2026-06-02T09:00:00Z");
    expect(batch.orders.every((item) => item.isNewCustomerOrder)).toBe(true);
  });

  it("handles an empty page", () => {
    expect(normaliseOrderBatch([], options)).toEqual({ orders: [], refunds: [], watermarkAt: null });
  });
});
