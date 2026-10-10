-- =============================================================================
-- Rydar Drive — Flotte Privée (spécification : docs/FLOTTE-PRIVEE.md)
--
-- Pack vendu à un chauffeur VTC indépendant : son site (relié par l'API v1) lui envoie ses réservations, rien que pour
-- lui. Une Flotte Privée est une organisation FLOTTE ordinaire (dispatch_model = 'fleet') marquée
-- organizations.private_fleet : le propriétaire (owner) est aussi l'unique fiche chauffeur, sur le même compte. Les
-- interdictions du pack sont des invariants en base ; le web et l'application ne font que masquer et expliquer.
--
--  A. Schéma : organizations.private_fleet (+ contrainte : modèle flotte, lien d'inscription fermé ; lecture par
--     colonne), drivers.owner_driver (fiche du gérant, gardée après une bascule), index de l'agenda.
--  B. Aides privées : is_private_fleet, private_fleet_driver, private_fleet_blockers, profils de dispatch, échéance
--     annoncée tenue (private_fleet_hold).
--  C. Garde des organisations : drapeau écrit par les seules RPC du super admin (marqueur rydar.private_fleet_change),
--     modèle flotte et lien fermé imposés, passage refusé tant qu'une raison de private_fleet_blockers existe.
--  D. Gardes des fiches chauffeur et des accès : une seule fiche, celle du propriétaire (adhésion owner active) ; un
--     seul accès au tableau de bord. Drapeau lu sous le verrou de la ligne de l'organisation : une entrée en Flotte
--     Privée en cours (même verrou) est attendue puis relue.
--  E. Garde du réseau partagé : aucune adhésion, aucun partage, aucune demande (entrée en cours attendue : verrou
--     consultatif de l'organisation).
--  F. Limites (private.org_limits) : 1 chauffeur et 1 accès imposés APRÈS l'offre et la surcharge.
--  G. Démarrage d'une course (private.start_dispatch) : branche Flotte Privée → réservation « à confirmer » proposée au
--     seul chauffeur (private.offer_to_fleet, sans condition de présence, de position ni de distance), ou attribuée
--     d'office quand il la saisit lui-même au tableau de bord.
--  H. Déclencheurs : rappels « à confirmer » (H1), refus = « Refusée » (H2), « Non confirmée » (H3), « NOUVELLE
--     RÉSERVATION » pour toute offre faite, même recréée par le moteur (H4), échéance annoncée tenue (H5), réglages
--     « Réservations » changés pendant l'attente d'une réponse (H6).
--  I. RPC du super admin : création atomique, recréation de la fiche, bascule vers / depuis la Flotte Privée.
--  J. RPC du chauffeur : « La prendre » (driver_take_ride), agenda (driver_agenda).
--  K. Lectures de l'application : driver_home, driver_account_state (clés ajoutées seulement).
--  L. Droits.
--
-- Organisations standard (private_fleet = false, toutes les lignes existantes) : comportement identique ; chaque
-- branche est conditionnée par le drapeau. Moteur du dispatch (offer_to_fleet, run_geo_wave, dispatch_tick,
-- accept_ride_offer, decline_ride_offer, assign_ride) réutilisé tel quel, jamais recopié.
-- Supabase hébergé : rien sur auth.*, storage.*, realtime.messages (realtime.send seulement). Aucun enum modifié,
-- aucune table créée. Constantes partagées : packages/shared/src/private-fleet.ts (private-fleet-sql.test.ts).
-- =============================================================================

-- =============================================================================
-- A. Schéma
-- =============================================================================
alter table public.organizations
  add column private_fleet boolean not null default false;
comment on column public.organizations.private_fleet is
  'Pack Flotte Privée : un seul chauffeur (le propriétaire), ni lien d''inscription, ni réseau, ni centrale. Écrit par les RPC svc_platform_* seulement.';

alter table public.organizations
  add constraint organizations_private_fleet_check
    check (not private_fleet or (dispatch_model = 'fleet' and not join_enabled));

-- Lecture par colonne (20260924004300) : sans ce grant, select('*') et la sélection des adhésions du web échouent
grant select (private_fleet) on public.organizations to authenticated;

alter table public.drivers
  add column owner_driver boolean not null default false;
comment on column public.drivers.owner_driver is
  'Fiche du gérant d''une Flotte Privée (même compte que le propriétaire). Gardée après une bascule : aucun règlement en centrale (20260924007700), prix affiché au lieu de « votre part ».';

-- Agenda du chauffeur (driver_agenda) : ses courses par heure de prise en charge
create index rides_driver_pickup_idx on public.rides (driver_id, pickup_at) where driver_id is not null;

-- =============================================================================
-- B. Aides privées
-- =============================================================================
create or replace function private.is_private_fleet(p_org uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select o.private_fleet from public.organizations o where o.id = p_org), false);
$$;

-- Fiche active de la Flotte Privée (celle du gérant d'abord) ; ligne vide (id NULL) si aucune
create or replace function private.private_fleet_driver(p_org uuid)
returns public.drivers
language sql
stable
set search_path = ''
as $$
  select d.*
    from public.drivers d
   where d.organization_id = p_org
     and d.status = 'active'
     and d.deleted_at is null
     and d.user_id is not null
   order by d.owner_driver desc, d.created_at, d.id
   limit 1;
$$;

-- Raisons qui empêchent le passage en Flotte Privée (PRIVATE_FLEET_BLOCKERS de @rydar/shared, dans cet ordre) :
-- model (pas flotte) ; members (autre chose qu'un seul membre, propriétaire actif) ; drivers (plus d'une fiche non
-- supprimée, candidatures comprises) ; owner_driver (aucune fiche active du propriétaire, même compte) ; applications
-- (candidature en attente) ; network (partage, demande d'adhésion en attente, course partagée ou exécutée en cours).
-- Organisation introuvable : NULL.
create or replace function private.private_fleet_blockers(p_org uuid)
returns text[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_remove(array[
    case when o.dispatch_model is distinct from 'fleet' then 'model' end,
    case when (select count(*) from public.organization_users u
                where u.organization_id = o.id and u.status <> 'disabled') <> 1
           or not exists (select 1 from public.organization_users u
                           where u.organization_id = o.id and u.status = 'active' and u.role = 'owner')
         then 'members' end,
    case when (select count(*) from public.drivers d where d.organization_id = o.id and d.deleted_at is null) > 1
         then 'drivers' end,
    case when not exists (select 1
                            from public.drivers d
                            join public.organization_users u
                              on u.organization_id = d.organization_id and u.user_id = d.user_id
                           where d.organization_id = o.id and d.deleted_at is null and d.status = 'active'
                             and u.status = 'active' and u.role = 'owner')
         then 'owner_driver' end,
    case when exists (select 1 from public.drivers d
                       where d.organization_id = o.id and d.deleted_at is null and d.application_status = 'pending')
         then 'applications' end,
    case when exists (select 1 from public.network_memberships m
                       where m.organization_id = o.id
                         and (m.share_out or m.share_in
                              or (m.requested_at is not null and m.approved_at is null and m.refused_reason is null)))
           or exists (select 1 from public.ride_network_shares x
                       where x.organization_id = o.id and x.status in ('open', 'accepted'))
           or exists (select 1 from public.ride_network_executions e
                       where e.executor_org_id = o.id and e.ended_at is null)
         then 'network' end
  ], null), '{}'::text[])
  from public.organizations o
  where o.id = p_org;
$$;

-- Profils de dispatch posés par les RPC (PRIVATE_FLEET_DISPATCH_PROFILE et STANDARD_DISPATCH_PROFILE de @rydar/shared) :
-- Flotte Privée = seule une course « maintenant » est immédiate, confirmation au plus tard 60 min avant, 5 min pour
-- répondre à une immédiate, un dernier appel GPS (100 km) sans relance ; standard = réglages par défaut d'une flotte.
create or replace function private.dispatch_profile(p_private boolean)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when p_private
    then '{"auto_dispatch": true, "instant_threshold_minutes": 0, "scheduled_dispatch_lead_minutes": 60, "offer_timeout_seconds": 300, "dispatch_radii_m": [100000], "dispatch_retry_radii_m": [], "allow_category_upgrade": true}'::jsonb
    else '{"auto_dispatch": true, "instant_threshold_minutes": 45, "scheduled_dispatch_lead_minutes": 60, "offer_timeout_seconds": 30, "dispatch_radii_m": [4000, 8000, 12000, 16000], "dispatch_retry_radii_m": [4000, 8000], "allow_category_upgrade": true}'::jsonb
  end;
$$;

create or replace function private.apply_dispatch_profile(p_org uuid, p_private boolean)
returns void
language sql
set search_path = ''
as $$
  update public.organization_settings s
     set auto_dispatch = (p.v ->> 'auto_dispatch')::boolean,
         instant_threshold_minutes = (p.v ->> 'instant_threshold_minutes')::integer,
         scheduled_dispatch_lead_minutes = (p.v ->> 'scheduled_dispatch_lead_minutes')::integer,
         offer_timeout_seconds = (p.v ->> 'offer_timeout_seconds')::integer,
         dispatch_radii_m = array(select x::integer
                                    from jsonb_array_elements_text(p.v -> 'dispatch_radii_m') with ordinality as t(x, i)
                                   order by t.i),
         dispatch_retry_radii_m = array(select x::integer
                                          from jsonb_array_elements_text(p.v -> 'dispatch_retry_radii_m') with ordinality as t(x, i)
                                         order by t.i),
         allow_category_upgrade = (p.v ->> 'allow_category_upgrade')::boolean
    from (select private.dispatch_profile(p_private) as v) p
   where s.organization_id = p_org;
$$;

-- Fiche du gérant et son véhicule (création, recréation) : saisie contrôlée avant toute écriture. Réponse
-- { ok: false, code: 'INVALID', field, message } (champ du formulaire privateFleetCreateSchema), NULL si complète.
create or replace function private.private_fleet_driver_input_error(p_driver jsonb, p_vehicle jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_first text := btrim(coalesce(p_driver ->> 'first_name', ''));
  v_last text := btrim(coalesce(p_driver ->> 'last_name', ''));
  v_phone text := btrim(coalesce(p_driver ->> 'phone', ''));
  v_model text := btrim(coalesce(p_vehicle ->> 'model', ''));
  v_plate text := btrim(coalesce(p_vehicle ->> 'plate', ''));
  v_category text := coalesce(p_vehicle ->> 'category', '');
  v_seats text := btrim(coalesce(p_vehicle ->> 'seats', ''));
  v_luggage text := btrim(coalesce(p_vehicle ->> 'luggage_capacity', ''));
  v_field text;
  v_message text;
begin
  if char_length(v_first) not between 1 and 80 then
    v_field := 'ownerFirstName';
    v_message := 'Prénom du chauffeur requis (80 caractères au plus).';
  elsif char_length(v_last) not between 1 and 80 then
    v_field := 'ownerLastName';
    v_message := 'Nom du chauffeur requis (80 caractères au plus).';
  elsif char_length(v_phone) not between 6 and 30 then
    v_field := 'ownerPhone';
    v_message := 'Téléphone du chauffeur invalide.';
  elsif char_length(v_model) not between 1 and 60 then
    v_field := 'vehicle.model';
    v_message := 'Modèle du véhicule requis.';
  elsif char_length(v_plate) not between 4 and 12 then
    v_field := 'vehicle.plate';
    v_message := 'Plaque du véhicule invalide.';
  elsif v_category not in ('standard', 'business', 'first', 'van', 'green') then
    v_field := 'vehicle.category';
    v_message := 'Catégorie du véhicule inconnue.';
  elsif v_seats !~ '^[0-9]{1,2}$' or v_seats::integer not between 1 and 20 then
    v_field := 'vehicle.seats';
    v_message := 'Places : entre 1 et 20.';
  elsif v_luggage <> '' and (v_luggage !~ '^[0-9]{1,2}$' or v_luggage::integer > 30) then
    v_field := 'vehicle.luggageCapacity';
    v_message := 'Bagages : entre 0 et 30.';
  else
    return null;
  end if;
  return jsonb_build_object('ok', false, 'code', 'INVALID', 'field', v_field, 'message', private.fr_typo(v_message));
end;
$$;

-- Véhicule puis fiche du gérant (owner_driver, « confirmé », active), même compte que le propriétaire. Plaque déjà
-- connue de l'organisation (fiche recréée après une suppression de compte) : ce véhicule est repris et mis à jour.
-- E-mail de la fiche : celui de la saisie, sinon celui du compte. Identités bannies : IDENTITY_BANNED (déclencheurs).
create or replace function private.private_fleet_insert_driver(p_org uuid, p_user uuid, p_actor uuid, p_driver jsonb, p_vehicle jsonb)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_vehicle uuid;
  v_driver uuid;
  v_email text;
begin
  select nullif(lower(btrim(u.email)), '') into v_email from public.users u where u.id = p_user;
  insert into public.vehicles (organization_id, brand, model, color, plate, category, seats, luggage_capacity)
  values (p_org, nullif(btrim(p_vehicle ->> 'brand'), ''), btrim(p_vehicle ->> 'model'),
          nullif(btrim(p_vehicle ->> 'color'), ''), upper(btrim(p_vehicle ->> 'plate')),
          (p_vehicle ->> 'category')::public.vehicle_category, btrim(p_vehicle ->> 'seats')::smallint,
          coalesce(nullif(btrim(p_vehicle ->> 'luggage_capacity'), '')::smallint, 3))
  on conflict (organization_id, plate) do update
     set brand = excluded.brand, model = excluded.model, color = excluded.color, category = excluded.category,
         seats = excluded.seats, luggage_capacity = excluded.luggage_capacity, is_active = true
  returning id into v_vehicle;

  insert into public.drivers (organization_id, user_id, first_name, last_name, phone, email, vtc_card_number, status,
                              presence, vehicle_id, trust_level, joined_via, owner_driver, created_by)
  values (p_org, p_user, btrim(p_driver ->> 'first_name'), btrim(p_driver ->> 'last_name'), btrim(p_driver ->> 'phone'),
          coalesce(nullif(lower(btrim(p_driver ->> 'email')), ''), v_email),
          nullif(btrim(p_driver ->> 'vtc_card_number'), ''), 'active', 'offline', v_vehicle, 'trusted', 'dashboard', true,
          p_actor)
  returning id into v_driver;
  return v_driver;
end;
$$;

-- Réservations de l'organisation sans chauffeur à traiter (prise en charge il y a moins de 6 h : « La prendre »
-- reste possible, PRIVATE_FLEET_TAKE_MAX_AGE_HOURS), avec l'offre en attente du chauffeur et l'état
-- (PRIVATE_FLEET_BOOKING_STATES de @rydar/shared, même règle que privateFleetBookingState) : to_confirm (offre en
-- attente) | declined (dernière offre refusée) | not_confirmed (aucun chauffeur, ou fenêtre de réponse passée) |
-- to_check (en recherche sans aucune offre : véhicule incompatible).
create or replace function private.private_fleet_unassigned(p_org uuid, p_driver uuid, p_limit integer)
returns table (ride_id uuid, offer_id uuid, offer_expires_at timestamptz, state text)
language sql
stable
set search_path = ''
as $$
  select r.id, o.id, o.expires_at,
         case when o.id is not null then 'to_confirm'
              when l.status = 'declined' then 'declined'
              when r.status = 'NO_DRIVER_FOUND' or l.status is not null then 'not_confirmed'
              else 'to_check' end
    from public.rides r
    left join lateral (select x.id, x.expires_at
                         from public.ride_offers x
                        where x.ride_id = r.id and x.driver_id = p_driver and x.status = 'pending'
                        order by x.sent_at desc, x.id
                        limit 1) o on true
    left join lateral (select x.status
                         from public.ride_offers x
                        where x.ride_id = r.id and x.driver_id = p_driver
                        order by x.sent_at desc, x.id desc
                        limit 1) l on true
   where r.organization_id = p_org
     and r.driver_id is null
     and r.status in ('CREATED', 'SEARCHING_DRIVER', 'OFFERED', 'NO_DRIVER_FOUND')
     and r.pickup_at > now() - interval '6 hours'
   order by r.pickup_at, r.id
   limit greatest(coalesce(p_limit, 100), 1);
$$;

-- Échéance annoncée tenue (H5, H6, bascule I3). private.dispatch_tick ferme la fenêtre « flotte » d'une réservation à
-- la prise en charge − délai de confirmation, au passage fixé par private.offer_to_fleet (dans 5 min au plus), sans
-- lire l'échéance de l'offre en attente. Quand cette fenêtre se ferme AVANT l'échéance annoncée au chauffeur
-- (notification, rappels) — délai de réponse de plus de 5 min, délai de confirmation augmenté, bascule —, le prochain
-- passage est repoussé à l'échéance : il ferme alors l'offre et suit le chemin normal (dernier appel, puis « Non
-- confirmée »). Jamais avancé. Courses de p_org (p_ride : cette seule course) ; renvoie le nombre de passages repoussés.
create or replace function private.private_fleet_hold(p_org uuid, p_ride uuid default null)
returns integer
language sql
set search_path = ''
as $$
  with x as (
    select y.id as ride_id, max(o.expires_at) as deadline
      from public.rides y
      join public.ride_offers o on o.ride_id = y.id
     where y.organization_id = p_org
       and (p_ride is null or y.id = p_ride)
       and y.status in ('SEARCHING_DRIVER', 'OFFERED')
       and y.dispatch_mode = 'fleet'
       and y.driver_id is null
       and o.status = 'pending' and o.mode = 'fleet' and not o.is_network
     group by y.id
  ),
  held as (
    update public.rides r
       set next_dispatch_at = x.deadline
      from x, public.organization_settings s
     where r.id = x.ride_id
       and s.organization_id = r.organization_id
       and r.status in ('SEARCHING_DRIVER', 'OFFERED')
       and r.dispatch_mode = 'fleet'
       and r.driver_id is null
       and r.pickup_at - make_interval(mins => coalesce(s.scheduled_dispatch_lead_minutes, 60)) < x.deadline
       and (r.next_dispatch_at is null or r.next_dispatch_at < x.deadline)
    returning 1
  )
  select count(*)::integer from held;
$$;

-- =============================================================================
-- C. Garde des organisations
-- =============================================================================
-- Drapeau posé (création) ou changé sans le marqueur de la transaction (rydar.private_fleet_change = id, posé par les
-- RPC du super admin) : PRIVATE_FLEET_LOCKED. Flotte Privée : modèle flotte (PRIVATE_FLEET_MODEL : couvre
-- svc_platform_set_fees vers « centrale ») et lien fermé (PRIVATE_FLEET_RESTRICTED : couvre set_join_link(true)) imposés,
-- avant la contrainte ; passage false → true refusé tant qu'une raison de private_fleet_blockers existe.
create or replace function private.organizations_private_fleet_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_blockers text[];
begin
  if (tg_op = 'INSERT' and new.private_fleet)
     or (tg_op = 'UPDATE' and new.private_fleet is distinct from old.private_fleet) then
    if coalesce(current_setting('rydar.private_fleet_change', true), '') is distinct from new.id::text then
      raise exception 'PRIVATE_FLEET_LOCKED: drapeau Flotte Privée modifiable par les seules RPC du super admin'
        using errcode = '42501';
    end if;
  end if;
  if new.private_fleet then
    if new.dispatch_model is distinct from 'fleet' then
      raise exception 'PRIVATE_FLEET_MODEL: Flotte Privée, modèle flotte imposé' using errcode = '55000';
    end if;
    if new.join_enabled then
      raise exception 'PRIVATE_FLEET_RESTRICTED: lien d''inscription des chauffeurs fermé en Flotte Privée'
        using errcode = '55000';
    end if;
    if tg_op = 'UPDATE' and not old.private_fleet then
      v_blockers := coalesce(private.private_fleet_blockers(new.id), '{}'::text[]);
      if cardinality(v_blockers) > 0 then
        raise exception 'PRIVATE_FLEET_NOT_ELIGIBLE: %', array_to_string(v_blockers, ', ') using errcode = '55000';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger organizations_private_fleet_guard
  before insert or update of private_fleet, dispatch_model, join_enabled on public.organizations
  for each row execute function private.organizations_private_fleet_guard();

-- =============================================================================
-- D. Gardes des fiches chauffeur et des accès
-- =============================================================================
-- Préfixe « aa_ » : premier des déclencheurs BEFORE de drivers (ordre alphabétique), avant drivers_plan_limit et
-- drivers_identity_bans, pour un message clair. Fiche détachée de son compte (user_id NULL : suppression de compte, clé
-- étrangère) : toujours permise, sans verrou. Sinon le drapeau est lu sous le verrou de la ligne de l'organisation
-- (FOR NO KEY UPDATE, celui que drivers_assign_number prend de toute façon ; jamais FOR SHARE : la montée vers ce verrou
-- interbloquerait deux insertions) : une bascule en cours (svc_platform_set_private_fleet, même verrou) est attendue
-- puis relue, deux insertions d'une même organisation sont sérialisées. Flotte Privée : toute nouvelle fiche alors
-- qu'une autre n'est pas supprimée (candidatures comprises) → PRIVATE_FLEET_SINGLE_DRIVER ; compte autre que celui
-- d'une adhésion owner ACTIVE → PRIVATE_FLEET_DRIVER_OWNER. Couvre createDriver (service role), svc_driver_apply (lien
-- fermé de toute façon) et toute insertion directe (aucune insertion ni user_id ouverts au client).
create or replace function private.drivers_private_fleet_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_private boolean;
begin
  if tg_op = 'UPDATE' and new.user_id is null then
    return new;
  end if;
  select o.private_fleet into v_private
    from public.organizations o
   where o.id = new.organization_id
     for no key update;
  if not coalesce(v_private, false) then
    return new;
  end if;
  if tg_op = 'INSERT' and exists (select 1 from public.drivers x
                                   where x.organization_id = new.organization_id and x.deleted_at is null
                                     and x.id <> new.id) then
    raise exception 'PRIVATE_FLEET_SINGLE_DRIVER: une seule fiche chauffeur en Flotte Privée' using errcode = '55000';
  end if;
  if new.user_id is null then
    return new;
  end if;
  if not exists (select 1 from public.organization_users u
                  where u.organization_id = new.organization_id and u.user_id = new.user_id
                    and u.role = 'owner' and u.status = 'active') then
    raise exception 'PRIVATE_FLEET_DRIVER_OWNER: la fiche chauffeur doit être celle du propriétaire du compte'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger drivers_aa_private_fleet_guard
  before insert or update of user_id on public.drivers
  for each row execute function private.drivers_private_fleet_guard();

-- Un seul accès au tableau de bord (G2) : en Flotte Privée, une adhésion non désactivée alors qu'une autre existe →
-- PRIVATE_FLEET_RESTRICTED. Dernier rempart en plus de org_limits (max_admins 1), qu'enforce_plan_limits n'applique
-- qu'à l'insertion et au départ de « disabled », sans verrou. Nouvel accès (insertion, réactivation) : drapeau lu sous le
-- verrou de la ligne de l'organisation (une bascule en cours est attendue puis relue) ; invitation acceptée (invited →
-- active : aucun accès de plus) : simple lecture. Nommé après organization_users_plan_limit : PLAN_LIMIT_ADMINS reste
-- le message d'une Flotte Privée déjà en place.
create or replace function private.organization_users_private_fleet_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_private boolean;
begin
  if new.status = 'disabled' or (tg_op = 'UPDATE' and new.status is not distinct from old.status) then
    return new;
  end if;
  if tg_op = 'INSERT' or old.status = 'disabled' then
    select o.private_fleet into v_private
      from public.organizations o
     where o.id = new.organization_id
       for no key update;
  else
    v_private := private.is_private_fleet(new.organization_id);
  end if;
  if coalesce(v_private, false)
     and exists (select 1 from public.organization_users u
                  where u.organization_id = new.organization_id and u.id <> new.id and u.status <> 'disabled') then
    raise exception 'PRIVATE_FLEET_RESTRICTED: un seul accès au tableau de bord en Flotte Privée, celui du propriétaire'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger organization_users_private_fleet_guard
  before insert or update of status on public.organization_users
  for each row execute function private.organization_users_private_fleet_guard();

-- =============================================================================
-- E. Garde du réseau partagé
-- =============================================================================
-- Flotte Privée : aucune adhésion créée ; une adhésion existante (non partagée, sinon le passage est refusé) ne passe
-- jamais au partage, à une demande, à une validation ni à une convention acceptée. Seuls écrivains :
-- set_network_settings, svc_network_approve (refusés) ; svc_network_suspend sur une adhésion existante (permis). Les
-- trois commencent par « insert … on conflict (organization_id) do nothing », qui déclenche ce garde AVANT le conflit :
-- l'insertion n'est laissée passer que si l'adhésion existe déjà (aucune ligne créée, le conflit l'écarte). Écriture
-- refusable seulement : une entrée en Flotte Privée en cours est attendue (verrou consultatif de l'organisation,
-- exclusif dans svc_platform_set_private_fleet, partagé ici : les écritures du réseau ne s'attendent pas entre elles,
-- et aucun verrou de ligne de l'organisation n'est pris après celui de l'adhésion), puis le drapeau est relu.
create or replace function private.network_memberships_private_fleet_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_private boolean;
begin
  if not ((tg_op = 'INSERT'
           and not exists (select 1 from public.network_memberships m where m.organization_id = new.organization_id))
          or new.share_out or new.share_in
          or (new.requested_at is not null and new.requested_at is distinct from old.requested_at)
          or (new.approved_at is not null and new.approved_at is distinct from old.approved_at)
          or (new.terms_version is not null and new.terms_version is distinct from old.terms_version)) then
    return new;
  end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('rydar.private_fleet:' || new.organization_id::text, 0));
  select o.private_fleet into v_private from public.organizations o where o.id = new.organization_id;
  if coalesce(v_private, false) then
    raise exception 'PRIVATE_FLEET_RESTRICTED: réseau partagé non inclus dans la Flotte Privée' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger network_memberships_private_fleet_guard
  before insert or update on public.network_memberships
  for each row execute function private.network_memberships_private_fleet_guard();

