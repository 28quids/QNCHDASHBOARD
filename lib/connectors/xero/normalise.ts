import { money, ZERO } from "@/lib/financial/money";
import { toBusinessDate } from "@/lib/financial/dates";
import type {
  XeroAccount,
  XeroBankTransaction,
  XeroInvoice,
  XeroReportsResponse,
} from "./types";

/**
 * Turns Xero payloads into the columns the database stores.
 *
 * The awkward part is dates. Xero serialises them the .NET way — `/Date(1476316800000+0000)/`
 * — rather than as ISO strings, and both forms appear in practice depending on the field and
 * the endpoint. Parsing one and not the other produces an `Invalid Date` that reaches the
 * database as null, so a transaction quietly loses the day it belongs to.
 */

const DOT_NET_DATE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

/**
 * Parses either serialisation to an ISO instant, or null when neither applies.
 *
 * The offset in the .NET form is deliberately ignored: the milliseconds are already a UTC
 * epoch, and the offset describes only the timezone it was displayed in. Applying it would
 * shift the instant by that offset.
 */
export function parseXeroInstant(value: string | undefined | null): string | null {
  if (!value) return null;

  const dotNet = DOT_NET_DATE.exec(value);
  if (dotNet) {
    const epoch = Number(dotNet[1]);
    return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * The business date a Xero timestamp falls on.
 *
 * Xero dates a transaction to a day in the organisation's own timezone but serialises it as
 * midnight UTC. Converting through the business timezone is what stops a payment made on the
 * 1st being reported on the 31st, which is how a month's costs land in the wrong month.
 */
export function parseXeroDate(value: string | undefined | null, businessTimezone: string): string | null {
  const instant = parseXeroInstant(value);
  return instant === null ? null : toBusinessDate(instant, businessTimezone);
}

const amount = (value: number | undefined): string => money(value ?? 0).toFixed(4);

export interface NormalisedXeroAccount {
  externalId: string;
  code: string | null;
  name: string;
  type: string | null;
  status: string | null;
  accountClass: string | null;
  bankAccountType: string | null;
  systemAccount: string | null;
  currencyCode: string | null;
  description: string | null;
  sourceUpdatedAt: string | null;
}

export function normaliseAccount(account: XeroAccount): NormalisedXeroAccount {
  return {
    externalId: account.AccountID,
    code: account.Code ?? null,
    name: account.Name,
    type: account.Type ?? null,
    status: account.Status ?? null,
    accountClass: account.Class ?? null,
    // Only accounts of type BANK carry this, and it is the flag the cash model filters on.
    bankAccountType: account.BankAccountType && account.BankAccountType !== "" ? account.BankAccountType : null,
    systemAccount: account.SystemAccount && account.SystemAccount !== "" ? account.SystemAccount : null,
    currencyCode: account.CurrencyCode ?? null,
    description: account.Description ?? null,
    sourceUpdatedAt: parseXeroInstant(account.UpdatedDateUTC),
  };
}

export interface NormalisedXeroLine {
  lineNumber: number;
  accountExternalId: string | null;
  accountCode: string | null;
  description: string | null;
  lineAmount: string;
  taxAmount: string;
}

export interface NormalisedXeroBankTransaction {
  externalId: string;
  /** Collapsed to SPEND or RECEIVE; the cash model signs on this and nothing else. */
  direction: "SPEND" | "RECEIVE";
  rawType: string;
  status: string | null;
  transactionDate: string | null;
  reference: string | null;
  contactName: string | null;
  currencyCode: string | null;
  subTotal: string;
  totalTax: string;
  total: string;
  isReconciled: boolean | null;
  bankAccountExternalId: string | null;
  /**
   * The expense account, when every line shares one. Null for a split transaction: filing it
   * under one of several accounts would charge the whole amount to that bucket, so the lines
   * carry the detail and the contribution walk reads those instead.
   */
  accountExternalId: string | null;
  lines: NormalisedXeroLine[];
  sourceUpdatedAt: string | null;
}

/**
 * `RECEIVE-TRANSFER` and `SPEND-TRANSFER` are movements between QNCH's own accounts. They are
 * still cash movements on each side, so they are kept and signed like anything else; treating
 * a transfer as income is what would be wrong, and the prefix is what prevents that.
 */
const directionOf = (type: string): "SPEND" | "RECEIVE" => (type.startsWith("SPEND") ? "SPEND" : "RECEIVE");

export function normaliseBankTransaction(
  transaction: XeroBankTransaction,
  businessTimezone: string,
): NormalisedXeroBankTransaction {
  const lines: NormalisedXeroLine[] = (transaction.LineItems ?? []).map((line, index) => ({
    // Position, because Xero does not guarantee a LineItemID on every line.
    lineNumber: index + 1,
    accountExternalId: line.AccountID ?? null,
    accountCode: line.AccountCode ?? null,
    description: line.Description ?? null,
    lineAmount: amount(line.LineAmount),
    taxAmount: amount(line.TaxAmount),
  }));

  const accountIds = new Set(
    lines.map((line) => line.accountExternalId).filter((id): id is string => id !== null),
  );

  return {
    externalId: transaction.BankTransactionID,
    direction: directionOf(transaction.Type),
    rawType: transaction.Type,
    status: transaction.Status ?? null,
    transactionDate: parseXeroDate(transaction.Date, businessTimezone),
    reference: transaction.Reference ?? null,
    contactName: transaction.Contact?.Name ?? null,
    currencyCode: transaction.CurrencyCode ?? null,
    subTotal: amount(transaction.SubTotal),
    totalTax: amount(transaction.TotalTax),
    total: amount(transaction.Total),
    isReconciled: transaction.IsReconciled ?? null,
    bankAccountExternalId: transaction.BankAccount?.AccountID ?? null,
    accountExternalId: accountIds.size === 1 ? [...accountIds][0] : null,
    lines,
    sourceUpdatedAt: parseXeroInstant(transaction.UpdatedDateUTC),
  };
}

export interface NormalisedXeroInvoice {
  externalId: string;
  invoiceType: "ACCPAY" | "ACCREC";
  contactName: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  status: string | null;
  currencyCode: string;
  subtotal: string;
  totalTax: string;
  total: string;
  amountDue: string;
  amountPaid: string;
  sourceUpdatedAt: string | null;
}

/**
 * Bills and sales invoices only.
 *
 * Credit notes, overpayments and prepayments share the endpoint but are different instruments,
 * and `xero_invoices.invoice_type` accepts only the two. They are dropped rather than coerced
 * into one, because a credit note stored as a bill would inflate what QNCH appears to owe.
 */
export function normaliseInvoice(
  invoice: XeroInvoice,
  businessTimezone: string,
): NormalisedXeroInvoice | null {
  if (invoice.Type !== "ACCPAY" && invoice.Type !== "ACCREC") return null;

  const invoiceDate = parseXeroDate(invoice.Date, businessTimezone);
  // `invoice_date` is not nullable, and an undated invoice cannot be placed on a cash timeline.
  if (invoiceDate === null) return null;

  return {
    externalId: invoice.InvoiceID,
    invoiceType: invoice.Type,
    contactName: invoice.Contact?.Name ?? null,
    invoiceDate,
    dueDate: parseXeroDate(invoice.DueDate, businessTimezone),
    status: invoice.Status ?? null,
    currencyCode: invoice.CurrencyCode ?? "GBP",
    subtotal: amount(invoice.SubTotal),
    totalTax: amount(invoice.TotalTax),
    total: amount(invoice.Total),
    amountDue: amount(invoice.AmountDue),
    amountPaid: amount(invoice.AmountPaid),
    sourceUpdatedAt: parseXeroInstant(invoice.UpdatedDateUTC),
  };
}

export interface NormalisedBankBalance {
  accountExternalId: string;
  closingBalance: string;
  cashReceived: string | null;
  cashSpent: string | null;
}

/**
 * Reads closing balances out of the Bank Summary report.
 *
 * Reports are returned as nested rows of cells rather than as records, and the account
 * identifier lives in a cell attribute rather than in a field. Only `RowType: "Row"` carries an
 * account — the header names the columns and `SummaryRow` is the total across accounts, which
 * would be read as an extra account if it were not excluded.
 *
 * Column order is Account, Opening Balance, Cash Received, Cash Spent, Closing Balance.
 */
export function normaliseBankSummary(response: XeroReportsResponse): NormalisedBankBalance[] {
  const balances: NormalisedBankBalance[] = [];

  const walk = (rows: readonly { RowType: string; Cells?: { Value?: string; Attributes?: { Value: string; Id: string }[] }[]; Rows?: unknown[] }[]): void => {
    for (const row of rows) {
      if (row.Rows) walk(row.Rows as typeof rows);
      if (row.RowType !== "Row" || !row.Cells || row.Cells.length < 5) continue;

      const accountId = row.Cells[0].Attributes?.find((attribute) => attribute.Id === "accountID")?.Value;
      if (!accountId) continue;

      const closing = money(row.Cells[4].Value ?? 0);
      if (!closing.isFinite()) continue;

      balances.push({
        accountExternalId: accountId,
        closingBalance: closing.toFixed(4),
        cashReceived: numeric(row.Cells[2].Value),
        cashSpent: numeric(row.Cells[3].Value),
      });
    }
  };

  for (const report of response.Reports ?? []) walk(report.Rows ?? []);
  return balances;
}

function numeric(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  const parsed = money(value);
  return parsed.isFinite() ? parsed.toFixed(4) : null;
}

/** Total of a set of transactions, for reporting what a sync actually imported. */
export function totalMovement(transactions: readonly NormalisedXeroBankTransaction[]): string {
  return transactions
    .reduce((total, transaction) => {
      const value = money(transaction.total);
      return transaction.direction === "SPEND" ? total.minus(value) : total.plus(value);
    }, ZERO)
    .toFixed(2);
}
