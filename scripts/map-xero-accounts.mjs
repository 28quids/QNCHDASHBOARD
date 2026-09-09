/**
 * Assigns Xero accounts to contribution buckets.
 *
 * Until an account is mapped, spend against it is imported and then ignored: it moves cash and
 * appears nowhere in the P&L. That is the intended default — silently guessing which bucket a
 * cost belongs in is exactly what would make CM2 and CM3 untrustworthy — but it means this
 * step is not optional, and the data-quality page reports every unmapped account with activity.
 *
 *   npm run map:xero -- --list                       # accounts, mappings and activity
 *   npm run map:xero -- --suggest                    # proposals, applied by nobody but you
 *   npm run map:xero -- --set 400 acquisition        # by account code
 *   npm run map:xero -- --set <uuid> fixed_operating # by Xero account id
 *   npm run map:xero -- --unset 400
 *
 * Categories: acquisition (CM2), variable_operating (CM3), fixed_operating, cash_commitment,
 * excluded. `excluded` is a decision, not an absence: it records that an account was looked at
 * and deliberately left out, which is what stops it being re-proposed every month.
 */

import { connect, loadEnvFile, printTable, requireEnv } from "./lib/db.mjs";

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const flagAt = (name, offset) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + offset];
};

const CATEGORIES = ["acquisition", "variable_operating", "fixed_operating", "cash_commitment", "excluded"];

/**
 * Advisory proposals from the account's own name and type.
 *
 * Deliberately never applied automatically. A wrong guess here does not look wrong — it
 * produces a plausible CM2 that is quietly incorrect — so a human confirms every one.
 */
const SUGGESTIONS = [
  [/facebook|meta|tiktok|google ads|advertis|marketing/i, "acquisition"],
  [/shipping|postage|courier|freight|fulfil|pick|pack|royal mail|dpd|evri/i, "variable_operating"],
  [/shopify|klaviyo|app subscription|transaction fee|stripe|paypal fee/i, "variable_operating"],
  [/salar|wages|payroll|pension|rent|insurance|accountan|software|subscription/i, "fixed_operating"],
  [/vat|tax|corporation tax|paye/i, "cash_commitment"],
  [/transfer|drawings|director loan|owner/i, "excluded"],
];

const suggest = (name, type) => {
  if (type === "BANK") return "excluded";
  const match = SUGGESTIONS.find(([pattern]) => pattern.test(name));
  return match ? match[1] : null;
};

const env = loadEnvFile();
const organisationId = requireEnv("ORGANISATION_ID", env);
const db = await connect();

try {
  const { rows: accounts } = await db.query(
    `select a.id, a.external_id, a.code, a.name, a.type, a.account_class, a.bank_account_type, a.status,
            r.financial_category, r.effective_from,
            coalesce(activity.transactions, 0)::int as transactions,
            coalesce(activity.total, 0) as total
     from public.xero_accounts a
     left join lateral (
       select r.financial_category, r.effective_from
       from public.expense_mapping_rules r
       where r.organisation_id = a.organisation_id and r.xero_account_id = a.id
         and r.effective_to is null
       order by r.effective_from desc
       limit 1
     ) r on true
     left join lateral (
       select count(*) as transactions, sum(l.line_amount + l.tax_amount) as total
       from public.xero_bank_transaction_lines l
       where l.organisation_id = a.organisation_id and l.xero_account_id = a.id
     ) activity on true
     where a.organisation_id = $1
     order by activity.total desc nulls last, a.code`,
    [organisationId],
  );

  if (accounts.length === 0) {
    console.error("No Xero accounts imported. Run: npm run backfill:xero");
    process.exit(1);
  }

  const byKey = new Map();
  for (const account of accounts) {
    byKey.set(account.external_id, account);
    if (account.code) byKey.set(account.code, account);
  }

  if (has("list") || argv.length === 0) {
    printTable(
      accounts.map((account) => ({
        code: account.code ?? "—",
        name: account.name.slice(0, 40),
        type: account.type ?? "—",
        mapped: account.financial_category ?? "—",
        lines: account.transactions,
        total: account.total ?? "0",
      })),
    );

    const unmapped = accounts.filter((account) => !account.financial_category && account.transactions > 0);
    if (unmapped.length > 0) {
      console.log(`\n${unmapped.length} account(s) with activity are unmapped.`);
      console.log("Their spend moves cash and appears nowhere in the P&L until they are mapped.");
      console.log("Run with --suggest to see proposals.");
    }
    process.exit(0);
  }

  if (has("suggest")) {
    const rows = accounts
      .filter((account) => !account.financial_category && account.transactions > 0)
      .map((account) => ({
        code: account.code ?? account.external_id.slice(0, 8),
        name: account.name.slice(0, 40),
        total: account.total ?? "0",
        proposal: suggest(account.name, account.type) ?? "(no proposal)",
      }));

    if (rows.length === 0) {
      console.log("Every account with activity is already mapped.");
      process.exit(0);
    }

    printTable(rows);
    console.log("\nProposals only — nothing has been written. Apply the ones you agree with:");
    for (const row of rows.filter((row) => row.proposal !== "(no proposal)")) {
      console.log(`  npm run map:xero -- --set ${row.code} ${row.proposal}`);
    }
    console.log("\nA wrong mapping does not look wrong. It produces a plausible CM2 that is");
    console.log("quietly incorrect, which is why none of these is applied for you.");
    process.exit(0);
  }

  if (has("unset")) {
    const key = flagAt("unset", 1);
    const account = byKey.get(key);
    if (!account) throw new Error(`No Xero account matches ${key}`);

    // End-dated rather than deleted, so a past period keeps the mapping it was calculated on
    // and a restatement does not silently change history.
    const { rowCount } = await db.query(
      `update public.expense_mapping_rules
       set effective_to = current_date
       where organisation_id = $1 and xero_account_id = $2 and effective_to is null`,
      [organisationId, account.id],
    );
    console.log(
      rowCount > 0
        ? `Ended ${rowCount} mapping(s) for ${account.name} as of today. Past periods keep theirs.`
        : `${account.name} had no active mapping.`,
    );
    process.exit(0);
  }

  if (has("set")) {
    const key = flagAt("set", 1);
    const category = flagAt("set", 2);
    const from = flagAt("from", 1) ?? "1900-01-01";

    const account = byKey.get(key);
    if (!account) throw new Error(`No Xero account matches ${key}`);
    if (!CATEGORIES.includes(category)) {
      throw new Error(`Unknown category ${category}. One of: ${CATEGORIES.join(", ")}`);
    }

    await db.query("begin");
    await db.query(
      `update public.expense_mapping_rules
       set effective_to = $3::date - 1
       where organisation_id = $1 and xero_account_id = $2 and effective_to is null and effective_from < $3::date`,
      [organisationId, account.id, from],
    );
    await db.query(
      `insert into public.expense_mapping_rules (organisation_id, xero_account_id, financial_category, effective_from)
       values ($1, $2, $3, $4)
       on conflict (organisation_id, xero_account_id, effective_from)
       do update set financial_category = excluded.financial_category, effective_to = null`,
      [organisationId, account.id, category, from],
    );
    await db.query("commit");

    console.log(`${account.name} → ${category}, effective ${from}.`);
    console.log("Run npm run calculate to restate the affected periods.");
    process.exit(0);
  }

  console.error("Nothing to do. Try --list, --suggest, --set or --unset.");
  process.exitCode = 1;
} catch (error) {
  await db.query("rollback").catch(() => {});
  console.error(`Failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
