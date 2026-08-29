/**
 * Records the approved QNCH financial policy and the cost inputs the engine needs.
 *
 * Until this runs, `financial_policy_status` is `draft`, `variant_cost_profiles` and
 * `cost_assumptions` are empty, and the engine has no costs — so every contribution line
 * would read as pure revenue. That is why the dashboard refuses to present profit figures
 * while the status is draft.
 *
 * Costs are dated from the first order in the data, not from today. Applying a cost approved
 * today to trading that predates it would restate history against an assumption nobody made
 * at the time; dating from first trade means the whole history is costed on one basis, which
 * is what "standard landed cost" means.
 *
 * Safe to run repeatedly. Every write is an upsert keyed on the same natural key the database
 * already enforces, so a second run updates in place rather than duplicating a cost.
 *
 *   node scripts/seed-financial-policy.mjs            # apply
 *   node scripts/seed-financial-policy.mjs --dry-run  # print what would be written
 */

import { connect, loadEnvFile, printTable, requireEnv } from "./lib/db.mjs";

const dryRun = process.argv.includes("--dry-run");

/**
 * The thirteen items of docs/financial-policy-decision-register.md, as approved.
 * Stored as data rather than prose so the engine and any audit read the same source.
 */
const POLICY_DECISIONS = [
  ["vat_basis", { basis: "exclusive", note: "Management revenue, margin and P&L are VAT-exclusive. VAT is a cash and tax commitment, not a margin item." }],
  ["revenue_composition", { merchandise: "shopify_gross_less_discounts", customerShipping: "shopify_actual_separately_identifiable", giftCards: "recognised_on_redemption" }],
  ["refund_timing", { recognise: "processed_refund_date", retains: "original_order_link" }],
  ["costing_method", { method: "standard_landed_cost_per_sku", reviewedOn: "each_replenishment" }],
  ["cm_category_map", { cm1: ["product_cogs", "packaging", "inbound_freight", "payment_processing"], cm2: ["meta_media", "tiktok_media", "affiliate_commission", "percentage_of_spend_agency_fee"], cm3: ["fulfilment", "carrier_shipping", "variable_shopify_and_apps"], fixedOperating: ["fixed_agency_retainer", "creative_production", "retention_and_crm", "shopify_subscription", "salaries", "software", "accounting"] }],
  ["new_customer_definition", { rule: "first_paid_non_test_shopify_order_by_resolved_customer_id" }],
  ["break_even_definition", { contributionLevel: "cm3", basis: "first_order_per_customer", alsoReport: "per_sku" }],
  ["advertising_scope", { platformSpend: "daily_in_account_timezone", accountingSource: "xero_mapped_accounts", platformAttribution: "reported_separately_never_mixed_into_contribution" }],
  ["cash_scope", { bankAccounts: "all_connected_xero_bank_accounts", availableCash: "reconciled_balance_less_dated_commitments", neverUse: "accounting_profit_as_cash" }],
  ["inventory_source", { source: "shopify_inventory_by_location", reportWindows: [7, 30], alertWindow: 7 }],
  // Items 11-13 were surfaced while implementing the engine and approved on 2026-08-27.
  ["refund_cogs_reversal", { rule: "reverse_when_restocked", packagingAndFreight: "treated_as_consumed" }],
  ["blended_roas_definition", { publish: ["mer", "new_customer_roas"], doNotPublish: "an_unqualified_blended_roas" }],
  ["assumption_vs_actual", { rule: "end_date_the_assumption_when_a_xero_mapping_takes_over", onOverlap: "report_both_and_raise_duplicated_cost_source" }],
];

/**
 * Approved per-unit landed cost. The whole amount sits in product_cogs because QNCH holds a
 * single landed figure, not a product/packaging/freight split. See the warning this script
 * prints: with no split, a restocked refund reverses the full landed cost rather than only
 * the goods portion that the approved policy intends.
 */
const LANDED_COGS_PER_UNIT = "7.0700";

const COST_ASSUMPTIONS = [
  {
    key: "payment_processing",
    bucket: "cm1",
    basis: "percentage_of_revenue",
    amount: "2.0000",
    periodUnit: null,
    notes: "Card rate, 2% of order net revenue. Paired with payment_processing_per_order.",
  },
  {
    key: "payment_processing_per_order",
    bucket: "cm1",
    basis: "per_order",
    amount: "0.2500",
    periodUnit: null,
    notes: "Flat 25p per transaction. Reported on the same P&L line as the percentage.",
  },
  {
    key: "outbound_shipping",
    bucket: "cm3",
    basis: "per_order",
    amount: "2.8500",
    periodUnit: null,
    notes: "Configurable carrier assumption. End-date this when Xero carrier actuals are mapped.",
  },
  {
    key: "shopify_subscription",
    bucket: "fixed_operating",
    basis: "fixed_period",
    amount: "25.0000",
    periodUnit: "month",
    // A flat plan charge does not vary with order volume. Putting it in CM3 would make
    // contribution margin move with the calendar rather than with trading.
    notes: "Shopify plan fee. Fixed, not a CM3 variable app cost — it does not scale with orders.",
  },
];

const env = loadEnvFile();
const organisationId = requireEnv("ORGANISATION_ID", env);
const client = await connect();

