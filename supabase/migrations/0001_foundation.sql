-- QNCH Control Centre: canonical data foundation.
-- Raw source facts are retained; reporting facts are versioned and rebuildable.

create extension if not exists pgcrypto;

create type public.integration_provider as enum ('shopify', 'meta', 'tiktok', 'xero', 'google_sheets');
create type public.connection_status as enum ('active', 'needs_reauth', 'disabled', 'failed');
create type public.sync_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
create type public.alert_severity as enum ('green', 'amber', 'red');
create type public.reconciliation_status as enum ('matched', 'within_tolerance', 'unmatched', 'needs_review', 'not_applicable');

create table public.organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  reporting_currency char(3) not null default 'GBP',
  business_timezone text not null default 'Europe/London',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organisation_members (
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('owner', 'finance_admin', 'operator', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (organisation_id, user_id)
);

create table public.business_settings (
  organisation_id uuid primary key references public.organisations(id) on delete cascade,
  financial_policy_status text not null default 'draft' check (financial_policy_status in ('draft', 'approved')),
  fiscal_year_start_month smallint not null default 1 check (fiscal_year_start_month between 1 and 12),
  vat_treatment text check (vat_treatment in ('inclusive', 'exclusive')),
  new_customer_definition text,
  inventory_sales_window_days smallint check (inventory_sales_window_days in (7, 30)),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

create table public.metric_targets (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  metric_key text not null,
  target_value numeric(19, 4) not null,
  comparison text not null check (comparison in ('gte', 'lte', 'eq')),
  severity public.alert_severity not null,
  effective_from date not null,
  effective_to date,
  check (effective_to is null or effective_to >= effective_from),
  unique (organisation_id, metric_key, effective_from)
);

create table public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  provider public.integration_provider not null,
  external_account_id text not null,
  display_name text,
  status public.connection_status not null default 'active',
  scopes text[] not null default '{}',
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, provider, external_account_id)
);

-- Ciphertext only: provider refresh/access tokens must never be stored in source control or returned to clients.
create table public.integration_tokens (
  connection_id uuid primary key references public.integration_connections(id) on delete cascade,
  encrypted_refresh_token bytea not null,
  encrypted_access_token bytea,
  access_token_expires_at timestamptz,
  key_version smallint not null default 1,
  updated_at timestamptz not null default now()
);

create table public.sync_cursors (
  connection_id uuid not null references public.integration_connections(id) on delete cascade,
  resource_name text not null,
  cursor_value text,
  watermark_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (connection_id, resource_name)
);

create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid references public.integration_connections(id) on delete set null,
  job_key text not null unique,
  resource_name text not null,
  status public.sync_status not null default 'queued',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  records_received integer not null default 0,
  records_written integer not null default 0,
  error_code text,
  error_message text,
  created_at timestamptz not null default now()
);

create table public.raw_import_objects (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  connection_id uuid references public.integration_connections(id) on delete set null,
  provider public.integration_provider not null,
  resource_name text not null,
  external_id text not null,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  payload jsonb not null,
  payload_hash text not null,
  ingested_at timestamptz not null default now(),
  unique (organisation_id, provider, resource_name, external_id, payload_hash)
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  source text not null default 'shopify',
  external_id text not null,
  title text not null,
  status text,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, source, external_id)
);

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  source text not null default 'shopify',
  external_id text not null,
  sku text,
  title text,
  active boolean not null default true,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, source, external_id)
);

create table public.variant_cost_profiles (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  effective_from date not null,
  effective_to date,
  product_cogs numeric(19, 4) not null default 0,
  packaging numeric(19, 4) not null default 0,
  inbound_freight numeric(19, 4) not null default 0,
  fulfilment numeric(19, 4) not null default 0,
  shipping numeric(19, 4) not null default 0,
  payment_processing numeric(19, 4) not null default 0,
  approved_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  unique (variant_id, effective_from)
);

