/**
 * Running the reconciliation checks against stored facts, and recording what they found.
 *
 * The checks themselves are pure and live in `lib/monitoring/reconciliation.ts`. This is the
 * part that goes to the database for each side of each comparison and writes the answer down,
 * which is what turns a set of tested functions into something the business actually sees.
 *
 * Nothing here nudges a figure towards agreement. A difference is recorded as a difference, and
 * a source that cannot be read at all is recorded as `not_applicable` rather than as zero —
 * "the two agree" and "one of them is missing" must never look the same.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, toBusinessDate, type DateRange } from "@/lib/financial/dates";
import { money } from "@/lib/financial/money";
import {
  reconcileAdvertisingSpend,
  reconcileBankBalance,
  reconcilePlatformSpend,
  reconcileShopifyPayouts,
  summariseReconciliation,
  type DatedAmount,
  type ReconciliationResult,
  type ReconciliationSummary,
} from "@/lib/monitoring/reconciliation";

/**
 * Differences treated as expected rather than as findings.
 *
 * Settlements lag orders by days and advertising is billed in arrears, so a period boundary
 * always cuts through both. These are proportions of the larger side rather than fixed amounts,
 * because a £50 gap on £500 is a problem and the same gap on £50,000 is a Tuesday.
 */
export const DEFAULT_TOLERANCE_RATE = 0.02;

export interface ReconciliationOptions {
  organisationId: string;
  businessTimezone: string;
  range: DateRange;
  /** Proportional tolerance. Defaults to `DEFAULT_TOLERANCE_RATE`. */
  toleranceRate?: number;
}

export async function runReconciliation(
  client: SupabaseClient,
  options: ReconciliationOptions,
): Promise<ReconciliationSummary> {
  const { organisationId, range } = options;
  const rate = options.toleranceRate ?? DEFAULT_TOLERANCE_RATE;

  const [orders, payouts, adSpend, accountingSpend, balance] = await Promise.all([
    loadChargedRevenue(client, organisationId, range, options.businessTimezone),
    loadPayouts(client, organisationId, range),
    loadPlatformSpend(client, organisationId, range),
    loadAccountingAdvertising(client, organisationId, range),
    loadBalances(client, organisationId, range),
  ]);

  const results: ReconciliationResult[] = [];

  /**
   * Money charged to customers against money settled by the processor.
   *
   * Gross of fees on both sides: the payout's charges less its refunds, not its net, because
   * the net has fees taken out and the order total has not. Comparing the two directly would
   * report the processor's fee as an unexplained difference every single period.
   *
   * Payouts only exist for Shopify Payments. A shop taking PayPal alongside it will show a real
   * gap, and that is the correct answer rather than something to tune away.
   */
  results.push(
    reconcileShopifyPayouts(orders, payouts, range, toleranceFor(orders, payouts, rate)),
  );

  // Per platform where the chart of accounts dedicates an account to one, and in total where it
  // does not. Both are reported when both are possible: a total that matches can still hide two
  // platforms wrong in opposite directions.
  for (const platform of ["meta", "tiktok"] as const) {
    const platformRows = adSpend.filter((row) => row.platform === platform);
    const accountingRows = accountingSpend.filter((row) => row.platform === platform);
    if (platformRows.length === 0 && accountingRows.length === 0) continue;

    results.push(
      reconcilePlatformSpend(
        platform,
        platformRows,
        accountingRows,
        range,
        toleranceFor(platformRows, accountingRows, rate),
      ),
    );
  }

  results.push(
    reconcileAdvertisingSpend(adSpend, accountingSpend, range, toleranceFor(adSpend, accountingSpend, rate)),
  );

  results.push(
    reconcileBankBalance(balance.modelled, balance.reported, range, toleranceFor([], [], rate)),
  );

  const summary = summariseReconciliation(results);
  await persistReconciliation(client, organisationId, results);
  return summary;
}

/** A tolerance proportional to the larger side, so it scales with the money involved. */
function toleranceFor(a: readonly DatedAmount[], b: readonly DatedAmount[], rate: number): string {
  const total = (rows: readonly DatedAmount[]) =>
    rows.reduce((sum, row) => sum.plus(money(row.amount).abs()), money(0));

  const largest = total(a).greaterThan(total(b)) ? total(a) : total(b);
  return largest.times(rate).toFixed(4);
}

