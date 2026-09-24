-- =============================================================================
-- Rydar Drive — KPIs, statistiques, vue plateforme
-- Toutes les fonctions vérifient explicitement l'appartenance au tenant.
-- =============================================================================

create or replace function private.org_limits(p_org uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p.limits, '{}'::jsonb) || coalesce(o.limits_override, '{}'::jsonb)
  from public.organizations o
  left join public.plans p on p.id = o.plan_id
  where o.id = p_org;
$$;

create or replace function private.assert_org_reader(p_org uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    perform private.assert_org_member(p_org);
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- KPIs temps réel du dashboard rattacheur
-- -----------------------------------------------------------------------------
create or replace function public.org_kpis(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_day timestamptz;
  v_week timestamptz;
  v_rides jsonb;
  v_drivers jsonb;
begin
  perform private.assert_org_reader(p_org);
  select timezone into v_tz from public.organizations where id = p_org;
  v_tz := coalesce(v_tz, 'Europe/Paris');
  v_day := date_trunc('day', now() at time zone v_tz) at time zone v_tz;
  v_week := date_trunc('week', now() at time zone v_tz) at time zone v_tz;

  select jsonb_build_object(
    'rides_today', count(*) filter (where r.pickup_at >= v_day and r.pickup_at < v_day + interval '1 day'),
    'revenue_today_cents', coalesce(sum(r.price_cents) filter (where r.status = 'COMPLETED' and r.completed_at >= v_day), 0),
    'expected_revenue_today_cents', coalesce(sum(r.price_cents) filter (
      where r.pickup_at >= v_day and r.pickup_at < v_day + interval '1 day' and r.status not in ('CANCELLED', 'NO_DRIVER_FOUND')), 0),
    'rides_week', count(*) filter (where r.pickup_at >= v_week and r.pickup_at < v_week + interval '7 days'),
    'revenue_week_cents', coalesce(sum(r.price_cents) filter (where r.status = 'COMPLETED' and r.completed_at >= v_week), 0),
    'instant_active', count(*) filter (where r.type = 'instant' and r.status not in ('COMPLETED', 'CANCELLED', 'NO_DRIVER_FOUND')),
    'scheduled_upcoming', count(*) filter (where r.type = 'scheduled' and r.pickup_at >= now() and r.status not in ('COMPLETED', 'CANCELLED', 'NO_DRIVER_FOUND')),
    'scheduled_unassigned', count(*) filter (where r.type = 'scheduled' and r.pickup_at >= now() and r.driver_id is null and r.status in ('CREATED', 'SEARCHING_DRIVER', 'OFFERED')),
    'searching', count(*) filter (where r.status in ('CREATED', 'SEARCHING_DRIVER')),
    'offered', count(*) filter (where r.status = 'OFFERED'),
    'assigned', count(*) filter (where r.status = 'ACCEPTED'),
    'in_progress', count(*) filter (where r.status in ('DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS')),
    'completed_today', count(*) filter (where r.status = 'COMPLETED' and r.completed_at >= v_day),
    'cancelled_today', count(*) filter (where r.status = 'CANCELLED' and r.cancelled_at >= v_day),
    'no_driver_today', count(*) filter (where r.status = 'NO_DRIVER_FOUND' and r.no_driver_at >= v_day),
    'avg_assign_seconds_today', round(avg(extract(epoch from (r.accepted_at - r.dispatch_started_at)))
      filter (where r.accepted_at >= v_day and r.dispatch_started_at is not null)::numeric, 1)
  ) into v_rides
  from public.rides r
  where r.organization_id = p_org
    and (r.pickup_at >= v_week - interval '1 day' or r.status not in ('COMPLETED', 'CANCELLED', 'NO_DRIVER_FOUND'));

  select jsonb_build_object(
    'drivers_total', count(*) filter (where d.status = 'active'),
    'drivers_online', count(*) filter (where d.status = 'active' and d.presence <> 'offline'),
    'drivers_available', count(*) filter (where d.status = 'active' and d.presence = 'available'),
    'drivers_offered', count(*) filter (where d.status = 'active' and d.presence = 'offered'),
    'drivers_busy', count(*) filter (where d.status = 'active' and d.presence in ('en_route', 'arrived', 'on_trip'))
  ) into v_drivers
  from public.drivers d
  where d.organization_id = p_org;

  return v_rides || v_drivers || jsonb_build_object('generated_at', now(), 'timezone', v_tz);
end;
$$;

-- -----------------------------------------------------------------------------
-- Statistiques sur une période
-- -----------------------------------------------------------------------------
create or replace function public.org_stats(p_org uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_advanced boolean;
  v_summary jsonb;
  v_offers jsonb;
  v_by_hour jsonb;
  v_by_weekday jsonb;
  v_daily jsonb;
  v_per_driver jsonb;
  v_by_source jsonb;
  v_by_category jsonb;
begin
  perform private.assert_org_reader(p_org);
  if p_to <= p_from or p_to - p_from > interval '400 days' then
    raise exception 'INVALID_RANGE' using errcode = '22023';
  end if;
  select timezone into v_tz from public.organizations where id = p_org;
  v_tz := coalesce(v_tz, 'Europe/Paris');
  v_advanced := coalesce((private.org_limits(p_org) ->> 'advanced_stats')::boolean, false) or private.is_super_admin();

  select jsonb_build_object(
    'rides_total', count(*),
    'completed', count(*) filter (where status = 'COMPLETED'),
    'cancelled', count(*) filter (where status = 'CANCELLED'),
    'no_driver', count(*) filter (where status = 'NO_DRIVER_FOUND'),
    'instant', count(*) filter (where type = 'instant'),
    'scheduled', count(*) filter (where type = 'scheduled'),
    'revenue_cents', coalesce(sum(price_cents) filter (where status = 'COMPLETED'), 0),
    'avg_price_cents', round(avg(price_cents) filter (where status = 'COMPLETED')),
    'avg_assign_seconds', round(avg(extract(epoch from (accepted_at - dispatch_started_at)))
      filter (where accepted_at is not null and dispatch_started_at is not null)::numeric, 1),
    'completion_rate', case when count(*) > 0 then round(count(*) filter (where status = 'COMPLETED')::numeric / count(*), 4) end
  ) into v_summary
  from public.rides
  where organization_id = p_org and pickup_at >= p_from and pickup_at < p_to;

  select jsonb_build_object(
    'offers_sent', count(*),
    'accepted', count(*) filter (where status = 'accepted'),
    'declined', count(*) filter (where status = 'declined'),
    'expired', count(*) filter (where status = 'expired'),
    'acceptance_rate', case when count(*) filter (where status in ('accepted', 'declined', 'expired')) > 0
      then round(count(*) filter (where status = 'accepted')::numeric
        / count(*) filter (where status in ('accepted', 'declined', 'expired')), 4) end,
    'avg_response_ms', round(avg(extract(epoch from (responded_at - sent_at)) * 1000) filter (where status = 'accepted')),
    'avg_pickup_distance_m', round(avg(distance_m) filter (where status = 'accepted' and mode = 'geo'))
  ) into v_offers
  from public.ride_offers
  where organization_id = p_org and sent_at >= p_from and sent_at < p_to;

  select coalesce(jsonb_agg(jsonb_build_object('date', d.day, 'rides', coalesce(x.rides, 0), 'completed', coalesce(x.completed, 0),
    'revenue_cents', coalesce(x.revenue, 0)) order by d.day), '[]'::jsonb)
  into v_daily
  from generate_series(
    date_trunc('day', p_from at time zone v_tz),
    date_trunc('day', (p_to - interval '1 second') at time zone v_tz),
    interval '1 day'
  ) as d(day)
  left join (
    select date_trunc('day', pickup_at at time zone v_tz) as day,
           count(*) as rides,
           count(*) filter (where status = 'COMPLETED') as completed,
           sum(price_cents) filter (where status = 'COMPLETED') as revenue
    from public.rides
    where organization_id = p_org and pickup_at >= p_from and pickup_at < p_to
    group by 1
  ) x on x.day = d.day;

  if v_advanced then
    select coalesce(jsonb_agg(jsonb_build_object('hour', h, 'rides', coalesce(x.c, 0)) order by h), '[]'::jsonb)
    into v_by_hour
    from generate_series(0, 23) as h
    left join (
      select extract(hour from pickup_at at time zone v_tz)::integer as hr, count(*) as c
      from public.rides
      where organization_id = p_org and pickup_at >= p_from and pickup_at < p_to and status <> 'CANCELLED'
      group by 1
    ) x on x.hr = h;

    select coalesce(jsonb_agg(jsonb_build_object('weekday', w, 'rides', coalesce(x.c, 0)) order by w), '[]'::jsonb)
    into v_by_weekday
    from generate_series(1, 7) as w
    left join (
      select extract(isodow from pickup_at at time zone v_tz)::integer as dw, count(*) as c
      from public.rides
      where organization_id = p_org and pickup_at >= p_from and pickup_at < p_to and status <> 'CANCELLED'
      group by 1
    ) x on x.dw = w;

    select coalesce(jsonb_agg(t order by (t ->> 'rides')::integer desc, t ->> 'name'), '[]'::jsonb)
    into v_per_driver
    from (
      select jsonb_build_object(
        'driver_id', d.id,
        'number', d.number,
        'name', d.first_name || ' ' || d.last_name,
        'rides', coalesce(rs.rides, 0),
        'revenue_cents', coalesce(rs.revenue, 0),
        'offers', coalesce(os.offers, 0),
        'acceptance_rate', case when coalesce(os.answered, 0) > 0 then round(os.accepted::numeric / os.answered, 4) end,
        'avg_pickup_distance_m', os.avg_distance
      ) as t
      from public.drivers d
      left join (
        select driver_id, count(*) filter (where status = 'COMPLETED') as rides,
               sum(price_cents) filter (where status = 'COMPLETED') as revenue
        from public.rides
        where organization_id = p_org and pickup_at >= p_from and pickup_at < p_to and driver_id is not null
        group by driver_id
      ) rs on rs.driver_id = d.id
      left join (
        select driver_id, count(*) as offers,
               count(*) filter (where status = 'accepted') as accepted,
               count(*) filter (where status in ('accepted', 'declined', 'expired')) as answered,
               round(avg(distance_m) filter (where status = 'accepted' and mode = 'geo')) as avg_distance
        from public.ride_offers
        where organization_id = p_org and sent_at >= p_from and sent_at < p_to
        group by driver_id
      ) os on os.driver_id = d.id
      where d.organization_id = p_org and (rs.driver_id is not null or os.driver_id is not null)
    ) s;

    select coalesce(jsonb_object_agg(source, c), '{}'::jsonb) into v_by_source
    from (select source::text, count(*) as c from public.rides
          where organization_id = p_org and pickup_at >= p_from and pickup_at < p_to group by 1) x;

    select coalesce(jsonb_object_agg(cat, c), '{}'::jsonb) into v_by_category
    from (select vehicle_category::text as cat, count(*) as c from public.rides
          where organization_id = p_org and pickup_at >= p_from and pickup_at < p_to group by 1) x;
  end if;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'timezone', v_tz, 'advanced', v_advanced,
    'summary', v_summary, 'offers', v_offers, 'daily', v_daily,
    'by_hour', v_by_hour, 'by_weekday', v_by_weekday, 'per_driver', v_per_driver,
    'by_source', v_by_source, 'by_category', v_by_category
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Statistiques d'un chauffeur (taux d'acceptation, terminées, annulées…)
-- -----------------------------------------------------------------------------
create or replace function public.driver_stats(p_driver uuid, p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_from timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)));
  v_rides jsonb;
  v_offers jsonb;
