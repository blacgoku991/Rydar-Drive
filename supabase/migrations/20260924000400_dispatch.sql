-- =============================================================================
-- Rydar Drive — Moteur de dispatch
--
--  INSERT rides ──► before_ride_insert (contrôle tenant, numéro, classification)
--               └─► after insert : historique + start_dispatch
--                     instant  → run_geo_wave : ST_DWithin 3 km → 5 → 8 → 12 km
--                     planifiée → offer_to_fleet : toute la flotte compatible
--  Worker ──► private.dispatch_tick() : timeout des vagues, élargissement,
--             bascule planifiée→GPS à T-lead, NO_DRIVER_FOUND
--  Chauffeur ──► accept_ride_offer : verrou ligne + compare-and-set + index
--                unique partiel => une course n'est JAMAIS attribuée deux fois.
--
-- Ordre de verrouillage (anti-deadlock) : rides → ride_offers → drivers.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Utilitaires
-- -----------------------------------------------------------------------------
create or replace function private.pl(p_n bigint, p_singular text, p_plural text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when abs(coalesce(p_n, 0)) > 1 then p_plural else p_singular end;
$$;

create or replace function private.category_compatible(
  p_requested public.vehicle_category,
  p_vehicle public.vehicle_category,
  p_allow_upgrade boolean
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    p_vehicle = p_requested
    or (coalesce(p_allow_upgrade, false) and (
         (p_requested = 'standard' and p_vehicle in ('business', 'first', 'green', 'van'))
      or (p_requested = 'business' and p_vehicle = 'first')
    )),
    false
  );
$$;

create or replace function private.log_event(
  p_org uuid,
  p_ride uuid,
  p_type text,
  p_message text,
  p_category public.event_category default 'timeline',
  p_level public.event_level default 'info',
  p_data jsonb default '{}'::jsonb,
  p_actor_type public.actor_type default null,
  p_actor_id uuid default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.ride_events (organization_id, ride_id, category, level, type, message, actor_type, actor_id, data)
  values (
    p_org, p_ride, p_category, p_level, p_type, p_message,
    coalesce(p_actor_type, private.actor_type()),
    case when p_actor_type = 'system' then null else coalesce(p_actor_id, private.actor_id()) end,
    coalesce(p_data, '{}'::jsonb)
  );
$$;

create or replace function private.queue_notification(
  p_org uuid,
  p_driver uuid,
  p_ride uuid,
  p_offer uuid,
  p_type text,
  p_title text,
  p_body text,
  p_data jsonb default '{}'::jsonb,
  p_priority text default 'high',
  p_scheduled_for timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.notifications (organization_id, driver_id, ride_id, offer_id, type, title, body, data, priority, scheduled_for)
  values (p_org, p_driver, p_ride, p_offer, p_type, p_title, p_body, coalesce(p_data, '{}'::jsonb), p_priority, coalesce(p_scheduled_for, now()))
  returning id into v_id;
  perform pg_notify('rydar_notifications', v_id::text);
  return v_id;
end;
$$;

-- Remet « disponible » les chauffeurs qui n'ont plus d'offre GPS en attente.
create or replace function private.release_offered_drivers(p_drivers uuid[])
returns void
language sql
security definer
set search_path = ''
as $$
  update public.drivers d
     set presence = 'available'
   where d.id in (
       select x.id from public.drivers x
       where x.id = any (coalesce(p_drivers, '{}'))
         and x.presence = 'offered'
       order by x.id
       for update
     )
     and not exists (
       select 1 from public.ride_offers o
       where o.driver_id = d.id and o.status = 'pending' and o.mode = 'geo'
     );
$$;

-- Ferme les offres en attente d'une course ; renvoie les chauffeurs concernés.
create or replace function private.close_pending_offers(
  p_ride_id uuid,
  p_status public.offer_status,
  p_reason text,
  p_except uuid default null
)
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drivers uuid[];
begin
  with upd as (
    update public.ride_offers
       set status = p_status,
           closed_reason = p_reason,
           responded_at = coalesce(responded_at, now())
     where ride_id = p_ride_id
       and status = 'pending'
       and (p_except is null or id <> p_except)
    returning driver_id
  )
  select coalesce(array_agg(driver_id), '{}') into v_drivers from upd;

  perform private.release_offered_drivers(v_drivers);
  return v_drivers;
end;
$$;

-- Rappels chauffeur (24 h, 3 h, 1 h, 30 min — configurables)
create or replace function private.schedule_reminders(p_ride_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  v_offsets integer[];
  v_tz text;
  v_offset integer;
  v_at timestamptz;
  v_label text;
  v_count integer := 0;
begin
  select * into r from public.rides where id = p_ride_id;
  if not found or r.driver_id is null then
    return 0;
  end if;

  select s.reminder_offsets_minutes, o.timezone into v_offsets, v_tz
  from public.organization_settings s
  join public.organizations o on o.id = s.organization_id
  where s.organization_id = r.organization_id;

  update public.notifications
     set status = 'cancelled'
   where ride_id = r.id and type = 'ride_reminder' and status = 'queued';

  foreach v_offset in array coalesce(v_offsets, '{}') loop
    v_at := r.pickup_at - make_interval(mins => v_offset);
    continue when v_at <= now();
    v_label := case when v_offset >= 60 and v_offset % 60 = 0 then (v_offset / 60)::text || ' h' else v_offset::text || ' min' end;
    insert into public.notifications (organization_id, driver_id, ride_id, type, title, body, data, priority, scheduled_for)
    values (
      r.organization_id, r.driver_id, r.id, 'ride_reminder',
      format('Rappel — course dans %s', v_label),
      format('%s · %s → %s', to_char(r.pickup_at at time zone coalesce(v_tz, 'Europe/Paris'), 'DD/MM à HH24:MI'),
        coalesce(private.short_address(r.pickup_address), r.pickup_address),
        coalesce(private.short_address(r.dropoff_address), r.dropoff_address)),
      jsonb_build_object('type', 'ride_reminder', 'ride_id', r.id, 'offset_minutes', v_offset),
      'high', v_at
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Triggers sur rides
-- -----------------------------------------------------------------------------
create or replace function private.before_ride_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org public.organizations;
  v_threshold integer;
  v_bypass boolean := current_setting('rydar.bypass_ride_rules', true) = 'on' and auth.role() is null;
begin
  select * into v_org from public.organizations where id = new.organization_id;
  if not found then
    raise exception 'ORGANIZATION_NOT_FOUND' using errcode = '23503';
  end if;

  if new.number is null or new.number = 0 then
    update public.organizations
       set ride_counter = ride_counter + 1
     where id = new.organization_id
     returning ride_counter into new.number;
  end if;

  -- Import / seed (connexion directe uniquement, jamais via l'API)
  if v_bypass then
    return new;
  end if;

  if v_org.status <> 'active' then
    raise exception 'ORGANIZATION_INACTIVE: organisation suspendue ou archivée' using errcode = '42501';
  end if;

  -- Client authentifié (dashboard) : contrôle tenant explicite + champs imposés
  if auth.role() = 'authenticated' then
    if not private.is_org_member(new.organization_id) then
      raise exception 'FORBIDDEN_TENANT: accès refusé à cette organisation' using errcode = '42501';
    end if;
    new.source := 'dashboard';
    new.created_by := auth.uid();
    new.api_key_id := null;
  end if;

  -- Champs gérés exclusivement par le moteur
  new.status := 'CREATED';
  new.driver_id := null;
  new.vehicle_id := null;
  new.dispatch_mode := null;
  new.dispatch_wave := 0;
  new.dispatch_radius_m := null;
  new.dispatch_started_at := null;
  new.next_dispatch_at := null;
  new.currency := coalesce(v_org.currency, 'EUR');

  if new.pickup_at is null then
    new.pickup_at := now();
  end if;
  if new.pickup_at < now() - interval '10 minutes' then
    raise exception 'PICKUP_IN_PAST: la date de prise en charge est déjà passée' using errcode = '22023';
  end if;
  if new.pickup_at > now() + interval '400 days' then
    raise exception 'PICKUP_TOO_FAR: date de prise en charge trop lointaine' using errcode = '22023';
  end if;
  if new.pickup_at < now() then
    new.pickup_at := now();
  end if;

  -- Détection automatique instantanée / planifiée
  select s.instant_threshold_minutes into v_threshold
  from public.organization_settings s where s.organization_id = new.organization_id;

  new.type := case
    when new.pickup_at <= now() + make_interval(mins => coalesce(v_threshold, 45)) then 'instant'
    else 'scheduled'
  end::public.ride_type;

  return new;
end;
$$;

create or replace function private.track_ride_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and current_setting('rydar.bypass_ride_rules', true) = 'on' and auth.role() is null then
    return null;
  end if;
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.ride_status_history (organization_id, ride_id, from_status, to_status, actor_type, actor_id)
    values (
      new.organization_id,
      new.id,
      case when tg_op = 'UPDATE' then old.status end,
      new.status,
      case
        when tg_op = 'INSERT' and new.source = 'api' then 'api'::public.actor_type
        when tg_op = 'INSERT' and new.source = 'booking_site' then 'booking_site'::public.actor_type
        else private.actor_type()
      end,
      private.actor_id()
    );
  end if;
  return null;
end;
$$;

create or replace function private.after_ride_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('rydar.bypass_ride_rules', true) = 'on' and auth.role() is null then
    return null;
  end if;
  perform private.start_dispatch(new.id);
  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- Démarrage du dispatch
-- -----------------------------------------------------------------------------
create or replace function private.start_dispatch(p_ride_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  s public.organization_settings;
  v_org_name text;
  v_tz text;
  v_actor public.actor_type;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found then
    return;
  end if;
  select * into s from public.organization_settings where organization_id = r.organization_id;
  select name, timezone into v_org_name, v_tz from public.organizations where id = r.organization_id;

  v_actor := case r.source when 'api' then 'api' when 'booking_site' then 'booking_site' else 'user' end::public.actor_type;

  perform private.log_event(r.organization_id, r.id, 'ride.created',
    case r.source
      when 'api' then 'Course reçue via l''API (site du rattacheur)'
      when 'booking_site' then 'Course reçue via le site de réservation'
      else 'Course créée par le rattacheur'
    end,
    'timeline', 'info', jsonb_build_object('source', r.source, 'number', r.number), v_actor, r.created_by);

  perform private.log_event(r.organization_id, r.id, 'dispatch.context',
    format('Course #%s créée — tenant : %s', r.number, v_org_name),
    'dispatch', 'debug', jsonb_build_object('organization_id', r.organization_id, 'tenant', v_org_name), 'system', null);

  perform private.log_event(r.organization_id, r.id, 'dispatch.pickup',
    format('GPS départ : %s / %s', round(r.pickup_lat::numeric, 5), round(r.pickup_lng::numeric, 5)),
    'dispatch', 'debug', jsonb_build_object('lat', r.pickup_lat, 'lng', r.pickup_lng), 'system', null);

  if not coalesce(s.auto_dispatch, true) then
    perform private.log_event(r.organization_id, r.id, 'dispatch.manual',
      'Dispatch automatique désactivé — attribution manuelle requise', 'timeline', 'warning', '{}'::jsonb, 'system', null);
    return;
  end if;

  if r.type = 'instant' then
    perform private.log_event(r.organization_id, r.id, 'ride.classified', 'Course instantanée détectée',
      'timeline', 'info', jsonb_build_object('type', 'instant', 'threshold_minutes', s.instant_threshold_minutes), 'system', null);
    update public.rides
       set status = 'SEARCHING_DRIVER', dispatch_mode = 'geo', dispatch_started_at = now(), dispatch_wave = 0
     where id = r.id;
    perform private.run_geo_wave(r.id);
  else
    perform private.log_event(r.organization_id, r.id, 'ride.classified',
      format('Course planifiée détectée — prise en charge le %s', to_char(r.pickup_at at time zone coalesce(v_tz, 'Europe/Paris'), 'DD/MM à HH24:MI')),
      'timeline', 'info', jsonb_build_object('type', 'scheduled', 'pickup_at', r.pickup_at), 'system', null);
    update public.rides
       set status = 'SEARCHING_DRIVER', dispatch_mode = 'fleet', dispatch_started_at = now(), dispatch_wave = 0
     where id = r.id;
    perform private.offer_to_fleet(r.id);
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Vague GPS (course instantanée) — PostGIS ST_DWithin
-- Enchaîne immédiatement les rayons tant qu'aucun chauffeur n'est trouvé.
-- -----------------------------------------------------------------------------
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
  v_drivers uuid[] := '{}';
  v_timeout interval;
  v_max_age interval;
  v_from text;
  v_to text;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.status not in ('SEARCHING_DRIVER', 'OFFERED') or r.driver_id is not null then
    return 0;
  end if;

  select * into s from public.organization_settings where organization_id = r.organization_id;
  v_radii := coalesce(s.dispatch_radii_m, '{3000,5000,8000,12000}');
  v_n := cardinality(v_radii);
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

  perform private.log_event(r.organization_id, r.id, 'dispatch.online',
    format('%s %s en ligne', v_online, private.pl(v_online, 'chauffeur', 'chauffeurs')),
    'timeline', 'info', jsonb_build_object('online', v_online), 'system', null);

  loop
    v_wave := v_wave + 1;
    v_radius := v_radii[least(v_wave, v_n)];

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
      and private.category_compatible(r.vehicle_category, v.category, s.allow_category_upgrade)
      and coalesce(v.seats, 0) >= r.passengers;

    perform private.log_event(r.organization_id, r.id, 'dispatch.eligible',
      format('%s %s', v_eligible, private.pl(v_eligible, 'chauffeur disponible et compatible', 'chauffeurs disponibles et compatibles')),
      'dispatch', 'debug',
      jsonb_build_object('eligible', v_eligible, 'category', r.vehicle_category, 'passengers', r.passengers,
        'upgrade', s.allow_category_upgrade, 'max_location_age_s', s.location_max_age_seconds),
      'system', null);

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
        and extensions.st_dwithin(l.location, r.pickup_location, v_radius)
        and private.category_compatible(r.vehicle_category, v.category, s.allow_category_upgrade)
        and coalesce(v.seats, 0) >= r.passengers
        and not exists (
          select 1 from public.ride_offers o
          where o.ride_id = r.id
            and o.driver_id = d.id
            and (o.status in ('pending', 'declined') or v_wave <= v_n)
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

    perform private.log_event(r.organization_id, r.id, 'dispatch.candidates',
      format('%s %s à moins de %s', v_count, private.pl(v_count, 'chauffeur', 'chauffeurs'), private.fmt_km(v_radius)),
      'timeline', case when v_count > 0 then 'info' else 'warning' end::public.event_level,
      jsonb_build_object('candidates', v_count, 'radius_m', v_radius, 'wave', v_wave, 'driver_ids', to_jsonb(v_drivers)),
      'system', null);

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
  else
    perform private.log_event(r.organization_id, r.id, 'dispatch.retry',
      format('Aucun chauffeur disponible dans un rayon de %s — nouvelle recherche dans %s s', private.fmt_km(v_radius), s.offer_timeout_seconds),
      'timeline', 'warning', jsonb_build_object('radius_m', v_radius), 'system', null);
  end if;

  update public.rides
     set dispatch_wave = v_wave,
         dispatch_radius_m = v_radius,
         status = case when v_count > 0 then 'OFFERED' else 'SEARCHING_DRIVER' end::public.ride_status,
         offered_at = case when v_count > 0 then coalesce(offered_at, now()) else offered_at end,
         next_dispatch_at = now() + v_timeout
   where id = r.id;

  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Course planifiée : proposée à toute la flotte compatible
-- -----------------------------------------------------------------------------
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
             'price_cents', r.price_cents, 'passengers', r.passengers),
           'high'
    from ins i
    returning 1
  )
  select count(*)::integer into v_count from ins;

  update public.rides
     set status = case when v_count > 0 then 'OFFERED' else 'SEARCHING_DRIVER' end::public.ride_status,
         offered_at = case when v_count > 0 then coalesce(offered_at, now()) else offered_at end,
         dispatch_wave = 1,
         next_dispatch_at = v_expires
   where id = r.id;

  if v_count > 0 then
    perform private.log_event(r.organization_id, r.id, 'dispatch.fleet',
      format('Course proposée à la flotte — %s %s', v_count, private.pl(v_count, 'chauffeur notifié', 'chauffeurs notifiés')),
      'timeline', 'success', jsonb_build_object('count', v_count, 'open_until', v_expires), 'system', null);
    perform pg_notify('rydar_notifications', r.id::text);
  else
    perform private.log_event(r.organization_id, r.id, 'dispatch.fleet_empty',
      'Aucun chauffeur compatible dans la flotte — nouvelle tentative avant la prise en charge',
      'timeline', 'warning', jsonb_build_object('open_until', v_expires), 'system', null);
  end if;

  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Tick du dispatch (appelé par apps/worker toutes les ~2 s, multi-instance safe)
-- -----------------------------------------------------------------------------
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
  v_waves integer := 0;
  v_escalated integer := 0;
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

    v_expired := private.close_pending_offers(r.id, 'expired', 'timeout');
    if cardinality(v_expired) > 0 then
      v_expired_count := v_expired_count + cardinality(v_expired);
      perform private.log_event(r.organization_id, r.id, 'dispatch.expired',
        format('%s %s sans réponse (vague %s)', cardinality(v_expired),
          private.pl(cardinality(v_expired), 'offre expirée', 'offres expirées'), r.dispatch_wave),
        'dispatch', 'info', jsonb_build_object('driver_ids', to_jsonb(v_expired), 'wave', r.dispatch_wave), 'system', null);
    end if;

    if r.dispatch_started_at < now() - make_interval(secs => coalesce(s.max_search_seconds, 300)) then
      update public.rides
         set status = 'NO_DRIVER_FOUND', no_driver_at = now(), next_dispatch_at = null
       where id = r.id;
      perform private.log_event(r.organization_id, r.id, 'dispatch.no_driver',
        format('Aucun chauffeur trouvé — recherche arrêtée après %s min', round(coalesce(s.max_search_seconds, 300) / 60.0)),
        'timeline', 'error', jsonb_build_object('waves', r.dispatch_wave, 'last_radius_m', r.dispatch_radius_m), 'system', null);
      v_failed := v_failed + 1;
    else
      perform private.run_geo_wave(r.id);
      v_waves := v_waves + 1;
    end if;
  end loop;

  return jsonb_build_object('waves', v_waves, 'escalated', v_escalated, 'no_driver', v_failed, 'expired_offers', v_expired_count);
end;
$$;

-- Ménage périodique (worker, toutes les ~5 min)
create or replace function private.housekeeping()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ghosts integer;
  v_history integer;
  v_logs integer;
  v_docs integer;
  v_notifs integer;
begin
  -- Chauffeurs « fantômes » : disponibles mais sans position depuis 15 min
  with g as (
    update public.drivers d
       set presence = 'offline', online_since = null
     where d.presence = 'available'
       and not exists (
         select 1 from public.driver_locations l
         where l.driver_id = d.id and l.updated_at > now() - interval '15 minutes'
       )
    returning d.id
  )
  select count(*) into v_ghosts from g;

  delete from public.driver_location_history where recorded_at < now() - interval '30 days';
  get diagnostics v_history = row_count;
  delete from public.api_logs where created_at < now() - interval '90 days';
  get diagnostics v_logs = row_count;
  update public.driver_documents set status = 'expired' where status = 'valid' and expires_at < current_date;
  get diagnostics v_docs = row_count;
  delete from public.notifications where created_at < now() - interval '90 days' and status in ('sent', 'cancelled');
  get diagnostics v_notifs = row_count;

  return jsonb_build_object('ghost_drivers', v_ghosts, 'history_purged', v_history, 'api_logs_purged', v_logs,
    'documents_expired', v_docs, 'notifications_purged', v_notifs);
end;
$$;

-- Réservation des notifications à envoyer (worker) — SKIP LOCKED
create or replace function private.claim_notifications(p_limit integer default 100)
returns table (
  id uuid,
  organization_id uuid,
  driver_id uuid,
  ride_id uuid,
  type text,
  title text,
  body text,
  data jsonb,
  priority text,
  attempts smallint,
  tokens jsonb
)
language sql
security definer
set search_path = ''
as $$
  with due as (
    select n.id
    from public.notifications n
    where n.status = 'queued'
      and n.channel = 'push'
      and n.scheduled_for <= now()
    order by n.scheduled_for
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update public.notifications n
       set status = 'sending', attempts = n.attempts + 1
      from due
     where n.id = due.id
    returning n.*
  )
  select c.id, c.organization_id, c.driver_id, c.ride_id, c.type, c.title, c.body, c.data, c.priority, c.attempts,
         coalesce((
           select jsonb_agg(jsonb_build_object('token', t.token, 'provider', t.provider, 'platform', t.platform))
           from public.push_tokens t
           where t.driver_id = c.driver_id and t.is_active
         ), '[]'::jsonb) as tokens
  from claimed c;
$$;

-- -----------------------------------------------------------------------------
-- RPC chauffeur : accepter / refuser une offre
-- -----------------------------------------------------------------------------
create or replace function public.accept_ride_offer(p_offer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_driver public.drivers;
  o public.ride_offers;
  r public.rides;
  v_closed uuid[];
  v_latency bigint;
begin
  select d.* into v_driver from public.drivers d where d.id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  perform private.set_actor('driver', v_driver.id);

  select * into o from public.ride_offers where id = p_offer_id and driver_id = v_driver.id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'OFFER_NOT_FOUND', 'message', 'Offre introuvable.');
  end if;

  -- Point de sérialisation : verrou exclusif sur la ligne de la course.
  select * into r from public.rides where id = o.ride_id for update;
  v_latency := (extract(epoch from (clock_timestamp() - o.sent_at)) * 1000)::bigint;

  if r.driver_id is not null or r.status not in ('SEARCHING_DRIVER', 'OFFERED') then
    if o.status = 'pending' then
      update public.ride_offers
         set status = 'closed', closed_reason = 'already_assigned', responded_at = now()
       where id = o.id;
      perform private.release_offered_drivers(array[v_driver.id]);
    end if;
    perform private.log_event(r.organization_id, r.id, 'offer.rejected_late',
      format('%s (#%s) a tenté d''accepter — course déjà attribuée', v_driver.first_name, v_driver.number),
      'dispatch', 'warning', jsonb_build_object('driver_id', v_driver.id, 'offer_id', o.id, 'latency_ms', v_latency),
      'driver', v_driver.id);
    return jsonb_build_object('ok', false, 'code', 'RIDE_ALREADY_ASSIGNED', 'message', 'Course déjà attribuée.');
  end if;

  if o.status in ('declined', 'closed') then
    return jsonb_build_object('ok', false, 'code', 'OFFER_CLOSED', 'message', 'Cette offre n''est plus disponible.');
  end if;

  if exists (
    select 1 from public.rides x
    where x.driver_id = v_driver.id
      and x.id <> r.id
      and (
        x.status in ('DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS')
        or (x.status = 'ACCEPTED' and x.type = 'instant')
      )
  ) and r.type = 'instant' then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_BUSY', 'message', 'Vous avez déjà une course en cours.');
  end if;

  -- Compare-and-set : ne réussit que si la course est encore libre.
  update public.rides
     set driver_id = v_driver.id,
         vehicle_id = v_driver.vehicle_id,
         status = 'ACCEPTED',
         accepted_at = now(),
         next_dispatch_at = null
   where id = r.id
     and driver_id is null
     and status in ('SEARCHING_DRIVER', 'OFFERED');
  if not found then
    return jsonb_build_object('ok', false, 'code', 'RIDE_ALREADY_ASSIGNED', 'message', 'Course déjà attribuée.');
  end if;

  -- Filet de sécurité : index unique partiel ride_assignments_one_active_uidx
  insert into public.ride_assignments (organization_id, ride_id, driver_id, vehicle_id, offer_id, method)
  values (r.organization_id, r.id, v_driver.id, v_driver.vehicle_id, o.id, 'accepted');

  update public.ride_offers set status = 'accepted', responded_at = now() where id = o.id;

  perform private.log_event(r.organization_id, r.id, 'offer.accepted', format('%s accepte', v_driver.first_name),
    'timeline', 'success',
    jsonb_build_object('driver_id', v_driver.id, 'driver_number', v_driver.number, 'offer_id', o.id,
      'distance_m', o.distance_m, 'response_ms', v_latency),
    'driver', v_driver.id);
  perform private.log_event(r.organization_id, r.id, 'ride.locked', 'Course verrouillée',
    'timeline', 'info', jsonb_build_object('mechanism', 'row_lock+compare_and_set'), 'system', null);
  perform private.log_event(r.organization_id, r.id, 'dispatch.assigned',
    format('Assignment lock acquired — ride assigned to driver #%s', v_driver.number),
    'dispatch', 'debug', jsonb_build_object('driver_id', v_driver.id), 'system', null);

  v_closed := private.close_pending_offers(r.id, 'closed', 'assigned_to_other', o.id);
  if cardinality(v_closed) > 0 then
    perform private.log_event(r.organization_id, r.id, 'offers.closed',
      format('%s %s', cardinality(v_closed), private.pl(cardinality(v_closed), 'autre offre fermée', 'autres offres fermées')),
      'timeline', 'info', jsonb_build_object('count', cardinality(v_closed), 'driver_ids', to_jsonb(v_closed)), 'system', null);
  end if;

  update public.notifications
     set status = 'cancelled'
   where ride_id = r.id and type in ('ride_offer', 'ride_offer_scheduled') and status = 'queued';

  if r.type = 'instant' then
    update public.drivers set presence = 'en_route', current_ride_id = r.id where id = v_driver.id;
  else
    perform private.release_offered_drivers(array[v_driver.id]);
    perform private.schedule_reminders(r.id);
  end if;

  return jsonb_build_object('ok', true, 'code', 'ACCEPTED', 'message', 'Course attribuée.', 'ride_id', r.id);
end;
$$;

create or replace function public.decline_ride_offer(p_offer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_driver public.drivers;
  o public.ride_offers;
begin
  select d.* into v_driver from public.drivers d where d.id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  perform private.set_actor('driver', v_driver.id);

  select * into o from public.ride_offers where id = p_offer_id and driver_id = v_driver.id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'OFFER_NOT_FOUND', 'message', 'Offre introuvable.');
  end if;

  perform 1 from public.rides where id = o.ride_id for update;

  update public.ride_offers
     set status = 'declined', responded_at = now()
   where id = o.id and status in ('pending', 'expired');
  if not found then
    return jsonb_build_object('ok', false, 'code', 'OFFER_CLOSED', 'message', 'Cette offre n''est plus disponible.');
  end if;

  perform private.release_offered_drivers(array[v_driver.id]);
  perform private.log_event(o.organization_id, o.ride_id, 'offer.declined', format('%s refuse la course', v_driver.first_name),
    'dispatch', 'info', jsonb_build_object('driver_id', v_driver.id, 'offer_id', o.id), 'driver', v_driver.id);

  -- Tous les chauffeurs ont répondu : on accélère la vague suivante
  update public.rides
     set next_dispatch_at = now()
   where id = o.ride_id
     and status in ('SEARCHING_DRIVER', 'OFFERED')
     and dispatch_mode = 'geo'
     and not exists (select 1 from public.ride_offers x where x.ride_id = o.ride_id and x.status = 'pending');

  return jsonb_build_object('ok', true, 'code', 'DECLINED');
end;
$$;

-- -----------------------------------------------------------------------------
-- RPC chauffeur : cycle de course
-- Aller au départ → Je suis arrivé → Client à bord → Démarrer → Terminer
-- -----------------------------------------------------------------------------
create or replace function public.driver_update_ride_status(p_ride_id uuid, p_status public.ride_status)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_driver public.drivers;
  r public.rides;
  v_message text;
begin
  select d.* into v_driver from public.drivers d where d.id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  perform private.set_actor('driver', v_driver.id);

  select * into r from public.rides where id = p_ride_id and driver_id = v_driver.id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_FOUND', 'message', 'Course introuvable.');
  end if;

  if (r.status::text || '>' || p_status::text) not in (
    'ACCEPTED>DRIVER_EN_ROUTE',
    'DRIVER_EN_ROUTE>DRIVER_ARRIVED',
    'DRIVER_ARRIVED>PASSENGER_ONBOARD',
    'PASSENGER_ONBOARD>IN_PROGRESS',
    'IN_PROGRESS>COMPLETED'
  ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TRANSITION',
      'message', format('Transition %s → %s impossible.', r.status, p_status), 'status', r.status);
  end if;

  if p_status = 'DRIVER_EN_ROUTE' and v_driver.current_ride_id is not null and v_driver.current_ride_id <> r.id then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_BUSY',
      'message', 'Terminez votre course en cours avant d''en démarrer une autre.');
  end if;

  update public.rides
     set status = p_status,
         driver_en_route_at = case when p_status = 'DRIVER_EN_ROUTE' then now() else driver_en_route_at end,
         driver_arrived_at = case when p_status = 'DRIVER_ARRIVED' then now() else driver_arrived_at end,
         passenger_onboard_at = case when p_status = 'PASSENGER_ONBOARD' then now() else passenger_onboard_at end,
         started_at = case when p_status = 'IN_PROGRESS' then now() else started_at end,
         completed_at = case when p_status = 'COMPLETED' then now() else completed_at end
   where id = r.id;

  v_message := case p_status
    when 'DRIVER_EN_ROUTE' then 'Chauffeur en route vers le client'
    when 'DRIVER_ARRIVED' then 'Chauffeur arrivé au point de départ'
    when 'PASSENGER_ONBOARD' then 'Client à bord'
    when 'IN_PROGRESS' then 'Course démarrée'
    when 'COMPLETED' then 'Course terminée'
  end;
  perform private.log_event(r.organization_id, r.id, 'ride.' || lower(p_status::text), v_message,
    'timeline', case when p_status = 'COMPLETED' then 'success' else 'info' end::public.event_level,
    jsonb_build_object('status', p_status), 'driver', v_driver.id);

  if p_status = 'COMPLETED' then
    update public.drivers set presence = 'available', current_ride_id = null where id = v_driver.id;
    update public.notifications set status = 'cancelled'
     where ride_id = r.id and type = 'ride_reminder' and status = 'queued';
  else
    update public.drivers
       set presence = case p_status
             when 'DRIVER_EN_ROUTE' then 'en_route'
             when 'DRIVER_ARRIVED' then 'arrived'
             else 'on_trip'
           end::public.driver_presence,
           current_ride_id = r.id
     where id = v_driver.id;
  end if;

  return jsonb_build_object('ok', true, 'code', 'UPDATED', 'status', p_status);
end;
$$;

-- -----------------------------------------------------------------------------
-- RPC rattacheur : annuler / attribuer manuellement / relancer
-- -----------------------------------------------------------------------------
create or replace function private.cancel_ride_internal(
  p_ride_id uuid,
  p_reason text,
  p_actor public.actor_type,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  v_closed uuid[];
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_FOUND', 'message', 'Course introuvable.');
  end if;
  if r.status in ('COMPLETED', 'CANCELLED') then
    return jsonb_build_object('ok', false, 'code', 'RIDE_CLOSED', 'message', 'Course déjà clôturée.');
  end if;
  if r.status in ('PASSENGER_ONBOARD', 'IN_PROGRESS') and p_actor in ('api', 'booking_site') then
    return jsonb_build_object('ok', false, 'code', 'RIDE_IN_PROGRESS', 'message', 'Course en cours : annulation impossible.');
  end if;

  perform private.set_actor(p_actor, p_actor_id);

  update public.rides
     set status = 'CANCELLED', cancelled_at = now(), cancel_reason = v_reason,
         cancelled_by_type = p_actor, next_dispatch_at = null
   where id = r.id;

  v_closed := private.close_pending_offers(r.id, 'closed', 'ride_cancelled');
  update public.ride_assignments
     set is_active = false, released_at = now(), release_reason = 'cancelled'
   where ride_id = r.id and is_active;
  update public.notifications set status = 'cancelled' where ride_id = r.id and status = 'queued';

  if r.driver_id is not null then
    update public.drivers
       set presence = 'available', current_ride_id = null
     where id = r.driver_id and current_ride_id = r.id;
    perform private.queue_notification(r.organization_id, r.driver_id, r.id, null, 'ride_cancelled', 'COURSE ANNULÉE',
      format('#%s · %s → %s', r.number, coalesce(private.short_address(r.pickup_address), r.pickup_address),
        coalesce(private.short_address(r.dropoff_address), r.dropoff_address)),
      jsonb_build_object('type', 'ride_cancelled', 'ride_id', r.id), 'high', null);
  end if;

  perform private.log_event(r.organization_id, r.id, 'ride.cancelled',
    coalesce('Course annulée — ' || v_reason, 'Course annulée'),
    'timeline', 'warning', jsonb_build_object('reason', v_reason, 'closed_offers', cardinality(v_closed)), p_actor, p_actor_id);

  return jsonb_build_object('ok', true, 'code', 'CANCELLED', 'status', 'CANCELLED');
end;
$$;

create or replace function public.cancel_ride(p_ride_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.rides where id = p_ride_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_FOUND', 'message', 'Course introuvable.');
  end if;
  perform private.assert_org_member(v_org);
  return private.cancel_ride_internal(p_ride_id, p_reason, 'user', auth.uid());
end;
$$;

-- Réservé au serveur (API publique / mini-site) : l'organisation vient de la clé API.
create or replace function public.svc_cancel_ride(p_org uuid, p_ride_id uuid, p_reason text, p_actor public.actor_type default 'api')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.rides where id = p_ride_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_FOUND', 'message', 'Course introuvable.');
  end if;
  if v_org <> p_org then
    raise exception 'FORBIDDEN_TENANT: accès refusé à cette course' using errcode = '42501';
  end if;
  return private.cancel_ride_internal(p_ride_id, p_reason, p_actor, null);
end;
$$;

create or replace function public.assign_ride(p_ride_id uuid, p_driver_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  d public.drivers;
  v_previous uuid;
  v_closed uuid[];
  v_tz text;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_FOUND', 'message', 'Course introuvable.');
  end if;
  perform private.assert_org_member(r.organization_id);
  perform private.set_actor('user', auth.uid());

  select * into d from public.drivers where id = p_driver_id and organization_id = r.organization_id;
  if not found then
    raise exception 'FORBIDDEN_TENANT: chauffeur hors de votre organisation' using errcode = '42501';
  end if;
  if d.status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_INACTIVE', 'message', 'Ce chauffeur n''est pas actif.');
  end if;
  if r.status not in ('CREATED', 'SEARCHING_DRIVER', 'OFFERED', 'NO_DRIVER_FOUND', 'ACCEPTED') then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_ASSIGNABLE', 'message', 'Cette course ne peut plus être réattribuée.');
  end if;
  if r.driver_id = d.id then
    return jsonb_build_object('ok', true, 'code', 'UNCHANGED');
  end if;

  select timezone into v_tz from public.organizations where id = r.organization_id;
  v_previous := r.driver_id;

  if v_previous is not null then
    update public.ride_assignments
       set is_active = false, released_at = now(), release_reason = 'reassigned'
     where ride_id = r.id and is_active;
    update public.drivers set presence = 'available', current_ride_id = null
     where id = v_previous and current_ride_id = r.id;
    update public.notifications set status = 'cancelled'
     where ride_id = r.id and driver_id = v_previous and status = 'queued';
    perform private.queue_notification(r.organization_id, v_previous, r.id, null, 'ride_unassigned', 'COURSE RETIRÉE',
      format('La centrale a réattribué la course #%s', r.number),
      jsonb_build_object('type', 'ride_unassigned', 'ride_id', r.id), 'high', null);
  end if;

  update public.rides
     set driver_id = d.id, vehicle_id = d.vehicle_id, status = 'ACCEPTED', accepted_at = now(), next_dispatch_at = null
   where id = r.id;

  insert into public.ride_assignments (organization_id, ride_id, driver_id, vehicle_id, method, assigned_by)
  values (r.organization_id, r.id, d.id, d.vehicle_id, 'manual', auth.uid());

  v_closed := private.close_pending_offers(r.id, 'closed', 'manual_assignment');

  if r.type = 'instant' and d.current_ride_id is null then
    update public.drivers set presence = 'en_route', current_ride_id = r.id where id = d.id;
  elsif r.type = 'scheduled' then
    perform private.schedule_reminders(r.id);
  end if;

  perform private.queue_notification(r.organization_id, d.id, r.id, null, 'ride_assigned', 'COURSE ATTRIBUÉE',
    format('#%s · %s · %s → %s', r.number, to_char(r.pickup_at at time zone coalesce(v_tz, 'Europe/Paris'), 'DD/MM HH24:MI'),
      coalesce(private.short_address(r.pickup_address), r.pickup_address),
      coalesce(private.short_address(r.dropoff_address), r.dropoff_address)),
    jsonb_build_object('type', 'ride_assigned', 'ride_id', r.id), 'high', null);

  perform private.log_event(r.organization_id, r.id, 'ride.assigned_manually',
    format('Course attribuée manuellement à %s %s (#%s)', d.first_name, d.last_name, d.number),
    'timeline', 'success',
    jsonb_build_object('driver_id', d.id, 'previous_driver_id', v_previous, 'closed_offers', cardinality(v_closed)),
    'user', auth.uid());

  return jsonb_build_object('ok', true, 'code', 'ASSIGNED', 'ride_id', r.id);
end;
$$;

create or replace function public.redispatch_ride(p_ride_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  v_threshold integer;
  v_type public.ride_type;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_FOUND', 'message', 'Course introuvable.');
  end if;
  perform private.assert_org_member(r.organization_id);
  perform private.set_actor('user', auth.uid());

  if r.driver_id is not null or r.status not in ('CREATED', 'SEARCHING_DRIVER', 'OFFERED', 'NO_DRIVER_FOUND') then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_DISPATCHABLE', 'message', 'Cette course ne peut pas être relancée.');
  end if;

  select instant_threshold_minutes into v_threshold from public.organization_settings where organization_id = r.organization_id;
  v_type := case when r.pickup_at <= now() + make_interval(mins => coalesce(v_threshold, 45)) then 'instant' else 'scheduled' end;

  perform private.close_pending_offers(r.id, 'expired', 'redispatch');
  update public.rides
     set status = 'SEARCHING_DRIVER',
         type = v_type,
         pickup_at = greatest(pickup_at, now()),
         dispatch_mode = case when v_type = 'instant' then 'geo' else 'fleet' end::public.dispatch_mode,
         dispatch_wave = 0,
         dispatch_started_at = now(),
         no_driver_at = null,
         next_dispatch_at = null
   where id = r.id;

  perform private.log_event(r.organization_id, r.id, 'dispatch.relaunched', 'Dispatch relancé par le rattacheur',
    'timeline', 'info', jsonb_build_object('type', v_type), 'user', auth.uid());

  if v_type = 'instant' then
    perform private.run_geo_wave(r.id);
  else
    perform private.offer_to_fleet(r.id);
  end if;

  return jsonb_build_object('ok', true, 'code', 'RELAUNCHED');
end;
$$;

-- -----------------------------------------------------------------------------
-- RPC chauffeur : présence, position, appareil, accueil, offres
-- -----------------------------------------------------------------------------
create or replace function public.driver_set_online(p_online boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_presence public.driver_presence;
begin
  select * into d from public.drivers where id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  perform private.set_actor('driver', d.id);

  if p_online then
    if d.presence = 'offline' then
      update public.drivers
         set presence = 'available', online_since = now(), last_seen_at = now()
       where id = d.id and current_ride_id is null;
    end if;
  else
    if d.current_ride_id is not null then
      return jsonb_build_object('ok', false, 'code', 'ACTIVE_RIDE',
        'message', 'Terminez votre course avant de passer hors ligne.', 'presence', d.presence);
    end if;
    update public.ride_offers
       set status = 'expired', closed_reason = 'driver_offline', responded_at = now()
     where driver_id = d.id and status = 'pending' and mode = 'geo';
    update public.drivers set presence = 'offline', online_since = null where id = d.id;
  end if;

  select presence into v_presence from public.drivers where id = d.id;
  if v_presence is distinct from d.presence then
    perform private.log_event(d.organization_id, null, case when p_online then 'driver.online' else 'driver.offline' end,
      format('%s (#%s) %s', d.first_name, d.number, case when p_online then 'est en ligne' else 'est hors ligne' end),
      'system', 'info', jsonb_build_object('driver_id', d.id), 'driver', d.id);
  end if;

  return jsonb_build_object('ok', true, 'presence', v_presence);
end;
$$;

create or replace function public.update_driver_location(
  p_lat double precision,
  p_lng double precision,
  p_heading real default null,
  p_speed real default null,
  p_accuracy real default null,
  p_battery real default null,
  p_recorded_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d record;
  v_recorded timestamptz := least(coalesce(p_recorded_at, now()), now());
  v_has_recent_history boolean;
begin
  select x.id, x.organization_id, x.presence, x.current_ride_id, x.last_seen_at into d
  from public.drivers x where x.id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'INVALID_COORDINATES' using errcode = '22023';
  end if;

  insert into public.driver_locations as dl
    (driver_id, organization_id, lat, lng, heading, speed_mps, accuracy_m, battery_level, recorded_at, updated_at)
  values (d.id, d.organization_id, p_lat, p_lng, p_heading, p_speed, p_accuracy, p_battery, v_recorded, now())
  on conflict (driver_id) do update
    set lat = excluded.lat,
        lng = excluded.lng,
        heading = excluded.heading,
        speed_mps = excluded.speed_mps,
        accuracy_m = excluded.accuracy_m,
        battery_level = coalesce(excluded.battery_level, dl.battery_level),
        recorded_at = excluded.recorded_at,
        updated_at = now()
    where dl.recorded_at <= excluded.recorded_at;

  -- Historique : chaque point en course, sinon 1 point / minute
  select exists (
    select 1 from public.driver_location_history h
    where h.driver_id = d.id and h.recorded_at > now() - interval '1 minute'
  ) into v_has_recent_history;
  if d.current_ride_id is not null or not v_has_recent_history then
    insert into public.driver_location_history (organization_id, driver_id, ride_id, lat, lng, speed_mps, heading, accuracy_m, recorded_at)
    values (d.organization_id, d.id, d.current_ride_id, p_lat, p_lng, p_speed, p_heading, p_accuracy, v_recorded);
  end if;

  if d.last_seen_at is null or d.last_seen_at < now() - interval '60 seconds' then
    update public.drivers set last_seen_at = now() where id = d.id;
  end if;

  -- Fréquence GPS adaptative suggérée à l'application (économie batterie)
  return jsonb_build_object(
    'ok', true,
    'presence', d.presence,
    'next_interval_s', case
      when d.current_ride_id is not null or d.presence = 'offered' then 5
      when d.presence = 'offline' then 120
      else 15
    end
  );
end;
$$;

create or replace function public.driver_register_device(
  p_installation_id text,
  p_platform public.device_platform,
  p_push_token text default null,
  p_provider public.push_provider default 'expo',
  p_device_name text default null,
  p_os_version text default null,
  p_app_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d record;
  v_device uuid;
begin
  select x.id, x.organization_id into d from public.drivers x where x.id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  if p_installation_id is null or char_length(p_installation_id) not between 8 and 128 then
    raise exception 'INVALID_INSTALLATION_ID' using errcode = '22023';
  end if;

  insert into public.driver_devices (organization_id, driver_id, installation_id, platform, device_name, os_version, app_version, last_seen_at)
  values (d.organization_id, d.id, p_installation_id, p_platform, left(p_device_name, 120), left(p_os_version, 40), left(p_app_version, 40), now())
  on conflict (driver_id, installation_id) do update
    set platform = excluded.platform,
        device_name = excluded.device_name,
        os_version = excluded.os_version,
        app_version = excluded.app_version,
        last_seen_at = now(),
        revoked_at = null
  returning id into v_device;

  if p_push_token is not null and char_length(p_push_token) between 10 and 512 then
    -- Le token peut changer de compte (téléphone partagé) : on le réattribue.
    delete from public.push_tokens where token = p_push_token and driver_id <> d.id;
    update public.push_tokens set is_active = false
     where device_id = v_device and token <> p_push_token and is_active;
    insert into public.push_tokens (organization_id, driver_id, device_id, token, provider, platform, is_active)
    values (d.organization_id, d.id, v_device, p_push_token, p_provider, p_platform, true)
    on conflict (token) do update
      set device_id = excluded.device_id,
          provider = excluded.provider,
          platform = excluded.platform,
          is_active = true,
          last_error = null;
  end if;

  return jsonb_build_object('ok', true, 'device_id', v_device);
end;
$$;

create or replace function public.driver_unregister_push_token(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.push_tokens
   where token = p_token
     and driver_id = (select d.id from public.drivers d where d.user_id = auth.uid() limit 1);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.driver_home()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  o public.organizations;
  v_day_start timestamptz;
begin
  select * into d from public.drivers where id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  select * into o from public.organizations where id = d.organization_id;
  v_day_start := date_trunc('day', now() at time zone o.timezone) at time zone o.timezone;

  return jsonb_build_object(
    'driver', jsonb_build_object(
      'id', d.id, 'number', d.number, 'first_name', d.first_name, 'last_name', d.last_name,
      'presence', d.presence, 'photo_url', d.photo_url, 'current_ride_id', d.current_ride_id),
    'organization', jsonb_build_object('id', o.id, 'name', o.name, 'logo_url', o.logo_url, 'phone', o.phone, 'timezone', o.timezone),
    'vehicle', (
      select jsonb_build_object('brand', v.brand, 'model', v.model, 'plate', v.plate, 'color', v.color,
        'category', v.category, 'seats', v.seats)
      from public.vehicles v where v.id = d.vehicle_id
    ),
    'today', (
      select jsonb_build_object('rides', count(*), 'revenue_cents', coalesce(sum(x.price_cents), 0))
      from public.rides x
      where x.driver_id = d.id and x.status = 'COMPLETED' and x.completed_at >= v_day_start
    ),
    'next_scheduled', (
      select jsonb_build_object('id', x.id, 'number', x.number, 'pickup_at', x.pickup_at,
        'pickup_address', x.pickup_address, 'dropoff_address', x.dropoff_address, 'price_cents', x.price_cents)
      from public.rides x
      where x.driver_id = d.id and x.status = 'ACCEPTED' and x.type = 'scheduled'
      order by x.pickup_at
      limit 1
    ),
    'pending_offers', (
      select count(*) from public.ride_offers x where x.driver_id = d.id and x.status = 'pending'
    )
  );
end;
$$;

-- Offres visibles par le chauffeur (sans téléphone client avant acceptation)
create or replace function public.driver_offers()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'offer_id', o.id,
    'ride_id', r.id,
    'number', r.number,
    'mode', o.mode,
    'status', o.status,
    'ride_type', r.type,
    'pickup_address', r.pickup_address,
    'pickup_lat', r.pickup_lat,
    'pickup_lng', r.pickup_lng,
    'dropoff_address', r.dropoff_address,
    'dropoff_lat', r.dropoff_lat,
    'dropoff_lng', r.dropoff_lng,
    'pickup_at', r.pickup_at,
    'price_cents', r.price_cents,
    'currency', r.currency,
    'payment_method', r.payment_method,
    'passengers', r.passengers,
    'luggage', r.luggage,
    'vehicle_category', r.vehicle_category,
    'distance_m', o.distance_m,
    'estimated_distance_m', r.estimated_distance_m,
    'estimated_duration_s', r.estimated_duration_s,
    'flight_number', r.flight_number,
    'comment', r.comment,
    'sent_at', o.sent_at,
    'expires_at', o.expires_at
  ) order by r.type, o.sent_at desc), '[]'::jsonb)
  from public.ride_offers o
  join public.rides r on r.id = o.ride_id
  where o.driver_id = private.current_driver_id()
    and o.status = 'pending'
    and r.driver_id is null
    and r.status in ('SEARCHING_DRIVER', 'OFFERED');
$$;

-- -----------------------------------------------------------------------------
-- Triggers rides (ordre alphabétique = ordre d'exécution)
-- -----------------------------------------------------------------------------
create trigger rides_before_insert
  before insert on public.rides
  for each row execute function private.before_ride_insert();

create trigger rides_a_track_status
  after insert or update of status on public.rides
  for each row execute function private.track_ride_status();

create trigger rides_b_start_dispatch
  after insert on public.rides
  for each row execute function private.after_ride_insert();