/**
 * What customers were actually charged, by day.
 *
 * The full amount taken from the card — gross less discounts, plus shipping, plus VAT — and not
 * net revenue. Net revenue is VAT-exclusive and management-adjusted; a processor settles what
 * the customer actually paid. Comparing a management figure against a bank figure would report
 * the VAT as a discrepancy in every single period.
 *
 * Refunds are excluded from this side because the payout side nets them off separately, on the
 * day the refund settled rather than the day the order was placed.
 *
 * The business date is computed here rather than in SQL, as everywhere else: PostgREST cannot
 * express `at time zone`, so the window is padded by a day in UTC and then filtered exactly.
 */
async function loadChargedRevenue(
  client: SupabaseClient,
  organisationId: string,
  range: DateRange,
  businessTimezone: string,
): Promise<DatedAmount[]> {
  const { data, error } = await client
    .from("shopify_orders")
    .select("ordered_at, gross_sales, discounts, shipping_revenue, tax")
    .eq("organisation_id", organisationId)
    .eq("is_test", false)
    .is("cancelled_at", null)
    .gte("ordered_at", `${addDays(range.from, -1)}T00:00:00.000Z`)
    .lte("ordered_at", `${addDays(range.to, 2)}T00:00:00.000Z`);
  if (error) throw error;

  return (data ?? [])
    .map((row) => ({
      businessDate: toBusinessDate(row.ordered_at as string, businessTimezone),
      amount: money(row.gross_sales as string)
        .minus(money(row.discounts as string))
        .plus(money(row.shipping_revenue as string))
        .plus(money(row.tax as string)),
    }))
    .filter((row) => row.businessDate >= range.from && row.businessDate <= range.to);
}

/** Settlements, gross of fees, so both sides of the comparison describe the same money. */
async function loadPayouts(
  client: SupabaseClient,
  organisationId: string,
  range: DateRange,
): Promise<DatedAmount[]> {
  const { data, error } = await client
    .from("shopify_payouts")
    .select("payout_date, charges, refunds, net_amount, fees")
    .eq("organisation_id", organisationId)
    .gte("payout_date", range.from)
    .lte("payout_date", range.to);
  if (error) throw error;

  return (data ?? []).map((row) => {
    const charges = money((row.charges as string | null) ?? 0);
    const refunds = money((row.refunds as string | null) ?? 0);

    // A payout imported without its breakdown has zero charges. Its net plus its fees is the
    // same gross figure, so it is recovered rather than counted as nothing.
    const gross = charges.isZero()
      ? money((row.net_amount as string | null) ?? 0).plus(money((row.fees as string | null) ?? 0))
      : charges.minus(refunds);

    return { businessDate: row.payout_date as string, amount: gross };
  });
}

interface PlatformAmount extends DatedAmount {
  platform: "meta" | "tiktok" | null;
}

/** Advertising spend as the platforms report it, at account level only. */
async function loadPlatformSpend(
  client: SupabaseClient,
  organisationId: string,
  range: DateRange,
): Promise<PlatformAmount[]> {
  const { data, error } = await client
    .from("ad_daily_metrics")
    .select("metric_date, spend, ad_accounts!inner(platform)")
    .eq("organisation_id", organisationId)
    // Entity rows repeat the same spend at finer grain; summing every level would multiply it
    // by the depth of the hierarchy. The account-level row is the total.
    .is("entity_id", null)
    .gte("metric_date", range.from)
    .lte("metric_date", range.to);
  if (error) throw error;

  return (data ?? []).map((row) => ({
    businessDate: row.metric_date as string,
    amount: (row.spend as string | null) ?? "0",
    platform: (row.ad_accounts as unknown as { platform: "meta" | "tiktok" }).platform,
  }));
}

/**
 * Advertising spend as the ledger records it.
 *
 * Read at line grain, like the contribution walk, so a card charge split across advertising and
 * something else contributes only its advertising line. `ad_platform` is set only where the
 * chart of accounts dedicates an account to one platform; null means the spend can be
 * reconciled in total but not attributed.
 */
