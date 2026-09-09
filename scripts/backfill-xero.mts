/**
 * Imports Xero accounting data.
 *
 * The chart of accounts syncs first and everything hangs off it: a bank transaction resolves
 * its bank account and its expense accounts against `xero_accounts`, so running transactions
 * into an empty chart writes rows that show up in cash and are invisible in the P&L.
 *
 *   npm run backfill:xero -- --dry-run           # read one page, write nothing
 *   npm run backfill:xero -- --since 2026-01-01  # everything modified since that date
 *   npm run backfill:xero                        # incremental, from the stored watermark
 *
 * `--since` filters on *modification* time, not transaction date. A payment entered last week
 * against a date in January is picked up by a January-onwards run because it was modified
 * recently, which is the behaviour that keeps a ledger converging.
 */

import { createClient } from "@supabase/supabase-js";
import { connect, loadEnvFile, printTable, requireEnv } from "./lib/db.mjs";
import { XeroClient } from "@/lib/connectors/xero/client";
import { createSupabaseXeroTokenStore } from "@/lib/connectors/xero/token-store";
import {
  normaliseAccount,
  normaliseBankSummary,
  normaliseBankTransaction,
  totalMovement,
} from "@/lib/connectors/xero/normalise";
import {
  buildXeroAccountsSyncJob,
  buildXeroBankTransactionsSyncJob,
  buildXeroInvoicesSyncJob,
} from "@/lib/connectors/xero/sync";
import { createXeroRepository } from "@/lib/repositories/xero-repository";
import { createSupabaseSyncStore } from "@/lib/connectors/supabase-sync-store";
import { runSync } from "@/lib/connectors/sync-runner";
import { toBusinessDate } from "@/lib/financial/dates";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const env = loadEnvFile();
const organisationId = requireEnv("ORGANISATION_ID", env);
const encryptionKey = requireEnv("TOKEN_ENCRYPTION_KEY", env);
const clientId = requireEnv("XERO_CLIENT_ID", env);
const clientSecret = requireEnv("XERO_CLIENT_SECRET", env);

const db = await connect();
let connectionId: string;
let tenantId: string;
let tenantName: string;
let businessTimezone: string;

try {
  const { rows } = await db.query(
    `select c.id as connection_id, c.external_account_id, c.display_name, c.status, o.business_timezone
     from public.integration_connections c
     join public.integration_tokens t on t.connection_id = c.id
     join public.organisations o on o.id = c.organisation_id
     where c.organisation_id = $1 and c.provider = 'xero'
     limit 1`,
    [organisationId],
  );

  if (rows.length === 0) {
    console.error("No Xero connection registered. Run: npm run xero:connect");
    process.exit(1);
  }
  if (rows[0].status === "needs_reauth") {
    console.error("The Xero connection needs reauthorising — its refresh token was rejected.");
    console.error("Run: npm run xero:connect");
    process.exit(1);
  }

  connectionId = rows[0].connection_id;
  tenantId = rows[0].external_account_id;
  tenantName = rows[0].display_name ?? tenantId;
  businessTimezone = rows[0].business_timezone;
} finally {
  await db.end();
}

const supabase = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL", env),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY", env),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const client = new XeroClient({
  clientId,
  clientSecret,
  tenantId,
  store: createSupabaseXeroTokenStore(supabase, { connectionId, encryptionKey }),
});

const today = toBusinessDate(new Date(), businessTimezone);
const since = flag("since");
const modifiedSince = since ? `${since}T00:00:00Z` : null;

console.log(`Xero ${tenantName} (${tenantId})`);
console.log(modifiedSince ? `Modified since ${modifiedSince}` : "Incremental, from the stored watermark");
console.log(dryRun ? "\nDry run: nothing will be written.\n" : "");

