-- What reconciliation needs that the schema did not yet carry.
--
-- Two additions, both small, both required by checks that would otherwise have to guess.
--
--  1. **Which advertising platform a mapped Xero account belongs to.** Reconciling Meta's
--     reported spend against the money that actually left the bank needs to know which bank
--     transactions are Meta's. `expense_mapping_rules` says an account is acquisition spend but
--     not whose, and inferring it from an account's name would be a guess dressed as a fact —
--     the same guess this system refuses to make about cost buckets. Left null, the check falls
--     back to reconciling total advertising spend, which is still worth knowing.
--
--  2. **A stable identity for a reconciliation result.** The table had no unique key, so every
--     nightly run inserted another row for the same check over the same period and the history
--     grew without a way to ask what the current answer is.

begin;

alter table public.expense_mapping_rules
  add column ad_platform text check (ad_platform in ('meta', 'tiktok'));

comment on column public.expense_mapping_rules.ad_platform is
  'Set only on acquisition accounts dedicated to one platform. Null means the account is not attributed to a platform, and only total advertising spend can be reconciled.';

-- One current answer per check per period. Re-running a reconciliation restates it rather than
-- appending, so the data-quality page shows today's finding instead of the first one ever made.
create unique index reconciliation_results_natural_key
  on public.reconciliation_results (organisation_id, reconciliation_key, period_start, period_end);

-- The same for data-quality results. `checked_at` was in the unique key, which made every run
-- distinct by construction — so the table recorded a growing log that nothing could query for
-- current state.
-- Dropped by looking the constraint up rather than by its generated name, which depends on
-- Postgres's truncation rules and would fail the whole migration if it differed by a character.
do $$
declare
  constraint_name text;
begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'public.data_quality_results'::regclass
    and contype = 'u'
    and array_length(conkey, 1) = 3;

  if constraint_name is not null then
    execute format('alter table public.data_quality_results drop constraint %I', constraint_name);
  end if;
end;
$$;

create unique index data_quality_results_natural_key
  on public.data_quality_results (organisation_id, check_key);

comment on table public.data_quality_results is
  'The latest result per check. Restated on each run rather than appended, so a stale row cannot be mistaken for a current pass.';

commit;
