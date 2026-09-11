import { describe, expect, it } from "vitest";
import { readEncryptedToken } from "@/lib/connectors/pipeline";
import { ShopifyGraphQlError } from "@/lib/connectors/shopify/client";

/**
 * PostgREST decides an embed's cardinality from the constraints it finds. `connection_id` is the
 * primary key of `integration_tokens` and a foreign key to `integration_connections`, which makes
 * the relationship one-to-one — so the embed arrives as an object, not an array of one.
 *
 * Reading only the array shape is how every connection came to be dropped in silence: the guard
 * saw `undefined`, concluded there was no token, and skipped the provider. The refresh then
 * reported success having synced nothing, and the dashboard showed data that had stopped
 * updating a fortnight earlier.
 */
describe("reading an embedded provider token", () => {
  it("reads the one-to-one object shape PostgREST actually returns", () => {
    expect(readEncryptedToken({ encrypted_refresh_token: "\\x00ff" })).toBe("\\x00ff");
  });

  it("still reads an array, so the cardinality is not something this bets on", () => {
    expect(readEncryptedToken([{ encrypted_refresh_token: "\\x00ff" }])).toBe("\\x00ff");
  });

  it("reports a genuinely absent token as absent", () => {
    expect(readEncryptedToken(null)).toBeNull();
    expect(readEncryptedToken(undefined)).toBeNull();
    expect(readEncryptedToken([])).toBeNull();
    expect(readEncryptedToken({})).toBeNull();
  });

  /** An empty string is not a token, and would fail later in a place that says nothing useful. */
  it("treats an empty value as absent rather than as a token", () => {
    expect(readEncryptedToken({ encrypted_refresh_token: "" })).toBeNull();
  });
});

/**
 * Payouts feed the revenue reconciliation and nothing else, and a shop that does not use Shopify
 * Payments has none to read. An app installed without the payments scope is a deliberate
 * configuration rather than a broken one, and no retry changes it — so reported as a failure it
 * turns every refresh red forever, which is how a genuine failure comes to be scrolled past.
 */
describe("recognising a missing Shopify scope", () => {
  it("identifies the access-denied response Shopify actually returns", () => {
    const error = new ShopifyGraphQlError([
      {
        message:
          "Access denied for shopifyPaymentsAccount field. Required access: the `read_shopify_payments` or the `read_shopify_payments_accounts` access scope.",
      },
    ]);

    expect(error.isMissingScope).toBe(true);
  });

  /** A throttle or a bad field is a fault and must keep reading as one. */
  it("does not mistake an ordinary GraphQL error for a permission answer", () => {
    expect(new ShopifyGraphQlError([{ message: "Throttled" }]).isMissingScope).toBe(false);
    expect(
      new ShopifyGraphQlError([{ message: "Field 'summary' doesn't exist on type 'Payout'" }]).isMissingScope,
    ).toBe(false);
  });
});
