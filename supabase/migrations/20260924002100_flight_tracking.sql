-- =============================================================================
-- Suivi des vols (prises en charge aéroport / dépôts pour un vol)
--
--  Worker ──► private.flights_to_check(n) : courses à vérifier (réservation SKIP LOCKED,
--             flight_checked_at posé immédiatement → un seul worker interroge le fournisseur)
--         ──► fournisseur de données de vol (hors base)
--         ──► private.apply_flight_status(...) : colonnes vol, prise en charge recalée
--             (mode arrivée), dispatch flotte / rappels recalés, journal + notification
--             chauffeur, diffusion temps réel (ride.updated enrichi, ride.event flight.*).
--
--  Mode (colonne générée rides.flight_mode) :
--    'arrival'   : départ de la course = aéroport → on attend le client à l'arrivée du vol ;
--                  horaires flight_*_arrival = ARRIVÉE du vol ; flight_origin = provenance.
--    'departure' : sinon (le client va prendre l'avion) → information seulement ;
--                  horaires flight_*_arrival = DÉPART du vol ; flight_origin = destination.
--
--  Ordre de verrouillage respecté : rides → ride_offers (jamais drivers ici).
-- =============================================================================

-- ----------------------------------------------------------------- aéroports
create or replace function private.is_airport_address(p_address text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(p_address, '') ~* (
    'a[eéÉ]roport|a[eéÉ]rogare|airport|aeropuerto|aeroporto|flughafen'
    || '|\mterminal\M|\mCDG\M|\mORY\M|\mBVA\M|roissy|\morly\M|beauvais|\mle[ -]bourget\M'
    || '|nice[ -]+c[oôÔ]te[ -]+d.?azur'
  );
$$;

-- Utilisée par la colonne générée rides.flight_mode : exécutable par tous les rôles qui
-- insèrent / modifient des courses (comme private.is_strictly_increasing, cf. 001700).
revoke all on function private.is_airport_address(text) from public, anon;
grant execute on function private.is_airport_address(text) to authenticated, service_role;

-- ----------------------------------------------------------------- colonnes
alter table public.rides
  add column flight_status text
    check (flight_status is null or flight_status in ('scheduled', 'delayed', 'departed', 'landed', 'cancelled', 'diverted', 'unknown')),
  add column flight_scheduled_arrival timestamptz,
  add column flight_estimated_arrival timestamptz,
  add column flight_actual_arrival timestamptz,
  add column flight_terminal text check (flight_terminal is null or char_length(flight_terminal) <= 20),
  add column flight_origin text check (flight_origin is null or char_length(flight_origin) <= 60),
  add column flight_delay_minutes integer,
  add column flight_checked_at timestamptz,
  add column pickup_at_original timestamptz,
  add column flight_mode text generated always as (
    case
      when nullif(btrim(flight_number), '') is null then null
      when private.is_airport_address(pickup_address) then 'arrival'
      else 'departure'
    end
  ) stored;

comment on column public.rides.flight_mode is
  'arrival : prise en charge à l''aéroport (horaires = arrivée du vol) ; departure : dépôt pour un vol (horaires = départ du vol)';
comment on column public.rides.pickup_at_original is
  'Heure de prise en charge demandée avant tout recalage automatique sur l''horaire du vol';

-- Lecture : GRANT SELECT de table déjà accordé à authenticated. Aucune écriture client :
-- les colonnes ne figurent pas dans les GRANT INSERT/UPDATE par colonne (cf. 0300).

create index rides_flight_watch_idx on public.rides (pickup_at)
  where flight_number is not null
    and status in ('CREATED', 'SEARCHING_DRIVER', 'OFFERED', 'ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED');

alter table public.organization_settings
  add column flight_tracking_enabled boolean not null default true,
  add column flight_pickup_buffer_minutes integer not null default 15
    check (flight_pickup_buffer_minutes between 0 and 120);

grant update (flight_tracking_enabled, flight_pickup_buffer_minutes) on public.organization_settings to authenticated;

-- ----------------------------------------------------------------- numéro de vol modifié
-- Nouveau vol saisi au dashboard : les données du vol précédent sont effacées (nouvelle
-- vérification immédiate). pickup_at_original (heure demandée) est conservée.
create or replace function private.reset_flight_tracking()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.flight_number is distinct from old.flight_number then
    new.flight_status := null;
    new.flight_scheduled_arrival := null;
    new.flight_estimated_arrival := null;
    new.flight_actual_arrival := null;
    new.flight_terminal := null;
    new.flight_origin := null;
    new.flight_delay_minutes := null;
    new.flight_checked_at := null;
  end if;
  return new;
end;
$$;

create trigger rides_flight_reset
  before update of flight_number on public.rides
  for each row execute function private.reset_flight_tracking();

-- ----------------------------------------------------------------- formats FR
-- « 35 min », « 1 h », « 1 h 20 » (valeur absolue)
create or replace function private.fmt_minutes(p_minutes integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_minutes is null then '—'
    when abs(p_minutes) < 60 then abs(p_minutes)::text || ' min'
    when abs(p_minutes) % 60 = 0 then (abs(p_minutes) / 60)::text || ' h'
    else (abs(p_minutes) / 60)::text || ' h ' || lpad((abs(p_minutes) % 60)::text, 2, '0')
  end;
$$;

-- « 15:20 », ou « 26/09 à 00:20 » si la date locale diffère de la référence
create or replace function private.fmt_local_time(p_at timestamptz, p_tz text, p_ref timestamptz default null)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_at is null then '—'
    when p_ref is null
      or (p_at at time zone coalesce(p_tz, 'Europe/Paris'))::date = (p_ref at time zone coalesce(p_tz, 'Europe/Paris'))::date
      then to_char(p_at at time zone coalesce(p_tz, 'Europe/Paris'), 'HH24:MI')
    else to_char(p_at at time zone coalesce(p_tz, 'Europe/Paris'), 'DD/MM à HH24:MI')
  end;
$$;

-- ----------------------------------------------------------------- worker : courses à vérifier
-- Réserve (SKIP LOCKED) et marque flight_checked_at = now() : deux workers n'interrogent
-- jamais le fournisseur pour la même course ; un échec du fournisseur est retenté au
-- prochain créneau (5 min si prise en charge < 3 h, 30 min sinon).
create or replace function private.flights_to_check(p_limit integer default 50)
returns table (
  id uuid,
  organization_id uuid,
  number bigint,
  flight_number text,
  flight_date date,
  mode text,
  timezone text,
  pickup_at timestamptz,
  flight_status text,
  flight_scheduled_arrival timestamptz
)
language sql
security definer
set search_path = ''
as $$
  with due as (
    select r.id
    from public.rides r
    join public.organization_settings s on s.organization_id = r.organization_id
    join public.organizations o on o.id = r.organization_id
    where r.flight_number is not null
      and btrim(r.flight_number) <> ''
      and s.flight_tracking_enabled
      and o.status = 'active'
      and r.status in ('CREATED', 'SEARCHING_DRIVER', 'OFFERED', 'ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED')
      and r.pickup_at between now() - interval '3 hours' and now() + interval '24 hours'
      and coalesce(r.flight_status, '') not in ('landed', 'cancelled')
      and (
        r.flight_checked_at is null
        or r.flight_checked_at < now() - case
             when r.pickup_at < now() + interval '3 hours' then interval '5 minutes'
             else interval '30 minutes'
           end
      )
    order by r.pickup_at
    limit greatest(1, least(coalesce(p_limit, 50), 500))
    for update of r skip locked
  ),
  claimed as (
    update public.rides r
       set flight_checked_at = now()
      from due
     where r.id = due.id
    returning r.*
  )
  select c.id,
         c.organization_id,
         c.number,
         upper(regexp_replace(c.flight_number, '\s+', '', 'g')),
         ((case
             when c.flight_scheduled_arrival is not null then c.flight_scheduled_arrival
             when c.flight_mode = 'arrival'
               then coalesce(c.pickup_at_original, c.pickup_at) - make_interval(mins => s.flight_pickup_buffer_minutes)
             else coalesce(c.pickup_at_original, c.pickup_at)
           end) at time zone coalesce(o.timezone, 'Europe/Paris'))::date,
         c.flight_mode,
         coalesce(o.timezone, 'Europe/Paris'),
         c.pickup_at,
         c.flight_status,
         c.flight_scheduled_arrival
  from claimed c
  join public.organizations o on o.id = c.organization_id
  join public.organization_settings s on s.organization_id = c.organization_id
  order by c.pickup_at;
$$;

-- ----------------------------------------------------------------- worker : résultat fournisseur
create or replace function private.apply_flight_status(
  p_ride_id uuid,
  p_status text,
  p_scheduled timestamptz default null,
  p_estimated timestamptz default null,
  p_actual timestamptz default null,
  p_terminal text default null,
  p_origin text default null,
  p_provider text default null,
  p_flight_number text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  s public.organization_settings;
  v_tz text;
  v_raw text := lower(btrim(coalesce(p_status, '')));
  v_status text;
  v_scheduled timestamptz;
  v_estimated timestamptz;
  v_actual timestamptz;
  v_terminal text;
  v_origin text;
  v_delay integer;
  v_delay_raw numeric;
  v_flight text;
  v_mode text;
  v_eta timestamptz;
  v_ideal timestamptz;
  v_target timestamptz;
  v_reference timestamptz;
  v_lead interval;
  v_shift boolean := false;
  v_incoherent boolean := false;
  v_fleet boolean := false;
  v_changed boolean;
  v_status_changed boolean;
  v_terminal_changed boolean;
  v_at_label text;
  v_eta_label text;
  v_terminal_label text;
  v_shift_type text;
  v_shift_msg text;
  v_msg text;
  v_events text[] := '{}';
  v_data jsonb;
  v_notif_type text;
  v_notif_title text;
  v_notif_body text;
  v_notified boolean := false;
begin
  perform private.set_actor('system', null);

  -- Point de sérialisation (accept, dispatch_tick, annulation) : la ligne de la course
  select * into r from public.rides where id = p_ride_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_FOUND', 'message', 'Course introuvable.');
  end if;
  if nullif(btrim(r.flight_number), '') is null then
    return jsonb_build_object('ok', false, 'code', 'NO_FLIGHT', 'message', 'Aucun numéro de vol sur cette course.');
  end if;
  if r.status in ('COMPLETED', 'CANCELLED') then
    return jsonb_build_object('ok', false, 'code', 'RIDE_CLOSED', 'message', 'Course déjà clôturée.');
  end if;
  v_flight := upper(regexp_replace(r.flight_number, '\s+', '', 'g'));
  -- Numéro modifié au dashboard pendant l'interrogation du fournisseur : résultat obsolète
  if p_flight_number is not null and upper(regexp_replace(p_flight_number, '\s+', '', 'g')) <> v_flight then
    return jsonb_build_object('ok', false, 'code', 'FLIGHT_CHANGED', 'message', 'Le numéro de vol a changé entre-temps.');
  end if;

  select * into s from public.organization_settings where organization_id = r.organization_id;
  if not coalesce(s.flight_tracking_enabled, true) then
    return jsonb_build_object('ok', false, 'code', 'TRACKING_DISABLED', 'message', 'Suivi des vols désactivé.');
  end if;
  select o.timezone into v_tz from public.organizations o where o.id = r.organization_id;
  v_tz := coalesce(v_tz, 'Europe/Paris');
  v_lead := make_interval(mins => coalesce(s.scheduled_dispatch_lead_minutes, 60));

  v_mode := coalesce(r.flight_mode, case when private.is_airport_address(r.pickup_address) then 'arrival' else 'departure' end);

  -- Statut normalisé (vocabulaires fournisseurs courants) ; « inconnu » ne remplace pas un statut connu
  v_status := case
    when v_raw in ('scheduled', 'delayed', 'departed', 'landed', 'cancelled', 'diverted', 'unknown') then v_raw
    when v_raw in ('canceled', 'cancelled_flight') then 'cancelled'
    when v_raw in ('active', 'airborne', 'en-route', 'en_route', 'enroute', 'in_air', 'inflight', 'in-flight') then 'departed'
    when v_raw in ('arrived', 'landed_arrived') then 'landed'
    when v_raw in ('expected', 'on_time', 'ontime', 'on-time', 'planned') then 'scheduled'
    when v_raw in ('redirected') then 'diverted'
    else 'unknown'
  end;
  if v_status = 'unknown' and r.flight_status is not null then
    v_status := r.flight_status;
  end if;

  -- Valeurs absentes de la réponse : on garde la dernière valeur connue
  v_scheduled := coalesce(p_scheduled, r.flight_scheduled_arrival);
  v_estimated := coalesce(p_estimated, r.flight_estimated_arrival);
  v_actual := coalesce(p_actual, r.flight_actual_arrival);
  v_terminal := coalesce(left(nullif(btrim(p_terminal), ''), 20), r.flight_terminal);
  v_origin := coalesce(left(nullif(btrim(p_origin), ''), 60), r.flight_origin);

  -- Retard = arrivée (réelle, sinon estimée) − prévue
  if v_scheduled is not null and coalesce(v_actual, v_estimated) is not null then
    v_delay_raw := round(extract(epoch from (coalesce(v_actual, v_estimated) - v_scheduled)) / 60.0);
    v_delay := case when abs(v_delay_raw) <= 100000 then v_delay_raw::integer end;
  else
    v_delay := r.flight_delay_minutes;
  end if;
  if v_status = 'scheduled' and coalesce(v_delay, 0) >= 15 then
    v_status := 'delayed';
  end if;

  v_status_changed := v_status is distinct from r.flight_status;
  v_terminal_changed := r.flight_terminal is not null and v_terminal is distinct from r.flight_terminal;
  v_changed := v_status_changed
    or v_scheduled is distinct from r.flight_scheduled_arrival
    or v_estimated is distinct from r.flight_estimated_arrival
    or v_actual is distinct from r.flight_actual_arrival
    or v_terminal is distinct from r.flight_terminal
    or v_origin is distinct from r.flight_origin
    or v_delay is distinct from r.flight_delay_minutes;

  v_eta := coalesce(v_actual, v_estimated, v_scheduled);
  v_reference := coalesce(r.pickup_at_original, r.pickup_at);

  -- Mode arrivée : prise en charge = arrivée (réelle | estimée | prévue) + marge, jamais dans le passé
  if v_mode = 'arrival'
     and v_eta is not null
     and v_status not in ('cancelled', 'diverted')
     and r.status in ('CREATED', 'SEARCHING_DRIVER', 'OFFERED', 'ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'NO_DRIVER_FOUND')
  then
    v_ideal := date_trunc('minute', v_eta) + make_interval(mins => coalesce(s.flight_pickup_buffer_minutes, 15));
    if abs(extract(epoch from (v_ideal - v_reference))) > 86400 then
      -- Plus de 24 h d'écart avec l'heure demandée : mauvais vol / mauvaise date → pas de recalage
      v_incoherent := true;
    else
      v_target := greatest(v_ideal, now());
      -- Comparaison des heures « effectives » (une heure déjà passée vaut maintenant) : pas de
      -- recalage répété vers now() quand l'heure idéale est déjà dépassée.
      v_shift := abs(extract(epoch from (v_target - greatest(r.pickup_at, now())))) >= 300;
    end if;
  end if;

  v_fleet := v_shift and r.dispatch_mode = 'fleet' and r.driver_id is null and r.status in ('SEARCHING_DRIVER', 'OFFERED');

  update public.rides
     set flight_status = v_status,
         flight_scheduled_arrival = v_scheduled,
         flight_estimated_arrival = v_estimated,
         flight_actual_arrival = v_actual,
         flight_terminal = v_terminal,
         flight_origin = v_origin,
         flight_delay_minutes = v_delay,
         flight_checked_at = now(),
         pickup_at_original = case when v_shift then coalesce(pickup_at_original, pickup_at) else pickup_at_original end,
         pickup_at = case when v_shift then v_target else pickup_at end,
         -- Planifiée proposée à la flotte : bascule GPS recalée (T-lead), au plus tard dans 5 min
         next_dispatch_at = case when v_fleet then least(v_target - v_lead, now() + interval '5 minutes') else next_dispatch_at end
   where id = r.id;

  if v_fleet then
    update public.ride_offers
       set expires_at = greatest(v_target - v_lead, now() + make_interval(secs => coalesce(s.offer_timeout_seconds, 30)))
     where ride_id = r.id and status = 'pending' and mode = 'fleet';
  end if;

  if v_shift and r.driver_id is not null then
    perform private.schedule_reminders(r.id);
  end if;

  -- ------------------------------------------------------------- journal
  v_at_label := private.fmt_local_time(v_target, v_tz, v_reference);
  v_eta_label := private.fmt_local_time(v_eta, v_tz, v_reference);
  v_terminal_label := case when v_terminal is not null then format(' (terminal %s)', v_terminal) else '' end;
  v_data := jsonb_build_object(
    'flight_number', v_flight, 'mode', v_mode, 'flight_status', v_status, 'previous_status', r.flight_status,
    'delay_minutes', v_delay, 'scheduled', v_scheduled, 'estimated', v_estimated, 'actual', v_actual,
    'terminal', v_terminal, 'origin', v_origin, 'provider', left(p_provider, 40),
    'pickup_at', case when v_shift then v_target else r.pickup_at end,
    'previous_pickup_at', r.pickup_at,
    'pickup_at_original', case when v_shift then coalesce(r.pickup_at_original, r.pickup_at) else r.pickup_at_original end);

  if v_shift then
    if coalesce(v_delay, 0) >= 5 then
      v_shift_type := 'flight.delayed';
      v_shift_msg := format('Vol %s retardé de %s — prise en charge à %s', v_flight, private.fmt_minutes(v_delay), v_at_label);
    elsif coalesce(v_delay, 0) <= -5 then
      v_shift_type := 'flight.early';
      v_shift_msg := format('Vol %s en avance de %s — prise en charge à %s', v_flight, private.fmt_minutes(v_delay), v_at_label);
    else
      v_shift_type := 'flight.updated';
      v_shift_msg := format('Vol %s — prise en charge ajustée à %s (arrivée %s + %s min)', v_flight, v_at_label, v_eta_label,
        coalesce(s.flight_pickup_buffer_minutes, 15));
    end if;
    perform private.log_event(r.organization_id, r.id, v_shift_type, v_shift_msg, 'timeline',
      case when v_shift_type = 'flight.delayed' and v_delay >= 15 then 'warning' else 'info' end::public.event_level,
      v_data, 'system', null);
    v_events := v_events || v_shift_type;
  end if;

  if v_status_changed and v_status = 'landed' and v_mode = 'arrival' then
    v_msg := format('Vol %s atterri%s%s', v_flight,
      case when v_actual is not null then ' à ' || private.fmt_local_time(v_actual, v_tz, v_reference) else '' end, v_terminal_label);
    perform private.log_event(r.organization_id, r.id, 'flight.landed', v_msg, 'timeline', 'success', v_data, 'system', null);
    v_events := v_events || 'flight.landed'::text;
  end if;

  if v_status_changed and v_status = 'cancelled' then
    perform private.log_event(r.organization_id, r.id, 'flight.cancelled', format('Vol %s annulé', v_flight),
      'timeline', 'warning', v_data, 'system', null);
    v_events := v_events || 'flight.cancelled'::text;
  end if;

  if v_status_changed and v_status = 'diverted' then
    perform private.log_event(r.organization_id, r.id, 'flight.updated', format('Vol %s dérouté', v_flight),
      'timeline', 'warning', v_data, 'system', null);
    v_events := v_events || 'flight.diverted'::text;
  end if;

  -- Mode départ : information seulement (retard significatif au départ)
  if v_mode = 'departure' and v_status <> 'cancelled' and coalesce(v_delay, 0) >= 15
     and (r.flight_delay_minutes is null or r.flight_delay_minutes < 15 or abs(v_delay - r.flight_delay_minutes) >= 15)
  then
    perform private.log_event(r.organization_id, r.id, 'flight.delayed',
      format('Vol %s retardé de %s au départ — prise en charge inchangée', v_flight, private.fmt_minutes(v_delay)),
      'timeline', 'warning', v_data, 'system', null);
    v_events := v_events || 'flight.departure_delayed'::text;
  end if;

  if v_terminal_changed then
    perform private.log_event(r.organization_id, r.id, 'flight.updated',
      format('Vol %s : changement de terminal — %s (au lieu de %s)', v_flight, v_terminal, r.flight_terminal),
      'timeline', 'info', v_data, 'system', null);
    v_events := v_events || 'flight.terminal'::text;
  end if;

  if v_incoherent and (v_scheduled is distinct from r.flight_scheduled_arrival or v_status_changed) then
    perform private.log_event(r.organization_id, r.id, 'flight.updated',
      format('Horaires du vol %s incohérents avec la prise en charge — vérifiez le numéro de vol', v_flight),
      'timeline', 'warning', v_data, 'system', null);
    v_events := v_events || 'flight.incoherent'::text;
  end if;

  -- Autre changement de statut (1re information, décollage…) : une ligne de suivi
  if cardinality(v_events) = 0 and v_status_changed and v_status <> 'unknown' then
    v_msg := case
      when r.flight_status is null and v_mode = 'arrival' then
        format('Vol %s suivi — arrivée %s à %s%s', v_flight,
          case when v_actual is not null then 'effective' when v_estimated is not null then 'estimée' else 'prévue' end,
          v_eta_label, v_terminal_label)
      when r.flight_status is null then
        format('Vol %s suivi — départ %s à %s%s', v_flight,
          case when v_actual is not null then 'effectif' when v_estimated is not null then 'estimé' else 'prévu' end,
          v_eta_label, v_terminal_label)
      else
        format('Vol %s %s%s', v_flight,
          case v_status
            when 'scheduled' then 'à l''heure'
            when 'delayed' then 'annoncé en retard'
            when 'departed' then 'a décollé'
            when 'landed' then 'arrivé à destination'
            else v_status
          end,
          case when v_mode = 'arrival' and v_eta is not null and v_status <> 'landed' then ' — arrivée estimée à ' || v_eta_label else '' end)
    end;
    if v_eta is not null or r.flight_status is not null then
      perform private.log_event(r.organization_id, r.id, 'flight.updated', v_msg, 'timeline', 'info', v_data, 'system', null);
      v_events := v_events || 'flight.updated'::text;
    end if;
  end if;

  -- ------------------------------------------------------------- notification chauffeur (une seule)
  if r.driver_id is not null then
    if 'flight.cancelled' = any (v_events) then
      v_notif_type := 'flight.cancelled';
      v_notif_title := 'VOL ANNULÉ';
      v_notif_body := format('Le vol %s est annulé — attendez les consignes de la centrale', v_flight);
    elsif 'flight.landed' = any (v_events) then
      v_notif_type := 'flight.landed';
      v_notif_title := 'VOL ATTERRI';
      v_notif_body := format('Le vol %s a atterri%s', v_flight, v_terminal_label)
        || case when v_shift then ' — prise en charge à ' || v_at_label else '' end;
    elsif v_shift then
      v_notif_type := v_shift_type;
      v_notif_title := case v_shift_type when 'flight.delayed' then 'VOL RETARDÉ' when 'flight.early' then 'VOL EN AVANCE' else 'HORAIRE MODIFIÉ' end;
      v_notif_body := v_shift_msg;
    elsif 'flight.diverted' = any (v_events) and v_mode = 'arrival' then
      v_notif_type := 'flight.diverted';
      v_notif_title := 'VOL DÉROUTÉ';
      v_notif_body := format('Le vol %s est dérouté — attendez les consignes de la centrale', v_flight);
    elsif 'flight.departure_delayed' = any (v_events) then
      v_notif_type := 'flight.departure_delayed';
      v_notif_title := 'VOL RETARDÉ';
      v_notif_body := format('Vol %s retardé de %s au départ — prise en charge inchangée à %s', v_flight,
        private.fmt_minutes(v_delay), private.fmt_local_time(r.pickup_at, v_tz, null));
    elsif 'flight.terminal' = any (v_events) and v_mode = 'arrival' then
      v_notif_type := 'flight.terminal';
      v_notif_title := 'TERMINAL MODIFIÉ';
      v_notif_body := format('Vol %s : arrivée au terminal %s', v_flight, v_terminal);
    end if;

    if v_notif_title is not null then
      perform private.queue_notification(r.organization_id, r.driver_id, r.id, null, 'flight_update', v_notif_title, v_notif_body,
        jsonb_build_object(
          'type', 'flight_update', 'event', v_notif_type, 'ride_id', r.id, 'flight_number', v_flight,
          'flight_status', v_status, 'delay_minutes', v_delay, 'terminal', v_terminal,
          'pickup_at', case when v_shift then v_target else r.pickup_at end,
          'pickup_at_original', case when v_shift then coalesce(r.pickup_at_original, r.pickup_at) else r.pickup_at_original end),
        'high', null);
      v_notified := true;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'code', case when v_changed or v_shift then 'UPDATED' else 'UNCHANGED' end,
    'ride_id', r.id,
    'mode', v_mode,
    'flight_status', v_status,
    'delay_minutes', v_delay,
    'pickup_changed', v_shift,
    'pickup_at', case when v_shift then v_target else r.pickup_at end,
    'previous_pickup_at', r.pickup_at,
    'pickup_at_original', case when v_shift then coalesce(r.pickup_at_original, r.pickup_at) else r.pickup_at_original end,
    'events', to_jsonb(v_events),
    'notified', v_notified);
end;
$$;

-- ----------------------------------------------------------------- temps réel
-- Dernière définition : 20260924001800. Ajouts : champs vol (+ heure d'origine) ; pas de
-- diffusion quand seule la date de vérification du vol change (réservation / « rien de neuf »).
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
  if tg_op = 'UPDATE' and new.flight_checked_at is distinct from old.flight_checked_at then
    if (to_jsonb(new) - '{flight_checked_at,updated_at}'::text[]) = (to_jsonb(old) - '{flight_checked_at,updated_at}'::text[]) then
      return null;
    end if;
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
      'created_at', v.created_at, 'updated_at', v.updated_at)
    || jsonb_build_object(
      'flight_number', v.flight_number, 'flight_mode', v.flight_mode, 'flight_status', v.flight_status,
      'flight_scheduled_arrival', v.flight_scheduled_arrival, 'flight_estimated_arrival', v.flight_estimated_arrival,
      'flight_actual_arrival', v.flight_actual_arrival, 'flight_delay_minutes', v.flight_delay_minutes,
      'flight_terminal', v.flight_terminal, 'flight_origin', v.flight_origin, 'flight_checked_at', v.flight_checked_at,
      'pickup_at_original', v.pickup_at_original),
    'ride.updated', 'org:' || v.organization_id::text, true);

  if v.driver_id is not null then
    perform realtime.send(
      jsonb_build_object('id', v.id, 'status', v.status, 'driver_id', v.driver_id, 'updated_at', v.updated_at,
        'pickup_at', v.pickup_at, 'pickup_at_original', v.pickup_at_original,
        'flight_status', v.flight_status, 'flight_delay_minutes', v.flight_delay_minutes),
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

-- ----------------------------------------------------------------- offres chauffeur
-- Dernière définition : 20260924001400. Ajout des champs vol.
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
    'route_polyline', r.route_polyline,
    'flight_number', r.flight_number,
    'comment', r.comment,
    'sent_at', o.sent_at,
    'expires_at', o.expires_at
  ) || jsonb_build_object(
    'flight_mode', r.flight_mode,
    'flight_status', r.flight_status,
    'flight_scheduled_arrival', r.flight_scheduled_arrival,
    'flight_estimated_arrival', r.flight_estimated_arrival,
    'flight_actual_arrival', r.flight_actual_arrival,
    'flight_delay_minutes', r.flight_delay_minutes,
    'flight_terminal', r.flight_terminal,
    'flight_origin', r.flight_origin,
    'pickup_at_original', r.pickup_at_original
  ) order by r.type, o.sent_at desc), '[]'::jsonb)
  from public.ride_offers o
  join public.rides r on r.id = o.ride_id
  where o.driver_id = private.current_driver_id()
    and o.status = 'pending'
    and r.driver_id is null
    and r.status in ('SEARCHING_DRIVER', 'OFFERED');
$$;

-- ----------------------------------------------------------------- droits
revoke all on function
  private.reset_flight_tracking(),
  private.fmt_minutes(integer),
  private.fmt_local_time(timestamptz, text, timestamptz),
  private.flights_to_check(integer),
  private.apply_flight_status(uuid, text, timestamptz, timestamptz, timestamptz, text, text, text, text),
  private.broadcast_ride()
from public, anon, authenticated;
grant execute on function
  private.fmt_minutes(integer),
  private.fmt_local_time(timestamptz, text, timestamptz),
  private.flights_to_check(integer),
  private.apply_flight_status(uuid, text, timestamptz, timestamptz, timestamptz, text, text, text, text)
to service_role;

revoke execute on function public.driver_offers() from public, anon;
grant execute on function public.driver_offers() to authenticated, service_role;