async function loadAccountingAdvertising(
  client: SupabaseClient,
  organisationId: string,
  range: DateRange,
): Promise<PlatformAmount[]> {
  const { data: rules, error: ruleError } = await client
    .from("expense_mapping_rules")
    .select("xero_account_id, financial_category, ad_platform, effective_from, effective_to")
    .eq("organisation_id", organisationId)
    .eq("financial_category", "acquisition");
  if (ruleError) throw ruleError;
  if (!rules || rules.length === 0) return [];

  const { data, error } = await client
    .from("xero_bank_transactions")
    .select(
      "transaction_date, transaction_type, xero_bank_transaction_lines(xero_account_id, line_amount, tax_amount)",
    )
    .eq("organisation_id", organisationId)
    .gte("transaction_date", range.from)
    .lte("transaction_date", range.to);
  if (error) throw error;

  const amounts: PlatformAmount[] = [];

  for (const transaction of data ?? []) {
    const date = transaction.transaction_date as string;
    // A receipt against an advertising account is a credit or rebate, so it reduces the spend.
    const sign = transaction.transaction_type === "RECEIVE" ? -1 : 1;

    const lines = (transaction.xero_bank_transaction_lines ?? []) as unknown as {
      xero_account_id: string | null;
      line_amount: string;
      tax_amount: string;
    }[];

    for (const line of lines) {
      const rule = rules.find(
        (candidate) =>
          candidate.xero_account_id === line.xero_account_id &&
          (candidate.effective_from as string) <= date &&
          (!candidate.effective_to || (candidate.effective_to as string) >= date),
      );
      if (!rule) continue;

      amounts.push({
        businessDate: date,
        amount: money(line.line_amount).plus(money(line.tax_amount)).times(sign),
        platform: (rule.ad_platform as "meta" | "tiktok" | null) ?? null,
      });
    }
  }

  return amounts;
}

/**
 * The balance QNCH's own movements imply, against the one Xero reports.
 *
 * The modelled balance is the earliest reported balance in the window carried forward by every
 * movement since. Starting from zero instead would produce a figure that is not a balance at
 * all and would disagree with Xero by the whole opening position, every time.
 */
async function loadBalances(
  client: SupabaseClient,
  organisationId: string,
  range: DateRange,
): Promise<{ modelled: string | null; reported: string | null }> {
  const [{ data: balances, error: balanceError }, { data: movements, error: movementError }] =
    await Promise.all([
      client
        .from("xero_bank_balances")
        .select("as_at, closing_balance")
        .eq("organisation_id", organisationId)
        .lte("as_at", range.to)
        .order("as_at", { ascending: true }),
      client
        .from("xero_bank_transactions")
        .select("transaction_date, transaction_type, total, bank_xero_account_id")
        .eq("organisation_id", organisationId)
        .gte("transaction_date", range.from)
        .lte("transaction_date", range.to),
    ]);
  if (balanceError) throw balanceError;
  if (movementError) throw movementError;

  const inWindow = (balances ?? []).filter((row) => (row.as_at as string) >= range.from);
  if (inWindow.length === 0) return { modelled: null, reported: null };

  const openingDate = inWindow[0].as_at as string;
  const opening = sumOn(inWindow, openingDate);

  const latestDate = inWindow[inWindow.length - 1].as_at as string;
  const reported = sumOn(inWindow, latestDate);

  // Movements strictly after the opening balance date. Including the opening day would count
  // that day's transactions twice, since the reported balance already contains them.
  const applied = (movements ?? [])
    .filter((row) => row.bank_xero_account_id !== null)
    .filter((row) => (row.transaction_date as string) > openingDate)
    .filter((row) => (row.transaction_date as string) <= latestDate)
    .reduce(
      (running, row) =>
        row.transaction_type === "SPEND"
          ? running.minus(money(row.total as string))
          : running.plus(money(row.total as string)),
      money(opening),
    );

  return { modelled: applied.toFixed(4), reported };
}

const sumOn = (rows: readonly Record<string, unknown>[], asAt: string): string =>
  rows
    .filter((row) => row.as_at === asAt)
    .reduce((total, row) => total.plus(money(row.closing_balance as string)), money(0))
    .toFixed(4);

/**
 * Records the findings.
 *
 * Upserted on the check and its period, so a nightly run restates yesterday's answer rather
 * than appending another row nobody can tell apart from it. The history that matters is across
 * periods, not across runs of the same period.
 */
export async function persistReconciliation(
  client: SupabaseClient,
  organisationId: string,
  results: readonly ReconciliationResult[],
): Promise<number> {
  if (results.length === 0) return 0;

  const { error } = await client.from("reconciliation_results").upsert(
    results.map((result) => ({
      organisation_id: organisationId,
      reconciliation_key: result.reconciliationKey,
      period_start: result.period.from,
      period_end: result.period.to,
      source_a_value: result.sourceAValue?.toFixed(4) ?? null,
      source_b_value: result.sourceBValue?.toFixed(4) ?? null,
      difference: result.difference?.toFixed(4) ?? null,
      tolerance: result.tolerance.toFixed(4),
      status: result.status,
      notes: result.message,
    })),
    { onConflict: "organisation_id,reconciliation_key,period_start,period_end" },
  );
  if (error) throw error;
  return results.length;
}
