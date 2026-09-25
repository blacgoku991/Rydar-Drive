-- =============================================================================
-- Offres sans réponse : prolongées une fois (quand le rayon s'élargit), puis
-- fermées après deux délais (« ignorée »). Le chauffeur redevient disponible pour
-- d'autres courses et n'est plus re-sollicité pour celle-ci pendant la recherche.
-- (Revue app chauffeur : sonnerie et blocage « offered » pendant toute la recherche.)
-- =============================================================================

create or replace function private.run_geo_wave(p_ride_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  s public.organization_settings;
  v_radii integer[];
  v_n integer;
  v_wave integer;
  v_radius integer;
  v_online integer;
  v_eligible integer;
  v_count integer := 0;
  v_pending integer := 0;
  v_drivers uuid[] := '{}';
  v_timeout interval;
  v_max_age interval;
  v_max_accuracy constant real := 1500;
  v_from text;
  v_to text;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.status not in ('SEARCHING_DRIVER', 'OFFERED') or r.driver_id is not null then
    return 0;
  end if;

  select * into s from public.organization_settings where organization_id = r.organization_id;
  v_radii := coalesce(s.dispatch_radii_m, '{4000,8000,12000,16000}');
  v_n := greatest(1, coalesce(cardinality(v_radii), 1));
  v_timeout := make_interval(secs => coalesce(s.offer_timeout_seconds, 30));
  v_max_age := make_interval(secs => coalesce(s.location_max_age_seconds, 180));
  v_from := coalesce(private.short_address(r.pickup_address), r.pickup_address);
  v_to := coalesce(private.short_address(r.dropoff_address), r.dropoff_address);
  v_wave := r.dispatch_wave;

  select count(*) into v_online
  from public.drivers d
  join public.driver_locations l on l.driver_id = d.id
  where d.organization_id = r.organization_id
    and d.status = 'active'
    and d.presence <> 'offline'
    and l.updated_at > now() - v_max_age;

  -- Journalisé une fois par recherche (pas à chaque relance après la dernière vague)
  if v_wave < v_n then
    perform private.log_event(r.organization_id, r.id, 'dispatch.online',
      format('%s %s en ligne', v_online, private.pl(v_online, 'chauffeur', 'chauffeurs')),
      'timeline', 'info', jsonb_build_object('online', v_online), 'system', null);
  end if;

  loop
    v_wave := v_wave + 1;
    v_radius := v_radii[least(v_wave, v_n)];

    if v_wave <= v_n then
      perform private.log_event(r.organization_id, r.id, 'dispatch.search',
        format('Recherche GPS — rayon %s (vague %s)', private.fmt_km(v_radius), v_wave),
        'timeline', 'info', jsonb_build_object('wave', v_wave, 'radius_m', v_radius), 'system', null);

      select count(*) into v_eligible
      from public.drivers d
      join public.driver_locations l on l.driver_id = d.id
      left join public.vehicles v on v.id = d.vehicle_id
      where d.organization_id = r.organization_id
        and d.status = 'active'
        and d.presence = 'available'
        and l.updated_at > now() - v_max_age
        and coalesce(l.accuracy_m, 0) <= v_max_accuracy
        and private.category_compatible(r.vehicle_category, v.category, s.allow_category_upgrade)
        and coalesce(v.seats, 0) >= r.passengers;

      perform private.log_event(r.organization_id, r.id, 'dispatch.eligible',
        format('%s %s', v_eligible, private.pl(v_eligible, 'chauffeur disponible et compatible', 'chauffeurs disponibles et compatibles')),
        'dispatch', 'debug',
        jsonb_build_object('eligible', v_eligible, 'category', r.vehicle_category, 'passengers', r.passengers,
          'upgrade', s.allow_category_upgrade, 'max_location_age_s', s.location_max_age_seconds),
        'system', null);
    end if;

    with candidates as (
      select d.id as driver_id,
             round(extensions.st_distance(l.location, r.pickup_location))::integer as distance_m
      from public.drivers d
      join public.driver_locations l on l.driver_id = d.id
      left join public.vehicles v on v.id = d.vehicle_id
      where d.organization_id = r.organization_id
        and d.status = 'active'
        and d.presence = 'available'
        and l.updated_at > now() - v_max_age
        and coalesce(l.accuracy_m, 0) <= v_max_accuracy
        and extensions.st_dwithin(l.location, r.pickup_location, v_radius)
        and private.category_compatible(r.vehicle_category, v.category, s.allow_category_upgrade)
        and coalesce(v.seats, 0) >= r.passengers
        and not exists (
          select 1 from public.ride_offers o
          where o.ride_id = r.id
            and o.driver_id = d.id
            and (
              o.status in ('pending', 'declined')
              -- déjà sollicité pendant CETTE recherche (hors offre expirée : ex. repassé en ligne),
              -- ou offre laissée sans réponse (ignorée) pendant cette recherche
              or (o.sent_at >= r.dispatch_started_at and (o.status <> 'expired' or o.closed_reason = 'ignored'))
            )
        )
      order by distance_m
      limit coalesce(s.max_offers_per_wave, 25)
    ),
    ins as (
      insert into public.ride_offers (organization_id, ride_id, driver_id, status, mode, wave, radius_m, distance_m, expires_at)
      select r.organization_id, r.id, c.driver_id, 'pending', 'geo', v_wave, v_radius, c.distance_m, now() + v_timeout
      from candidates c
      returning id, driver_id, distance_m
    ),
    notif as (
      insert into public.notifications (organization_id, driver_id, ride_id, offer_id, type, title, body, data, priority)
      select r.organization_id, i.driver_id, r.id, i.id, 'ride_offer', 'NOUVELLE COURSE',
             format('%s → %s · %s du client · %s', v_from, v_to, private.fmt_km(i.distance_m), private.fmt_eur(r.price_cents)),
             jsonb_build_object(
               'type', 'ride_offer', 'offer_id', i.id, 'ride_id', r.id, 'ride_type', r.type,
               'pickup', r.pickup_address, 'dropoff', r.dropoff_address, 'price_cents', r.price_cents,
               'distance_m', i.distance_m, 'passengers', r.passengers, 'expires_at', now() + v_timeout),
             'high'
      from ins i
      returning 1
    )
    select count(*)::integer, coalesce(array_agg(i.driver_id), '{}') into v_count, v_drivers from ins i;

    select count(*) into v_pending from public.ride_offers o where o.ride_id = r.id and o.status = 'pending' and o.mode = 'geo';

    if v_wave <= v_n or v_count > 0 then
      perform private.log_event(r.organization_id, r.id, 'dispatch.candidates',
        case when v_pending > v_count
             then format('%s %s à moins de %s, dont %s %s', v_pending,
                    private.pl(v_pending, 'chauffeur sollicité', 'chauffeurs sollicités'), private.fmt_km(v_radius),
                    v_count, private.pl(v_count, 'nouveau', 'nouveaux'))
             else format('%s %s à moins de %s', v_count, private.pl(v_count, 'chauffeur', 'chauffeurs'), private.fmt_km(v_radius))
        end,
        'timeline', case when v_count > 0 or v_pending > 0 then 'info' else 'warning' end::public.event_level,
        jsonb_build_object('candidates', v_count, 'pending', v_pending, 'radius_m', v_radius, 'wave', v_wave, 'driver_ids', to_jsonb(v_drivers)),
        'system', null);
    end if;

    exit when v_count > 0 or v_wave >= v_n;
  end loop;

  if v_count > 0 then
    update public.drivers
       set presence = 'offered'
     where id in (
       select x.id from public.drivers x
       where x.id = any (v_drivers) and x.presence = 'available'
       order by x.id
       for update
     );

    perform private.log_event(r.organization_id, r.id, 'dispatch.notified',
      format('%s %s', v_count, private.pl(v_count, 'notification envoyée', 'notifications envoyées')),
      'timeline', 'success', jsonb_build_object('count', v_count, 'expires_in_s', s.offer_timeout_seconds), 'system', null);
    perform pg_notify('rydar_notifications', r.id::text);
  elsif v_pending = 0 and v_wave <= v_n then
    perform private.log_event(r.organization_id, r.id, 'dispatch.retry',
      format('Aucun chauffeur disponible dans un rayon de %s — nouvelle recherche dans %s s', private.fmt_km(v_radius), s.offer_timeout_seconds),
      'timeline', 'warning', jsonb_build_object('radius_m', v_radius), 'system', null);
  end if;

  update public.rides
     set dispatch_wave = v_wave,
         dispatch_radius_m = v_radius,
         status = case when v_pending > 0 then 'OFFERED' else 'SEARCHING_DRIVER' end::public.ride_status,
         offered_at = case when v_pending > 0 then coalesce(offered_at, now()) else offered_at end,
         next_dispatch_at = now() + v_timeout
   where id = r.id;

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

    -- Offres de chauffeurs devenus indisponibles (autre course, suspendus) : fermées, pas prolongées
    with gone as (
      update public.ride_offers o
         set status = 'expired', closed_reason = 'driver_unavailable', responded_at = coalesce(o.responded_at, now())
        from public.drivers d
       where o.ride_id = r.id and o.status = 'pending' and o.mode = 'geo'
         and d.id = o.driver_id
         and (d.status <> 'active' or d.presence not in ('available', 'offered'))
      returning o.driver_id
    )
    select coalesce(array_agg(driver_id), '{}') into v_expired from gone;
    perform private.release_offered_drivers(v_expired);

    -- Offres restées sans réponse pendant deux délais : fermées (le chauffeur redevient disponible
    -- pour d'autres courses) et non re-proposées pendant cette recherche
    with ignored as (
      update public.ride_offers o
         set status = 'expired', closed_reason = 'ignored', responded_at = coalesce(o.responded_at, now())
       where o.ride_id = r.id and o.status = 'pending' and o.mode = 'geo'
         and o.sent_at < now() - make_interval(secs => 2 * coalesce(s.offer_timeout_seconds, 30))
      returning o.driver_id
    )
    select coalesce(array_agg(driver_id), '{}') into v_expired from ignored;
    perform private.release_offered_drivers(v_expired);

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
