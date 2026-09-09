/**
 * Shapes returned by the Xero Accounting API (v2.0) and the Xero identity service.
 *
 * Three behaviours drive the rest of this connector:
 *
 *  - **Refresh tokens rotate.** Every refresh invalidates the token that was used and issues a
 *    new one. Losing the new value disconnects the tenant permanently — reconnecting means a
 *    human re-consenting in a browser — so it is persisted before the access token is used.
 *  - **Dates are .NET serialised**, as `/Date(1476316800000+0000)/`, not as ISO strings.
 *  - **The tenant is a header, not part of the URL.** One authorisation can cover several
 *    organisations, so the tenant is resolved once from `/connections` and pinned.
 */

export const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";
export const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";
export const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
export const XERO_AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize";

/**
 * The read scopes this connector needs.
 *
 * `offline_access` is what makes a refresh token be issued at all; without it the connection
 * dies thirty minutes after it is made. Everything else is read-only: nothing here should ever
 * be able to write to QNCH's accounting records.
 */
export const XERO_SCOPES = [
  "offline_access",
  "accounting.settings.read",
  "accounting.transactions.read",
  "accounting.reports.read",
] as const;

export interface XeroTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export interface XeroConnection {
  id: string;
  tenantId: string;
  tenantType: string;
  tenantName?: string;
}

export interface XeroAccount {
  AccountID: string;
  Code?: string;
  Name: string;
  Type?: string;
  Status?: string;
  Class?: string;
  BankAccountType?: string;
  SystemAccount?: string;
  CurrencyCode?: string;
  Description?: string;
  UpdatedDateUTC?: string;
}

export interface XeroLineItem {
  LineItemID?: string;
  Description?: string;
  AccountCode?: string;
  AccountID?: string;
  LineAmount?: number;
  TaxAmount?: number;
}

export interface XeroBankTransaction {
  BankTransactionID: string;
  /** RECEIVE, SPEND and their overpayment, prepayment and transfer variants. */
  Type: string;
  Status?: string;
  Date?: string;
  Reference?: string;
  CurrencyCode?: string;
  IsReconciled?: boolean;
  SubTotal?: number;
  TotalTax?: number;
  Total?: number;
  Contact?: { Name?: string };
  BankAccount?: { AccountID?: string; Code?: string; Name?: string };
  LineItems?: XeroLineItem[];
  UpdatedDateUTC?: string;
}

export interface XeroInvoice {
  InvoiceID: string;
  /** ACCPAY is a bill QNCH owes; ACCREC is a sales invoice owed to QNCH. */
  Type: string;
  Status?: string;
  Date?: string;
  DueDate?: string;
  CurrencyCode?: string;
  SubTotal?: number;
  TotalTax?: number;
  Total?: number;
  AmountDue?: number;
  AmountPaid?: number;
  Contact?: { Name?: string };
  UpdatedDateUTC?: string;
}

export interface XeroPagination {
  page: number;
  pageSize: number;
  pageCount: number;
  itemCount: number;
}

export interface XeroListResponse {
  Accounts?: XeroAccount[];
  BankTransactions?: XeroBankTransaction[];
  Invoices?: XeroInvoice[];
  pagination?: XeroPagination;
}

/** One cell of a report row. The identifier, when there is one, is in `Attributes`. */
export interface XeroReportCell {
  Value?: string;
  Attributes?: { Value: string; Id: string }[];
}

export interface XeroReportRow {
  RowType: string;
  Title?: string;
  Cells?: XeroReportCell[];
  Rows?: XeroReportRow[];
}

export interface XeroReport {
  ReportID?: string;
  ReportName?: string;
  ReportType?: string;
  ReportDate?: string;
  Rows?: XeroReportRow[];
}

export interface XeroReportsResponse {
  Reports?: XeroReport[];
}