if (dryRun) {
  // Enough to prove the tokens, the tenant and the scopes without touching the database.
  const accountsResponse = await client.list("Accounts");
  const accounts = (accountsResponse.Accounts ?? []).map(normaliseAccount);
  const banks = accounts.filter((account) => account.bankAccountType !== null);

  console.log(`${accounts.length} account(s), of which ${banks.length} bank account(s).`);
  printTable(
    accounts.slice(0, 20).map((account) => ({
      code: account.code ?? "—",
      name: account.name,
      type: account.type ?? "—",
      class: account.accountClass ?? "—",
    })),
  );

  const page = await client.list("BankTransactions", { page: 1, pageSize: 10, where: 'Status=="AUTHORISED"' }, modifiedSince);
  const transactions = (page.BankTransactions ?? []).map((transaction) =>
    normaliseBankTransaction(transaction, businessTimezone),
  );

  if (transactions.length > 0) {
    console.log("");
    printTable(
      transactions.map((transaction) => ({
        date: transaction.transactionDate ?? "—",
        type: transaction.direction,
        total: transaction.total,
        lines: transaction.lines.length,
        reference: (transaction.reference ?? transaction.contactName ?? "").slice(0, 30),
      })),
    );
    console.log(`\nNet movement across this page: ${totalMovement(transactions)}`);
  } else {
    console.log("\nNo bank transactions in this window.");
  }

  const balances = normaliseBankSummary(await client.report("BankSummary", { fromDate: today, toDate: today }));
  console.log(`\nBank balances reported today: ${balances.length}`);
  for (const balance of balances) console.log(`  ${balance.accountExternalId}  ${balance.closingBalance}`);

  console.log("\nNothing written. Re-run without --dry-run to import.");
  process.exit(0);
}

const repository = createXeroRepository(supabase, { organisationId });
const store = createSupabaseSyncStore(supabase);
const discriminator = since ? `since_${since}` : today;
const runStartedAt = new Date().toISOString();
const shared = { client, repository, connectionId, jobDiscriminator: discriminator };

console.log("--- accounts ---");
const accounts = await runSync(buildXeroAccountsSyncJob(shared), store);
console.log(`status: ${accounts.status}`);
if (accounts.status === "succeeded") console.log(`  ${accounts.written} account(s)`);
if (accounts.status === "failed") console.error(`  ${accounts.error.message}`);

console.log("\n--- bank transactions ---");
let split = 0;
let unresolved = 0;
let lines = 0;

const transactions = await runSync(
  buildXeroBankTransactionsSyncJob({
    ...shared,
    businessTimezone,
    modifiedSince: modifiedSince ?? (await store.getCursor(connectionId, "bank_transactions")),
    runStartedAt,
    onPagePersisted: (result) => {
      split += result.split;
      unresolved += result.unresolvedAccounts;
      lines += result.lines;
      console.log(`  +${result.transactions} transactions`);
    },
  }),
  store,
);
console.log(`status: ${transactions.status}`);
if (transactions.status === "succeeded") {
  console.log(`  pages ${transactions.pages}, received ${transactions.received}, written ${transactions.written}`);
  console.log(`  ${lines} line(s)`);
  if (split > 0) {
    console.log(`  ${split} transaction(s) split across several expense accounts.`);
    console.log("  Their cost is charged per line, so each account gets its own share.");
  }
  if (unresolved > 0) {
    console.log(`  ${unresolved} line(s) reference an account not in the chart of accounts.`);
    console.log("  Re-run to pick them up once the account sync has caught up.");
  }
}
if (transactions.status === "failed") console.error(`  ${transactions.error.message}`);

console.log("\n--- invoices ---");
let skipped = 0;
const invoices = await runSync(
  buildXeroInvoicesSyncJob({
    ...shared,
    businessTimezone,
    modifiedSince: modifiedSince ?? (await store.getCursor(connectionId, "invoices")),
    runStartedAt,
    onPagePersisted: (result) => {
      skipped += result.skipped;
    },
  }),
  store,
);
console.log(`status: ${invoices.status}`);
if (invoices.status === "succeeded") {
  console.log(`  pages ${invoices.pages}, received ${invoices.received}, written ${invoices.written}`);
  if (skipped > 0) console.log(`  ${skipped} credit note(s) and prepayment(s) skipped — not bills or sales invoices`);
}
if (invoices.status === "failed") console.error(`  ${invoices.error.message}`);

console.log("\n--- bank balances ---");
try {
  const balances = normaliseBankSummary(await client.report("BankSummary", { fromDate: today, toDate: today }));
  const written = await repository.persistBankBalances(balances, today);
  console.log(`status: succeeded`);
  console.log(`  ${written} balance(s) recorded as at ${today}`);
  if (written < balances.length) {
    console.log(`  ${balances.length - written} skipped: account not in the chart of accounts yet`);
  }
} catch (error) {
  console.error(`status: failed\n  ${(error as Error).message}`);
}

console.log("\nNext: npm run map:xero, then npm run calculate");
