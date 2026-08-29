-- Structures the financial engine requires that the foundation migration did not yet provide.
--
-- Refunds must carry their own processed date, because approved policy recognises a refund on
-- the date it was processed rather than against the original order date. An order-level refund
-- total cannot express that. Recurring costs likewise need an explicit period so a daily P&L
-- can spread them and still sum back to the approved monthly amount.
--
-- Wrapped in a transaction deliberately. None of the statements below are individually
-- idempotent, so a failure part-way through would otherwise leave the schema half-built
-- with no clean way to re-run. Postgres DDL is transactional: on any error the whole
-- migration rolls back and the database is left exactly as it was.

begin;

alter table public.cost_assumptions
  add column period_unit text check (period_unit in ('day', 'week', 'month', 'year'));

comment on column public.cost_assumptions.period_unit is
  'Required for charge_basis = fixed_period. Null for per-order, per-unit and percentage costs.';

alter table public.cost_assumptions
  add constraint cost_assumptions_period_unit_required
  check (charge_basis <> 'fixed_period' or period_unit is not null);

comment on column public.cost_assumptions.amount is
  'Currency for per_order/per_unit/fixed_period. A percentage (1.75 meaning 1.75%) for percentage_of_revenue.';

-- Refunds ------------------------------------------------------------------------------------

create table public.shopify_refunds (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  external_id text not null,
  order_id uuid not null references public.shopify_orders(id) on delete cascade,
  -- The date the refund is recognised against in the management P&L.
  processed_at timestamptz not null,
  subtotal numeric(19, 4) not null default 0,
  shipping numeric(19, 4) not null default 0,
  tax numeric(19, 4) not null default 0,
  total numeric(19, 4) not null default 0,
  -- Drives whether stock cost is reversed, per the approved refund policy.
  restocked boolean not null default false,
  note text,
  source_updated_at timestamptz,
  ingested_at timestamptz not null default now(),
  unique (organisation_id, external_id)
);
create index shopify_refunds_org_processed_at_idx on public.shopify_refunds (organisation_id, processed_at);

create table public.shopify_refund_lines (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  refund_id uuid not null references public.shopify_refunds(id) on delete cascade,
  order_line_id uuid references public.shopify_order_lines(id) on delete set null,
  variant_id uuid references public.product_variants(id) on delete set null,
  external_id text not null,
  quantity integer not null default 0,
  subtotal numeric(19, 4) not null default 0,
  restocked boolean not null default false,
  unique (organisation_id, external_id)
);

-- Payment settlements, for revenue reconciliation ---------------------------------------------

create table public.shopify_payouts (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  external_id text not null,
  payout_date date not null,
  status text,
  currency char(3) not null,
  charges numeric(19, 4) not null default 0,
  refunds numeric(19, 4) not null default 0,
  adjustments numeric(19, 4) not null default 0,
  fees numeric(19, 4) not null default 0,
  net_amount numeric(19, 4) not null,
  source_updated_at timestamptz,
  ingested_at timestamptz not null default now(),
  unique (organisation_id, external_id)
);
create index shopify_payouts_org_date_idx on public.shopify_payouts (organisation_id, payout_date);

-- Inventory planning inputs -------------------------------------------------------------------

create table public.variant_inventory_settings (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  reorder_point_units numeric(19, 4) check (reorder_point_units >= 0),
  supplier_lead_time_days smallint check (supplier_lead_time_days >= 0),
  supplier_name text,
  effective_from date not null,
  effective_to date,
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  unique (variant_id, effective_from)
);

create trigger variant_inventory_settings_set_updated_at
  before update on public.variant_inventory_settings
  for each row execute function public.set_updated_at();

alter table public.inventory_snapshots
  add column expected_delivery_date date;

-- Accounts payable and receivable, for the cash commitment model -------------------------------

create table public.xero_invoices (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  external_id text not null,
  -- ACCPAY is a bill QNCH owes; ACCREC is a sales invoice owed to QNCH.
  invoice_type text not null check (invoice_type in ('ACCPAY', 'ACCREC')),
  contact_name text,
  invoice_date date not null,
  due_date date,
  status text,
  currency char(3) not null,
  subtotal numeric(19, 4) not null default 0,
  total_tax numeric(19, 4) not null default 0,
  total numeric(19, 4) not null default 0,
  amount_due numeric(19, 4) not null default 0,
  amount_paid numeric(19, 4) not null default 0,
  source_updated_at timestamptz,
  ingested_at timestamptz not null default now(),
  unique (organisation_id, external_id)
);
create index xero_invoices_org_due_date_idx on public.xero_invoices (organisation_id, due_date);

-- Access control -------------------------------------------------------------------------------
-- Same model as the foundation migration: members read tenant facts, finance administrators
-- manage the human-maintained settings, and connector workers use the service role.

alter table public.shopify_refunds enable row level security;
alter table public.shopify_refund_lines enable row level security;
alter table public.shopify_payouts enable row level security;
alter table public.variant_inventory_settings enable row level security;
alter table public.xero_invoices enable row level security;

do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'shopify_refunds', 'shopify_refund_lines', 'shopify_payouts',
    'variant_inventory_settings', 'xero_invoices'
  ] loop
    execute format(
      'create policy member_read on public.%I for select to authenticated using (public.is_organisation_member(organisation_id))',
      target_table
    );
  end loop;
end;
$$;

create policy finance_admin_manage on public.variant_inventory_settings
  for all to authenticated
  using (public.has_organisation_role(organisation_id, array['owner', 'finance_admin']))
  with check (public.has_organisation_role(organisation_id, array['owner', 'finance_admin']));

commit;
