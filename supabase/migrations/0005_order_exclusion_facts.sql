-- Records whether a Shopify order is excluded from management reporting.
--
-- `normaliseOrder` already decides this (lib/connectors/shopify/normalise.ts: a test order or
-- a cancelled one is excluded), but the decision was never stored. Everything downstream that
-- reads orders back out of the database — the reporting layer, the P&L, CAC — had no way to
-- tell an excluded order from a real one, so a test order would have entered revenue silently.
--
-- Both source facts are stored rather than a single derived `is_excluded` flag, so that the
-- exclusion rule stays a policy decision in code that can change without a migration, and so
-- a cancelled order remains distinguishable from a test one in any audit.
--
-- Existing rows default to not-excluded. That is a claim about data already imported, so the
-- Shopify backfill must be re-run over the full history to populate these truthfully; until
-- it is, a test order among the existing rows still reads as real. `scripts/probe-shopify.mts`
-- reports the counts to check against.

begin;

alter table public.shopify_orders
  add column is_test boolean not null default false,
  add column cancelled_at timestamptz;

comment on column public.shopify_orders.is_test is
  'Shopify test order. Excluded from management reporting, revenue and acquisition counts.';
comment on column public.shopify_orders.cancelled_at is
  'Set when the order was cancelled. Excluded from management reporting while non-null.';

-- The reporting layer filters on these for every P&L query, over a date range.
create index shopify_orders_org_reportable_idx
  on public.shopify_orders (organisation_id, ordered_at)
  where is_test = false and cancelled_at is null;

commit;
