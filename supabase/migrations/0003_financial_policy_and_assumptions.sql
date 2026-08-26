-- Configurable, date-effective policies and assumptions. These are management inputs,
-- never values inferred or silently rewritten from raw provider data.

create type public.cost_charge_basis as enum ('per_order', 'per_unit', 'percentage_of_revenue', 'fixed_period');
create type public.financial_bucket as enum ('cm1', 'cm2', 'cm3', 'fixed_operating', 'cash_only');

create table public.financial_policy_decisions (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  decision_key text not null,
  decision_value jsonb not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'superseded')),
  effective_from date not null,
  effective_to date,
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  unique (organisation_id, decision_key, effective_from)
);

create table public.cost_assumptions (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  assumption_key text not null,
  financial_bucket public.financial_bucket not null,
  charge_basis public.cost_charge_basis not null,
  amount numeric(19, 4) not null check (amount >= 0),
  currency char(3) not null default 'GBP',
  applies_to text not null default 'all_orders',
  effective_from date not null,
  effective_to date,
  approved_by uuid references public.profiles(id),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  unique (organisation_id, assumption_key, applies_to, effective_from)
);

create trigger cost_assumptions_set_updated_at
  before update on public.cost_assumptions
  for each row execute function public.set_updated_at();

alter table public.financial_policy_decisions enable row level security;
alter table public.cost_assumptions enable row level security;

create policy member_read on public.financial_policy_decisions
  for select to authenticated using (public.is_organisation_member(organisation_id));
create policy finance_admin_manage on public.financial_policy_decisions
  for all to authenticated
  using (public.has_organisation_role(organisation_id, array['owner', 'finance_admin']))
  with check (public.has_organisation_role(organisation_id, array['owner', 'finance_admin']));
create policy member_read on public.cost_assumptions
  for select to authenticated using (public.is_organisation_member(organisation_id));
create policy finance_admin_manage on public.cost_assumptions
  for all to authenticated
  using (public.has_organisation_role(organisation_id, array['owner', 'finance_admin']))
  with check (public.has_organisation_role(organisation_id, array['owner', 'finance_admin']));
