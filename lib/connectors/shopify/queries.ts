/**
 * GraphQL documents for the Shopify Admin API.
 *
 * Orders are paged by `updatedAt` so an incremental sync collects anything edited since the
 * last watermark, not just newly created orders — an order refunded days later must be
 * re-read. `sortKey: UPDATED_AT` keeps that ordering stable across pages.
 *
 * Discounts are read from `discountAllocations`, never from `discountedTotalSet`. The latter
 * reflects line-level discounts only: on an order carrying a cart-wide code it equals the
 * original price, so the discount vanishes and revenue reads high. `totalPriceSet` is fetched
 * alongside so the parts can be checked against what the customer was actually charged.
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
        totalPriceSet {
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
            discountAllocations {
              allocatedAmountSet {
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
            discountAllocations {
              allocatedAmountSet {
                shopMoney {
                  amount
                  currencyCode
                }
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

/**
 * Payouts from Shopify Payments, for reconciling reported revenue against money settled.
 *
 * Two documents rather than one, and the reason is worth stating. The summary breakdown —
 * charges, refunds, adjustments and the fees on each — is the useful detail, but a GraphQL
 * field name that does not exist in the shop's API version fails the *whole* query rather than
 * returning null. Requiring the breakdown would therefore make the payout sync all-or-nothing.
 *
 * `PAYOUTS_QUERY` asks for the detail; `PAYOUTS_MINIMAL_QUERY` asks only for what the
 * reconciliation genuinely needs, and is used when the first is rejected. Net amount alone is
 * enough to compare settlements with revenue; the breakdown only explains the difference.
 *
 * Requires the `read_shopify_payments_payouts` scope. A shop that does not use Shopify Payments
 * has no `shopifyPaymentsAccount` at all, which is null rather than an error.
 */
const PAYOUT_HEADER = /* GraphQL */ `
  id
  issuedAt
  status
  net {
    amount
    currencyCode
  }
`;

export const PAYOUTS_QUERY = /* GraphQL */ `
  query QnchPayouts($cursor: String, $pageSize: Int!) {
    shopifyPaymentsAccount {
      payouts(first: $pageSize, after: $cursor, sortKey: ISSUED_AT) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          ${PAYOUT_HEADER}
          summary {
            chargesGross { amount }
            chargesFee { amount }
            refundsFeeGross { amount }
            refundsFee { amount }
            adjustmentsGross { amount }
            adjustmentsFee { amount }
          }
        }
      }
    }
  }
`;

export const PAYOUTS_MINIMAL_QUERY = /* GraphQL */ `
  query QnchPayoutsMinimal($cursor: String, $pageSize: Int!) {
    shopifyPaymentsAccount {
      payouts(first: $pageSize, after: $cursor, sortKey: ISSUED_AT) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          ${PAYOUT_HEADER}
        }
      }
    }
  }
`;
