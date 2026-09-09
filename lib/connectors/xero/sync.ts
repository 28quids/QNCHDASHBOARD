/**
 * Builds the runnable Xero syncs.
 *
 * The chart of accounts syncs first and the rest hang off it: a bank transaction resolves both
 * its bank account and its expense accounts against `xero_accounts`, so running transactions
 * into an empty chart writes rows that are visible in cash and invisible in the P&L.
 *
 * Collections page by page number and are bounded by `If-Modified-Since`, which is what keeps a
 * nightly run from re-reading the whole ledger. The watermark is the run's own start time
 * rather than the newest record seen: Xero's own clock decides what "modified since" means, and
 * a watermark taken from record timestamps drifts against it.
 */

import { buildJobKey, type SyncJob, type SyncPage } from "../sync-runner";
import type { XeroClient } from "./client";
import {
  normaliseAccount,
  normaliseBankTransaction,
  normaliseInvoice,
  type NormalisedXeroAccount,
  type NormalisedXeroBankTransaction,
  type NormalisedXeroInvoice,
} from "./normalise";
import type { createXeroRepository } from "@/lib/repositories/xero-repository";

/** Xero returns up to 100 records a page for transactions and invoices. */
const PAGE_SIZE = 100;

interface BaseOptions {
  client: XeroClient;
  repository: ReturnType<typeof createXeroRepository>;
  connectionId: string;
  jobDiscriminator: string;
}

/**
 * Syncs the chart of accounts.
 *
 * Read in full every time rather than incrementally. It is one small page, and an account
 * renamed or archived since the last run has to be reflected before a mapping rule is applied
 * against it.
 */
export function buildXeroAccountsSyncJob(options: BaseOptions): SyncJob<NormalisedXeroAccount> {
  return {
    provider: "xero",
    resourceName: "accounts",
    connectionId: options.connectionId,
    jobKey: buildJobKey("xero", "accounts", options.jobDiscriminator),

    async fetchPage(): Promise<SyncPage<NormalisedXeroAccount>> {
      const response = await options.client.list("Accounts");
      return {
        records: (response.Accounts ?? []).map(normaliseAccount),
        // Accounts are not paged.
        nextCursor: null,
      };
    },

    upsert: (records) => options.repository.persistAccounts(records),
  };
}

export interface XeroBankTransactionsSyncOptions extends BaseOptions {
  businessTimezone: string;
  /**
   * Lower bound on modification time. Null reads the whole ledger, which is what a first
   * backfill wants; an incremental run passes the previous watermark.
   */
  modifiedSince: string | null;
  /** The instant this run started, recorded as the next watermark. */
  runStartedAt: string;
  onPagePersisted?: (result: { transactions: number; lines: number; split: number; unresolvedAccounts: number }) => void;
}

export function buildXeroBankTransactionsSyncJob(
  options: XeroBankTransactionsSyncOptions,
): SyncJob<NormalisedXeroBankTransaction> {
  return {
    provider: "xero",
    resourceName: "bank_transactions",
    connectionId: options.connectionId,
    jobKey: buildJobKey("xero", "bank_transactions", options.jobDiscriminator),

    async fetchPage(cursor: string | null): Promise<SyncPage<NormalisedXeroBankTransaction>> {
      const page = pageNumber(cursor);

      const response = await options.client.list(
        "BankTransactions",
        {
          page,
          pageSize: PAGE_SIZE,
          // VOIDED and DELETED transactions never moved money, and including them would put
          // reversed costs into the P&L and phantom movements into the cash model.
          where: 'Status=="AUTHORISED"',
        },
        options.modifiedSince,
      );

      const records = (response.BankTransactions ?? []).map((transaction) =>
        normaliseBankTransaction(transaction, options.businessTimezone),
      );

      return {
        records,
        nextCursor: nextPage(page, response.pagination?.pageCount, records.length),
        watermarkAt: options.runStartedAt,
      };
    },

    async upsert(records): Promise<number> {
      const result = await options.repository.persistBankTransactions(records);
      options.onPagePersisted?.(result);
      return result.transactions;
    },
  };
}

export interface XeroInvoicesSyncOptions extends BaseOptions {
  businessTimezone: string;
  modifiedSince: string | null;
  runStartedAt: string;
  onPagePersisted?: (result: { invoices: number; skipped: number }) => void;
}

/**
 * Syncs bills and sales invoices, which are what the cash commitment model reads.
 *
 * These are obligations, not cash and not cost: a bill QNCH owes is neither an expense in the
 * contribution walk nor money that has left the bank. Keeping them in their own table is what
 * stops the three being conflated.
 */
export function buildXeroInvoicesSyncJob(options: XeroInvoicesSyncOptions): SyncJob<NormalisedXeroInvoice> {
  return {
    provider: "xero",
    resourceName: "invoices",
    connectionId: options.connectionId,
    jobKey: buildJobKey("xero", "invoices", options.jobDiscriminator),

    async fetchPage(cursor: string | null): Promise<SyncPage<NormalisedXeroInvoice>> {
      const page = pageNumber(cursor);

      const response = await options.client.list(
        "Invoices",
        { page, pageSize: PAGE_SIZE },
        options.modifiedSince,
      );

      const returned = response.Invoices ?? [];
      const records = returned
        .map((invoice) => normaliseInvoice(invoice, options.businessTimezone))
        .filter((invoice): invoice is NormalisedXeroInvoice => invoice !== null);

      options.onPagePersisted?.({ invoices: records.length, skipped: returned.length - records.length });

      return {
        records,
        // Paged on what Xero returned, not on what survived normalisation: a page entirely of
        // credit notes is a full page, and stopping there would truncate the sync.
        nextCursor: nextPage(page, response.pagination?.pageCount, returned.length),
        watermarkAt: options.runStartedAt,
      };
    },

    upsert: (records) => options.repository.persistInvoices(records),
  };
}

/** A stored cursor is a page number. Validated rather than trusted, so a bad value restarts. */
function pageNumber(cursor: string | null): number {
  const parsed = cursor === null ? 1 : Number(cursor);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

/**
 * The next page, or null at the end.
 *
 * `pagination.pageCount` is authoritative where Xero sends it. It is absent on some responses,
 * so a short page is the fallback signal — and an empty page always ends the sync, which is
 * what stops a missing page count paging forever.
 */
function nextPage(page: number, pageCount: number | undefined, received: number): string | null {
  if (received === 0) return null;
  if (pageCount !== undefined) return page < pageCount ? String(page + 1) : null;
  return received < PAGE_SIZE ? null : String(page + 1);
}
