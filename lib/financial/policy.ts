import type { ContributionLevel } from "./types";

/**
 * Policy the calculation engine requires QNCH to have decided. There are no silent defaults:
 * an unapproved policy is a missing input, and the caller is expected to keep
 * `business_settings.financial_policy_status` at `draft` until every field is approved.
 */

/**
 * Whether a refund also reverses the cost of goods.
 * Only the stock value is reversed — packaging and inbound freight are treated as consumed,
 * because a returned unit does not recover its packaging or the freight already paid.
 */
export type RefundCogsReversal = "reverse_when_restocked" | "always_reverse" | "never_reverse";

export interface FinancialPolicy {
  refundCogsReversal: RefundCogsReversal;
  /** Contribution level used for maximum CAC and break-even ROAS. */
  breakEvenContributionLevel: ContributionLevel;
  businessTimezone: string;
  /** Sales window used for the primary stock-out alert. */
  inventoryAlertWindowDays: number;
}

export function shouldReverseCogs(policy: FinancialPolicy, restocked: boolean): boolean {
  switch (policy.refundCogsReversal) {
    case "always_reverse":
      return true;
    case "never_reverse":
      return false;
    case "reverse_when_restocked":
      return restocked;
  }
}
