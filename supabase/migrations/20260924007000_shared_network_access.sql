-- =============================================================================
-- Rydar Drive — Réseau partagé, lot 5 : accès, confidentialité, temps réel. Interrupteur plateforme COUPÉ.
--
-- Partie 5a (spécification §11.1 à §11.4, matrice de visibilité) : RPC du chauffeur partenaire, de l'organisation qui
-- confie la course (A) et de l'organisation du chauffeur (B). Contrats : packages/shared/src/network.ts (NetworkRpcs),
-- noms, paramètres (« tous transmis, NULL = inchangé ») et clés JSON appelés par les écrans déjà écrits
-- (apps/web/app/dashboard/reseau-partage, components/network-share, fiche course, En direct ; apps/driver/src/lib/api.ts).
--  * Chauffeur (portée private.current_driver_id()) : driver_offers_v2 (offres propres = driver_offers() à l'identique
--    + offres partenaires : « Course de {A} », communes, coordonnées arrondies à ~300 m, UN montant, jamais l'adresse
--    exacte, le tracé, le commentaire ni le client), driver_ride (liste blanche de l'écran course ; course partenaire :
--    client seulement dans sa fenêtre, chaque lecture comptée pour A), driver_rides_upcoming, driver_network_state /
--    driver_network_ping / driver_set_network (conditions acceptées : legal_acceptances « network_driver »).
--  * A (tout membre ; owner / admin d'une A suspendue ou archivée pour ses sommes en cours) : org_network_summary,
--    org_network_given, org_network_ride (téléphone du chauffeur dans sa fenêtre, lectures des données client),
--    network_partner_names ; exclusions de chauffeurs partenaires (owner / admin) : exclude_network_driver,
--    org_network_driver_exclusions, lift_network_driver_exclusion.
--  * B (membre ; owner / admin pour les réglages) : org_network_received (date, heure, communes, chauffeur, véhicule,
--    prix, part, règlement — JAMAIS le client ni l'adresse), org_network_activity (sans position, Q5),
--    org_network_drivers, set_driver_network_allowed.
--  * private.driver_label_for (libellé court « Prénom I. · B » d'un chauffeur d'une autre organisation) pour les
--    messages de la suite du lot.
-- Interrupteur coupé : aucune fonction existante n'est redéfinie par la partie 5a ; les nouvelles RPC répondent
-- NETWORK_DISABLED (55000) sauf celles de NETWORK_CLOSED_RPCS (sommes et courses en cours) et les lectures générales de
-- l'application (driver_offers_v2, driver_ride, driver_rides_upcoming : offres et courses propres identiques à avant).
--
-- Partie 5b (spécification §11.5 à §11.7, §13, sections 7 à 14) : journaux, alertes, positions, temps réel,
-- notifications, webhooks et API.
--  * Journaux (private.log_event, private.track_ride_status) : filet de sécurité — chauffeur d'une autre organisation
--    jamais cité par son identifiant, son n° interne ni son nom de famille (libellé court), acteur d'une autre
--    organisation sans identifiant ; alertes de suivi (private.apply_ride_alert, private.watch_rides) : libellé court,
--    ni position ni n° interne, distance arrondie à 100 m ; annulation : « COURSE ANNULÉE — {A} » sans adresse.
--  * Positions (Q5) : points d'une course partenaire marqués ride_org_id (invisibles pour B), supprimés 1 h après la fin
--    (private.housekeeping, avec les rappels et notifications de vol du partenaire) ; aucune position diffusée pendant
--    la course partenaire ; org:{B} reçoit « En course partenaire ({A}) » sans identifiant de course.
--  * Temps réel org:{A} : ni identifiant ni position du partenaire (courses, alertes) ; notifications : jamais de
--    commission, frais Rydar ni part chez un partenaire (ni de frais Rydar chez un chauffeur de flotte).
--  * Webhooks et API v1 : objet « driver » commun (public.ride_public_driver) — partenaire : prénom, véhicule de
--    l'instantané, exploitant « operator », NULL 24 h après la fin.
-- Interrupteur coupé (aucun chauffeur d'une autre organisation sur une course) : mêmes écritures, mêmes messages, mêmes
-- diffusions qu'avant.
-- =============================================================================

-- =============================================================================
-- 1. Aides (private, sans definer : appelées par les RPC definer ci-dessous)
-- =============================================================================

-- Réseau fermé par la plateforme : refus des RPC qui n'ont de sens que réseau ouvert (réglages, consentement,
-- exclusions). Les sommes et courses en cours restent accessibles (NETWORK_CLOSED_RPCS de @rydar/shared).
create or replace function private.assert_network_open()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not public.shared_network_enabled() then
    raise exception 'NETWORK_DISABLED: réseau partagé fermé par Rydar' using errcode = '55000';
  end if;
end;
$$;

-- Propriétaire ou administrateur de l'organisation, adhésion active, jeton émis après l'activation, organisation
-- active, suspendue ou archivée : même prédicat que private.assert_network_creditor (lot 3), en booléen (actions
-- proposées par org_network_ride).
create or replace function private.network_creditor_ok(p_org uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_org is not null and exists (
    select 1
      from public.organization_users ou
      join public.organizations o on o.id = ou.organization_id
     where ou.organization_id = p_org
       and ou.user_id = auth.uid()
       and ou.status = 'active'
       and private.jwt_issued_after(ou.activated_at)
       and ou.role in ('owner', 'admin')
       and o.status in ('active', 'suspended', 'archived'));
$$;

-- Lecture des courses confiées (A) : tout membre d'une organisation active (dispatcher compris) ; owner / admin d'une
-- organisation suspendue ou archivée (ses sommes en cours restent à régler, C12 : NETWORK_SUSPENDED_CREDITOR_RPCS).
create or replace function private.assert_network_reader(p_org uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_org is not null and private.is_org_member(p_org) then
    return;
  end if;
  perform private.assert_network_creditor(p_org);
end;
$$;

-- Libellé d'un chauffeur pour une organisation (§11.5, S3) : la sienne → libellé habituel « Prénom NOM (#n) » ; une
-- autre → libellé court « Prénom I. · {nom de son organisation} » (jamais son nom de famille, son n° interne ni son
-- identifiant). Fiche absente : NULL.
create or replace function private.driver_label_for(p_driver uuid, p_org uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select case
           when d.organization_id = p_org then format('%s %s (#%s)', btrim(d.first_name), btrim(d.last_name), d.number)
           else btrim(btrim(d.first_name) || coalesce(' ' || nullif(left(btrim(d.last_name), 1), '') || '.', ''))
                || ' · ' || o.name
         end
    from public.drivers d
    join public.organizations o on o.id = d.organization_id
   where d.id = p_driver;
$$;

-- Coordonnée d'une offre partenaire, arrondie à 0,003° (~300 m, NETWORK_PARAMS.coordStepDegrees) : le point exact du
-- départ n'est connu qu'après l'acceptation (§9.4, S7).
create or replace function private.network_round_coord(p double precision)
returns double precision
language sql
immutable
set search_path = ''
as $$
  select (round((p / 0.003)::numeric) * 0.003)::double precision;
$$;

-- Fin de la fenêtre d'un téléphone échangé pour une course partagée (§11.1 : chauffeur chez A, A chez le chauffeur) :
-- NULL pendant la course (visible) ; après la fin, 48 h, prolongées tant que le règlement réseau de cette exécution est
-- ouvert ou a bougé ces 48 dernières heures, 30 jours au plus (NETWORK_PARAMS.phoneAfterHours / phoneMaxDays).
create or replace function private.network_phone_until(p_ended_at timestamptz, p_execution uuid)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case when p_ended_at is null then null else
    least(p_ended_at + interval '30 days',
          greatest(p_ended_at + interval '48 hours',
                   coalesce((select case when x.status in ('due', 'declared', 'disputed') then 'infinity'::timestamptz
                                         else x.updated_at + interval '48 hours' end
                               from public.ride_settlements x
                              where x.network_execution_id = p_execution
                                and x.network_driver_org_id is not null
                              limit 1), p_ended_at)))
  end;
$$;

-- Chauffeur partenaire exclu par A (« Exclure ce chauffeur », private.network_driver_exclusions non levée) : depuis
-- cette exécution, ou par ses empreintes d'identité (même règle que private.network_identity_block, « excluded »).
create or replace function private.network_driver_excluded(p_giver uuid, p_driver uuid, p_execution uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
           select 1 from private.network_driver_exclusions x
            where x.giver_org_id = p_giver and x.lifted_at is null and x.execution_id = p_execution)
      or (p_driver is not null and exists (
           select 1
             from private.network_driver_exclusions x
            cross join lateral unnest(x.kinds, x.value_hashes) as u(kind, value_hash)
             join private.driver_identity_keys k on k.driver_id = p_driver and k.kind = u.kind and k.value_hash = u.value_hash
            where x.giver_org_id = p_giver and x.lifted_at is null));
$$;

-- Exécution vue par A (contrat NetworkExecutionSummary) : libellé court figé, organisation du chauffeur (nom validé à
-- l'acceptation), véhicule et termes figés, « à vérifier », retenue, contestations, validation, exclusion. Jamais le
-- nom de famille, le n° interne ni le téléphone du chauffeur (fenêtre : org_network_ride seulement).
create or replace function private.network_execution_summary(e public.ride_network_executions)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', e.id,
    'accepted_at', e.accepted_at,
    'ended_at', e.ended_at,
    'end_reason', e.end_reason,
    'driver_label', e.driver_label,
    'partner', jsonb_build_object('id', e.executor_org_id, 'name', coalesce(e.operator ->> 'name', '')),
    'vehicle', e.vehicle,
    'terms', e.terms,
    'counterparty', e.counterparty,
    'suspect_reasons', to_jsonb(e.suspect_reasons),
    'on_hold', coalesce(e.hold_until > now(), false),
    'hold_until', e.hold_until,
    'contested_at', e.contested_at,
    'contested_reason', e.contested_reason,
    'driver_disputed_at', e.driver_disputed_at,
    'driver_dispute_reason', e.driver_dispute_reason,
    'validated_at', e.validated_at,
    'driver_excluded', private.network_driver_excluded(e.organization_id, e.executor_driver_id, e.id));
$$;

-- Lisibilité de l'organisation (§6.4, contrat OrgNetworkReadiness) : pour chaque sens, TOUS les manques dans l'ordre
-- de ORG_NETWORK_READINESS_CODES (avertissement « terms_grace » à part) ; « active » = private.network_org_reason NULL
-- (mêmes conditions que le dispatch). Statut de validation : approved, refused (motif de Rydar), lost (validation perdue
-- après un changement de nom ou de n°, instantané conservé), pending (demande envoyée), none. Le lot administration
-- l'enveloppe (public.org_network_readiness) ; org_network_summary la renvoie.
create or replace function private.org_network_readiness(p_org uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  o public.organizations;
  m public.network_memberships;
  s public.organization_settings;
  p public.platform_settings;
  v_enabled boolean := public.shared_network_enabled();
  v_approval text;
  v_common text[] := '{}';
  v_approval_codes text[] := '{}';
  v_out text[];
  v_in text[];
  v_warnings text[] := '{}';
begin
  select * into o from public.organizations x where x.id = p_org;
  select * into m from public.network_memberships x where x.organization_id = p_org;
  select * into s from public.organization_settings x where x.organization_id = p_org;
  select * into p from public.platform_settings x where x.id;

  v_approval := case
    when m.organization_id is null then 'none'
    when m.approved_at is not null then 'approved'
    when m.refused_reason is not null then 'refused'
    when m.approved_legal_name is not null then 'lost'
    when m.requested_at is not null then 'pending'
    else 'none'
  end;

  if not v_enabled then
    v_common := v_common || 'network_off'::text;
  end if;
  if o.status is distinct from 'active' then
    v_common := v_common || 'org_inactive'::text;
  end if;
  if m.suspended_at is not null then
    v_common := v_common || 'suspended'::text;
  end if;
  v_out := v_common;
  v_in := v_common;
  if m.organization_id is null or not m.share_out then
    v_out := v_out || 'not_sharing'::text;
  end if;
  if m.organization_id is null or not m.share_in then
    v_in := v_in || 'not_receiving'::text;
  end if;
  if not private.network_terms_ok(m.terms_version) then
    v_approval_codes := v_approval_codes || 'terms'::text;
  elsif m.terms_version is distinct from p.network_terms_version then
    v_warnings := v_warnings || 'terms_grace'::text;
  end if;
  if v_approval <> 'approved'
     and (nullif(btrim(coalesce(o.legal_name, '')), '') is null or nullif(btrim(coalesce(o.siret, '')), '') is null
          or nullif(btrim(coalesce(o.vtc_registration, '')), '') is null) then
    v_approval_codes := v_approval_codes || 'vtc_registration'::text;
  end if;
  if v_approval = 'refused' then
    v_approval_codes := v_approval_codes || 'approval_refused'::text;
  elsif v_approval = 'lost' then
    v_approval_codes := v_approval_codes || 'approval_lost'::text;
  elsif v_approval <> 'approved' then
    v_approval_codes := v_approval_codes || 'approval_pending'::text;
  end if;
  v_out := v_out || v_approval_codes;
  v_in := v_in || v_approval_codes;
  if not (coalesce(private.settlement_methods_available(s), '{}'::text[]) && array['link', 'transfer']::text[]) then
    v_out := v_out || 'online_payment_method'::text;
  end if;
  if m.insurance_confirmed_at is null then
    v_in := v_in || 'insurance'::text;
  end if;
  if coalesce(o.platform_fee_percent, 0) = 0 and coalesce(o.platform_fee_fixed_cents, 0) = 0
     and not coalesce(m.fee_waiver, false) then
    v_out := v_out || 'platform_fee'::text;
  end if;
  if exists (
    select 1 from public.ride_settlements x
     where x.organization_id = p_org
       and x.network_driver_org_id is not null
       and x.direction = 'centrale_owes'
       and x.status = 'due'
       and x.due_at < now() - interval '7 days') then
    v_out := v_out || 'payouts_overdue'::text;
  end if;

  return jsonb_build_object(
    'enabled', v_enabled,
    'share_out', jsonb_build_object('active', private.network_org_reason(p_org, 'out') is null,
                                    'missing', to_jsonb(v_out), 'warnings', to_jsonb(v_warnings)),
    'share_in', jsonb_build_object('active', private.network_org_reason(p_org, 'in') is null,
                                   'missing', to_jsonb(v_in), 'warnings', to_jsonb(v_warnings)),
    'terms', jsonb_build_object('version', p.network_terms_version, 'min_version', p.network_terms_min_version,
                                'grace_until', p.network_terms_grace_until, 'accepted_version', m.terms_version,
                                'accepted_at', m.terms_accepted_at),
    'approval', jsonb_build_object('status', v_approval, 'requested_at', m.requested_at, 'approved_at', m.approved_at,
                                   'refused_reason', m.refused_reason),
    'suspended_reason', m.suspended_reason);
end;
$$;

-- =============================================================================
-- 2. Chauffeur partenaire (§11.2) — portée private.current_driver_id()
-- =============================================================================

-- Course vue par le chauffeur qui la tient (contrats DriverRide, DriverRideMoney, BookingVoucher) : LISTE BLANCHE des
-- champs de l'écran course (apps/driver/app/(app)/ride/[id].tsx), jamais la répartition interne de la course (commission,
-- frais Rydar, part des chauffeurs de A), l'e-mail du client, la référence externe, la clé API ni le créateur.
--  * Course de son organisation : tout ce que lisait l'app (ligne rides), client compris ; argent : sa part et celle de
--    l'organisation en centrale (répartition de la course), rien en flotte (jamais les frais Rydar d'une flotte, S20) ;
--    bon de réservation (§7.5).
--  * Course partenaire (§11.1) : adresse exacte, coordonnées, tracé, commentaire, vol après l'acceptation et jusqu'à la
--    fin + 1 h (ensuite : communes et coordonnées arrondies, comme l'offre et l'historique) ; client (nom, téléphone)
--    seulement de la prise en charge − 60 min (immédiate : dès l'acceptation) à la fin + 1 h, et si p_client (les
--    lectures sont comptées par public.driver_ride) ; motif d'annulation de A jamais ; argent : termes figés de son
--    exécution (UN montant « part de {A} », jamais commission ni frais Rydar) ; bloc « network » : A (instantané validé,
--    téléphone jusqu'à la fin + 48 h, prolongé tant qu'un règlement est ouvert, 30 jours au plus).
-- NULL : course partenaire sans exécution de ce chauffeur (jamais lisible).
create or replace function private.driver_ride_json(r public.rides, d public.drivers, p_client boolean)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  o public.organizations;
  m public.network_memberships;
  e public.ride_network_executions;
  v_partner boolean := r.organization_id <> d.organization_id;
  v_collects boolean := r.payment_method in ('cash', 'card');
  v_exact boolean := true;
  v_from timestamptz;
  v_until timestamptz;
  v_client boolean := true;
  v_phone_until timestamptz;
  v_phone text;
  v_drop_area text := coalesce(private.address_city(r.dropoff_address), private.address_area(r.dropoff_address));
  v_money jsonb;
  v_network jsonb;
  v_operator jsonb;
  v_booked_by jsonb;
  v_giver_part integer;
begin
  select * into o from public.organizations x where x.id = r.organization_id;
  if v_partner then
    select * into e from public.ride_network_executions x
     where x.ride_id = r.id and x.executor_driver_id = d.id
     order by x.accepted_at desc
     limit 1;
    if not found then
      return null;
    end if;
    select * into m from public.network_memberships x where x.organization_id = r.organization_id;
    v_exact := e.ended_at is null or now() < e.ended_at + interval '60 minutes';
    v_from := case when r.type = 'instant' then e.accepted_at
                   else greatest(r.pickup_at - interval '60 minutes', e.accepted_at) end;
    v_until := e.ended_at + interval '60 minutes';
    v_client := coalesce(p_client, false) and now() >= v_from and (v_until is null or now() < v_until);
    v_phone_until := private.network_phone_until(e.ended_at, e.id);
    v_phone := case when v_phone_until is null or now() < v_phone_until then o.phone end;
    v_money := jsonb_build_object(
      'price_cents', (e.terms ->> 'price_cents')::integer,
      'currency', r.currency,
      'payment_method', e.terms ->> 'payment_method',
      'collects', (e.terms ->> 'collects')::boolean,
      'driver_part_cents', (e.terms ->> 'driver_payout_cents')::integer,
      'giver_part_cents', (e.terms ->> 'giver_cut_cents')::integer,
      'direction', e.terms ->> 'direction',
      'amount_cents', (e.terms ->> 'amount_cents')::integer,
      'counterparty', e.counterparty,
      'creditor_name', o.name);
    v_network := jsonb_build_object(
      'execution_id', e.id,
      'giver', jsonb_build_object(
        'name', o.name,
        'legal_name', coalesce(m.approved_legal_name, o.legal_name),
        'vtc_registration', coalesce(m.approved_vtc_registration, o.vtc_registration),
        'phone', v_phone,
        'phone_until', v_phone_until));
    v_booked_by := jsonb_build_object('name', o.name, 'legal_name', coalesce(m.approved_legal_name, o.legal_name),
      'vtc_registration', coalesce(m.approved_vtc_registration, o.vtc_registration), 'phone', v_phone);
    v_operator := case when e.operator ->> 'dispatch_model' = 'centrale'
      then jsonb_build_object('kind', 'driver', 'name', btrim(d.first_name || ' ' || d.last_name),
                              'vtc_registration', e.operator ->> 'driver_operator_registration')
      else jsonb_build_object('kind', 'organization',
                              'name', coalesce(nullif(e.operator ->> 'legal_name', ''), e.operator ->> 'name'),
                              'vtc_registration', e.operator ->> 'vtc_registration') end;
  else
    if o.dispatch_model = 'centrale' and r.driver_payout_cents is not null then
      v_giver_part := coalesce(r.commission_cents, 0) + coalesce(r.platform_fee_cents, 0);
      v_money := jsonb_build_object(
        'price_cents', r.price_cents, 'currency', r.currency, 'payment_method', r.payment_method,
        'collects', v_collects, 'driver_part_cents', r.driver_payout_cents, 'giver_part_cents', v_giver_part,
        'direction', case when v_collects then 'driver_owes' else 'centrale_owes' end,
        'amount_cents', case when v_collects then v_giver_part else r.driver_payout_cents end,
        'counterparty', null, 'creditor_name', o.name);
    else
      v_money := jsonb_build_object(
        'price_cents', r.price_cents, 'currency', r.currency, 'payment_method', r.payment_method,
        'collects', v_collects, 'driver_part_cents', null, 'giver_part_cents', null, 'direction', null,
        'amount_cents', null, 'counterparty', null, 'creditor_name', null);
    end if;
    v_booked_by := jsonb_build_object('name', o.name, 'legal_name', o.legal_name,
      'vtc_registration', o.vtc_registration, 'phone', o.phone);
    v_operator := case when o.dispatch_model = 'centrale'
      then jsonb_build_object('kind', 'driver', 'name', btrim(d.first_name || ' ' || d.last_name),
                              'vtc_registration', d.vtc_operator_registration)
      else jsonb_build_object('kind', 'organization', 'name', coalesce(nullif(btrim(o.legal_name), ''), o.name),
                              'vtc_registration', o.vtc_registration) end;
  end if;

  return jsonb_build_object(
    'id', r.id,
    'number', r.number,
    'type', r.type,
    'status', r.status,
    'pickup_address', case when v_exact then r.pickup_address
                           else coalesce(private.address_area(r.pickup_address), 'Départ communiqué après acceptation') end,
    'pickup_lat', case when v_exact then r.pickup_lat else private.network_round_coord(r.pickup_lat) end,
    'pickup_lng', case when v_exact then r.pickup_lng else private.network_round_coord(r.pickup_lng) end,
    'dropoff_address', case when v_exact then r.dropoff_address
                            else coalesce(v_drop_area, 'Arrivée communiquée après acceptation') end,
    'dropoff_lat', case when v_exact then r.dropoff_lat else private.network_round_coord(r.dropoff_lat) end,
    'dropoff_lng', case when v_exact then r.dropoff_lng else private.network_round_coord(r.dropoff_lng) end,
    'pickup_at', r.pickup_at,
    'created_at', r.created_at,
    'accepted_at', case when v_partner then e.accepted_at else r.accepted_at end,
    'completed_at', r.completed_at,
    'cancelled_at', r.cancelled_at,
    'cancel_reason', case when v_partner then null else r.cancel_reason end,
    'passengers', r.passengers,
    'luggage', r.luggage,
    'vehicle_category', r.vehicle_category,
    'estimated_distance_m', r.estimated_distance_m,
    'estimated_duration_s', r.estimated_duration_s,
    'route_polyline', case when v_exact then r.route_polyline end,
    'flight_number', case when v_exact then r.flight_number end,
    'comment', case when v_exact then r.comment end)
  || jsonb_build_object(
    'customer_name', case when v_client then r.customer_name end,
    'customer_phone', case when v_client then r.customer_phone end,
    'customer_visible_from', case when v_partner then v_from end,
    'customer_visible_until', case when v_partner then v_until end,
    'price_cents', r.price_cents,
    'currency', r.currency,
    'payment_method', r.payment_method,
    'flight_mode', r.flight_mode,
    'flight_status', case when v_exact then r.flight_status end,
    'flight_scheduled_arrival', r.flight_scheduled_arrival,
    'flight_estimated_arrival', case when v_exact then r.flight_estimated_arrival end,
    'flight_actual_arrival', case when v_exact then r.flight_actual_arrival end,
    'flight_terminal', case when v_exact then r.flight_terminal end,
    'flight_origin', case when v_exact then r.flight_origin end,
    'flight_delay_minutes', case when v_exact then r.flight_delay_minutes end,
    'pickup_at_original', r.pickup_at_original,
    'money', v_money,
    'network', v_network,
    'voucher', jsonb_build_object(
      'booked_by', v_booked_by,
      'operator', v_operator,
      'booked_at', r.created_at,
      'pickup_at', r.pickup_at,
      'pickup_address', case when v_exact then r.pickup_address
                             else coalesce(private.address_area(r.pickup_address), 'Départ communiqué après acceptation') end,
      'customer', case when v_client then jsonb_build_object('name', r.customer_name, 'phone', r.customer_phone) end,
      'receipt_by', o.name));
end;
$$;

-- État réseau du chauffeur (contrat DriverNetworkState) : son interrupteur, l'autorisation de son organisation, les
-- conditions acceptées et la version en vigueur, réception effective de son organisation, capacité de l'app, exclusion
-- temporaire, lisibilité complète (private.network_driver_readiness, lot argent) et coordonnées bancaires masquées.
-- mode : toujours « consent » (décision Q2 : il accepte et règle toujours lui-même).
create or replace function private.driver_network_state_json(p_driver uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'enabled', coalesce(n.enabled, false),
    'org_allowed', coalesce(n.org_allowed, true),
    'accepted_version', n.accepted_version,
    'accepted_at', n.accepted_at,
    'terms', jsonb_build_object('version', p.network_terms_version, 'min_version', p.network_terms_min_version,
                                'grace_until', p.network_terms_grace_until),
    'mode', 'consent',
    'organization', jsonb_build_object('id', o.id, 'name', o.name, 'dispatch_model', o.dispatch_model,
                                       'receiving', private.network_org_reason(o.id, 'in') is null),
    'capable_at', n.capable_at,
    'excluded_until', case when n.excluded_until > now() then n.excluded_until end,
    'readiness', private.network_driver_readiness(d.id),
    'payout', private.driver_payout_json(d.id))
  from public.drivers d
  join public.organizations o on o.id = d.organization_id
  left join public.driver_network_settings n on n.driver_id = d.id
  cross join (select x.network_terms_version, x.network_terms_min_version, x.network_terms_grace_until
                from public.platform_settings x where x.id) p
  where d.id = p_driver;
$$;

-- Offres en attente du chauffeur (contrat DriverOfferV2) : ses offres propres = public.driver_offers() À L'IDENTIQUE
-- (même ordre) + « network »: null ; puis ses offres partenaires (réseau ouvert, cycle de partage courant) au format du
-- §9.4 : départ = « code postal + commune » (private.address_area, sinon « Départ communiqué après acceptation »),
-- arrivée = commune, coordonnées arrondies à ~300 m, distance au départ déjà arrondie à 100 m ; ni tracé, ni n° de vol,
-- ni commentaire, ni client ; vol : mode et heure prévue seulement ; argent : termes figés de l'offre, UN montant
-- (part du chauffeur + « part de {A} »), jamais commission ni frais Rydar ; blocage = règles locales
-- (private.network_blocker) avec son message aux noms de A et de B. Répond toujours (interrupteur coupé : offres
-- propres seulement, comme driver_offers()).
create or replace function public.driver_offers_v2()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_own jsonb;
  v_network jsonb;
begin
  select coalesce(jsonb_agg(x.v || jsonb_build_object('network', null) order by x.n), '[]'::jsonb) into v_own
    from jsonb_array_elements(public.driver_offers()) with ordinality as x(v, n);
  select * into d from public.drivers where id = private.current_driver_id();
  if not found or not public.shared_network_enabled() then
    return v_own;
  end if;

  select coalesce(jsonb_agg(
      jsonb_build_object(
        'offer_id', o.id,
        'ride_id', r.id,
        'number', r.number,
        'mode', o.mode,
        'status', o.status,
        'ride_type', r.type,
        'pickup_address', coalesce(z.pickup_area, 'Départ communiqué après acceptation'),
        'pickup_lat', private.network_round_coord(r.pickup_lat),
        'pickup_lng', private.network_round_coord(r.pickup_lng),
        'dropoff_address', coalesce(z.dropoff_area, 'Arrivée communiquée après acceptation'),
        'dropoff_lat', private.network_round_coord(r.dropoff_lat),
        'dropoff_lng', private.network_round_coord(r.dropoff_lng),
        'pickup_at', r.pickup_at,
        'price_cents', (o.network_terms ->> 'price_cents')::integer,
        'currency', r.currency,
        'payment_method', o.network_terms ->> 'payment_method',
        'passengers', r.passengers,
        'luggage', r.luggage,
        'vehicle_category', r.vehicle_category,
        'distance_m', o.distance_m,
        'estimated_distance_m', r.estimated_distance_m,
        'estimated_duration_s', r.estimated_duration_s,
        'route_polyline', null,
        'flight_number', null,
        'comment', null,
        'sent_at', o.sent_at,
        'expires_at', o.expires_at)
      || jsonb_build_object(
        'flight_mode', r.flight_mode,
        'flight_status', null,
        'flight_scheduled_arrival', r.flight_scheduled_arrival,
        'flight_estimated_arrival', null,
        'flight_actual_arrival', null,
        'flight_delay_minutes', null,
        'flight_terminal', null,
        'flight_origin', null,
        'pickup_at_original', r.pickup_at_original)
      || jsonb_build_object(
        'dispatch_model', null,
        'commission_cents', null,
        'platform_fee_cents', null,
        'driver_payout_cents', (o.network_terms ->> 'driver_payout_cents')::integer,
        'driver_collects', (o.network_terms ->> 'collects')::boolean,
        'blocked', z.blocked,
        'blocked_message', case when z.blocked is not null
                                then private.network_blocker_message(z.blocked, g.name, b.name) end,
        'network', jsonb_build_object(
          'giver', jsonb_build_object('name', g.name,
                                      'legal_name', coalesce(m.approved_legal_name, g.legal_name),
                                      'vtc_registration', coalesce(m.approved_vtc_registration, g.vtc_registration)),
          'pickup_area', z.pickup_area,
          'dropoff_area', z.dropoff_area,
          'money', jsonb_build_object(
            'price_cents', (o.network_terms ->> 'price_cents')::integer,
            'currency', r.currency,
            'payment_method', o.network_terms ->> 'payment_method',
            'collects', (o.network_terms ->> 'collects')::boolean,
            'driver_part_cents', (o.network_terms ->> 'driver_payout_cents')::integer,
            'giver_part_cents', (o.network_terms ->> 'giver_cut_cents')::integer,
            'direction', o.network_terms ->> 'direction',
            'amount_cents', (o.network_terms ->> 'amount_cents')::integer,
            'counterparty', 'driver')))
      order by r.type, o.sent_at desc), '[]'::jsonb)
    into v_network
    from public.ride_offers o
    join public.rides r on r.id = o.ride_id
    join public.organizations g on g.id = r.organization_id
    join public.organizations b on b.id = d.organization_id
    left join public.network_memberships m on m.organization_id = g.id
    cross join lateral (
      select private.address_area(r.pickup_address) as pickup_area,
             coalesce(private.address_city(r.dropoff_address), private.address_area(r.dropoff_address)) as dropoff_area,
             private.network_blocker(d.id, g.id, private.network_terms_debt(o.network_terms)) as blocked) z
   where o.driver_id = d.id
     and o.status = 'pending'
     and o.is_network
     and r.driver_id is null
     and r.status in ('SEARCHING_DRIVER', 'OFFERED')
     and r.network_at is not null
     and o.sent_at >= r.network_at;

  return v_own || v_network;
end;
$$;

-- Course du chauffeur (propre ou partenaire), liste blanche (private.driver_ride_json) ; course qu'il ne tient pas
-- (retirée, réattribuée, d'une autre organisation) : RIDE_NOT_FOUND. Course partenaire : chaque réponse qui contient le
-- nom ou le téléphone du client est comptée pour A (client_data_reads, première et dernière lecture : fiche course de
-- A). Repli C3 (comme driver_update_ride_status) : fiche ou organisation du chauffeur devenue inactive, client à bord
-- d'une course d'une autre organisation (ou terminée depuis moins d'une heure) — le compte qui la tient la lit encore
-- pour la terminer. Répond toujours (interrupteur coupé compris).
create or replace function public.driver_ride(p_ride uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  r public.rides;
  v jsonb;
begin
  select * into d from public.drivers where id = private.current_driver_id();
  if not found then
    select x.* into d
      from public.drivers x
      join public.rides y on y.driver_id = x.id
     where x.user_id = auth.uid()
       and x.deleted_at is null
       and y.id = p_ride
       and y.organization_id <> x.organization_id
       and (y.status in ('PASSENGER_ONBOARD', 'IN_PROGRESS')
            or (y.status = 'COMPLETED' and y.completed_at > now() - interval '1 hour'));
    if not found then
      raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
    end if;
  end if;
  select * into r from public.rides x where x.id = p_ride and x.driver_id = d.id;
  if not found then
    raise exception 'RIDE_NOT_FOUND: course introuvable' using errcode = 'P0002';
  end if;
  v := private.driver_ride_json(r, d, true);
  if v is null then
    raise exception 'RIDE_NOT_FOUND: course introuvable' using errcode = 'P0002';
  end if;
  -- Lectures des coordonnées du client d'une course partenaire, enregistrées pour A (§11.1)
  if jsonb_typeof(v -> 'network') = 'object' and (v ->> 'customer_name') is not null then
    update public.ride_network_executions x
       set client_data_reads = x.client_data_reads + 1,
           client_data_first_read_at = coalesce(x.client_data_first_read_at, now()),
           client_data_last_read_at = now()
     where x.id = (v -> 'network' ->> 'execution_id')::uuid;
  end if;
  return v;
end;
$$;

-- Courses du chauffeur à venir ou en cours (propres et partenaires), dans l'ordre de prise en charge, 50 au plus : même
-- liste blanche que driver_ride, SANS le client d'une course partenaire (le planning ne l'affiche pas : aucune lecture
-- comptée ; l'écran course le lit par driver_ride). Remplace la lecture directe de rides par l'app (RLS : courses propres
-- seulement). Répond toujours.
create or replace function public.driver_rides_upcoming()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d public.drivers;
begin
  select * into d from public.drivers where id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(x.v order by x.pickup_at, x.id)
      from (select private.driver_ride_json(r, d, false) as v, r.pickup_at, r.id
              from public.rides r
             where r.driver_id = d.id
               and r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS')
             order by r.pickup_at, r.id
             limit 50) x
     where x.v is not null), '[]'::jsonb);
end;
$$;

-- État réseau du chauffeur (profil, conditions, lisibilité). Réseau fermé : NETWORK_DISABLED (l'app n'affiche alors rien
-- du réseau, hors sommes déjà nées : driver_network_settings, driver_payout_info).
create or replace function public.driver_network_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_driver uuid := private.current_driver_id();
begin
  if v_driver is null then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  perform private.assert_network_open();
  return private.driver_network_state_json(v_driver);
end;
$$;

-- Nouvelle application ouverte (démarrage, retour au premier plan) : capable d'afficher les offres partenaires
-- (capable_at : sans signe depuis 7 jours, plus d'offre réseau — raison « app_update »). Réseau fermé : NETWORK_DISABLED
-- (rien n'est écrit ; l'app ignore le refus).
create or replace function public.driver_network_ping()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_at timestamptz;
begin
  select * into d from public.drivers where id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  perform private.assert_network_open();
  insert into public.driver_network_settings (driver_id, organization_id, capable_at)
  values (d.id, d.organization_id, now())
  on conflict (driver_id) do update set capable_at = excluded.capable_at
  returning capable_at into v_at;
  return jsonb_build_object('capable_at', v_at);
end;
$$;

-- Interrupteur « Courses du réseau partagé » du chauffeur (§6.2, §7.3). Activer : conditions de la version EN VIGUEUR
-- (p_version = platform_settings.network_terms_version, sinon NETWORK_TERMS_OUTDATED), preuve dans legal_acceptances
-- (« network_driver », au nom de son organisation, source app, idempotente), ou sans p_version si ses conditions
-- acceptées sont encore valables (sinon NETWORK_TERMS_REQUIRED). Arrêter : ses offres partenaires en attente fermées
-- (les courses déjà acceptées restent à faire). Audit « driver.network_consent » chez B. Renvoie son état réseau.
create or replace function public.driver_set_network(p_enabled boolean, p_version text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  n public.driver_network_settings;
  v_current text;
  v_version text := nullif(btrim(coalesce(p_version, '')), '');
  v_closed integer := 0;
  v_changed boolean;
begin
  select * into d from public.drivers where id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  perform private.assert_network_open();
  if p_enabled is null then
    raise exception 'p_enabled obligatoire' using errcode = '22023';
  end if;
  select x.network_terms_version into v_current from public.platform_settings x where x.id;
  select * into n from public.driver_network_settings x where x.driver_id = d.id for update;

  if p_enabled then
    if v_version is not null then
      if v_version is distinct from v_current then
        raise exception 'NETWORK_TERMS_OUTDATED: conditions du réseau partagé changées, lisez la version en vigueur'
          using errcode = '55000';
      end if;
      insert into public.legal_acceptances (user_id, organization_id, document, version, source)
      values (auth.uid(), d.organization_id, 'network_driver', v_version, 'app')
      on conflict do nothing;
    elsif not private.network_terms_ok(n.accepted_version) then
      raise exception 'NETWORK_TERMS_REQUIRED: conditions du réseau partagé à accepter' using errcode = '55000';
    end if;
    v_changed := n.driver_id is null or not n.enabled
                 or (v_version is not null and n.accepted_version is distinct from v_version);
    if n.driver_id is null then
      -- Première acceptation (v_version posée : sinon NETWORK_TERMS_REQUIRED ci-dessus) ; une ligne née entre-temps
      -- (signe de vie de l'app) est complétée
      insert into public.driver_network_settings (driver_id, organization_id, enabled, accepted_version, accepted_at)
      values (d.id, d.organization_id, true, v_version, now())
      on conflict (driver_id) do update
        set enabled = true, accepted_version = excluded.accepted_version, accepted_at = excluded.accepted_at;
    else
      update public.driver_network_settings x
         set enabled = true,
             accepted_version = coalesce(v_version, x.accepted_version),
             accepted_at = case when v_version is not null and v_version is distinct from x.accepted_version
                                then now() else x.accepted_at end
       where x.driver_id = d.id;
    end if;
  else
    v_changed := coalesce(n.enabled, false);
    insert into public.driver_network_settings (driver_id, organization_id, enabled)
    values (d.id, d.organization_id, false)
    on conflict (driver_id) do update set enabled = false;
    v_closed := private.close_network_offers(null, null, d.id, 'network_unavailable');
  end if;

  if v_changed then
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity,
                                   metadata)
    values (d.organization_id, 'driver', auth.uid(), 'driver.network_consent', 'drivers', d.id::text, 'info',
            jsonb_build_object('enabled', p_enabled, 'version', case when p_enabled then coalesce(v_version, n.accepted_version) end,
                               'closed_offers', v_closed));
  end if;
  return private.driver_network_state_json(d.id);
end;
$$;

-- =============================================================================
-- 3. Organisation qui confie la course (A, §11.3)
-- =============================================================================

-- Élément de « Courses confiées » (contrat NetworkGivenItem) : la course (données de A), l'exécution (libellé court du
-- partenaire, jamais son identité complète) et le règlement réseau (settlement_json, bloc « network » compris).
create or replace function private.network_given_item(e public.ride_network_executions, r public.rides,
                                                      x public.ride_settlements)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'ride', jsonb_build_object(
      'id', r.id, 'number', r.number, 'type', r.type, 'status', r.status, 'pickup_at', r.pickup_at,
      'completed_at', r.completed_at, 'pickup_address', r.pickup_address, 'dropoff_address', r.dropoff_address,
      'customer_name', r.customer_name, 'currency', r.currency),
    'execution', private.network_execution_summary(e),
    'settlement', case when x.id is null then null else private.settlement_json(x) end);
$$;

-- Bande d'indicateurs et pastille (contrat OrgNetworkSummary) : courses confiées (en recherche réseau, tenues par un
-- partenaire, à encaisser, à confirmer, à verser, à vérifier, en retard, contestations ouvertes), courses de ses
-- chauffeurs pour d'autres organisations (en cours, du mois, total, règlements ouverts) et lisibilité. Lu à chaque page
-- du tableau de bord réseau ouvert : index partiels (section 5). Tout membre ; owner / admin d'une organisation
-- suspendue ou archivée. Indépendante de l'interrupteur (NETWORK_CLOSED_RPCS).
--  * en retard : règlement « dû » échu, dans les deux sens (reversement du chauffeur, versement de A) ;
--  * contestations ouvertes : règlement encore ouvert marqué « Pas reçu », contesté par le chauffeur ou course
--    contestée ;
--  * à vérifier : course partagée terminée avec des contrôles de fin signalés, ni validée ni contestée.
create or replace function public.org_network_summary(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  v_searching integer;
  v_in_progress integer;
  v_to_check integer;
  g record;
  v_rec record;
  v_month text;
begin
  perform private.assert_network_reader(p_org);
  select * into o from public.organizations x where x.id = p_org;
  v_month := to_char(now() at time zone coalesce(o.timezone, 'Europe/Paris'), 'YYYY-MM');

  select count(*)::integer into v_searching
    from public.rides r
   where r.organization_id = p_org
     and r.network_at is not null
     and r.driver_id is null
     and r.status in ('CREATED', 'SEARCHING_DRIVER', 'OFFERED');
  select count(*)::integer into v_in_progress
    from public.ride_network_executions e
   where e.organization_id = p_org and e.ended_at is null;
  select count(*)::integer into v_to_check
    from public.ride_network_executions e
   where e.organization_id = p_org
     and e.end_reason = 'completed'
     and e.validated_at is null
     and e.contested_at is null
     and cardinality(e.suspect_reasons) > 0;

  select coalesce(sum(x.amount_cents) filter (where x.direction = 'driver_owes'), 0)::integer as to_collect,
         count(*) filter (where x.direction = 'driver_owes' and x.status = 'declared')::integer as to_confirm,
         coalesce(sum(x.amount_cents) filter (where x.direction = 'centrale_owes' and x.status = 'due'), 0)::integer as to_pay,
         coalesce(sum(x.amount_cents) filter (where x.status = 'due' and x.due_at <= now()), 0)::integer as overdue_cents,
         count(*) filter (where x.status = 'due' and x.due_at <= now())::integer as overdue_count,
         count(*) filter (where x.status = 'disputed' or x.driver_disputed_at is not null
                          or exists (select 1 from public.ride_network_executions e
                                      where e.id = x.network_execution_id and e.contested_at is not null))::integer
           as disputed
    into g
    from public.ride_settlements x
   where x.organization_id = p_org
     and x.network_driver_org_id is not null
     and x.status in ('due', 'declared', 'disputed');

  select count(*) filter (where e.ended_at is null)::integer as in_progress,
         count(*) filter (where e.end_reason = 'completed' and private.network_month(e) = v_month)::integer as month_rides,
         count(*)::integer as total_rides
    into v_rec
    from public.ride_network_executions e
   where e.executor_org_id = p_org;

  return jsonb_build_object(
    'currency', coalesce(o.currency, 'EUR'),
    'readiness', private.org_network_readiness(p_org),
    'given', jsonb_build_object(
      'searching', v_searching,
      'in_progress', v_in_progress,
      'to_collect_cents', g.to_collect,
      'to_confirm_count', g.to_confirm,
      'to_pay_cents', g.to_pay,
      'to_check_count', v_to_check,
      'overdue_cents', g.overdue_cents,
      'overdue_count', g.overdue_count,
      'disputed_count', g.disputed),
    'received', jsonb_build_object(
      'in_progress', v_rec.in_progress,
      'month_rides', v_rec.month_rides,
      'total_rides', v_rec.total_rides,
      'open_count', (select count(*)::integer from public.ride_settlements x
                      where x.network_driver_org_id = p_org
                        and x.status in ('due', 'declared', 'disputed'))),
    'badge', g.to_confirm + g.overdue_count + v_to_check);
end;
$$;

-- « Courses confiées » (contrat OrgNetworkGiven) : exécutions des courses de p_org par des chauffeurs partenaires, de
-- la plus récente à la plus ancienne (curseur p_before = accepted_at du dernier élément, next_before NULL en fin de
-- liste), p_limit de 1 à 500. Filtres (NETWORK_GIVEN_FILTERS ; inconnu → « all ») : in_progress (tenue maintenant),
-- to_check (terminée, à vérifier), to_collect (reversement non soldé), to_confirm (signalé payé), overdue (dû et échu,
-- deux sens), disputed (« Pas reçu », contestation du chauffeur ou course contestée), to_pay (versement dû), settled
-- (réglé ou annulé). p_partner : organisation du chauffeur ; p_month (« AAAA-MM ») : mois de la course partagée
-- (private.network_month : fin, sinon acceptation, fuseau de A — même mois chez B). Tout membre ; owner / admin d'une
-- organisation suspendue ou archivée. Indépendante de l'interrupteur.
create or replace function public.org_network_given(p_org uuid, p_filter text default 'all', p_partner uuid default null,
                                                    p_month text default null, p_limit integer default 50,
                                                    p_before timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_filter text := coalesce(nullif(btrim(coalesce(p_filter, '')), ''), 'all');
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_items jsonb;
  v_count integer;
  v_last timestamptz;
begin
  perform private.assert_network_reader(p_org);
  if v_filter not in ('all', 'in_progress', 'to_check', 'to_collect', 'to_confirm', 'overdue', 'disputed', 'to_pay',
                      'settled') then
    v_filter := 'all';
  end if;
  if p_month is not null and p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'p_month invalide : AAAA-MM attendu' using errcode = '22023';
  end if;

  with page as (
    select e, r, x
      from public.ride_network_executions e
      join public.rides r on r.id = e.ride_id
      left join public.ride_settlements x on x.network_execution_id = e.id and x.network_driver_org_id is not null
     where e.organization_id = p_org
       and (p_partner is null or e.executor_org_id = p_partner)
       and (p_month is null or private.network_month(e) = p_month)
       and (p_before is null or e.accepted_at < p_before)
       and case v_filter
             when 'in_progress' then e.ended_at is null
             when 'to_check' then e.end_reason = 'completed' and e.validated_at is null and e.contested_at is null
                                  and cardinality(e.suspect_reasons) > 0
             when 'to_collect' then x.direction = 'driver_owes' and x.status in ('due', 'declared', 'disputed')
             when 'to_confirm' then x.direction = 'driver_owes' and x.status = 'declared'
             when 'overdue' then x.status = 'due' and x.due_at <= now()
             when 'disputed' then x.status = 'disputed' or x.driver_disputed_at is not null or e.contested_at is not null
             when 'to_pay' then x.direction = 'centrale_owes' and x.status = 'due'
             when 'settled' then x.status in ('paid', 'waived')
             else true
           end
     order by e.accepted_at desc, e.id desc
     limit v_limit
  )
  select coalesce(jsonb_agg(private.network_given_item(page.e, page.r, page.x)
                            order by (page.e).accepted_at desc, (page.e).id desc), '[]'::jsonb),
         count(*)::integer, min((page.e).accepted_at)
    into v_items, v_count, v_last
    from page;

  return jsonb_build_object('filter', v_filter, 'items', v_items,
                            'next_before', case when v_count = v_limit then v_last end);
end;
$$;

-- Bloc « Réseau partagé » de la fiche course de A (contrat OrgNetworkRide) : partage (cycle, étape, compteur des
-- partenaires sollicités seulement), exécution en cours ou dernière (libellé court, véhicule, contrôles figés,
-- téléphone du chauffeur de l'acceptation à la fin + 48 h — prolongé tant que le règlement est ouvert, 30 jours au
-- plus —, lectures des coordonnées du client), carte permanente de l'organisation du chauffeur (instantané validé),
-- exécutants précédents (retraits), règlement, actions permises à l'appelant. NULL : course jamais partagée. Jamais
-- l'identifiant d'un partenaire non retenu. Tout membre de l'organisation de la course (active) ; course d'une autre
-- organisation : FORBIDDEN. Indépendante de l'interrupteur (sauf les exclusions, proposées réseau ouvert seulement).
create or replace function public.org_network_ride(p_ride uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r public.rides;
  s public.ride_network_shares;
  e public.ride_network_executions;
  x public.ride_settlements;
  d public.drivers;
  v_previous jsonb;
  v_execution jsonb;
  v_phone_until timestamptz;
  v_member boolean;
  v_admin boolean;
  v_creditor boolean;
  v_open boolean := public.shared_network_enabled();
  v_exec_status public.org_status;
  v_last timestamptz;
  v_close boolean := false;
  v_held boolean := false;
  v_completed boolean := false;
begin
  select * into r from public.rides y where y.id = p_ride;
  if not found then
    raise exception 'RIDE_NOT_FOUND: course introuvable' using errcode = 'P0002';
  end if;
  -- Fiche course du tableau de bord : organisation active (une organisation suspendue règle ses sommes en cours depuis
  -- /suspended/reseau-partage, sans fiche course : NETWORK_SUSPENDED_CREDITOR_RPCS)
  perform private.assert_org_member(r.organization_id);

  select * into s from public.ride_network_shares y where y.ride_id = r.id;
  -- Exécution affichée : en cours, terminée, ou close avec la course (annulée, non effectuée) ; un retrait (la course
  -- est repartie en recherche) va dans « previous »
  select * into e from public.ride_network_executions y
   where y.ride_id = r.id
     and (y.ended_at is null or y.end_reason in ('completed', 'cancelled_by_giver', 'not_performed'))
   order by y.accepted_at desc
   limit 1;
  if s.ride_id is null and e.id is null
     and not exists (select 1 from public.ride_network_executions y where y.ride_id = r.id) then
    return null;
  end if;

  select coalesce(jsonb_agg(private.network_execution_summary(y) order by y.accepted_at desc), '[]'::jsonb)
    into v_previous
    from public.ride_network_executions y
   where y.ride_id = r.id and y.id is distinct from e.id;

  v_member := private.is_org_member(r.organization_id);
  v_admin := private.has_org_role(r.organization_id, array['owner', 'admin']::public.org_role[]);
  v_creditor := private.network_creditor_ok(r.organization_id);

  if e.id is not null then
    select * into x from public.ride_settlements y
     where y.network_execution_id = e.id and y.network_driver_org_id is not null;
    select * into d from public.drivers y where y.id = e.executor_driver_id;
    v_held := e.ended_at is null and r.driver_id is not distinct from e.executor_driver_id;
    v_completed := coalesce(e.end_reason = 'completed', false);
    v_phone_until := private.network_phone_until(e.ended_at, e.id);
    v_execution := private.network_execution_summary(e) || jsonb_build_object(
      'checks', e.checks,
      'driver_phone', case when d.deleted_at is null and (v_phone_until is null or now() < v_phone_until)
                           then d.phone end,
      'driver_phone_until', v_phone_until,
      'client_data', jsonb_build_object('reads', e.client_data_reads, 'first_read_at', e.client_data_first_read_at,
                                        'last_read_at', e.client_data_last_read_at));
    -- « Clôturer la course » : mêmes conditions que public.close_network_ride (client à bord, chauffeur ou B inactif,
    -- ou aucune position depuis 30 min)
    if v_held and r.status in ('PASSENGER_ONBOARD', 'IN_PROGRESS') then
      select o.status into v_exec_status from public.organizations o where o.id = e.executor_org_id;
      select l.updated_at into v_last from public.driver_locations l where l.driver_id = e.executor_driver_id;
      v_close := d.id is null or d.status <> 'active' or d.deleted_at is not null
                 or v_exec_status is distinct from 'active'
                 or v_last is null or v_last < now() - interval '30 minutes';
    end if;
  end if;

  return jsonb_build_object(
    'ride_id', r.id,
    'share', case when s.ride_id is null then null else jsonb_build_object(
      'status', s.status, 'cycle', s.cycle, 'stage', s.opened_stage, 'opened_at', s.opened_at,
      'partners_offered', s.partners_offered, 'closed_at', s.closed_at, 'closed_reason', s.closed_reason) end,
    'execution', v_execution,
    'operator', case when e.id is null then null else e.operator end,
    'previous', v_previous,
    'settlement', case when x.id is null then null else private.settlement_json(x) end,
    'can', jsonb_build_object(
      'remove', coalesce(v_member and v_held and r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'), false),
      'close', coalesce(v_creditor and v_close, false),
      'validate', coalesce(v_creditor and v_completed and e.contested_at is null and e.validated_at is null
                           and (cardinality(e.suspect_reasons) > 0 or coalesce(e.hold_until > now(), false)), false),
      'contest', coalesce(v_creditor and v_completed and e.contested_at is null
                          and e.ended_at >= now() - interval '7 days', false),
      'exclude_driver', coalesce(v_admin and v_open and e.id is not null and e.executor_driver_id is not null
                                 and not private.network_driver_excluded(e.organization_id, e.executor_driver_id, e.id),
                                 false),
      'exclude_partner', coalesce(v_admin and v_open and e.id is not null
                                  and not exists (select 1 from public.network_exclusions y
                                                   where y.organization_id = r.organization_id
                                                     and y.excluded_org_id = e.executor_org_id), false)));
end;
$$;

-- Organisations déjà rencontrées (contrat NetworkPartnerNames) : { id : nom } des organisations dont un chauffeur a fait
-- une course de p_org, ou pour lesquelles un chauffeur de p_org en a fait une. Jamais une organisation seulement
-- sollicitée. Tout membre ; owner / admin d'une organisation suspendue ou archivée. Indépendante de l'interrupteur.
create or replace function public.network_partner_names(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_network_reader(p_org);
  return coalesce((
    select jsonb_object_agg(o.id, o.name)
      from (select e.executor_org_id as id from public.ride_network_executions e where e.organization_id = p_org
            union
            select e.organization_id from public.ride_network_executions e where e.executor_org_id = p_org) x
      join public.organizations o on o.id = x.id), '{}'::jsonb);
end;
$$;

-- Exclusion d'un chauffeur partenaire vue par A (contrat NetworkDriverExclusion) : libellé court, motif, date, auteur.
create or replace function private.network_driver_exclusion_json(x private.network_driver_exclusions)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', x.id,
    'label', x.label,
    'reason', x.reason,
    'created_at', x.created_at,
    'created_by_name', (select coalesce(nullif(btrim(u.full_name), ''), u.email) from public.users u where u.id = x.created_by),
    'lifted_at', x.lifted_at);
$$;

-- « Exclure ce chauffeur » (§6.1, §11.3) depuis une course confiée : owner / admin de A (organisation active), réseau
-- ouvert. Fondée sur ses empreintes d'identité (private.driver_identity_keys : téléphone, e-mails, carte VTC, compte),
-- valable même s'il change d'organisation ; ses offres partenaires de A en attente sont fermées. Idempotente : déjà
-- exclu (exclusion non levée qui le vise), même réponse avec l'exclusion existante. Audit « network.driver_excluded »
-- chez A (jamais les empreintes). Fiche supprimée (plus d'empreinte) : DRIVER_NOT_FOUND.
create or replace function public.exclude_network_driver(p_execution uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.ride_network_executions;
  x private.network_driver_exclusions;
  v_reason text := left(nullif(btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g')), ''), 300);
  v_kinds text[];
  v_hashes text[];
  v_closed integer := 0;
begin
  select * into e from public.ride_network_executions y where y.id = p_execution;
  if not found then
    raise exception 'RIDE_NOT_FOUND: course partagée introuvable' using errcode = 'P0002';
  end if;
  perform private.assert_org_member(e.organization_id, array['owner', 'admin']::public.org_role[]);
  perform private.assert_network_open();

  select y.* into x
    from private.network_driver_exclusions y
   where y.giver_org_id = e.organization_id
     and y.lifted_at is null
     and (y.execution_id = e.id
          or exists (select 1
                       from unnest(y.kinds, y.value_hashes) as u(kind, value_hash)
                       join private.driver_identity_keys k
                         on k.driver_id = e.executor_driver_id and k.kind = u.kind and k.value_hash = u.value_hash))
   order by y.created_at desc
   limit 1;
  if x.id is not null then
    return jsonb_build_object('ok', true, 'exclusion', private.network_driver_exclusion_json(x), 'closed_offers', 0);
  end if;

  select array_agg(k.kind order by k.kind, k.value_hash), array_agg(k.value_hash order by k.kind, k.value_hash)
    into v_kinds, v_hashes
    from (select k.kind, k.value_hash from private.driver_identity_keys k
           where k.driver_id = e.executor_driver_id
           order by k.kind, k.value_hash
           limit 50) k;
  if coalesce(cardinality(v_kinds), 0) = 0 then
    raise exception 'DRIVER_NOT_FOUND: chauffeur partenaire introuvable (compte supprimé)' using errcode = 'P0002';
  end if;

  insert into private.network_driver_exclusions (giver_org_id, execution_id, label, kinds, value_hashes, reason, created_by)
  values (e.organization_id, e.id,
          left(e.driver_label || ' · ' || coalesce(nullif(e.operator ->> 'name', ''), 'partenaire'), 200),
          v_kinds, v_hashes, v_reason, auth.uid())
  returning * into x;
  if e.executor_driver_id is not null then
    v_closed := private.close_network_offers(e.organization_id, null, e.executor_driver_id, 'network_unavailable');
  end if;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity,
                                 metadata)
  values (e.organization_id, 'user', auth.uid(), 'network.driver_excluded', 'network_driver_exclusions', x.id::text,
          'info', jsonb_build_object('execution_id', e.id, 'closed_offers', v_closed, 'reason', v_reason));
  return jsonb_build_object('ok', true, 'exclusion', private.network_driver_exclusion_json(x), 'closed_offers', v_closed);
end;
$$;

-- Chauffeurs partenaires exclus par p_org (Réglages › Options avancées), du plus récent au plus ancien, levées
-- comprises (200 au plus). Owner / admin, organisation active, réseau ouvert.
create or replace function public.org_network_driver_exclusions(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_org_member(p_org, array['owner', 'admin']::public.org_role[]);
  perform private.assert_network_open();
  return coalesce((
    select jsonb_agg(private.network_driver_exclusion_json(x) order by x.created_at desc, x.id)
      from (select * from private.network_driver_exclusions y
             where y.giver_org_id = p_org
             order by y.created_at desc, y.id
             limit 200) x), '[]'::jsonb);
end;
$$;

-- Lever l'exclusion d'un chauffeur partenaire : owner / admin de p_org (organisation active), réseau ouvert ;
-- exclusion d'une autre organisation ou inconnue : FORBIDDEN_TENANT ; déjà levée : même réponse. Audit
-- « network.driver_exclusion_lifted ».
create or replace function public.lift_network_driver_exclusion(p_org uuid, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  x private.network_driver_exclusions;
begin
  perform private.assert_org_member(p_org, array['owner', 'admin']::public.org_role[]);
  perform private.assert_network_open();
  select * into x from private.network_driver_exclusions y where y.id = p_id and y.giver_org_id = p_org for update;
  if not found then
    raise exception 'FORBIDDEN_TENANT: exclusion introuvable pour cette organisation' using errcode = '42501';
  end if;
  if x.lifted_at is null then
    update private.network_driver_exclusions y set lifted_at = now() where y.id = x.id;
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity,
                                   metadata)
    values (p_org, 'user', auth.uid(), 'network.driver_exclusion_lifted', 'network_driver_exclusions', x.id::text, 'info',
            jsonb_build_object('execution_id', x.execution_id));
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- =============================================================================
-- 4. Organisation du chauffeur (B, §11.4) — jamais le client, l'adresse exacte, le commentaire ni le détail de la part
--    de A ; jamais l'évolution de la course chez A après la fin de l'exécution
-- =============================================================================

-- Élément de « Courses reçues » (contrat NetworkReceivedItem) : date, heure, communes, chauffeur (sa fiche ; NULL si
-- supprimée), véhicule et montants figés à l'acceptation, organisation qui confie (nom, téléphone), état du règlement
-- (sens, échéance, retard, retenue, contestation du chauffeur), « à vérifier » / contestée. Statut : celui de la course
-- tant que le chauffeur la tient, sinon celui de l'exécution (COMPLETED, ou CANCELLED après un retrait ou une
-- annulation : la suite de la course chez A n'est jamais montrée).
create or replace function private.network_received_item(e public.ride_network_executions, r public.rides,
                                                         x public.ride_settlements)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'execution_id', e.id,
    'reference', 'R' || r.number,
    'accepted_at', e.accepted_at,
    'ended_at', e.ended_at,
    'end_reason', e.end_reason,
    'ride', jsonb_build_object(
      'type', r.type,
      'status', case when e.ended_at is null then r.status::text
                     when e.end_reason = 'completed' then 'COMPLETED' else 'CANCELLED' end,
      'pickup_at', r.pickup_at,
      'completed_at', case when e.end_reason = 'completed' then coalesce(r.completed_at, e.ended_at) end,
      'pickup_area', private.address_area(r.pickup_address),
      'dropoff_area', coalesce(private.address_city(r.dropoff_address), private.address_area(r.dropoff_address))),
    'driver', (select jsonb_build_object('id', d.id, 'number', d.number, 'first_name', d.first_name,
                                         'last_name', d.last_name)
                 from public.drivers d where d.id = e.executor_driver_id and d.deleted_at is null),
    'vehicle', e.vehicle,
    'giver', (select jsonb_build_object('id', g.id, 'name', g.name, 'phone', g.phone)
                from public.organizations g where g.id = e.organization_id),
    'money', jsonb_build_object(
      'price_cents', (e.terms ->> 'price_cents')::integer,
      'currency', r.currency,
      'payment_method', e.terms ->> 'payment_method',
      'driver_part_cents', (e.terms ->> 'driver_payout_cents')::integer,
      'direction', e.terms ->> 'direction',
      'amount_cents', (e.terms ->> 'amount_cents')::integer),
    'settlement', case when x.id is null then null else jsonb_build_object(
      'status', x.status,
      'overdue', x.status = 'due' and x.due_at <= now(),
      'due_at', x.due_at,
      'on_hold', x.direction = 'centrale_owes' and x.status = 'due' and coalesce(e.hold_until > now(), false),
      'driver_disputed', x.driver_disputed_at is not null) end,
    'to_check', e.end_reason = 'completed' and e.validated_at is null and e.contested_at is null
                and cardinality(e.suspect_reasons) > 0,
    'contested', e.contested_at is not null);
$$;

-- « Courses reçues » (contrat OrgNetworkReceived) : courses faites par les chauffeurs de p_org pour d'autres
-- organisations, de la plus récente à la plus ancienne (curseur p_before, p_limit de 1 à 500). Filtres
-- (NETWORK_RECEIVED_FILTERS ; inconnu → « all ») : in_progress, open (règlement ouvert), overdue (dû et échu),
-- to_check, settled. p_partner : organisation qui confie ; p_month : même mois que chez A (private.network_month).
-- Tout membre de p_org (organisation active). Indépendante de l'interrupteur (NETWORK_CLOSED_RPCS).
create or replace function public.org_network_received(p_org uuid, p_filter text default 'all', p_partner uuid default null,
                                                       p_month text default null, p_limit integer default 50,
                                                       p_before timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_filter text := coalesce(nullif(btrim(coalesce(p_filter, '')), ''), 'all');
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_items jsonb;
  v_count integer;
  v_last timestamptz;
begin
  perform private.assert_org_member(p_org);
  if v_filter not in ('all', 'in_progress', 'open', 'overdue', 'to_check', 'settled') then
    v_filter := 'all';
  end if;
  if p_month is not null and p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'p_month invalide : AAAA-MM attendu' using errcode = '22023';
  end if;

  with page as (
    select e, r, x
      from public.ride_network_executions e
      join public.rides r on r.id = e.ride_id
      left join public.ride_settlements x on x.network_execution_id = e.id and x.network_driver_org_id is not null
     where e.executor_org_id = p_org
       and (p_partner is null or e.organization_id = p_partner)
       and (p_month is null or private.network_month(e) = p_month)
       and (p_before is null or e.accepted_at < p_before)
       and case v_filter
             when 'in_progress' then e.ended_at is null
             when 'open' then x.status in ('due', 'declared', 'disputed')
             when 'overdue' then x.status = 'due' and x.due_at <= now()
             when 'to_check' then e.end_reason = 'completed' and e.validated_at is null and e.contested_at is null
                                  and cardinality(e.suspect_reasons) > 0
             when 'settled' then x.status in ('paid', 'waived')
             else true
           end
     order by e.accepted_at desc, e.id desc
     limit v_limit
  )
  select coalesce(jsonb_agg(private.network_received_item(page.e, page.r, page.x)
                            order by (page.e).accepted_at desc, (page.e).id desc), '[]'::jsonb),
         count(*)::integer, min((page.e).accepted_at)
    into v_items, v_count, v_last
    from page;

  return jsonb_build_object('filter', v_filter, 'items', v_items,
                            'next_before', case when v_count = v_limit then v_last end);
end;
$$;

-- Activité des chauffeurs de p_org pour d'autres organisations (contrat OrgNetworkActivity, En direct et « Courses
-- reçues ») : en course partenaire maintenant (« En course partenaire ({A}) », phase et depuis quand, SANS position : Q5)
-- et créneaux pris par des courses partenaires planifiées acceptées (prise en charge, fin estimée : durée estimée ou
-- 45 min, + 45 min, comme private.driver_time_conflict). Jamais l'identifiant ni l'adresse de la course. Tout membre de
-- p_org (organisation active). Indépendante de l'interrupteur.
create or replace function public.org_network_activity(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_org_member(p_org);
  return (
    with held as (
      select e.accepted_at, r.status, r.pickup_at, r.estimated_duration_s, r.driver_en_route_at, r.driver_arrived_at,
             r.passenger_onboard_at, r.started_at, d.id as driver_id, d.number, d.first_name, d.last_name,
             g.id as giver_id, g.name as giver_name,
             (r.status in ('DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS')
              or coalesce(d.current_ride_id = r.id, false)) as on_ride
        from public.ride_network_executions e
        join public.rides r on r.id = e.ride_id and r.driver_id = e.executor_driver_id
        join public.drivers d on d.id = e.executor_driver_id
        join public.organizations g on g.id = e.organization_id
       where e.executor_org_id = p_org
         and e.ended_at is null
         and d.deleted_at is null
    )
    select jsonb_build_object(
      'on_ride', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'driver', jsonb_build_object('id', h.driver_id, 'number', h.number, 'first_name', h.first_name,
                                              'last_name', h.last_name),
                 'giver', jsonb_build_object('id', h.giver_id, 'name', h.giver_name),
                 'phase', h.status,
                 'since', coalesce(case h.status
                                     when 'IN_PROGRESS' then h.started_at
                                     when 'PASSENGER_ONBOARD' then h.passenger_onboard_at
                                     when 'DRIVER_ARRIVED' then h.driver_arrived_at
                                     when 'DRIVER_EN_ROUTE' then h.driver_en_route_at
                                   end, h.accepted_at))
               order by h.first_name, h.last_name, h.driver_id)
          from held h where h.on_ride), '[]'::jsonb),
      'scheduled', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'driver', jsonb_build_object('id', h.driver_id, 'number', h.number, 'first_name', h.first_name,
                                              'last_name', h.last_name),
                 'giver', jsonb_build_object('id', h.giver_id, 'name', h.giver_name),
                 'pickup_at', h.pickup_at,
                 'until', h.pickup_at + make_interval(secs => coalesce(h.estimated_duration_s, 2700))
                          + interval '45 minutes')
               order by h.pickup_at, h.driver_id)
          from held h where not h.on_ride), '[]'::jsonb)));
end;
$$;

-- Liste « Prêt » / « Manque : … » des chauffeurs de p_org (Réglages › Recevoir, contrat OrgNetworkDriver) : fiches
-- actives, inactives ou suspendues, ni candidates, ni bannies, ni supprimées ; réglages réseau, n° d'exploitant VTC et
-- lisibilité complète (private.network_driver_readiness). Owner / admin, organisation active, réseau ouvert.
create or replace function public.org_network_drivers(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_org_member(p_org, array['owner', 'admin']::public.org_role[]);
  perform private.assert_network_open();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'driver', jsonb_build_object('id', d.id, 'number', d.number, 'first_name', d.first_name,
                                          'last_name', d.last_name, 'status', d.status),
             'settings', case when n.driver_id is null then null else jsonb_build_object(
               'enabled', n.enabled, 'org_allowed', n.org_allowed, 'accepted_version', n.accepted_version,
               'capable_at', n.capable_at, 'excluded_until', n.excluded_until) end,
             'vtc_operator_registration', d.vtc_operator_registration,
             'readiness', private.network_driver_readiness(d.id))
           order by d.status <> 'active', d.first_name, d.last_name, d.number)
      from public.drivers d
      left join public.driver_network_settings n on n.driver_id = d.id
     where d.organization_id = p_org
       and d.deleted_at is null
       and d.banned_at is null
       and d.status in ('active', 'inactive', 'suspended')
       and (d.application_status is null or d.application_status = 'approved')), '[]'::jsonb);
end;
$$;

-- Interrupteur « Autorisé » d'un chauffeur de l'organisation (§6.1) : owner / admin de SON organisation (organisation
-- active), réseau ouvert ; fiche supprimée : DRIVER_DELETED. Retrait : ses offres partenaires en attente fermées ; ses
-- courses partenaires acceptées pas encore commencées sont rendues à leur organisation par private.network_watch
-- (« driver_withdrawn », lot 3b). Audit « network.settings » chez B.
create or replace function public.set_driver_network_allowed(p_driver uuid, p_allowed boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  n public.driver_network_settings;
  v_closed integer := 0;
begin
  select * into d from public.drivers x where x.id = p_driver;
  if not found then
    raise exception 'DRIVER_NOT_FOUND: chauffeur introuvable' using errcode = 'P0002';
  end if;
  perform private.assert_org_member(d.organization_id, array['owner', 'admin']::public.org_role[]);
  perform private.assert_network_open();
  if d.deleted_at is not null then
    raise exception 'DRIVER_DELETED: ce chauffeur a supprimé son compte (fiche anonyme, non modifiable)'
      using errcode = '42501';
  end if;
  if p_allowed is null then
    raise exception 'p_allowed obligatoire' using errcode = '22023';
  end if;

  select * into n from public.driver_network_settings x where x.driver_id = d.id for update;
  -- Sans réglage, le chauffeur est autorisé (défaut) : seul un vrai changement est écrit et journalisé
  if coalesce(n.org_allowed, true) is distinct from p_allowed then
    insert into public.driver_network_settings (driver_id, organization_id, org_allowed, org_updated_at, org_updated_by)
    values (d.id, d.organization_id, p_allowed, now(), auth.uid())
    on conflict (driver_id) do update
      set org_allowed = excluded.org_allowed, org_updated_at = excluded.org_updated_at,
          org_updated_by = excluded.org_updated_by;
    if not p_allowed then
      v_closed := private.close_network_offers(null, null, d.id, 'network_unavailable');
    end if;
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity,
                                   metadata)
    values (d.organization_id, 'user', auth.uid(), 'network.settings', 'drivers', d.id::text, 'info',
            jsonb_build_object('org_allowed', p_allowed, 'closed_offers', v_closed));
  end if;
  return jsonb_build_object('ok', true, 'driver_id', d.id, 'allowed', p_allowed, 'closed_offers', v_closed);
end;
$$;

-- -----------------------------------------------------------------------------------------------------------------
-- 4b. Statistiques (§11.4) : chiffres de l'organisation seulement, offres réseau hors des taux, courses partenaires en
--     nombre (jamais les montants de l'organisation qui les confie)
-- -----------------------------------------------------------------------------------------------------------------

-- Dernière définition : 20260924002050_offer_missed_analytics.sql. Réseau partagé (§11.4), ajouts seulement : offres
-- réseau (is_network : chauffeurs partenaires sollicités pour ses courses) exclues des taux de ses chauffeurs ; clé
-- « network_rides » (courses faites par ses chauffeurs pour d'autres organisations, nombre seulement) s'il y en a.
-- Sans réseau : réponse identique.
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
  -- Réseau partagé
  v_network_rides integer;
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
  where organization_id = p_org and sent_at >= p_from and sent_at < p_to
    and closed_reason is distinct from 'removed_by_dispatch'
    -- Réseau partagé : offres aux chauffeurs partenaires exclues des taux de ses chauffeurs
    and not is_network;

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
          and closed_reason is distinct from 'removed_by_dispatch'
          -- Réseau partagé : offres aux chauffeurs partenaires exclues
          and not is_network
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

  -- Réseau partagé : courses faites par ses chauffeurs pour d'autres organisations (nombre seulement, jamais les
  -- montants de l'organisation qui les confie) — clé présente seulement s'il y en a
  select count(*)::integer into v_network_rides
    from public.ride_network_executions e
    join public.rides r on r.id = e.ride_id
   where e.executor_org_id = p_org and e.end_reason = 'completed' and r.pickup_at >= p_from and r.pickup_at < p_to;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'timezone', v_tz, 'advanced', v_advanced,
    'summary', v_summary, 'offers', v_offers, 'daily', v_daily,
    'by_hour', v_by_hour, 'by_weekday', v_by_weekday, 'per_driver', v_per_driver,
    'by_source', v_by_source, 'by_category', v_by_category
  ) || case when v_network_rides > 0 then jsonb_build_object('network_rides', v_network_rides) else '{}'::jsonb end;
end;
$$;

-- Dernière définition : 20260924002050_offer_missed_analytics.sql. Réseau partagé (§11.4), ajouts seulement : chiffres
-- de SON organisation (une course partenaire est une course d'une autre organisation : ni son prix ni son statut dans
-- les compteurs), offres réseau exclues de ses taux, clé « network_rides » (courses partenaires terminées, nombre
-- seulement) s'il y en a. Sans réseau : réponse identique.
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
  -- Réseau partagé
  v_network_rides integer;
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
    'completed_all_time', (select count(*) from public.rides x where x.driver_id = p_driver and x.status = 'COMPLETED'
                             and x.organization_id = v_org)
  ) into v_rides
  from public.rides
  where driver_id = p_driver and pickup_at >= v_from
    -- Réseau partagé : courses de son organisation seulement (jamais les montants d'une autre)
    and organization_id = v_org;

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
  where driver_id = p_driver and sent_at >= v_from
    and closed_reason is distinct from 'removed_by_dispatch'
    -- Réseau partagé : offres d'autres organisations exclues de ses taux
    and not is_network;

  -- Réseau partagé : courses partenaires terminées sur la période (nombre seulement) — clé présente seulement s'il y en a
  select count(*)::integer into v_network_rides
    from public.ride_network_executions e
    join public.rides r on r.id = e.ride_id
   where e.executor_driver_id = p_driver and e.end_reason = 'completed' and r.pickup_at >= v_from;

  return jsonb_build_object('days', p_days, 'rides', v_rides, 'offers', v_offers)
    || case when v_network_rides > 0 then jsonb_build_object('network_rides', v_network_rides) else '{}'::jsonb end;
end;
$$;

-- =============================================================================
-- 5. Index (bande d'indicateurs lue à chaque page du tableau de bord, réseau ouvert)
-- =============================================================================
create index if not exists ride_network_executions_giver_open_idx on public.ride_network_executions (organization_id)
  where ended_at is null;
create index if not exists ride_network_executions_exec_open_idx on public.ride_network_executions (executor_org_id)
  where ended_at is null;
create index if not exists ride_network_executions_to_check_idx on public.ride_network_executions (organization_id)
  where end_reason = 'completed' and validated_at is null and contested_at is null;
create index if not exists ride_settlements_network_open_org_idx on public.ride_settlements (organization_id)
  where network_driver_org_id is not null and status in ('due', 'declared', 'disputed');
create index if not exists ride_settlements_network_open_exec_idx on public.ride_settlements (network_driver_org_id)
  where network_driver_org_id is not null and status in ('due', 'declared', 'disputed');

-- =============================================================================
-- 6. Droits de la partie 5a : aides réservées aux fonctions serveur ; RPC ouvertes à authenticated (contrôle d'accès
--    DANS la fonction : private.current_driver_id(), assert_org_member / assert_network_reader /
--    assert_network_creditor), jamais à anon
-- =============================================================================
revoke all on function
  private.assert_network_open(),
  private.network_creditor_ok(uuid),
  private.assert_network_reader(uuid),
  private.driver_label_for(uuid, uuid),
  private.network_round_coord(double precision),
  private.network_phone_until(timestamptz, uuid),
  private.network_driver_excluded(uuid, uuid, uuid),
  private.network_execution_summary(public.ride_network_executions),
  private.org_network_readiness(uuid),
  private.driver_ride_json(public.rides, public.drivers, boolean),
  private.driver_network_state_json(uuid),
  private.network_given_item(public.ride_network_executions, public.rides, public.ride_settlements),
  private.network_driver_exclusion_json(private.network_driver_exclusions),
  private.network_received_item(public.ride_network_executions, public.rides, public.ride_settlements)
from public, anon, authenticated;
grant execute on function
  private.assert_network_open(),
  private.network_creditor_ok(uuid),
  private.assert_network_reader(uuid),
  private.driver_label_for(uuid, uuid),
  private.network_round_coord(double precision),
  private.network_phone_until(timestamptz, uuid),
  private.network_driver_excluded(uuid, uuid, uuid),
  private.network_execution_summary(public.ride_network_executions),
  private.org_network_readiness(uuid),
  private.driver_ride_json(public.rides, public.drivers, boolean),
  private.driver_network_state_json(uuid),
  private.network_given_item(public.ride_network_executions, public.rides, public.ride_settlements),
  private.network_driver_exclusion_json(private.network_driver_exclusions),
  private.network_received_item(public.ride_network_executions, public.rides, public.ride_settlements)
to service_role;

revoke all on function
  public.driver_offers_v2(),
  public.driver_ride(uuid),
  public.driver_rides_upcoming(),
  public.driver_network_state(),
  public.driver_network_ping(),
  public.driver_set_network(boolean, text),
  public.org_network_summary(uuid),
  public.org_network_given(uuid, text, uuid, text, integer, timestamptz),
  public.org_network_ride(uuid),
  public.network_partner_names(uuid),
  public.exclude_network_driver(uuid, text),
  public.org_network_driver_exclusions(uuid),
  public.lift_network_driver_exclusion(uuid, uuid),
  public.org_network_received(uuid, text, uuid, text, integer, timestamptz),
  public.org_network_activity(uuid),
  public.org_network_drivers(uuid),
  public.set_driver_network_allowed(uuid, boolean)
from public, anon;
grant execute on function
  public.driver_offers_v2(),
  public.driver_ride(uuid),
  public.driver_rides_upcoming(),
  public.driver_network_state(),
  public.driver_network_ping(),
  public.driver_set_network(boolean, text),
  public.org_network_summary(uuid),
  public.org_network_given(uuid, text, uuid, text, integer, timestamptz),
  public.org_network_ride(uuid),
  public.network_partner_names(uuid),
  public.exclude_network_driver(uuid, text),
  public.org_network_driver_exclusions(uuid),
  public.lift_network_driver_exclusion(uuid, uuid),
  public.org_network_received(uuid, text, uuid, text, integer, timestamptz),
  public.org_network_activity(uuid),
  public.org_network_drivers(uuid),
  public.set_driver_network_allowed(uuid, boolean)
to authenticated, service_role;

-- =============================================================================
-- Partie 5b (spécification §11.5 à §11.7, §13) : journaux, alertes, positions, temps réel, notifications, webhooks.
-- Toute ligne lisible par A (journal, historique des statuts, alertes, notifications, temps réel org:{A}) ne cite un
-- chauffeur de B que par son libellé court ; B ne reçoit rien de A pendant la course partenaire (ni identifiant de
-- course, ni adresse, ni position : « En course partenaire ({A}) », Q5) ; ses points GPS de la course sont invisibles
-- pour B puis supprimés 1 h après la fin. Fonctions existantes redéfinies à partir de leur dernière définition (citée),
-- ajouts commentés « Réseau partagé » : sans chauffeur d'une autre organisation, mêmes écritures et mêmes messages.
-- =============================================================================

-- =============================================================================
-- 7. Journaux et historique des statuts (§11.5, S3) — filet de sécurité de private.log_event et de
--    private.track_ride_status
-- =============================================================================

-- Acteur d'une ligne du journal ou de l'historique des statuts de la course p_ride de p_org : inchangé, sauf un
-- acteur d'une AUTRE organisation sur une course passée par le réseau (offre réseau, exécution, chauffeur d'une autre
-- organisation), jamais identifié chez p_org — chauffeur d'une autre organisation (partenaire) : « driver » sans
-- identifiant ; utilisateur qui n'est ni membre (toute adhésion), ni chauffeur de p_org, ni super admin, mais membre ou
-- chauffeur d'une autre organisation (membre de B, compte du partenaire appelé sans set_actor) : sans identifiant,
-- « driver » si c'est un compte de chauffeur, sinon « system ». Ligne sans course, acteur de p_org ou course jamais
-- passée par le réseau (interrupteur coupé) : rien ne change, sans lecture de plus pour un acteur de p_org.
create or replace function private.event_actor(p_org uuid, p_ride uuid, p_type public.actor_type, p_actor uuid,
                                               out actor_type public.actor_type, out actor_id uuid)
language plpgsql
stable
set search_path = ''
as $$
begin
  actor_type := p_type;
  actor_id := p_actor;
  if p_org is null or p_ride is null or p_actor is null or p_type is null or p_type not in ('driver', 'user') then
    return;
  end if;
  if p_type = 'driver' then
    if not exists (select 1 from public.drivers d where d.id = p_actor and d.organization_id <> p_org) then
      return;
    end if;
  elsif exists (select 1 from public.organization_users ou where ou.organization_id = p_org and ou.user_id = p_actor)
     or exists (select 1 from public.drivers d where d.user_id = p_actor and d.organization_id = p_org)
     or exists (select 1 from public.users u where u.id = p_actor and u.is_super_admin)
     or not (exists (select 1 from public.drivers d where d.user_id = p_actor)
             or exists (select 1 from public.organization_users ou where ou.user_id = p_actor)) then
    return;
  end if;
  -- Course jamais passée par le réseau : acteur inchangé (sans réseau, aucune de ces lignes n'existe)
  if not exists (select 1 from public.ride_offers o where o.ride_id = p_ride and o.is_network)
     and not exists (select 1 from public.ride_network_executions e where e.ride_id = p_ride)
     and not exists (select 1 from public.rides r where r.id = p_ride and r.driver_org_id <> r.organization_id) then
    return;
  end if;
  actor_id := null;
  if p_type = 'user' then
    actor_type := case when exists (select 1 from public.drivers d where d.user_id = p_actor)
                       then 'driver'::public.actor_type else 'system'::public.actor_type end;
  end if;
end;
$$;

-- Données et message d'une ligne du journal de p_org : pour chaque chauffeur d'une AUTRE organisation cité (clés
-- driver_id, previous_driver_id, assigned_driver_id, driver_ids) — clé retirée (driver_ids : ses identifiants retirés,
-- compteur network_count), driver_number, driver_name, lat, lng retirés ; dans le message, « Prénom NOM (#n) » ou
-- « Prénom (#n) » → libellé court (private.driver_label_for), nom de famille → initiale. Aucun chauffeur d'une autre
-- organisation cité (toute ligne hors réseau) : données et message inchangés, sans lecture de plus.
create or replace function private.network_event_scrub(p_org uuid, p_message text, p_data jsonb,
                                                       out message text, out data jsonb)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_key text;
  v_elem jsonb;
  v_keep jsonb := '[]'::jsonb;
  v_removed integer := 0;
  v_foreign uuid[] := '{}';
  v_label text;
  d record;
begin
  message := p_message;
  data := p_data;
  if p_org is null or jsonb_typeof(data) is distinct from 'object'
     or not (data ?| array['driver_id', 'previous_driver_id', 'assigned_driver_id', 'driver_ids']) then
    return;
  end if;
  foreach v_key in array array['driver_id', 'previous_driver_id', 'assigned_driver_id'] loop
    if jsonb_typeof(data -> v_key) = 'string' and (data ->> v_key) ~ v_uuid
       and exists (select 1 from public.drivers x where x.id = (data ->> v_key)::uuid and x.organization_id <> p_org) then
      v_foreign := v_foreign || (data ->> v_key)::uuid;
      data := data - v_key;
    end if;
  end loop;
  if jsonb_typeof(data -> 'driver_ids') = 'array' then
    for v_elem in select x.value from jsonb_array_elements(data -> 'driver_ids') x loop
      if jsonb_typeof(v_elem) = 'string' and (v_elem #>> '{}') ~ v_uuid
         and exists (select 1 from public.drivers x where x.id = (v_elem #>> '{}')::uuid and x.organization_id <> p_org) then
        v_foreign := v_foreign || (v_elem #>> '{}')::uuid;
        v_removed := v_removed + 1;
      else
        v_keep := v_keep || jsonb_build_array(v_elem);
      end if;
    end loop;
    if v_removed > 0 then
      data := jsonb_set(data, '{driver_ids}', v_keep)
        || jsonb_build_object('network_count', v_removed
             + case when jsonb_typeof(data -> 'network_count') = 'number' then (data ->> 'network_count')::numeric::integer else 0 end);
    end if;
  end if;
  if cardinality(v_foreign) = 0 then
    return;
  end if;
  data := data - array['driver_number', 'driver_name', 'lat', 'lng'];
  if message is not null then
    for d in select x.id, btrim(x.first_name) as first_name, btrim(x.last_name) as last_name, x.number
               from public.drivers x where x.id = any (v_foreign) loop
      v_label := coalesce(private.driver_label_for(d.id, p_org), 'Chauffeur partenaire');
      message := replace(message, format('%s %s (#%s)', d.first_name, d.last_name, d.number), v_label);
      message := replace(message, format('%s (#%s)', d.first_name, d.number), v_label);
      if char_length(d.last_name) >= 2 then
        message := regexp_replace(message,
          '\m' || regexp_replace(d.last_name, '([^[:alnum:][:space:]])', '\\\1', 'g') || '\M',
          left(d.last_name, 1) || '.', 'g');
      end if;
    end loop;
  end if;
end;
$$;

-- Dernière définition : 20260924000400_dispatch.sql. Devient plpgsql (§11.5) : filet de sécurité des journaux — un
-- chauffeur d'une autre organisation cité dans les données ou le message n'y apparaît qu'en libellé court
-- (private.network_event_scrub), un acteur d'une autre organisation sur une course passée par le réseau jamais par son
-- identifiant (private.event_actor). Sans chauffeur ni acteur d'une autre organisation : même ligne qu'avant.
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
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type public.actor_type := coalesce(p_actor_type, private.actor_type());
  v_actor uuid := case when p_actor_type = 'system' then null else coalesce(p_actor_id, private.actor_id()) end;
  v_message text := p_message;
  v_data jsonb := coalesce(p_data, '{}'::jsonb);
begin
  -- Réseau partagé (§11.5, S3) : filet de sécurité — chauffeur d'une autre organisation cité dans les données ou le
  -- message (private.network_event_scrub), acteur d'une autre organisation (private.event_actor) ; ligne hors
  -- réseau : valeurs inchangées
  select s.message, s.data into v_message, v_data from private.network_event_scrub(p_org, v_message, v_data) s;
  select a.actor_type, a.actor_id into v_type, v_actor from private.event_actor(p_org, p_ride, v_type, v_actor) a;
  insert into public.ride_events (organization_id, ride_id, category, level, type, message, actor_type, actor_id, data)
  values (p_org, p_ride, p_category, p_level, p_type, v_message, v_type, v_actor, v_data);
end;
$$;

-- Dernière définition : 20260924000400_dispatch.sql. Réseau partagé, seul ajout : acteur d'une autre organisation
-- (chauffeur partenaire à ses étapes, membre de B qui retire la course à son chauffeur) sur une course passée par le
-- réseau, sans identifiant (private.event_actor) — l'historique des statuts est lu par tout membre de A. Sinon inchangé.
create or replace function private.track_ride_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Réseau partagé
  v_type public.actor_type;
  v_actor uuid;
begin
  if tg_op = 'INSERT' and current_setting('rydar.bypass_ride_rules', true) = 'on' and auth.role() is null then
    return null;
  end if;
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    -- Réseau partagé (§11.5, S3) : acteur d'une autre organisation (chauffeur partenaire, membre de son organisation)
    -- jamais identifié dans l'historique de la course (private.event_actor) ; sinon inchangé
    select a.actor_type, a.actor_id into v_type, v_actor
      from private.event_actor(new.organization_id, new.id,
             case
               when tg_op = 'INSERT' and new.source = 'api' then 'api'::public.actor_type
               when tg_op = 'INSERT' and new.source = 'booking_site' then 'booking_site'::public.actor_type
               else private.actor_type()
             end,
             private.actor_id()) a;
    insert into public.ride_status_history (organization_id, ride_id, from_status, to_status, actor_type, actor_id)
    values (
      new.organization_id,
      new.id,
      case when tg_op = 'UPDATE' then old.status end,
      new.status,
      v_type,
      v_actor
    );
  end if;
  return null;
end;
$$;

-- =============================================================================
-- 8. Alertes de suivi (§11.5) : chauffeur partenaire en libellé court, ni identifiant, ni n° interne, ni position
-- =============================================================================

-- Dernière définition : 20260924002200_ride_alerts.sql. Réseau partagé, seul ajout : chauffeur d'une autre organisation
-- (alerte d'une course confiée, y compris « retard » dès l'acceptation) → données sans driver_id, driver_number, lat,
-- lng, distance au départ arrondie à 100 m, driver_name = libellé court, « network »: true (contrat RideAlertData).
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
  -- Réseau partagé
  v_partner boolean := p_driver.id is not null and p_driver.organization_id is distinct from p_ride.organization_id;
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
  -- Réseau partagé (§11.5, S3) : chauffeur d'une autre organisation → libellé court (« Prénom I. · B »), ni son
  -- identifiant, ni son n° interne, ni sa position ; distance au départ arrondie à 100 m (« network »: true)
  if v_partner then
    v_data := (v_data - array['driver_id', 'driver_number', 'lat', 'lng'])
      || jsonb_build_object('driver_name', coalesce(private.driver_label_for(p_driver.id, p_ride.organization_id),
                                                    p_driver.first_name), 'network', true)
      || case when jsonb_typeof(v_data -> 'distance_m') = 'number'
              then jsonb_build_object('distance_m', round((v_data ->> 'distance_m')::numeric, -2)::integer)
              else '{}'::jsonb end;
  end if;

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

-- Dernière définition : 20260924002200_ride_alerts.sql. Réseau partagé, seul ajout (S14, §14.1 n° 32) : alerte d'un
-- chauffeur d'une autre organisation diffusée sur org:{A} (et rendue par les RPC) sans son identifiant (driver_id NULL,
-- « network »: true) ; la ligne ride_alerts garde driver_id (clé « on delete set null », identifiant résiduel accepté).
create or replace function private.ride_alert_payload(a public.ride_alerts, p_op text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'op', p_op, 'id', a.id, 'ride_id', a.ride_id,
    -- Réseau partagé (S14) : chauffeur d'une autre organisation jamais identifié sur org:{A}
    'driver_id', case when a.driver_org_id is distinct from a.organization_id then null else a.driver_id end,
    'kind', a.kind,
    'severity', a.severity, 'message', a.message, 'data', a.data, 'status', a.status,
    'resolution', a.resolution, 'muted_until', a.muted_until, 'created_at', a.created_at,
    'updated_at', a.updated_at, 'resolved_at', a.resolved_at, 'resolved_by', a.resolved_by)
    || case when a.driver_id is not null and a.driver_org_id is distinct from a.organization_id
            then jsonb_build_object('network', true) else '{}'::jsonb end;
$$;

-- Dernière définition : 20260924006800_shared_network_dispatch.sql. Réseau partagé, seul ajout (§11.5) : chauffeur
-- d'une autre organisation cité dans les messages d'alerte par son libellé court (« Karim T. · Flotte B sera en
-- retard… ») ; chauffeur de l'organisation : prénom, comme avant.
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
  -- Réseau partagé
  v_network jsonb;
  v_who text;
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
    -- Réseau partagé (§11.5, S3) : chauffeur d'une autre organisation cité par son libellé court (« Prénom I. · B »)
    v_who := case when d.organization_id <> r.organization_id
                  then coalesce(private.driver_label_for(d.id, r.organization_id), d.first_name) else d.first_name end;
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
          v_message := format('%s sera en retard d''environ %s min', v_who, greatest(1, round(v_delay / 60.0))::integer);
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
      elsif r.pickup_at > now() + make_interval(secs => round(v_dist * 1.35 / 8.3)::integer)
                             + make_interval(mins => v_stall_min + v_tolerance) then
        -- Rien ne presse (prise en charge repoussée par un retard de vol, planifiée en avance) :
        -- s'arrêter n'est pas une anomalie
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
            v_message := format('%s est immobile depuis %s min, à %s du départ', v_who, v_still, v_dist_label);
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
          when not v_has_loc then format('Aucune position GPS reçue de %s', v_who)
          else format('Plus de position GPS de %s depuis %s min', v_who, greatest(1, v_age / 60))
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
        v_message := format('%s n''a pas démarré — prise en charge à %s, chauffeur %s', v_who,
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

  -- Réseau partagé : chien de garde des courses confiées à des chauffeurs partenaires (private.network_watch), dans
  -- un bloc protégé (une erreur n'arrête pas la surveillance) ; compteurs renvoyés seulement s'il a agi
  begin
    v_network := private.network_watch();
  exception when others then
    v_network := jsonb_build_object('error', true);
  end;

  return jsonb_build_object('ok', true, 'checked', v_checked, 'opened', v_opened, 'updated', v_updated,
    'resolved', v_resolved, 'skipped', v_skipped)
    || case when v_network ? 'error'
              or coalesce((v_network ->> 'released')::integer, 0) + coalesce((v_network ->> 'alerts')::integer, 0)
                 + coalesce((v_network ->> 'notified')::integer, 0) + coalesce((v_network ->> 'closed_offers')::integer, 0)
                 + coalesce((v_network ->> 'errors')::integer, 0) > 0
            then jsonb_build_object('network', v_network) else '{}'::jsonb end;
end;
$$;

-- =============================================================================
-- 9. Annulation (§11.5) : message au chauffeur partenaire sans adresse
-- =============================================================================

-- Dernière définition : 20260924006800_shared_network_dispatch.sql. Réseau partagé, seul ajout : course tenue par un
-- chauffeur partenaire → « COURSE ANNULÉE — {A} » sans n° ni adresse (data : network, giver), ses notifications
-- précédentes de la course retirées (offre, rappels, vol), comme un retrait (private.unassign_network_ride, lot 3).
-- Course propre : inchangée (« #n · départ → arrivée »).
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
  -- Réseau partagé
  v_giver text;
  v_tz text;
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
  -- Réseau partagé : client à bord d'un chauffeur partenaire — le chauffeur termine, sinon A clôture puis conteste
  if r.status in ('PASSENGER_ONBOARD', 'IN_PROGRESS') and r.driver_id is not null
     and r.driver_org_id <> r.organization_id and p_actor not in ('system', 'super_admin') then
    return jsonb_build_object('ok', false, 'code', 'NETWORK_RIDE_IN_PROGRESS',
      'message', 'Client à bord d''un chauffeur partenaire : annulation impossible. Il termine la course ; s''il ne le peut plus, clôturez-la (« Clôturer la course »), puis contestez-la si besoin.');
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
    if r.driver_org_id <> r.organization_id then
      -- Réseau partagé (§11.5, S7) : chauffeur partenaire prévenu sans adresse (« COURSE ANNULÉE — {A} ») ; ses
      -- notifications précédentes de la course (offre, rappels, vol : adresses) retirées de son historique
      select g.name, g.timezone into v_giver, v_tz from public.organizations g where g.id = r.organization_id;
      delete from public.notifications n where n.ride_id = r.id and n.driver_id = r.driver_id;
      perform private.queue_notification(r.organization_id, r.driver_id, r.id, null, 'ride_cancelled',
        'COURSE ANNULÉE — ' || coalesce(v_giver, 'organisation partenaire'),
        format('Course de %s du %s annulée : elle ne figure plus dans votre planning.',
          coalesce(v_giver, 'l''organisation partenaire'),
          to_char(r.pickup_at at time zone coalesce(v_tz, 'Europe/Paris'), 'DD/MM à HH24:MI')),
        jsonb_build_object('type', 'ride_cancelled', 'ride_id', r.id, 'network', true, 'giver', v_giver), 'high', null);
    else
      perform private.queue_notification(r.organization_id, r.driver_id, r.id, null, 'ride_cancelled', 'COURSE ANNULÉE',
        format('#%s · %s → %s', r.number, coalesce(private.short_address(r.pickup_address), r.pickup_address),
          coalesce(private.short_address(r.dropoff_address), r.dropoff_address)),
        jsonb_build_object('type', 'ride_cancelled', 'ride_id', r.id), 'high', null);
    end if;
  end if;

  perform private.log_event(r.organization_id, r.id, 'ride.cancelled',
    coalesce('Course annulée — ' || v_reason, 'Course annulée'),
    'timeline', 'warning', jsonb_build_object('reason', v_reason, 'closed_offers', cardinality(v_closed)), p_actor, p_actor_id);

  return jsonb_build_object('ok', true, 'code', 'CANCELLED', 'status', 'CANCELLED');
end;
$$;

-- =============================================================================
-- 10. Positions (§11.6, Q5, S8) : rien pour B pendant la course partenaire ; points marqués, puis supprimés
-- =============================================================================

-- Dernière définition : 20260924000400_dispatch.sql. Réseau partagé, seul ajout : point enregistré pendant une course
-- d'une autre organisation marqué ride_org_id (invisible pour l'organisation du chauffeur, supprimé 1 h après la fin).
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
  -- Réseau partagé
  v_ride_org uuid;
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
    -- Réseau partagé (§11.6, Q5, S8) : point d'une course d'une AUTRE organisation marqué (ride_org_id) — invisible
    -- pour l'organisation du chauffeur (policy driver_location_history_select), supprimé 1 h après la fin
    -- (private.housekeeping) ; course propre ou aucune course : NULL, comme avant
    if d.current_ride_id is not null then
      select r.organization_id into v_ride_org from public.rides r
       where r.id = d.current_ride_id and r.organization_id <> d.organization_id;
    end if;
    insert into public.driver_location_history (organization_id, driver_id, ride_id, lat, lng, speed_mps, heading, accuracy_m, recorded_at,
                                                ride_org_id)
    values (d.organization_id, d.id, d.current_ride_id, p_lat, p_lng, p_speed, p_heading, p_accuracy, v_recorded, v_ride_org);
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

-- Dernière définition : 20260924000600_realtime.sql. Réseau partagé, seul ajout (Q5) : aucune position diffusée pendant
-- une course d'une autre organisation (private.driver_on_foreign_ride, lot 2).
create or replace function private.broadcast_driver_location()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Réseau partagé (Q5, §11.6) : course d'une autre organisation en cours → aucune position diffusée à l'organisation
  -- du chauffeur (elle voit « En course partenaire ({A}) ») ; l'organisation de la course n'a pas de carte du
  -- partenaire en v1
  if private.driver_on_foreign_ride(new.driver_id) then
    return null;
  end if;
  perform realtime.send(
    jsonb_build_object('driver_id', new.driver_id, 'lat', new.lat, 'lng', new.lng, 'heading', new.heading,
      'speed', new.speed_mps, 'accuracy', new.accuracy_m, 'updated_at', new.updated_at),
    'driver.location', 'org:' || new.organization_id::text, true);
  return null;
end;
$$;

-- Dernière définition : 20260924000600_realtime.sql. Réseau partagé, seul ajout (Q5, contrat
-- NetworkDriverBroadcastFields) : sur org:{B}, course en cours d'une autre organisation → current_ride_id NULL,
-- « network »: true, « network_giver » : nom de A ; sinon charge utile inchangée.
create or replace function private.broadcast_driver()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Réseau partagé
  v_giver text;
begin
  -- Réseau partagé (Q5, §11.6) : course en cours d'une autre organisation → org:{B} ne reçoit ni son identifiant
  -- (current_ride_id NULL) ni rien d'autre de A que son nom (« En course partenaire ({A}) », network: true) ;
  -- driver:{id} inchangé (le chauffeur lui-même)
  if new.current_ride_id is not null then
    select g.name into v_giver
      from public.rides r
      join public.organizations g on g.id = r.organization_id
     where r.id = new.current_ride_id
       and r.organization_id <> new.organization_id
       and r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS');
  end if;
  perform realtime.send(
    jsonb_build_object('id', new.id, 'number', new.number, 'first_name', new.first_name, 'last_name', new.last_name,
      'presence', new.presence, 'status', new.status,
      'current_ride_id', case when v_giver is null then new.current_ride_id end, 'vehicle_id', new.vehicle_id)
    || case when v_giver is not null then jsonb_build_object('network', true, 'network_giver', v_giver)
            else '{}'::jsonb end,
    'driver.updated', 'org:' || new.organization_id::text, true);
  perform realtime.send(
    jsonb_build_object('id', new.id, 'presence', new.presence, 'status', new.status, 'current_ride_id', new.current_ride_id),
    'driver.updated', 'driver:' || new.id::text, true);
  return null;
end;
$$;

-- Exécutions closes (fin, retrait, annulation…) depuis plus d'1 h — et moins de 31 jours, au-delà les purges de 30 et 90
-- jours ont fait le reste — dont le chauffeur ne tient plus la course : (course, chauffeur) dont private.housekeeping
-- supprime les traces chez le chauffeur et son organisation (points GPS marqués, rappels, notifications de vol).
create or replace function private.network_ended_traces()
returns table (ride_id uuid, driver_id uuid)
language sql
stable
set search_path = ''
as $$
  select distinct e.ride_id, e.executor_driver_id
    from public.ride_network_executions e
   where e.ended_at < now() - interval '1 hour'
     and e.ended_at > now() - interval '31 days'
     and e.executor_driver_id is not null
     and not exists (
       select 1 from public.ride_network_executions x
        where x.ride_id = e.ride_id and x.executor_driver_id = e.executor_driver_id
          and (x.ended_at is null or x.ended_at >= now() - interval '1 hour'));
$$;

create index if not exists ride_network_executions_ended_idx on public.ride_network_executions (ended_at)
  where ended_at is not null;

-- Dernière définition : 20260924006900_shared_network_money.sql (corps 20260924006600 et ajout 006900 gardés À
-- L'IDENTIQUE). Réseau partagé, seuls ajouts : traces d'une course partenaire chez le chauffeur et son organisation
-- 1 h après la fin (points GPS marqués, rappels, notifications de vol), comptées dans history_purged et
-- notifications_purged (réponse inchangée).
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
  v_fleet integer;
  v_network integer;
  v_alert_positions integer;
  v_debtors integer;
  v_auth integer;
  v_expired integer;
  v_fee_changes integer;
  v_reductions integer;
  v_rides integer := 0;
  v_count integer;
  v_org uuid;
  v_rides_before timestamptz := date_trunc('year', now() - interval '10 years');
  v_bans jsonb;
  v_errors jsonb := '{}'::jsonb;
begin
  -- Le ménage ne met jamais un chauffeur hors ligne : application fermée, c'est private.watch_driver_gps qui s'en
  -- charge (20260924003400).

  -- Courses planifiées acceptées jamais démarrées, 6 h après l'heure de prise en charge : clôturées (005900). Un
  -- échec est journalisé par le worker et n'empêche pas le reste du ménage ; retenté au passage suivant.
  begin
    v_expired := private.expire_unstarted_rides();
  exception when others then
    v_expired := null;
    v_errors := v_errors || jsonb_build_object('rides_expired', left(sqlerrm, 300));
  end;

  delete from public.driver_location_history where recorded_at < now() - interval '30 days';
  get diagnostics v_history = row_count;
  -- Réseau partagé (Q5, §11.6, S8) : points GPS d'une course partenaire (ride_org_id, invisibles pour l'organisation du
  -- chauffeur) 1 h après la fin de son exécution pour ce chauffeur (private.network_ended_traces) ; comptés avec
  -- l'historique purgé (réponse inchangée)
  delete from public.driver_location_history h
   using private.network_ended_traces() n
   where h.ride_id = n.ride_id and h.driver_id = n.driver_id and h.ride_org_id is not null;
  get diagnostics v_count = row_count;
  v_history := v_history + v_count;
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
  -- Notifications : 90 jours après leur envoi prévu, quel que soit leur statut ; réveils silencieux : un jour
  delete from public.notifications
   where greatest(created_at, scheduled_for) < now() - interval '90 days'
      or (type = 'location_ping' and created_at < now() - interval '1 day');
  get diagnostics v_notifs = row_count;
  -- Réseau partagé : rappels et notifications de vol du chauffeur partenaire (adresse, n° de vol), même délai ; comptés
  -- avec les notifications purgées
  delete from public.notifications x
   using private.network_ended_traces() n
   where x.ride_id = n.ride_id and x.driver_id = n.driver_id and x.driver_org_id <> x.organization_id
     and x.type in ('ride_reminder', 'flight_update');
  get diagnostics v_count = row_count;
  v_notifs := v_notifs + v_count;
  delete from public.chat_messages where created_at < now() - interval '180 days';
  get diagnostics v_chat = row_count;
  -- Signalements de la flotte recopiés dans le journal de la centrale : même durée que les messages
  delete from public.ride_events
   where type in ('fleet.report', 'fleet.report_cleared') and created_at < now() - interval '180 days';
  get diagnostics v_fleet = row_count;
  -- Journal d'audit : adresse IP et navigateur effacés au bout d'un an (l'action reste tracée)
  update public.audit_logs set ip = null, user_agent = null
   where (ip is not null or user_agent is not null) and created_at < now() - interval '1 year';
  get diagnostics v_network = row_count;
  -- Position du chauffeur relevée par une alerte (immobile, GPS muet) : 30 jours. Alerte encore ouverte : sa
  -- position est celle du moment, retirée une fois l'alerte close.
  with batch as (
    select a.id from public.ride_alerts a
     where a.status <> 'open' and (a.data ? 'lat' or a.data ? 'lng') and a.created_at < now() - interval '30 days'
     order by a.created_at
     limit 500
  )
  update public.ride_alerts a
     set data = a.data - array['lat', 'lng']
    from batch b
   where a.id = b.id;
  get diagnostics v_alert_positions = row_count;
  update public.ride_events e
     set data = e.data - array['lat', 'lng']
   where e.type in ('alert.stalled', 'alert.no_gps') and (e.data ? 'lat' or e.data ? 'lng')
     and e.created_at < now() - interval '30 days';
  get diagnostics v_count = row_count;
  v_alert_positions := v_alert_positions + v_count;
  -- Empreintes d'un chauffeur supprimé qui devait des commissions : plus de dette ouverte, plus d'empreinte
  delete from private.debtor_identities x
   where not exists (
     select 1 from public.ride_settlements s
      where s.driver_id = x.driver_id and s.direction = 'driver_owes'
        and s.status in ('due', 'declared', 'disputed') and s.amount_cents > 0);
  get diagnostics v_debtors = row_count;
  -- Réseau partagé : empreintes d'un chauffeur partenaire supprimé, plus rien d'ouvert envers CETTE organisation
  -- créancière (comptées avec les précédentes : réponse inchangée)
  delete from private.network_debtor_identities n
   where not exists (
     select 1 from public.ride_settlements s
      where s.organization_id = n.creditor_org_id and s.network_driver_id = n.driver_id
        and s.network_driver_org_id is not null and s.direction = 'driver_owes'
        and s.status in ('due', 'declared', 'disputed') and s.amount_cents > 0);
  get diagnostics v_count = row_count;
  v_debtors := v_debtors + v_count;
  -- Courses : 10 ans après la fin de l'année de la prise en charge, quel que soit leur statut. Par centrale (index
  -- organization_id, pickup_at).
  -- Purges longues ou hors de nos tables (courses, bannissements, journal Auth) : un échec est journalisé par le
  -- worker et n'empêche pas le reste du ménage ; elles sont retentées au passage suivant.
  begin
    for v_org in select o.id from public.organizations o loop
      delete from public.rides r
       where r.organization_id = v_org and r.pickup_at < v_rides_before;
      get diagnostics v_count = row_count;
      v_rides := v_rides + v_count;
    end loop;
  exception when others then
    v_rides := 0;
    v_errors := v_errors || jsonb_build_object('rides', left(sqlerrm, 300));
  end;
  begin
    v_bans := private.purge_expired_bans();
  exception when others then
    v_errors := v_errors || jsonb_build_object('bans', left(sqlerrm, 300));
  end;
  -- Journal d'audit de Supabase Auth : 1 an ; une fois par heure au plus (parcours complet de la table)
  if not exists (select 1 from private.housekeeping_runs h
                  where h.task = 'auth_audit' and h.last_run_at > now() - interval '1 hour') then
    insert into private.housekeeping_runs (task, last_run_at) values ('auth_audit', now())
    on conflict (task) do update set last_run_at = excluded.last_run_at;
    begin
      v_auth := 0;
      if to_regclass('auth.audit_log_entries') is not null then
        delete from auth.audit_log_entries a where a.created_at < now() - interval '1 year';
        get diagnostics v_auth = row_count;
      end if;
    exception when others then
      v_auth := null;
      v_errors := v_errors || jsonb_build_object('auth_audit', left(sqlerrm, 300));
    end;
  end if;

  -- Frais Rydar (20260924006600) : baisses en attente depuis 30 jours sans décision du super admin acceptées (CGV
  -- art. 5)
  begin
    v_reductions := private.accept_stale_platform_reductions();
  exception when others then
    v_reductions := null;
    v_errors := v_errors || jsonb_build_object('platform_reductions', left(sqlerrm, 300));
  end;
  -- Hausses annoncées arrivées à leur date d'effet, EN DERNIER : le verrou de l'organisation (UPDATE des taux) est gardé
  -- jusqu'à la fin de la transaction, et la création d'une course de l'organisation l'attend
  begin
    v_fee_changes := private.apply_platform_fee_changes();
  exception when others then
    v_fee_changes := null;
    v_errors := v_errors || jsonb_build_object('platform_fee_changes', left(sqlerrm, 300));
  end;

  return jsonb_build_object('rides_expired', v_expired, 'platform_fee_changes_applied', v_fee_changes,
    'platform_reductions_accepted', v_reductions,
    'history_purged', v_history, 'api_logs_purged', v_logs,
    'documents_expired', v_docs, 'notifications_purged', v_notifs, 'chat_purged', v_chat,
    'fleet_events_purged', v_fleet, 'audit_network_purged', v_network, 'rides_purged', v_rides,
    'bans_purged', v_bans, 'alert_positions_purged', v_alert_positions, 'debtor_identities_purged', v_debtors,
    'auth_audit_purged', v_auth)
    || case when v_errors = '{}'::jsonb then '{}'::jsonb else jsonb_build_object('errors', v_errors) end;
end;
$$;

-- =============================================================================
-- 11. Temps réel (§13, S14) : org:{A} sans identifiant de partenaire ; jamais org:{B} pour une course de A
-- =============================================================================

-- Dernière définition : 20260924002100_flight_tracking.sql. Réseau partagé, seul ajout (contrat
-- NetworkRideBroadcastFields) : chauffeur d'une autre organisation → driver_id NULL, « network »: true,
-- « network_execution_id » sur org:{A} ; driver:{id} et ride.unassigned inchangés.
create or replace function private.broadcast_ride()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.rides;
  -- Réseau partagé
  v_partner boolean;
  v_execution uuid;
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
  -- Réseau partagé (§13, S14) : chauffeur d'une autre organisation → org:{A} ne reçoit jamais son identifiant
  -- (driver_id NULL), mais l'exécution en cours (network_execution_id, network: true) ; driver:{id} inchangé ;
  -- jamais org:{B}
  v_partner := v.driver_id is not null and v.driver_org_id is distinct from v.organization_id;
  if v_partner then
    select e.id into v_execution
      from public.ride_network_executions e
     where e.ride_id = v.id and e.executor_driver_id = v.driver_id
     order by e.ended_at is null desc, e.accepted_at desc
     limit 1;
  end if;

  perform realtime.send(
    jsonb_build_object(
      'op', lower(tg_op), 'id', v.id, 'number', v.number, 'status', v.status, 'type', v.type, 'source', v.source,
      'dispatch_mode', v.dispatch_mode,
      'pickup_address', v.pickup_address, 'pickup_lat', v.pickup_lat, 'pickup_lng', v.pickup_lng,
      'dropoff_address', v.dropoff_address, 'dropoff_lat', v.dropoff_lat, 'dropoff_lng', v.dropoff_lng,
      'pickup_at', v.pickup_at, 'customer_name', v.customer_name, 'passengers', v.passengers,
      'vehicle_category', v.vehicle_category, 'price_cents', v.price_cents,
      'driver_id', case when v_partner then null else v.driver_id end,
      'dispatch_wave', v.dispatch_wave, 'dispatch_radius_m', v.dispatch_radius_m, 'next_dispatch_at', v.next_dispatch_at,
      'estimated_distance_m', v.estimated_distance_m, 'estimated_duration_s', v.estimated_duration_s,
      'route_polyline', case when tg_op = 'INSERT' or new.route_polyline is distinct from old.route_polyline then v.route_polyline end,
      'created_at', v.created_at, 'updated_at', v.updated_at)
    || jsonb_build_object(
      'flight_number', v.flight_number, 'flight_mode', v.flight_mode, 'flight_status', v.flight_status,
      'flight_scheduled_arrival', v.flight_scheduled_arrival, 'flight_estimated_arrival', v.flight_estimated_arrival,
      'flight_actual_arrival', v.flight_actual_arrival, 'flight_delay_minutes', v.flight_delay_minutes,
      'flight_terminal', v.flight_terminal, 'flight_origin', v.flight_origin, 'flight_checked_at', v.flight_checked_at,
      'pickup_at_original', v.pickup_at_original)
    || case when v_partner then jsonb_build_object('network', true, 'network_execution_id', v_execution)
            else '{}'::jsonb end,
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

-- =============================================================================
-- 12. Notifications (§13)
-- =============================================================================

-- Montants internes jamais chez un chauffeur qui ne doit pas les voir (§13, U4 ; critère 5 : aucun montant de frais
-- Rydar chez un chauffeur de flotte) — point unique de TOUTE insertion (private.queue_notification, offres de
-- private.run_geo_wave / private.offer_to_fleet, rappels…), après private.set_driver_org_id (G1, ordre alphabétique) :
--  * chauffeur partenaire (organisation de la notification = A ≠ la sienne) : commission_cents, platform_fee_cents,
--    driver_payout_cents retirés des données ;
--  * chauffeur d'une flotte : ces montants retirés s'ils sont renseignés (en flotte, la course les porte NULL : rien ne
--    change aujourd'hui, filet de sécurité).
-- Centrale, son propre chauffeur (part affichée dans l'offre) : inchangé.
create or replace function private.notifications_scrub_money()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.driver_id is null or jsonb_typeof(new.data) is distinct from 'object'
     or not (new.data ?| array['commission_cents', 'platform_fee_cents', 'driver_payout_cents']) then
    return new;
  end if;
  if new.driver_org_id is distinct from new.organization_id then
    new.data := new.data - array['commission_cents', 'platform_fee_cents', 'driver_payout_cents'];
  elsif exists (select 1 from public.organizations o where o.id = new.organization_id and o.dispatch_model = 'fleet') then
    new.data := new.data - array(
      select k from unnest(array['commission_cents', 'platform_fee_cents', 'driver_payout_cents']) k
       where jsonb_typeof(new.data -> k) is distinct from 'null');
  end if;
  return new;
end;
$$;

create trigger notifications_scrub_money before insert on public.notifications
  for each row execute function private.notifications_scrub_money();

-- =============================================================================
-- 13. Webhooks et API (§11.7)
-- =============================================================================

-- Chauffeur d'une course pour l'API publique et les webhooks (objet « driver » de publicRide, @rydar/shared) :
--  * chauffeur de l'organisation de la course : prénom et véhicule de sa fiche — objet identique à l'ancien
--    embed PostgREST et à l'ancienne private.webhook_ride_json ;
--  * chauffeur partenaire (réseau partagé, §11.7) : prénom, véhicule de l'instantané figé à l'acceptation
--    (ride_network_executions.vehicle), exploitant « operator » { name : raison sociale validée de son organisation } ;
--    NULL 24 h après la fin de son exécution (jamais son nom, son téléphone ni son identifiant).
-- Colonne calculée PostgREST de rides (« driver:ride_public_driver » dans PUBLIC_RIDE_SELECT, apps/web/lib/api/v1.ts,
-- lue avec le client service role de l'API v1) et private.webhook_ride_json : même objet des deux côtés. EXECUTE :
-- service_role seulement (jamais un client : une ligne rides forgée en paramètre lirait n'importe quel chauffeur).
create or replace function public.ride_public_driver(r public.rides)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case
    when r.driver_id is null then null
    when r.driver_org_id <> r.organization_id then (
      select case when e.ended_at is null or e.ended_at > now() - interval '24 hours' then jsonb_build_object(
               'first_name', d.first_name,
               'vehicle', jsonb_build_object('brand', e.vehicle ->> 'brand', 'model', e.vehicle ->> 'model',
                                             'color', e.vehicle ->> 'color', 'plate', e.vehicle ->> 'plate'),
               'operator', jsonb_build_object(
                 'name', coalesce(nullif(btrim(e.operator ->> 'legal_name'), ''), e.operator ->> 'name'))) end
        from public.ride_network_executions e
        left join public.drivers d on d.id = e.executor_driver_id
       where e.ride_id = r.id and e.executor_driver_id = r.driver_id
       order by e.ended_at is null desc, e.accepted_at desc
       limit 1)
    else (
      select jsonb_build_object(
               'first_name', d.first_name,
               'vehicle', case when v.id is null then null else jsonb_build_object(
                 'brand', v.brand, 'model', v.model, 'color', v.color, 'plate', v.plate) end)
        from public.drivers d
        left join public.vehicles v on v.organization_id = d.organization_id and v.id = d.vehicle_id
       where d.organization_id = r.organization_id and d.id = r.driver_id)
  end;
$$;

-- Dernière définition : 20260924006000_webhooks.sql. Réseau partagé, seul changement : objet « driver » calculé par
-- public.ride_public_driver (identique pour un chauffeur de l'organisation ; partenaire : instantané, exploitant, NULL
-- 24 h après la fin). Une course partagée n'apparaît que dans les webhooks de A (déclencheur sur la course de A).
create or replace function private.webhook_ride_json(p_ride uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'number', r.number,
    'type', r.type,
    'status', r.status,
    'pickup_address', r.pickup_address,
    'pickup_lat', r.pickup_lat,
    'pickup_lng', r.pickup_lng,
    'dropoff_address', r.dropoff_address,
    'dropoff_lat', r.dropoff_lat,
    'dropoff_lng', r.dropoff_lng,
    'pickup_at', r.pickup_at,
    'passengers', r.passengers,
    'luggage', r.luggage,
    'vehicle_category', r.vehicle_category,
    'price_cents', r.price_cents,
    'currency', r.currency,
    'payment_method', r.payment_method,
    'flight_number', r.flight_number,
    'external_reference', r.external_reference,
    'estimated_distance_m', r.estimated_distance_m,
    'estimated_duration_s', r.estimated_duration_s,
    'route_polyline', r.route_polyline,
    'created_at', r.created_at,
    'accepted_at', r.accepted_at,
    'driver_arrived_at', r.driver_arrived_at,
    'started_at', r.started_at,
    'completed_at', r.completed_at,
    'cancelled_at', r.cancelled_at,
    'updated_at', r.updated_at,
    -- Réseau partagé (§11.7) : même objet que l'API v1 (public.ride_public_driver) — chauffeur de l'organisation :
    -- prénom et véhicule de sa fiche, comme avant ; chauffeur partenaire : instantané et exploitant
    'driver', public.ride_public_driver(r)
  )
  from public.rides r
  where r.id = p_ride;
$$;

-- =============================================================================
-- 14. Droits de la partie 5b : aides et déclencheur réservés aux fonctions serveur ; public.ride_public_driver au
--     service role seulement (colonne calculée de l'API v1). Fonctions redéfinies : droits conservés (même signature).
-- =============================================================================
revoke all on function
  private.event_actor(uuid, uuid, public.actor_type, uuid),
  private.network_event_scrub(uuid, text, jsonb),
  private.network_ended_traces()
from public, anon, authenticated;
grant execute on function
  private.event_actor(uuid, uuid, public.actor_type, uuid),
  private.network_event_scrub(uuid, text, jsonb),
  private.network_ended_traces()
to service_role;
revoke all on function private.notifications_scrub_money() from public, anon, authenticated, service_role;
revoke all on function public.ride_public_driver(public.rides) from public, anon, authenticated;
grant execute on function public.ride_public_driver(public.rides) to service_role;
