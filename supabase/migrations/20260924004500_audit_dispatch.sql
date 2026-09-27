-- =============================================================================
-- Rydar Drive — Audit « dispatch » : corrections du cycle de course.
--
--  1. Double acceptation (flux-course#2) : accept_ride_offer verrouille la ligne du chauffeur AVANT le test
--     DRIVER_BUSY. Deux acceptations concurrentes du même chauffeur (deux offres en attente : tick ∥ création,
--     relance…) se sérialisent : la seconde relit les courses après la validation de la première → DRIVER_BUSY.
--     Ordre des verrous inchangé : course → offre → chauffeur (comme run_geo_wave / driver_set_online).
--  2. Motif du refus (flux-course#3) : course annulée → RIDE_CANCELLED « Course annulée. » ; recherche terminée
--     (aucun chauffeur, course retirée en attente d'attribution) → SEARCH_ENDED ; « Course déjà attribuée. »
--     seulement si un chauffeur l'a.
--  3. Enchaînement (flux-course#5) : une instantanée attribuée pendant une course n'est plus orpheline. Quand la
--     course en cours se termine, est annulée ou retirée au chauffeur, il enchaîne sur la suivante
--     (private.release_driver_ride) au lieu de redevenir « disponible » sans course en cours.
--  4. Vol retardé d'une planifiée déjà en recherche GPS (flux-course#1, flux-annexes#3) : prise en charge repoussée
--     au-delà de la bascule (T-lead) → de nouveau proposée à toute la flotte ; flights_to_check suit aussi les
--     courses NO_DRIVER_FOUND (nouveaux retards / annulation du vol).
--  5. Blocage « frais plateforme en retard » et quota mensuel (flux-argent#5, sql-rpc-courses#3) : mêmes règles
--     que la création (rides_platform_block, enforce_plan_limits : BEFORE INSERT) pour relancer (redispatch_ride)
--     ou attribuer à la main (assign_ride) une course SANS chauffeur. Réattribuer une course déjà attribuée reste
--     possible (attribuée avant le blocage).
-- =============================================================================

-- ----------------------------------------------------------------- helper : enchaînement
-- Libère le chauffeur p_driver de la course p_ride : il enchaîne sur sa course suivante (course déjà démarrée,
-- sinon instantanée attribuée, la plus ancienne d'abord) ou redevient disponible s'il n'en a pas.
-- Même définition de « course en cours » que le test DRIVER_BUSY de accept_ride_offer.
-- p_only_if_current : seulement si p_ride est sa course en cours (annulation, retrait, réattribution).
-- Renvoie la course enchaînée (null = disponible). Appelé par des RPC security definer : pas de definer ici.
create or replace function private.release_driver_ride(p_driver uuid, p_ride uuid, p_only_if_current boolean default true)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_next uuid;
  v_status public.ride_status;
begin
  if p_driver is null then
    return null;
  end if;

  select x.id, x.status into v_next, v_status
  from public.rides x
  where x.driver_id = p_driver
    and x.id is distinct from p_ride
    and (
      x.status in ('DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS')
      or (x.status = 'ACCEPTED' and x.type = 'instant')
    )
  order by x.status = 'ACCEPTED', coalesce(x.accepted_at, x.pickup_at), x.id
  limit 1;

  update public.drivers
     set current_ride_id = v_next,
         presence = case
           when v_next is null then 'available'
           when v_status = 'DRIVER_ARRIVED' then 'arrived'
           when v_status in ('PASSENGER_ONBOARD', 'IN_PROGRESS') then 'on_trip'
           else 'en_route'
         end::public.driver_presence
   where id = p_driver
     and (not coalesce(p_only_if_current, true) or current_ride_id = p_ride);

  return v_next;
end;
$$;

revoke all on function private.release_driver_ride(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function private.release_driver_ride(uuid, uuid, boolean) to service_role;

-- ----------------------------------------------------------------- acceptation
-- Dernière définition : 20260924002600_centrale_mode.sql. Changements : motif réel du refus (annulée, recherche
-- terminée, attribuée) ; verrou du chauffeur avant le test DRIVER_BUSY (double acceptation concurrente).
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
  v_block := private.driver_blocker(v_driver.id, r.price_cents);
  if v_block is not null then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_BLOCKED', 'reason', v_block,
      'message', private.blocker_message(v_block));
  end if;

  -- Sérialise les acceptations d'un même chauffeur (deux offres en attente acceptées en même temps) :
  -- après l'attente du verrou, le test suivant relit les courses validées par l'autre acceptation.
  perform 1 from public.drivers where id = v_driver.id for update;

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

-- ----------------------------------------------------------------- cycle de course (chauffeur)
-- Dernière définition : 20260924000400_dispatch.sql. Seul changement : course terminée → le chauffeur enchaîne
-- sur sa course suivante attribuée pendant celle-ci (private.release_driver_ride), sinon disponible.
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
    perform private.release_driver_ride(v_driver.id, r.id, false);
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

-- ----------------------------------------------------------------- annulation
-- Dernière définition : 20260924000400_dispatch.sql. Seul changement : chauffeur libéré de sa course en cours →
-- il enchaîne sur sa course suivante (private.release_driver_ride), sinon disponible.
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
    perform private.release_driver_ride(r.driver_id, r.id, true);
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

-- ----------------------------------------------------------------- « Relancer » : retirer la course au chauffeur
-- Dernière définition : 20260924002200_ride_alerts.sql. Seul changement (étape 3) : le chauffeur retiré enchaîne
-- sur sa course suivante (private.release_driver_ride), sinon disponible.
create or replace function public.reassign_ride(p_ride_id uuid, p_reason text default null, p_expected_driver uuid default null)
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
  v_auto boolean;
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
  if p_expected_driver is not null and r.driver_id is distinct from p_expected_driver then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_CHANGED',
      'message', 'La course a changé de chauffeur entre-temps : vérifiez avant de la retirer.', 'driver_id', r.driver_id);
  end if;

  select * into d from public.drivers where id = r.driver_id;

  select s.instant_threshold_minutes, coalesce(s.auto_dispatch, true) into v_threshold, v_auto
  from public.organization_settings s where s.organization_id = r.organization_id;
  v_auto := coalesce(v_auto, true);
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
  -- offre « fermée » (pas « refusée » : le taux d'acceptation du chauffeur n'est pas touché), exclue en
  -- permanence par run_geo_wave et offer_to_fleet
  insert into public.ride_offers (organization_id, ride_id, driver_id, status, mode, wave, sent_at, expires_at, responded_at, closed_reason)
  values (r.organization_id, r.id, r.driver_id, 'closed', 'geo', 0, now(), now(), now(), 'removed_by_dispatch');

  -- 3. chauffeur retiré de sa course en cours : il enchaîne sur la suivante, sinon disponible
  perform private.release_driver_ride(r.driver_id, r.id, true);

  -- 4. notifications : rappels en file annulés, prévenir le chauffeur
  update public.notifications
     set status = 'cancelled'
   where ride_id = r.id and driver_id = r.driver_id and status = 'queued';
  perform private.queue_notification(r.organization_id, r.driver_id, r.id, null, 'ride_unassigned', 'COURSE RETIRÉE',
    format('La centrale a réattribué la course #%s', r.number),
    jsonb_build_object('type', 'ride_unassigned', 'ride_id', r.id, 'number', r.number, 'reason', v_reason), 'high', null);

  -- 5. course remise en recherche (type recalculé) ; sans dispatch automatique : en attente d'attribution
  update public.rides
     set status = case when v_auto then 'SEARCHING_DRIVER' else 'CREATED' end::public.ride_status,
         driver_id = null,
         vehicle_id = null,
         type = v_type,
         pickup_at = greatest(pickup_at, now()),
         dispatch_mode = case when v_type = 'instant' then 'geo' else 'fleet' end::public.dispatch_mode,
         dispatch_wave = 0,
         dispatch_radius_m = null,
         dispatch_started_at = case when v_auto then now() end,
         next_dispatch_at = null,
         accepted_at = null,
         driver_en_route_at = null,
         driver_arrived_at = null,
         no_driver_at = null
   where id = r.id;

  -- 6. alertes de la course : traitées par la relance
  v_alerts := private.close_ride_alerts(r.id, 'relaunched', auth.uid());

  perform private.log_event(r.organization_id, r.id, 'ride.reassigned',
    format('Course retirée à %s %s (#%s) par la centrale%s — %s',
      coalesce(d.first_name, 'chauffeur'), coalesce(d.last_name, ''), coalesce(d.number::text, '?'),
      coalesce(' : ' || v_reason, ''), case when v_auto then 'nouvelle recherche' else 'à attribuer manuellement' end),
    'timeline', 'warning',
    jsonb_build_object('previous_driver_id', r.driver_id, 'previous_status', r.status, 'reason', v_reason,
      'type', v_type, 'closed_alerts', v_alerts, 'closed_offers', cardinality(v_closed)),
    'user', auth.uid());

  -- 7. nouvelle recherche : 4 km d'abord (instantanée) ou toute la flotte (planifiée) ;
  --    dispatch automatique désactivé : la course attend une attribution manuelle
  if not v_auto then
    return jsonb_build_object('ok', true, 'code', 'UNASSIGNED', 'message', 'Course retirée au chauffeur — à attribuer manuellement.',
      'ride_id', r.id, 'previous_driver_id', r.driver_id, 'type', v_type, 'status', 'CREATED',
      'notified', 0, 'closed_alerts', v_alerts);
  end if;
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

-- ----------------------------------------------------------------- « Attribuer » / « Réattribuer » à un chauffeur choisi
-- Dernière définition : 20260924002200_ride_alerts.sql. Changements : course sans chauffeur → mêmes règles que la
-- création (frais plateforme en retard, quota mensuel) ; chauffeur précédent → enchaîne sur sa course suivante.
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
  v_max bigint;
  v_count bigint;
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

  -- Course sans chauffeur : l'attribuer = la (re)mettre en service, mêmes règles que la création
  -- (private.rides_platform_block, private.enforce_plan_limits) comptée comme si elle était créée maintenant.
  if r.driver_id is null then
    if exists (select 1 from public.organizations o where o.id = r.organization_id and o.platform_block_after_days is not null)
       and private.platform_blocked(r.organization_id) then
      return jsonb_build_object('ok', false, 'code', 'PLATFORM_FEES_OVERDUE',
        'message', 'Frais plateforme en retard : réglez Rydar Drive (Encaissements) pour relancer ou attribuer une course.');
    end if;
    v_max := nullif(coalesce(private.org_limits(r.organization_id), '{}'::jsonb) ->> 'max_rides_per_month', '')::bigint;
    if v_max is not null then
      select count(*) into v_count from public.rides x
      where x.organization_id = r.organization_id
        and x.id <> r.id
        and x.created_at >= date_trunc('month', now() at time zone coalesce(v_tz, 'Europe/Paris')) at time zone coalesce(v_tz, 'Europe/Paris');
      if v_count >= v_max then
        return jsonb_build_object('ok', false, 'code', 'PLAN_LIMIT_RIDES',
          'message', 'Limite mensuelle de courses atteinte pour votre offre.');
      end if;
    end if;
  end if;

  v_previous := r.driver_id;

  if v_previous is not null then
    update public.ride_assignments
       set is_active = false, released_at = now(), release_reason = 'reassigned'
     where ride_id = r.id and is_active;
    perform private.release_driver_ride(v_previous, r.id, true);
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

-- ----------------------------------------------------------------- « Relancer » une course sans chauffeur
-- Dernière définition : 20260924000400_dispatch.sql. Seul changement : mêmes règles que la création (frais
-- plateforme en retard, quota mensuel) avant de relancer.
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
  v_tz text;
  v_max bigint;
  v_count bigint;
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

  -- Relancer = remettre la course en service : mêmes règles que la création (private.rides_platform_block,
  -- private.enforce_plan_limits), comptée comme si elle était créée maintenant.
  if exists (select 1 from public.organizations o where o.id = r.organization_id and o.platform_block_after_days is not null)
     and private.platform_blocked(r.organization_id) then
    return jsonb_build_object('ok', false, 'code', 'PLATFORM_FEES_OVERDUE',
      'message', 'Frais plateforme en retard : réglez Rydar Drive (Encaissements) pour relancer ou attribuer une course.');
  end if;
  v_max := nullif(coalesce(private.org_limits(r.organization_id), '{}'::jsonb) ->> 'max_rides_per_month', '')::bigint;
  if v_max is not null then
    select timezone into v_tz from public.organizations where id = r.organization_id;
    select count(*) into v_count from public.rides x
    where x.organization_id = r.organization_id
      and x.id <> r.id
      and x.created_at >= date_trunc('month', now() at time zone coalesce(v_tz, 'Europe/Paris')) at time zone coalesce(v_tz, 'Europe/Paris');
    if v_count >= v_max then
      return jsonb_build_object('ok', false, 'code', 'PLAN_LIMIT_RIDES',
        'message', 'Limite mensuelle de courses atteinte pour votre offre.');
    end if;
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

-- ----------------------------------------------------------------- worker : courses à vérifier
-- Dernière définition : 20260924002100_flight_tracking.sql. Seul changement : les courses NO_DRIVER_FOUND restent
-- suivies (nouveau retard → de nouveau proposée à la flotte, annulation du vol signalée). La fenêtre
-- « prise en charge entre −3 h et +24 h » borne toujours le suivi.
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
      and r.status in ('CREATED', 'SEARCHING_DRIVER', 'OFFERED', 'NO_DRIVER_FOUND', 'ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED')
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
-- Dernière définition : 20260924002100_flight_tracking.sql. Changements : planifiée sans chauffeur déjà passée en
-- recherche GPS (T-lead) et repoussée au-delà de la bascule → de nouveau proposée à toute la flotte ; chauffeur
-- libéré d'une instantanée repassée en planifiée → enchaîne sur sa course suivante (private.release_driver_ride).
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
      perform private.close_pending_offers(r.id, 'closed', 'flight_rescheduled');
      update public.rides
         set type = 'scheduled', dispatch_mode = 'fleet', status = 'SEARCHING_DRIVER', dispatch_wave = 0,
             dispatch_radius_m = null, dispatch_started_at = now(), no_driver_at = null, next_dispatch_at = null
       where id = r.id;
      perform private.offer_to_fleet(r.id);
      v_requalified := 'fleet';
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

-- ----------------------------------------------------------------- droits (signatures inchangées : ACL conservées ;
-- réaffirmées pour les RPC exposées)
revoke execute on function
  public.accept_ride_offer(uuid),
  public.driver_update_ride_status(uuid, public.ride_status),
  public.reassign_ride(uuid, text, uuid),
  public.assign_ride(uuid, uuid),
  public.redispatch_ride(uuid)
from public, anon;
grant execute on function
  public.accept_ride_offer(uuid),
  public.driver_update_ride_status(uuid, public.ride_status),
  public.reassign_ride(uuid, text, uuid),
  public.assign_ride(uuid, uuid),
  public.redispatch_ride(uuid)
to authenticated, service_role;

revoke all on function
  private.cancel_ride_internal(uuid, text, public.actor_type, uuid),
  private.flights_to_check(integer),
  private.apply_flight_status(uuid, text, timestamptz, timestamptz, timestamptz, text, text, text, text)
from public, anon, authenticated;
grant execute on function
  private.cancel_ride_internal(uuid, text, public.actor_type, uuid),
  private.flights_to_check(integer),
  private.apply_flight_status(uuid, text, timestamptz, timestamptz, timestamptz, text, text, text, text)
to service_role;