create table public.shopify_customers (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  external_id text not null,
  first_order_at timestamptz,
  orders_count integer,
  source_updated_at timestamptz,
  ingested_at timestamptz not null default now(),
  unique (organisation_id, external_id)
);

create table public.shopify_orders (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  external_id text not null,
  customer_id uuid references public.shopify_customers(id) on delete set null,
  order_number text,
  currency char(3) not null,
  ordered_at timestamptz not null,
  processed_at timestamptz,
  financial_status text,
  gross_sales numeric(19, 4) not null default 0,
  discounts numeric(19, 4) not null default 0,
  refunds numeric(19, 4) not null default 0,
  tax numeric(19, 4) not null default 0,
  shipping_revenue numeric(19, 4) not null default 0,
  source_updated_at timestamptz,
  ingested_at timestamptz not null default now(),
  unique (organisation_id, external_id)
);
create index shopify_orders_org_ordered_at_idx on public.shopify_orders (organisation_id, ordered_at);

create table public.shopify_order_lines (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  order_id uuid not null references public.shopify_orders(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete set null,
  external_id text not null,
  sku text,
  quantity integer not null,
  gross_sales numeric(19, 4) not null default 0,
  discounts numeric(19, 4) not null default 0,
  source_updated_at timestamptz,
  unique (organisation_id, external_id)
);

create table public.ad_accounts (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  platform text not null check (platform in ('meta', 'tiktok')),
  external_id text not null,
  name text,
  currency char(3),
  timezone text,
  source_updated_at timestamptz,
  unique (organisation_id, platform, external_id)
);

create table public.ad_entities (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null references public.ad_accounts(id) on delete cascade,
  external_id text not null,
  level text not null check (level in ('campaign', 'adset', 'adgroup', 'ad')),
  parent_external_id text,
  name text,
  status text,
  source_updated_at timestamptz,
  unique (ad_account_id, external_id)
);

create table public.ad_daily_metrics (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  ad_account_id uuid not null references public.ad_accounts(id) on delete cascade,
  entity_id uuid references public.ad_entities(id) on delete cascade,
  metric_date date not null,
  attribution_window text not null default 'platform_default',
  breakdown_key text not null default '',
  spend numeric(19, 4) not null default 0,
  impressions bigint not null default 0,
  reach bigint,
  clicks bigint not null default 0,
  landing_page_views bigint,
  add_to_carts bigint,
  checkouts bigint,
  purchases bigint,
  purchase_value numeric(19, 4),
  raw_metrics jsonb not null default '{}'::jsonb,
  source_updated_at timestamptz,
  ingested_at timestamptz not null default now(),
  unique (ad_account_id, entity_id, metric_date, attribution_window, breakdown_key)
);
create index ad_daily_metrics_org_date_idx on public.ad_daily_metrics (organisation_id, metric_date);

create table public.xero_accounts (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  external_id text not null,
  code text,
  name text not null,
  type text,
  status text,
  unique (organisation_id, external_id)
);

create table public.xero_bank_transactions (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  external_id text not null,
  xero_account_id uuid references public.xero_accounts(id) on delete set null,
  transaction_date date not null,
  transaction_type text,
  status text,
  reference text,
  total numeric(19, 4) not null,
  source_updated_at timestamptz,
  ingested_at timestamptz not null default now(),
  unique (organisation_id, external_id)
);
create index xero_bank_transactions_org_date_idx on public.xero_bank_transactions (organisation_id, transaction_date);

create table public.expense_mapping_rules (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  xero_account_id uuid references public.xero_accounts(id) on delete cascade,
  financial_category text not null check (financial_category in ('acquisition', 'variable_operating', 'fixed_operating', 'cash_commitment', 'excluded')),
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  unique (organisation_id, xero_account_id, effective_from)
);

create table public.inventory_snapshots (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  location_external_id text not null default '',
  snapshot_at timestamptz not null,
  available_units numeric(19, 4) not null,
  units_on_order numeric(19, 4) not null default 0,
  source_updated_at timestamptz,
  unique (organisation_id, variant_id, location_external_id, snapshot_at)
);

create table public.cash_commitments (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  due_date date not null,
  category text not null,
  amount numeric(19, 4) not null check (amount >= 0),
  description text,
  source text not null default 'manual',
  external_id text,
  created_at timestamptz not null default now()
);
create unique index cash_commitments_external_id_idx on public.cash_commitments (organisation_id, source, external_id) where external_id is not null;

create table public.daily_financials (
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  business_date date not null,
  calculation_version text not null,
  is_current boolean not null default true,
  net_revenue numeric(19, 4) not null,
  product_cogs numeric(19, 4) not null,
  cm1 numeric(19, 4) not null,
  advertising_spend numeric(19, 4) not null,
  cm2 numeric(19, 4) not null,
  variable_operating_costs numeric(19, 4) not null,
  cm3 numeric(19, 4) not null,
  fixed_operating_costs numeric(19, 4) not null,
  operating_profit numeric(19, 4) not null,
  orders integer not null default 0,
  new_customers integer,
  calculated_at timestamptz not null default now(),
  primary key (organisation_id, business_date, calculation_version)
);
create unique index daily_financials_current_idx on public.daily_financials (organisation_id, business_date) where is_current;

create table public.data_quality_results (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  check_key text not null,
  severity public.alert_severity not null,
  status text not null check (status in ('pass', 'warn', 'fail')),
  observed_value jsonb,
  checked_at timestamptz not null default now(),
  unique (organisation_id, check_key, checked_at)
);

create table public.reconciliation_results (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  reconciliation_key text not null,
  period_start date not null,
  period_end date not null,
  source_a_value numeric(19, 4),
  source_b_value numeric(19, 4),
  difference numeric(19, 4),
  tolerance numeric(19, 4) not null default 0,
  status public.reconciliation_status not null,
  mapping_version text,
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  alert_key text not null,
  severity public.alert_severity not null,
  message text not null,
  metric_value numeric(19, 4),
  active boolean not null default true,
  detected_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.change_audit_log (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  actor_id uuid references public.profiles(id),
  action text not null,
  entity_type text not null,
  entity_id text not null,
  before_value jsonb,
  after_value jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;

create trigger organisations_set_updated_at before update on public.organisations for each row execute procedure public.set_updated_at();
create trigger profiles_set_updated_at before update on public.profiles for each row execute procedure public.set_updated_at();
create trigger connections_set_updated_at before update on public.integration_connections for each row execute procedure public.set_updated_at();
create trigger products_set_updated_at before update on public.products for each row execute procedure public.set_updated_at();
create trigger variants_set_updated_at before update on public.product_variants for each row execute procedure public.set_updated_at();

-- RLS is enabled now; access policies are intentionally added with the authenticated app
-- role implementation so that no table is accidentally exposed during development.
alter table public.organisations enable row level security;
alter table public.profiles enable row level security;
alter table public.organisation_members enable row level security;
alter table public.business_settings enable row level security;
alter table public.metric_targets enable row level security;
alter table public.integration_connections enable row level security;
alter table public.integration_tokens enable row level security;
alter table public.sync_cursors enable row level security;
alter table public.sync_runs enable row level security;
alter table public.raw_import_objects enable row level security;
alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.variant_cost_profiles enable row level security;
alter table public.shopify_customers enable row level security;
alter table public.shopify_orders enable row level security;
alter table public.shopify_order_lines enable row level security;
alter table public.ad_accounts enable row level security;
alter table public.ad_entities enable row level security;
alter table public.ad_daily_metrics enable row level security;
alter table public.xero_accounts enable row level security;
alter table public.xero_bank_transactions enable row level security;
alter table public.expense_mapping_rules enable row level security;
alter table public.inventory_snapshots enable row level security;
alter table public.cash_commitments enable row level security;
alter table public.daily_financials enable row level security;
alter table public.data_quality_results enable row level security;
alter table public.reconciliation_results enable row level security;
alter table public.alerts enable row level security;
alter table public.change_audit_log enable row level security;
