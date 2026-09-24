-- =============================================================================
-- Rydar Drive — Limites des offres SaaS (appliquées en base) + audit
-- =============================================================================

create or replace function private.enforce_plan_limits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limits jsonb;
  v_max bigint;
  v_count bigint;
  v_tz text;
begin
  if current_setting('rydar.bypass_ride_rules', true) = 'on' and auth.role() is null then
    return new;
  end if;
  v_limits := coalesce(private.org_limits(new.organization_id), '{}'::jsonb);

  if tg_table_name = 'drivers' then
    if new.status in ('invited', 'active', 'suspended')
       and (tg_op = 'INSERT' or old.status = 'inactive') then
      v_max := nullif(v_limits ->> 'max_drivers', '')::bigint;
      if v_max is not null then
        select count(*) into v_count from public.drivers
        where organization_id = new.organization_id and status in ('invited', 'active', 'suspended') and id <> new.id;
        if v_count >= v_max then
          raise exception 'PLAN_LIMIT_DRIVERS: limite de % chauffeurs atteinte pour votre offre', v_max using hint = 'upgrade';
        end if;
      end if;
    end if;

  elsif tg_table_name = 'rides' then
    v_max := nullif(v_limits ->> 'max_rides_per_month', '')::bigint;
    if v_max is not null then
      select timezone into v_tz from public.organizations where id = new.organization_id;
      select count(*) into v_count from public.rides
      where organization_id = new.organization_id
        and created_at >= date_trunc('month', now() at time zone coalesce(v_tz, 'Europe/Paris')) at time zone coalesce(v_tz, 'Europe/Paris');
      if v_count >= v_max then
        raise exception 'PLAN_LIMIT_RIDES: limite de % courses / mois atteinte pour votre offre', v_max using hint = 'upgrade';
      end if;
    end if;

  elsif tg_table_name = 'api_keys' then
    if not coalesce((v_limits ->> 'api_access')::boolean, false) then
      raise exception 'PLAN_FEATURE_API: l''API n''est pas incluse dans votre offre' using hint = 'upgrade';
    end if;

  elsif tg_table_name = 'organization_users' then
    if new.status in ('active', 'invited') and (tg_op = 'INSERT' or old.status = 'disabled') then
      v_max := nullif(v_limits ->> 'max_admins', '')::bigint;
      if v_max is not null then
        select count(*) into v_count from public.organization_users
        where organization_id = new.organization_id and status in ('active', 'invited') and id <> new.id;
        if v_count >= v_max then
          raise exception 'PLAN_LIMIT_ADMINS: limite de % administrateurs atteinte pour votre offre', v_max using hint = 'upgrade';
        end if;
      end if;
    end if;

  elsif tg_table_name = 'booking_sites' then
    if new.enabled and not coalesce((v_limits ->> 'booking_site')::boolean, false) then
      raise exception 'PLAN_FEATURE_BOOKING_SITE: le site de réservation n''est pas inclus dans votre offre' using hint = 'upgrade';
    end if;
    if new.custom_domain is not null
       and (tg_op = 'INSERT' or new.custom_domain is distinct from old.custom_domain)
       and not coalesce((v_limits ->> 'custom_domain')::boolean, false) then
      raise exception 'PLAN_FEATURE_CUSTOM_DOMAIN: le domaine personnalisé n''est pas inclus dans votre offre' using hint = 'upgrade';
    end if;
    if tg_op = 'UPDATE' and new.custom_domain is distinct from old.custom_domain then
      new.custom_domain_verified_at := null;
    end if;
  end if;

  return new;
end;
$$;

create trigger drivers_plan_limit before insert or update of status on public.drivers
  for each row execute function private.enforce_plan_limits();
create trigger rides_plan_limit before insert on public.rides
  for each row execute function private.enforce_plan_limits();
create trigger api_keys_plan_limit before insert on public.api_keys
  for each row execute function private.enforce_plan_limits();
create trigger organization_users_plan_limit before insert or update of status on public.organization_users
  for each row execute function private.enforce_plan_limits();
create trigger booking_sites_plan_limit before insert or update of enabled, custom_domain on public.booking_sites
  for each row execute function private.enforce_plan_limits();

-- -----------------------------------------------------------------------------
-- Audit générique des tables de configuration
-- -----------------------------------------------------------------------------
create or replace function private.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ignored text[] := array['updated_at', 'presence', 'last_seen_at', 'current_ride_id', 'online_since',
                             'ride_counter', 'driver_counter', 'last_used_at', 'last_used_ip'];
  v_old jsonb;
  v_new jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_key text;
  v_org uuid;
  v_row jsonb;
begin
  if tg_op in ('UPDATE', 'DELETE') then v_old := to_jsonb(old) - v_ignored; end if;
  if tg_op in ('INSERT', 'UPDATE') then v_new := to_jsonb(new) - v_ignored; end if;

  if tg_op = 'UPDATE' then
    for v_key in select jsonb_object_keys(v_new) loop
      if (v_new -> v_key) is distinct from (v_old -> v_key) then
        v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('from', v_old -> v_key, 'to', v_new -> v_key));
      end if;
    end loop;
    if v_changes = '{}'::jsonb then
      return null;
    end if;
  end if;

  v_row := coalesce(v_new, v_old);
  v_org := case when tg_table_name = 'organizations' then (v_row ->> 'id')::uuid else (v_row ->> 'organization_id')::uuid end;
  if v_org is not null and not exists (select 1 from public.organizations where id = v_org) then
    v_org := null;
  end if;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (
    v_org,
    case when auth.uid() is null then 'system' when private.is_super_admin() then 'super_admin' else 'user' end::public.actor_type,
    auth.uid(),
    tg_table_name || '.' || lower(tg_op),
    tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'organization_id'),
    case
      when tg_table_name = 'organizations' and tg_op = 'UPDATE' and v_changes ? 'status' then 'warning'
      when tg_table_name = 'drivers' and tg_op = 'UPDATE' and (v_changes -> 'status' ->> 'to') = 'suspended' then 'warning'
      when tg_table_name = 'api_keys' and tg_op = 'UPDATE' and v_changes ? 'revoked_at' then 'warning'
      else 'info'
    end,
    case tg_op
      when 'UPDATE' then jsonb_build_object('changes', v_changes)
      when 'INSERT' then jsonb_build_object('new', v_new)
      else jsonb_build_object('old', v_old)
    end
  );
  return null;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'organizations', 'organization_settings', 'booking_sites', 'organization_users', 'drivers', 'vehicles',
    'api_keys', 'pricing_rules', 'plans', 'subscriptions'
  ] loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function private.audit_row_change()',
      t || '_audit', t);
  end loop;
end;
$$;