-- =============================================================================
-- F. Limites
-- =============================================================================
-- Dernière définition : 20260924002800_plans_optional.sql. Flotte Privée seulement : 1 chauffeur et 1 accès imposés
-- APRÈS l'offre et la surcharge (ni une offre, ni limits_override, ni Stripe ne les lèvent ; PRIVATE_FLEET_LIMITS de
-- @rydar/shared). Autres organisations : identique. api_access n'est pas forcé (copie TypeScript de lib/api/v1.ts) :
-- une offre sans API est refusée à la création (PRIVATE_FLEET_PLAN_INVALID).
create or replace function private.org_limits(p_org uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select (case
           when o.plan_id is null
             then '{"api_access": true, "booking_site": true, "custom_domain": true, "advanced_stats": true}'::jsonb
           else coalesce(p.limits, '{}'::jsonb)
         end || coalesce(o.limits_override, '{}'::jsonb))
         || case when o.private_fleet then '{"max_drivers": 1, "max_admins": 1}'::jsonb else '{}'::jsonb end
  from public.organizations o
  left join public.plans p on p.id = o.plan_id
  where o.id = p_org;
$$;

-- =============================================================================
-- G. Démarrage d'une course
-- =============================================================================
-- Branche Flotte Privée (appelée par private.start_dispatch, sous le verrou de la course) :
--  1. journal « Réservation immédiate » / « Réservation du JJ/MM à HH:MM » ;
--  2. aucune fiche active (supprimée, suspendue, désactivée) : NO_DRIVER_FOUND tout de suite (le site est prévenu par
--     le webhook ride.no_driver_found) ;
--  3. saisie par le chauffeur lui-même au tableau de bord : attribuée d'office (public.assign_ride, même transaction :
--     la notification « attribuée » qui lui serait adressée est annulée) ;
--  4-5. sinon offre « à confirmer » au chauffeur (private.offer_to_fleet : ni présence, ni position, ni distance),
--     échéance = prise en charge − délai de confirmation, au moins maintenant + délai de réponse ; sa notification
--     devient « NOUVELLE RÉSERVATION » (H4 : kind private_new, sonnerie si la réponse est attendue dans 15 min au plus)
--     et l'échéance annoncée est tenue (H5) ;
--  6. véhicule incompatible (catégorie, places) : aucune offre, notification « RÉSERVATION À VÉRIFIER » (sans
--     ride_id dans les données : l'app 1.1.0 ouvrirait une course qui n'est pas la sienne) ; la course reste en
--     recherche jusqu'à l'échéance puis suit le chemin normal.
-- Tout se fait dans la transaction de la création : pg_notify n'est livré qu'au commit, le worker lit la ligne finale.
create or replace function private.private_fleet_dispatch(p_ride uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  r public.rides;
  d public.drivers;
  o public.ride_offers;
  v_tz text;
  v_res jsonb;
  v_count integer;
  v_ring boolean;
  v_route text;
begin
  select * into r from public.rides where id = p_ride;
  if not found then
    return;
  end if;
  select x.timezone into v_tz from public.organizations x where x.id = r.organization_id;
  v_tz := coalesce(v_tz, 'Europe/Paris');
  d := private.private_fleet_driver(r.organization_id);
  v_route := coalesce(private.short_address(r.pickup_address), r.pickup_address) || ' → '
    || coalesce(private.short_address(r.dropoff_address), r.dropoff_address);

  perform private.log_event(r.organization_id, r.id, 'ride.classified',
    case when r.type = 'instant' then 'Réservation immédiate'
         else format('Réservation du %s', to_char(r.pickup_at at time zone v_tz, 'DD/MM à HH24:MI')) end,
    'timeline', 'info', jsonb_build_object('type', r.type, 'pickup_at', r.pickup_at, 'private_fleet', true), 'system', null);

  -- 2. aucune fiche active
  if d.id is null then
    update public.rides
       set status = 'NO_DRIVER_FOUND', no_driver_at = now(), dispatch_mode = 'fleet', dispatch_started_at = now(),
           next_dispatch_at = null
     where id = r.id;
    perform private.log_event(r.organization_id, r.id, 'dispatch.private_no_driver',
      'Aucune fiche chauffeur active (supprimée, suspendue ou désactivée) — réservation non proposée',
      'timeline', 'error', jsonb_build_object('private_fleet', true), 'system', null);
    return;
  end if;

  -- 3. saisie par le chauffeur lui-même au tableau de bord : attribuée d'office
  if r.source = 'dashboard' and r.created_by = d.user_id then
    v_res := public.assign_ride(r.id, d.id);
    if coalesce((v_res ->> 'ok')::boolean, false) then
      update public.notifications
         set status = 'cancelled'
       where ride_id = r.id and driver_id = d.id and type = 'ride_assigned' and status = 'queued';
      perform private.log_event(r.organization_id, r.id, 'dispatch.private_self',
        'Réservation saisie par le chauffeur — confirmée d''office', 'timeline', 'success',
        jsonb_build_object('driver_id', d.id, 'private_fleet', true), 'system', null);
      return;
    end if;
    perform private.log_event(r.organization_id, r.id, 'dispatch.private_self',
      format('Confirmation d''office impossible (%s) — réservation proposée à confirmer', coalesce(v_res ->> 'code', '?')),
      'timeline', 'warning', jsonb_build_object('driver_id', d.id, 'code', v_res ->> 'code', 'private_fleet', true),
      'system', null);
  end if;

  -- 4. offre « à confirmer » au chauffeur
  update public.rides
     set status = 'SEARCHING_DRIVER', dispatch_mode = 'fleet', dispatch_started_at = now(), dispatch_wave = 0
   where id = r.id;
  v_count := private.offer_to_fleet(r.id);

  if v_count > 0 then
    -- 5. offre faite : sa notification initiale est déjà « NOUVELLE RÉSERVATION » (H4), qui sonne ou non
    select * into o from public.ride_offers x
     where x.ride_id = r.id and x.driver_id = d.id and x.status = 'pending' and x.mode = 'fleet'
     order by x.sent_at desc, x.id
     limit 1;
    v_ring := exists (select 1 from public.notifications n
                       where n.ride_id = r.id and n.offer_id = o.id and n.type = 'ride_offer');
    perform private.log_event(r.organization_id, r.id, 'dispatch.private_offer',
      format('Proposée — réponse attendue avant %s', private.fmt_local_time(o.expires_at, v_tz, now())),
      'timeline', 'info',
      jsonb_build_object('offer_id', o.id, 'driver_id', d.id, 'expires_at', o.expires_at, 'ring', v_ring, 'private_fleet', true),
      'system', null);
  else
    -- 6. véhicule incompatible : à vérifier
    perform private.queue_notification(r.organization_id, d.id, r.id, null, 'ride_unconfirmed', 'RÉSERVATION À VÉRIFIER',
      format('#%s · %s · %s', r.number, to_char(r.pickup_at at time zone v_tz, 'DD/MM HH24:MI'), v_route)
        || private.fr_typo(' : catégorie ou nombre de places au-delà de votre véhicule. Prenez-la quand même ou prévenez votre client.'),
      jsonb_build_object('type', 'ride_unconfirmed', 'reason', 'to_check', 'booking_id', r.id, 'number', r.number),
      'high', null);
    perform private.log_event(r.organization_id, r.id, 'dispatch.private_incompatible',
      'Véhicule du chauffeur incompatible (catégorie ou nombre de places) — réservation à vérifier',
      'timeline', 'warning',
      jsonb_build_object('driver_id', d.id, 'category', r.vehicle_category, 'passengers', r.passengers, 'private_fleet', true),
      'system', null);
  end if;
end;
$$;

-- Dernière définition : 20260924000400_dispatch.sql (définition unique). Seul ajout : Flotte Privée → branche
-- private.private_fleet_dispatch, AVANT le test auto_dispatch (la colonne reste modifiable par le client). Autres
-- organisations : corps identique au caractère près.
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
  v_private boolean;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found then
    return;
  end if;
  select * into s from public.organization_settings where organization_id = r.organization_id;
  select name, timezone, private_fleet into v_org_name, v_tz, v_private from public.organizations where id = r.organization_id;

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

  -- Flotte Privée (20260924007600) : réservation proposée à confirmer au seul chauffeur, quel que soit auto_dispatch
  if coalesce(v_private, false) then
    perform private.private_fleet_dispatch(r.id);
    return;
  end if;

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

-- =============================================================================
-- H. Déclencheurs de dispatch (aucune fonction du moteur recopiée)
-- =============================================================================

-- Rappels « à confirmer » d'une offre (PRIVATE_FLEET_REMINDER_RULES de @rydar/shared), calcul commun à H1 et H6.
-- Heures candidates : prise en charge − chaque délai des rappels de course de l'organisation, plus l'échéance − 30 min
-- (« dernier rappel ») ; gardées de maintenant + 20 min à l'échéance − 5 min, triées ; une heure à moins de 15 min de
-- la précédente retenue écartée ; 4 au plus. Les rappels en file de l'offre sont remplacés ; p_keep (rappels changés
-- dans les réglages, échéance inchangée) : un rappel en file encore prévu reste tel quel, même à moins de 20 min, et un
-- rappel déjà dû n'est pas touché. Offre qui n'est plus « à confirmer » (organisation sortie de la Flotte Privée, offre
-- close) : ses rappels en file sont annulés. Renvoie le nombre de rappels mis en file.
create or replace function private.private_fleet_plan_reminders(p_offer uuid, p_keep boolean)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  c_min_ahead constant interval := interval '20 minutes';
  c_last_call constant interval := interval '30 minutes';
  c_end_margin constant interval := interval '5 minutes';
  c_min_gap constant interval := interval '15 minutes';
  c_max constant integer := 4;
  f public.ride_offers;
  r public.rides;
  v_active boolean;
  v_offsets integer[];
  v_queued timestamptz[];
  v_plan timestamptz[] := '{}';
  v_tz text;
  v_at timestamptz;
  v_last_call timestamptz;
  v_when text;
  v_route text;
  v_data jsonb;
  v_count integer := 0;
