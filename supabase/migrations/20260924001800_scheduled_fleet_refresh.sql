-- =============================================================================
-- Courses planifiées « à tout le monde », vraiment (audit planifiées) :
--  * l'offre flotte est re-proposée toutes les 5 min jusqu'à T-lead : un
--    chauffeur créé, réactivé ou équipé d'un véhicule compatible après la
--    création de la course la reçoit aussi ;
--  * le statut suit les offres encore ouvertes (une relance sans nouveau
--    chauffeur ne repasse pas la course en « recherche ») ;
--  * la diffusion temps réel inclut dispatch_mode : le dashboard voit la
--    bascule planifiée → recherche GPS sans rechargement.
-- =============================================================================

create or replace function private.offer_to_fleet(p_ride_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  s public.organization_settings;
  v_tz text;
  v_when text;
  v_expires timestamptz;
  v_count integer := 0;
  v_pending integer := 0;
  v_first boolean;
  v_from text;
  v_to text;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.status not in ('SEARCHING_DRIVER', 'OFFERED') or r.driver_id is not null then
    return 0;
  end if;

  select * into s from public.organization_settings where organization_id = r.organization_id;
  select timezone into v_tz from public.organizations where id = r.organization_id;
  v_when := to_char(r.pickup_at at time zone coalesce(v_tz, 'Europe/Paris'), 'DD/MM HH24:MI');
  v_expires := greatest(
    r.pickup_at - make_interval(mins => coalesce(s.scheduled_dispatch_lead_minutes, 60)),
    now() + make_interval(secs => coalesce(s.offer_timeout_seconds, 30))
  );
  v_from := coalesce(private.short_address(r.pickup_address), r.pickup_address);
  v_to := coalesce(private.short_address(r.dropoff_address), r.dropoff_address);
  v_first := r.dispatch_wave = 0;

  with candidates as (
    select d.id as driver_id,
           case when l.driver_id is null then null
                else round(extensions.st_distance(l.location, r.pickup_location))::integer end as distance_m
    from public.drivers d
    left join public.driver_locations l on l.driver_id = d.id
    left join public.vehicles v on v.id = d.vehicle_id
    where d.organization_id = r.organization_id
      and d.status = 'active'
      and private.category_compatible(r.vehicle_category, v.category, s.allow_category_upgrade)
      and coalesce(v.seats, 0) >= r.passengers
      and not exists (
        select 1 from public.ride_offers o
        where o.ride_id = r.id and o.driver_id = d.id and o.status in ('pending', 'declined')
      )
  ),
  ins as (
    insert into public.ride_offers (organization_id, ride_id, driver_id, status, mode, wave, distance_m, expires_at)
    select r.organization_id, r.id, c.driver_id, 'pending', 'fleet', 1, c.distance_m, v_expires
    from candidates c
    returning id, driver_id
  ),
  notif as (
    insert into public.notifications (organization_id, driver_id, ride_id, offer_id, type, title, body, data, priority)
    select r.organization_id, i.driver_id, r.id, i.id, 'ride_offer_scheduled', 'NOUVELLE COURSE PLANIFIÉE',
           format('%s · %s → %s · %s', v_when, v_from, v_to, private.fmt_eur(r.price_cents)),
           jsonb_build_object(
             'type', 'ride_offer_scheduled', 'offer_id', i.id, 'ride_id', r.id, 'ride_type', r.type,
             'pickup', r.pickup_address, 'dropoff', r.dropoff_address, 'pickup_at', r.pickup_at,
             'price_cents', r.price_cents, 'passengers', r.passengers, 'expires_at', v_expires),
           'high'
    from ins i
    returning 1
  )
  select count(*)::integer into v_count from ins;

  select count(*) into v_pending from public.ride_offers o where o.ride_id = r.id and o.status = 'pending' and o.mode = 'fleet';

  update public.rides
     set status = case when v_pending > 0 then 'OFFERED' else 'SEARCHING_DRIVER' end::public.ride_status,
         offered_at = case when v_pending > 0 then coalesce(offered_at, now()) else offered_at end,
         dispatch_wave = 1,
         -- nouveau passage dans 5 min (nouveaux chauffeurs), au plus tard à T-lead (bascule GPS)
         next_dispatch_at = least(v_expires, now() + interval '5 minutes')
   where id = r.id;

  if v_count > 0 then
    perform private.log_event(r.organization_id, r.id, 'dispatch.fleet',
      case when v_first
           then format('Course proposée à la flotte — %s %s', v_count, private.pl(v_count, 'chauffeur notifié', 'chauffeurs notifiés'))
           else format('Course proposée à %s %s de la flotte', v_count, private.pl(v_count, 'nouveau chauffeur', 'nouveaux chauffeurs'))
      end,
      'timeline', 'success', jsonb_build_object('count', v_count, 'pending', v_pending, 'open_until', v_expires), 'system', null);
    perform pg_notify('rydar_notifications', r.id::text);
  elsif v_first then
    perform private.log_event(r.organization_id, r.id, 'dispatch.fleet_empty',
      'Aucun chauffeur compatible dans la flotte pour l''instant — nouvel essai toutes les 5 min, puis recherche GPS avant la prise en charge',
      'timeline', 'warning', jsonb_build_object('open_until', v_expires), 'system', null);
  end if;

  return v_count;
end;
$$;

create or replace function private.dispatch_tick(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ride record;
  r public.rides;
  s public.organization_settings;
  v_expired uuid[];
  v_extended integer;
  v_waves integer := 0;
  v_escalated integer := 0;
  v_refreshed integer := 0;
  v_failed integer := 0;
  v_expired_count integer := 0;
begin
  perform private.set_actor('system', null);

  for v_ride in
    select id from public.rides
    where status in ('SEARCHING_DRIVER', 'OFFERED')
      and next_dispatch_at <= now()
    order by next_dispatch_at
    limit p_limit
    for update skip locked
  loop
    select * into r from public.rides where id = v_ride.id;
    select * into s from public.organization_settings where organization_id = r.organization_id;

    if r.dispatch_mode = 'fleet' then
      -- Fenêtre flotte encore ouverte : on propose aux chauffeurs devenus éligibles
      if now() < r.pickup_at - make_interval(mins => coalesce(s.scheduled_dispatch_lead_minutes, 60)) then
        perform private.offer_to_fleet(r.id);
        v_refreshed := v_refreshed + 1;
        continue;
      end if;
      v_expired := private.close_pending_offers(r.id, 'expired', 'fleet_window_elapsed');
      update public.rides
         set dispatch_mode = 'geo', dispatch_wave = 0, dispatch_started_at = now()
       where id = r.id;
      perform private.log_event(r.organization_id, r.id, 'dispatch.escalated',
        format('Course planifiée toujours sans chauffeur à T-%s min — bascule en recherche GPS', s.scheduled_dispatch_lead_minutes),
        'timeline', 'warning', jsonb_build_object('closed_offers', cardinality(v_expired)), 'system', null);
      perform private.run_geo_wave(r.id);
      v_escalated := v_escalated + 1;
      continue;
    end if;

    if r.dispatch_started_at < now() - make_interval(secs => coalesce(s.max_search_seconds, 300)) then
      v_expired := private.close_pending_offers(r.id, 'expired', 'timeout');
      v_expired_count := v_expired_count + cardinality(v_expired);
      update public.rides
         set status = 'NO_DRIVER_FOUND', no_driver_at = now(), next_dispatch_at = null
       where id = r.id;
      perform private.log_event(r.organization_id, r.id, 'dispatch.no_driver',
        format('Aucun chauffeur trouvé — recherche arrêtée après %s min', round(coalesce(s.max_search_seconds, 300) / 60.0)),
        'timeline', 'error', jsonb_build_object('waves', r.dispatch_wave, 'last_radius_m', r.dispatch_radius_m,
          'closed_offers', cardinality(v_expired)), 'system', null);
      v_failed := v_failed + 1;
      continue;
    end if;

    -- Vague suivante : les chauffeurs déjà sollicités gardent leur offre (prolongée, sans re-sonnerie)
    update public.ride_offers
       set expires_at = now() + make_interval(secs => coalesce(s.offer_timeout_seconds, 30))
     where ride_id = r.id and status = 'pending' and mode = 'geo';
    get diagnostics v_extended = row_count;
    if v_extended > 0 then
      perform private.log_event(r.organization_id, r.id, 'dispatch.extended',
        format('%s %s sans réponse — %s', v_extended, private.pl(v_extended, 'offre toujours ouverte', 'offres toujours ouvertes'),
          case when r.dispatch_wave < cardinality(s.dispatch_radii_m) then 'on élargit le rayon' else 'recherche de nouveaux chauffeurs' end),
        'dispatch', 'info', jsonb_build_object('pending', v_extended, 'wave', r.dispatch_wave), 'system', null);
    end if;

    perform private.run_geo_wave(r.id);
    v_waves := v_waves + 1;
  end loop;

  return jsonb_build_object('waves', v_waves, 'escalated', v_escalated, 'fleet_refreshed', v_refreshed,
    'no_driver', v_failed, 'expired_offers', v_expired_count);
end;
$$;

create or replace function private.broadcast_ride()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.rides;
begin
  if current_setting('rydar.bypass_ride_rules', true) = 'on' then
    return null;
  end if;
  select * into v from public.rides where id = new.id;
  if not found then
    v := new;
  end if;

  perform realtime.send(
    jsonb_build_object(
      'op', lower(tg_op), 'id', v.id, 'number', v.number, 'status', v.status, 'type', v.type, 'source', v.source,
      'dispatch_mode', v.dispatch_mode,
      'pickup_address', v.pickup_address, 'pickup_lat', v.pickup_lat, 'pickup_lng', v.pickup_lng,
      'dropoff_address', v.dropoff_address, 'dropoff_lat', v.dropoff_lat, 'dropoff_lng', v.dropoff_lng,
      'pickup_at', v.pickup_at, 'customer_name', v.customer_name, 'passengers', v.passengers,
      'vehicle_category', v.vehicle_category, 'price_cents', v.price_cents, 'driver_id', v.driver_id,
      'dispatch_wave', v.dispatch_wave, 'dispatch_radius_m', v.dispatch_radius_m, 'next_dispatch_at', v.next_dispatch_at,
      'estimated_distance_m', v.estimated_distance_m, 'estimated_duration_s', v.estimated_duration_s,
      'route_polyline', case when tg_op = 'INSERT' or new.route_polyline is distinct from old.route_polyline then v.route_polyline end,
      'created_at', v.created_at, 'updated_at', v.updated_at),
    'ride.updated', 'org:' || v.organization_id::text, true);

  if v.driver_id is not null then
    perform realtime.send(
      jsonb_build_object('id', v.id, 'status', v.status, 'driver_id', v.driver_id, 'updated_at', v.updated_at),
      'ride.updated', 'driver:' || v.driver_id::text, true);
  end if;
  if tg_op = 'UPDATE' and old.driver_id is not null and old.driver_id is distinct from new.driver_id then
    perform realtime.send(
      jsonb_build_object('id', new.id, 'status', 'UNASSIGNED'),
      'ride.unassigned', 'driver:' || old.driver_id::text, true);
  end if;
  return null;
end;
$$;
