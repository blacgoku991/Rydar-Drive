-- =============================================================================
-- Rydar Drive — Position EN DIRECT uniquement (retour utilisateur sur 20260924003200).
-- « Je ne veux pas de dernière position : la position doit rester active téléphone verrouillé ou dans une
--   autre application. »
--
--  * Dispatch : seuls les chauffeurs dont la position est fraîche (location_max_age_seconds, 180 s par
--    défaut) sont sollicités. Fin de la tolérance de 30 min sur la dernière position connue (003200).
--  * L'app envoie sa position en continu (tâche GPS de fond, service Android, battement). Si elle n'arrive plus
--    depuis 90 s : push SILENCIEUX « location_ping » (ni alerte ni son) qui réveille l'app → suivi GPS relancé,
--    position fraîche envoyée. Puis toutes les 20 min tant que la position n'arrive pas (Apple recommande 2 à 3
--    réveils par heure au plus) ; worker, private.watch_driver_gps, toutes les 30 s. Priorité « normal » (les
--    offres passent devant), un seul essai, périmé après 1 min (claim_notifications / complete_notification).
--  * Au-delà de location_max_age_seconds : push visible « POSITION NON REÇUE », une fois par coupure
--    (application fermée à la main : seul le chauffeur peut la rouvrir).
--  * Le chauffeur n'est JAMAIS retiré : plus de passage hors ligne automatique (« fantômes » du ménage,
--    15 min depuis 000400, 30 min en 003200). Il reste en ligne jusqu'à ce qu'il se mette hors ligne.
--  * Corrections de la revue de 003200 : marqueurs GPS exclus du journal d'audit ; après « Relancer », le
--    marqueur « retiré par la centrale » ne compte plus comme une sollicitation (message et explication
--    corrects) ; un « Refuser » tardif (offre déjà close) ne raccourcit plus la vague en cours.
-- =============================================================================

-- Dernier réveil silencieux envoyé (limite : un toutes les 2 min par coupure)
alter table public.drivers add column if not exists gps_ping_at timestamptz;

-- ----------------------------------------------------------------- fenêtre = position fraîche
-- Utilisée par run_geo_wave (chauffeurs sollicités, « en ligne ») et explain_no_driver (20260924003200).
create or replace function private.dispatch_location_window(p_max_age_seconds integer)
returns interval
language sql
immutable
set search_path = ''
as $$
  select make_interval(secs => coalesce(p_max_age_seconds, 180));
$$;

-- ----------------------------------------------------------------- réveil puis alerte
-- Dernière définition : 20260924003200.
create or replace function private.watch_driver_gps()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  x record;
  v_pinged integer := 0;
  v_warned integer := 0;
begin
  for x in
    select d.id, d.organization_id, d.gps_ping_at, d.gps_lost_notified_at,
           -- dernière activité : dernier point reçu, ou passage en ligne s'il est plus récent
           greatest(l.updated_at, d.online_since) as last_at,
           make_interval(secs => coalesce(s.location_max_age_seconds, 180)) as fresh
    from public.drivers d
    left join public.driver_locations l on l.driver_id = d.id
    left join public.organization_settings s on s.organization_id = d.organization_id
    where d.status = 'active'
      and d.presence <> 'offline'
      and greatest(l.updated_at, d.online_since) < now() - interval '90 seconds'
    order by d.id
    for update of d skip locked
  loop
    -- Réveil silencieux : premier de la coupure, puis toutes les 20 min
    if x.gps_ping_at is null or x.gps_ping_at < x.last_at or x.gps_ping_at < now() - interval '20 minutes' then
      update public.drivers set gps_ping_at = now() where id = x.id;
      -- Un seul réveil en file par chauffeur (les précédents, périmés, sont annulés)
      update public.notifications
         set status = 'cancelled'
       where driver_id = x.id and type = 'location_ping' and status = 'queued';
      perform private.queue_notification(x.organization_id, x.id, null, null, 'location_ping', 'Rydar Drive',
        'Actualisation de la position', jsonb_build_object('type', 'location_ping'), 'normal', null);
      v_pinged := v_pinged + 1;
    end if;

    -- Position plus fraîche (réveils sans effet : application fermée) : le chauffeur est prévenu, une fois par coupure
    if x.last_at < now() - x.fresh
       and (x.gps_lost_notified_at is null or x.gps_lost_notified_at < x.last_at) then
      update public.drivers set gps_lost_notified_at = now() where id = x.id;
      perform private.queue_notification(x.organization_id, x.id, null, null, 'gps_lost', 'POSITION NON REÇUE',
        'Rydar Drive ne reçoit plus votre position. Ouvrez l''application pour continuer à recevoir les courses.',
        jsonb_build_object('type', 'gps_lost'), 'high', null);
      v_warned := v_warned + 1;
    end if;
  end loop;
  return jsonb_build_object('location_ping', v_pinged, 'gps_lost', v_warned);
end;
$$;

-- ----------------------------------------------------------------- ménage : plus aucun passage hors ligne automatique
-- Dernière définition : 20260924003200.
create or replace function private.housekeeping()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_history integer;
  v_logs integer;
  v_docs integer;
  v_notifs integer;
  v_chat integer;
begin
  -- Le chauffeur en ligne n'est jamais passé hors ligne par le système : sa position est maintenue en direct par
  -- l'app (et les réveils silencieux de private.watch_driver_gps) ; il se met hors ligne lui-même.

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
  -- Réveils silencieux : sans intérêt au-delà d'un jour
  delete from public.notifications
   where (created_at < now() - interval '90 days' and status in ('sent', 'cancelled'))
      or (type = 'location_ping' and created_at < now() - interval '1 day');
  get diagnostics v_notifs = row_count;
  delete from public.chat_messages where created_at < now() - interval '180 days';
  get diagnostics v_chat = row_count;

  return jsonb_build_object('history_purged', v_history, 'api_logs_purged', v_logs,
    'documents_expired', v_docs, 'notifications_purged', v_notifs, 'chat_purged', v_chat);