try {
  const organisation = await client.query(
    "select name, business_timezone from public.organisations where id = $1",
    [organisationId],
  );
  if (organisation.rows.length === 0) {
    throw new Error(`ORGANISATION_ID ${organisationId} does not match any organisation row`);
  }
  const { name, business_timezone: timezone } = organisation.rows[0];

  const firstTrade = await client.query(
    `select to_char(min(ordered_at at time zone $2), 'YYYY-MM-DD') as first_order
     from public.shopify_orders where organisation_id = $1`,
    [organisationId, timezone],
  );
  const effectiveFrom = firstTrade.rows[0].first_order;
  if (!effectiveFrom) {
    throw new Error("No orders found. Run the Shopify backfill first so costs can be dated from first trade.");
  }

  const variants = await client.query(
    "select id, coalesce(sku, external_id) as label from public.product_variants where organisation_id = $1",
    [organisationId],
  );
  if (variants.rows.length === 0) {
    throw new Error("No product variants found. Run the Shopify catalogue sync first.");
  }

  console.log(`Organisation      ${name} (${organisationId})`);
  console.log(`Business timezone ${timezone}`);
  console.log(`Effective from    ${effectiveFrom}  (first order in the data)`);
  console.log(`Variants to cost  ${variants.rows.length}`);
  console.log("");

  printTable([
    ...COST_ASSUMPTIONS.map((a) => ({
      record: a.key,
      bucket: a.bucket,
      basis: a.basis,
      amount: a.basis === "percentage_of_revenue" ? `${Number(a.amount)}%` : `£${Number(a.amount).toFixed(2)}`,
    })),
    ...variants.rows.map((v) => ({
      record: `landed cogs · ${v.label}`,
      bucket: "cm1",
      basis: "per_unit",
      amount: `£${Number(LANDED_COGS_PER_UNIT).toFixed(2)}`,
    })),
  ]);

  if (dryRun) {
    console.log(`\nDry run — nothing written. ${POLICY_DECISIONS.length} policy decisions would also be recorded.`);
    process.exit(0);
  }

  await client.query("begin");

  for (const [key, value] of POLICY_DECISIONS) {
    await client.query(
      `insert into public.financial_policy_decisions
         (organisation_id, decision_key, decision_value, status, effective_from, approved_at)
       values ($1, $2, $3, 'approved', $4, now())
       on conflict (organisation_id, decision_key, effective_from)
       do update set decision_value = excluded.decision_value,
                     status = 'approved',
                     approved_at = now()`,
      [organisationId, key, JSON.stringify(value), effectiveFrom],
    );
  }

  for (const variant of variants.rows) {
    await client.query(
      `insert into public.variant_cost_profiles
         (organisation_id, variant_id, effective_from, product_cogs,
          packaging, inbound_freight, fulfilment, shipping, payment_processing)
       values ($1, $2, $3, $4, 0, 0, 0, 0, 0)
       on conflict (variant_id, effective_from)
       do update set product_cogs = excluded.product_cogs`,
      [organisationId, variant.id, effectiveFrom, LANDED_COGS_PER_UNIT],
    );
  }

  for (const assumption of COST_ASSUMPTIONS) {
    await client.query(
      `insert into public.cost_assumptions
         (organisation_id, assumption_key, financial_bucket, charge_basis, amount,
          currency, applies_to, effective_from, period_unit, notes)
       values ($1, $2, $3, $4, $5, 'GBP', 'all_orders', $6, $7, $8)
       on conflict (organisation_id, assumption_key, applies_to, effective_from)
       do update set financial_bucket = excluded.financial_bucket,
                     charge_basis = excluded.charge_basis,
                     amount = excluded.amount,
                     period_unit = excluded.period_unit,
                     notes = excluded.notes`,
      [
        organisationId,
        assumption.key,
        assumption.bucket,
        assumption.basis,
        assumption.amount,
        effectiveFrom,
        assumption.periodUnit,
        assumption.notes,
      ],
    );
  }

  // Only flip the status to approved once the inputs above are actually in place, in the
  // same transaction. An approved status with no costs would present revenue as contribution.
  await client.query(
    `update public.business_settings
     set financial_policy_status = 'approved',
         vat_treatment = 'exclusive',
         new_customer_definition = 'first_paid_non_test_shopify_order_by_resolved_customer_id',
         inventory_sales_window_days = 7,
         updated_at = now()
     where organisation_id = $1`,
    [organisationId],
  );

  await client.query("commit");

  console.log(`\nRecorded ${POLICY_DECISIONS.length} policy decisions, ${variants.rows.length} variant cost profiles, ${COST_ASSUMPTIONS.length} cost assumptions.`);
  console.log("business_settings.financial_policy_status is now 'approved'.");

  console.log(
    "\nKnown limitation: the £7.07 landed cost is held as a single figure, so it all sits in\n" +
      "product_cogs. Approved policy treats packaging and inbound freight as consumed on a\n" +
      "refund, but with no split available a restocked refund reverses the full £7.07. This\n" +
      "slightly overstates CM1 on refund days. Supply the product/packaging/freight split to\n" +
      "remove it.",
  );
} catch (error) {
  await client.query("rollback").catch(() => {});
  console.error(`Failed, rolled back: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
