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