end;
$$;

-- ----------------------------------------------------------------- revue de 003200
-- Journal d'audit : dernière définition 20260924000700 (+ marqueurs GPS ignorés).
create or replace function private.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ignored text[] := array['updated_at', 'presence', 'last_seen_at', 'current_ride_id', 'online_since',
                             'ride_counter', 'driver_counter', 'last_used_at', 'last_used_ip',
                             -- marqueurs techniques du suivi GPS (20260924003200 / 003300)
                             'gps_lost_notified_at', 'gps_ping_at'];
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

-- Tick : dernière définition 20260924003200 (+ marqueur de retrait exclu du « déjà sollicité »).
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
        -- (le marqueur « retiré par la centrale » de reassign_ride n'est pas une sollicitation)
        if exists (select 1 from public.ride_offers o where o.ride_id = r.id and o.sent_at >= r.dispatch_started_at
                     and o.closed_reason is distinct from 'removed_by_dispatch') then
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

-- Refus : dernière définition 20260924000400 (+ accélération seulement si l'offre était ouverte).
create or replace function public.decline_ride_offer(p_offer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_driver public.drivers;
  o public.ride_offers;
  v_prev public.offer_status;
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
  select status into v_prev from public.ride_offers where id = o.id for update;

  update public.ride_offers
     set status = 'declined', responded_at = now()
   where id = o.id and status in ('pending', 'expired');
  if not found then
    return jsonb_build_object('ok', false, 'code', 'OFFER_CLOSED', 'message', 'Cette offre n''est plus disponible.');
  end if;

  perform private.release_offered_drivers(array[v_driver.id]);
  perform private.log_event(o.organization_id, o.ride_id, 'offer.declined', format('%s refuse la course', v_driver.first_name),
    'dispatch', 'info', jsonb_build_object('driver_id', v_driver.id, 'offer_id', o.id), 'driver', v_driver.id);

  -- Tous les chauffeurs ont répondu : on accélère la vague suivante — seulement si CETTE offre était encore
  -- ouverte (un « Refuser » tardif depuis une vieille notification ne raccourcit pas la vague en cours)
  update public.rides
     set next_dispatch_at = now()
   where id = o.ride_id
     and v_prev = 'pending'
     and status in ('SEARCHING_DRIVER', 'OFFERED')
     and dispatch_mode = 'geo'
     and not exists (select 1 from public.ride_offers x where x.ride_id = o.ride_id and x.status = 'pending');

  return jsonb_build_object('ok', true, 'code', 'DECLINED');
end;
$$;

-- ----------------------------------------------------------------- réveils : pas de réessai, périmés vite
-- Réclamation : dernière définition 20260924001700 (+ réveils de plus d'une minute annulés).
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
  -- worker arrêté en plein envoi : on remet en file après 2 min
  update public.notifications n
     set status = 'queued', last_error = 'worker_interrupted'
   where n.status = 'sending'
     and coalesce(n.claimed_at, n.created_at) < now() - interval '2 minutes';

  -- Réveil GPS silencieux périmé (plus d'une minute) : le suivant, s'il faut, est émis par watch_driver_gps
  update public.notifications n
     set status = 'cancelled', last_error = 'wake_expired'
   where n.status = 'queued'
     and n.type = 'location_ping'
     and n.created_at < now() - interval '1 minute';

  with stale as (
    update public.notifications n
       set status = 'cancelled', last_error = 'offer_closed'
      from public.ride_offers o
     where n.status = 'queued'
       and n.offer_id = o.id
       and n.type in ('ride_offer', 'ride_offer_scheduled')
       and o.status <> 'pending'
    returning n.id
  ),
  due as (
    select n.id
    from public.notifications n
    where n.status = 'queued'
      and n.channel = 'push'
      and n.scheduled_for <= now()
      and not exists (select 1 from stale s where s.id = n.id)
    order by n.priority = 'high' desc, n.scheduled_for
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update public.notifications n
       set status = 'sending', attempts = n.attempts + 1, claimed_at = now()
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

-- Fin d'envoi : dernière définition 20260924001200 (+ un seul essai pour un réveil).
create or replace function private.complete_notification(
  p_id uuid,
  p_ok boolean,
  p_error text default null,
  p_provider text default null,
  p_message_id text default null,
  p_retryable boolean default true
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  n public.notifications;
  v_max smallint;
begin
  select * into n from public.notifications where id = p_id for update;
  if not found then
    return;
  end if;
  if p_ok then
    update public.notifications
       set status = 'sent', sent_at = now(), provider = p_provider, provider_message_id = p_message_id, last_error = null
     where id = p_id;
    return;
  end if;
  -- Les offres sont urgentes : 2 tentatives maximum ; réveil GPS silencieux : 1 (utile tout de suite ou jamais,
  -- watch_driver_gps en émet un autre) ; le reste : 5.
  v_max := case when n.type = 'ride_offer' then 2 when n.type = 'location_ping' then 1 else 5 end;
  if p_retryable and n.attempts < v_max then
    update public.notifications
       set status = 'queued', last_error = left(p_error, 500), provider = p_provider,
           scheduled_for = now() + make_interval(secs => least(300, 5 * power(2, n.attempts)::int))
     where id = p_id;
  else
    update public.notifications
       set status = 'failed', last_error = left(p_error, 500), provider = p_provider
     where id = p_id;
  end if;
end;
$$;