begin
  select * into f from public.ride_offers x where x.id = p_offer;
  if not found then
    return 0;
  end if;
  select coalesce(array_agg(n.scheduled_for), '{}') into v_queued
    from public.notifications n
   where n.ride_id = f.ride_id and n.offer_id = f.id and n.status = 'queued' and n.data ->> 'kind' = 'private_reminder';
  v_active := f.status = 'pending' and f.mode = 'fleet' and not f.is_network and f.expires_at is not null
              and private.is_private_fleet(f.organization_id);

  if v_active then
    select * into r from public.rides x where x.id = f.ride_id;
    select s.reminder_offsets_minutes into v_offsets from public.organization_settings s where s.organization_id = f.organization_id;
    v_last_call := f.expires_at - c_last_call;
    for v_at in
      select distinct c.reminder_at
        from (select r.pickup_at - make_interval(mins => x) as reminder_at
                from unnest(coalesce(v_offsets, '{}'::integer[])) as x
              union all
              select v_last_call) c
       where c.reminder_at <= f.expires_at - c_end_margin
         and (c.reminder_at >= now() + c_min_ahead
              or (p_keep and c.reminder_at > now() and c.reminder_at = any (v_queued)))
       order by c.reminder_at
    loop
      continue when cardinality(v_plan) > 0 and v_at < v_plan[cardinality(v_plan)] + c_min_gap;
      exit when cardinality(v_plan) >= c_max;
      v_plan := v_plan || v_at;
    end loop;
  end if;

  update public.notifications n
     set status = 'cancelled'
   where n.ride_id = f.ride_id and n.offer_id = f.id and n.status = 'queued' and n.data ->> 'kind' = 'private_reminder'
     and not (v_active and p_keep and (n.scheduled_for = any (v_plan) or n.scheduled_for <= now()));
  if cardinality(v_plan) = 0 then
    return 0;
  end if;

  select o.timezone into v_tz from public.organizations o where o.id = f.organization_id;
  v_tz := coalesce(v_tz, 'Europe/Paris');
  v_when := to_char(r.pickup_at at time zone v_tz, 'DD/MM HH24:MI');
  v_route := coalesce(private.short_address(r.pickup_address), r.pickup_address) || ' → '
    || coalesce(private.short_address(r.dropoff_address), r.dropoff_address);
  v_data := jsonb_build_object('type', 'ride_offer_scheduled', 'kind', 'private_reminder', 'offer_id', f.id,
    'ride_id', r.id, 'ride_type', r.type, 'pickup', r.pickup_address, 'dropoff', r.dropoff_address,
    'pickup_at', r.pickup_at, 'price_cents', r.price_cents, 'passengers', r.passengers, 'expires_at', f.expires_at);
  foreach v_at in array v_plan loop
    continue when p_keep and v_at = any (v_queued);
    perform private.queue_notification(f.organization_id, f.driver_id, r.id, f.id, 'ride_offer_scheduled',
      'RÉSERVATION À CONFIRMER',
      case when v_at = v_last_call
           then private.fr_typo('Dernier rappel : répondez avant ') || private.fmt_local_time(f.expires_at, v_tz, v_at)
                || format(' · %s · %s', v_when, v_route)
           else format('Prise en charge dans %s · %s · %s · %s',
                  private.fmt_minutes(round(extract(epoch from (r.pickup_at - v_at)) / 60)::integer), v_when, v_route,
                  private.fmt_eur(r.price_cents))
      end,
      v_data, 'high', v_at);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- H1. Rappels « à confirmer » : à chaque offre « flotte » en attente créée ou dont l'échéance change (réglages, vol
