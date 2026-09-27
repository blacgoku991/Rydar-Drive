-- =============================================================================
-- Rydar Drive — Dispatch par vagues STRICTES, relance, chauffeurs joignables h24 (retour terrain).
--
-- Constaté : les vagues vides s'enchaînaient dans la même seconde (4, 8, 12 et 16 km à 15:50) et un
-- chauffeur EN LIGNE, téléphone verrouillé, n'était pas sollicité (« position GPS vieille de 3 min »).
-- Demandé : 4 km d'abord ; personne n'accepte dans le délai → 8 km ; puis 12 km ; puis 16 km ; toujours
-- personne → nouvelle relance à 4 km puis 8 km ; ensuite le dispatch est prévenu que personne n'a pris.
--
--  * Une vague par délai (offer_timeout_seconds), même vide : plus de cascade instantanée. Une vague se
--    termine plus tôt seulement si tous les chauffeurs sollicités ont refusé (inchangé).
--  * Relance : organization_settings.dispatch_retry_radii_m (défaut : les deux premiers rayons, 4 → 8 km).
--    Les chauffeurs restés sans réponse sont re-sollicités (« COURSE TOUJOURS DISPONIBLE ») ; un refus,
--    un retrait par la centrale ou une offre encore ouverte ne sont jamais re-sonnés.
--  * Fin de la séquence sans acceptation : NO_DRIVER_FOUND + alerte du dispatch (dispatch.no_driver) +
--    explication (chauffeurs en ligne et raison). max_search_seconds n'est plus utilisé par le dispatch GPS.
--  * Chauffeur EN LIGNE = sollicité : sa dernière position reste utilisée tant qu'il est en ligne (au moins
--    30 min ; location_max_age_seconds ne fait plus que qualifier une position de « récente »). L'offre
--    part par push, elle sonne même application fermée ou téléphone verrouillé.
--  * Position qui n'arrive plus depuis 5 min : push « POSITION NON REÇUE » au chauffeur (une fois par
--    coupure, private.watch_driver_gps, worker toutes les minutes) ; après 30 min sans position, passage
--    hors ligne automatique (housekeeping) ET push « VOUS ÊTES HORS LIGNE » (avant : 15 min, sans prévenir).
-- =============================================================================

-- ----------------------------------------------------------------- réglage : rayons de la relance
alter table public.organization_settings
  add column if not exists dispatch_retry_radii_m integer[] not null default '{4000,8000}';

-- Organisations existantes : relance sur leurs deux premiers rayons (4 → 8 km avec les rayons par défaut)
update public.organization_settings
   set dispatch_retry_radii_m = dispatch_radii_m[1:2]
 where cardinality(dispatch_radii_m) >= 1;

alter table public.organization_settings
  add constraint organization_settings_retry_radii_check check (
    cardinality(dispatch_retry_radii_m) <= 4
    and 500 <= all (dispatch_retry_radii_m)
    and 100000 >= all (dispatch_retry_radii_m)
    and private.is_strictly_increasing(dispatch_retry_radii_m)
  );

grant update (dispatch_retry_radii_m) on public.organization_settings to authenticated;

-- Coupure de position déjà signalée au chauffeur (une seule alerte par coupure)
alter table public.drivers add column if not exists gps_lost_notified_at timestamptz;

