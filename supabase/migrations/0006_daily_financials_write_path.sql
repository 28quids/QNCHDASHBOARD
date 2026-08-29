-- Atomic republish of a calculated period into daily_financials.
--
-- `daily_financials_current_idx` allows exactly one current row per date. Recalculating a
-- period therefore has to stand the old rows down and put the new ones up together: doing it
-- as two PostgREST calls either violates the index (new rows up first) or leaves a window
-- where the dashboard reads no data at all for those dates (old rows down first).
--
-- A function body is a single transaction, so this does both or neither. Superseded rows are
-- retained rather than deleted — a restatement must stay auditable against what was published
-- at the time, which is the whole point of versioning the calculation.

begin;

create or replace function public.replace_daily_financials(
  p_organisation_id uuid,
  p_calculation_version text,
  p_rows jsonb
) returns integer
language plpgsql
as $$
declare
  written integer;
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array, got %', jsonb_typeof(p_rows);
  end if;

  -- Only the dates actually being republished are stood down. A partial recalculation must
  -- not blank out days outside the window it was given.
  update public.daily_financials existing
  set is_current = false
  where existing.organisation_id = p_organisation_id
    and existing.is_current
    and existing.business_date in (
      select (row_value ->> 'business_date')::date
      from jsonb_array_elements(p_rows) as row_value
    );

  insert into public.daily_financials (
    organisation_id, business_date, calculation_version, is_current,
    net_revenue, product_cogs, cm1, advertising_spend, cm2,
    variable_operating_costs, cm3, fixed_operating_costs, operating_profit,
    orders, new_customers, calculated_at
  )
  select
    p_organisation_id,
    (row_value ->> 'business_date')::date,
    p_calculation_version,
    true,
    (row_value ->> 'net_revenue')::numeric,
    (row_value ->> 'product_cogs')::numeric,
    (row_value ->> 'cm1')::numeric,
    (row_value ->> 'advertising_spend')::numeric,
    (row_value ->> 'cm2')::numeric,
    (row_value ->> 'variable_operating_costs')::numeric,
    (row_value ->> 'cm3')::numeric,
    (row_value ->> 'fixed_operating_costs')::numeric,
    (row_value ->> 'operating_profit')::numeric,
    (row_value ->> 'orders')::integer,
    (row_value ->> 'new_customers')::integer,
    now()
  from jsonb_array_elements(p_rows) as row_value
  on conflict (organisation_id, business_date, calculation_version)
  do update set
    is_current = true,
    net_revenue = excluded.net_revenue,
    product_cogs = excluded.product_cogs,
    cm1 = excluded.cm1,
    advertising_spend = excluded.advertising_spend,
    cm2 = excluded.cm2,
    variable_operating_costs = excluded.variable_operating_costs,
    cm3 = excluded.cm3,
    fixed_operating_costs = excluded.fixed_operating_costs,
    operating_profit = excluded.operating_profit,
    orders = excluded.orders,
    new_customers = excluded.new_customers,
    calculated_at = now();

  get diagnostics written = row_count;
  return written;
end;
$$;

comment on function public.replace_daily_financials is
  'Republishes a calculated date range as the current version, atomically. Superseded rows are kept for audit.';

-- Calculation is a server-side job running under the service role. No browser session should
-- be able to write published financials, so the authenticated role is not granted execute.
revoke all on function public.replace_daily_financials(uuid, text, jsonb) from public, anon, authenticated;

commit;
