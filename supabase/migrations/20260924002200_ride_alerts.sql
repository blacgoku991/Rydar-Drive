-- =============================================================================
-- Alertes de suivi des courses attribuées : la centrale est prévenue et DÉCIDE.
--
--  late         chauffeur qui arrivera en retard (ETA ≈ distance × 1,35 / 8,3 m/s)
--  stalled      chauffeur immobile (< 150 m depuis N min) loin du départ
--  no_gps       plus de position GPS pendant une course active
--  not_started  planifiée imminente (< 30 min) et chauffeur hors ligne / sans GPS
--
--  Worker (~30 s) ──► private.watch_rides() : ouvre / met à jour / clôt les alertes
--                     (une seule alerte ouverte par course et par type).
--  Dashboard ──► acknowledge_ride_alert  « Garder »   (sourdine 15 min)
--            ──► assign_ride             « Réattribuer » (à un chauffeur choisi,
--                                          désormais aussi en route / arrivé)
--            ──► reassign_ride           « Relancer »  (retire la course au chauffeur,
--                                          qui n'est plus sollicité, puis nouvelle
--                                          recherche 4 km d'abord ou flotte)
--  Temps réel : 'ride.alert' sur org:{id} (op insert | update | resolve).
--  accept_ride_offer : une offre déjà « acceptée » ne peut plus resservir (chauffeur retiré).
--
-- Ordre de verrouillage : rides → ride_offers → drivers → ride_alerts.
-- =============================================================================

-- ----------------------------------------------------------------- réglages
alter table public.organization_settings
  add column late_alert_tolerance_minutes integer not null default 5
    constraint organization_settings_late_alert_tolerance_check check (late_alert_tolerance_minutes between 1 and 60),
  add column stalled_alert_minutes integer not null default 4
    constraint organization_settings_stalled_alert_minutes_check check (stalled_alert_minutes between 2 and 30);

grant update (late_alert_tolerance_minutes, stalled_alert_minutes) on public.organization_settings to authenticated;

-- ----------------------------------------------------------------- table
create table public.ride_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  ride_id uuid not null,
  driver_id uuid,
  kind text not null check (kind in ('late', 'stalled', 'no_gps', 'not_started')),
  severity text not null default 'warning' check (severity in ('warning', 'critical')),
  message text not null check (char_length(message) between 1 and 300),
  data jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  resolution text check (resolution in ('kept', 'reassigned', 'relaunched', 'auto_resolved')),
  muted_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.users (id) on delete set null,
  unique (organization_id, id),
  constraint ride_alerts_status_coherent check (
    (status = 'open' and resolution is null)
    or (status = 'acknowledged' and resolution = 'kept' and muted_until is not null)
    or (status = 'resolved' and resolution is not null and resolved_at is not null)
  ),
  foreign key (organization_id, ride_id) references public.rides (organization_id, id) on delete cascade,
  foreign key (organization_id, driver_id) references public.drivers (organization_id, id) on delete set null (driver_id)
);

comment on table public.ride_alerts is
  'Alertes de suivi (retard, immobile, GPS muet, non démarrée) — écrites par private.watch_rides et les RPC de la centrale.';

-- Garantie : une seule alerte ouverte par course et par type.
create unique index ride_alerts_one_open_uidx on public.ride_alerts (ride_id, kind) where status = 'open';
create index ride_alerts_active_idx on public.ride_alerts (ride_id, kind) where status in ('open', 'acknowledged');
create index ride_alerts_org_idx on public.ride_alerts (organization_id, created_at desc);

-- Courses surveillées par watch_rides (attribuées, pas terminées)
create index if not exists rides_assigned_active_idx on public.rides (status, pickup_at)
  where driver_id is not null
    and status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS');

create trigger ride_alerts_touch_updated_at
  before update on public.ride_alerts
  for each row execute function private.touch_updated_at();

create trigger ride_alerts_forbid_org_change
  before update of organization_id on public.ride_alerts
  for each row execute function private.forbid_org_change();

-- ----------------------------------------------------------------- RLS : lecture org (+ super admin), aucune écriture directe
alter table public.ride_alerts enable row level security;

