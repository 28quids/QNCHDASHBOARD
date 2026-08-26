import { z } from "zod";

export const financialBucketSchema = z.enum(["cm1", "cm2", "cm3", "fixed_operating", "cash_only"]);
export const costChargeBasisSchema = z.enum(["per_order", "per_unit", "percentage_of_revenue", "fixed_period"]);

export const costAssumptionSchema = z.object({
  assumptionKey: z.string().min(1),
  financialBucket: financialBucketSchema,
  chargeBasis: costChargeBasisSchema,
  amount: z.number().nonnegative(),
  currency: z.string().length(3).default("GBP"),
  appliesTo: z.string().min(1).default("all_orders"),
  effectiveFrom: z.iso.date(),
  effectiveTo: z.iso.date().optional(),
  notes: z.string().max(2_000).optional(),
});

export type CostAssumption = z.infer<typeof costAssumptionSchema>;

/**
 * These are recorded business choices, not hidden calculation defaults. Outstanding
 * decisions are intentionally represented as null until finance approves them.
 */
export const qnchFinancialPolicyDraft = {
  vatTreatment: "exclusive",
  customerShippingRevenue: "shopify_actual",
  refundRecognition: "processed_refund_date",
  cm2: ["meta_media", "tiktok_media", "approved_other_acquisition"],
  cm3: ["fulfilment", "carrier_shipping", "variable_shopify_and_apps", "approved_variable_operating"],
  newCustomer: "first_paid_non_test_shopify_order",
  breakEvenContributionLevel: "cm3",
  targetMaximumCacGbp: 35,
  xeroBankAccountScope: "all_connected_bank_accounts",
  inventoryWindowsDays: [7, 30],
  inventoryAlertWindowDays: 7,
  cogsMethod: null,
  agencyAndCreativeTreatment: null,
} as const;
