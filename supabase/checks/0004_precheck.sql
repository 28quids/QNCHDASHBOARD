-- Read-only schema state check. Safe to run against any environment, at any point.
--
-- Reports which migrations are applied and how much data each table holds. Nothing here
-- references a table directly, so it works on a completely empty project as well as a
-- fully migrated one — an earlier version did reference tables directly, which meant one
-- missing table aborted the whole script and hid the results of every other query.

-- 1. Which expected tables exist, and how many rows does each hold? ------------------
with expected(table_name, migration) as (
  values
    ('organisations', '0001'), ('profiles', '0001'), ('organisation_members', '0001'),
    ('business_settings', '0001'), ('metric_targets', '0001'),
    ('integration_connections', '0001'), ('integration_tokens', '0001'),
    ('sync_cursors', '0001'), ('sync_runs', '0001'), ('raw_import_objects', '0001'),
    ('products', '0001'), ('product_variants', '0001'), ('variant_cost_profiles', '0001'),
    ('shopify_customers', '0001'), ('shopify_orders', '0001'), ('shopify_order_lines', '0001'),
    ('ad_accounts', '0001'), ('ad_entities', '0001'), ('ad_daily_metrics', '0001'),
    ('xero_accounts', '0001'), ('xero_bank_transactions', '0001'),
    ('expense_mapping_rules', '0001'), ('inventory_snapshots', '0001'),
    ('cash_commitments', '0001'), ('daily_financials', '0001'),
    ('data_quality_results', '0001'), ('reconciliation_results', '0001'),
    ('alerts', '0001'), ('change_audit_log', '0001'),
    ('financial_policy_decisions', '0003'), ('cost_assumptions', '0003'),
    ('shopify_refunds', '0004'), ('shopify_refund_lines', '0004'),
    ('shopify_payouts', '0004'), ('variant_inventory_settings', '0004'),
    ('xero_invoices', '0004')
),
resolved as (
  select migration, table_name, to_regclass('public.' || quote_ident(table_name)) as oid
  from expected
)
select
  migration,
  table_name,
  case when oid is null then 'MISSING' else 'present' end as state,
  -- query_to_xml runs the count through the planner only for tables that resolved, so a
  -- missing table yields null instead of raising undefined_table.
  case
    when oid is null then null
    else (xpath(
      '/row/c/text()',
      query_to_xml('select count(*) as c from ' || oid::text, false, true, '')
    ))[1]::text::bigint
  end as row_count
from resolved
order by migration, table_name;

-- 2. Have 0004's two added columns been applied? -------------------------------------
-- information_schema never raises on a missing table, so this is safe unconditionally.
select
  'cost_assumptions.period_unit' as column_ref,
  case when count(*) = 0 then 'MISSING' else 'present' end as state
from information_schema.columns
where table_schema = 'public' and table_name = 'cost_assumptions' and column_name = 'period_unit'
union all
select
  'inventory_snapshots.expected_delivery_date',
  case when count(*) = 0 then 'MISSING' else 'present' end
from information_schema.columns
where table_schema = 'public' and table_name = 'inventory_snapshots'
  and column_name = 'expected_delivery_date';

-- 3. Which enum types exist? ----------------------------------------------------------
-- 0001 and 0003 each create enums before their tables. A migration that half-applied
-- before transaction wrapping was added would show types present but tables missing.
select typname as enum_type
from pg_type
where typnamespace = 'public'::regnamespace and typtype = 'e'
order by typname;
