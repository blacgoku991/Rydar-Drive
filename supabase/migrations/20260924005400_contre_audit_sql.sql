-- =============================================================================
-- Contre-audit « sql » (tour 2) : correctifs incomplets des migrations 004400 → 005300.
--
--  1. Plafond « nouveau chauffeur » (sql1#0) : accepter une course SANS PRIX = même règle que l'envoi des offres
--     (private.centrale_blocker : prix absent = au-dessus du plafond). private.driver_blocker(id, prix, true) pour une
--     course ; driver_blocker(id, prix) inchangé hors course (accueil, Commissions, vue d'ensemble).
--  2. accept_ride_offer (sql1#1) : verrou FOR NO KEY UPDATE sur le chauffeur (au lieu de FOR UPDATE) — les deux
--     acceptations d'un même chauffeur restent sérialisées, sans interblocage avec dispatch_tick (FOR KEY SHARE des
--     insertions qui référencent le chauffeur).
--  3. Suivi des vols (sql1#3) : une course NO_DRIVER_FOUND n'est relancée par apply_flight_status qu'avec les
--     contrôles de redispatch_ride / assign_ride (frais plateforme en retard, quota mensuel :
--     private.ride_restart_blocker) ; sinon elle reste sans chauffeur (journal dispatch.relaunch_blocked).
--  4. Téléphone (sql2#0) : un bannissement dont l'empreinte date de l'ANCIENNE normalisation (avant 004600) et n'a pas
--     pu être recalculée (fiche supprimée, numéro modifié depuis) reste effectif : private.identity_hashes compare
--     aussi les formes anciennes du même numéro (identity_ban_scope, fraud_report_carriers) ; fiches qui ne tombent
--     sur un tel bannissement que par ces formes signalées une fois (comme le rattrapage 004600).
--  5. Compte conservé à la suppression / au bannissement plateforme (sql2#1, web_comptes#5) : une adhésion
--     « invitée » (invitation en attente, aucun accès) ne compte plus (private.keeps_login_account = règle de
--     public.svc_login_account_shared).
--  6. Jetons et activation (sql2#2, sql2#3) : jeton émis STRICTEMENT après la seconde d'activation ;
--     org_platform_status exige lui aussi un jeton postérieur à l'activation.
--  7. Suspension / archivage d'une centrale (sql2#4) : sessions fermées seulement pour ses membres ACTIFS sans autre
--     accès (autre centrale, fiche chauffeur active ou candidature, super admin) — comme la branche organization_users.
--  8. Super Admin donné à un compte existant (web_comptes#1) : users.super_admin_since (posé par
--     deploy/create-admin.sh) ; private.is_super_admin() exige un jeton émis après ; public.session_is_super_admin()
--     applique la même règle côté web (requireSuperAdmin).
-- =============================================================================

-- ----------------------------------------------------------------- 1. blocage « nouveau chauffeur » d'une course
-- Nouvelle surcharge (3 paramètres, sans défaut : aucun appel existant ne change de sens). p_for_ride = course
-- (acceptation) : un prix absent n'est PAS compté 0 € — même règle que l'envoi des offres (run_geo_wave,
-- offer_to_fleet → private.centrale_blocker). Appelée par des RPC security definer : pas de definer ici.
create or replace function private.driver_blocker(p_driver uuid, p_price integer, p_for_ride boolean)
returns text
language sql
stable
set search_path = ''
as $$
  select case when o.dispatch_model = 'centrale' then
           private.centrale_blocker(d.id, d.trust_level,
             case when coalesce(p_for_ride, false) then p_price else coalesce(p_price, 0) end,
             s.block_unpaid, s.settlement_credit_limit_cents, s.new_driver_max_price_cents)
         end
  from public.drivers d
  join public.organizations o on o.id = d.organization_id
  left join public.organization_settings s on s.organization_id = d.organization_id
  where d.id = p_driver;
$$;

-- Dernière définition : 20260924004400_audit_argent.sql. Deux paramètres = comme avant : prix absent compté 0 €
-- (jamais 'new_driver') — hors course (accueil, Commissions, vue d'ensemble) ; driver_offers (affichage de l'offre)
-- l'appelle encore ainsi : l'acceptation reste le contrôle qui fait foi.
create or replace function private.driver_blocker(p_driver uuid, p_price integer default null)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select private.driver_blocker(p_driver, p_price, false);
$$;

-- ----------------------------------------------------------------- 2. acceptation
-- Dernière définition : 20260924004500_audit_dispatch.sql. Changements : plafond « nouveau chauffeur » d'une course
-- sans prix (driver_blocker(…, true)) ; verrou du chauffeur FOR NO KEY UPDATE (interblocage avec dispatch_tick).
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
  v_block text;
  v_code text;
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
    -- Motif réel : annulée ; recherche terminée (aucun chauffeur, course retirée en attente d'attribution) ;
    -- sinon attribuée à un autre chauffeur.
    v_code := case
      when r.status = 'CANCELLED' then 'RIDE_CANCELLED'
      when r.driver_id is null then 'SEARCH_ENDED'
      else 'RIDE_ALREADY_ASSIGNED'
    end;
    if o.status = 'pending' then
      update public.ride_offers
         set status = 'closed',
             closed_reason = case v_code
               when 'RIDE_CANCELLED' then 'ride_cancelled'
               when 'SEARCH_ENDED' then 'search_ended'
               else 'already_assigned'
             end,
             responded_at = now()
       where id = o.id;
      perform private.release_offered_drivers(array[v_driver.id]);
    end if;
    perform private.log_event(r.organization_id, r.id, 'offer.rejected_late',
      format('%s (#%s) a tenté d''accepter — %s', v_driver.first_name, v_driver.number,
        case v_code
          when 'RIDE_CANCELLED' then 'course annulée'
          when 'SEARCH_ENDED' then 'recherche terminée'
          else 'course déjà attribuée'
        end),
      'dispatch', 'warning',
      jsonb_build_object('driver_id', v_driver.id, 'offer_id', o.id, 'latency_ms', v_latency, 'code', v_code),
      'driver', v_driver.id);
    return jsonb_build_object('ok', false, 'code', v_code, 'message', case v_code
      when 'RIDE_CANCELLED' then 'Course annulée.'
      when 'SEARCH_ENDED' then 'Recherche terminée : la course n''est plus proposée.'
      else 'Course déjà attribuée.'
    end);
  end if;

  if o.status in ('declined', 'closed', 'accepted') then
    return jsonb_build_object('ok', false, 'code', 'OFFER_CLOSED', 'message', 'Cette offre n''est plus disponible.');
  end if;
  -- Offre retirée (chauffeur passé hors ligne, relance, fin de fenêtre) ou périmée
  if o.status = 'expired' or (o.status = 'pending' and o.expires_at < now() - interval '3 seconds') then
    return jsonb_build_object('ok', false, 'code', 'OFFER_EXPIRED', 'message', 'Cette offre a expiré.');
  end if;

  -- Mode centrale : commission en retard / contestée, plafond d'encours, plafond « nouveau chauffeur ».
  -- L'offre reste ouverte : le chauffeur peut régler (ou signaler son paiement) puis accepter.
  v_block := private.driver_blocker(v_driver.id, r.price_cents, true);
  if v_block is not null then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_BLOCKED', 'reason', v_block,
      'message', private.blocker_message(v_block));
  end if;

  -- Sérialise les acceptations d'un même chauffeur (deux offres en attente acceptées en même temps) :
  -- après l'attente du verrou, le test suivant relit les courses validées par l'autre acceptation.
  -- FOR NO KEY UPDATE (et non FOR UPDATE) : s'exclut lui-même, mais laisse passer le FOR KEY SHARE des insertions
  -- qui référencent le chauffeur (offres du dispatch_tick, notifications, position) — sinon interblocage avec le tick.
  perform 1 from public.drivers where id = v_driver.id for no key update;

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

-- ----------------------------------------------------------------- 3. relance d'une course sans chauffeur
-- Remettre en service une course sans chauffeur = mêmes règles que la création (private.rides_platform_block,
-- private.enforce_plan_limits), comptée comme si elle était créée maintenant : 'PLATFORM_FEES_OVERDUE',
-- 'PLAN_LIMIT_RIDES' ou null. Mêmes contrôles que redispatch_ride / assign_ride (20260924004500).
-- Appelée par des fonctions security definer : pas de definer ici.
create or replace function private.ride_restart_blocker(p_org uuid, p_ride uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tz text;
  v_max bigint;
  v_count bigint;
begin
  if exists (select 1 from public.organizations o where o.id = p_org and o.platform_block_after_days is not null)
     and private.platform_blocked(p_org) then
    return 'PLATFORM_FEES_OVERDUE';
  end if;
  v_max := nullif(coalesce(private.org_limits(p_org), '{}'::jsonb) ->> 'max_rides_per_month', '')::bigint;
  if v_max is not null then
    select timezone into v_tz from public.organizations where id = p_org;
    select count(*) into v_count from public.rides x
    where x.organization_id = p_org
      and x.id is distinct from p_ride
      and x.created_at >= date_trunc('month', now() at time zone coalesce(v_tz, 'Europe/Paris')) at time zone coalesce(v_tz, 'Europe/Paris');
    if v_count >= v_max then
      return 'PLAN_LIMIT_RIDES';
    end if;
  end if;
  return null;
end;
$$;

-- Dernière définition : 20260924004500_audit_dispatch.sql. Seul changement : course NO_DRIVER_FOUND (recherche
-- terminée) → relancée (flotte) seulement si private.ride_restart_blocker ne s'y oppose pas ; sinon elle reste sans
-- chauffeur, l'heure de prise en charge suit le vol et le refus est journalisé (dispatch.relaunch_blocked).
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
  v_relative boolean := false;
  v_requalified text;
  v_incoherent boolean := false;
  v_fleet boolean := false;
  v_restart_block text;
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

  -- Mode arrivée : la prise en charge suit le RETARD du vol, à partir de l'heure demandée
  --   (heure demandée + (arrivée réelle | estimée − arrivée prévue)) : un vol à l'heure ne déplace
  --   jamais l'heure choisie par le client, même s'il a prévu plus (ou moins) que la marge.
  --   Sans horaire prévu, ou heure demandée AVANT l'arrivée prévue (réservation incohérente) :
  --   arrivée + marge bagages. Jamais dans le passé.
  if v_mode = 'arrival'
     and v_eta is not null
     and v_status not in ('cancelled', 'diverted')
     and r.status in ('CREATED', 'SEARCHING_DRIVER', 'OFFERED', 'ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'NO_DRIVER_FOUND')
  then
    v_relative := v_scheduled is not null and v_reference >= v_scheduled;
    v_ideal := case
      when v_relative then date_trunc('minute', v_reference + (v_eta - v_scheduled))
      else date_trunc('minute', v_eta) + make_interval(mins => coalesce(s.flight_pickup_buffer_minutes, 15))
    end;
    if abs(extract(epoch from (v_eta - v_reference))) > 86400
       or abs(extract(epoch from (v_ideal - v_reference))) > 12 * 3600 then
      -- Vol à plus de 24 h de l'heure demandée (mauvais vol / mauvaise date) ou décalage > 12 h : pas de recalage
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

  -- Retard qui repousse une course INSTANTANÉE au-delà du seuil « instantané » : elle redevient une
  -- planifiée, comme à la création ou à la relance. Sinon : vagues GPS et « aucun chauffeur » des heures
  -- avant la prise en charge, ou chauffeur bloqué « en route » pendant tout le retard.
  if v_shift and r.type = 'instant'
     and v_target > now() + make_interval(mins => coalesce(s.instant_threshold_minutes, 45)) then
    if r.driver_id is null and r.status in ('SEARCHING_DRIVER', 'OFFERED', 'NO_DRIVER_FOUND') then
      -- Recherche terminée (NO_DRIVER_FOUND) : la relancer = la remettre en service, mêmes règles que
      -- redispatch_ride / assign_ride (frais plateforme en retard, quota mensuel)
      if r.status = 'NO_DRIVER_FOUND' then
        v_restart_block := private.ride_restart_blocker(r.organization_id, r.id);
      end if;
      if v_restart_block is null then
        perform private.close_pending_offers(r.id, 'closed', 'flight_rescheduled');
        update public.rides
           set type = 'scheduled', dispatch_mode = 'fleet', status = 'SEARCHING_DRIVER', dispatch_wave = 0,
               dispatch_radius_m = null, dispatch_started_at = now(), no_driver_at = null, next_dispatch_at = null
         where id = r.id;
        perform private.offer_to_fleet(r.id);
        v_requalified := 'fleet';
      end if;
    elsif r.driver_id is not null and r.status = 'ACCEPTED' then
      -- Le chauffeur garde la course (planning, rappels) et redevient disponible d'ici là
      -- (ou enchaîne sur sa course suivante)
      update public.rides set type = 'scheduled' where id = r.id;
      perform private.release_driver_ride(r.driver_id, r.id, true);
      v_requalified := 'assigned';
    end if;
    if v_requalified is not null then
      perform private.log_event(r.organization_id, r.id, 'ride.requalified',
        format('Prise en charge repoussée à %s : course repassée en planifiée%s',
          private.fmt_local_time(v_target, v_tz, v_reference),
          case v_requalified when 'fleet' then ' et proposée à toute la flotte'
            else ' — le chauffeur reste attribué et redevient disponible d''ici là' end),
        'timeline', 'info', jsonb_build_object('type', 'scheduled', 'pickup_at', v_target, 'mode', v_requalified),
        'system', null);
    end if;
  end if;

  -- Retard qui repousse une PLANIFIÉE sans chauffeur, déjà passée en recherche GPS (T-lead), au-delà de la
  -- bascule : de nouveau proposée à toute la flotte (sinon vagues GPS puis « aucun chauffeur » des heures avant
  -- la prise en charge). La bascule GPS reviendra à la nouvelle heure − T-lead (offer_to_fleet).
  if v_shift and r.type = 'scheduled' and r.dispatch_mode = 'geo' and r.driver_id is null
     and r.status in ('SEARCHING_DRIVER', 'OFFERED', 'NO_DRIVER_FOUND')
     and v_target - v_lead > now() then
    -- Recherche terminée : mêmes règles que la relance (voir plus haut)
    if r.status = 'NO_DRIVER_FOUND' then
      v_restart_block := private.ride_restart_blocker(r.organization_id, r.id);
    end if;
    if v_restart_block is null then
      perform private.close_pending_offers(r.id, 'closed', 'flight_rescheduled');
      update public.rides
         set dispatch_mode = 'fleet', status = 'SEARCHING_DRIVER', dispatch_wave = 0,
             dispatch_radius_m = null, dispatch_started_at = now(), no_driver_at = null, next_dispatch_at = null
       where id = r.id;
      perform private.offer_to_fleet(r.id);
      v_requalified := 'fleet';
      perform private.log_event(r.organization_id, r.id, 'ride.requalified',
        format('Prise en charge repoussée à %s : course de nouveau proposée à toute la flotte',
          private.fmt_local_time(v_target, v_tz, v_reference)),
        'timeline', 'info', jsonb_build_object('type', 'scheduled', 'pickup_at', v_target, 'mode', 'fleet'),
        'system', null);
    end if;
  end if;

  -- Relance refusée (centrale bloquée pour frais plateforme en retard, ou quota mensuel atteint) : la course reste
  -- sans chauffeur (NO_DRIVER_FOUND), seule l'heure de prise en charge suit le vol ; la centrale la relance
  -- elle-même une fois la situation réglée.
  if v_restart_block is not null then
    perform private.log_event(r.organization_id, r.id, 'dispatch.relaunch_blocked',
      format('Prise en charge repoussée à %s : course non relancée — %s',
        private.fmt_local_time(v_target, v_tz, v_reference),
        case v_restart_block
          when 'PLATFORM_FEES_OVERDUE' then 'frais plateforme en retard (réglez Rydar Drive dans Encaissements, puis relancez-la)'
          else 'limite mensuelle de courses atteinte pour votre offre'
        end),
      'timeline', 'warning', jsonb_build_object('code', v_restart_block, 'pickup_at', v_target), 'system', null);
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
      v_shift_msg := format('Vol %s — prise en charge ajustée à %s (arrivée %s%s)', v_flight, v_at_label, v_eta_label,
        case when v_relative then '' else format(' + %s min', coalesce(s.flight_pickup_buffer_minutes, 15)) end);
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
    'notified', v_notified,
    -- 'fleet' : de nouveau proposée à toute la flotte (instantanée repassée en planifiée, ou planifiée repoussée
    -- après la bascule GPS) ; 'assigned' : instantanée attribuée repassée en planifiée ; sinon null
    'requalified', v_requalified);
end;
$$;

-- ----------------------------------------------------------------- 4. téléphone : empreintes de l'ancienne normalisation
-- Empreintes à comparer pour une identité SAISIE. Autres types : l'empreinte actuelle (private.identity_hash).
-- Téléphone : l'empreinte actuelle + celles des écritures que l'ANCIENNE normalisation (20260924002600, avant
-- 20260924004600) donnait au même numéro — un bannissement (ou un signalement) antérieur que le rattrapage n'a pas pu
-- recalculer (fiche supprimée : numéro effacé ; numéro modifié depuis) garde ainsi son effet :
--   « +330612… » (0 du préfixe national gardé après +33 / +262 / +590 / +594 / +596 : « +33 06… », « +33 (0)6… »),
--   « 33612… » et « 330612… » (« + » absent : l'ancienne règle ne l'ajoutait pas),
--   et l'ancienne normalisation de la saisie elle-même (« +44 (0)20… » → « +44020… »).
-- Aucune de ces formes n'est produite par la normalisation actuelle pour un autre numéro : pas de faux positif.
create or replace function private.identity_hashes(p_kind text, p_value text)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := btrim(coalesce(p_value, ''));
  n text := private.identity_normalize(p_kind, p_value);
  o text;
  f text;
  v_forms text[];
begin
  if n is null then
    return '{}';
  end if;
  if p_kind is distinct from 'phone' then
    return array[encode(sha256(convert_to('rydar:' || p_kind || ':' || n, 'UTF8')), 'hex')];
  end if;

  v_forms := array[n];
  if n ~ '^\+(33|262|590|594|596)[1-9]' then
    v_forms := v_forms || regexp_replace(n, '^\+(33|262|590|594|596)', '+\10');
  end if;
  foreach f in array v_forms loop
    if f ~ '^\+[1-9][0-9]{9,}$' then
      v_forms := v_forms || substr(f, 2);
    end if;
  end loop;

  -- Ancienne normalisation de la saisie (20260924002600, recopiée telle quelle)
  o := case when left(v, 1) = '+' then '+' || regexp_replace(v, '[^0-9]', '', 'g')
            else regexp_replace(v, '[^0-9]', '', 'g') end;
  if left(o, 2) = '00' then
    o := '+' || substr(o, 3);
  elsif o ~ '^0[1-9][0-9]{8}$' then
    o := '+33' || substr(o, 2);
  end if;
  if char_length(regexp_replace(o, '[^0-9]', '', 'g')) >= 6 then
    v_forms := v_forms || o;
  end if;

  return array(
    select distinct encode(sha256(convert_to('rydar:phone:' || x.form, 'UTF8')), 'hex')
    from unnest(v_forms) as x(form));
end;
$$;

-- Dernière définition : 20260924002600_centrale_mode.sql. Seul changement : toutes les empreintes de la saisie
-- (private.identity_hashes : téléphone, formes de l'ancienne normalisation comprises).
create or replace function private.identity_ban_scope(p_org uuid, p_kind text, p_value text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select b.scope
  from public.banned_identities b
  where b.lifted_at is null
    and b.kind = p_kind
    and b.value_hash = any (private.identity_hashes(p_kind, p_value))
    and (b.scope = 'platform' or b.organization_id = p_org)
  order by (b.scope = 'platform') desc
  limit 1;
$$;

-- Dernière définition : 20260924004600_audit_bannissement.sql. Changements : une empreinte « phone » du signalement
-- calculée avec l'ancienne normalisation reconnaît aussi le même numéro écrit autrement sur une fiche
-- (private.identity_hashes) ; value_hash = empreinte DU SIGNALEMENT (svc_platform_ban la compare aux identités du
-- signalement pour ne pas bannir de la plateforme une identité portée par une fiche non confirmée).
create or replace function private.fraud_report_carriers(p_report_id uuid)
returns table (driver_id uuid, organization_id uuid, same_org boolean, kind text, value_hash text)
language sql
stable
set search_path = ''
as $$
  select distinct d.id, d.organization_id, d.organization_id = f.organization_id, i.kind, e ->> 'hash'
  from public.fraud_reports f
  join public.drivers d
    on d.deleted_at is null
   and d.id is distinct from f.driver_id
   and d.ban_scope is distinct from 'platform'
  cross join lateral private.driver_identities(d.id, true) i
  cross join lateral jsonb_array_elements(f.identities) e
  where f.id = p_report_id
    and e ->> 'kind' = i.kind
    and (e ->> 'hash' = i.value_hash
         or (i.kind = 'phone' and e ->> 'hash' = any (private.identity_hashes('phone', d.phone))));
$$;

-- Rattrapage (appelé une fois ci-dessous) : fiche non bannie (active ou candidature en attente) dont le numéro ne tombe
-- sur un bannissement actif (plateforme, ou de sa centrale) QUE par une forme de l'ancienne normalisation —
-- réinscription acceptée depuis 20260924004600 ou contournement par l'écriture du numéro : signalée comme au rattrapage
-- (c) de 004600 (private.flag_driver_banned_match : candidature refusée d'office, fiche sans course suspendue
-- « vérification requise », journal). Les correspondances par l'empreinte actuelle ont déjà été traitées par 004600.
create or replace function private.flag_legacy_phone_ban_matches()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_flagged integer := 0;
begin
  for r in
    select distinct on (d.id) d.id, b.scope
    from public.drivers d
    join public.banned_identities b
      on b.lifted_at is null
     and b.kind = 'phone'
     and (b.scope = 'platform' or b.organization_id = d.organization_id)
     and b.value_hash = any (private.identity_hashes('phone', d.phone))
    where d.deleted_at is null
      and d.banned_at is null
      and btrim(coalesce(d.phone, '')) <> ''
      and (d.status = 'active' or (d.status = 'inactive' and d.application_status = 'pending'))
      and not exists (
        select 1 from public.banned_identities b2
        where b2.lifted_at is null
          and b2.kind = 'phone'
          and (b2.scope = 'platform' or b2.organization_id = d.organization_id)
          and b2.value_hash = private.identity_hash('phone', d.phone))
    order by d.id, (b.scope = 'platform') desc
  loop
    if private.flag_driver_banned_match(r.id, 'phone', r.scope, jsonb_build_object('legacy_hash', true)) then
      v_flagged := v_flagged + 1;
    end if;
  end loop;
  return v_flagged;
end;
$$;

select private.flag_legacy_phone_ban_matches();

-- ----------------------------------------------------------------- 5. compte de connexion conservé
-- Dernière définition : 20260924004000_account_deletion_fixes.sql. Seul changement : une adhésion « invitée »
-- (invitation en attente : aucun accès, 20260924004700) ne compte plus — même règle que
-- public.svc_login_account_shared : adhésion ACTIVE à une centrale non archivée, ou super admin. Appelants :
-- suppression du compte chauffeur (delete_driver_account, admin_find_drivers, repair_deleted_drivers) et
-- bannissement plateforme (svc_platform_ban, admin_fraud_report_matches).
create or replace function private.keeps_login_account(p_user uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_user is not null and (
    exists (select 1
              from public.organization_users m
              join public.organizations o on o.id = m.organization_id
             where m.user_id = p_user and m.status = 'active' and o.status <> 'archived')
    or exists (select 1 from public.users u where u.id = p_user and u.is_super_admin));
$$;

-- ----------------------------------------------------------------- 6. jeton émis après une activation
-- Dernière définition : 20260924005300_member_activation_tokens.sql. Seul changement : STRICTEMENT après la seconde
-- de p_at — « iat » est en secondes entières : un jeton émis plus tôt dans la même seconde (avant l'activation)
-- passait. /auth/set-password attend le changement de seconde avant de rafraîchir la session.
create or replace function private.jwt_issued_after(p_at timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_at is null
      or coalesce(nullif(auth.jwt() ->> 'iat', '')::numeric, 0) > floor(extract(epoch from p_at));
$$;

-- Dernière définition : 20260924003000_platform_fees.sql. Seul changement : adhésion activée → jeton émis après
-- l'activation (private.jwt_issued_after), comme tous les autres contrôles d'appartenance (20260924005300).
create or replace function public.org_platform_status(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_org is null or not exists (
    select 1
    from public.organization_users ou
    join public.organizations o on o.id = ou.organization_id
    where ou.organization_id = p_org and ou.user_id = auth.uid() and ou.status = 'active'
      and private.jwt_issued_after(ou.activated_at)
      and ou.role in ('owner', 'admin') and o.status in ('active', 'suspended')
  ) then
    return jsonb_build_object('enabled', false);
  end if;
  if not exists (select 1 from public.organizations o where o.id = p_org and o.dispatch_model = 'centrale')
     and not exists (select 1 from public.platform_fee_entries e where e.organization_id = p_org)
     and not exists (select 1 from public.platform_payments p where p.organization_id = p_org) then
    return jsonb_build_object('enabled', false);
  end if;
  return jsonb_build_object('enabled', true, 'account', private.platform_account(p_org));
end;
$$;

-- ----------------------------------------------------------------- 7. sessions à la suspension d'une centrale
-- Dernière définition : 20260924004700_audit_comptes.sql. Seul changement (branche organizations, membres) : mêmes
-- règles que la branche organization_users — seuls les membres ACTIFS de la centrale suspendue / archivée perdent
-- leurs sessions, et jamais un compte qui garde un autre accès : autre centrale active, super admin, fiche chauffeur
-- active ou candidature en attente dans une centrale active (invitation en attente, ancien membre désactivé : rien).
create or replace function private.revoke_sessions_on_access_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keep text := nullif(current_setting('rydar.keep_sessions', true), '');
begin
  if tg_table_name = 'drivers' then
    if tg_op = 'DELETE' then
      if not public.svc_login_account_shared(old.user_id) then
        perform private.revoke_user_sessions(old.user_id);
      end if;
    else
      if new.user_id is not null and old.status = 'active' and new.status <> 'active'
         and new.user_id::text is distinct from v_keep
         and not public.svc_login_account_shared(new.user_id) then
        perform private.revoke_user_sessions(new.user_id);
      end if;
      if old.user_id is not null and new.user_id is distinct from old.user_id
         and old.user_id::text is distinct from v_keep
         and not public.svc_login_account_shared(old.user_id) then
        perform private.revoke_user_sessions(old.user_id);
      end if;
    end if;

  elsif tg_table_name = 'organization_users' then
    if old.status = 'active' and (tg_op = 'DELETE' or new.status <> 'active')
       and not exists (
         select 1 from public.organization_users m2
         join public.organizations o2 on o2.id = m2.organization_id
         where m2.user_id = old.user_id and m2.id <> old.id and m2.status = 'active' and o2.status = 'active')
       and not exists (select 1 from public.users u where u.id = old.user_id and u.is_super_admin)
       and not exists (
         select 1 from public.drivers d
         join public.organizations o3 on o3.id = d.organization_id
         where d.user_id = old.user_id and d.deleted_at is null and o3.status = 'active'
           and (d.status = 'active' or d.application_status = 'pending')) then
      perform private.revoke_user_sessions(old.user_id);
    end if;

  elsif tg_table_name = 'organizations' then
    if old.status = 'active' and new.status <> 'active' then
      -- Chauffeurs de l'organisation (sauf compte partagé : ses membres sont traités juste en dessous, et la gestion
      -- d'une autre centrale ou de la plateforme n'est pas coupée)
      perform private.revoke_user_sessions(d.user_id)
        from public.drivers d
       where d.organization_id = new.id and d.user_id is not null
         and not public.svc_login_account_shared(d.user_id);
      -- Membres ACTIFS qui n'ont aucun autre accès (autre centrale active, super admin, fiche chauffeur active ou
      -- candidature en attente dans une centrale active)
      perform private.revoke_user_sessions(m.user_id)
        from public.organization_users m
       where m.organization_id = new.id
         and m.status = 'active'
         and not exists (
           select 1 from public.organization_users m2
           join public.organizations o2 on o2.id = m2.organization_id
           where m2.user_id = m.user_id and m2.organization_id <> new.id
             and m2.status = 'active' and o2.status = 'active')
         and not exists (select 1 from public.users u where u.id = m.user_id and u.is_super_admin)
         and not exists (
           select 1 from public.drivers d
           join public.organizations o3 on o3.id = d.organization_id
           where d.user_id = m.user_id and d.deleted_at is null and o3.status = 'active'
             and (d.status = 'active' or d.application_status = 'pending'));
    end if;
  end if;
  return null;
end;
$$;

-- ----------------------------------------------------------------- 8. Super Admin : jeton émis après la promotion
-- Date à laquelle le rôle a été donné par deploy/create-admin.sh (compte existant repris : mot de passe remplacé,
-- sessions fermées). Un jeton d'accès émis AVANT (celui d'un tiers qui aurait créé le compte avec cette adresse, valable
-- jusqu'à 1 h) n'a pas les droits Super Admin. Null (rôle donné autrement, avant cette migration) : aucun changement.
-- Non modifiable par les utilisateurs (UPDATE accordé par colonne à authenticated : full_name, phone, avatar_url,
-- last_active_org_id).
alter table public.users add column if not exists super_admin_since timestamptz;
comment on column public.users.super_admin_since is
  'Promotion Super Admin (deploy/create-admin.sh) : seuls les jetons émis après donnent le rôle (private.is_super_admin).';

-- Dernière définition : 20260924000300_security.sql. Seul changement : jeton émis après users.super_admin_since.
create or replace function private.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select u.is_super_admin and private.jwt_issued_after(u.super_admin_since)
                   from public.users u where u.id = auth.uid()), false);
$$;

-- Tableau de bord (requireSuperAdmin) : même règle que la base pour le jeton de la session courante.
create or replace function public.session_is_super_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select private.is_super_admin();
$$;

-- ----------------------------------------------------------------- droits d'exécution
-- Nouvelles fonctions (deny-by-default, cf. 20260924000900) ; les fonctions redéfinies gardent leurs droits
-- (signatures inchangées).
revoke all on function
  private.driver_blocker(uuid, integer, boolean),
  private.ride_restart_blocker(uuid, uuid),
  private.identity_hashes(text, text),
  private.flag_legacy_phone_ban_matches()
from public, anon, authenticated;
grant execute on function
  private.driver_blocker(uuid, integer, boolean),
  private.ride_restart_blocker(uuid, uuid),
  private.identity_hashes(text, text),
  private.flag_legacy_phone_ban_matches()
to service_role;

revoke all on function public.session_is_super_admin() from public, anon;
grant execute on function public.session_is_super_admin() to authenticated, service_role;