create policy ride_alerts_select on public.ride_alerts for select to authenticated
  using (organization_id in (select private.member_org_ids()) or (select private.is_super_admin()));

revoke all on public.ride_alerts from public, anon, authenticated;
grant select on public.ride_alerts to authenticated;
grant all on public.ride_alerts to service_role;

-- ----------------------------------------------------------------- utilitaires
create or replace function private.ride_alert_label(p_kind text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_kind
    when 'late' then 'retard'
    when 'stalled' then 'chauffeur immobile'
    when 'no_gps' then 'GPS muet'
    when 'not_started' then 'course non démarrée'
    else coalesce(p_kind, 'alerte')
  end;
$$;

-- Charge utile commune (temps réel + retour des RPC)
create or replace function private.ride_alert_payload(a public.ride_alerts, p_op text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'op', p_op, 'id', a.id, 'ride_id', a.ride_id, 'driver_id', a.driver_id, 'kind', a.kind,
    'severity', a.severity, 'message', a.message, 'data', a.data, 'status', a.status,
    'resolution', a.resolution, 'muted_until', a.muted_until, 'created_at', a.created_at,
    'updated_at', a.updated_at, 'resolved_at', a.resolved_at, 'resolved_by', a.resolved_by);
$$;

create or replace function private.broadcast_ride_alert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    private.ride_alert_payload(new, case
      when tg_op = 'INSERT' then 'insert'
      when new.status = 'resolved' and old.status is distinct from 'resolved' then 'resolve'
      else 'update'
    end),
    'ride.alert', 'org:' || new.organization_id::text, true);
  return null;
end;
$$;

create trigger ride_alerts_broadcast
  after insert or update on public.ride_alerts
  for each row execute function private.broadcast_ride_alert();