-- ----------------------------------------------------------------- séquence et fenêtre de position
-- Rayons successifs : premier passage puis relance. Réglages absents : 4 → 8 → 12 → 16 km, relance 4 → 8 km.
create or replace function private.dispatch_plan(p_radii integer[], p_retry integer[])
returns integer[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(nullif(p_radii, '{}'), '{4000,8000,12000,16000}'::integer[])
      || coalesce(p_retry, (coalesce(nullif(p_radii, '{}'), '{4000,8000,12000,16000}'::integer[]))[1:2]);
$$;

-- Nombre de vagues du premier passage
create or replace function private.dispatch_first_pass(p_radii integer[])
returns integer
language sql
immutable
set search_path = ''
as $$
  select cardinality(coalesce(nullif(p_radii, '{}'), '{4000,8000,12000,16000}'::integer[]));
$$;

-- Ancienneté maximale de la dernière position d'un chauffeur EN LIGNE pour être sollicité (et au-delà de
-- laquelle il passe hors ligne) : 30 min, ou plus si l'organisation a réglé une « position récente » plus longue.
create or replace function private.dispatch_location_window(p_max_age_seconds integer)
returns interval
language sql
immutable
set search_path = ''
as $$
  select make_interval(secs => greatest(coalesce(p_max_age_seconds, 180), 1800));
$$;

