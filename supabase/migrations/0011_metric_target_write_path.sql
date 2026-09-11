-- Setting and clearing a metric target, atomically.
--
-- A target is versioned by `effective_from` so that restating a past period is judged against
-- the threshold that was in force at the time rather than today's. Changing one is therefore
-- two writes — end-date the target in force, then insert the replacement — and doing them as
-- two separate PostgREST calls can half-apply.
--
-- Both orders are wrong. End-date first and a failure leaves the metric with no target at all,
-- which the dashboard reports as healthy because nothing is judging it. Insert first and there
-- are briefly two targets in force, which `resolveAllEffective` returns both of. A function
-- body is one transaction, so this does both or neither.
--
-- Security invoker, deliberately: the `finance_admin_manage` policy on `metric_targets` is what
-- decides who may do this, and a definer function would bypass it and let any member write.

begin;

create or replace function public.set_metric_target(
  p_organisation_id uuid,
  p_metric_key text,
  p_target_value numeric,
  p_comparison text,
  p_severity public.alert_severity,
  p_effective_from date
) returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_comparison not in ('gte', 'lte', 'eq') then
    raise exception 'comparison must be gte, lte or eq, got %', p_comparison;
  end if;

  -- Only targets that started earlier are closed. One already starting on this date is the row
  -- being replaced, and end-dating it to the day before its own start would make it apply to
  -- no dates at all.
  update public.metric_targets
  set effective_to = p_effective_from - 1
  where organisation_id = p_organisation_id
    and metric_key = p_metric_key
    and effective_to is null
    and effective_from < p_effective_from;

  insert into public.metric_targets
    (organisation_id, metric_key, target_value, comparison, severity, effective_from)
  values
    (p_organisation_id, p_metric_key, p_target_value, p_comparison, p_severity, p_effective_from)
  on conflict (organisation_id, metric_key, effective_from)
  do update set
    target_value = excluded.target_value,
    comparison = excluded.comparison,
    severity = excluded.severity,
    effective_to = null;
end;
$$;

/**
 * Stops a metric being judged from a given date.
 *
 * End-dated rather than deleted. A deleted target would silently change what a past period was
 * reported against, and the point of dating them is that it cannot.
 */
create or replace function public.clear_metric_target(
  p_organisation_id uuid,
  p_metric_key text,
  p_effective_to date
) returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  ended integer;
begin
  update public.metric_targets
  set effective_to = p_effective_to
  where organisation_id = p_organisation_id
    and metric_key = p_metric_key
    and effective_to is null;

  get diagnostics ended = row_count;
  return ended;
end;
$$;

revoke all on function public.set_metric_target(uuid, text, numeric, text, public.alert_severity, date) from public;
revoke all on function public.clear_metric_target(uuid, text, date) from public;
grant execute on function public.set_metric_target(uuid, text, numeric, text, public.alert_severity, date) to authenticated;
grant execute on function public.clear_metric_target(uuid, text, date) to authenticated;

commit;