-- retardé : private.apply_flight_status), les rappels en file de l'offre sont remplacés (calcul ci-dessus) — annulés
-- d'abord, même quand l'organisation n'est plus une Flotte Privée (sortie : aucun rappel à l'ancienne échéance).
-- Nettoyage sans code : private.claim_notifications annule les notifications d'une offre qui n'est plus en attente,
-- public.accept_ride_offer celles de la course.
create or replace function private.ride_offers_private_fleet_reminders()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.expires_at is not distinct from new.expires_at then
    return null;
  end if;
  -- Offre créée hors Flotte Privée : aucun rappel à poser ni à annuler
  if tg_op = 'INSERT' and not private.is_private_fleet(new.organization_id) then
    return null;
  end if;
  perform private.private_fleet_plan_reminders(new.id, false);
  return null;
end;
$$;

create trigger ride_offers_private_fleet_reminders
  after insert or update of expires_at on public.ride_offers
  for each row
  when (new.status = 'pending' and new.mode = 'fleet' and not new.is_network)
  execute function private.ride_offers_private_fleet_reminders();

-- H2. Refus = « Refusée » : offre propre refusée pendant qu'elle était EN ATTENTE (public.decline_ride_offer tient
-- déjà le verrou de la course) → réservation sans chauffeur tout de suite (NO_DRIVER_FOUND, webhook
-- ride.no_driver_found), si elle est encore en recherche et qu'aucune autre offre n'attend. Refus tardif d'une offre
-- déjà expirée : rien.
create or replace function private.ride_offers_private_fleet_declined()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if not private.is_private_fleet(new.organization_id) then
    return null;
  end if;
  update public.rides x
     set status = 'NO_DRIVER_FOUND', no_driver_at = now(), next_dispatch_at = null
   where x.id = new.ride_id
     and x.driver_id is null
     and x.status in ('SEARCHING_DRIVER', 'OFFERED')
     and not exists (select 1 from public.ride_offers o where o.ride_id = new.ride_id and o.status = 'pending');
  get diagnostics v_rows = row_count;
  if v_rows > 0 then
    perform private.log_event(new.organization_id, new.ride_id, 'dispatch.private_declined',
      'Réservation refusée par le chauffeur', 'timeline', 'warning',
      jsonb_build_object('offer_id', new.id, 'driver_id', new.driver_id, 'private_fleet', true), 'driver', new.driver_id);
  end if;
  return null;
end;
$$;

create trigger ride_offers_private_fleet_declined
  after update of status on public.ride_offers
  for each row
  when (new.status = 'declined' and old.status = 'pending' and not new.is_network)
  execute function private.ride_offers_private_fleet_declined();

-- H3. « Non confirmée » : réservation passée sans chauffeur (fin de la fenêtre de réponse et du dernier appel, véhicule
-- incompatible…) alors que le chauffeur ne l'a pas refusée → notification « RÉSERVATION NON CONFIRMÉE » (rattrapage :
-- « La prendre »). notifications.ride_id renseigné (cascade, nettoyage), JAMAIS data.ride_id (l'app 1.1.0 ouvrirait
-- /ride/[id], RIDE_NOT_FOUND pour une course non attribuée).
create or replace function private.rides_private_fleet_unconfirmed()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  d public.drivers;
  v_last public.offer_status;
  v_tz text;
