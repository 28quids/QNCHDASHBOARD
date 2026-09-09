-- Saved custom reports.
--
-- A report is a *question*, not a copy of an answer: which metrics, over what window, at what
-- grain. The figures are recomputed from the engine every time it is opened, so a saved report
-- reflects the costs approved now rather than a snapshot taken when it was created. Storing the
-- numbers instead would produce a report that silently disagrees with the dashboard the moment
-- a cost is corrected.
--
-- `metric_keys` is validated against the application's metric catalogue rather than by a check
-- constraint, because the catalogue is where the metrics are defined and a duplicated list in
-- SQL would drift from it. A key that no longer exists is reported when the report is opened.

begin;

create table public.saved_reports (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  name text not null,
  description text,
  metric_keys text[] not null check (cardinality(metric_keys) between 1 and 20),
  grain text not null check (grain in ('day', 'week', 'month', 'total')),
  -- Either a named timeframe that moves with today, or a fixed pair of dates. A report meant to
  -- answer "how are the last 30 days" must not freeze to the 30 days it was created in.
  timeframe_key text,
  range_from date,
  range_to date,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, name),
  -- Exactly one of the two ways of expressing a window.
  check (
    (timeframe_key is not null and range_from is null and range_to is null)
    or (timeframe_key is null and range_from is not null and range_to is not null)
  ),
  check (range_to is null or range_to >= range_from)
);

create index saved_reports_org_name_idx on public.saved_reports (organisation_id, name);

create trigger set_saved_reports_updated_at
  before update on public.saved_reports
  for each row execute function public.set_updated_at();

-- Access control -------------------------------------------------------------------------------
-- Every member reads reports. Saving one is not a financial-policy change — it does not alter a
-- figure, only which figures are asked for — so operators may manage them as well as owners and
-- finance administrators. Viewers stay read-only.

alter table public.saved_reports enable row level security;

create policy member_read on public.saved_reports
  for select to authenticated
  using (public.is_organisation_member(organisation_id));

create policy operator_manage on public.saved_reports
  for all to authenticated
  using (public.has_organisation_role(organisation_id, array['owner', 'finance_admin', 'operator']))
  with check (public.has_organisation_role(organisation_id, array['owner', 'finance_admin', 'operator']));

commit;