begin
  select organization_id into v_org from public.drivers where id = p_driver;
  if not found then
    raise exception 'DRIVER_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform private.assert_org_reader(v_org);

  select jsonb_build_object(
    'completed', count(*) filter (where status = 'COMPLETED'),
    'cancelled', count(*) filter (where status = 'CANCELLED'),
    'active', count(*) filter (where status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS')),
    'revenue_cents', coalesce(sum(price_cents) filter (where status = 'COMPLETED'), 0),
    'completed_all_time', (select count(*) from public.rides x where x.driver_id = p_driver and x.status = 'COMPLETED')
  ) into v_rides
  from public.rides
  where driver_id = p_driver and pickup_at >= v_from;

  select jsonb_build_object(
    'offers', count(*),
    'accepted', count(*) filter (where status = 'accepted'),
    'declined', count(*) filter (where status = 'declined'),
    'expired', count(*) filter (where status = 'expired'),
    'acceptance_rate', case when count(*) filter (where status in ('accepted', 'declined', 'expired')) > 0
      then round(count(*) filter (where status = 'accepted')::numeric
        / count(*) filter (where status in ('accepted', 'declined', 'expired')), 4) end,
    'avg_response_ms', round(avg(extract(epoch from (responded_at - sent_at)) * 1000) filter (where status = 'accepted'))
  ) into v_offers
  from public.ride_offers
  where driver_id = p_driver and sent_at >= v_from;

  return jsonb_build_object('days', p_days, 'rides', v_rides, 'offers', v_offers);
end;
$$;

-- -----------------------------------------------------------------------------
-- Consommation vs limites de l'offre
-- -----------------------------------------------------------------------------
create or replace function public.org_usage(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_month timestamptz;
begin
  perform private.assert_org_reader(p_org);
  select timezone into v_tz from public.organizations where id = p_org;
  v_month := date_trunc('month', now() at time zone coalesce(v_tz, 'Europe/Paris')) at time zone coalesce(v_tz, 'Europe/Paris');
  return jsonb_build_object(
    'limits', private.org_limits(p_org),
    'drivers', (select count(*) from public.drivers where organization_id = p_org and status in ('invited', 'active', 'suspended')),
    'rides_this_month', (select count(*) from public.rides where organization_id = p_org and created_at >= v_month),
    'admins', (select count(*) from public.organization_users where organization_id = p_org and status in ('active', 'invited')),
    'api_keys', (select count(*) from public.api_keys where organization_id = p_org and revoked_at is null)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Vue plateforme (super admin)
-- -----------------------------------------------------------------------------
create or replace function public.platform_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_day timestamptz := date_trunc('day', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris';
  v_month timestamptz := date_trunc('month', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris';
  v_totals jsonb;
  v_orgs jsonb;
  v_daily jsonb;
  v_errors jsonb;
begin
  if not private.is_super_admin() then
    raise exception 'FORBIDDEN: réservé au super admin' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'organizations', (select count(*) from public.organizations where status <> 'archived'),
    'organizations_active', (select count(*) from public.organizations where status = 'active'),
    'organizations_suspended', (select count(*) from public.organizations where status = 'suspended'),
    'drivers', (select count(*) from public.drivers where status = 'active'),
    'drivers_online', (select count(*) from public.drivers where status = 'active' and presence <> 'offline'),
    'rides_today', (select count(*) from public.rides where pickup_at >= v_day and pickup_at < v_day + interval '1 day'),
    'rides_month', (select count(*) from public.rides where pickup_at >= v_month),
    'gmv_month_cents', (select coalesce(sum(price_cents), 0) from public.rides where status = 'COMPLETED' and completed_at >= v_month),
    'active_rides', (select count(*) from public.rides where status in ('SEARCHING_DRIVER', 'OFFERED', 'ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS')),
    'no_driver_24h', (select count(*) from public.rides where status = 'NO_DRIVER_FOUND' and no_driver_at > now() - interval '24 hours'),
    'dispatch_errors_24h', (select count(*) from public.ride_events where level = 'error' and created_at > now() - interval '24 hours'),
    'notifications_sent_24h', (select count(*) from public.notifications where status = 'sent' and sent_at > now() - interval '24 hours'),
    'notifications_failed_24h', (select count(*) from public.notifications where status = 'failed' and created_at > now() - interval '24 hours'),
    'api_requests_24h', (select count(*) from public.api_logs where created_at > now() - interval '24 hours'),
    'security_events_7d', (select count(*) from public.audit_logs where severity <> 'info' and created_at > now() - interval '7 days'),
    'mrr_cents', (
      select coalesce(sum(case s.billing_interval when 'year' then p.price_yearly_cents / 12 else p.price_monthly_cents end), 0)
      from public.subscriptions s join public.plans p on p.id = s.plan_id
      where s.status in ('active', 'trialing', 'past_due')
    )
  ) into v_totals;

  select coalesce(jsonb_agg(t order by (t ->> 'rides_30d')::integer desc, t ->> 'name'), '[]'::jsonb) into v_orgs
  from (
    select jsonb_build_object(
      'id', o.id, 'name', o.name, 'slug', o.slug, 'status', o.status, 'city', o.city, 'created_at', o.created_at,
      'plan', p.name, 'plan_code', p.code,
      'drivers', (select count(*) from public.drivers d where d.organization_id = o.id and d.status = 'active'),
      'drivers_online', (select count(*) from public.drivers d where d.organization_id = o.id and d.status = 'active' and d.presence <> 'offline'),
      'rides_today', (select count(*) from public.rides r where r.organization_id = o.id and r.pickup_at >= v_day and r.pickup_at < v_day + interval '1 day'),
      'rides_30d', (select count(*) from public.rides r where r.organization_id = o.id and r.pickup_at > now() - interval '30 days'),
      'no_driver_7d', (select count(*) from public.rides r where r.organization_id = o.id and r.status = 'NO_DRIVER_FOUND' and r.no_driver_at > now() - interval '7 days'),
      'last_ride_at', (select max(r.created_at) from public.rides r where r.organization_id = o.id),
      'subscription_status', (select s.status from public.subscriptions s where s.organization_id = o.id order by s.created_at desc limit 1)
    ) as t
    from public.organizations o
    left join public.plans p on p.id = o.plan_id
    where o.status <> 'archived'
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object('date', d.day, 'rides', coalesce(x.c, 0), 'completed', coalesce(x.done, 0)) order by d.day), '[]'::jsonb)
  into v_daily
  from generate_series(date_trunc('day', now() at time zone 'Europe/Paris') - interval '29 days',
                       date_trunc('day', now() at time zone 'Europe/Paris'), interval '1 day') as d(day)
  left join (
    select date_trunc('day', pickup_at at time zone 'Europe/Paris') as day, count(*) as c,
           count(*) filter (where status = 'COMPLETED') as done
    from public.rides where pickup_at > now() - interval '31 days'
    group by 1
  ) x on x.day = d.day;

  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'organization_id', e.organization_id, 'organization', o.name,
    'ride_id', e.ride_id, 'type', e.type, 'level', e.level, 'message', e.message, 'created_at', e.created_at) order by e.id desc), '[]'::jsonb)
  into v_errors
  from (
    select * from public.ride_events
    where level in ('warning', 'error') and created_at > now() - interval '7 days'
    order by id desc limit 50
  ) e
  join public.organizations o on o.id = e.organization_id;

  return jsonb_build_object('totals', v_totals, 'organizations', v_orgs, 'daily', v_daily, 'recent_errors', v_errors);
end;
$$;

-- Résolution publique d'un mini-site : sous-domaine de la plateforme
-- (ex. elite.rydar.app) ou domaine personnalisé vérifié.
create or replace function public.resolve_booking_host(p_host text, p_root_domain text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select o.slug
  from public.booking_sites b
  join public.organizations o on o.id = b.organization_id
  where b.enabled
    and o.status = 'active'
    and (
      (
        lower(p_host) like '%.' || lower(p_root_domain)
        and lower(b.subdomain) = lower(left(p_host, char_length(p_host) - char_length(p_root_domain) - 1))
      )
      or (b.custom_domain_verified_at is not null and lower(b.custom_domain) = lower(p_host))
    )
  limit 1;
$$;
