/**
 * GraphQL documents for the Shopify Admin API.
 *
 * Orders are paged by `updatedAt` so an incremental sync collects anything edited since the
 * last watermark, not just newly created orders — an order refunded days later must be
 * re-read. `sortKey: UPDATED_AT` keeps that ordering stable across pages.
 */

export const SHOPIFY_API_VERSION = "2026-07";

export const ORDERS_QUERY = /* GraphQL */ `
  query QnchOrders($cursor: String, $query: String!, $pageSize: Int!) {
    orders(first: $pageSize, after: $cursor, query: $query, sortKey: UPDATED_AT) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        createdAt
        processedAt
        updatedAt
        cancelledAt
        test
        currencyCode
        taxesIncluded
        displayFinancialStatus
        customer {
          id
        }
        totalDiscountsSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalShippingPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalTaxSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        shippingLines(first: 10) {
          nodes {
            taxLines {
              priceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
        lineItems(first: 100) {
          nodes {
            id
            quantity
            sku
            variant {
              id
            }
            originalTotalSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            discountedTotalSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            taxLines {
              priceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
        refunds {
          id
          createdAt
          totalRefundedSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          refundShippingLines(first: 10) {
            nodes {
              subtotalAmountSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              taxAmountSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
          }
          refundLineItems(first: 100) {
            nodes {
              quantity
              restockType
              subtotalSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              totalTaxSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              lineItem {
                id
                sku
                variant {
                  id
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const VARIANTS_QUERY = /* GraphQL */ `
  query QnchVariants($cursor: String, $pageSize: Int!) {
    productVariants(first: $pageSize, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        sku
        title
        updatedAt
        product {
          id
          title
          status
        }
        inventoryItem {
          inventoryLevels(first: 20) {
            nodes {
              location {
                id
              }
              quantities(names: ["available", "incoming"]) {
                name
                quantity
              }
            }
          }
        }
      }
    }
  }
`;

/** Shopify search syntax for "updated at or after this instant". */
export const updatedSinceQuery = (since: string | null): string =>
  since ? `updated_at:>='${since}'` : "";

/**
 * Shopify search syntax for "created at or after this instant".
 *
 * For bounding an initial backfill to a period of trading. `updated_at` is the right filter
 * for incremental syncs — an order refunded later must be re-read — but it is the wrong one
 * for a window, because an old order edited inside the window would be pulled in with it.
 */
export const createdSinceQuery = (since: string | null): string =>
  since ? `created_at:>='${since}'` : "";