-- ----------------------------------------------------------------- une vague GPS (une seule par appel)
-- Dernière définition : 20260924002600 (règles de la centrale, conservées).
create or replace function private.run_geo_wave(p_ride_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  s public.organization_settings;
  v_plan integer[];
  v_n integer;
  v_wave integer;
  v_radius integer;
  v_relance boolean;
  v_online integer;
  v_eligible integer;
  v_blocked integer := 0;
  v_count integer := 0;
  v_pending integer := 0;
  v_drivers uuid[] := '{}';
  v_timeout interval;
  v_window interval;
  v_max_accuracy constant real := 1500;
  v_from text;
  v_to text;
  v_centrale boolean;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.status not in ('SEARCHING_DRIVER', 'OFFERED') or r.driver_id is not null then
    return 0;
  end if;

  select * into s from public.organization_settings where organization_id = r.organization_id;
  select coalesce(o.dispatch_model = 'centrale', false) into v_centrale from public.organizations o where o.id = r.organization_id;
  v_plan := private.dispatch_plan(s.dispatch_radii_m, s.dispatch_retry_radii_m);
  v_n := private.dispatch_first_pass(s.dispatch_radii_m);
  v_wave := r.dispatch_wave + 1;
  -- Séquence terminée : private.dispatch_tick conclut (NO_DRIVER_FOUND)
  if v_wave > cardinality(v_plan) then
    return 0;
  end if;
  v_radius := v_plan[v_wave];
  v_relance := v_wave > v_n;
  v_timeout := make_interval(secs => coalesce(s.offer_timeout_seconds, 30));
  v_window := private.dispatch_location_window(s.location_max_age_seconds);
  v_from := coalesce(private.short_address(r.pickup_address), r.pickup_address);
  v_to := coalesce(private.short_address(r.dropoff_address), r.dropoff_address);

  -- Journalisé une fois par recherche
  if v_wave = 1 then
    select count(*) into v_online
    from public.drivers d
    join public.driver_locations l on l.driver_id = d.id
    where d.organization_id = r.organization_id
      and d.status = 'active'
      and d.presence <> 'offline'
      and l.updated_at > now() - v_window;
    perform private.log_event(r.organization_id, r.id, 'dispatch.online',
      format('%s %s en ligne', v_online, private.pl(v_online, 'chauffeur', 'chauffeurs')),
      'timeline', 'info', jsonb_build_object('online', v_online), 'system', null);
  end if;

  perform private.log_event(r.organization_id, r.id, 'dispatch.search',
    case when v_relance
         then format('Relance — rayon %s (vague %s)', private.fmt_km(v_radius), v_wave)
         else format('Recherche GPS — rayon %s (vague %s)', private.fmt_km(v_radius), v_wave) end,
    'timeline', 'info', jsonb_build_object('wave', v_wave, 'radius_m', v_radius, 'relance', v_relance), 'system', null);

  select count(*) filter (where (case when v_centrale then private.centrale_blocker(d.id, d.trust_level, r.price_cents,
                            s.block_unpaid, s.settlement_credit_limit_cents, s.new_driver_max_price_cents) end) is null),
         count(*) filter (where (case when v_centrale then private.centrale_blocker(d.id, d.trust_level, r.price_cents,
                            s.block_unpaid, s.settlement_credit_limit_cents, s.new_driver_max_price_cents) end) is not null)
    into v_eligible, v_blocked
  from public.drivers d
  join public.driver_locations l on l.driver_id = d.id
  left join public.vehicles v on v.id = d.vehicle_id
  where d.organization_id = r.organization_id
    and d.status = 'active'
    and d.presence = 'available'
    and l.updated_at > now() - v_window
    and coalesce(l.accuracy_m, 0) <= v_max_accuracy
    and private.category_compatible(r.vehicle_category, v.category, s.allow_category_upgrade)
    and coalesce(v.seats, 0) >= r.passengers;

  perform private.log_event(r.organization_id, r.id, 'dispatch.eligible',
    format('%s %s', v_eligible, private.pl(v_eligible, 'chauffeur disponible et compatible', 'chauffeurs disponibles et compatibles'))
      || case when v_blocked > 0
              then format(' · %s %s par les règles de la centrale', v_blocked, private.pl(v_blocked, 'exclu', 'exclus'))
              else '' end,
    'dispatch', 'debug',
    jsonb_build_object('eligible', v_eligible, 'blocked', v_blocked, 'category', r.vehicle_category,
      'passengers', r.passengers, 'upgrade', s.allow_category_upgrade, 'location_window_s', extract(epoch from v_window)::integer),
    'system', null);

  with candidates as (
    select d.id as driver_id,
           round(extensions.st_distance(l.location, r.pickup_location))::integer as distance_m,
           -- déjà sollicité pendant cette recherche : la relance le lui re-propose
           exists (select 1 from public.ride_offers p
                    where p.ride_id = r.id and p.driver_id = d.id and p.sent_at >= r.dispatch_started_at) as again
    from public.drivers d
    join public.driver_locations l on l.driver_id = d.id
    left join public.vehicles v on v.id = d.vehicle_id
    where d.organization_id = r.organization_id
      and d.status = 'active'
      and d.presence = 'available'
      -- dernière position connue, tant que le chauffeur est en ligne (application fermée, téléphone verrouillé)
      and l.updated_at > now() - v_window
      and coalesce(l.accuracy_m, 0) <= v_max_accuracy
      and extensions.st_dwithin(l.location, r.pickup_location, v_radius)
      and private.category_compatible(r.vehicle_category, v.category, s.allow_category_upgrade)
      and coalesce(v.seats, 0) >= r.passengers
      -- mode centrale : commission en retard, plafond d'encours, prix au-dessus du plafond « nouveau »
      and (case when v_centrale then private.centrale_blocker(d.id, d.trust_level, r.price_cents,
             s.block_unpaid, s.settlement_credit_limit_cents, s.new_driver_max_price_cents) end) is null
      and not exists (
        select 1 from public.ride_offers o
        where o.ride_id = r.id
          and o.driver_id = d.id
          and (
            o.status in ('pending', 'declined')
            -- retiré par la centrale (reassign_ride) : plus jamais sollicité pour cette course
            or o.closed_reason = 'removed_by_dispatch'
            -- premier passage : une seule sonnerie par chauffeur (hors offre expirée pour une autre raison
            -- qu'une absence de réponse, ex. repassé en ligne) ; la relance re-sonne les offres sans réponse
            or (not v_relance and o.sent_at >= r.dispatch_started_at and (o.status <> 'expired' or o.closed_reason = 'ignored'))
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
    select r.organization_id, i.driver_id, r.id, i.id, 'ride_offer',
           case when c.again then 'COURSE TOUJOURS DISPONIBLE' else 'NOUVELLE COURSE' end,
           case when v_centrale and r.driver_payout_cents is not null
                then format('%s → %s · %s du client · Vous gagnez %s (course %s)', v_from, v_to,
                       private.fmt_km(i.distance_m), private.fmt_eur(r.driver_payout_cents), private.fmt_eur(r.price_cents))
                else format('%s → %s · %s du client · %s', v_from, v_to, private.fmt_km(i.distance_m),
                       private.fmt_eur(r.price_cents))
           end,
           jsonb_build_object(
             'type', 'ride_offer', 'offer_id', i.id, 'ride_id', r.id, 'ride_type', r.type,
             'pickup', r.pickup_address, 'dropoff', r.dropoff_address, 'price_cents', r.price_cents,
             'distance_m', i.distance_m, 'passengers', r.passengers, 'expires_at', now() + v_timeout,
             'driver_payout_cents', r.driver_payout_cents, 'commission_cents', r.commission_cents,
             'platform_fee_cents', r.platform_fee_cents),
           'high'
    from ins i
    join candidates c on c.driver_id = i.driver_id
    returning 1
  )
  select count(*)::integer, coalesce(array_agg(i.driver_id), '{}') into v_count, v_drivers from ins i;

  select count(*) into v_pending from public.ride_offers o where o.ride_id = r.id and o.status = 'pending' and o.mode = 'geo';

  perform private.log_event(r.organization_id, r.id, 'dispatch.candidates',
    case when v_pending > v_count
         then format('%s %s à moins de %s, dont %s %s', v_pending,
                private.pl(v_pending, 'chauffeur sollicité', 'chauffeurs sollicités'), private.fmt_km(v_radius),
                v_count, private.pl(v_count, 'nouveau', 'nouveaux'))
         else format('%s %s à moins de %s', v_count, private.pl(v_count, 'chauffeur', 'chauffeurs'), private.fmt_km(v_radius))
    end,
    'timeline', case when v_count > 0 or v_pending > 0 then 'info' else 'warning' end::public.event_level,
    jsonb_build_object('candidates', v_count, 'pending', v_pending, 'radius_m', v_radius, 'wave', v_wave,
      'relance', v_relance, 'driver_ids', to_jsonb(v_drivers)),
    'system', null);

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
      'timeline', 'success', jsonb_build_object('count', v_count, 'expires_in_s', coalesce(s.offer_timeout_seconds, 30)), 'system', null);
    perform pg_notify('rydar_notifications', r.id::text);
  end if;

  -- La vague dure son délai complet, même sans chauffeur (la suivante n'est pas lancée tout de suite)
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

-- ----------------------------------------------------------------- tick : vague suivante ou fin
-- Dernière définition : 20260924002000. Partie flotte (planifiées) inchangée.
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
  v_plan integer[];
  v_n integer;
  v_expired uuid[];
  v_extended integer;
  v_waves integer := 0;
  v_escalated integer := 0;
  v_refreshed integer := 0;
  v_failed integer := 0;
  v_expired_count integer := 0;
  v_next integer;
  v_path text;
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
        format('Course planifiée toujours sans chauffeur à T-%s min — bascule en recherche GPS', coalesce(s.scheduled_dispatch_lead_minutes, 60)),
        'timeline', 'warning', jsonb_build_object('closed_offers', cardinality(v_expired)), 'system', null);
      perform private.run_geo_wave(r.id);
      v_escalated := v_escalated + 1;
      continue;
    end if;

    v_plan := private.dispatch_plan(s.dispatch_radii_m, s.dispatch_retry_radii_m);
    v_n := private.dispatch_first_pass(s.dispatch_radii_m);

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

    -- Dernière vague écoulée (relance comprise) : personne n'a pris la course, le dispatch est prévenu
    if r.dispatch_wave >= cardinality(v_plan) then
      v_expired := private.close_pending_offers(r.id, 'expired', 'timeout');
      v_expired_count := v_expired_count + cardinality(v_expired);
      update public.rides
         set status = 'NO_DRIVER_FOUND', no_driver_at = now(), next_dispatch_at = null
       where id = r.id;
      select string_agg(private.fmt_km(x), ' → ' order by i) into v_path
        from unnest(v_plan[1:v_n]) with ordinality as t(x, i);
      if cardinality(v_plan) > v_n then
        v_path := v_path || ', relance ' || (select string_agg(private.fmt_km(x), ' → ' order by i)
                                               from unnest(v_plan[v_n + 1:]) with ordinality as t(x, i));
      end if;
      perform private.log_event(r.organization_id, r.id, 'dispatch.no_driver',
        format('Personne n''a accepté la course (%s) — attribuez-la ou relancez', v_path),
        'timeline', 'error', jsonb_build_object('waves', r.dispatch_wave, 'last_radius_m', r.dispatch_radius_m,
          'closed_offers', cardinality(v_expired)), 'system', null);
      v_failed := v_failed + 1;
      continue;
    end if;

    -- Offres restées sans réponse pendant deux délais : fermées (le chauffeur redevient disponible
    -- pour d'autres courses) ; la relance les re-propose
    with ignored as (
      update public.ride_offers o
         set status = 'expired', closed_reason = 'ignored', responded_at = coalesce(o.responded_at, now())
       where o.ride_id = r.id and o.status = 'pending' and o.mode = 'geo'
         and o.sent_at < now() - make_interval(secs => 2 * coalesce(s.offer_timeout_seconds, 30))
      returning o.driver_id
    )
    select coalesce(array_agg(driver_id), '{}') into v_expired from ignored;
    perform private.release_offered_drivers(v_expired);

    -- Les chauffeurs déjà sollicités gardent leur offre une vague de plus (prolongée, sans re-sonnerie)
    update public.ride_offers
       set expires_at = now() + make_interval(secs => coalesce(s.offer_timeout_seconds, 30))
     where ride_id = r.id and status = 'pending' and mode = 'geo';
    get diagnostics v_extended = row_count;
    if v_extended > 0 then
      perform private.log_event(r.organization_id, r.id, 'dispatch.extended',
        format('%s %s sans réponse — %s', v_extended, private.pl(v_extended, 'offre toujours ouverte', 'offres toujours ouvertes'),
          'prolongée' || case when v_extended > 1 then 's' else '' end || ' sans nouvelle sonnerie'),
        'dispatch', 'info', jsonb_build_object('pending', v_extended, 'wave', r.dispatch_wave), 'system', null);
    end if;

    if r.dispatch_wave >= 1 then
      v_next := v_plan[r.dispatch_wave + 1];
      if r.dispatch_wave = v_n then
        if exists (select 1 from public.ride_offers o where o.ride_id = r.id and o.sent_at >= r.dispatch_started_at) then
          perform private.log_event(r.organization_id, r.id, 'dispatch.next',
            format('Personne n''a accepté jusqu''à %s — relance à %s', private.fmt_km(r.dispatch_radius_m), private.fmt_km(v_next)),
            'timeline', 'warning', jsonb_build_object('wave', r.dispatch_wave + 1, 'radius_m', v_next, 'relance', true), 'system', null);
        else
          -- Personne n'a même été sollicité : l'explication (chauffeurs en ligne et raison) suit (déclencheur)
          perform private.log_event(r.organization_id, r.id, 'dispatch.retry',
            format('Aucun chauffeur disponible jusqu''à %s — relance à %s', private.fmt_km(r.dispatch_radius_m), private.fmt_km(v_next)),
            'timeline', 'warning', jsonb_build_object('radius_m', r.dispatch_radius_m, 'wave', r.dispatch_wave + 1, 'relance', true), 'system', null);
        end if;
      else
        perform private.log_event(r.organization_id, r.id, 'dispatch.next',
          format('Personne n''a accepté — rayon élargi à %s', private.fmt_km(v_next)),
          'timeline', 'info', jsonb_build_object('wave', r.dispatch_wave + 1, 'radius_m', v_next, 'relance', r.dispatch_wave > v_n), 'system', null);
      end if;
    end if;

    perform private.run_geo_wave(r.id);
    v_waves := v_waves + 1;
  end loop;

  return jsonb_build_object('waves', v_waves, 'escalated', v_escalated, 'fleet_refreshed', v_refreshed,
    'no_driver', v_failed, 'expired_offers', v_expired_count);
end;
$$;

-- ----------------------------------------------------------------- explication (fin de recherche)
-- Dernière définition : 20260924002900. Fenêtre de position « en ligne », offres sans réponse de la
-- recherche en cours (ignorées ou closes à la fin), déclenchée aussi par dispatch.no_driver.
create or replace function private.explain_no_driver(p_ride_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  s public.organization_settings;
  v_centrale boolean;
  v_window interval;
  v_max_radius integer;
  v_items jsonb;
  v_counts jsonb;
  v_total integer;
  v_shown text;
begin
  select * into r from public.rides where id = p_ride_id;
  if not found or r.driver_id is not null then
    return;
  end if;
  select * into s from public.organization_settings where organization_id = r.organization_id;
  select coalesce(o.dispatch_model = 'centrale', false) into v_centrale from public.organizations o where o.id = r.organization_id;
  v_window := private.dispatch_location_window(s.location_max_age_seconds);
  select max(x) into v_max_radius from unnest(private.dispatch_plan(s.dispatch_radii_m, s.dispatch_retry_radii_m)) x;

  with online as (
    select d.id, d.first_name, d.last_name, d.presence, d.vehicle_id, v.category, v.seats, l.updated_at, l.accuracy_m,
           case when l.driver_id is not null and r.pickup_location is not null
                then round(extensions.st_distance(l.location, r.pickup_location))::integer end as distance_m,
           (select case when o.status = 'declined' then 'declined'
                        when o.closed_reason = 'removed_by_dispatch' then 'removed'
                        else 'ignored' end
              from public.ride_offers o
             where o.ride_id = r.id and o.driver_id = d.id
               and (o.status = 'declined' or o.closed_reason = 'removed_by_dispatch'
                    or (o.closed_reason in ('ignored', 'timeout') and o.sent_at >= r.dispatch_started_at))
             order by o.sent_at desc limit 1) as offer_state,
           case when v_centrale then private.centrale_blocker(d.id, d.trust_level, r.price_cents, s.block_unpaid,
                  s.settlement_credit_limit_cents, s.new_driver_max_price_cents) end as blocker
    from public.drivers d
    left join public.driver_locations l on l.driver_id = d.id
    left join public.vehicles v on v.id = d.vehicle_id
    where d.organization_id = r.organization_id
      and d.status = 'active'
      and d.presence <> 'offline'
  ),
  classified as (
    select o.*,
      case
        when o.offer_state is not null then o.offer_state
        when o.presence <> 'available' then 'busy'
        when o.vehicle_id is null then 'no_vehicle'
        when not private.category_compatible(r.vehicle_category, o.category, s.allow_category_upgrade) then 'category'
        when coalesce(o.seats, 0) < r.passengers then 'seats'
        when o.updated_at is null or o.updated_at <= now() - v_window then 'stale'
        when coalesce(o.accuracy_m, 0) > 1500 then 'accuracy'
        when o.blocker is not null then 'blocked'
        when o.distance_m > v_max_radius then 'far'
      end as reason
    from online o
  ),
  explained as (
    select c.*,
      format('%s %s.', c.first_name, left(coalesce(c.last_name, ''), 1)) as name,
      case c.reason
        when 'busy' then case c.presence when 'offered' then 'offre en cours pour une autre course' else 'déjà en course' end
        when 'declined' then 'a refusé cette course'
        when 'removed' then 'retiré de cette course par la centrale'
        when 'ignored' then 'n''a pas répondu à l''offre'
        when 'no_vehicle' then 'aucun véhicule associé'
        when 'category' then format('véhicule %s, course %s', coalesce(private.category_label(c.category), '—'),
                                    private.category_label(r.vehicle_category))
        when 'seats' then format('%s places, %s passagers', coalesce(c.seats, 0), r.passengers)
        when 'stale' then case when c.updated_at is null then 'aucune position GPS reçue'
                               when c.updated_at > now() - interval '90 minutes'
                                 then format('aucune position reçue depuis %s min (application fermée ?)', greatest(1, round(extract(epoch from now() - c.updated_at) / 60)))
                               else format('aucune position reçue depuis %s h', round(extract(epoch from now() - c.updated_at) / 3600)) end
        when 'accuracy' then format('position GPS imprécise (± %s m)', round(c.accuracy_m))
        when 'blocked' then case c.blocker when 'unpaid' then 'commission en retard'
                                           when 'credit_limit' then 'plafond de commissions atteint'
                                           else 'course réservée aux chauffeurs confirmés' end
        when 'far' then format('à %s, au-delà du rayon de %s', private.fmt_km((round(c.distance_m / 100.0) * 100)::integer), private.fmt_km(v_max_radius))
      end as label
    from classified c
    where c.reason is not null
  )
  select
    coalesce(jsonb_agg(jsonb_build_object('driver_id', e.id, 'name', e.name, 'reason', e.reason, 'label', e.label,
                                          'distance_m', e.distance_m)
                       order by e.distance_m nulls last, e.name), '[]'::jsonb),
    count(*)::integer
  into v_items, v_total
  from explained e;

  if v_total = 0 then
    return;
  end if;

  select jsonb_object_agg(k, n) into v_counts
  from (select x->>'reason' as k, count(*) as n from jsonb_array_elements(v_items) x group by 1) t;

  -- Les 3 plus proches : « Mohamed M. (320 m) : véhicule Berline, course Business » (distances arrondies à 10 m)
  select string_agg(
           format('%s%s : %s', x->>'name',
                  case when x->>'distance_m' is not null then format(' (%s)', private.fmt_km((round((x->>'distance_m')::numeric / 10) * 10)::integer)) else '' end,
                  x->>'label'),
           ' · ' order by ord)
    into v_shown
  from jsonb_array_elements(v_items) with ordinality as t(x, ord)
  where ord <= 3;

  perform private.log_event(r.organization_id, r.id, 'dispatch.excluded',
    format('%s %s en ligne %s pas pris la course — %s%s', v_total, private.pl(v_total, 'chauffeur', 'chauffeurs'),
           private.pl(v_total, 'n''a', 'n''ont'), v_shown,
           case when v_total > 3 then format(' · et %s autre%s', v_total - 3, case when v_total - 3 > 1 then 's' else '' end) else '' end),
    'timeline', 'warning', jsonb_build_object('excluded', v_items, 'counts', v_counts), 'system', null);
end;
$$;

drop trigger if exists ride_events_explain_retry on public.ride_events;
create trigger ride_events_explain_retry
  after insert on public.ride_events
  for each row
  when (new.type in ('dispatch.retry', 'dispatch.no_driver') and new.ride_id is not null)
  execute function private.ride_events_explain_retry();

-- ----------------------------------------------------------------- coupure de position : prévenir le chauffeur
-- Appelée par le worker toutes les minutes. Chauffeur en ligne dont la position n'arrive plus depuis 5 min
-- (application fermée par le système, batterie « optimisée »…) : un push, une fois par coupure.
create or replace function private.watch_driver_gps()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  x record;
  v_warned integer := 0;
begin
  for x in
    select d.id, d.organization_id
    from public.drivers d
    left join public.driver_locations l on l.driver_id = d.id
    where d.status = 'active'
      and d.presence <> 'offline'
      -- dernière activité : dernier point reçu, ou passage en ligne s'il est plus récent
      and greatest(l.updated_at, d.online_since) < now() - interval '5 minutes'
      and (d.gps_lost_notified_at is null or d.gps_lost_notified_at < greatest(l.updated_at, d.online_since))
    order by d.id
    for update of d skip locked
  loop
    update public.drivers set gps_lost_notified_at = now() where id = x.id;
    perform private.queue_notification(x.organization_id, x.id, null, null, 'gps_lost', 'POSITION NON REÇUE',
      'Rydar Drive ne reçoit plus votre position. Ouvrez l''application pour continuer à recevoir les courses.',
      jsonb_build_object('type', 'gps_lost'), 'high', null);
    v_warned := v_warned + 1;
  end loop;
  return jsonb_build_object('gps_lost', v_warned);
end;
$$;

-- ----------------------------------------------------------------- ménage : hors ligne après 30 min, prévenu
-- Dernière définition : 20260924002300 (purges inchangées).
create or replace function private.housekeeping()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ghosts integer := 0;
  v_history integer;
  v_logs integer;
  v_docs integer;
  v_notifs integer;
  v_chat integer;
  g record;
begin
  -- Chauffeurs « fantômes » : disponibles mais sans position depuis la fenêtre « en ligne » (30 min par
  -- défaut ; téléphone éteint, application fermée) → hors ligne, et le chauffeur est prévenu
  for g in
    with ghosts as (
      select d.id, d.organization_id
      from public.drivers d
      left join public.organization_settings s on s.organization_id = d.organization_id
      where d.presence = 'available'
        and coalesce(d.online_since, '-infinity') < now() - private.dispatch_location_window(s.location_max_age_seconds)
        and not exists (
          select 1 from public.driver_locations l
          where l.driver_id = d.id
            and l.updated_at > now() - private.dispatch_location_window(s.location_max_age_seconds)
        )
      order by d.id
      for update of d skip locked
    )
    update public.drivers d
       set presence = 'offline', online_since = null, gps_lost_notified_at = null
      from ghosts
     where d.id = ghosts.id
    returning d.id, d.organization_id
  loop
    perform private.queue_notification(g.organization_id, g.id, null, null, 'driver_offline', 'VOUS ÊTES HORS LIGNE',
      'Aucune position reçue depuis 30 min. Ouvrez Rydar Drive et repassez en ligne pour recevoir des courses.',
      jsonb_build_object('type', 'driver_offline'), 'high', null);
    v_ghosts := v_ghosts + 1;
  end loop;

  delete from public.driver_location_history where recorded_at < now() - interval '30 days';
  get diagnostics v_history = row_count;
  delete from public.api_logs where created_at < now() - interval '90 days';
  get diagnostics v_logs = row_count;
  -- Échéance au jour LOCAL de l'organisation (comme private.document_reminders), pas au jour UTC du serveur
  update public.driver_documents x
     set status = 'expired'
    from public.organizations o
   where o.id = x.organization_id
     and x.status = 'valid'
     and x.expires_at < (now() at time zone coalesce(o.timezone, 'Europe/Paris'))::date;
  get diagnostics v_docs = row_count;
  delete from public.notifications where created_at < now() - interval '90 days' and status in ('sent', 'cancelled');
  get diagnostics v_notifs = row_count;
  delete from public.chat_messages where created_at < now() - interval '180 days';
  get diagnostics v_chat = row_count;

  return jsonb_build_object('ghost_drivers', v_ghosts, 'history_purged', v_history, 'api_logs_purged', v_logs,
    'documents_expired', v_docs, 'notifications_purged', v_notifs, 'chat_purged', v_chat);
end;
$$;

-- Droits d'exécution (deny-by-default, cf. 20260924000900)
revoke execute on function
  private.dispatch_plan(integer[], integer[]),
  private.dispatch_first_pass(integer[]),
  private.dispatch_location_window(integer),
  private.watch_driver_gps()
from public, anon, authenticated;
grant execute on function
  private.dispatch_plan(integer[], integer[]),
  private.dispatch_first_pass(integer[]),
  private.dispatch_location_window(integer),
  private.watch_driver_gps()
to service_role;