begin
  if not private.is_private_fleet(new.organization_id) then
    return null;
  end if;
  d := private.private_fleet_driver(new.organization_id);
  if d.id is null then
    return null;
  end if;
  select o.status into v_last
    from public.ride_offers o
   where o.ride_id = new.id and o.driver_id = d.id
   order by o.sent_at desc, o.id desc
   limit 1;
  if v_last is not distinct from 'declined' then
    return null;
  end if;
  select x.timezone into v_tz from public.organizations x where x.id = new.organization_id;
  perform private.queue_notification(new.organization_id, d.id, new.id, null, 'ride_unconfirmed', 'RÉSERVATION NON CONFIRMÉE',
    format('#%s · %s · %s → %s', new.number, to_char(new.pickup_at at time zone coalesce(v_tz, 'Europe/Paris'), 'DD/MM HH24:MI'),
      coalesce(private.short_address(new.pickup_address), new.pickup_address),
      coalesce(private.short_address(new.dropoff_address), new.dropoff_address))
      || private.fr_typo(' : confirmez-la quand même ou prévenez votre client.'),
    jsonb_build_object('type', 'ride_unconfirmed', 'reason', 'not_confirmed', 'booking_id', new.id, 'number', new.number),
    'high', null);
  return null;
end;
$$;

create trigger rides_private_fleet_unconfirmed
  after update of status on public.rides
  for each row
  when (new.status = 'NO_DRIVER_FOUND' and old.status is distinct from 'NO_DRIVER_FOUND')
  execute function private.rides_private_fleet_unconfirmed();

-- H4. Notification initiale de toute offre « à confirmer » — réservation reçue, ou offre recréée par le moteur
-- (véhicule corrigé, vol retardé, relance) : la notification standard de private.offer_to_fleet (« NOUVELLE COURSE
-- PLANIFIÉE », insérée par la même instruction, déjà visible ici) devient « NOUVELLE RÉSERVATION » (kind private_new)
-- et sonne (ride_offer : canal des offres, plein écran possible) si la réponse est attendue dans 15 min au plus
-- (PRIVATE_FLEET_RING_WINDOW_S). pg_notify n'est livré qu'au commit : le worker lit la ligne finale.
create or replace function private.ride_offers_private_fleet_new()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  c_ring_window constant interval := interval '900 seconds';
  v_ring boolean;
begin
  if not private.is_private_fleet(new.organization_id) then
    return null;
  end if;
  v_ring := coalesce(new.expires_at <= now() + c_ring_window, false);
  update public.notifications n
     set title = 'NOUVELLE RÉSERVATION',
         type = case when v_ring then 'ride_offer' else n.type end,
         data = n.data || jsonb_build_object('kind', 'private_new', 'type', case when v_ring then 'ride_offer' else n.type end)
   where n.ride_id = new.ride_id and n.offer_id = new.id and n.status = 'queued' and not (n.data ? 'kind');
  return null;
end;
$$;

create trigger ride_offers_private_fleet_new
  after insert on public.ride_offers
  for each row
  when (new.status = 'pending' and new.mode = 'fleet' and not new.is_network)
  execute function private.ride_offers_private_fleet_new();

-- H5. Échéance annoncée tenue (private.private_fleet_hold) pour toute offre « à confirmer » créée ou dont l'échéance
-- change. Déclencheur DIFFÉRÉ (fin de transaction) : il passe après l'écriture de rides.next_dispatch_at qui suit
-- l'offre dans private.offer_to_fleet et private.apply_flight_status. Definer : un déclencheur différé s'exécute avec le
-- rôle actif au commit (authenticated pour une réservation saisie au tableau de bord), sans droit d'écriture sur rides.
create or replace function private.ride_offers_private_fleet_hold()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.is_private_fleet(new.organization_id) then
    perform private.private_fleet_hold(new.organization_id, new.ride_id);
  end if;
  return null;
end;
$$;

create constraint trigger ride_offers_private_fleet_hold
  after insert or update of expires_at on public.ride_offers
  deferrable initially deferred
  for each row
  when (new.status = 'pending' and new.mode = 'fleet' and not new.is_network)
  execute function private.ride_offers_private_fleet_hold();

-- H6. Réglages « Réservations » changés pendant que des réservations attendent une réponse (Flotte Privée) :
--  * délai de confirmation : échéances annoncées tenues (private.private_fleet_hold) — une confirmation demandée plus
--    tôt ne vaut que pour les réservations suivantes ; plus tard, private.offer_to_fleet reporte l'échéance au passage
--    suivant (rappels replanifiés par H1) ;
--  * rappels : rappels « à confirmer » des offres en attente replanifiés (ceux encore prévus gardés).
-- Definer : écriture depuis le tableau de bord (owner / admin : colonnes ouvertes en écriture) ; rides.next_dispatch_at
-- et les notifications sont réservées au serveur.
create or replace function private.organization_settings_private_fleet()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  x record;
begin
  if not private.is_private_fleet(new.organization_id) then
    return null;
  end if;
  if new.scheduled_dispatch_lead_minutes is distinct from old.scheduled_dispatch_lead_minutes then
    perform private.private_fleet_hold(new.organization_id);
  end if;
  if new.reminder_offsets_minutes is distinct from old.reminder_offsets_minutes then
    for x in
      select o.id
        from public.rides y
        join public.ride_offers o on o.ride_id = y.id
       where y.organization_id = new.organization_id
         and y.status in ('SEARCHING_DRIVER', 'OFFERED')
         and y.driver_id is null
         and o.status = 'pending' and o.mode = 'fleet' and not o.is_network
       order by o.expires_at, o.id
    loop
      perform private.private_fleet_plan_reminders(x.id, true);
    end loop;
  end if;
  return null;
end;
$$;

create trigger organization_settings_private_fleet
  after update of scheduled_dispatch_lead_minutes, reminder_offsets_minutes on public.organization_settings
  for each row
  when (new.scheduled_dispatch_lead_minutes is distinct from old.scheduled_dispatch_lead_minutes
        or new.reminder_offsets_minutes is distinct from old.reminder_offsets_minutes)
  execute function private.organization_settings_private_fleet();

-- =============================================================================
-- I. RPC du super admin (service role seul, auteur revérifié : private.assert_platform_actor)
-- =============================================================================

-- I1. Création d'un client Flotte Privée, tout ou rien : organisation (drapeau, modèle flotte, lien fermé), adhésion
-- owner active du compte NEUF du propriétaire (phase 1 : jamais un compte existant), profil de dispatch, véhicule et
-- fiche du gérant (même compte), frais Rydar initiaux (svc_platform_set_fees « initial »). Un refus des frais annule
-- tout (exception interne RYD01 dans un sous-bloc : ni organisation, ni adhésion, ni e-mail en file) et sa réponse est
-- renvoyée telle quelle ; toute autre erreur (IDENTITY_BANNED…) annule la transaction et remonte (l'action web supprime
-- alors le compte Auth qu'elle vient de créer). Référence du contrat signé obligatoire (conditions particulières et
-- contrat de prestations, docs/FLOTTE-PRIVEE.md § 12). Aucun abonnement créé (facturation à décider).
create or replace function public.svc_platform_create_private_fleet(
  p_actor uuid,
  p_owner uuid,
  p_org jsonb,
  p_driver jsonb,
  p_vehicle jsonb,
  p_plan_id uuid,
  p_percent numeric,
  p_fixed_cents integer,
  p_contract_ref text,
  p_org_legal_version text,
  p_org_legal_effective_on date,
  p_app_url text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  u public.users;
  p public.plans;
  v_ref text := left(nullif(btrim(regexp_replace(coalesce(p_contract_ref, ''), '\s+', ' ', 'g')), ''), 200);
  v_name text := btrim(regexp_replace(coalesce(p_org ->> 'name', ''), '\s+', ' ', 'g'));
  v_slug text := lower(btrim(coalesce(p_org ->> 'slug', '')));
  v_city text := btrim(coalesce(p_org ->> 'city', ''));
  v_invalid jsonb;
  v_org uuid;
  v_driver uuid;
  v_fees jsonb;
begin
  perform private.assert_platform_actor(p_actor);
  if v_ref is null or char_length(v_ref) < 3 then
    return jsonb_build_object('ok', false, 'code', 'CONSENT_REQUIRED', 'field', 'contractRef',
      'message', private.fr_typo('Référence du contrat signé requise : conditions particulières et contrat de prestations, signés avant toute activation.'));
  end if;
  select * into u from public.users x where x.id = p_owner;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'field', 'ownerEmail',
      'message', 'Compte du propriétaire introuvable.');
  end if;
  if p_owner = p_actor or u.is_super_admin then
    return jsonb_build_object('ok', false, 'code', 'SELF_NOT_ALLOWED', 'field', 'ownerEmail',
      'message', 'Impossible de vous désigner vous-même.');
  end if;
  if exists (select 1 from public.drivers x where x.user_id = p_owner) then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_REGISTERED', 'field', 'ownerEmail',
      'message', 'Ce compte est déjà rattaché à une fiche chauffeur.');
  end if;
  -- Défense en profondeur (le web refuse déjà toute adresse existante) : compte créé pour ce client, sans adhésion
  if exists (select 1 from public.organization_users x where x.user_id = p_owner)
     or u.created_at < now() - interval '1 hour' then
    return jsonb_build_object('ok', false, 'code', 'OWNER_NOT_NEW', 'field', 'ownerEmail',
      'message', private.fr_typo('Compte déjà utilisé : la Flotte Privée exige un compte neuf (phase 1).'));
  end if;
  if p_plan_id is not null then
    select * into p from public.plans x where x.id = p_plan_id;
    if not found or not p.is_active
       or not coalesce(lower(btrim(p.limits ->> 'api_access')) in ('true', 't', 'yes', 'y', 'on', '1'), false) then
      return jsonb_build_object('ok', false, 'code', 'PRIVATE_FLEET_PLAN_INVALID', 'field', 'planId',
        'message', private.fr_typo('Offre sans accès à l''API : le site du client ne pourrait pas réserver.'));
    end if;
  end if;
  if char_length(v_name) not between 2 and 120 then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'field', 'name',
      'message', 'Nom commercial requis (2 à 120 caractères).');
  end if;
  if v_slug !~ '^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'field', 'slug',
      'message', 'Identifiant invalide : lettres minuscules, chiffres et tirets.');
  end if;
  if private.is_reserved_subdomain(v_slug) then
    return jsonb_build_object('ok', false, 'code', 'SUBDOMAIN_RESERVED', 'field', 'slug',
      'message', private.fr_typo('Ce sous-domaine est réservé à la plateforme : choisissez-en un autre.'));
  end if;
  if exists (select 1 from public.organizations x where x.slug = v_slug) then
    return jsonb_build_object('ok', false, 'code', 'SLUG_TAKEN', 'field', 'slug', 'message', 'Ce slug est déjà utilisé.');
  end if;
  -- Ville obligatoire (docs/FLOTTE-PRIVEE.md § 8.1, privateFleetCreateSchema)
  if char_length(v_city) not between 1 and 80 then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'field', 'city',
      'message', 'Ville requise (80 caractères au plus).');
  end if;
  v_invalid := private.private_fleet_driver_input_error(p_driver, p_vehicle);
  if v_invalid is not null then
    return v_invalid;
  end if;

  begin
    v_org := gen_random_uuid();
    perform set_config('rydar.private_fleet_change', v_org::text, true);
    insert into public.organizations (id, name, slug, email, phone, city, legal_name, siret, vtc_registration, plan_id,
                                      created_by, private_fleet, join_enabled)
    values (v_org, v_name, v_slug, nullif(lower(btrim(p_org ->> 'email')), ''), nullif(btrim(p_org ->> 'phone'), ''),
            v_city, nullif(btrim(p_org ->> 'legal_name'), ''),
            nullif(regexp_replace(coalesce(p_org ->> 'siret', ''), '\s', '', 'g'), ''),
            nullif(btrim(p_org ->> 'vtc_registration'), ''), p_plan_id, p_actor, true, false);
    perform set_config('rydar.private_fleet_change', '', true);
    insert into public.organization_users (organization_id, user_id, role, status, invited_by, activated_at)
    values (v_org, p_owner, 'owner', 'active', p_actor, now());
    perform private.apply_dispatch_profile(v_org, true);
    v_driver := private.private_fleet_insert_driver(v_org, p_owner, p_actor, p_driver, p_vehicle);
    v_fees := public.svc_platform_set_fees(v_org, p_actor, coalesce(p_percent, 0), coalesce(p_fixed_cents, 0), 'fleet',
      'initial', null, null, p_org_legal_version, p_org_legal_effective_on, p_app_url);
    if not coalesce((v_fees ->> 'ok')::boolean, false) then
      raise exception using errcode = 'RYD01';
    end if;
  exception when sqlstate 'RYD01' then
    return v_fees;
  end;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (v_org, 'super_admin', p_actor, 'organization.private_fleet_created', 'organizations', v_org::text, 'info',
    jsonb_build_object('owner', p_owner, 'owner_email', u.email, 'driver_id', v_driver, 'plan_id', p_plan_id,
      'percent', coalesce(p_percent, 0), 'fixed_cents', coalesce(p_fixed_cents, 0), 'contract_ref', v_ref,
      'fees_code', v_fees ->> 'code'));

  return jsonb_build_object('ok', true, 'code', 'CREATED', 'organization_id', v_org, 'driver_id', v_driver, 'fees', v_fees);
