/**
 * Reads stored facts back out as the financial engine's inputs.
 *
 * The engine is pure and the connectors only write, so until this existed there was no path
 * from the database to a number. This is that path, and it is deliberately the only one: no
 * calculation happens here, and no policy is decided here. It loads, shapes and hands over.
 *
 * Three things are load-bearing:
 *
 *  - **Business dates are computed here, not in SQL.** PostgREST cannot express `at time zone`,
 *    so rows are fetched over a UTC window padded by a day and then filtered exactly on the
 *    business date. Filtering on UTC alone would move a 00:30 BST order into the previous day.
 *
 *  - **Refunds pull their original order in, even from outside the range.** Reversing the cost
 *    of a refunded unit needs the cost profile in force on the *original* order date. The
 *    engine reports a refund whose order it cannot see as a warning, so the order ids are
 *    collected from the refunds and loaded explicitly rather than hoping the window covers them.
 *
 *  - **An unapproved policy is not a zero.** If finance has not approved the policy, or a
 *    required decision is missing, this returns `not_approved` with the specific gaps. It does
 *    not fall back to a default, because a default would present a number nobody approved.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { assignNewCustomerFlags } from "@/lib/connectors/shopify/normalise";
import type { AllocationContext } from "@/lib/financial/allocation";
import { addDays, toBusinessDate, type DateRange } from "@/lib/financial/dates";
import { money } from "@/lib/financial/money";
import type {
  AdSpendInput,
  CostAssumptionRecord,
  FinancialBucket,
  MappedExpenseInput,
  OrderInput,
  OrderLineInput,
  RefundInput,
  VariantCostProfile,
} from "@/lib/financial/domain";
import type { ContributionLevel } from "@/lib/financial/types";
import type { FinancialPolicy, RefundCogsReversal } from "@/lib/financial/policy";

export interface ReportingRepositoryContext {
  organisationId: string;
  businessTimezone: string;
}

export interface ReportingFacts {
  range: DateRange;
  orders: OrderInput[];
  refunds: RefundInput[];
  adSpend: AdSpendInput[];
  mappedExpenses: MappedExpenseInput[];
  context: AllocationContext;
  policy: FinancialPolicy;
}

export type PolicyLoad =
  | { status: "approved"; policy: FinancialPolicy }
  /** Named gaps, so the dashboard can say which decision is outstanding rather than "no data". */
  | { status: "not_approved"; missing: string[] };

const REFUND_REVERSALS: readonly RefundCogsReversal[] = [
  "reverse_when_restocked",
  "always_reverse",
  "never_reverse",
];

/**
 * Xero's expense categories onto the engine's contribution buckets. `excluded` yields null so
 * the transaction is dropped rather than defaulting into a margin line.
 */
const EXPENSE_BUCKETS: Record<string, FinancialBucket | null> = {
  acquisition: "cm2",
  variable_operating: "cm3",
  fixed_operating: "fixed_operating",
  cash_commitment: "cash_only",
  excluded: null,
};

/** Widens a business-date range into the UTC window that can possibly contain it. */
function utcWindow(range: DateRange): { fromIso: string; toIso: string } {
  return {
    fromIso: `${addDays(range.from, -1)}T00:00:00.000Z`,
    toIso: `${addDays(range.to, 2)}T00:00:00.000Z`,
  };
}

