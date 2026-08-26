-- Tenant access model for authenticated dashboard users.
-- Connector workers use the service role; raw payloads and OAuth tokens deliberately
-- receive no authenticated-user policy.
--
-- Transaction-wrapped so a failure part-way through cannot leave policies half-applied.

begin;

create or replace function public.is_organisation_member(requested_organisation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organisation_members
    where organisation_id = requested_organisation_id
      and user_id = auth.uid()
  );
$$;

create or replace function public.has_organisation_role(requested_organisation_id uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organisation_members
    where organisation_id = requested_organisation_id
      and user_id = auth.uid()
      and role = any(allowed_roles)
  );
$$;

revoke all on function public.is_organisation_member(uuid) from public;
revoke all on function public.has_organisation_role(uuid, text[]) from public;
grant execute on function public.is_organisation_member(uuid) to authenticated;
grant execute on function public.has_organisation_role(uuid, text[]) to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create policy profiles_read_own on public.profiles
  for select to authenticated using (id = auth.uid());
create policy profiles_update_own on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy organisation_members_read on public.organisation_members
  for select to authenticated
  using (user_id = auth.uid() or public.has_organisation_role(organisation_id, array['owner']));
create policy organisation_members_manage_owners on public.organisation_members
  for all to authenticated
  using (public.has_organisation_role(organisation_id, array['owner']))
  with check (public.has_organisation_role(organisation_id, array['owner']));

create policy organisations_read_members on public.organisations
  for select to authenticated using (public.is_organisation_member(id));
create policy organisations_update_owners on public.organisations
  for update to authenticated
  using (public.has_organisation_role(id, array['owner']))
  with check (public.has_organisation_role(id, array['owner']));

-- Read policies are applied to all dashboard-safe tenant facts with an organisation_id.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'business_settings', 'metric_targets', 'integration_connections',
    'products', 'product_variants', 'shopify_orders', 'shopify_customers',
    'ad_accounts', 'ad_daily_metrics', 'xero_accounts', 'xero_bank_transactions',
    'expense_mapping_rules', 'inventory_snapshots', 'cash_commitments',
    'daily_financials', 'data_quality_results', 'reconciliation_results',
    'alerts', 'change_audit_log'
  ] loop
    execute format(
      'create policy member_read on public.%I for select to authenticated using (public.is_organisation_member(organisation_id))',
      table_name
    );
  end loop;
end;
$$;

-- Human-maintained settings remain editable only by finance administrators/owners.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'business_settings', 'metric_targets', 'variant_cost_profiles',
    'expense_mapping_rules', 'cash_commitments'
  ] loop
    if table_name = 'variant_cost_profiles' then
      execute $policy$
        create policy finance_admin_manage on public.variant_cost_profiles
        for all to authenticated
        using (
          exists (
            select 1 from public.product_variants v
            where v.id = variant_cost_profiles.variant_id
              and public.has_organisation_role(v.organisation_id, array['owner', 'finance_admin'])
          )
        )
        with check (
          exists (
            select 1 from public.product_variants v
            where v.id = variant_cost_profiles.variant_id
              and public.has_organisation_role(v.organisation_id, array['owner', 'finance_admin'])
          )
        )
      $policy$;
    else
      execute format(
        'create policy finance_admin_manage on public.%I for all to authenticated using (public.has_organisation_role(organisation_id, array[''owner'', ''finance_admin''])) with check (public.has_organisation_role(organisation_id, array[''owner'', ''finance_admin'']))',
        table_name
      );
    end if;
  end loop;
end;
$$;

-- Child records derive access through their parent. They are read-only to dashboard users.
create policy variant_cost_profiles_read on public.variant_cost_profiles
  for select to authenticated using (
    exists (
      select 1 from public.product_variants v
      where v.id = variant_cost_profiles.variant_id
        and public.is_organisation_member(v.organisation_id)
    )
  );

create policy shopify_order_lines_read on public.shopify_order_lines
  for select to authenticated using (
    exists (
      select 1 from public.shopify_orders o
      where o.id = shopify_order_lines.order_id
        and public.is_organisation_member(o.organisation_id)
    )
  );

create policy ad_entities_read on public.ad_entities
  for select to authenticated using (
    exists (
      select 1 from public.ad_accounts a
      where a.id = ad_entities.ad_account_id
        and public.is_organisation_member(a.organisation_id)
    )
  );

-- No policies are created for integration_tokens, sync_cursors, sync_runs,
-- raw_import_objects, or other internal tables. RLS therefore denies browser access.

commit;