end;
$$;

-- I2. Fiche du gérant recréée (après une suppression de compte chauffeur : fiche figée DRIVER_DELETED ; phase 2 :
-- compte existant invité, une fois son adhésion activée) : Flotte Privée (PRIVATE_FLEET_ONLY), propriétaire actif,
-- aucune fiche non supprimée (PRIVATE_FLEET_HAS_DRIVER), compte sans autre fiche (ALREADY_REGISTERED).
create or replace function public.svc_platform_attach_private_fleet_driver(p_org uuid, p_actor uuid, p_driver jsonb, p_vehicle jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  v_owner uuid;
  v_invalid jsonb;
  v_driver uuid;
begin
  perform private.assert_platform_actor(p_actor);
  select * into o from public.organizations x where x.id = p_org for no key update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Organisation introuvable.');
  end if;
  if not o.private_fleet then
    return jsonb_build_object('ok', false, 'code', 'PRIVATE_FLEET_ONLY', 'message', 'Réservé à la Flotte Privée.');
  end if;
  select m.user_id into v_owner
    from public.organization_users m
   where m.organization_id = p_org and m.role = 'owner' and m.status = 'active'
   order by m.created_at, m.id
   limit 1;
  if v_owner is null then
    if exists (select 1 from public.organization_users m
                where m.organization_id = p_org and m.role = 'owner' and m.status = 'invited') then
      return jsonb_build_object('ok', false, 'code', 'INVITATION_PENDING',
        'message', private.fr_typo('Le propriétaire n''a pas encore activé son accès : la fiche sera recréée après son activation.'));
    end if;
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Aucun propriétaire actif pour cette organisation.');
  end if;
  if exists (select 1 from public.drivers x where x.organization_id = p_org and x.deleted_at is null) then
    return jsonb_build_object('ok', false, 'code', 'PRIVATE_FLEET_HAS_DRIVER',
      'message', 'Cette Flotte Privée a déjà une fiche chauffeur.');
  end if;
  if exists (select 1 from public.drivers x where x.user_id = v_owner) then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_REGISTERED',
      'message', 'Ce compte est déjà rattaché à une fiche chauffeur.');
  end if;
  v_invalid := private.private_fleet_driver_input_error(p_driver, p_vehicle);
  if v_invalid is not null then
    return v_invalid;
  end if;

  perform private.set_actor('super_admin', p_actor);
  v_driver := private.private_fleet_insert_driver(p_org, v_owner, p_actor, p_driver, p_vehicle);

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, 'super_admin', p_actor, 'driver.private_fleet_attached', 'drivers', v_driver::text, 'info',
    jsonb_build_object('owner', v_owner, 'driver_id', v_driver));

  return jsonb_build_object('ok', true, 'code', 'CREATED', 'driver_id', v_driver);
end;
$$;

-- I3. Bascule sur place, sans perte (organization_id immuable) : entrée en Flotte Privée (aucune raison de
-- private_fleet_blockers, sinon PRIVATE_FLEET_NOT_ELIGIBLE + liste ; lien fermé, profil Flotte Privée, owner_driver
-- posé) ou sortie (profil standard ; offre choisie si p_set_plan — p_plan_id, null = sans offre — écrite après le
-- drapeau ; puis, si un modèle ou des taux sont fournis, public.svc_platform_set_fees dans le MÊME sous-bloc : son refus
-- annule tout, offre comprise, et sa réponse est renvoyée telle quelle ; le drapeau d'abord, la contrainte refusant
-- « centrale » tant qu'il est vrai). Note obligatoire : demande ou accord écrit du client (CGV art. 3).
-- Courses en recherche : aucune offre fermée — une offre en attente vit jusqu'à son échéance annoncée (passage
-- inchangé, au besoin repoussé : private.private_fleet_hold) ; sans offre en attente, relancées au passage suivant
-- (échéances recalculées avec le nouveau profil) ; entrée : course déjà en vagues GPS reprise à la première vague du
-- nouveau plan (le dernier appel de 100 km est vraiment lancé) ; sortie : rappels « à confirmer » en file annulés.
-- Audit organization.private_fleet_enabled / _disabled (et organization.plan_changed si l'offre change) ; diffusion
-- « platform.updated » (model) et « driver.updated » de chaque fiche (l'application relit driver_home).
create or replace function public.svc_platform_set_private_fleet(
  p_org uuid,
  p_actor uuid,
  p_enabled boolean,
  p_consent_note text,
  p_dispatch_model text default null,
  p_percent numeric default null,
  p_fixed_cents integer default null,
  p_fee_mode text default 'notice',
  p_effective_on date default null,
  p_org_legal_version text default null,
  p_org_legal_effective_on date default null,
  p_app_url text default null,
  p_set_plan boolean default false,
  p_plan_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  v_note text := left(nullif(btrim(regexp_replace(coalesce(p_consent_note, ''), '\s+', ' ', 'g')), ''), 500);
  v_model text := case when p_enabled and p_dispatch_model = 'fleet' then null else p_dispatch_model end;
  v_rates boolean := p_percent is not null or p_fixed_cents is not null;
  v_set_plan boolean := coalesce(p_set_plan, false);
  v_plan_changed boolean := false;
  v_blockers text[] := '{}';
  v_fees jsonb;
  v_open integer := 0;
  v_code text;
  x record;
begin
  perform private.assert_platform_actor(p_actor);
  if p_enabled is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'field', 'target', 'message', 'Offre de service inconnue.');
  end if;
  if v_note is null or char_length(v_note) < 3 then
    return jsonb_build_object('ok', false, 'code', 'CONSENT_REQUIRED', 'field', 'consentNote',
      'message', private.fr_typo('Changement d''offre de service : précisez la demande ou l''accord écrit du client (date et forme : e-mail, courrier…), CGV article 3.'));
  end if;
  -- Offre de la sortie : active (une offre retirée ne s'attribue plus) ; null = sans offre, absence assumée
  if v_set_plan and p_plan_id is not null
     and not exists (select 1 from public.plans y where y.id = p_plan_id and y.is_active) then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'field', 'planId', 'message', 'Offre introuvable ou inactive.');
  end if;
  -- Entrée : écritures concurrentes attendues puis relues par les gardes (D : verrou de la ligne de l'organisation,
  -- pris ci-dessous ; E : verrou consultatif exclusif ici, partagé dans la garde)
  if p_enabled then
    perform pg_advisory_xact_lock(hashtextextended('rydar.private_fleet:' || p_org::text, 0));
  end if;
  select * into o from public.organizations y where y.id = p_org for no key update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Organisation introuvable.');
  end if;
  if o.status = 'archived' then
    return jsonb_build_object('ok', false, 'code', 'ORGANIZATION_INACTIVE', 'message', 'Organisation archivée.');
  end if;
  if p_enabled and (v_model is not null or v_rates or v_set_plan) then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'field', 'dispatchModel',
      'message', private.fr_typo('Entrée en Flotte Privée : modèle flotte, frais et offre inchangés (réglez-les ensuite depuis la fiche).'));
  end if;
  if o.private_fleet = p_enabled then
    if v_model is null and not v_rates and not v_set_plan then
      return jsonb_build_object('ok', true, 'code', 'UNCHANGED');
    end if;
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'field', 'dispatchModel',
      'message', private.fr_typo('Organisation déjà hors de la Flotte Privée : modèle, frais et offre se règlent depuis sa fiche.'));
  end if;
  perform private.set_actor('super_admin', p_actor);

  begin
    if p_enabled then
      v_blockers := coalesce(private.private_fleet_blockers(p_org), '{}'::text[]);
      if cardinality(v_blockers) > 0 then
        return jsonb_build_object('ok', false, 'code', 'PRIVATE_FLEET_NOT_ELIGIBLE', 'blockers', to_jsonb(v_blockers),
          'message', private.fr_typo('Passage en Flotte Privée impossible : un seul membre (le propriétaire), une seule fiche (la sienne), aucune candidature, aucun réseau partagé, modèle flotte.'));
      end if;
      perform set_config('rydar.private_fleet_change', p_org::text, true);
      update public.organizations
         set private_fleet = true, join_enabled = false, join_auto_approve = false
       where id = p_org;
      perform set_config('rydar.private_fleet_change', '', true);
      perform private.apply_dispatch_profile(p_org, true);
      update public.drivers d
         set owner_driver = true
       where d.organization_id = p_org and d.deleted_at is null and not d.owner_driver
         and exists (select 1 from public.organization_users m
                      where m.organization_id = p_org and m.user_id = d.user_id and m.role = 'owner' and m.status = 'active');
      -- Course déjà en vagues GPS : plan de rayons changé sous elle ; reprise à la première vague (dernier appel)
      update public.rides k
         set dispatch_wave = 0
       where k.organization_id = p_org and k.status in ('SEARCHING_DRIVER', 'OFFERED') and k.dispatch_mode = 'geo';
    else
      perform set_config('rydar.private_fleet_change', p_org::text, true);
      update public.organizations set private_fleet = false where id = p_org;
      perform set_config('rydar.private_fleet_change', '', true);
      -- Offre choisie, après le drapeau et dans le même sous-bloc : un refus des frais l'annule avec le reste
      if v_set_plan and p_plan_id is distinct from o.plan_id then
        update public.organizations set plan_id = p_plan_id where id = p_org;
        v_plan_changed := true;
      end if;
      perform private.apply_dispatch_profile(p_org, false);
      -- Rappels « à confirmer » : propres à la Flotte Privée (échéances recalculées avec le profil standard)
      update public.notifications n
         set status = 'cancelled'
       where n.organization_id = p_org and n.status = 'queued' and n.data ->> 'kind' = 'private_reminder';
      if v_model is not null or v_rates then
        v_fees := public.svc_platform_set_fees(p_org, p_actor, p_percent, p_fixed_cents, v_model, p_fee_mode,
          p_effective_on, v_note, p_org_legal_version, p_org_legal_effective_on, p_app_url);
        if not coalesce((v_fees ->> 'ok')::boolean, false) then
          raise exception using errcode = 'RYD01';
        end if;
      end if;
    end if;
    -- Aucune offre fermée : une offre en attente vit jusqu'à son échéance annoncée ; les autres courses en recherche
    -- repartent au passage suivant, avec le nouveau profil
    update public.rides k
       set next_dispatch_at = now()
     where k.organization_id = p_org and k.status in ('SEARCHING_DRIVER', 'OFFERED')
       and not exists (select 1 from public.ride_offers f where f.ride_id = k.id and f.status = 'pending');
    perform private.private_fleet_hold(p_org);
    select count(*)::integer into v_open
      from public.rides k
     where k.organization_id = p_org and k.status in ('SEARCHING_DRIVER', 'OFFERED');
  exception when sqlstate 'RYD01' then
    return v_fees;
  end;

  v_code := case when p_enabled then 'PRIVATE_FLEET_ENABLED' else 'PRIVATE_FLEET_DISABLED' end;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, 'super_admin', p_actor,
    case when p_enabled then 'organization.private_fleet_enabled' else 'organization.private_fleet_disabled' end,
    'organizations', p_org::text, 'warning',
    jsonb_build_object('note', v_note, 'blockers', to_jsonb(v_blockers),
      'dispatch_model', coalesce(v_model, o.dispatch_model), 'fees_code', v_fees ->> 'code', 'open_rides', v_open,
      'plan_id', case when v_plan_changed then p_plan_id else o.plan_id end, 'plan_changed', v_plan_changed));
  -- Même action et mêmes clés que « Offre & limites » (updateOrganizationPlan) : historique des offres de la fiche
  if v_plan_changed then
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
    values (p_org, 'super_admin', p_actor, 'organization.plan_changed', 'organizations', p_org::text, 'info',
      jsonb_build_object('planId', p_plan_id, 'previousPlanId', o.plan_id, 'reason', 'private_fleet_disabled'));
  end if;

  perform private.broadcast_platform(p_org, 'model');
  for x in select d.id, d.presence, d.status, d.current_ride_id from public.drivers d where d.organization_id = p_org loop
    perform realtime.send(
      jsonb_build_object('id', x.id, 'presence', x.presence, 'status', x.status, 'current_ride_id', x.current_ride_id),
      'driver.updated', 'driver:' || x.id::text, true);
  end loop;

  return jsonb_build_object('ok', true, 'code', v_code, 'fees', v_fees, 'open_rides', v_open);
