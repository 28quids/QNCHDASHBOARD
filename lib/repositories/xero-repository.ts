/**
 * Persists Xero accounting data.
 *
 * Two constraints shape this, and both come from what reads the rows afterwards.
 *
 * **Accounts must land before anything referencing them.** A bank transaction resolves its
 * bank account and its expense account against `xero_accounts`, so writing transactions into an
 * empty chart of accounts leaves every row unattributed — visible in cash, invisible in the
 * P&L. The account sync runs first for that reason.
 *
 * **A transaction and its lines are different grains.** The header carries the total, which is
 * what the cash model needs and what summing lines would drift from by rounding. The lines
 * carry the expense accounts, which is what the contribution walk needs. Both are stored.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  NormalisedBankBalance,
  NormalisedXeroAccount,
  NormalisedXeroBankTransaction,
  NormalisedXeroInvoice,
} from "@/lib/connectors/xero/normalise";

export interface XeroRepositoryContext {
  organisationId: string;
}

export interface PersistTransactionsResult {
  transactions: number;
  lines: number;
  /**
   * Transactions whose lines span more than one expense account.
   *
   * Their header carries no single account, so no mapping rule matches it. The cost is not
   * lost — the lines hold it — but it is worth reporting, because a split transaction whose
   * lines are themselves unmapped is invisible in the P&L while still moving cash.
   */
  split: number;
  /** Lines whose account is not in `xero_accounts`, so no mapping rule can ever match them. */
  unresolvedAccounts: number;
}