-- Clôture manuelle (réattribution / relance) de toutes les alertes actives d'une course.
create or replace function private.close_ride_alerts(p_ride_id uuid, p_resolution text, p_by uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.ride_alerts
     set status = 'resolved', resolution = p_resolution, resolved_at = now(), resolved_by = p_by
   where ride_id = p_ride_id
     and status in ('open', 'acknowledged');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Ouvre / met à jour / clôt l'alerte d'un type pour une course.
--   p_active = true  → condition présente ; false → absente ; null → inconnue (rien ne change)
-- Renvoie 'opened' | 'updated' | 'resolved' | null.
create or replace function private.apply_ride_alert(
  p_ride public.rides,
  p_driver public.drivers,
  p_kind text,
  p_active boolean,
  p_severity text,
  p_message text,
  p_data jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.ride_alerts;
  v_found boolean;
  v_id uuid;
  v_data jsonb;
begin
  if p_active is null then
    return null;
  end if;

  select * into a from public.ride_alerts
   where ride_id = p_ride.id and kind = p_kind and status = 'open'
   for update;
  v_found := found;

  if not p_active then
    if not v_found then
      return null;
    end if;
    update public.ride_alerts
       set status = 'resolved', resolution = 'auto_resolved', resolved_at = now()
     where id = a.id;
    perform private.log_event(p_ride.organization_id, p_ride.id, 'alert.resolved',
      format('Alerte close : %s', private.ride_alert_label(p_kind)), 'dispatch', 'info',
      jsonb_build_object('alert_id', a.id, 'kind', p_kind, 'resolution', 'auto_resolved'), 'system', null);
    return 'resolved';
  end if;

  v_id := case when v_found then a.id else gen_random_uuid() end;
  v_data := coalesce(p_data, '{}'::jsonb) || jsonb_build_object(
    'alert_id', v_id,
    'ride_number', p_ride.number,
    'driver_id', p_driver.id,
    'driver_name', p_driver.first_name,
    'driver_number', p_driver.number,
    -- keep → acknowledge_ride_alert ; reassign → assign_ride ; relaunch → reassign_ride
    'actions', jsonb_build_array('keep', 'reassign', 'relaunch'));

  if v_found then
    if a.message is distinct from p_message or a.severity is distinct from p_severity then
      update public.ride_alerts
         set message = p_message, severity = p_severity, data = v_data
       where id = a.id;
      return 'updated';
    end if;
    return null;
  end if;

  -- « Garder » : pas de nouvelle alerte de ce type pendant la sourdine
  if exists (
    select 1 from public.ride_alerts x
    where x.ride_id = p_ride.id
      and x.kind = p_kind
      and x.status = 'acknowledged'
      and x.muted_until > now()
      and x.driver_id is not distinct from p_driver.id
  ) then
    return null;
  end if;

  insert into public.ride_alerts (id, organization_id, ride_id, driver_id, kind, severity, message, data)
  values (v_id, p_ride.organization_id, p_ride.id, p_driver.id, p_kind, p_severity, p_message, v_data)
  on conflict (ride_id, kind) where status = 'open' do nothing;
  if not found then
    return null;
  end if;

  perform private.log_event(p_ride.organization_id, p_ride.id, 'alert.' || p_kind, p_message, 'timeline', 'warning',
    v_data || jsonb_build_object('kind', p_kind, 'severity', p_severity), 'system', null);
  return 'opened';
end;
$$;

-- ----------------------------------------------------------------- surveillance (worker, ~30 s)
create or replace function private.watch_rides()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  x record;
  a record;
  r public.rides;
  d public.drivers;
  s public.organization_settings;
  l public.driver_locations;
  v_tz text;
  v_watched boolean;
  v_has_loc boolean;
  v_fresh boolean;
  v_gps_max integer;
  v_age integer;
  v_dist integer;
  v_dist_label text;
  v_eta integer;
  v_d0 integer;
  v_ref timestamptz;
  v_delay integer;
  v_tolerance integer;
  v_stall_min integer;
  v_start timestamptz;
  v_last_away timestamptz;
  v_since timestamptz;
  v_still integer;
  v_cond boolean;
  v_severity text;
  v_message text;
  v_data jsonb;
  v_res text;
  v_checked integer := 0;
  v_opened integer := 0;
  v_updated integer := 0;
  v_resolved integer := 0;
  v_skipped integer := 0;
begin
  -- Plusieurs workers : un seul passage à la fois (les autres sortent aussitôt)
  if not pg_try_advisory_xact_lock(1918985550, 2200) then
    return jsonb_build_object('ok', false, 'code', 'LOCKED', 'checked', 0, 'opened', 0, 'updated', 0, 'resolved', 0, 'skipped', 0);
  end if;
  perform private.set_actor('system', null);

  for x in
    select c.id
    from (
      select r0.id
      from public.rides r0
      where r0.driver_id is not null
        and (
          r0.status in ('DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS')
          or (r0.status = 'ACCEPTED' and (r0.type = 'instant' or r0.pickup_at < now() + interval '90 minutes'))
        )
      union
      select a0.ride_id from public.ride_alerts a0 where a0.status in ('open', 'acknowledged')
    ) c
    order by c.id
  loop
    -- Course en cours de modification (acceptation, réattribution…) : on repassera
    select * into r from public.rides where id = x.id for no key update skip locked;
    if not found then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    v_checked := v_checked + 1;

    v_watched := r.driver_id is not null and (
      r.status in ('DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS')
      or (r.status = 'ACCEPTED' and (r.type = 'instant' or r.pickup_at < now() + interval '90 minutes'))
    );

    -- Course terminée / annulée / remise en recherche / autre chauffeur : alertes closes.
    -- Sourdine écoulée : l'alerte « gardée » est close (une nouvelle peut s'ouvrir ci-dessous).
    for a in
      update public.ride_alerts
         set status = 'resolved',
             resolution = coalesce(resolution, 'auto_resolved'),
             resolved_at = now()
       where ride_id = r.id
         and status in ('open', 'acknowledged')
         and (
           not v_watched
           or driver_id is distinct from r.driver_id
           or (status = 'acknowledged' and muted_until <= now())
         )
      returning id, kind, resolution
    loop
      v_resolved := v_resolved + 1;
      if a.resolution = 'auto_resolved' then
        perform private.log_event(r.organization_id, r.id, 'alert.resolved',
          format('Alerte close : %s', private.ride_alert_label(a.kind)), 'dispatch', 'info',
          jsonb_build_object('alert_id', a.id, 'kind', a.kind, 'resolution', a.resolution), 'system', null);
      end if;
    end loop;

    continue when not v_watched;

    select * into d from public.drivers where id = r.driver_id;
    continue when not found;
    select * into s from public.organization_settings where organization_id = r.organization_id;
    select o.timezone into v_tz from public.organizations o where o.id = r.organization_id;
    select * into l from public.driver_locations where driver_id = r.driver_id;
    v_has_loc := found;

    v_gps_max := greatest(coalesce(s.location_max_age_seconds, 180), 180);
    v_tolerance := coalesce(s.late_alert_tolerance_minutes, 5);
    v_stall_min := coalesce(s.stalled_alert_minutes, 4);
    if v_has_loc then
      v_age := greatest(0, floor(extract(epoch from (now() - l.updated_at))))::integer;
      v_fresh := v_age <= v_gps_max;
      v_dist := round(extensions.st_distance(l.location, r.pickup_location))::integer;
      v_dist_label := private.fmt_km(round(v_dist::numeric, -2)::integer);
    else
      v_age := null;
      v_fresh := false;
      v_dist := null;
      v_dist_label := null;
    end if;

    -- ---------------------------------------------------------------- retard
    v_cond := false;
    v_severity := null;
    v_message := null;
    v_data := null;
    if r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE') then
      if not v_fresh then
        v_cond := null; -- position inconnue : c'est l'alerte GPS qui parle
      else
        v_eta := round(v_dist * 1.35 / 8.3)::integer;
        -- Heure de référence :
        --  * planifiée : l'heure réservée (pickup_at) ;
        --  * instantanée (« dès que possible ») : l'heure promise à l'acceptation =
        --    greatest(pickup_at, acceptation + trajet estimé à ce moment-là), la distance
        --    venant de l'offre acceptée, sinon de la position à l'acceptation.
        v_d0 := null;
        if r.type = 'instant' and r.accepted_at is not null then
          select o.distance_m into v_d0
          from public.ride_assignments ra
          join public.ride_offers o on o.id = ra.offer_id
          where ra.ride_id = r.id and ra.is_active and ra.driver_id = r.driver_id
          limit 1;
          if v_d0 is null and l.updated_at <= r.accepted_at + interval '1 minute' then
            v_d0 := v_dist; -- aucune position reçue depuis l'attribution : c'est celle de l'attribution
          elsif v_d0 is null then
            select round(extensions.st_distance(
                     extensions.st_setsrid(extensions.st_makepoint(h.lng, h.lat), 4326)::extensions.geography,
                     r.pickup_location))::integer
              into v_d0
            from public.driver_location_history h
            where h.driver_id = r.driver_id
              and h.recorded_at between r.accepted_at - interval '10 minutes' and r.accepted_at + interval '1 minute'
            order by h.recorded_at desc
            limit 1;
          end if;
          v_ref := greatest(r.pickup_at, r.accepted_at + make_interval(secs => coalesce(round(v_d0 * 1.35 / 8.3), 0)));
        else
          v_ref := r.pickup_at;
        end if;
        v_delay := floor(extract(epoch from (now() + make_interval(secs => v_eta) - v_ref)))::integer;
        v_cond := v_delay > v_tolerance * 60;
        if v_cond then
          v_severity := case when v_delay > 15 * 60 then 'critical' else 'warning' end;
          v_message := format('%s sera en retard d''environ %s min', d.first_name, greatest(1, round(v_delay / 60.0))::integer);
          v_data := jsonb_build_object(
            'delay_minutes', greatest(1, round(v_delay / 60.0))::integer,
            'eta_minutes', ceil(v_eta / 60.0)::integer,
            'distance_m', v_dist,
            'expected_at', now() + make_interval(secs => v_eta),
            'reference_at', v_ref,
            'pickup_at', r.pickup_at,
            'tolerance_minutes', v_tolerance);
        end if;
      end if;
    end if;
    v_res := private.apply_ride_alert(r, d, 'late', v_cond, v_severity, v_message, v_data);
    v_opened := v_opened + case when v_res = 'opened' then 1 else 0 end;
    v_updated := v_updated + case when v_res = 'updated' then 1 else 0 end;
    v_resolved := v_resolved + case when v_res = 'resolved' then 1 else 0 end;

    -- ---------------------------------------------------------------- immobile
    v_cond := false;
    v_severity := null;
    v_message := null;
    v_data := null;
    if r.status = 'DRIVER_EN_ROUTE' or (r.status = 'ACCEPTED' and r.type = 'instant') then
      if not v_fresh then
        v_cond := null;
      elsif v_dist <= 800 then
        v_cond := false;
      else
        -- Censé rouler depuis : départ « en route » (ou acceptation d'une instantanée)
        v_start := coalesce(
          case when r.status = 'DRIVER_EN_ROUTE' then coalesce(r.driver_en_route_at, r.accepted_at) else r.accepted_at end,
          now());
        -- Dernier point à plus de 150 m de la position actuelle, puis premier point « sur place » après lui
        select max(h.recorded_at) into v_last_away
        from public.driver_location_history h
        where h.driver_id = d.id
          and h.recorded_at >= greatest(v_start - interval '2 minutes', now() - interval '2 hours')
          and coalesce(h.accuracy_m, 0) <= 500
          and extensions.st_distance(
                extensions.st_setsrid(extensions.st_makepoint(h.lng, h.lat), 4326)::extensions.geography,
                l.location) > 150;
        select min(h.recorded_at) into v_since
        from public.driver_location_history h
        where h.driver_id = d.id
          and h.recorded_at >= greatest(v_start - interval '2 minutes', now() - interval '2 hours')
          and h.recorded_at > coalesce(v_last_away, '-infinity'::timestamptz)
          and coalesce(h.accuracy_m, 0) <= 500;
        if v_since is null then
          v_cond := false; -- pas d'historique : aucune preuve d'immobilité
        else
          v_since := greatest(v_since, v_start);
          v_still := floor(extract(epoch from (now() - v_since)) / 60)::integer;
          v_cond := v_since <= now() - make_interval(mins => v_stall_min);
          if v_cond then
            v_severity := case when v_still >= 2 * v_stall_min then 'critical' else 'warning' end;
            v_message := format('%s est immobile depuis %s min, à %s du départ', d.first_name, v_still, v_dist_label);
            v_data := jsonb_build_object(
              'still_minutes', v_still,
              'since', v_since,
              'distance_m', v_dist,
              'lat', l.lat,
              'lng', l.lng,
              'threshold_minutes', v_stall_min);
          end if;
        end if;
      end if;
    end if;
    v_res := private.apply_ride_alert(r, d, 'stalled', v_cond, v_severity, v_message, v_data);
    v_opened := v_opened + case when v_res = 'opened' then 1 else 0 end;
    v_updated := v_updated + case when v_res = 'updated' then 1 else 0 end;
    v_resolved := v_resolved + case when v_res = 'resolved' then 1 else 0 end;

    -- ---------------------------------------------------------------- GPS muet
    v_cond := false;
    v_severity := null;
    v_message := null;
    v_data := null;
    if r.status <> 'ACCEPTED' or r.type = 'instant' then
      v_cond := not v_fresh;
      if v_cond then
        v_severity := case when not v_has_loc or v_age >= 600 then 'critical' else 'warning' end;
        v_message := case
          when not v_has_loc then format('Aucune position GPS reçue de %s', d.first_name)
          else format('Plus de position GPS de %s depuis %s min', d.first_name, greatest(1, v_age / 60))
        end;
        v_data := jsonb_build_object(
          'last_location_at', case when v_has_loc then l.updated_at end,
          'location_age_s', v_age,
          'max_age_s', v_gps_max,
          'lat', case when v_has_loc then l.lat end,
          'lng', case when v_has_loc then l.lng end);
      end if;
    end if;
    v_res := private.apply_ride_alert(r, d, 'no_gps', v_cond, v_severity, v_message, v_data);
    v_opened := v_opened + case when v_res = 'opened' then 1 else 0 end;
    v_updated := v_updated + case when v_res = 'updated' then 1 else 0 end;
    v_resolved := v_resolved + case when v_res = 'resolved' then 1 else 0 end;

    -- ---------------------------------------------------------------- planifiée non démarrée
    v_cond := false;
    v_severity := null;
    v_message := null;
    v_data := null;
    if r.status = 'ACCEPTED' and r.type = 'scheduled' and r.pickup_at <= now() + interval '30 minutes' then
      v_cond := d.presence = 'offline' or not v_fresh;
      if v_cond then
        v_severity := case when r.pickup_at <= now() + interval '15 minutes' then 'critical' else 'warning' end;
        v_message := format('%s n''a pas démarré — prise en charge à %s, chauffeur %s', d.first_name,
          to_char(r.pickup_at at time zone coalesce(v_tz, 'Europe/Paris'), 'HH24:MI'),
          case when d.presence = 'offline' then 'hors ligne' else 'sans position GPS' end);
        v_data := jsonb_build_object(
          'pickup_at', r.pickup_at,
          'minutes_to_pickup', ceil(extract(epoch from (r.pickup_at - now())) / 60)::integer,
          'presence', d.presence,
          'last_location_at', case when v_has_loc then l.updated_at end,
          'location_age_s', v_age);
      end if;
    end if;
    v_res := private.apply_ride_alert(r, d, 'not_started', v_cond, v_severity, v_message, v_data);
    v_opened := v_opened + case when v_res = 'opened' then 1 else 0 end;
    v_updated := v_updated + case when v_res = 'updated' then 1 else 0 end;
    v_resolved := v_resolved + case when v_res = 'resolved' then 1 else 0 end;
  end loop;

  return jsonb_build_object('ok', true, 'checked', v_checked, 'opened', v_opened, 'updated', v_updated,
    'resolved', v_resolved, 'skipped', v_skipped);
end;
$$;

-- ----------------------------------------------------------------- « Garder » (sourdine 15 min)
create or replace function public.acknowledge_ride_alert(p_alert_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.ride_alerts;
  v_org uuid;
  v_ride uuid;
begin
  select organization_id, ride_id into v_org, v_ride from public.ride_alerts where id = p_alert_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'ALERT_NOT_FOUND', 'message', 'Alerte introuvable.');
  end if;
  perform private.assert_org_member(v_org, array['owner', 'admin', 'dispatcher']::public.org_role[]);
  perform private.set_actor('user', auth.uid());

  -- ordre de verrouillage : course → alerte (comme watch_rides / reassign_ride)
  perform 1 from public.rides where id = v_ride for update;
  select * into a from public.ride_alerts where id = p_alert_id for update;

  if a.status = 'acknowledged' then
    return jsonb_build_object('ok', true, 'code', 'ALREADY_ACKNOWLEDGED', 'message', 'Alerte déjà en sourdine.',
      'alert', private.ride_alert_payload(a, 'update'));
  end if;
  if a.status <> 'open' then
    return jsonb_build_object('ok', false, 'code', 'ALERT_CLOSED', 'message', 'Alerte déjà traitée.',
      'alert', private.ride_alert_payload(a, 'update'));
  end if;

  update public.ride_alerts
     set status = 'acknowledged', resolution = 'kept', muted_until = now() + interval '15 minutes', resolved_by = auth.uid()
   where id = a.id
  returning * into a;

  perform private.log_event(a.organization_id, a.ride_id, 'alert.kept',
    format('Alerte « %s » : la centrale garde %s — pas de nouvelle alerte pendant 15 min',
      private.ride_alert_label(a.kind), coalesce(a.data ->> 'driver_name', 'le chauffeur')),
    'timeline', 'info', jsonb_build_object('alert_id', a.id, 'kind', a.kind, 'muted_until', a.muted_until),
    'user', auth.uid());

  return jsonb_build_object('ok', true, 'code', 'ACKNOWLEDGED', 'message', 'Alerte mise en sourdine 15 min.',
    'alert', private.ride_alert_payload(a, 'update'));
end;
$$;

-- ----------------------------------------------------------------- « Relancer » : retirer la course au chauffeur
create or replace function public.reassign_ride(p_ride_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  d public.drivers;
  v_threshold integer;
  v_type public.ride_type;
  v_reason text := left(nullif(trim(coalesce(p_reason, '')), ''), 300);
  v_closed uuid[];
  v_alerts integer;
  v_count integer;
  v_status public.ride_status;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_FOUND', 'message', 'Course introuvable.');
  end if;
  perform private.assert_org_member(r.organization_id, array['owner', 'admin', 'dispatcher']::public.org_role[]);
  perform private.set_actor('user', auth.uid());

  if r.driver_id is null or r.status not in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED') then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_REASSIGNABLE',
      'message', 'Seule une course attribuée et pas encore commencée peut être retirée au chauffeur.', 'status', r.status);
  end if;

  select * into d from public.drivers where id = r.driver_id;

  select s.instant_threshold_minutes into v_threshold
  from public.organization_settings s where s.organization_id = r.organization_id;
  v_type := case
    when greatest(r.pickup_at, now()) <= now() + make_interval(mins => coalesce(v_threshold, 45)) then 'instant'
    else 'scheduled'
  end::public.ride_type;

  -- 1. affectation libérée
  update public.ride_assignments
     set is_active = false, released_at = now(), release_reason = 'reassigned_by_dispatch'
   where ride_id = r.id and is_active;

  -- 2. offres : restes éventuels fermés + marqueur d'exclusion (ce chauffeur n'est plus
  --    sollicité pour cette course, ni par les vagues GPS ni par la flotte)
  v_closed := private.close_pending_offers(r.id, 'closed', 'reassigned_by_dispatch');
  insert into public.ride_offers (organization_id, ride_id, driver_id, status, mode, wave, sent_at, expires_at, responded_at, closed_reason)
  values (r.organization_id, r.id, r.driver_id, 'declined', 'geo', 0, now(), now(), now(), 'removed_by_dispatch');

  -- 3. chauffeur retiré : disponible si c'était sa course en cours
  update public.drivers
     set presence = 'available', current_ride_id = null
   where id = r.driver_id and current_ride_id = r.id;

  -- 4. notifications : rappels en file annulés, prévenir le chauffeur
  update public.notifications
     set status = 'cancelled'
   where ride_id = r.id and driver_id = r.driver_id and status = 'queued';
  perform private.queue_notification(r.organization_id, r.driver_id, r.id, null, 'ride_unassigned', 'COURSE RETIRÉE',
    format('La centrale a réattribué la course #%s', r.number),
    jsonb_build_object('type', 'ride_unassigned', 'ride_id', r.id, 'number', r.number, 'reason', v_reason), 'high', null);

  -- 5. course remise en recherche (type recalculé)
  update public.rides
     set status = 'SEARCHING_DRIVER',
         driver_id = null,
         vehicle_id = null,
         type = v_type,
         pickup_at = greatest(pickup_at, now()),
         dispatch_mode = case when v_type = 'instant' then 'geo' else 'fleet' end::public.dispatch_mode,
         dispatch_wave = 0,
         dispatch_radius_m = null,
         dispatch_started_at = now(),
         next_dispatch_at = null,
         accepted_at = null,
         driver_en_route_at = null,
         driver_arrived_at = null,
         no_driver_at = null
   where id = r.id;

  -- 6. alertes de la course : traitées par la relance
  v_alerts := private.close_ride_alerts(r.id, 'relaunched', auth.uid());

  perform private.log_event(r.organization_id, r.id, 'ride.reassigned',
    format('Course retirée à %s %s (#%s) par la centrale%s — nouvelle recherche',
      coalesce(d.first_name, 'chauffeur'), coalesce(d.last_name, ''), coalesce(d.number::text, '?'),
      coalesce(' : ' || v_reason, '')),
    'timeline', 'warning',
    jsonb_build_object('previous_driver_id', r.driver_id, 'previous_status', r.status, 'reason', v_reason,
      'type', v_type, 'closed_alerts', v_alerts, 'closed_offers', cardinality(v_closed)),
    'user', auth.uid());

  -- 7. nouvelle recherche : 4 km d'abord (instantanée) ou toute la flotte (planifiée)
  if v_type = 'instant' then
    v_count := private.run_geo_wave(r.id);
  else
    v_count := private.offer_to_fleet(r.id);
  end if;

  select status into v_status from public.rides where id = r.id;
  return jsonb_build_object('ok', true, 'code', 'RELAUNCHED', 'message', 'Course retirée au chauffeur — nouvelle recherche lancée.',
    'ride_id', r.id, 'previous_driver_id', r.driver_id, 'type', v_type, 'status', v_status,
    'notified', coalesce(v_count, 0), 'closed_alerts', v_alerts);
end;
$$;

-- ----------------------------------------------------------------- « Réattribuer » à un chauffeur choisi
-- Dernière définition : 20260924000400. Ajouts : réattribution possible en route / arrivé,
-- horodatages du chauffeur précédent remis à zéro, alertes closes ('reassigned').
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
  v_alerts integer;
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
  if r.status not in ('CREATED', 'SEARCHING_DRIVER', 'OFFERED', 'NO_DRIVER_FOUND', 'ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED') then
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
     set driver_id = d.id, vehicle_id = d.vehicle_id, status = 'ACCEPTED', accepted_at = now(), next_dispatch_at = null,
         driver_en_route_at = null, driver_arrived_at = null
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

  v_alerts := private.close_ride_alerts(r.id, 'reassigned', auth.uid());

  perform private.log_event(r.organization_id, r.id, 'ride.assigned_manually',
    format('Course attribuée manuellement à %s %s (#%s)', d.first_name, d.last_name, d.number),
    'timeline', 'success',
    jsonb_build_object('driver_id', d.id, 'previous_driver_id', v_previous, 'previous_status', r.status,
      'closed_offers', cardinality(v_closed), 'closed_alerts', v_alerts),
    'user', auth.uid());

  return jsonb_build_object('ok', true, 'code', 'ASSIGNED', 'ride_id', r.id);
end;
$$;

-- ----------------------------------------------------------------- acceptation : seule une offre « en attente »
-- Dernière définition : 20260924001900. Seul changement : une offre déjà « acceptée » est
-- refusée (OFFER_CLOSED). Sans cela, un chauffeur retiré par reassign_ride (course remise en
-- recherche) pourrait reprendre la course en ré-acceptant son ancienne offre.
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
  -- Relecture sous verrou : l'offre a pu être retirée entre-temps (hors ligne, fin de recherche…)
  select * into o from public.ride_offers where id = p_offer_id for update;
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

  if o.status in ('declined', 'closed', 'accepted') then
    return jsonb_build_object('ok', false, 'code', 'OFFER_CLOSED', 'message', 'Cette offre n''est plus disponible.');
  end if;
  -- Offre retirée (chauffeur passé hors ligne, relance, fin de fenêtre) ou périmée
  if o.status = 'expired' or (o.status = 'pending' and o.expires_at < now() - interval '3 seconds') then
    return jsonb_build_object('ok', false, 'code', 'OFFER_EXPIRED', 'message', 'Cette offre a expiré.');
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

-- ----------------------------------------------------------------- droits d'exécution (deny-by-default)
revoke execute on function
  private.ride_alert_label(text),
  private.ride_alert_payload(public.ride_alerts, text),
  private.broadcast_ride_alert(),
  private.close_ride_alerts(uuid, text, uuid),
  private.apply_ride_alert(public.rides, public.drivers, text, boolean, text, text, jsonb),
  private.watch_rides()
from public, anon, authenticated;
grant execute on function
  private.ride_alert_label(text),
  private.ride_alert_payload(public.ride_alerts, text),
  private.broadcast_ride_alert(),
  private.close_ride_alerts(uuid, text, uuid),
  private.apply_ride_alert(public.rides, public.drivers, text, boolean, text, text, jsonb),
  private.watch_rides()
to service_role;

revoke execute on function
  public.acknowledge_ride_alert(uuid),
  public.reassign_ride(uuid, text),
  public.assign_ride(uuid, uuid),
  public.accept_ride_offer(uuid)
from public, anon;
grant execute on function
  public.acknowledge_ride_alert(uuid),
  public.reassign_ride(uuid, text),
  public.assign_ride(uuid, uuid),
  public.accept_ride_offer(uuid)
to authenticated, service_role;