end;
$$;

-- =============================================================================
-- J. RPC du chauffeur (security definer, portée private.current_driver_id())
-- =============================================================================

-- J1. « La prendre » / « Confirmer quand même » (Flotte Privée seulement) : réservation de SON organisation encore
-- sans chauffeur (en recherche ou sans chauffeur), prise en charge il y a moins de 6 h (RIDE_TOO_LATE au-delà :
-- PRIVATE_FLEET_TAKE_MAX_AGE_HOURS). Offre en attente : acceptation atomique (public.accept_ride_offer) ; occupé par une
-- course immédiate (DRIVER_BUSY) ou offre expirée : attribution (public.assign_ride : aucune condition de catégorie,
-- enchaînée à la fin de la course en cours) ; la notification « attribuée » qui lui serait adressée est annulée.
create or replace function public.driver_take_ride(p_ride_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  r public.rides;
  v_offer uuid;
  v_res jsonb;
  v_current uuid;
  v_chained boolean;
begin
  select * into d from public.drivers where id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  if not private.is_private_fleet(d.organization_id) then
    return jsonb_build_object('ok', false, 'code', 'PRIVATE_FLEET_ONLY', 'message', 'Réservé à la Flotte Privée.');
  end if;
  perform private.set_actor('driver', d.id);

  select * into r from public.rides x where x.id = p_ride_id and x.organization_id = d.organization_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_FOUND', 'message', 'Course introuvable.');
  end if;
  if r.driver_id = d.id then
    return jsonb_build_object('ok', true, 'code', 'UNCHANGED', 'ride_id', r.id);
  end if;
  if r.driver_id is not null or r.status not in ('CREATED', 'SEARCHING_DRIVER', 'OFFERED', 'NO_DRIVER_FOUND') then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_ASSIGNABLE',
      'message', 'Cette réservation ne peut plus être prise.');
  end if;
  if r.pickup_at < now() - make_interval(hours => 6) then
    return jsonb_build_object('ok', false, 'code', 'RIDE_TOO_LATE',
      'message', 'Heure de prise en charge dépassée depuis plus de 6' || chr(160) || 'h.');
  end if;

  select x.id into v_offer
    from public.ride_offers x
   where x.ride_id = r.id and x.driver_id = d.id and x.status = 'pending'
   order by x.sent_at desc, x.id
   limit 1;
  if v_offer is not null then
    v_res := public.accept_ride_offer(v_offer);
    if coalesce((v_res ->> 'ok')::boolean, false) then
      return v_res;
    end if;
    if coalesce(v_res ->> 'code', '') not in ('DRIVER_BUSY', 'OFFER_EXPIRED') then
      return v_res;
    end if;
  end if;

  v_res := public.assign_ride(r.id, d.id);
  if not coalesce((v_res ->> 'ok')::boolean, false) then
    return v_res;
  end if;
  update public.notifications
     set status = 'cancelled'
   where ride_id = r.id and driver_id = d.id and type = 'ride_assigned' and status = 'queued';
  select x.current_ride_id into v_current from public.drivers x where x.id = d.id;
  v_chained := r.type = 'instant' and v_current is not null and v_current <> r.id;
  perform private.log_event(r.organization_id, r.id, 'ride.taken_by_driver',
    case when v_chained then format('%s prend la réservation — enchaînée après sa course en cours', d.first_name)
         else format('%s prend la réservation', d.first_name) end,
    'timeline', 'success',
    jsonb_build_object('driver_id', d.id, 'previous_status', r.status, 'chained', v_chained, 'private_fleet', true),
    'driver', d.id);
  return jsonb_build_object('ok', true, 'code', 'ACCEPTED', 'message', 'Réservation confirmée.', 'ride_id', r.id,
    'chained', v_chained);
end;
$$;