export function createReportingRepository(
  client: SupabaseClient,
  context: ReportingRepositoryContext,
) {
  const { organisationId, businessTimezone } = context;
  const businessDate = (instant: string) => toBusinessDate(instant, businessTimezone);
  const inRange = (date: string, range: DateRange) => date >= range.from && date <= range.to;

  async function loadPolicy(): Promise<PolicyLoad> {
    const missing: string[] = [];

    const { data: settings, error: settingsError } = await client
      .from("business_settings")
      .select("financial_policy_status, vat_treatment, inventory_sales_window_days")
      .eq("organisation_id", organisationId)
      .maybeSingle();
    if (settingsError) throw settingsError;

    if (!settings) return { status: "not_approved", missing: ["business_settings row"] };
    if (settings.financial_policy_status !== "approved") {
      missing.push("business_settings.financial_policy_status is still draft");
    }
    if (settings.vat_treatment === null) missing.push("VAT treatment (register item 1)");
    if (settings.inventory_sales_window_days === null) {
      missing.push("inventory alert window (register item 10)");
    }

    const { data: decisions, error: decisionError } = await client
      .from("financial_policy_decisions")
      .select("decision_key, decision_value, status")
      .eq("organisation_id", organisationId)
      .eq("status", "approved");
    if (decisionError) throw decisionError;

    const byKey = new Map(
      (decisions ?? []).map((row) => [
        row.decision_key as string,
        row.decision_value as Record<string, unknown>,
      ]),
    );

    const reversal = byKey.get("refund_cogs_reversal")?.rule as RefundCogsReversal | undefined;
    if (!reversal || !REFUND_REVERSALS.includes(reversal)) {
      missing.push("refund cost reversal (register item 11)");
    }

    const level = byKey.get("break_even_definition")?.contributionLevel as ContributionLevel | undefined;
    if (level !== "cm1" && level !== "cm3") {
      missing.push("break-even contribution level (register item 7)");
    }

    if (missing.length > 0) return { status: "not_approved", missing };

    return {
      status: "approved",
      policy: {
        refundCogsReversal: reversal as RefundCogsReversal,
        breakEvenContributionLevel: level as ContributionLevel,
        businessTimezone,
        inventoryAlertWindowDays: settings.inventory_sales_window_days as number,
      },
    };
  }

  async function loadAllocationContext(): Promise<AllocationContext> {
    const [{ data: profiles, error: profileError }, { data: assumptions, error: assumptionError }] =
      await Promise.all([
        client
          .from("variant_cost_profiles")
          .select(
            "variant_id, effective_from, effective_to, product_cogs, packaging, inbound_freight, payment_processing, fulfilment, shipping",
          )
          .eq("organisation_id", organisationId),
        client
          .from("cost_assumptions")
          .select(
            "assumption_key, financial_bucket, charge_basis, amount, applies_to, effective_from, effective_to, period_unit",
          )
          .eq("organisation_id", organisationId),
      ]);
    if (profileError) throw profileError;
    if (assumptionError) throw assumptionError;

    const variantCostProfiles: VariantCostProfile[] = (profiles ?? []).map((row) => ({
      variantId: row.variant_id as string,
      effectiveFrom: row.effective_from as string,
      effectiveTo: (row.effective_to as string | null) ?? null,
      productCogs: row.product_cogs as string,
      packaging: row.packaging as string,
      inboundFreight: row.inbound_freight as string,
      paymentProcessing: row.payment_processing as string,
      fulfilment: row.fulfilment as string,
      shipping: row.shipping as string,
    }));

    const costAssumptions: CostAssumptionRecord[] = (assumptions ?? []).map((row) => ({
      assumptionKey: row.assumption_key as string,
      financialBucket: row.financial_bucket as FinancialBucket,
      chargeBasis: row.charge_basis as CostAssumptionRecord["chargeBasis"],
      amount: row.amount as string,
      appliesTo: row.applies_to as string,
      effectiveFrom: row.effective_from as string,
      effectiveTo: (row.effective_to as string | null) ?? null,
      periodUnit: (row.period_unit as CostAssumptionRecord["periodUnit"]) ?? null,
    }));

    return { variantCostProfiles, costAssumptions };
  }

  /**
   * Orders in the range, plus any specifically requested by id.
   *
   * The extra ids are the originals behind refunds processed inside the range. They produce no
   * rows of their own — the engine only emits dates within the range — but their presence is
   * what lets a refund's cost reversal find the profile that was in force when it was sold.
   */
  async function loadOrders(range: DateRange, alsoIncludeIds: readonly string[] = []) {
    const { fromIso, toIso } = utcWindow(range);

    const windowQuery = client
      .from("shopify_orders")
      .select("id, external_id, customer_id, ordered_at, gross_sales, discounts, shipping_revenue")
      .eq("organisation_id", organisationId)
      .eq("is_test", false)
      .is("cancelled_at", null)
      .gte("ordered_at", fromIso)
      .lt("ordered_at", toIso);

    const { data: windowRows, error: windowError } = await windowQuery;
    if (windowError) throw windowError;

    const rows = [...(windowRows ?? [])];
    const seen = new Set(rows.map((row) => row.id as string));
    const outstanding = alsoIncludeIds.filter((id) => !seen.has(id));

    if (outstanding.length > 0) {
      const { data: extra, error: extraError } = await client
        .from("shopify_orders")
        .select("id, external_id, customer_id, ordered_at, gross_sales, discounts, shipping_revenue")
        .eq("organisation_id", organisationId)
        .eq("is_test", false)
        .is("cancelled_at", null)
        .in("id", outstanding);
      if (extraError) throw extraError;
      rows.push(...(extra ?? []));
    }

    // Rows fetched on a padded UTC window; anything whose business date falls outside the
    // range is dropped here, unless it was pulled in deliberately for a refund.
    const requested = new Set(alsoIncludeIds);
    const kept = rows.filter(
      (row) => requested.has(row.id as string) || inRange(businessDate(row.ordered_at as string), range),
    );

    return kept;
  }

  async function loadOrderLines(orderIds: readonly string[]): Promise<Map<string, OrderLineInput[]>> {
    if (orderIds.length === 0) return new Map();

    const { data, error } = await client
      .from("shopify_order_lines")
      .select("order_id, external_id, variant_id, sku, quantity, gross_sales, discounts")
      .eq("organisation_id", organisationId)
      .in("order_id", orderIds);
    if (error) throw error;

    const byOrder = new Map<string, OrderLineInput[]>();
    for (const row of data ?? []) {
      const line: OrderLineInput = {
        externalId: row.external_id as string,
        variantId: (row.variant_id as string | null) ?? null,
        sku: (row.sku as string | null) ?? null,
        quantity: row.quantity as number,
        grossSales: row.gross_sales as string,
        discounts: row.discounts as string,
      };
      const bucket = byOrder.get(row.order_id as string);
      if (bucket) bucket.push(line);
      else byOrder.set(row.order_id as string, [line]);
    }
    return byOrder;
  }

  /** Customer id → business date of their first order, from stored history rather than the window. */
  async function loadFirstOrderDates(customerIds: readonly string[]): Promise<Map<string, string>> {
    if (customerIds.length === 0) return new Map();

    const { data, error } = await client
      .from("shopify_customers")
      .select("id, first_order_at")
      .eq("organisation_id", organisationId)
      .in("id", customerIds);
    if (error) throw error;

    const dates = new Map<string, string>();
    for (const row of data ?? []) {
      if (row.first_order_at) dates.set(row.id as string, businessDate(row.first_order_at as string));
    }
    return dates;
  }

  async function loadRefunds(range: DateRange) {
    const { fromIso, toIso } = utcWindow(range);

    const { data, error } = await client
      .from("shopify_refunds")
      .select("id, external_id, order_id, processed_at, total, tax, restocked")
      .eq("organisation_id", organisationId)
      .gte("processed_at", fromIso)
      .lt("processed_at", toIso);
    if (error) throw error;

    return (data ?? []).filter((row) => inRange(businessDate(row.processed_at as string), range));
  }

  async function loadRefundLines(refundIds: readonly string[]) {
    if (refundIds.length === 0) return new Map<string, { variantId: string | null; quantity: number; amount: string }[]>();

    const { data, error } = await client
      .from("shopify_refund_lines")
      .select("refund_id, variant_id, quantity, subtotal")
      .eq("organisation_id", organisationId)
      .in("refund_id", refundIds);
    if (error) throw error;

    const byRefund = new Map<string, { variantId: string | null; quantity: number; amount: string }[]>();
    for (const row of data ?? []) {
      const line = {
        variantId: (row.variant_id as string | null) ?? null,
        quantity: row.quantity as number,
        amount: row.subtotal as string,
      };
      const bucket = byRefund.get(row.refund_id as string);
      if (bucket) bucket.push(line);
      else byRefund.set(row.refund_id as string, [line]);
    }
    return byRefund;
  }

  async function loadAdSpend(range: DateRange): Promise<AdSpendInput[]> {
    // Account-level rows only. Campaign and ad rows repeat the same spend at a finer grain;
    // summing every level would multiply advertising spend by the depth of the hierarchy.
    const { data, error } = await client
      .from("ad_daily_metrics")
      .select("metric_date, spend, purchases, purchase_value, ad_accounts!inner(platform)")
      .eq("organisation_id", organisationId)
      .is("entity_id", null)
      .gte("metric_date", range.from)
      .lte("metric_date", range.to);
    if (error) throw error;

    return (data ?? []).map((row) => {
      const account = row.ad_accounts as unknown as { platform: "meta" | "tiktok" };
      return {
        platform: account.platform,
        businessDate: row.metric_date as string,
        spend: row.spend as string,
        attributedPurchases: (row.purchases as number | null) ?? undefined,
        attributedPurchaseValue: (row.purchase_value as string | null) ?? undefined,
      };
    });
  }

  /**
   * Xero spend against accounts an approved mapping rule assigns to a contribution bucket.
   *
   * Read at **line** grain, not at transaction grain. A single payment can be split across
   * several expense accounts — fulfilment and software on one card charge, say — and charging
   * the whole amount to whichever account happened to come first would put real money in the
   * wrong contribution bucket. The transaction header holds the total, which is what the cash
   * model needs; the lines hold the accounts, which is what this needs.
   *
   * Only outgoing transactions are treated as costs. A receipt against a mapped expense
   * account is a refund or correction, so it reduces the cost rather than adding to it.
   */
  async function loadMappedExpenses(range: DateRange): Promise<MappedExpenseInput[]> {
    const { data: rules, error: ruleError } = await client
      .from("expense_mapping_rules")
      .select("xero_account_id, financial_category, effective_from, effective_to")
      .eq("organisation_id", organisationId);
    if (ruleError) throw ruleError;
    if (!rules || rules.length === 0) return [];

    const { data: transactions, error: transactionError } = await client
      .from("xero_bank_transactions")
      .select(
        "id, xero_account_id, transaction_date, transaction_type, total, reference, xero_bank_transaction_lines(xero_account_id, line_amount, tax_amount, description)",
      )
      .eq("organisation_id", organisationId)
      .gte("transaction_date", range.from)
      .lte("transaction_date", range.to);
    if (transactionError) throw transactionError;

    /** The rule in force for an account on a date, or null when none applies. */
    const ruleFor = (accountId: string | null, date: string) => {
      if (accountId === null) return null;
      return (
        rules.find(
          (candidate) =>
            candidate.xero_account_id === accountId &&
            (candidate.effective_from as string) <= date &&
            (!candidate.effective_to || (candidate.effective_to as string) >= date),
        ) ?? null
      );
    };

    const expenses: MappedExpenseInput[] = [];

    for (const transaction of transactions ?? []) {
      const date = transaction.transaction_date as string;
      // A receipt reduces the cost rather than adding to it.
      const sign = transaction.transaction_type === "RECEIVE" ? -1 : 1;
      const reference = (transaction.reference as string | null) ?? null;

      const lines = (transaction.xero_bank_transaction_lines ?? []) as unknown as {
        xero_account_id: string | null;
        line_amount: string;
        tax_amount: string;
        description: string | null;
      }[];

      if (lines.length > 0) {
        for (const line of lines) {
          const rule = ruleFor(line.xero_account_id, date);
          if (!rule) continue;

          const bucket = EXPENSE_BUCKETS[rule.financial_category as string];
          if (!bucket) continue;

          // Tax is added back because the header total is tax inclusive, and the two figures
          // have to describe the same money or a split transaction stops summing to its total.
          const gross = money(line.line_amount).plus(money(line.tax_amount)).times(sign);

          expenses.push({
            businessDate: date,
            bucket,
            amount: gross,
            category: line.description ?? reference ?? (rule.financial_category as string),
          });
        }
        continue;
      }

      // No lines stored — a transaction imported before line capture, or one Xero returned
      // without them. The header account is the only basis available.
      const rule = ruleFor(transaction.xero_account_id as string | null, date);
      if (!rule) continue;

      const bucket = EXPENSE_BUCKETS[rule.financial_category as string];
      if (!bucket) continue;

      expenses.push({
        businessDate: date,
        bucket,
        amount: money(transaction.total as string).times(sign),
        category: reference ?? (rule.financial_category as string),
      });
    }

    return expenses;
  }

  return {
    loadPolicy,
    loadAllocationContext,

    /** Everything `buildDailyFinancials` needs for one date range. */
    async loadFacts(range: DateRange, policy: FinancialPolicy): Promise<ReportingFacts> {
      const allRefundRows = await loadRefunds(range);
      const originalOrderIds = [...new Set(allRefundRows.map((row) => row.order_id as string))];

      const [orderRows, context] = await Promise.all([
        loadOrders(range, originalOrderIds),
        loadAllocationContext(),
      ]);

      /**
       * A refund only counts when its original order does.
       *
       * `loadOrders` drops test and cancelled orders, so an order that survives it is
       * reportable. Cancelling an order and refunding it is routine, and the cancelled
       * order's revenue was never recognised — subtracting its refund anyway would take
       * money off net revenue that was never added, understating it.
       */
      const reportableOrderIds = new Set(orderRows.map((row) => row.id as string));
      const refundRows = allRefundRows.filter((row) => reportableOrderIds.has(row.order_id as string));

      const orderIds = orderRows.map((row) => row.id as string);
      const customerIds = [
        ...new Set(orderRows.map((row) => row.customer_id as string | null).filter((id): id is string => id !== null)),
      ];

      const [linesByOrder, firstOrderDates, refundLinesByRefund, adSpend, mappedExpenses] =
        await Promise.all([
          loadOrderLines(orderIds),
          loadFirstOrderDates(customerIds),
          loadRefundLines(refundRows.map((row) => row.id as string)),
          loadAdSpend(range),
          loadMappedExpenses(range),
        ]);

      const externalIdByRowId = new Map(orderRows.map((row) => [row.id as string, row.external_id as string]));

      const orders: OrderInput[] = orderRows.map((row) => ({
        externalId: row.external_id as string,
        customerId: (row.customer_id as string | null) ?? null,
        businessDate: businessDate(row.ordered_at as string),
        grossSales: row.gross_sales as string,
        discounts: row.discounts as string,
        shippingRevenue: row.shipping_revenue as string,
        lines: linesByOrder.get(row.id as string) ?? [],
        isNewCustomerOrder: false,
        // Test and cancelled orders were filtered in SQL, so everything loaded is reportable.
        isExcluded: false,
      }));

      const refunds: RefundInput[] = refundRows.map((row) => ({
        externalId: row.external_id as string,
        // Every surviving refund's order was loaded above, so this always resolves. The
        // previous fallback put a database UUID into the engine's warnings, which reads as
        // a missing order rather than as the bug it was.
        orderExternalId: externalIdByRowId.get(row.order_id as string) as string,
        processedBusinessDate: businessDate(row.processed_at as string),
        // Stored totals include VAT; the engine works VAT-exclusive throughout.
        amount: money(row.total as string).minus(row.tax as string),
        restocked: row.restocked as boolean,
        lines: (refundLinesByRefund.get(row.id as string) ?? []).map((line) => ({
          variantId: line.variantId,
          sku: null,
          quantity: line.quantity,
          amount: line.amount,
        })),
      }));

      return {
        range,
        // Acquisition is decided against every customer's stored first-order date, so an order
        // inside the window is only new if the customer has no earlier one anywhere.
        orders: assignNewCustomerFlags(orders, firstOrderDates),
        refunds,
        adSpend,
        mappedExpenses,
        context,
        policy,
      };
    },
  };
}
