-- Statistiques d'offres : une offre prolongée sans réponse compte comme « manquée »
--
-- Depuis les vagues cumulatives (001700), une offre sans réponse n'expire plus à la fin de sa fenêtre :
-- elle est prolongée pendant l'élargissement du rayon, puis fermée « assigned_to_other » si un collègue
-- accepte. Sans marqueur, ces offres ignorées disparaissaient du taux d'acceptation (2/22 affiché 2/2).
--
-- ride_offers.missed_at : posé (déclencheur) quand une offre géo passe une fenêtre complète sans réponse
-- (prolongation par le tick, expiration « timeout » / « ignored »). Pas pour les offres flotte (proposées à
-- tous, non répondre n'est pas un manque) ni pour « driver_unavailable » (chauffeur parti sur une autre course).
-- Manquée = status in ('expired','closed') and missed_at is not null ; compte dans le dénominateur.
-- La clé JSON « expired » des statistiques garde son nom (compatibilité) et compte les offres manquées.

alter table public.ride_offers add column if not exists missed_at timestamptz;

create or replace function private.mark_offer_missed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.missed_at is null and new.mode = 'geo' and (
       (new.status = 'expired' and new.closed_reason is distinct from 'driver_unavailable')
    -- seule la vague suivante du tick prolonge une offre géo en attente : sa fenêtre est passée sans réponse
    or (new.status = 'pending' and new.expires_at > old.expires_at)
  ) then
    new.missed_at := now();
  end if;
  return new;
end;
$$;

revoke execute on function private.mark_offer_missed() from public, anon, authenticated;

drop trigger if exists ride_offers_mark_missed on public.ride_offers;
create trigger ride_offers_mark_missed
  before update of status, expires_at on public.ride_offers
  for each row
  when (old.status = 'pending')
  execute function private.mark_offer_missed();

-- Historique : les offres géo déjà expirées (hors chauffeur indisponible) étaient des manques
update public.ride_offers
   set missed_at = coalesce(responded_at, expires_at)
 where missed_at is null and mode = 'geo' and status = 'expired'
   and closed_reason is distinct from 'driver_unavailable';

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
      filter (where accepted_at is not null and dispatch_started_at is not null and type = 'instant')::numeric, 1),
    'completion_rate', case when count(*) > 0 then round(count(*) filter (where status = 'COMPLETED')::numeric / count(*), 4) end
  ) into v_summary
  from public.rides
  where organization_id = p_org and pickup_at >= p_from and pickup_at < p_to;

  select jsonb_build_object(
    'offers_sent', count(*),
    'accepted', count(*) filter (where status = 'accepted'),
    'declined', count(*) filter (where status = 'declined'),
    'expired', count(*) filter (where (status in ('expired', 'closed') and missed_at is not null)),
    'acceptance_rate', case when count(*) filter (where (status in ('accepted', 'declined') or (status in ('expired', 'closed') and missed_at is not null))) > 0
      then round(count(*) filter (where status = 'accepted')::numeric
        / count(*) filter (where (status in ('accepted', 'declined') or (status in ('expired', 'closed') and missed_at is not null))), 4) end,
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
               count(*) filter (where (status in ('accepted', 'declined') or (status in ('expired', 'closed') and missed_at is not null))) as answered,
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
    'expired', count(*) filter (where (status in ('expired', 'closed') and missed_at is not null)),
    'acceptance_rate', case when count(*) filter (where (status in ('accepted', 'declined') or (status in ('expired', 'closed') and missed_at is not null))) > 0
      then round(count(*) filter (where status = 'accepted')::numeric
        / count(*) filter (where (status in ('accepted', 'declined') or (status in ('expired', 'closed') and missed_at is not null))), 4) end,
    'avg_response_ms', round(avg(extract(epoch from (responded_at - sent_at)) * 1000) filter (where status = 'accepted'))
  ) into v_offers
  from public.ride_offers
  where driver_id = p_driver and sent_at >= v_from;

  return jsonb_build_object('days', p_days, 'rides', v_rides, 'offers', v_offers);
end;
$$;

create or replace function public.org_driver_metrics(p_org uuid, p_days integer default 30)
returns table (
  driver_id uuid,
  offers bigint,
  accepted bigint,
  declined bigint,
  expired bigint,
  acceptance_rate numeric,
  completed bigint,
  cancelled bigint,
  revenue_cents bigint,
  last_ride_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)));
begin
  perform private.assert_org_reader(p_org);
  return query
  select d.id,
         coalesce(o.offers, 0),
         coalesce(o.accepted, 0),
         coalesce(o.declined, 0),
         coalesce(o.expired, 0),
         case when coalesce(o.answered, 0) > 0 then round(o.accepted::numeric / o.answered, 4) end,
         coalesce(r.completed, 0),
         coalesce(r.cancelled, 0),
         coalesce(r.revenue, 0)::bigint,
         r.last_ride_at
  from public.drivers d
  left join (
    select x.driver_id, count(*) as offers,
           count(*) filter (where x.status = 'accepted') as accepted,
           count(*) filter (where x.status = 'declined') as declined,
           count(*) filter (where (x.status in ('expired', 'closed') and x.missed_at is not null)) as expired,
           count(*) filter (where (x.status in ('accepted', 'declined') or (x.status in ('expired', 'closed') and x.missed_at is not null))) as answered
    from public.ride_offers x
    where x.organization_id = p_org and x.sent_at >= v_from
    group by x.driver_id
  ) o on o.driver_id = d.id
  left join (
    select y.driver_id,
           count(*) filter (where y.status = 'COMPLETED') as completed,
           count(*) filter (where y.status = 'CANCELLED') as cancelled,
           sum(y.price_cents) filter (where y.status = 'COMPLETED') as revenue,
           max(y.pickup_at) as last_ride_at
    from public.rides y
    where y.organization_id = p_org and y.pickup_at >= v_from and y.driver_id is not null
    group by y.driver_id
  ) r on r.driver_id = d.id
  where d.organization_id = p_org;
end;
$$;