-- J2. Agenda du chauffeur sur une période de 62 jours au plus (PRIVATE_FLEET_AGENDA_MAX_DAYS de @rydar/shared).
--  * rides : SES courses de la période, tous statuts ; une course close (terminée, annulée, sans chauffeur) seulement
--    si elle a changé depuis moins de 24 h (règle RLS du chauffeur) ou s'il est membre de l'organisation de la course
--    (un membre lit déjà toutes ses courses : RLS rides_select) — jamais l'historique avec clients pour un chauffeur
--    non membre ; liste blanche de private.driver_ride_json (sans client d'une course partenaire) ; 500 au plus.
--  * unassigned (Flotte Privée et membre, sinon NULL) : réservations sans chauffeur à traiter, QUELLE QUE SOIT la
--    période (private.private_fleet_unassigned : offre en attente, échéance, état) ; 100 au plus.
create or replace function public.driver_agenda(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_member boolean;
  v_private boolean;
  v_tz text;
  v_rides jsonb;
  v_unassigned jsonb;
begin
  select * into d from public.drivers where id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '62 days' then
    raise exception 'AGENDA_RANGE_INVALID: période d''agenda invalide (62 jours au plus, fin après le début)'
      using errcode = '22023';
  end if;
  v_member := d.organization_id in (select private.member_org_ids());
  v_private := private.is_private_fleet(d.organization_id);
  select o.timezone into v_tz from public.organizations o where o.id = d.organization_id;

  select coalesce(jsonb_agg(x.v order by x.pickup_at, x.id), '[]'::jsonb) into v_rides
    from (select private.driver_ride_json(r, d, false) as v, r.pickup_at, r.id
            from public.rides r
           where r.driver_id = d.id
             and r.pickup_at >= p_from
             and r.pickup_at < p_to
             and (r.status not in ('COMPLETED', 'CANCELLED', 'NO_DRIVER_FOUND')
                  or r.updated_at > now() - interval '24 hours'
                  or (v_member and r.organization_id = d.organization_id))
           order by r.pickup_at, r.id
           limit 500) x
   where x.v is not null;

  if v_private and v_member then
    select coalesce(jsonb_agg(y.v order by y.pickup_at, y.id), '[]'::jsonb) into v_unassigned
      from (select private.driver_ride_json(r, d, false)
                     || jsonb_build_object('offer_id', u.offer_id, 'offer_expires_at', u.offer_expires_at, 'state', u.state) as v,
                   r.pickup_at, r.id
              from private.private_fleet_unassigned(d.organization_id, d.id, 100) u
              join public.rides r on r.id = u.ride_id) y
     where y.v is not null;
  end if;

  return jsonb_build_object('timezone', coalesce(v_tz, 'Europe/Paris'), 'private_fleet', v_private, 'from', p_from,
    'to', p_to, 'rides', v_rides, 'unassigned', v_unassigned);
end;
$$;

-- =============================================================================
-- K. Lectures de l'application
-- =============================================================================

-- Dernière définition : 20260924006900_shared_network_money.sql. Ajouts seulement : organization.private_fleet,
-- driver.owner_driver ; clé « private » pour une Flotte Privée seulement : { unassigned: n } = réservations sans
-- chauffeur à traiter (à vérifier, non confirmées : mêmes critères que driver_agenda.unassigned, sans offre en attente
-- pour lui ni dernier refus ; 0 pour un chauffeur qui n'est pas membre). Organisation standard : deux clés booléennes
-- en plus, rien d'autre.
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
  v_centrale boolean;
  v_block text;
  v_settlement jsonb;
  v_network jsonb;
  v_private jsonb;
begin
  select * into d from public.drivers where id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  select * into o from public.organizations where id = d.organization_id;
  v_day_start := date_trunc('day', now() at time zone o.timezone) at time zone o.timezone;
  v_centrale := o.dispatch_model = 'centrale';

  if v_centrale then
    v_block := private.driver_blocker(d.id, null);
    select jsonb_build_object(
        'owed_cents', coalesce(sum(x.amount_cents) filter (where x.direction = 'driver_owes' and x.status in ('due', 'disputed')), 0),
        'overdue_cents', coalesce(sum(x.amount_cents) filter (where x.direction = 'driver_owes'
          and (x.status = 'disputed' or (x.status = 'due' and x.due_at <= now()))), 0),
        'declared_cents', coalesce(sum(x.amount_cents) filter (where x.direction = 'driver_owes' and x.status = 'declared'), 0),
        'to_receive_cents', coalesce(sum(x.amount_cents) filter (where x.direction = 'centrale_owes' and x.status = 'due'), 0),
        'open_count', count(*),
        'next_due_at', min(x.due_at) filter (where x.direction = 'driver_owes' and x.status = 'due' and x.due_at > now()),
        'blocked', v_block,
        'blocked_message', private.blocker_message(v_block))
      into v_settlement
    from public.ride_settlements x
    where x.driver_id = d.id and x.status in ('due', 'declared', 'disputed');
  end if;
  -- Réseau partagé : sommes des courses partenaires, lisibilité (NULL : clé absente)
  v_network := private.driver_home_network(d);
  -- Flotte Privée : réservations sans chauffeur à traiter
  if o.private_fleet then
    select jsonb_build_object('unassigned', count(*)) into v_private
      from private.private_fleet_unassigned(o.id, d.id, 100) u
     where u.state in ('to_check', 'not_confirmed')
       and d.organization_id in (select private.member_org_ids());
  end if;

  return jsonb_build_object(
    'driver', jsonb_build_object(
      'id', d.id, 'number', d.number, 'first_name', d.first_name, 'last_name', d.last_name,
      'presence', d.presence, 'photo_url', d.photo_url, 'current_ride_id', d.current_ride_id,
      'trust_level', d.trust_level, 'owner_driver', d.owner_driver),
    'organization', jsonb_build_object('id', o.id, 'name', o.name, 'logo_url', o.logo_url, 'phone', o.phone,
      'timezone', o.timezone, 'dispatch_model', o.dispatch_model, 'private_fleet', o.private_fleet),
    'model', o.dispatch_model,
    'vehicle', (
      select jsonb_build_object('brand', v.brand, 'model', v.model, 'plate', v.plate, 'color', v.color,
        'category', v.category, 'seats', v.seats)
      from public.vehicles v where v.id = d.vehicle_id
    ),
    'today', (
      select jsonb_build_object('rides', count(*), 'revenue_cents', coalesce(sum(x.price_cents), 0),
        'net_cents', case when v_centrale then coalesce(sum(
          -- Réseau partagé : course partenaire → sa part aux termes figés
          case when x.organization_id <> d.organization_id then private.network_driver_part(x.id)
               else x.driver_payout_cents end), 0) end)
      from public.rides x
      where x.driver_id = d.id and x.status = 'COMPLETED' and x.completed_at >= v_day_start
    ),
    'next_scheduled', (
      select jsonb_build_object('id', x.id, 'number', x.number, 'pickup_at', x.pickup_at,
        'pickup_address', x.pickup_address, 'dropoff_address', x.dropoff_address, 'price_cents', x.price_cents,
        'driver_payout_cents', case when x.organization_id <> d.organization_id then private.network_driver_part(x.id)
                                    else x.driver_payout_cents end)
      from public.rides x
      where x.driver_id = d.id and x.status = 'ACCEPTED' and x.type = 'scheduled'
      order by x.pickup_at
      limit 1
    ),
    'pending_offers', (
      select count(*) from public.ride_offers x where x.driver_id = d.id and x.status = 'pending'
    ),
    'settlement', v_settlement
  ) || case when v_network is null then '{}'::jsonb else jsonb_build_object('network', v_network) end
    || case when o.private_fleet then jsonb_build_object('private', v_private) else '{}'::jsonb end;
end;
$$;

-- Dernière définition : 20260924007400_legal_review.sql. Seul ajout : organization.private_fleet (l'application
-- détecte la Flotte Privée même compte en attente, refusé ou suspendu ; clé absente d'un serveur plus ancien = standard).
create or replace function public.driver_account_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  o public.organizations;
  v_state text;
begin
  select * into d from public.drivers where user_id = auth.uid();
  if not found then
    return jsonb_build_object('state', 'none', 'message', 'Aucun compte chauffeur n''est associé à cet identifiant.');
  end if;
  select * into o from public.organizations where id = d.organization_id;

  v_state := case
    when d.banned_at is not null then 'banned'
    when o.status <> 'active' then 'organization_suspended'
    when d.application_status = 'pending' then 'pending'
    when d.application_status = 'rejected' then 'rejected'
    when d.status = 'active' then 'active'
    when d.status = 'invited' then 'invited'
    when d.status = 'suspended' then 'suspended'
    else 'inactive'
  end;

  return jsonb_build_object(
    'state', v_state,
    'driver', jsonb_build_object('id', d.id, 'number', d.number, 'first_name', d.first_name, 'last_name', d.last_name,
      'applied_at', d.applied_at, 'trust_level', d.trust_level),
    'organization', jsonb_build_object('id', o.id, 'name', o.name, 'logo_url', o.logo_url, 'phone', o.phone, 'email', o.email,
      'timezone', o.timezone, 'dispatch_model', o.dispatch_model, 'private_fleet', o.private_fleet),
    'reason', case v_state
      when 'banned' then d.ban_reason
      when 'rejected' then d.application_note
      when 'suspended' then d.suspended_reason
    end,
    'can_submit_documents', v_state = 'pending',
    -- Bannissement : « org » (décidé par la centrale) ou « platform » (décidé par l'éditeur, motifs envoyés par e-mail)
    'ban_scope', case when v_state = 'banned' then d.ban_scope end
  );
end;
$$;

-- =============================================================================
-- L. Droits (deny-by-default, cf. 20260924000900) — fonctions redéfinies (même signature) : droits conservés
-- =============================================================================
revoke all on function
  private.is_private_fleet(uuid),
  private.private_fleet_driver(uuid),
  private.private_fleet_blockers(uuid),
  private.dispatch_profile(boolean),
  private.apply_dispatch_profile(uuid, boolean),
  private.private_fleet_driver_input_error(jsonb, jsonb),
  private.private_fleet_insert_driver(uuid, uuid, uuid, jsonb, jsonb),
  private.private_fleet_unassigned(uuid, uuid, integer),
  private.private_fleet_hold(uuid, uuid),
  private.organizations_private_fleet_guard(),
  private.drivers_private_fleet_guard(),
  private.organization_users_private_fleet_guard(),
  private.network_memberships_private_fleet_guard(),
  private.private_fleet_dispatch(uuid),
  private.private_fleet_plan_reminders(uuid, boolean),
  private.ride_offers_private_fleet_reminders(),
  private.ride_offers_private_fleet_declined(),
  private.rides_private_fleet_unconfirmed(),
  private.ride_offers_private_fleet_new(),
  private.ride_offers_private_fleet_hold(),
  private.organization_settings_private_fleet()
from public, anon, authenticated;
grant execute on function
  private.is_private_fleet(uuid),
  private.private_fleet_driver(uuid),
  private.private_fleet_blockers(uuid),
  private.dispatch_profile(boolean),
  private.apply_dispatch_profile(uuid, boolean),
  private.private_fleet_driver_input_error(jsonb, jsonb),
  private.private_fleet_insert_driver(uuid, uuid, uuid, jsonb, jsonb),
  private.private_fleet_unassigned(uuid, uuid, integer),
  private.private_fleet_hold(uuid, uuid),
  private.organizations_private_fleet_guard(),
  private.drivers_private_fleet_guard(),
  private.organization_users_private_fleet_guard(),
  private.network_memberships_private_fleet_guard(),
  private.private_fleet_dispatch(uuid),
  private.private_fleet_plan_reminders(uuid, boolean),
  private.ride_offers_private_fleet_reminders(),
  private.ride_offers_private_fleet_declined(),
  private.rides_private_fleet_unconfirmed(),
  private.ride_offers_private_fleet_new(),
  private.ride_offers_private_fleet_hold(),
  private.organization_settings_private_fleet()
to service_role;

revoke all on function
  public.svc_platform_create_private_fleet(uuid, uuid, jsonb, jsonb, jsonb, uuid, numeric, integer, text, text, date, text),
  public.svc_platform_attach_private_fleet_driver(uuid, uuid, jsonb, jsonb),
  public.svc_platform_set_private_fleet(uuid, uuid, boolean, text, text, numeric, integer, text, date, text, date, text, boolean, uuid)
from public, anon, authenticated;
grant execute on function
  public.svc_platform_create_private_fleet(uuid, uuid, jsonb, jsonb, jsonb, uuid, numeric, integer, text, text, date, text),
  public.svc_platform_attach_private_fleet_driver(uuid, uuid, jsonb, jsonb),
  public.svc_platform_set_private_fleet(uuid, uuid, boolean, text, text, numeric, integer, text, date, text, date, text, boolean, uuid)
to service_role;

revoke all on function
  public.driver_take_ride(uuid),
  public.driver_agenda(timestamptz, timestamptz)
from public, anon;
grant execute on function
  public.driver_take_ride(uuid),
  public.driver_agenda(timestamptz, timestamptz)
to authenticated, service_role;
