-- Structures the Xero connector needs that the foundation migration did not yet provide.
--
-- Three gaps, each of which would otherwise be filled by guessing:
--
--  1. **A bank transaction can span several expense accounts.** `xero_bank_transactions`
--     carries one `xero_account_id`, so a split transaction either had to be mis-filed under
--     one of its accounts or left unattributed and silently missing from the P&L. Its lines
--     are stored instead, and the contribution walk reads those.
--
--  2. **A running total of imported movements is not a bank balance.** It is only the net of
--     whatever happened to be imported, and reads as a balance. Xero's own Bank Summary report
--     states the closing balance per account, which is what makes the cash page and the
--     bank-balance reconciliation mean anything.
--
--  3. **Nothing recorded which accounts are bank accounts**, or what class an account is, so
--     a cash movement could not be distinguished from an accrual and no mapping could be
--     suggested from the chart of accounts.
--
-- Wrapped in a transaction: none of the statements below are individually idempotent, so a
-- failure part-way would otherwise leave the schema half-built with no clean way to re-run.

begin;

-- Chart of accounts ----------------------------------------------------------------------------

alter table public.xero_accounts
  add column account_class text,
  add column bank_account_type text,
  add column system_account text,
  add column currency_code char(3),
  add column description text,
  add column source_updated_at timestamptz;

comment on column public.xero_accounts.account_class is
  'ASSET, EQUITY, EXPENSE, LIABILITY or REVENUE. Reported by Xero; used to sanity-check a mapping.';
comment on column public.xero_accounts.bank_account_type is
  'BANK, CREDITCARD or PAYPAL for accounts of type BANK. Null for everything else.';

-- Bank transactions ----------------------------------------------------------------------------

alter table public.xero_bank_transactions
  add column contact_name text,
  add column currency_code char(3),
  add column sub_total numeric(19, 4),
  add column total_tax numeric(19, 4),
  add column is_reconciled boolean,
  -- The bank account the money moved through, which is not the expense account the cost
  -- belongs to. Keeping both is what lets cash and contribution read the same row without
  -- one of them being wrong.
  add column bank_xero_account_id uuid references public.xero_accounts(id) on delete set null;

comment on column public.xero_bank_transactions.xero_account_id is
  'The expense account, when every line shares one. Null for a split transaction — its lines carry the detail.';
comment on column public.xero_bank_transactions.bank_xero_account_id is
  'The bank account the money moved through. This is what the cash model reads, never the expense account.';

create index xero_bank_transactions_org_bank_idx
  on public.xero_bank_transactions (organisation_id, bank_xero_account_id, transaction_date);

/**
 * One row per line of a bank transaction.
 *
 * The contribution walk reads these rather than the transaction header, so a payment split
 * across fulfilment and software is charged to both buckets instead of to whichever account
 * happened to be first. The header keeps the total, because that is the figure the cash model
 * needs and summing lines would drift from it by rounding.
 */
create table public.xero_bank_transaction_lines (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  bank_transaction_id uuid not null references public.xero_bank_transactions(id) on delete cascade,
  -- Xero does not guarantee a LineItemID on every line, so position within the transaction is
  -- the only stable identity. It is stable because a re-read returns the lines in order.
  line_number smallint not null,
  xero_account_id uuid references public.xero_accounts(id) on delete set null,
  account_code text,
  description text,
  line_amount numeric(19, 4) not null default 0,
  tax_amount numeric(19, 4) not null default 0,
  ingested_at timestamptz not null default now(),
  unique (bank_transaction_id, line_number)
);
create index xero_bank_transaction_lines_account_idx
  on public.xero_bank_transaction_lines (organisation_id, xero_account_id);

-- Bank balances --------------------------------------------------------------------------------

/**
 * Closing balance per bank account, as Xero reports it.
 *
 * Kept as dated observations rather than as one current figure, so a balance can be compared
 * with the day it applied to and a reconciliation can be re-run over a past period.
 */
create table public.xero_bank_balances (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  xero_account_id uuid not null references public.xero_accounts(id) on delete cascade,
  as_at date not null,
  closing_balance numeric(19, 4) not null,
  cash_received numeric(19, 4),
  cash_spent numeric(19, 4),
  ingested_at timestamptz not null default now(),
  unique (organisation_id, xero_account_id, as_at)
);

-- Access control -------------------------------------------------------------------------------
-- Same model as the earlier migrations: members read tenant facts, finance administrators
-- manage the human-maintained settings, and connector workers use the service role.

alter table public.xero_bank_transaction_lines enable row level security;
alter table public.xero_bank_balances enable row level security;

do $$
declare
  target_table text;
begin
  foreach target_table in array array['xero_bank_transaction_lines', 'xero_bank_balances'] loop
    execute format(
      'create policy member_read on public.%I for select to authenticated using (public.is_organisation_member(organisation_id))',
      target_table
    );
  end loop;
end;
$$;

commit;
