-- Makes the account-level advertising row unique, and clears the rows that were not.
--
-- `ad_daily_metrics` is keyed on (ad_account_id, entity_id, metric_date, attribution_window,
-- breakdown_key). The account-level row -- the one the P&L reads -- has a null entity_id, and
-- Postgres treats nulls as distinct in a unique constraint. So every re-import inserted
-- another account-level row for the same day rather than updating the existing one, and
-- advertising spend grew on each sync.
--
-- The connector compounded it by writing entity-level rows with a null entity_id when the
-- campaign behind them had not been synced yet. That put them in the account-level bucket,
-- where their spend was added on top of the account row that already contained it.
--
-- Both are fixed here and in lib/repositories/meta-repository.ts. `nulls not distinct`
-- requires Postgres 15; this database runs 17.
--
-- The existing rows are deleted rather than deduplicated. A legitimate account row and a
-- mis-filed entity row are now indistinguishable -- both carry a null entity_id and real
-- spend -- so there is no rule that keeps the right one. The data is fully re-derivable from
-- Meta, so re-importing is the only correct repair:
--
--   npm run backfill:meta -- --since <first day of trading>

begin;

-- Advertising metrics only. Orders, costs and published financials are untouched.
delete from public.ad_daily_metrics;

alter table public.ad_daily_metrics
  drop constraint ad_daily_metrics_ad_account_id_entity_id_metric_date_attrib_key;

-- `nulls not distinct` is the whole point: it makes two account-level rows for the same day
-- collide, so an upsert updates rather than inserts, and a re-sync converges.
create unique index ad_daily_metrics_natural_key
  on public.ad_daily_metrics (ad_account_id, entity_id, metric_date, attribution_window, breakdown_key)
  nulls not distinct;

comment on index public.ad_daily_metrics_natural_key is
  'Nulls not distinct so the account-level row (null entity_id) upserts rather than duplicating on re-sync.';

commit;