export function createXeroRepository(client: SupabaseClient, context: XeroRepositoryContext) {
  const { organisationId } = context;

  return {
    async persistAccounts(accounts: readonly NormalisedXeroAccount[]): Promise<number> {
      if (accounts.length === 0) return 0;

      const { error } = await client.from("xero_accounts").upsert(
        accounts.map((account) => ({
          organisation_id: organisationId,
          external_id: account.externalId,
          code: account.code,
          name: account.name,
          type: account.type,
          status: account.status,
          account_class: account.accountClass,
          bank_account_type: account.bankAccountType,
          system_account: account.systemAccount,
          currency_code: account.currencyCode,
          description: account.description,
          source_updated_at: account.sourceUpdatedAt,
        })),
        { onConflict: "organisation_id,external_id" },
      );
      if (error) throw error;
      return accounts.length;
    },

    async persistBankTransactions(
      transactions: readonly NormalisedXeroBankTransaction[],
    ): Promise<PersistTransactionsResult> {
      if (transactions.length === 0) {
        return { transactions: 0, lines: 0, split: 0, unresolvedAccounts: 0 };
      }

      // A transaction with no date cannot be placed on the cash timeline and the column is not
      // nullable, so it is dropped rather than dated arbitrarily.
      const dated = transactions.filter((transaction) => transaction.transactionDate !== null);
      if (dated.length === 0) return { transactions: 0, lines: 0, split: 0, unresolvedAccounts: 0 };

      const accountIds = await resolveAccounts(dated);

      const rows = dated.map((transaction) => ({
        organisation_id: organisationId,
        external_id: transaction.externalId,
        xero_account_id: transaction.accountExternalId
          ? (accountIds.get(transaction.accountExternalId) ?? null)
          : null,
        bank_xero_account_id: transaction.bankAccountExternalId
          ? (accountIds.get(transaction.bankAccountExternalId) ?? null)
          : null,
        transaction_date: transaction.transactionDate,
        // The collapsed direction, not the raw type: the cash model signs on SPEND alone, so a
        // SPEND-TRANSFER stored verbatim would be counted as money coming in.
        transaction_type: transaction.direction,
        status: transaction.status,
        reference: transaction.reference,
        contact_name: transaction.contactName,
        currency_code: transaction.currencyCode,
        sub_total: transaction.subTotal,
        total_tax: transaction.totalTax,
        total: transaction.total,
        is_reconciled: transaction.isReconciled,
        source_updated_at: transaction.sourceUpdatedAt,
      }));

      const { data, error } = await client
        .from("xero_bank_transactions")
        .upsert(rows, { onConflict: "organisation_id,external_id" })
        .select("id, external_id");
      if (error) throw error;

      const transactionIds = new Map((data ?? []).map((row) => [row.external_id as string, row.id as string]));

      let unresolvedAccounts = 0;
      const lineRows = dated.flatMap((transaction) => {
        const transactionId = transactionIds.get(transaction.externalId);
        if (!transactionId) return [];

        return transaction.lines.map((line) => {
          const resolved = line.accountExternalId ? (accountIds.get(line.accountExternalId) ?? null) : null;
          if (line.accountExternalId && resolved === null) unresolvedAccounts += 1;

          return {
            organisation_id: organisationId,
            bank_transaction_id: transactionId,
            line_number: line.lineNumber,
            xero_account_id: resolved,
            account_code: line.accountCode,
            description: line.description,
            line_amount: line.lineAmount,
            tax_amount: line.taxAmount,
          };
        });
      });

      if (lineRows.length > 0) {
        const { error: lineError } = await client
          .from("xero_bank_transaction_lines")
          .upsert(lineRows, { onConflict: "bank_transaction_id,line_number" });
        if (lineError) throw lineError;
      }

      return {
        transactions: rows.length,
        lines: lineRows.length,
        split: dated.filter((transaction) => transaction.accountExternalId === null && transaction.lines.length > 1)
          .length,
        unresolvedAccounts,
      };
    },

    async persistInvoices(invoices: readonly NormalisedXeroInvoice[]): Promise<number> {
      if (invoices.length === 0) return 0;

      const { error } = await client.from("xero_invoices").upsert(
        invoices.map((invoice) => ({
          organisation_id: organisationId,
          external_id: invoice.externalId,
          invoice_type: invoice.invoiceType,
          contact_name: invoice.contactName,
          invoice_date: invoice.invoiceDate,
          due_date: invoice.dueDate,
          status: invoice.status,
          currency: invoice.currencyCode,
          subtotal: invoice.subtotal,
          total_tax: invoice.totalTax,
          total: invoice.total,
          amount_due: invoice.amountDue,
          amount_paid: invoice.amountPaid,
          source_updated_at: invoice.sourceUpdatedAt,
        })),
        { onConflict: "organisation_id,external_id" },
      );
      if (error) throw error;
      return invoices.length;
    },

    /**
     * Records the balance Xero reports for each bank account on a given date.
     *
     * Dated rather than overwritten, so a past reconciliation can be re-run against the balance
     * that applied at the time instead of against today's.
     */
    async persistBankBalances(balances: readonly NormalisedBankBalance[], asAt: string): Promise<number> {
      if (balances.length === 0) return 0;

      const accountIds = await accountIdsFor(balances.map((balance) => balance.accountExternalId));

      const rows = balances.flatMap((balance) => {
        const accountId = accountIds.get(balance.accountExternalId);
        // An account the chart of accounts has not caught up with yet. Skipped rather than
        // written against a null account, which the not-null constraint would reject anyway.
        if (!accountId) return [];

        return [{
          organisation_id: organisationId,
          xero_account_id: accountId,
          as_at: asAt,
          closing_balance: balance.closingBalance,
          cash_received: balance.cashReceived,
          cash_spent: balance.cashSpent,
        }];
      });

      if (rows.length === 0) return 0;

      const { error } = await client
        .from("xero_bank_balances")
        .upsert(rows, { onConflict: "organisation_id,xero_account_id,as_at" });
      if (error) throw error;
      return rows.length;
    },
  };

  async function resolveAccounts(
    transactions: readonly NormalisedXeroBankTransaction[],
  ): Promise<Map<string, string>> {
    return accountIdsFor(
      transactions.flatMap((transaction) => [
        transaction.accountExternalId,
        transaction.bankAccountExternalId,
        ...transaction.lines.map((line) => line.accountExternalId),
      ]),
    );
  }

  async function accountIdsFor(externalIds: readonly (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(externalIds.filter((id): id is string => id !== null))];
    if (unique.length === 0) return new Map();

    const { data, error } = await client
      .from("xero_accounts")
      .select("id, external_id")
      .eq("organisation_id", organisationId)
      .in("external_id", unique);
    if (error) throw error;

    return new Map((data ?? []).map((row) => [row.external_id as string, row.id as string]));
  }
}
