-- =============================================================================
-- Rydar Drive — Réseau partagé, lot 3 : dispatch. Interrupteur plateforme COUPÉ.
--
-- Une course de A qu'aucun de ses chauffeurs n'accepte est proposée aux chauffeurs des organisations B du réseau :
--  * courses immédiates : APRÈS les vagues propres de A (premier passage + relance), seulement si la course est
--    partageable (private.network_ride_reason) et qu'un partenaire éligible est dans le rayon maximal de A
--    (private.network_candidates) ; vagues réseau = rayons du premier passage de A, délai et quota de A ; un chauffeur
--    de A qui se libère pendant ces vagues passe toujours en premier ; arrêt anticipé quand plus personne ne peut être
--    sollicité ; NO_DRIVER_FOUND reste à la fin du plan (sinon : au même moment qu'aujourd'hui) ;
--  * planifiées : fenêtre réseau à prise en charge − 2 h (jamais moins de 15 min après le début du dispatch), en plus
--    de la flotte de A ; refermée à T-lead (bascule GPS : chauffeurs de A seuls), rouverte après leurs vagues ;
--  * offres réseau : termes figés (ride_offers.network_terms, private.network_terms, miroir networkTerms() de
--    @rydar/shared), notifications sans adresse précise ni montant interne, jamais lisibles par A ;
--  * acceptation (public.accept_ride_offer) : sous verrou, partage du cycle courant, paire, chauffeur éligible, termes
--    inchangés (OFFER_CLOSED / OFFER_CHANGED / DRIVER_BLOCKED), créneau libre dans les deux sens (DRIVER_BUSY_AT_TIME),
--    exécution figée dans ride_network_executions ; public.driver_offers() (anciennes apps) n'a jamais d'offre réseau.
-- Isolement (C8) : une course passée au réseau est traitée par dispatch_tick dans un bloc protégé (50 au plus par
-- passage) ; une erreur ne bloque qu'elle (3 erreurs : partage clos).
-- Partie 3b (sections 11 à 15) — après l'acceptation :
--  * retrait avant la prise en charge (private.unassign_network_ride) : par A (« Retirer », public.reassign_ride), par
--    B (public.ban_driver, public.set_driver_status) ou par le chien de garde ; course remise en recherche chez A, ses
--    chauffeurs d'abord ; partenaire prévenu sans adresse, ses notifications de la course supprimées ; 3 retraits en
--    30 jours → exclu du réseau 30 jours ; attribution à un chauffeur de A ou relance : partage clos ;
--  * vol retardé : l'heure suit le vol malgré le verrou G6 ; fenêtre réseau recalculée (C13) ;
--  * chien de garde (private.network_watch, dans private.watch_rides) : chauffeur ou B indisponible → course rendue à
--    A, ou alerte si le client est à bord (le chauffeur termine même si B est suspendue, C3) ; A suspendue : partenaires
--    prévenus ; public.close_network_ride (owner / admin de A) ;
--  * contrôles de fin (private.network_completion_checks) : course « à vérifier », jamais de refus.
-- Tant que public.shared_network_enabled() est faux, ou que A ne partage pas, tous les chemins et leurs effets sont
-- ceux d'avant (fonctions redéfinies : seules des branches réseau sont ajoutées, commentées « Réseau partagé »).
-- =============================================================================

-- =============================================================================
-- 1. Aides : rayons, intention de partage, adresses approximatives
-- =============================================================================

-- Vagues réseau : rayons du premier passage de A (sans relance), défaut 4 → 8 → 12 → 16 km comme dispatch_plan.
create or replace function private.network_radii(p_radii integer[])
returns integer[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(nullif(p_radii, '{}'), '{4000,8000,12000,16000}'::integer[]);
$$;

create or replace function private.network_max_radius(p_radii integer[])
returns integer
language sql
immutable
set search_path = ''
as $$
  select max(x) from unnest(private.network_radii(p_radii)) as t(x);
$$;

-- Organisation qui DEMANDE à partager (interrupteur plateforme ouvert, « Partager mes courses non prises ») : seul
-- filtre lu par dispatch_tick pour une course qui n'est pas au réseau. Faux : chemin du dispatch inchangé. Les
-- conditions d'éligibilité (validation, convention…) sont lues ensuite (private.network_ride_reason).
create or replace function private.network_wants_share(p_org uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.shared_network_enabled()
     and exists (select 1 from public.network_memberships m where m.organization_id = p_org and m.share_out);
$$;

-- Ouverture de la fenêtre réseau d'une planifiée : 2 h avant la prise en charge, jamais moins de 15 min après le
-- début du dispatch (NETWORK_PARAMS.scheduledLeadMinutes / scheduledMinAfterStartMinutes de @rydar/shared).
create or replace function private.network_window_at(r public.rides)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select greatest(r.pickup_at - interval '120 minutes', r.dispatch_started_at + interval '15 minutes');
$$;

-- Offre réseau (S7) : « code postal + commune » d'une adresse (« 12 Avenue X, 75008 Paris » → « 75008 Paris »),
-- NULL si aucun code postal reconnaissable ; commune seule pour l'arrivée.
create or replace function private.address_area(p_address text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(left(x.m[1] || ' ' || btrim(x.m[2]), 80), '')
    from (select regexp_match(coalesce(p_address, ''), '([0-9]{5})\s+([^,]+)') as m) x
   where x.m is not null;
$$;

create or replace function private.address_city(p_address text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(left(btrim(x.m[2]), 80), '')
    from (select regexp_match(coalesce(p_address, ''), '([0-9]{5})\s+([^,]+)') as m) x
   where x.m is not null;
$$;

-- =============================================================================
-- 2. Montants d'une course partagée (§10.1, décision Q1) — miroir EXACT : networkTerms() de @rydar/shared
-- =============================================================================
-- Le chauffeur partenaire est traité comme les chauffeurs de A ; B ne prend rien :
--  * A centrale : commission et frais Rydar de la répartition de la course (rides_centrale_split, commission saisie
--    comprise), repli champ par champ sur private.compute_ride_split (aux taux actuels de A) ;
--  * A flotte : commission 0, frais Rydar = private.fleet_platform_fee aux taux actuels de A (% du prix + fixe, sans
--    plafond au prix ; rides.platform_fee_cents, NULL en flotte ou hérité d'un passage en centrale, n'est pas lu) ;
--  * part de A = commission + frais ; part du chauffeur = prix − part de A ;
--  * à bord (espèces, carte) : le chauffeur reverse la part de A (driver_owes), sinon A lui verse sa part
--    (centrale_owes).
-- NULL = non partageable : sans prix (raison no_price) ou part du chauffeur ≤ 0 (no_payout). Le chauffeur ne voit
-- jamais commission ni frais Rydar : seulement « part de {A} » (lot accès).
create or replace function private.network_terms(r public.rides)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  o record;
  v_split_commission integer;
  v_split_fee integer;
  v_commission integer := 0;
  v_fee integer;
  v_cut integer;
  v_payout integer;
  v_collects boolean;
  v_terms jsonb;
begin
  if r.price_cents is null then
    return null;
  end if;
  select x.dispatch_model, x.platform_fee_percent, x.platform_fee_fixed_cents into o
    from public.organizations x where x.id = r.organization_id;
  if not found then
    return null;
  end if;
  if o.dispatch_model = 'centrale' then
    if r.commission_cents is null or r.platform_fee_cents is null then
      select x.commission_cents, x.platform_fee_cents into v_split_commission, v_split_fee
        from private.compute_ride_split(r.organization_id, r.price_cents, null) x;
    end if;
    v_commission := coalesce(r.commission_cents, v_split_commission);
    v_fee := coalesce(r.platform_fee_cents, v_split_fee);
  else
    v_fee := private.fleet_platform_fee(r.price_cents, o.platform_fee_percent, o.platform_fee_fixed_cents);
  end if;
  v_cut := v_commission + v_fee;
  v_payout := r.price_cents - v_cut;
  if v_payout <= 0 then
    return null;
  end if;
  v_collects := r.payment_method in ('cash', 'card');
  v_terms := jsonb_build_object(
    'price_cents', r.price_cents,
    'payment_method', r.payment_method,
    'collects', v_collects,
    'commission_cents', v_commission,
    'platform_fee_cents', v_fee,
    'giver_cut_cents', v_cut,
    'driver_payout_cents', v_payout,
    'direction', case when v_collects then 'driver_owes' else 'centrale_owes' end,
    'amount_cents', case when v_collects then v_cut else v_payout end);
  -- Contrôle d'insertion des offres (private.network_terms_insert_check) : jamais une offre refusée en 23514
  if not private.network_terms_complete(v_terms) then
    return null;
  end if;
  return v_terms;
end;
$$;

-- Somme que le chauffeur devrait à A pour cette course (termes d'une offre ou d'une course) : part de A si le
-- client paie à bord, 0 sinon. Sert aux plafonds (private.network_blocker).
create or replace function private.network_terms_debt(p_terms jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when p_terms ->> 'direction' = 'driver_owes' then coalesce((p_terms ->> 'amount_cents')::integer, 0) else 0 end;
$$;

-- =============================================================================
-- 3. Éligibilité (§9.1) — toutes les aides renvoient une RAISON (NULL = éligible), C18
-- =============================================================================

-- Course partageable par A : raison d'organisation (sens « out », private.network_org_reason) ; no_price ;
-- no_payout (part du chauffeur ≤ 0, C9).
create or replace function private.network_ride_reason(r public.rides)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(private.network_org_reason(r.organization_id, 'out'),
                  case when r.price_cents is null then 'no_price'
                       when private.network_terms(r) is null then 'no_payout' end);
$$;

-- Double réservation entre organisations (C4) : le chauffeur tient une autre course (acceptée → en cours) dont
-- l'intervalle [prise en charge, + durée estimée (45 min sinon) + 45 min] chevauche celui de p_ride. Appliqué
-- seulement si l'une des deux courses est d'une autre organisation que le chauffeur : entre ses propres courses,
-- règles d'avant (DRIVER_BUSY des instantanées, enchaînement).
create or replace function private.driver_time_conflict(p_driver uuid, p_ride uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
      from public.rides p
      join public.drivers d on d.id = p_driver
      join public.rides x on x.driver_id = p_driver
     where p.id = p_ride
       and x.id <> p.id
       and x.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS')
       and (x.organization_id <> d.organization_id or p.organization_id <> d.organization_id)
       and x.pickup_at < p.pickup_at + make_interval(secs => coalesce(p.estimated_duration_s, 2700)) + interval '45 minutes'
       and p.pickup_at < x.pickup_at + make_interval(secs => coalesce(x.estimated_duration_s, 2700)) + interval '45 minutes');
$$;

-- Documents obligatoires (§7.6, U3) : carte VTC, assurance, carte grise et permis validés et valables à la date de
-- prise en charge (p_on, fuseau de A), n° de carte VTC renseigné.
create or replace function private.network_documents_ok(d public.drivers, p_on date)
returns boolean
language sql
stable
set search_path = ''
as $$
  select nullif(btrim(coalesce(d.vtc_card_number, '')), '') is not null
     and (select count(distinct x.type)
            from public.driver_documents x
           where x.driver_id = d.id
             and x.type in ('vtc_card', 'insurance', 'vehicle_registration', 'driving_license')
             and x.status = 'valid'
             and (x.expires_at is null or x.expires_at >= p_on)) = 4;
$$;

-- Identité (S2) : par les empreintes de la fiche (private.driver_identity_keys, téléphone sous toutes ses formes,
-- e-mails, carte VTC, compte), plus les pièces, appareils et la plaque de son véhicule (private.driver_identities) :
--  * banned       : bannissement actif par A ou par la plateforme (même si la fiche de B n'a pas été cochée) ;
--  * debtor       : compte supprimé qui doit encore une somme à A (dettes propres : private.debtor_identities ; réseau :
--                   private.network_debtor_identities) ;
--  * giver_driver : fiche de A du même chauffeur active, invitée, suspendue, bannie ou endettée ;
--  * excluded     : exclu par A (« Ne plus confier de courses à ce chauffeur », non levé).
create or replace function private.network_identity_block(p_driver uuid, p_giver uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
begin
  if exists (
    select 1
      from (select k.kind, k.value_hash from private.driver_identity_keys k
             where k.driver_id = p_driver and k.kind <> 'account'
            union
            select i.kind, i.value_hash from private.driver_identities(p_driver, true) i) x
      join public.banned_identities b on b.kind = x.kind and b.value_hash = x.value_hash and b.lifted_at is null
     where b.scope = 'platform' or b.organization_id = p_giver) then
    return 'banned';
  end if;

  if exists (
       select 1
         from private.driver_identity_keys k
         join private.debtor_identities i on i.organization_id = p_giver and i.kind = k.kind and i.value_hash = k.value_hash
        where k.driver_id = p_driver
          and exists (select 1 from private.driver_open_debt(i.driver_id) od where od.owed_count > 0))
     or exists (
       select 1
         from private.driver_identity_keys k
         join private.network_debtor_identities n
           on n.creditor_org_id = p_giver and n.kind = k.kind and n.value_hash = k.value_hash
        where k.driver_id = p_driver
          and exists (select 1 from public.ride_settlements x
                       where x.organization_id = p_giver
                         and x.network_driver_id = n.driver_id
                         and x.direction = 'driver_owes'
                         and x.amount_cents > 0
                         and x.status in ('due', 'declared', 'disputed'))) then
    return 'debtor';
  end if;

  if exists (
    select 1
      from private.driver_identity_keys k
      join private.driver_identity_keys g
        on g.kind = k.kind and g.value_hash = k.value_hash and g.organization_id = p_giver and g.driver_id <> k.driver_id
      join public.drivers a on a.id = g.driver_id
     where k.driver_id = p_driver
       and (a.status in ('active', 'invited', 'suspended')
            or a.banned_at is not null
            or exists (select 1 from private.driver_open_debt(a.id) od where od.owed_count > 0))) then
    return 'giver_driver';
  end if;

  if exists (
    select 1
      from private.network_driver_exclusions x
     cross join lateral unnest(x.kinds, x.value_hashes) as u(kind, value_hash)
      join private.driver_identity_keys k on k.driver_id = p_driver and k.kind = u.kind and k.value_hash = u.value_hash
     where x.giver_org_id = p_giver and x.lifted_at is null) then
    return 'excluded';
  end if;
  return null;
end;
$$;

-- Blocages (§10.7) : règles LOCALES, jamais un blocage commun au réseau (U9, S9, S13, C7) :
--  1. own_unpaid         : règles et dettes propres de B (private.driver_blocker à 2 paramètres : jamais « nouveau
--                          chauffeur ») ;
--  2. giver_unpaid       : règle de A (block_unpaid) — ligne réseau du chauffeur envers A contestée, échue, ou
--                          redéclarée après « Pas reçu » : courses de A seulement ;
--  3. giver_credit_limit : encours envers A (déclaré > 72 h compté) + p_amount > plafond de A ;
--  4. executor_limit     : sommes dues au réseau par le chauffeur, toutes donneuses, + p_amount > plafond de B (garante).
-- p_amount : ce que le chauffeur devrait à A pour cette course (private.network_terms_debt). Les lignes réseau
-- (driver_id NULL) n'entrent jamais dans les blocages propres (private.centrale_blocker filtre driver_id).
create or replace function private.network_blocker(p_driver uuid, p_giver uuid, p_amount integer)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  s public.organization_settings;
  v_limit integer;
begin
  if private.driver_blocker(p_driver) is not null then
    return 'own_unpaid';
  end if;
  select * into s from public.organization_settings x where x.organization_id = p_giver;
  if coalesce(s.block_unpaid, true) and exists (
    select 1 from public.ride_settlements x
     where x.organization_id = p_giver
       and x.network_driver_id = p_driver
       and x.direction = 'driver_owes'
       and x.amount_cents > 0
       and (x.status = 'disputed'
            or (x.status = 'due' and x.due_at <= now())
            or (x.status = 'declared' and x.disputed_at is not null))) then
    return 'giver_unpaid';
  end if;
  if s.settlement_credit_limit_cents is not null and (
    select coalesce(sum(x.amount_cents), 0) from public.ride_settlements x
     where x.organization_id = p_giver
       and x.network_driver_id = p_driver
       and x.direction = 'driver_owes'
       and (x.status in ('due', 'disputed')
            or (x.status = 'declared'
                and (x.disputed_at is not null or coalesce(x.declared_at, x.created_at) <= now() - interval '72 hours')))
  ) + coalesce(p_amount, 0) > s.settlement_credit_limit_cents then
    return 'giver_credit_limit';
  end if;
  select m.executor_credit_limit_cents into v_limit
    from public.drivers d
    join public.network_memberships m on m.organization_id = d.organization_id
   where d.id = p_driver;
  if v_limit is not null and (
    select coalesce(sum(x.amount_cents), 0) from public.ride_settlements x
     where x.network_driver_id = p_driver
       and x.network_driver_org_id is not null
       and x.direction = 'driver_owes'
       and x.status in ('due', 'declared', 'disputed')
  ) + coalesce(p_amount, 0) > v_limit then
    return 'executor_limit';
  end if;
  return null;
end;
$$;

-- Message d'un blocage réseau, noms des organisations insérés ({giver} = A, {executor} = B). Mêmes textes que
-- NETWORK_BLOCKER_META de @rydar/shared (test network-sql.test.ts), mêmes replis que networkBlockerMessage().
create or replace function private.network_blocker_message(p_reason text, p_giver text, p_executor text)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(replace(
    case p_reason
      when 'own_unpaid' then 'Commissions en retard ou contestées chez {executor} : réglez-les pour recevoir les courses partenaires.'
      when 'giver_unpaid' then 'Un impayé envers {giver} bloque seulement les courses de {giver} : réglez-le pour en recevoir à nouveau.'
      when 'giver_credit_limit' then 'Plafond de {giver} atteint : réglez vos courses de {giver} pour en recevoir d''autres.'
      when 'executor_limit' then 'Plafond de {executor} atteint : réglez d''abord vos courses partenaires.'
    end,
    '{giver}', coalesce(nullif(btrim(p_giver), ''), 'l''organisation')),
    '{executor}', coalesce(nullif(btrim(p_executor), ''), 'votre organisation'));
$$;

create or replace function private.network_is_blocker(p_reason text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_reason in ('own_unpaid', 'giver_unpaid', 'giver_credit_limit', 'executor_limit'), false);
$$;

-- Chauffeur partenaire éligible pour CETTE course de A (la paire d'organisations est contrôlée à part :
-- private.network_pair_ok). Ordre : consent (interrupteur, autorisation de B, conditions valables), app_update
-- (nouvelle app non déclarée depuis 7 jours), inactive, excluded_until (retraits répétés), documents (§7.6, à la date
-- de prise en charge), operator_registration (B centrale : n° d'exploitant du chauffeur, bon de réservation),
-- identité (private.network_identity_block), busy (private.driver_time_conflict → DRIVER_BUSY_AT_TIME), puis blocage
-- (private.network_blocker). p_amount : ce que le chauffeur devrait à A pour cette course.
create or replace function private.network_driver_reason(d public.drivers, r public.rides, p_amount integer)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  n public.driver_network_settings;
  v_model text;
  v_on date;
  v_reason text;
begin
  select * into n from public.driver_network_settings x where x.driver_id = d.id;
  if not found or not n.enabled or not n.org_allowed or not private.network_terms_ok(n.accepted_version) then
    return 'consent';
  end if;
  if n.capable_at is null or n.capable_at < now() - interval '7 days' then
    return 'app_update';
  end if;
  if d.status <> 'active' or d.deleted_at is not null then
    return 'inactive';
  end if;
  if n.excluded_until is not null and n.excluded_until > now() then
    return 'excluded_until';
  end if;
  select (r.pickup_at at time zone coalesce(o.timezone, 'Europe/Paris'))::date into v_on
    from public.organizations o where o.id = r.organization_id;
  if not private.network_documents_ok(d, v_on) then
    return 'documents';
  end if;
  select o.dispatch_model into v_model from public.organizations o where o.id = d.organization_id;
  if v_model = 'centrale' and nullif(btrim(coalesce(d.vtc_operator_registration, '')), '') is null then
    return 'operator_registration';
  end if;
  v_reason := private.network_identity_block(d.id, r.organization_id);
  if v_reason is not null then
    return v_reason;
  end if;
  if private.driver_time_conflict(d.id, r.id) then
    return 'busy';
  end if;
  return private.network_blocker(d.id, r.organization_id, p_amount);
end;
$$;

-- Même règle, montant tiré des termes actuels de la course (§9.1).
create or replace function private.network_driver_reason(d public.drivers, r public.rides)
returns text
language sql
stable
set search_path = ''
as $$
  select private.network_driver_reason(d, r, private.network_terms_debt(private.network_terms(r)));
$$;

-- Chauffeurs partenaires éligibles pour une course de A, du plus proche au plus loin (§9.1) : autre organisation,
-- paire éligible (private.network_pair_ok), chauffeur éligible (private.network_driver_reason), fiche active, véhicule
-- compatible (catégorie avec allow_category_upgrade de A, places), position à moins de p_radius_m, jamais sollicité
-- pendant ce cycle de partage (sauf offre fermée « terms_changed »), ni refusé ou retiré pour cette course.
--  * immédiate (p_scheduled faux) : disponible, position récente (fenêtre de A), aucune offre GPS en attente pour une
--    autre course (une offre réseau ne le passe pas « sollicité » : son organisation peut toujours le solliciter) ;
--  * planifiée (fenêtre réseau) : sans présence exigée, comme la flotte, dernière position de moins de 24 h.
-- Course non partageable (A, prix, part) : aucun. Évaluée sur les seuls chauffeurs déjà dans le rayon (index GiST des
-- positions, puis d'identités) : les contrôles coûteux ne portent que sur quelques fiches.
create or replace function private.network_candidates(r public.rides, p_radius_m integer, p_scheduled boolean default false)
returns table (driver_id uuid, organization_id uuid, distance_m integer)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  s public.organization_settings;
  v_terms jsonb;
  v_amount integer;
  v_window interval;
  v_since timestamptz := coalesce(r.network_at, now());
begin
  if r.pickup_location is null or p_radius_m is null
     or private.network_org_reason(r.organization_id, 'out') is not null then
    return;
  end if;
  v_terms := private.network_terms(r);
  if v_terms is null then
    return;
  end if;
  v_amount := private.network_terms_debt(v_terms);
  select * into s from public.organization_settings x where x.organization_id = r.organization_id;
  v_window := case when coalesce(p_scheduled, false) then interval '24 hours'
                   else private.dispatch_location_window(s.location_max_age_seconds) end;
  return query
  with near as materialized (
    select d.id as n_driver, d.organization_id as n_org,
           round(extensions.st_distance(l.location, r.pickup_location))::integer as n_distance
      from public.driver_locations l
      join public.drivers d on d.id = l.driver_id
      left join public.vehicles v on v.id = d.vehicle_id
     where extensions.st_dwithin(l.location, r.pickup_location, p_radius_m)
       and l.updated_at > now() - v_window
       and coalesce(l.accuracy_m, 0) <= 1500
       and d.organization_id <> r.organization_id
       and d.status = 'active'
       and d.deleted_at is null
       and (coalesce(p_scheduled, false) or d.presence = 'available')
       and private.category_compatible(r.vehicle_category, v.category, s.allow_category_upgrade)
       and coalesce(v.seats, 0) >= r.passengers
       and not exists (
         select 1 from public.ride_offers o
          where o.ride_id = r.id
            and o.driver_id = d.id
            and (o.status in ('pending', 'declined')
                 or o.closed_reason = 'removed_by_dispatch'
                 or (o.sent_at >= v_since and o.closed_reason is distinct from 'terms_changed')))
       and (coalesce(p_scheduled, false) or not exists (
         select 1 from public.ride_offers x
          where x.driver_id = d.id and x.status = 'pending' and x.mode = 'geo'))
  ),
  partners as materialized (
    select g.n_org
      from (select distinct n.n_org from near n) g
     where private.network_pair_ok(r.organization_id, g.n_org)
  )
  select n.n_driver, n.n_org, n.n_distance
    from near n
    join partners p on p.n_org = n.n_org
    join public.drivers d on d.id = n.n_driver
   where private.network_driver_reason(d, r, v_amount) is null
   order by n.n_distance, n.n_driver;
end;
$$;

-- Chauffeurs de A sollicitables par une vague GPS (corps des candidats de private.run_geo_wave, partagé avec l'arrêt
-- anticipé du réseau) : en ligne, disponibles, position récente et précise, dans le rayon, véhicule compatible,
-- règles de la centrale, jamais refusé ni retiré ; premier passage (p_relance faux) : une seule sonnerie par
-- recherche (hors offre expirée pour une autre raison qu'une absence de réponse).
create or replace function private.own_geo_candidates(r public.rides, p_radius integer, p_relance boolean)
returns table (driver_id uuid, distance_m integer, again boolean)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  s public.organization_settings;
  v_centrale boolean;
  v_window interval;
  v_max_accuracy constant real := 1500;
begin
  select * into s from public.organization_settings x where x.organization_id = r.organization_id;
  select coalesce(o.dispatch_model = 'centrale', false) into v_centrale from public.organizations o where o.id = r.organization_id;
  v_window := private.dispatch_location_window(s.location_max_age_seconds);
  return query
    select d.id,
           round(extensions.st_distance(l.location, r.pickup_location))::integer,
           -- déjà sollicité pendant cette recherche : la relance le lui re-propose
           exists (select 1 from public.ride_offers p
                    where p.ride_id = r.id and p.driver_id = d.id and p.sent_at >= r.dispatch_started_at)
    from public.drivers d
    join public.driver_locations l on l.driver_id = d.id
    left join public.vehicles v on v.id = d.vehicle_id
    where d.organization_id = r.organization_id
      and d.status = 'active'
      and d.presence = 'available'
      -- dernière position connue, tant que le chauffeur est en ligne (application fermée, téléphone verrouillé)
      and l.updated_at > now() - v_window
      and coalesce(l.accuracy_m, 0) <= v_max_accuracy
      and extensions.st_dwithin(l.location, r.pickup_location, p_radius)
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
            or (not p_relance and o.sent_at >= r.dispatch_started_at and (o.status <> 'expired' or o.closed_reason = 'ignored'))
          )
      );
end;
$$;

-- =============================================================================
-- 4. Journal de A : raisons de non-partage, événements écrits pour un chauffeur partenaire
-- =============================================================================

-- Libellés de NETWORK_SKIP_REASON_LABELS de @rydar/shared (test network-sql.test.ts).
create or replace function private.network_skip_label(p_reason text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_reason
    when 'network_off' then 'réseau partagé fermé'
    when 'org_inactive' then 'organisation suspendue'
    when 'not_sharing' then 'partage désactivé'
    when 'not_receiving' then 'réception désactivée'
    when 'approval_pending' then 'vérification Rydar en attente'
    when 'suspended' then 'réseau partagé suspendu'
    when 'terms' then 'convention à accepter'
    when 'online_payment_method' then 'aucun moyen de paiement en ligne'
    when 'platform_fee' then 'frais Rydar à définir'
    when 'payouts_overdue' then 'versement réseau en retard'
    when 'insurance' then 'assurance à confirmer'
    when 'no_price' then 'course sans prix'
    when 'no_payout' then 'part du chauffeur nulle'
    when 'no_partner_nearby' then 'aucun chauffeur partenaire à proximité'
    else coalesce(p_reason, '?')
  end;
$$;

-- Événement du journal de A écrit pendant une action d'un chauffeur partenaire (acceptation, refus) : jamais son
-- identifiant (actor_id NULL, « driver » seulement), jamais son nom de famille ni son n° interne (S3).
create or replace function private.log_partner_event(p_org uuid, p_ride uuid, p_type text, p_message text,
                                                     p_category public.event_category, p_level public.event_level,
                                                     p_data jsonb)
returns void
language sql
set search_path = ''
as $$
  insert into public.ride_events (organization_id, ride_id, category, level, type, message, actor_type, actor_id, data)
  values (p_org, p_ride, p_category, p_level, p_type, p_message, 'driver', null, coalesce(p_data, '{}'::jsonb));
$$;

-- =============================================================================
-- 5. Offres réseau (§9.2, §9.3, §9.4)
-- =============================================================================

-- Offres aux partenaires pour une course dont le partage est ouvert (immédiate : p_mode geo, rayon de la vague ;
-- planifiée : p_mode fleet, rayon maximal de A), p_limit au plus (reste du quota de la vague après les chauffeurs de
-- A) : termes figés (network_terms), distance au départ arrondie à 100 m, notification « COURSE PARTENAIRE » sans
-- adresse précise ni montant interne (S7, U4 : ni commission, ni frais Rydar, ni coordonnées). Jamais de passage
-- « sollicité » : son organisation peut toujours le solliciter. Compteur partners_offered du partage. Renvoie le
-- nombre d'offres envoyées.
create or replace function private.network_offer(r public.rides, p_mode public.dispatch_mode, p_wave integer,
                                                 p_radius integer, p_limit integer, p_expires timestamptz)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_terms jsonb;
  v_giver text;
  v_tz text;
  v_from text;
  v_to text;
  v_when text;
  v_scheduled boolean := p_mode = 'fleet';
  v_ids uuid[];
  v_drivers uuid[];
  v_distances integer[];
  v_count integer;
begin
  if r.network_at is null or coalesce(p_limit, 0) <= 0 then
    return 0;
  end if;
  v_terms := private.network_terms(r);
  if v_terms is null then
    return 0;
  end if;
  select o.name, o.timezone into v_giver, v_tz from public.organizations o where o.id = r.organization_id;
  v_from := coalesce(private.address_area(r.pickup_address), 'départ communiqué après acceptation');
  v_to := coalesce(private.address_city(r.dropoff_address), 'arrivée communiquée après acceptation');
  v_when := to_char(r.pickup_at at time zone coalesce(v_tz, 'Europe/Paris'), 'DD/MM HH24:MI');

  with c as (
    select x.driver_id, x.distance_m
      from private.network_candidates(r, p_radius, v_scheduled) x
     order by x.distance_m, x.driver_id
     limit p_limit
  ),
  ins as (
    insert into public.ride_offers (organization_id, ride_id, driver_id, status, mode, wave, radius_m, distance_m,
                                    expires_at, network_terms)
    select r.organization_id, r.id, c.driver_id, 'pending', p_mode, p_wave,
           case when not v_scheduled then p_radius end,
           -- départ exact connu seulement après l'acceptation
           (round(c.distance_m / 100.0) * 100)::integer,
           p_expires, v_terms
      from c
    returning id, driver_id, distance_m
  )
  select coalesce(array_agg(ins.id), '{}'), coalesce(array_agg(ins.driver_id), '{}'),
         coalesce(array_agg(ins.distance_m), '{}')
    into v_ids, v_drivers, v_distances
    from ins;
  v_count := cardinality(v_ids);
  if v_count = 0 then
    return 0;
  end if;

  insert into public.notifications (organization_id, driver_id, ride_id, offer_id, type, title, body, data, priority)
  select r.organization_id, u.driver_id, r.id, u.offer_id,
         case when v_scheduled then 'ride_offer_scheduled' else 'ride_offer' end,
         case when v_scheduled then 'COURSE PARTENAIRE PLANIFIÉE' else 'COURSE PARTENAIRE' end,
         case when v_scheduled
              then format('%s · %s · %s → %s · %s', v_when, v_giver, v_from, v_to, private.fmt_eur(r.price_cents))
              else format('%s · %s → %s · %s du départ · %s', v_giver, v_from, v_to, private.fmt_km(u.distance_m),
                     private.fmt_eur(r.price_cents))
         end,
         jsonb_build_object(
           'type', case when v_scheduled then 'ride_offer_scheduled' else 'ride_offer' end,
           'offer_id', u.offer_id, 'ride_id', r.id, 'ride_type', r.type, 'network', true, 'giver', v_giver,
           'pickup', v_from, 'dropoff', v_to, 'pickup_at', r.pickup_at, 'price_cents', r.price_cents,
           'distance_m', u.distance_m, 'passengers', r.passengers, 'expires_at', p_expires),
         'high'
    from unnest(v_ids, v_drivers, v_distances) as u(offer_id, driver_id, distance_m);

  update public.ride_network_shares x
     set partners_offered = x.partners_offered + v_count, updated_at = now()
   where x.ride_id = r.id;
  return v_count;
end;
$$;

-- Ouverture d'un cycle de partage (§9.2, §9.3) : course partageable (private.network_ride_reason) ET au moins un
-- partenaire éligible dans le rayon maximal de A (U8 : sinon NO_DRIVER_FOUND au même moment qu'aujourd'hui) →
-- network_at (private.ride_network_share_sync ouvre ou rouvre le partage, étape p_stage), journal dispatch.network
-- (+ explication des chauffeurs de A pour une recherche GPS) ; sinon dispatch.network_skipped avec la raison, une fois
-- par recherche, jamais pour l'interrupteur coupé ni une organisation suspendue ou qui ne partage pas. Plus
-- d'ouverture après 3 erreurs dans la recherche (private.network_dispatch_failed). Renvoie vrai si le partage s'ouvre.
create or replace function private.network_open(p_ride uuid, p_stage text)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  r public.rides;
  s public.organization_settings;
  v_reason text;
  v_nearby integer := 0;
  v_cycle integer;
begin
  if p_stage is null or p_stage not in ('instant', 'scheduled_window', 'scheduled_geo') then
    raise exception 'network_open : étape inconnue (%)', p_stage using errcode = '22023';
  end if;
  select * into r from public.rides where id = p_ride;
  if not found or r.network_at is not null or r.driver_id is not null
     or r.status not in ('SEARCHING_DRIVER', 'OFFERED') then
    return false;
  end if;
  if (select count(*) from public.ride_events e
       where e.ride_id = r.id and e.type = 'dispatch.network_error'
         and e.created_at >= coalesce(r.dispatch_started_at, r.created_at)) >= 3 then
    return false;
  end if;
  select * into s from public.organization_settings x where x.organization_id = r.organization_id;
  v_reason := private.network_ride_reason(r);
  if v_reason is null then
    select count(*)::integer into v_nearby
      from private.network_candidates(r, private.network_max_radius(s.dispatch_radii_m), p_stage = 'scheduled_window');
    if v_nearby = 0 then
      v_reason := 'no_partner_nearby';
    end if;
  end if;
  if v_reason is not null then
    if v_reason not in ('network_off', 'org_inactive', 'not_sharing')
       and not exists (select 1 from public.ride_events e
                        where e.ride_id = r.id and e.type = 'dispatch.network_skipped'
                          and e.created_at >= coalesce(r.dispatch_started_at, r.created_at)) then
      perform private.log_event(r.organization_id, r.id, 'dispatch.network_skipped',
        case when v_reason = 'no_price' then 'Course sans prix : non proposée au réseau partagé'
             else 'Non proposée au réseau partagé : ' || private.network_skip_label(v_reason) end,
        'timeline', 'info', jsonb_build_object('reason', v_reason), 'system', null);
    end if;
    return false;
  end if;

  perform set_config('rydar.network_stage', p_stage, true);
  update public.rides set network_at = now() where id = r.id;
  perform set_config('rydar.network_stage', '', true);
  select x.cycle into v_cycle from public.ride_network_shares x where x.ride_id = r.id;
  perform private.log_event(r.organization_id, r.id, 'dispatch.network',
    case when p_stage = 'scheduled_window'
         then 'Course planifiée toujours sans chauffeur — proposée aussi au réseau partagé'
         else 'Aucun de vos chauffeurs n''a accepté — course proposée au réseau partagé' end,
    'timeline', 'info', jsonb_build_object('partners_nearby', v_nearby, 'stage', p_stage, 'cycle', v_cycle),
    'system', null);
  return true;
end;
$$;

-- Arrêt anticipé de la phase réseau (U8) : plus aucune offre en attente, ni partenaire, ni chauffeur de A à
-- solliciter dans le rayon maximal → NO_DRIVER_FOUND sans attendre la fin des vagues.
create or replace function private.network_search_exhausted(r public.rides)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_radius integer;
begin
  if exists (select 1 from public.ride_offers o where o.ride_id = r.id and o.status = 'pending') then
    return false;
  end if;
  select private.network_max_radius(s.dispatch_radii_m) into v_radius
    from public.organization_settings s where s.organization_id = r.organization_id;
  return not exists (select 1 from private.network_candidates(r, v_radius, false))
     and not exists (select 1 from private.own_geo_candidates(r, v_radius, false));
end;
$$;

-- Fenêtre réseau d'une planifiée (§9.3), juste avant private.offer_to_fleet à chaque passage (toutes les 5 min) :
-- ouverture à private.network_window_at si elle précède T-lead ; course devenue non partageable (C15) : offres
-- partenaires fermées ; sinon offres aux nouveaux partenaires éligibles (sans présence exigée, du plus proche au plus
-- loin, quota max_offers_per_wave par passage), ouvertes jusqu'à T-lead comme celles de la flotte.
create or replace function private.network_fleet_step(p_ride uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  r public.rides;
  s public.organization_settings;
  v_lead timestamptz;
  v_window timestamptz;
  v_expires timestamptz;
  v_count integer;
begin
  select * into r from public.rides where id = p_ride for update;
  if not found or r.status not in ('SEARCHING_DRIVER', 'OFFERED') or r.driver_id is not null
     or r.dispatch_mode is distinct from 'fleet' then
    return 0;
  end if;
  select * into s from public.organization_settings x where x.organization_id = r.organization_id;
  v_lead := r.pickup_at - make_interval(mins => coalesce(s.scheduled_dispatch_lead_minutes, 60));
  if now() >= v_lead then
    return 0;
  end if;
  if r.network_at is null then
    v_window := private.network_window_at(r);
    if v_window >= v_lead or now() < v_window or not private.network_open(r.id, 'scheduled_window') then
      return 0;
    end if;
    select * into r from public.rides where id = p_ride;
  elsif private.network_ride_reason(r) is not null then
    perform private.close_network_offers(r.organization_id, null, null, 'network_unavailable', r.id);
    return 0;
  end if;
  v_expires := greatest(v_lead, now() + make_interval(secs => coalesce(s.offer_timeout_seconds, 30)));
  v_count := private.network_offer(r, 'fleet', 1, private.network_max_radius(s.dispatch_radii_m),
                                   coalesce(s.max_offers_per_wave, 25), v_expires);
  if v_count > 0 then
    perform private.log_event(r.organization_id, r.id, 'dispatch.fleet',
      format('Course proposée à %s %s', v_count,
        private.pl(v_count, 'chauffeur partenaire du réseau partagé', 'chauffeurs partenaires du réseau partagé')),
      'timeline', 'success', jsonb_build_object('network_offered', v_count, 'open_until', v_expires), 'system', null);
    perform pg_notify('rydar_notifications', r.id::text);
  end if;
  return v_count;
end;
$$;

-- Erreur pendant l'étape réseau d'une course (bloc protégé de private.dispatch_tick, ses effets déjà annulés, C8) :
-- erreur comptée (ride_network_shares.errors, journal dispatch.network_error sans détail technique), course repoussée
-- d'un délai. 3e erreur de la recherche : partage clos (« error ») — recherche GPS : fin du plan (NO_DRIVER_FOUND) ;
-- fenêtre d'une planifiée : offres partenaires fermées, la flotte continue (plus d'ouverture avant la bascule GPS).
create or replace function private.network_dispatch_failed(p_ride uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  r public.rides;
  v_timeout integer;
  v_errors integer;
  v_closed uuid[];
begin
  select * into r from public.rides where id = p_ride;
  if not found then
    return;
  end if;
  select x.offer_timeout_seconds into v_timeout from public.organization_settings x where x.organization_id = r.organization_id;
  select count(*)::integer + 1 into v_errors
    from public.ride_events e
   where e.ride_id = r.id and e.type = 'dispatch.network_error'
     and e.created_at >= coalesce(r.dispatch_started_at, r.created_at);
  update public.ride_network_shares x
     set errors = least(x.errors + 1, 32767), updated_at = now()
   where x.ride_id = r.id and x.status in ('open', 'accepted');
  perform private.log_event(r.organization_id, r.id, 'dispatch.network_error',
    'Réseau partagé : étape interrompue par une erreur — nouvel essai au prochain délai',
    'dispatch', 'warning', jsonb_build_object('errors', v_errors), 'system', null);
  if v_errors < 3 then
    update public.rides set next_dispatch_at = now() + make_interval(secs => coalesce(v_timeout, 30)) where id = r.id;
    return;
  end if;

  perform set_config('rydar.network_reason', 'error', true);
  if r.dispatch_mode = 'fleet' then
    perform private.close_network_offers(r.organization_id, null, null, 'network_unavailable', r.id);
    update public.rides
       set network_at = null, next_dispatch_at = now() + make_interval(secs => coalesce(v_timeout, 30))
     where id = r.id;
  else
    v_closed := private.close_pending_offers(r.id, 'expired', 'timeout');
    update public.rides
       set status = 'NO_DRIVER_FOUND', no_driver_at = now(), next_dispatch_at = null, network_at = null
     where id = r.id;
    perform private.log_event(r.organization_id, r.id, 'dispatch.no_driver',
      'Personne n''a accepté la course (réseau partagé interrompu par des erreurs) — attribuez-la ou relancez',
      'timeline', 'error', jsonb_build_object('waves', r.dispatch_wave, 'last_radius_m', r.dispatch_radius_m,
        'closed_offers', cardinality(v_closed), 'network', true), 'system', null);
  end if;
  perform set_config('rydar.network_reason', '', true);
exception when others then
  -- Dernier recours : la course est seulement repoussée (le dispatch des autres courses continue)
  update public.rides set next_dispatch_at = now() + interval '30 seconds' where id = p_ride;
end;
$$;

-- =============================================================================
-- 6. Moteur : étape GPS, vague, fenêtre flotte, tick (§9.2, §9.3)
-- =============================================================================

-- Étape GPS d'une course (corps de la boucle de private.dispatch_tick, extrait tel quel pour qu'une course passée au
-- réseau puisse être traitée dans un bloc protégé) : offres de chauffeurs devenus indisponibles, fin de séquence,
-- offres ignorées, prolongation, journal de transition, vague suivante. Réseau partagé (p_network : partage ouvert,
-- ou organisation qui partage à la fin de ses vagues propres) : ouverture du partage après les vagues propres
-- (private.network_open, qui remplace le journal « rayon élargi »), vagues réseau = rayons du premier passage de A,
-- arrêt anticipé (private.network_search_exhausted), fin de séquence complétée (partenaires sollicités, partage clos).
-- step : 'wave' (vague lancée) | 'no_driver' ; expired : offres fermées par la fin de séquence.
create or replace function private.dispatch_geo_step(p_ride uuid, p_network boolean, out step text, out expired integer)
language plpgsql
set search_path = ''
as $$
declare
  r public.rides;
  s public.organization_settings;
  v_plan integer[];
  v_n integer;
  v_expired uuid[];
  v_extended integer;
  v_next integer;
  v_path text;
  -- Réseau partagé
  v_own integer;
  v_opened boolean := false;
  v_stop boolean := false;
  v_network_phase boolean;
  v_partners integer := 0;
begin
  step := 'none';
  expired := 0;
  select * into r from public.rides where id = p_ride;
  select * into s from public.organization_settings where organization_id = r.organization_id;

  v_plan := private.dispatch_plan(s.dispatch_radii_m, s.dispatch_retry_radii_m);
  v_n := private.dispatch_first_pass(s.dispatch_radii_m);
  -- Réseau partagé : vagues réseau (rayons du premier passage de A) après les vagues propres
  v_own := cardinality(v_plan);
  if r.network_at is not null then
    v_plan := v_plan || private.network_radii(s.dispatch_radii_m);
  end if;

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

  -- Réseau partagé : vagues propres terminées → ouverture du partage (ses chauffeurs d'abord) ; phase réseau sans
  -- plus personne à solliciter → fin anticipée
  if p_network then
    if r.network_at is null and r.dispatch_wave >= v_own then
      v_opened := private.network_open(r.id, case when r.type = 'instant' then 'instant' else 'scheduled_geo' end);
      if v_opened then
        select * into r from public.rides where id = p_ride;
        v_plan := v_plan || private.network_radii(s.dispatch_radii_m);
      end if;
    elsif r.network_at is not null and r.dispatch_wave > v_own then
      v_stop := private.network_search_exhausted(r);
    end if;
  end if;
  v_network_phase := r.network_at is not null and r.dispatch_wave >= v_own;

  -- Dernière vague écoulée (relance et vagues réseau comprises) : personne n'a pris la course, le dispatch est prévenu
  if r.dispatch_wave >= cardinality(v_plan) or v_stop then
    v_expired := private.close_pending_offers(r.id, 'expired', 'timeout');
    expired := cardinality(v_expired);
    if v_network_phase then
      -- Réseau partagé : le partage se clôt avec la recherche (« no_driver »)
      update public.rides
         set status = 'NO_DRIVER_FOUND', no_driver_at = now(), next_dispatch_at = null, network_at = null
       where id = r.id;
    else
      update public.rides
         set status = 'NO_DRIVER_FOUND', no_driver_at = now(), next_dispatch_at = null
       where id = r.id;
    end if;
    select string_agg(private.fmt_km(x), ' → ' order by i) into v_path
      from unnest(v_plan[1:v_n]) with ordinality as t(x, i);
    if v_own > v_n then
      v_path := v_path || ', relance ' || (select string_agg(private.fmt_km(x), ' → ' order by i)
                                             from unnest(v_plan[v_n + 1:v_own]) with ordinality as t(x, i));
    end if;
    if v_network_phase then
      select coalesce(max(x.partners_offered), 0) into v_partners
        from public.ride_network_shares x where x.ride_id = r.id;
      v_path := v_path || format(', réseau partagé : %s %s', v_partners,
        private.pl(v_partners, 'chauffeur partenaire sollicité', 'chauffeurs partenaires sollicités'));
    end if;
    perform private.log_event(r.organization_id, r.id, 'dispatch.no_driver',
      format('Personne n''a accepté la course (%s) — attribuez-la ou relancez', v_path),
      'timeline', 'error', jsonb_build_object('waves', r.dispatch_wave, 'last_radius_m', r.dispatch_radius_m,
        'closed_offers', cardinality(v_expired))
        || case when v_network_phase then jsonb_build_object('network', true, 'partners_offered', v_partners)
                else '{}'::jsonb end,
      'system', null);
    step := 'no_driver';
    return;
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

  -- (Réseau partagé : à l'ouverture, dispatch.network tient lieu de journal de transition)
  if r.dispatch_wave >= 1 and not v_opened then
    v_next := v_plan[r.dispatch_wave + 1];
    if v_network_phase then
      -- Réseau partagé : vague réseau suivante
      perform private.log_event(r.organization_id, r.id, 'dispatch.next',
        format('Personne n''a accepté — réseau partagé, rayon élargi à %s', private.fmt_km(v_next)),
        'timeline', 'info', jsonb_build_object('wave', r.dispatch_wave + 1, 'radius_m', v_next, 'relance', false,
          'network', true), 'system', null);
    elsif r.dispatch_wave = v_n then
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
  step := 'wave';
end;
$$;

-- ----------------------------------------------------------------- une vague GPS (une seule par appel)
-- Dernière définition : 20260924003200_dispatch_strict_waves.sql. Réseau partagé (partage ouvert : network_at) : plan
-- prolongé des vagues réseau (rayons du premier passage de A, traitées comme un premier passage : une seule sonnerie
-- par chauffeur) ; chauffeurs de A d'abord (mêmes candidats, private.own_geo_candidates), puis partenaires dans le reste
-- du quota (private.network_offer) ; journal : compteur des partenaires seulement, jamais leurs identifiants ; seuls
-- les chauffeurs de A passent « sollicités ». Course hors réseau : comportement inchangé.
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
  -- Réseau partagé
  v_own integer;
  v_network_phase boolean := false;
  v_partners integer := 0;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.status not in ('SEARCHING_DRIVER', 'OFFERED') or r.driver_id is not null then
    return 0;
  end if;

  select * into s from public.organization_settings where organization_id = r.organization_id;
  select coalesce(o.dispatch_model = 'centrale', false) into v_centrale from public.organizations o where o.id = r.organization_id;
  v_plan := private.dispatch_plan(s.dispatch_radii_m, s.dispatch_retry_radii_m);
  -- Réseau partagé : vagues réseau après les vagues propres
  v_own := cardinality(v_plan);
  if r.network_at is not null then
    v_plan := v_plan || private.network_radii(s.dispatch_radii_m);
  end if;
  v_n := private.dispatch_first_pass(s.dispatch_radii_m);
  v_wave := r.dispatch_wave + 1;
  -- Séquence terminée : private.dispatch_tick conclut (NO_DRIVER_FOUND)
  if v_wave > cardinality(v_plan) then
    return 0;
  end if;
  v_radius := v_plan[v_wave];
  v_network_phase := r.network_at is not null and v_wave > v_own;
  v_relance := v_wave > v_n and not v_network_phase;
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
    case when v_network_phase
         then format('Réseau partagé — rayon %s (vague %s)', private.fmt_km(v_radius), v_wave)
         when v_relance
         then format('Relance — rayon %s (vague %s)', private.fmt_km(v_radius), v_wave)
         else format('Recherche GPS — rayon %s (vague %s)', private.fmt_km(v_radius), v_wave) end,
    'timeline', 'info', jsonb_build_object('wave', v_wave, 'radius_m', v_radius, 'relance', v_relance)
      || case when v_network_phase then jsonb_build_object('network', true) else '{}'::jsonb end,
    'system', null);

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
    -- chauffeurs de l'organisation (private.own_geo_candidates : mêmes règles que les vagues propres)
    select c.driver_id, c.distance_m, c.again
    from private.own_geo_candidates(r, v_radius, v_relance) c
    order by c.distance_m
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

  -- Réseau partagé : partenaires dans le reste du quota de la vague (après les chauffeurs de A)
  if v_network_phase then
    v_partners := private.network_offer(r, 'geo', v_wave, v_radius, coalesce(s.max_offers_per_wave, 25) - v_count,
                                        now() + v_timeout);
  end if;

  select count(*) into v_pending from public.ride_offers o where o.ride_id = r.id and o.status = 'pending' and o.mode = 'geo';

  if v_network_phase then
    -- Réseau partagé : partenaires comptés, jamais nommés ni identifiés (driver_ids : chauffeurs de A seulement)
    perform private.log_event(r.organization_id, r.id, 'dispatch.candidates',
      format('%s %s à moins de %s · réseau partagé : %s %s', v_count, private.pl(v_count, 'chauffeur', 'chauffeurs'),
        private.fmt_km(v_radius), v_partners,
        private.pl(v_partners, 'chauffeur partenaire sollicité', 'chauffeurs partenaires sollicités')),
      'timeline', case when v_count + v_partners > 0 or v_pending > 0 then 'info' else 'warning' end::public.event_level,
      jsonb_build_object('candidates', v_count, 'pending', v_pending, 'radius_m', v_radius, 'wave', v_wave,
        'relance', v_relance, 'driver_ids', to_jsonb(v_drivers), 'network', true, 'network_offered', v_partners),
      'system', null);
  else
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
  end if;

  if v_count > 0 then
    update public.drivers
       set presence = 'offered'
     where id in (
       select x.id from public.drivers x
       where x.id = any (v_drivers) and x.presence = 'available'
       order by x.id
       for update
     );
  end if;

  if v_count + v_partners > 0 then
    perform private.log_event(r.organization_id, r.id, 'dispatch.notified',
      format('%s %s', v_count + v_partners, private.pl(v_count + v_partners, 'notification envoyée', 'notifications envoyées')),
      'timeline', 'success', jsonb_build_object('count', v_count + v_partners, 'expires_in_s', coalesce(s.offer_timeout_seconds, 30)), 'system', null);
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

  return v_count + v_partners;
end;
$$;

-- ----------------------------------------------------------------- planifiées : offre à toute la flotte
-- Dernière définition : 20260924002600_centrale_mode.sql. Réseau partagé : seul ajout, le prochain passage a lieu au
-- plus tard à l'ouverture de la fenêtre réseau (private.network_window_at, si elle précède T-lead) d'une course dont
-- l'organisation partage et dont la fenêtre n'est pas encore ouverte. Les offres aux partenaires sont faites par
-- private.network_fleet_step (dispatch_tick, juste avant) : elles comptent ici comme les offres de la flotte (statut
-- OFFERED, échéance recalculée à T-lead).
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
  v_pending integer := 0;
  v_first boolean;
  v_from text;
  v_to text;
  v_centrale boolean;
  -- Réseau partagé
  v_network_at timestamptz;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.status not in ('SEARCHING_DRIVER', 'OFFERED') or r.driver_id is not null then
    return 0;
  end if;

  select * into s from public.organization_settings where organization_id = r.organization_id;
  select o.timezone, coalesce(o.dispatch_model = 'centrale', false) into v_tz, v_centrale
  from public.organizations o where o.id = r.organization_id;
  v_when := to_char(r.pickup_at at time zone coalesce(v_tz, 'Europe/Paris'), 'DD/MM HH24:MI');
  v_expires := greatest(
    r.pickup_at - make_interval(mins => coalesce(s.scheduled_dispatch_lead_minutes, 60)),
    now() + make_interval(secs => coalesce(s.offer_timeout_seconds, 30))
  );
  v_from := coalesce(private.short_address(r.pickup_address), r.pickup_address);
  v_to := coalesce(private.short_address(r.dropoff_address), r.dropoff_address);
  v_first := r.dispatch_wave = 0;

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
      and (case when v_centrale then private.centrale_blocker(d.id, d.trust_level, r.price_cents,
             s.block_unpaid, s.settlement_credit_limit_cents, s.new_driver_max_price_cents) end) is null
      and not exists (
        select 1 from public.ride_offers o
        where o.ride_id = r.id and o.driver_id = d.id
          and (o.status in ('pending', 'declined') or o.closed_reason = 'removed_by_dispatch')
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
           case when v_centrale and r.driver_payout_cents is not null
                then format('%s · %s → %s · Vous gagnez %s (course %s)', v_when, v_from, v_to,
                       private.fmt_eur(r.driver_payout_cents), private.fmt_eur(r.price_cents))
                else format('%s · %s → %s · %s', v_when, v_from, v_to, private.fmt_eur(r.price_cents))
           end,
           jsonb_build_object(
             'type', 'ride_offer_scheduled', 'offer_id', i.id, 'ride_id', r.id, 'ride_type', r.type,
             'pickup', r.pickup_address, 'dropoff', r.dropoff_address, 'pickup_at', r.pickup_at,
             'price_cents', r.price_cents, 'passengers', r.passengers, 'expires_at', v_expires,
             'driver_payout_cents', r.driver_payout_cents, 'commission_cents', r.commission_cents,
             'platform_fee_cents', r.platform_fee_cents),
           'high'
    from ins i
    returning 1
  )
  select count(*)::integer into v_count from ins;

  -- échéance recalculée (délai de bascule modifié dans les réglages)
  update public.ride_offers
     set expires_at = v_expires
   where ride_id = r.id and status = 'pending' and mode = 'fleet' and expires_at is distinct from v_expires;

  select count(*) into v_pending from public.ride_offers o where o.ride_id = r.id and o.status = 'pending' and o.mode = 'fleet';

  -- Réseau partagé : réveil à l'ouverture de la fenêtre réseau (organisation qui partage, fenêtre avant T-lead)
  if r.network_at is null and private.network_wants_share(r.organization_id) then
    v_network_at := private.network_window_at(r);
    if v_network_at <= now()
       or v_network_at >= r.pickup_at - make_interval(mins => coalesce(s.scheduled_dispatch_lead_minutes, 60)) then
      v_network_at := null;
    end if;
  end if;

  update public.rides
     set status = case when v_pending > 0 then 'OFFERED' else 'SEARCHING_DRIVER' end::public.ride_status,
         offered_at = case when v_pending > 0 then coalesce(offered_at, now()) else offered_at end,
         dispatch_wave = 1,
         -- nouveau passage dans 5 min (nouveaux chauffeurs), au plus tard à T-lead (bascule GPS)
         -- (Réseau partagé : ou à l'ouverture de la fenêtre réseau ; least() ignore NULL)
         next_dispatch_at = least(v_expires, now() + interval '5 minutes', v_network_at)
   where id = r.id;

  if v_count > 0 then
    perform private.log_event(r.organization_id, r.id, 'dispatch.fleet',
      case when v_first
           then format('Course proposée à la flotte — %s %s', v_count, private.pl(v_count, 'chauffeur notifié', 'chauffeurs notifiés'))
           else format('Course proposée à %s %s de la flotte', v_count, private.pl(v_count, 'nouveau chauffeur', 'nouveaux chauffeurs'))
      end,
      'timeline', 'success', jsonb_build_object('count', v_count, 'pending', v_pending, 'open_until', v_expires), 'system', null);
    perform pg_notify('rydar_notifications', r.id::text);
  elsif v_first then
    perform private.log_event(r.organization_id, r.id, 'dispatch.fleet_empty',
      'Aucun chauffeur compatible dans la flotte pour l''instant — nouvel essai toutes les 5 min, puis recherche GPS avant la prise en charge',
      'timeline', 'warning', jsonb_build_object('open_until', v_expires), 'system', null);
  end if;

  return v_count;
end;
$$;

-- ----------------------------------------------------------------- tick : vague suivante ou fin
-- Dernière définition : 20260924003300_live_position.sql. Étape GPS extraite telle quelle dans
-- private.dispatch_geo_step. Réseau partagé (C8) : une course au réseau (partage ouvert, fin des vagues propres
-- d'une organisation qui partage, fenêtre réseau d'une planifiée) est traitée dans un bloc protégé — une erreur
-- n'arrête qu'elle (private.network_dispatch_failed) — 50 au plus par passage (les suivantes 10 s plus tard) ;
-- fenêtre réseau des planifiées (private.network_fleet_step) avant l'offre à la flotte ; à T-lead, partage de la
-- fenêtre clos (« window_elapsed ») avant la bascule GPS (vagues propres d'abord, réouverture après elles).
-- Organisation qui ne partage pas, ou interrupteur coupé : chemin et effets inchangés.
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
  v_refreshed integer := 0;
  v_failed integer := 0;
  v_expired_count integer := 0;
  -- Réseau partagé
  v_step record;
  v_lead timestamptz;
  v_network boolean;
  v_network_rides integer := 0;
  v_network_max constant integer := 50;
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
      v_lead := r.pickup_at - make_interval(mins => coalesce(s.scheduled_dispatch_lead_minutes, 60));
      -- Réseau partagé : fenêtre réseau ouverte, ou à ouvrir (2 h avant, jamais moins de 15 min après le début)
      v_network := r.network_at is not null
        or (now() < v_lead and private.network_wants_share(r.organization_id)
            and private.network_window_at(r) < v_lead and now() >= private.network_window_at(r));
      if v_network then
        if v_network_rides >= v_network_max then
          update public.rides set next_dispatch_at = now() + interval '10 seconds' where id = r.id;
          continue;
        end if;
        v_network_rides := v_network_rides + 1;
      end if;
      -- Fenêtre flotte encore ouverte : on propose aux chauffeurs devenus éligibles
      if now() < v_lead then
        if v_network then
          begin
            perform private.network_fleet_step(r.id);
          exception when others then
            perform private.network_dispatch_failed(r.id);
          end;
        end if;
        perform private.offer_to_fleet(r.id);
        v_refreshed := v_refreshed + 1;
        continue;
      end if;
      v_expired := private.close_pending_offers(r.id, 'expired', 'fleet_window_elapsed');
      -- Réseau partagé : la fenêtre réseau se referme avec celle de la flotte ; les vagues GPS repartent avec les
      -- seuls chauffeurs de l'organisation (réouverture après elles)
      if r.network_at is not null then
        begin
          perform set_config('rydar.network_reason', 'window_elapsed', true);
          update public.rides set network_at = null where id = r.id;
          perform set_config('rydar.network_reason', '', true);
        exception when others then
          perform private.network_dispatch_failed(r.id);
          continue;
        end;
      end if;
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

    -- Réseau partagé : partage ouvert, ou vagues propres terminées pour une organisation qui partage
    v_network := r.network_at is not null
      or (r.dispatch_wave >= cardinality(private.dispatch_plan(s.dispatch_radii_m, s.dispatch_retry_radii_m))
          and private.network_wants_share(r.organization_id));
    if not v_network then
      select * into v_step from private.dispatch_geo_step(r.id, false);
    elsif v_network_rides >= v_network_max then
      update public.rides set next_dispatch_at = now() + interval '10 seconds' where id = r.id;
      continue;
    else
      v_network_rides := v_network_rides + 1;
      begin
        select * into v_step from private.dispatch_geo_step(r.id, true);
      exception when others then
        perform private.network_dispatch_failed(r.id);
        continue;
      end;
    end if;
    v_expired_count := v_expired_count + coalesce(v_step.expired, 0);
    if v_step.step = 'no_driver' then
      v_failed := v_failed + 1;
    elsif v_step.step = 'wave' then
      v_waves := v_waves + 1;
    end if;
  end loop;

  return jsonb_build_object('waves', v_waves, 'escalated', v_escalated, 'fleet_refreshed', v_refreshed,
    'no_driver', v_failed, 'expired_offers', v_expired_count);
end;
$$;

-- =============================================================================
-- 7. Acceptation (§9.5) et lectures des anciennes apps
-- =============================================================================

-- Exécution d'une course de A par un chauffeur de B, à l'acceptation (preuve, termes figés : S1, C5, U2, U3) :
-- termes = ceux de l'offre acceptée, contrepartie TOUJOURS le chauffeur (décision Q2), libellé court (« Karim B. »,
-- jamais le nom de famille ni le n° interne), instantané validé de B (exploitant ; n° d'exploitant du chauffeur si B
-- est une centrale), véhicule de la course, contrôles des documents (échéances seulement, sans les pièces), versions
-- des conventions (A, B) et des conditions du chauffeur. Renvoie l'id de l'exécution.
create or replace function private.network_execution_insert(p_ride uuid, p_driver uuid, p_offer uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  r public.rides;
  d public.drivers;
  o public.ride_offers;
  b public.organizations;
  mb public.network_memberships;
  ma public.network_memberships;
  v public.vehicles;
  n public.driver_network_settings;
  v_id uuid;
begin
  select * into r from public.rides where id = p_ride;
  select * into d from public.drivers where id = p_driver;
  select * into o from public.ride_offers where id = p_offer;
  select * into b from public.organizations where id = d.organization_id;
  select * into mb from public.network_memberships where organization_id = d.organization_id;
  select * into ma from public.network_memberships where organization_id = r.organization_id;
  select * into v from public.vehicles where id = r.vehicle_id;
  select * into n from public.driver_network_settings where driver_id = d.id;

  insert into public.ride_network_executions (ride_id, organization_id, executor_org_id, executor_driver_id, offer_id,
    counterparty, driver_label, operator, vehicle, checks, terms, giver_terms_version, executor_terms_version,
    driver_terms_version)
  values (r.id, r.organization_id, d.organization_id, d.id, o.id, 'driver',
    format('%s %s.', d.first_name, left(d.last_name, 1)),
    jsonb_build_object(
      'organization_id', b.id, 'name', b.name, 'legal_name', mb.approved_legal_name, 'siret', mb.approved_siret,
      'vtc_registration', mb.approved_vtc_registration, 'phone', b.phone, 'email', b.email,
      'dispatch_model', b.dispatch_model,
      'driver_operator_registration', case when b.dispatch_model = 'centrale' then d.vtc_operator_registration end),
    jsonb_build_object('brand', v.brand, 'model', v.model, 'color', v.color, 'plate', v.plate, 'category', v.category,
      'seats', v.seats),
    jsonb_build_object(
      'vtc_card_number', d.vtc_card_number,
      'vtc_card_expires_on', (select max(x.expires_at) from public.driver_documents x
                               where x.driver_id = d.id and x.type = 'vtc_card' and x.status = 'valid'),
      'insurance_expires_on', (select max(x.expires_at) from public.driver_documents x
                                where x.driver_id = d.id and x.type = 'insurance' and x.status = 'valid'),
      'vehicle_registration_expires_on', (select max(x.expires_at) from public.driver_documents x
                                           where x.driver_id = d.id and x.type = 'vehicle_registration' and x.status = 'valid'),
      'driving_license_expires_on', (select max(x.expires_at) from public.driver_documents x
                                      where x.driver_id = d.id and x.type = 'driving_license' and x.status = 'valid'),
      'verified_at', (select max(x.reviewed_at) from public.driver_documents x
                       where x.driver_id = d.id and x.status = 'valid'
                         and x.type in ('vtc_card', 'insurance', 'vehicle_registration', 'driving_license'))),
    o.network_terms, ma.terms_version, mb.terms_version, n.accepted_version)
  returning id into v_id;
  return v_id;
end;
$$;

-- Dernière définition : 20260924005400_contre_audit_sql.sql. Réseau partagé — offre d'un partenaire (is_network),
-- sous le verrou de la course : partage du cycle courant toujours ouvert, paire éligible, véhicule, chauffeur éligible
-- (private.network_driver_reason) — sinon OFFER_CLOSED, offre fermée « network_unavailable » ; créneau pris :
-- DRIVER_BUSY_AT_TIME, offre fermée « driver_busy » ; blocage (règles locales) : DRIVER_BLOCKED, offre laissée ouverte ;
-- termes changés : OFFER_CHANGED, offre fermée « terms_changed » (reproposée) ; puis exécution figée
-- (private.network_execution_insert) et journaux de A sans identifiant ni nom de famille du partenaire. Toutes offres,
-- après le verrou du chauffeur : DRIVER_BUSY_AT_TIME si une course qui chevauche est d'une autre organisation
-- (private.driver_time_conflict, C4, dans les deux sens). Offre propre sans course partenaire : inchangée.
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
  -- Réseau partagé
  v_reason text;
  v_execution uuid;
  v_partner text;
  v_own_closed uuid[];
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
    if o.is_network then
      -- Réseau partagé : un partenaire non retenu n'apparaît jamais dans le journal de A (ni nom, ni identifiant)
      perform private.log_partner_event(r.organization_id, r.id, 'offer.rejected_late',
        format('Un chauffeur du réseau partagé a tenté d''accepter — %s',
          case v_code
            when 'RIDE_CANCELLED' then 'course annulée'
            when 'SEARCH_ENDED' then 'recherche terminée'
            else 'course déjà attribuée'
          end),
        'dispatch', 'warning',
        jsonb_build_object('offer_id', o.id, 'latency_ms', v_latency, 'code', v_code, 'network', true));
    else
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
    end if;
    return jsonb_build_object('ok', false, 'code', v_code, 'message', case v_code
      when 'RIDE_CANCELLED' then 'Course annulée.'
      when 'SEARCH_ENDED' then 'Recherche terminée : la course n''est plus proposée.'
      else 'Course déjà attribuée.'
    end);
  end if;

  -- Réseau partagé : offre fermée parce que la course a changé (G9) → « reproposée si encore disponible »
  if o.is_network and o.status = 'closed' and o.closed_reason = 'terms_changed' then
    return jsonb_build_object('ok', false, 'code', 'OFFER_CHANGED',
      'message', 'La course a été modifiée : elle vous sera reproposée si elle est encore disponible.');
  end if;
  if o.status in ('declined', 'closed', 'accepted') then
    return jsonb_build_object('ok', false, 'code', 'OFFER_CLOSED', 'message', 'Cette offre n''est plus disponible.');
  end if;
  -- Offre retirée (chauffeur passé hors ligne, relance, fin de fenêtre) ou périmée
  if o.status = 'expired' or (o.status = 'pending' and o.expires_at < now() - interval '3 seconds') then
    return jsonb_build_object('ok', false, 'code', 'OFFER_EXPIRED', 'message', 'Cette offre a expiré.');
  end if;

  if o.is_network then
    -- Réseau partagé : éligibilité relue sous verrou (partage du cycle courant, paire, véhicule, chauffeur)
    v_reason := case
      when r.network_at is null or o.sent_at < r.network_at
           or not private.network_pair_ok(r.organization_id, v_driver.organization_id)
           or v_driver.vehicle_id is null then 'network_unavailable'
      else private.network_driver_reason(v_driver, r, private.network_terms_debt(o.network_terms))
    end;
    if v_reason is not null and not private.network_is_blocker(v_reason) then
      update public.ride_offers
         set status = 'closed', closed_reason = case when v_reason = 'busy' then 'driver_busy' else 'network_unavailable' end,
             responded_at = now()
       where id = o.id and status = 'pending';
      if v_reason = 'busy' then
        return jsonb_build_object('ok', false, 'code', 'DRIVER_BUSY_AT_TIME',
          'message', 'Créneau déjà pris : une autre course de ce chauffeur chevauche celle-ci.');
      end if;
      return jsonb_build_object('ok', false, 'code', 'OFFER_CLOSED', 'message', 'Cette offre n''est plus disponible.');
    end if;
    -- Règles locales (A pour ses courses, B pour ses chauffeurs) : l'offre reste ouverte, le chauffeur peut régler
    if v_reason is not null then
      return jsonb_build_object('ok', false, 'code', 'DRIVER_BLOCKED', 'reason', v_reason,
        'message', private.network_blocker_message(v_reason,
          (select g.name from public.organizations g where g.id = r.organization_id),
          (select g.name from public.organizations g where g.id = v_driver.organization_id)));
    end if;
    -- Termes figés : ce que le partenaire a vu est ce qui sera réglé (S1)
    if private.network_terms(r) is distinct from o.network_terms then
      update public.ride_offers
         set status = 'closed', closed_reason = 'terms_changed', responded_at = now()
       where id = o.id and status = 'pending';
      return jsonb_build_object('ok', false, 'code', 'OFFER_CHANGED',
        'message', 'La course a été modifiée : elle vous sera reproposée si elle est encore disponible.');
    end if;
  else
    -- Mode centrale : commission en retard / contestée, plafond d'encours, plafond « nouveau chauffeur ».
    -- L'offre reste ouverte : le chauffeur peut régler (ou signaler son paiement) puis accepter.
    v_block := private.driver_blocker(v_driver.id, r.price_cents, true);
    if v_block is not null then
      return jsonb_build_object('ok', false, 'code', 'DRIVER_BLOCKED', 'reason', v_block,
        'message', private.blocker_message(v_block));
    end if;
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

  -- Réseau partagé : créneau pris par une course d'une autre organisation que le chauffeur (dans les deux sens, C4),
  -- relu sous le verrou du chauffeur
  if private.driver_time_conflict(v_driver.id, r.id) then
    if o.is_network then
      update public.ride_offers
         set status = 'closed', closed_reason = 'driver_busy', responded_at = now()
       where id = o.id and status = 'pending';
    end if;
    return jsonb_build_object('ok', false, 'code', 'DRIVER_BUSY_AT_TIME',
      'message', 'Créneau déjà pris : une autre course de ce chauffeur chevauche celle-ci.');
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

  if o.is_network then
    -- Réseau partagé : exécution figée, journal de A avec le seul libellé court du partenaire
    v_execution := private.network_execution_insert(r.id, v_driver.id, o.id);
    select g.name into v_partner from public.organizations g where g.id = v_driver.organization_id;
    perform private.log_partner_event(r.organization_id, r.id, 'offer.accepted',
      format('%s %s. (%s) accepte — chauffeur du réseau partagé', v_driver.first_name, left(v_driver.last_name, 1), v_partner),
      'timeline', 'success',
      jsonb_build_object('offer_id', o.id, 'response_ms', v_latency, 'network', true, 'execution_id', v_execution));
  else
    perform private.log_event(r.organization_id, r.id, 'offer.accepted', format('%s accepte', v_driver.first_name),
      'timeline', 'success',
      jsonb_build_object('driver_id', v_driver.id, 'driver_number', v_driver.number, 'offer_id', o.id,
        'distance_m', o.distance_m, 'response_ms', v_latency),
      'driver', v_driver.id);
  end if;
  perform private.log_event(r.organization_id, r.id, 'ride.locked', 'Course verrouillée',
    'timeline', 'info', jsonb_build_object('mechanism', 'row_lock+compare_and_set'), 'system', null);
  if o.is_network then
    perform private.log_event(r.organization_id, r.id, 'dispatch.assigned',
      'Assignment lock acquired — ride assigned to a shared-network partner',
      'dispatch', 'debug', jsonb_build_object('network', true, 'execution_id', v_execution), 'system', null);
  else
    perform private.log_event(r.organization_id, r.id, 'dispatch.assigned',
      format('Assignment lock acquired — ride assigned to driver #%s', v_driver.number),
      'dispatch', 'debug', jsonb_build_object('driver_id', v_driver.id), 'system', null);
  end if;

  v_closed := private.close_pending_offers(r.id, 'closed', 'assigned_to_other', o.id);
  if cardinality(v_closed) > 0 then
    -- Réseau partagé : identifiants des seuls chauffeurs de A, compteur pour les partenaires (C21)
    select coalesce(array_agg(x.id order by x.ord), '{}') into v_own_closed
      from unnest(v_closed) with ordinality as x(id, ord)
     where exists (select 1 from public.drivers d where d.id = x.id and d.organization_id = r.organization_id);
    perform private.log_event(r.organization_id, r.id, 'offers.closed',
      format('%s %s', cardinality(v_closed), private.pl(cardinality(v_closed), 'autre offre fermée', 'autres offres fermées')),
      'timeline', 'info',
      jsonb_build_object('count', cardinality(v_closed), 'driver_ids', to_jsonb(v_own_closed))
        || case when cardinality(v_own_closed) < cardinality(v_closed)
                then jsonb_build_object('network_closed', cardinality(v_closed) - cardinality(v_own_closed))
                else '{}'::jsonb end,
      'system', null);
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

-- Dernière définition : 20260924003300_live_position.sql. Réseau partagé : refus d'une offre de partenaire journalisé
-- chez A sans nom ni identifiant (« Un chauffeur du réseau partagé refuse », S3). Sinon inchangée.
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
  if o.is_network then
    perform private.log_partner_event(o.organization_id, o.ride_id, 'offer.declined',
      'Un chauffeur du réseau partagé refuse la course', 'dispatch', 'info',
      jsonb_build_object('offer_id', o.id, 'network', true));
  else
    perform private.log_event(o.organization_id, o.ride_id, 'offer.declined', format('%s refuse la course', v_driver.first_name),
      'dispatch', 'info', jsonb_build_object('driver_id', v_driver.id, 'offer_id', o.id), 'driver', v_driver.id);
  end if;

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

-- Dernière définition : 20260924005600_driver_offers_blocker.sql. Réseau partagé : seul changement, aucune offre
-- réseau (anciennes versions de l'app : elles n'affichent ni n'acceptent jamais une course partenaire ; la nouvelle
-- app lit driver_offers_v2).
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
  ) || jsonb_build_object(
    'dispatch_model', g.dispatch_model,
    'commission_cents', r.commission_cents,
    'platform_fee_cents', r.platform_fee_cents,
    'driver_payout_cents', r.driver_payout_cents,
    'driver_collects', r.payment_method in ('cash', 'card'),
    'blocked', case when g.dispatch_model = 'centrale' then private.driver_blocker(o.driver_id, r.price_cents, true) end
  ) order by r.type, o.sent_at desc), '[]'::jsonb)
  from public.ride_offers o
  join public.rides r on r.id = o.ride_id
  join public.organizations g on g.id = r.organization_id
  where o.driver_id = private.current_driver_id()
    and o.status = 'pending'
    and not o.is_network
    and r.driver_id is null
    and r.status in ('SEARCHING_DRIVER', 'OFFERED');
$$;

-- Dernière définition : 20260924000400_dispatch.sql. Réseau partagé : une offre réseau en attente ne retient pas le
-- chauffeur « sollicité » (elle ne le rend jamais « sollicité » : son organisation peut toujours le solliciter).
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
       where o.driver_id = d.id and o.status = 'pending' and o.mode = 'geo' and not o.is_network
     );
$$;

-- Dernière définition : 20260924000600_realtime.sql. Réseau partagé (S14) : offre d'un partenaire diffusée à
-- l'organisation de la course sans chauffeur, distance ni vague (« network »: true) — A ne connaît jamais les
-- partenaires sollicités ; topic du chauffeur inchangé.
create or replace function private.broadcast_offer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('rydar.bypass_ride_rules', true) = 'on' then
    return null;
  end if;
  if new.is_network then
    perform realtime.send(
      jsonb_build_object('op', lower(tg_op), 'id', new.id, 'ride_id', new.ride_id, 'driver_id', null,
        'status', new.status, 'mode', new.mode, 'wave', null, 'distance_m', null, 'expires_at', new.expires_at,
        'network', true),
      'offer.updated', 'org:' || new.organization_id::text, true);
  else
    perform realtime.send(
      jsonb_build_object('op', lower(tg_op), 'id', new.id, 'ride_id', new.ride_id, 'driver_id', new.driver_id,
        'status', new.status, 'mode', new.mode, 'wave', new.wave, 'distance_m', new.distance_m, 'expires_at', new.expires_at),
      'offer.updated', 'org:' || new.organization_id::text, true);
  end if;
  perform realtime.send(
    jsonb_build_object('op', lower(tg_op), 'id', new.id, 'ride_id', new.ride_id, 'status', new.status,
      'mode', new.mode, 'expires_at', new.expires_at),
    'offer.updated', 'driver:' || new.driver_id::text, true);
  return null;
end;
$$;

-- =============================================================================
-- 8. Attribution manuelle (§9.5 point 6, §9.7, C4, C14)
-- =============================================================================
-- Dernière définition : 20260924006600_platform_fee_schedule.sql (corps gardé À L'IDENTIQUE : version provisoire du
-- chantier CGV). Réseau partagé, ajouts seulement : DRIVER_BUSY_AT_TIME quand le chauffeur choisi tient une course
-- d'une autre organisation qui chevauche celle-ci (private.driver_time_conflict ; sans course partenaire : jamais) ;
-- network_at remis à NULL dans tous les cas (partage clos « reassigned_own », C14) ; chauffeur précédent partenaire
-- libéré, ses notifications de la course supprimées, prévenu sans adresse (« COURSE RETIRÉE — {A} »), jamais son
-- identifiant dans le journal. Toujours un chauffeur de l'organisation de la course (jamais un partenaire à la main).
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
  -- Réseau partagé
  v_previous_partner boolean;
  v_giver text;
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
  -- Réseau partagé : créneau déjà pris par une course d'une autre organisation que ce chauffeur (course partenaire
  -- qu'il a acceptée, invisible ici ; ou course partenaire attribuée pendant une course de son organisation) : C4
  if private.driver_time_conflict(d.id, r.id) then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_BUSY_AT_TIME',
      'message', 'Créneau déjà pris : une autre course de ce chauffeur chevauche celle-ci.');
  end if;

  select timezone into v_tz from public.organizations where id = r.organization_id;

  -- Course sans chauffeur : l'attribuer = la (re)mettre en service, mêmes règles que la création
  -- (private.rides_platform_block, private.enforce_plan_limits) comptée comme si elle était créée maintenant.
  if r.driver_id is null then
    if exists (select 1 from public.organizations o where o.id = r.organization_id and o.platform_block_after_days is not null)
       and private.platform_blocked(r.organization_id) then
      return jsonb_build_object('ok', false, 'code', 'PLATFORM_FEES_OVERDUE',
        'message', 'Frais plateforme en retard : réglez vos frais Rydar (menu « Frais Rydar » ou « Encaissements ») pour relancer ou attribuer une course.');
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
  -- Réseau partagé : chauffeur précédent d'une autre organisation (partenaire)
  v_previous_partner := v_previous is not null and r.driver_org_id <> r.organization_id;

  if v_previous is not null then
    update public.ride_assignments
       set is_active = false, released_at = now(), release_reason = 'reassigned'
     where ride_id = r.id and is_active;
    perform private.release_driver_ride(v_previous, r.id, true);
    if v_previous_partner then
      -- Réseau partagé : ses notifications de la course supprimées (adresses, rappels), prévenu sans adresse ; son
      -- exécution et le partage sont clos « reassigned_own » (private.ride_network_share_sync)
      select o.name into v_giver from public.organizations o where o.id = r.organization_id;
      delete from public.notifications where ride_id = r.id and driver_id = v_previous;
      perform private.queue_notification(r.organization_id, v_previous, r.id, null, 'ride_unassigned',
        'COURSE RETIRÉE — ' || v_giver,
        format('%s a confié la course du %s à l''un de ses chauffeurs : elle ne figure plus dans votre planning.', v_giver,
          to_char(r.pickup_at at time zone coalesce(v_tz, 'Europe/Paris'), 'DD/MM à HH24:MI')),
        jsonb_build_object('type', 'ride_unassigned', 'ride_id', r.id, 'network', true, 'giver', v_giver,
          'reason', 'reassigned_own'), 'high', null);
    else
      update public.notifications set status = 'cancelled'
       where ride_id = r.id and driver_id = v_previous and status = 'queued';
      perform private.queue_notification(r.organization_id, v_previous, r.id, null, 'ride_unassigned', 'COURSE RETIRÉE',
        format('La centrale a réattribué la course #%s', r.number),
        jsonb_build_object('type', 'ride_unassigned', 'ride_id', r.id), 'high', null);
    end if;
  end if;

  update public.rides
     set driver_id = d.id, vehicle_id = d.vehicle_id, status = 'ACCEPTED', accepted_at = now(), next_dispatch_at = null,
         driver_en_route_at = null, driver_arrived_at = null,
         -- Réseau partagé : partage clos dans tous les cas (C14 ; « reassigned_own »)
         network_at = null
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
    jsonb_build_object('driver_id', d.id,
      -- Réseau partagé : jamais l'identifiant d'un chauffeur partenaire dans le journal (S3)
      'previous_driver_id', case when v_previous_partner then null else v_previous end, 'previous_status', r.status,
      'closed_offers', cardinality(v_closed), 'closed_alerts', v_alerts)
      || case when v_previous_partner then jsonb_build_object('network', true) else '{}'::jsonb end,
    'user', auth.uid());

  return jsonb_build_object('ok', true, 'code', 'ASSIGNED', 'ride_id', r.id);
end;
$$;

-- =============================================================================
-- 9. Explication « pourquoi vos chauffeurs n'ont pas pris » aussi à l'ouverture du réseau (§9.2)
-- =============================================================================
-- Déclencheur : dernière définition 20260924003200_dispatch_strict_waves.sql (+ dispatch.network d'une recherche GPS ;
-- pas pour la fenêtre réseau d'une planifiée, où la flotte n'est pas sollicitée par position).
drop trigger if exists ride_events_explain_retry on public.ride_events;
create trigger ride_events_explain_retry
  after insert on public.ride_events
  for each row
  when ((new.type in ('dispatch.retry', 'dispatch.no_driver')
         or (new.type = 'dispatch.network' and (new.data ->> 'stage') is distinct from 'scheduled_window'))
        and new.ride_id is not null)
  execute function private.ride_events_explain_retry();

-- =============================================================================
-- 10. Droits : fonctions serveur seulement (RPC definer, worker, service role)
-- =============================================================================
revoke all on function
  private.network_radii(integer[]),
  private.network_max_radius(integer[]),
  private.network_wants_share(uuid),
  private.network_window_at(public.rides),
  private.address_area(text),
  private.address_city(text),
  private.network_terms(public.rides),
  private.network_terms_debt(jsonb),
  private.network_ride_reason(public.rides),
  private.driver_time_conflict(uuid, uuid),
  private.network_documents_ok(public.drivers, date),
  private.network_identity_block(uuid, uuid),
  private.network_blocker(uuid, uuid, integer),
  private.network_blocker_message(text, text, text),
  private.network_is_blocker(text),
  private.network_driver_reason(public.drivers, public.rides, integer),
  private.network_driver_reason(public.drivers, public.rides),
  private.network_candidates(public.rides, integer, boolean),
  private.own_geo_candidates(public.rides, integer, boolean),
  private.network_skip_label(text),
  private.log_partner_event(uuid, uuid, text, text, public.event_category, public.event_level, jsonb),
  private.network_offer(public.rides, public.dispatch_mode, integer, integer, integer, timestamptz),
  private.network_open(uuid, text),
  private.network_search_exhausted(public.rides),
  private.network_fleet_step(uuid),
  private.network_dispatch_failed(uuid),
  private.dispatch_geo_step(uuid, boolean),
  private.network_execution_insert(uuid, uuid, uuid)
from public, anon, authenticated;
grant execute on function
  private.network_radii(integer[]),
  private.network_max_radius(integer[]),
  private.network_wants_share(uuid),
  private.network_window_at(public.rides),
  private.address_area(text),
  private.address_city(text),
  private.network_terms(public.rides),
  private.network_terms_debt(jsonb),
  private.network_ride_reason(public.rides),
  private.driver_time_conflict(uuid, uuid),
  private.network_documents_ok(public.drivers, date),
  private.network_identity_block(uuid, uuid),
  private.network_blocker(uuid, uuid, integer),
  private.network_blocker_message(text, text, text),
  private.network_is_blocker(text),
  private.network_driver_reason(public.drivers, public.rides, integer),
  private.network_driver_reason(public.drivers, public.rides),
  private.network_candidates(public.rides, integer, boolean),
  private.own_geo_candidates(public.rides, integer, boolean),
  private.network_skip_label(text),
  private.log_partner_event(uuid, uuid, text, text, public.event_category, public.event_level, jsonb),
  private.network_offer(public.rides, public.dispatch_mode, integer, integer, integer, timestamptz),
  private.network_open(uuid, text),
  private.network_search_exhausted(public.rides),
  private.network_fleet_step(uuid),
  private.network_dispatch_failed(uuid),
  private.dispatch_geo_step(uuid, boolean),
  private.network_execution_insert(uuid, uuid, uuid)
to service_role;

-- =============================================================================
-- 11. Partie 3b — aides : argent et clôture côté A, chauffeur partenaire libéré
-- =============================================================================

-- Actions d'argent et clôture d'une course confiée (§10.5, §9.8, C12) : propriétaire ou administrateur de A, adhésion
-- active, jeton émis après l'activation (private.jwt_issued_after), organisation active, suspendue OU archivée (A
-- suspendue garde la main sur ses courses confiées et leurs règlements ; modèle private.assert_platform_payer). Le lot
-- argent la réutilise (ne pas la recréer).
create or replace function private.assert_network_creditor(p_org uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_org is null or not exists (
    select 1
      from public.organization_users ou
      join public.organizations o on o.id = ou.organization_id
     where ou.organization_id = p_org
       and ou.user_id = auth.uid()
       and ou.status = 'active'
       and private.jwt_issued_after(ou.activated_at)
       and ou.role in ('owner', 'admin')
       and o.status in ('active', 'suspended', 'archived')) then
    raise exception 'FORBIDDEN_ROLE: réservé au propriétaire ou à un administrateur de l''organisation'
      using errcode = '42501';
  end if;
end;
$$;

-- Chauffeur partenaire libéré d'une course de A (retrait, clôture) : il enchaîne sur sa course suivante
-- (private.release_driver_ride), sinon disponible ; hors ligne si sa fiche ou son organisation n'est plus active (il ne
-- peut plus travailler : « disponible » fausserait la présence vue par son organisation).
create or replace function private.network_release_driver(p_driver uuid, p_ride uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform private.release_driver_ride(p_driver, p_ride, true);
  update public.drivers d
     set presence = 'offline', current_ride_id = null
   where d.id = p_driver
     and (d.presence <> 'offline' or d.current_ride_id is not null)
     and (d.status <> 'active'
          or not exists (select 1 from public.organizations o where o.id = d.organization_id and o.status = 'active'));
end;
$$;

-- =============================================================================
-- 12. Retrait, annulation, réattribution (§9.7)
-- =============================================================================

-- Retrait d'une course de A au chauffeur partenaire qui la tient, avant la prise en charge du client (S19, C14) :
--  * removed_by_giver     : A la reprend (« Retirer » : public.reassign_ride) ;
--  * executor_released    : B la lui retire (public.ban_driver, public.set_driver_status, retrait du réseau) ;
--  * executor_unavailable : chauffeur ou B devenus indisponibles (private.network_watch).
-- N'agit que si p_driver tient la course (ACCEPTED, DRIVER_EN_ROUTE, DRIVER_ARRIVED) : sinon RIDE_NOT_REASSIGNABLE.
-- Attribution close ; marqueur « retiré » (removed_by_dispatch, termes de l'exécution : G4, C1) — il n'est plus sollicité
-- pour cette course ; chauffeur libéré ; ses notifications de cette course supprimées (adresses, rappels en file) sauf
-- « COURSE RETIRÉE — {A} », sans adresse ; course remise en recherche chez A, ses chauffeurs d'abord (dispatch_wave 0,
-- network_at NULL : le partage ne rouvre qu'après leurs vagues), lancée par private.dispatch_tick au prochain passage
-- (public.reassign_ride la lance tout de suite) ; sans dispatch automatique : en attente d'attribution. Exécution et
-- partage clos par private.ride_network_share_sync, motif p_reason (réglage local rydar.network_reason) ; verrou G6 levé.
-- Retraits répétés (S6) : 3 exécutions closes « executor_released » / « executor_unavailable » en 30 jours → chauffeur
-- exclu du réseau 30 jours (driver_network_settings.excluded_until, offres réseau fermées, audit
-- network.driver_auto_excluded pour le super admin). Journal de A (« ride.network_unassigned ») : libellé court du
-- partenaire, jamais son identifiant ; acteur : le membre de A pour removed_by_giver, le système sinon (une action de B
-- n'apparaît jamais sous l'identifiant d'un membre de B). Appelée par des fonctions definer.
create or replace function private.unassign_network_ride(p_driver uuid, p_ride uuid, p_reason text,
                                                         p_note text default null)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r public.rides;
  e public.ride_network_executions;
  s public.organization_settings;
  v_by_giver boolean := p_reason = 'removed_by_giver';
  v_note text := left(nullif(btrim(coalesce(p_note, '')), ''), 300);
  v_giver text;
  v_tz text;
  v_partner text;
  v_label text;
  v_terms jsonb;
  v_type public.ride_type;
  v_auto boolean;
  v_closed uuid[];
  v_alerts integer;
  v_when text;
  v_releases integer := 0;
  v_until timestamptz;
  v_excluded boolean;
begin
  if p_reason is null or p_reason not in ('removed_by_giver', 'executor_released', 'executor_unavailable') then
    raise exception 'unassign_network_ride : motif inconnu (%)', p_reason using errcode = '22023';
  end if;
  select * into r from public.rides where id = p_ride for update;
  if not found or r.driver_id is null or r.driver_id is distinct from p_driver
     or r.driver_org_id = r.organization_id
     or r.status not in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED') then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_REASSIGNABLE',
      'message', 'Seule une course attribuée et pas encore commencée peut être retirée au chauffeur.');
  end if;

  select * into e from public.ride_network_executions x where x.ride_id = r.id and x.ended_at is null;
  v_terms := coalesce(e.terms, (
    select o.network_terms from public.ride_offers o
     where o.ride_id = r.id and o.driver_id = p_driver and o.status = 'accepted' and o.is_network
     order by o.sent_at desc limit 1));
  select o.name, o.timezone into v_giver, v_tz from public.organizations o where o.id = r.organization_id;
  v_partner := coalesce(e.operator ->> 'name', (select o.name from public.organizations o where o.id = r.driver_org_id),
                        'organisation partenaire');
  v_label := coalesce(e.driver_label, 'chauffeur');
  select * into s from public.organization_settings x where x.organization_id = r.organization_id;
  v_auto := coalesce(s.auto_dispatch, true);
  v_type := case
    when greatest(r.pickup_at, now()) <= now() + make_interval(mins => coalesce(s.instant_threshold_minutes, 45)) then 'instant'
    else 'scheduled'
  end::public.ride_type;
  v_when := to_char(r.pickup_at at time zone coalesce(v_tz, 'Europe/Paris'), 'DD/MM à HH24:MI');

  -- 1. attribution close, restes d'offres fermés, marqueur « retiré » (avant le retrait : G4)
  update public.ride_assignments
     set is_active = false, released_at = now(), release_reason = p_reason
   where ride_id = r.id and is_active;
  v_closed := private.close_pending_offers(r.id, 'closed', 'reassigned_by_dispatch');
  if v_terms is not null then
    insert into public.ride_offers (organization_id, ride_id, driver_id, status, mode, wave, sent_at, expires_at,
                                    responded_at, closed_reason, network_terms)
    values (r.organization_id, r.id, p_driver, 'closed', 'geo', 0, now(), now(), now(), 'removed_by_dispatch', v_terms);
  end if;

  -- 2. chauffeur libéré ; ses notifications de cette course (adresses, rappels en file) supprimées
  perform private.network_release_driver(p_driver, r.id);
  delete from public.notifications n where n.ride_id = r.id and n.driver_id = p_driver;

  -- 3. course remise en recherche chez A : exécution et partage clos (motif p_reason), vagues propres d'abord
  perform set_config('rydar.network_reason', p_reason, true);
  update public.rides
     set status = case when v_auto then 'SEARCHING_DRIVER' else 'CREATED' end::public.ride_status,
         driver_id = null,
         vehicle_id = null,
         network_at = null,
         type = v_type,
         dispatch_mode = case when v_type = 'instant' then 'geo' else 'fleet' end::public.dispatch_mode,
         dispatch_wave = 0,
         dispatch_radius_m = null,
         dispatch_started_at = case when v_auto then now() end,
         next_dispatch_at = case when v_auto then now() end,
         accepted_at = null,
         driver_en_route_at = null,
         driver_arrived_at = null,
         no_driver_at = null
   where id = r.id;
  perform set_config('rydar.network_reason', '', true);
  -- Heure de prise en charge passée (instantanée) : maintenant, comme public.reassign_ride (après la clôture de
  -- l'exécution : le verrou G6 ne s'applique plus)
  update public.rides set pickup_at = now() where id = r.id and pickup_at < now();

  -- 4. alertes de la course : traitées
  v_alerts := private.close_ride_alerts(r.id, case when v_by_giver then 'relaunched' else 'auto_resolved' end,
                                        case when v_by_giver then auth.uid() end);

  -- 5. chauffeur prévenu, sans adresse (S7)
  perform private.queue_notification(r.organization_id, p_driver, r.id, null, 'ride_unassigned',
    'COURSE RETIRÉE — ' || coalesce(v_giver, 'organisation partenaire'),
    case p_reason
      when 'removed_by_giver' then
        format('%s a repris la course du %s : elle ne figure plus dans votre planning.', v_giver, v_when)
      when 'executor_released' then
        format('%s vous a retiré la course de %s du %s.', v_partner, v_giver, v_when)
      else
        format('Course de %s du %s retirée : vous n''êtes plus disponible pour le réseau partagé.', v_giver, v_when)
    end,
    jsonb_build_object('type', 'ride_unassigned', 'ride_id', r.id, 'network', true, 'giver', v_giver,
      'reason', p_reason),
    'high', null);

  -- 6. journal de A (S3) : libellé court du partenaire, jamais son identifiant
  perform private.log_event(r.organization_id, r.id, 'ride.network_unassigned',
    case p_reason
      when 'removed_by_giver' then
        format('Course retirée au chauffeur partenaire %s (%s)%s', v_label, v_partner, coalesce(' : ' || v_note, ''))
      when 'executor_released' then
        format('%s a retiré la course à son chauffeur (%s)', v_partner, v_label)
      else
        format('Chauffeur partenaire indisponible (%s, %s)', v_label, v_partner)
    end || ' — ' || case when v_auto then 'recherche relancée, vos chauffeurs d''abord' else 'à attribuer manuellement' end,
    'timeline', 'warning',
    jsonb_build_object('network', true, 'reason', p_reason, 'execution_id', e.id, 'previous_status', r.status,
      'type', v_type, 'auto', v_auto, 'closed_alerts', v_alerts, 'closed_offers', cardinality(v_closed))
      || case when v_note is not null then jsonb_build_object('note', v_note) else '{}'::jsonb end,
    case when v_by_giver then 'user' else 'system' end::public.actor_type,
    case when v_by_giver then auth.uid() end);

  -- 7. retraits répétés (S6) : 3 en 30 jours → exclu du réseau 30 jours (NETWORK_PARAMS de @rydar/shared)
  if not v_by_giver then
    select count(*)::integer into v_releases
      from public.ride_network_executions x
     where x.executor_driver_id = p_driver
       and x.end_reason in ('executor_released', 'executor_unavailable')
       and x.ended_at > now() - interval '30 days';
    if v_releases >= 3 then
      v_until := now() + interval '30 days';
      insert into public.driver_network_settings as n (driver_id, organization_id, excluded_until)
      select d.id, d.organization_id, v_until from public.drivers d where d.id = p_driver
      on conflict (driver_id) do update
        set excluded_until = excluded.excluded_until
        where n.excluded_until is null or n.excluded_until <= now()
      returning true into v_excluded;
      if coalesce(v_excluded, false) then
        perform private.close_network_offers(null, null, p_driver, 'network_unavailable');
        insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id,
                                       severity, metadata)
        values (r.driver_org_id, 'system', null, 'network.driver_auto_excluded', 'drivers', p_driver::text, 'warning',
                jsonb_build_object('releases_30d', v_releases, 'excluded_until', v_until));
      end if;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'code', 'RELEASED', 'ride_id', r.id, 'type', v_type,
    'status', case when v_auto then 'SEARCHING_DRIVER' else 'CREATED' end, 'auto', v_auto,
    'closed_alerts', v_alerts, 'auto_excluded', coalesce(v_excluded, false));
end;
$$;

-- « Retirer » (fiche course, alerte « Relancer »)
-- Dernière définition : 20260924004500_audit_dispatch.sql. Réseau partagé : seul ajout, course tenue par un chauffeur
-- partenaire → private.unassign_network_ride (« removed_by_giver ») puis nouvelle recherche lancée tout de suite (même
-- réponse, sans l'identifiant du partenaire). Course propre : inchangée.
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
  -- Réseau partagé
  v_res jsonb;
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

  -- Réseau partagé : course tenue par un chauffeur partenaire → retirée par private.unassign_network_ride
  -- (« removed_by_giver » : marqueur, chauffeur libéré et prévenu sans adresse, exécution close, verrou G6 levé), puis
  -- nouvelle recherche lancée tout de suite comme pour une course propre (chauffeurs de A d'abord, partage rouvert
  -- après leurs vagues). Réponse de même forme, sans l'identifiant du partenaire.
  if r.driver_org_id <> r.organization_id then
    v_res := private.unassign_network_ride(r.driver_id, r.id, 'removed_by_giver', v_reason);
    if not coalesce((v_res ->> 'ok')::boolean, false) then
      return v_res;
    end if;
    v_type := (v_res ->> 'type')::public.ride_type;
    v_alerts := (v_res ->> 'closed_alerts')::integer;
    if not coalesce((v_res ->> 'auto')::boolean, true) then
      return jsonb_build_object('ok', true, 'code', 'UNASSIGNED', 'message', 'Course retirée au chauffeur — à attribuer manuellement.',
        'ride_id', r.id, 'previous_driver_id', null, 'type', v_type, 'status', 'CREATED',
        'notified', 0, 'closed_alerts', v_alerts, 'network', true);
    end if;
    if v_type = 'instant' then
      v_count := private.run_geo_wave(r.id);
    else
      v_count := private.offer_to_fleet(r.id);
    end if;
    select status into v_status from public.rides where id = r.id;
    return jsonb_build_object('ok', true, 'code', 'RELAUNCHED', 'message', 'Course retirée au chauffeur — nouvelle recherche lancée.',
      'ride_id', r.id, 'previous_driver_id', null, 'type', v_type, 'status', v_status,
      'notified', coalesce(v_count, 0), 'closed_alerts', v_alerts, 'network', true);
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

-- « Relancer » une course sans chauffeur
-- Dernière définition : 20260924006600_platform_fee_schedule.sql (corps gardé À L'IDENTIQUE : version provisoire du
-- chantier CGV). Réseau partagé : seul ajout, relance pendant le partage → network_at remis à NULL (partage clos
-- « redispatch ») avant la remise en recherche ; course hors réseau : aucune écriture de plus.
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
      'message', 'Frais plateforme en retard : réglez vos frais Rydar (menu « Frais Rydar » ou « Encaissements ») pour relancer ou attribuer une course.');
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
  -- Réseau partagé : relance pendant le partage → partage clos (« redispatch »), la recherche repart avec les chauffeurs
  -- de l'organisation (réouverture après leurs vagues) ; course hors réseau : aucune écriture de plus
  if r.network_at is not null then
    perform set_config('rydar.network_reason', 'redispatch', true);
    update public.rides set network_at = null where id = r.id;
    perform set_config('rydar.network_reason', '', true);
  end if;
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

-- Suivi de vol
-- Dernière définition : 20260924006600_platform_fee_schedule.sql (corps gardé À L'IDENTIQUE : version provisoire du
-- chantier CGV). Réseau partagé, deux ajouts : (1) course tenue par un chauffeur partenaire : réglage local
-- rydar.network_flight_update pendant l'écriture (G6 laisse alors passer la seule heure de prise en charge, le
-- partenaire est prévenu par la notification de vol habituelle) ; (2) vol retardé d'une course au réseau sans chauffeur
-- et rendue à la flotte (C13) : offres partenaires fermées « flight_rescheduled », partage clos, prochain passage au
-- plus tard à la nouvelle ouverture de la fenêtre réseau. Course hors réseau : inchangé.
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
  -- Réseau partagé
  v_net_row public.rides;
  v_net_window timestamptz;
  v_net_reset boolean := false;
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

  -- Réseau partagé (C13) : course proposée au réseau, sans chauffeur, prise en charge repoussée et rendue à la flotte de
  -- l'organisation — planifiée dont la fenêtre réseau recalculée (private.network_window_at) n'est pas encore ouverte,
  -- instantanée repassée en planifiée, planifiée en recherche GPS repoussée avant la bascule : offres partenaires
  -- fermées (« flight_rescheduled »), partage clos, prochain passage au plus tard à la nouvelle ouverture de la fenêtre.
  -- Fenêtre toujours ouverte ou vagues réseau : offres fermées « terms_changed » et reproposées (G9).
  if v_shift and r.network_at is not null and r.driver_id is null and r.status in ('SEARCHING_DRIVER', 'OFFERED') then
    v_net_row := r;
    v_net_row.pickup_at := v_target;
    v_net_window := private.network_window_at(v_net_row);
    v_net_reset := (r.dispatch_mode = 'fleet' and v_net_window > now())
      or (r.type = 'instant' and v_target > now() + make_interval(mins => coalesce(s.instant_threshold_minutes, 45)))
      or (r.type = 'scheduled' and r.dispatch_mode = 'geo' and v_target - v_lead > now());
    if v_net_reset then
      perform private.close_network_offers(r.organization_id, null, null, 'flight_rescheduled', r.id);
      perform set_config('rydar.network_reason', 'flight_rescheduled', true);
      update public.rides set network_at = null where id = r.id;
      perform set_config('rydar.network_reason', '', true);
    else
      v_net_window := null;
    end if;
  end if;
  -- Réseau partagé : course tenue par un chauffeur partenaire (verrou G6) — seule l'heure suit le vol
  if r.driver_id is not null and r.driver_org_id <> r.organization_id then
    perform set_config('rydar.network_flight_update', 'on', true);
  end if;

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
         -- (Réseau partagé : au plus tard à la nouvelle ouverture de la fenêtre réseau, partage clos ci-dessus)
         next_dispatch_at = case when v_fleet then least(v_target - v_lead, now() + interval '5 minutes', v_net_window) else next_dispatch_at end
   where id = r.id;
  perform set_config('rydar.network_flight_update', '', true);

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
          when 'PLATFORM_FEES_OVERDUE' then 'frais plateforme en retard (réglez vos frais Rydar, menu « Frais Rydar » ou « Encaissements », puis relancez-la)'
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

-- Bannissement par l'organisation du chauffeur
-- Dernière définition : 20260924004600_audit_bannissement.sql. Réseau partagé : seul changement, une course d'une
-- autre organisation tenue par ce chauffeur (pas encore commencée) lui est retirée par private.unassign_network_ride
-- (« executor_released ») au lieu de public.reassign_ride (FORBIDDEN : elle n'est pas à son organisation) ; client à
-- bord : refus DRIVER_ON_RIDE inchangé (le chauffeur termine), message sans « annulez-la » pour une course partenaire.
create or replace function public.ban_driver(
  p_driver_id uuid,
  p_reason text,
  p_category text default 'fraud',
  p_report_to_platform boolean default false,
  p_ban_vehicle boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
  v_category text := coalesce(nullif(p_category, ''), 'fraud');
  v_ride record;
  v_other record;
  v_res jsonb;
  v_reassigned integer := 0;
  v_flagged integer := 0;
  v_count integer;
  v_report uuid;
begin
  select * into d from public.drivers where id = p_driver_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_FOUND', 'message', 'Chauffeur introuvable.');
  end if;
  perform private.assert_org_member(d.organization_id, array['owner', 'admin']::public.org_role[]);
  perform private.set_actor('user', auth.uid());

  if v_reason is null or char_length(v_reason) < 3 then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'message', 'Indiquez le motif du bannissement.');
  end if;
  if v_category not in ('unpaid', 'fraud', 'behavior', 'documents', 'other') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CATEGORY', 'message', 'Motif invalide.');
  end if;
  if d.banned_at is not null then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_BANNED', 'message', 'Ce chauffeur est déjà banni.');
  end if;
  if exists (select 1 from public.rides r where r.driver_id = d.id and r.status in ('PASSENGER_ONBOARD', 'IN_PROGRESS')) then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_ON_RIDE',
      'message', case
        -- Réseau partagé : course d'une autre organisation, que la sienne ne peut pas annuler
        when exists (select 1 from public.rides r where r.driver_id = d.id and r.status in ('PASSENGER_ONBOARD', 'IN_PROGRESS')
                       and r.organization_id <> d.organization_id)
          then 'Client à bord d''une course partenaire : attendez la fin de la course avant de bannir ce chauffeur.'
        else 'Client à bord : attendez la fin de la course (ou annulez-la) avant de bannir ce chauffeur.' end);
  end if;

  -- Courses attribuées pas encore commencées : remises en recherche
  for v_ride in
    select r.id, r.organization_id from public.rides r
    where r.driver_id = d.id and r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED')
    order by r.pickup_at
  loop
    -- Réseau partagé : course d'une autre organisation (confiée à ce chauffeur) rendue à son organisation, qui la
    -- relance (private.unassign_network_ride, « executor_released » ; public.reassign_ride lèverait FORBIDDEN)
    if v_ride.organization_id <> d.organization_id then
      v_res := private.unassign_network_ride(d.id, v_ride.id, 'executor_released');
    else
      v_res := public.reassign_ride(v_ride.id, 'Chauffeur banni', d.id);
    end if;
    if coalesce((v_res ->> 'ok')::boolean, false) then
      v_reassigned := v_reassigned + 1;
    end if;
  end loop;

  update public.ride_offers
     set status = 'closed', closed_reason = 'driver_banned', responded_at = now()
   where driver_id = d.id and status = 'pending';

  -- Identités refusées désormais dans cette centrale
  insert into public.banned_identities (scope, organization_id, kind, value_hash, hint, driver_id, reason, created_by)
  select 'org', d.organization_id, i.kind, i.value_hash, i.hint, d.id, v_reason, auth.uid()
  from private.driver_identities(d.id, p_ban_vehicle) i
  on conflict do nothing;
  get diagnostics v_count = row_count;

  -- Signalement au super admin (bannissement de toute la plateforme sur décision). Pour chaque identité : date
  -- de la dernière saisie de CETTE valeur par un membre de la centrale (journal de la fiche, du véhicule, des
  -- numéros de pièce ; justificatif déposé depuis le tableau de bord) — une identité recopiée depuis la fiche
  -- d'un chauffeur d'une autre centrale juste avant le signalement se voit.
  if coalesce(p_report_to_platform, false) then
    insert into public.fraud_reports (organization_id, driver_id, driver_label, category, reason, identities, reported_by)
    values (d.organization_id, d.id, format('%s %s (#%s)', d.first_name, d.last_name, d.number), v_category, v_reason,
      (select coalesce(jsonb_agg(jsonb_build_object('kind', i.kind, 'hash', i.value_hash, 'hint', i.hint)
                || case when e.at is null then '{}'::jsonb else jsonb_build_object('edited_by_org_at', e.at) end), '[]'::jsonb)
       from private.driver_identities(d.id, p_ban_vehicle) i
       left join lateral (
         select max(t.at) as at
         from (
           select a.created_at as at
           from public.audit_logs a
           where i.kind in ('phone', 'email', 'vtc_card')
             and a.entity_type = 'drivers' and a.entity_id = d.id::text
             and a.action in ('drivers.insert', 'drivers.update')
             and a.actor_user_id is not null
             and private.identity_hash(i.kind, case a.action
                   when 'drivers.insert' then a.metadata -> 'new' ->> (case i.kind when 'vtc_card' then 'vtc_card_number' else i.kind end)
                   else a.metadata -> 'changes' -> (case i.kind when 'vtc_card' then 'vtc_card_number' else i.kind end) ->> 'to'
                 end) = i.value_hash
             and exists (select 1 from public.organization_users m
                         where m.organization_id = d.organization_id and m.user_id = a.actor_user_id)
           union all
           select a.created_at
           from public.audit_logs a
           where i.kind = 'plate' and d.vehicle_id is not null
             and a.entity_type = 'vehicles' and a.entity_id = d.vehicle_id::text
             and a.action in ('vehicles.insert', 'vehicles.update')
             and a.actor_user_id is not null
             and private.identity_hash('plate', case a.action
                   when 'vehicles.insert' then a.metadata -> 'new' ->> 'plate'
                   else a.metadata -> 'changes' -> 'plate' ->> 'to'
                 end) = i.value_hash
             and exists (select 1 from public.organization_users m
                         where m.organization_id = d.organization_id and m.user_id = a.actor_user_id)
           union all
           select a.created_at
           from public.audit_logs a
           where a.entity_type = 'drivers' and a.entity_id = d.id::text
             and a.action = 'driver_documents.number_set'
             and a.metadata ->> 'kind' = i.kind and a.metadata ->> 'hash' = i.value_hash
             and a.actor_user_id is not null
             and exists (select 1 from public.organization_users m
                         where m.organization_id = d.organization_id and m.user_id = a.actor_user_id)
           union all
           -- Justificatifs antérieurs au journal des numéros : déposés depuis le tableau de bord
           select x.created_at
           from public.driver_documents x
           where x.driver_id = d.id and x.source = 'dashboard'
             and i.kind = case x.type when 'identity' then 'identity_doc' else x.type::text end
             and private.identity_hash(i.kind, x.number) = i.value_hash
             and not exists (select 1 from public.audit_logs a
                             where a.entity_type = 'drivers' and a.entity_id = d.id::text
                               and a.action = 'driver_documents.number_set'
                               and a.metadata ->> 'document_id' = x.id::text)
         ) t
       ) e on true),
      auth.uid())
    returning id into v_report;
  end if;

  -- Compte coupé (sessions révoquées par drivers_revoke_sessions) ; « inactif » conservé pour un
  -- candidat (ne consomme pas de place dans l'offre)
  update public.drivers
     set status = case when status = 'inactive' then 'inactive' else 'suspended' end::public.driver_status,
         presence = 'offline',
         online_since = null,
         current_ride_id = null,
         banned_at = now(),
         banned_by = auth.uid(),
         ban_reason = v_reason,
         ban_scope = 'org',
         suspended_reason = 'Banni : ' || v_reason,
         application_status = case when application_status = 'pending' then 'rejected' else application_status end
   where id = d.id;

  -- Autres fiches de la centrale déjà enregistrées sur un appareil du banni (révoqué ou non) : même traitement
  -- qu'un nouveau compte sur cet appareil (suspendue « vérification requise », candidature refusée, alerte)
  for v_other in
    select distinct on (o.id) o.id, dv2.id as device_id, dv2.platform, dv2.device_name
    from public.driver_devices dv
    join public.driver_devices dv2
      on dv2.organization_id = d.organization_id
     and dv2.driver_id <> d.id
     and private.identity_hash('device', dv2.installation_id) = private.identity_hash('device', dv.installation_id)
    join public.drivers o on o.id = dv2.driver_id
    where dv.driver_id = d.id
      and o.banned_at is null
      and o.deleted_at is null
    order by o.id, dv2.last_seen_at desc
  loop
    if private.flag_driver_banned_match(v_other.id, 'device', 'org',
         jsonb_build_object('device_id', v_other.device_id, 'platform', v_other.platform, 'device_name', v_other.device_name,
           'banned_driver_id', d.id)) then
      v_flagged := v_flagged + 1;
    end if;
  end loop;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (d.organization_id, 'user', auth.uid(), 'driver.banned', 'drivers', d.id::text, 'critical',
    jsonb_build_object('reason', v_reason, 'category', v_category, 'identities', v_count,
      'reassigned_rides', v_reassigned, 'report_id', v_report, 'vehicle', coalesce(p_ban_vehicle, false),
      'flagged_drivers', v_flagged));

  return jsonb_build_object('ok', true, 'code', 'BANNED',
    'message', 'Chauffeur banni : ses identifiants connus (téléphone, e-mail, carte VTC, appareils) sont refusés à toute nouvelle inscription dans votre centrale.'
      || case when v_flagged = 1 then ' Une autre fiche de votre centrale utilise le même appareil : bloquée en attendant votre vérification.'
              when v_flagged > 1 then format(' %s autres fiches de votre centrale utilisent le même appareil : bloquées en attendant votre vérification.', v_flagged)
              else '' end,
    'identities', v_count, 'reassigned_rides', v_reassigned, 'report_id', v_report, 'user_id', d.user_id,
    'flagged_drivers', v_flagged);
end;
$$;

-- Statut d'un chauffeur (owner / admin)
-- Dernière définition : 20260924004700_audit_comptes.sql. Réseau partagé : même changement que public.ban_driver.
create or replace function public.set_driver_status(p_driver_id uuid, p_status public.driver_status, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
  v_ride record;
  v_res jsonb;
  v_reassigned integer := 0;
begin
  select * into d from public.drivers where id = p_driver_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_FOUND', 'message', 'Chauffeur introuvable.');
  end if;
  perform private.assert_org_member(d.organization_id, array['owner', 'admin']::public.org_role[]);
  perform private.set_actor('user', auth.uid());
  if p_status is null or p_status not in ('active', 'inactive', 'suspended') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_STATUS', 'message', 'Statut invalide.');
  end if;

  if p_status <> 'active' then
    if exists (select 1 from public.rides r where r.driver_id = d.id and r.status in ('PASSENGER_ONBOARD', 'IN_PROGRESS')) then
      return jsonb_build_object('ok', false, 'code', 'DRIVER_ON_RIDE',
        'message', format(case
            -- Réseau partagé : course d'une autre organisation, que la sienne ne peut pas annuler
            when exists (select 1 from public.rides r where r.driver_id = d.id and r.status in ('PASSENGER_ONBOARD', 'IN_PROGRESS')
                           and r.organization_id <> d.organization_id)
              then 'Client à bord d''une course partenaire : attendez la fin de la course avant de %s ce chauffeur.'
            else 'Client à bord : attendez la fin de la course (ou annulez-la) avant de %s ce chauffeur.' end,
          case when p_status = 'suspended' then 'suspendre' else 'désactiver' end));
    end if;
    for v_ride in
      select r.id, r.organization_id from public.rides r
      where r.driver_id = d.id and r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED')
      order by r.pickup_at
    loop
      -- Réseau partagé : course d'une autre organisation (confiée à ce chauffeur) rendue à son organisation, qui la
      -- relance (private.unassign_network_ride, « executor_released » ; public.reassign_ride lèverait FORBIDDEN)
      if v_ride.organization_id <> d.organization_id then
        v_res := private.unassign_network_ride(d.id, v_ride.id, 'executor_released');
      else
        v_res := public.reassign_ride(v_ride.id, case when p_status = 'suspended' then 'Chauffeur suspendu' else 'Chauffeur désactivé' end, d.id);
      end if;
      if coalesce((v_res ->> 'ok')::boolean, false) then
        v_reassigned := v_reassigned + 1;
      end if;
    end loop;
    update public.ride_offers
       set status = 'closed', closed_reason = 'driver_inactive', responded_at = now()
     where driver_id = d.id and status = 'pending';
  end if;

  update public.drivers
     set status = p_status,
         suspended_reason = case when p_status = 'suspended' then v_reason end,
         presence = case when p_status = 'active' then presence else 'offline' end,
         online_since = case when p_status = 'active' then online_since end,
         current_ride_id = case when p_status = 'active' then current_ride_id end
   where id = d.id;

  return jsonb_build_object('ok', true, 'code', 'STATUS_CHANGED', 'status', p_status, 'user_id', d.user_id,
    'reassigned_rides', v_reassigned,
    'message', case
      when p_status = 'active' then 'Chauffeur activé.'
      when v_reassigned > 0 then format('%s : %s course(s) attribuée(s) remise(s) en recherche.',
        case when p_status = 'suspended' then 'Chauffeur suspendu' else 'Chauffeur désactivé' end, v_reassigned)
      when p_status = 'suspended' then 'Chauffeur suspendu.'
      else 'Chauffeur désactivé.'
    end);
end;
$$;

-- Suppression de compte d'un chauffeur (application, super admin)
-- Dernière définition : 20260924004800_audit_rgpd.sql. Réseau partagé, seul changement : une course d'une autre
-- organisation tenue par ce chauffeur refuse toujours la suppression (RIDES_ASSIGNED, message « demandez à
-- l'organisation qui vous a confié la course de la retirer ») — jamais libérée par ce chemin (« organisation du
-- chauffeur inactive ») : elle l'est par A (« Retirer ») ou par le chien de garde du réseau. Course propre : inchangé.
-- (Le lot administration redéfinit cette fonction — effacement des traces réseau : partir de celle-ci.)
create or replace function private.delete_driver_account(p_driver_id uuid, p_source text, p_actor uuid default null)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  d public.drivers;
  q private.account_deletions;
  r public.rides;
  v_rides integer;
  v_release integer;
  -- Réseau partagé
  v_partner_rides integer;
  v_released integer := 0;
  v_org_active boolean;
  v_owed_cents bigint := 0;
  v_owed_count integer := 0;
  v_debtor_ids integer := 0;
  v_alias text;
  v_key text;
  v_keep boolean;
  v_files integer;
  v_vehicle uuid;
  v_vehicle_action text;
  v_admin boolean := p_source = 'admin';
begin
  if p_source is null or p_source not in ('app', 'admin') then
    raise exception 'INVALID_SOURCE' using errcode = '22023';
  end if;
  select * into d from public.drivers where id = p_driver_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_DRIVER', 'message', 'Aucun compte chauffeur associé.');
  end if;

  -- Déjà supprimé (appel rejoué) : état de la file
  if d.deleted_at is not null then
    select * into q from private.account_deletions where driver_id = d.id;
    if q.id is not null then
      return jsonb_build_object('ok', true, 'code', 'DELETED', 'already_deleted', true) || private.account_deletion_json(q);
    end if;
    return jsonb_build_object('ok', true, 'code', 'DELETED', 'already_deleted', true,
      'driver_id', d.id, 'organization_id', d.organization_id, 'number', d.number,
      'storage_prefix', format('%s/%s/', d.organization_id, d.id), 'keep_auth', false,
      'deletion_id', null, 'done', true, 'pending', false);
  end if;

  -- Courses attribuées. Centrale suspendue ou archivée : les courses acceptées non commencées seront libérées ;
  -- les autres (commencées, ou toute course d'une centrale active) bloquent la suppression.
  select coalesce(o.status = 'active', false) into v_org_active from public.organizations o where o.id = d.organization_id;
  v_org_active := coalesce(v_org_active, false);
  -- Réseau partagé : une course d'une autre organisation (confiée à ce chauffeur) n'est jamais libérée ici (elle l'est
  -- par l'organisation qui l'a confiée, ou par le chien de garde du réseau) : elle refuse toujours la suppression
  select count(*),
         count(*) filter (where r0.status = 'ACCEPTED' and not v_org_active and r0.organization_id = d.organization_id),
         count(*) filter (where r0.organization_id <> d.organization_id)
    into v_rides, v_release, v_partner_rides
    from public.rides r0
   where r0.driver_id = d.id
     and r0.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS');
  v_rides := v_rides - v_release;
  if v_rides > 0
     or (d.current_ride_id is not null and not exists (
           select 1 from public.rides x
            where x.id = d.current_ride_id and x.driver_id = d.id and x.status = 'ACCEPTED' and not v_org_active
              and x.organization_id = d.organization_id)) then
    return jsonb_build_object('ok', false, 'code', 'RIDES_ASSIGNED', 'count', greatest(v_rides, 1),
      'message', case
        -- Réseau partagé : c'est l'organisation qui a confié la course qui la retire
        when v_partner_rides > 0 and v_admin
        then 'Course d''une organisation partenaire attribuée à ce chauffeur : elle doit d''abord être terminée, ou retirée par l''organisation qui l''a confiée.'
        when v_partner_rides > 0
        then 'Vous avez une course confiée par une autre organisation : terminez-la ou demandez à l''organisation qui vous a confié la course de la retirer, puis supprimez votre compte.'
        when v_admin and v_rides > 1
        then format('%s courses attribuées à ce chauffeur : la centrale doit d''abord les terminer ou les réattribuer.', v_rides)
        when v_admin then 'Une course attribuée à ce chauffeur : la centrale doit d''abord la terminer ou la réattribuer.'
        when v_rides > 1
        then format('Vous avez %s courses attribuées : terminez-les ou demandez à votre centrale de les réattribuer, puis supprimez votre compte.', v_rides)
        else 'Vous avez une course attribuée : terminez-la ou demandez à votre centrale de la réattribuer, puis supprimez votre compte.' end);
  end if;

  if v_admin then
    perform private.set_actor('super_admin', p_actor);
  else
    perform private.set_actor('driver', d.id);
  end if;
  v_key := 'driver:' || d.id::text;
  v_alias := format('Chauffeur supprimé (#%s)', d.number);
  -- Compte conservé s'il sert aussi à gérer une centrale ou la plateforme
  v_keep := private.keeps_login_account(d.user_id);

  -- Centrale suspendue ou archivée : courses acceptées libérées (plus de dispatch pour elle : « à attribuer »)
  if v_release > 0 then
    for r in
      select * from public.rides x
       where x.driver_id = d.id and x.status = 'ACCEPTED'
         -- Réseau partagé : courses de son organisation seulement
         and x.organization_id = d.organization_id
       order by x.pickup_at, x.id
       for update
    loop
      update public.ride_assignments
         set is_active = false, released_at = now(), release_reason = 'driver_deleted'
       where ride_id = r.id and is_active;
      perform private.close_pending_offers(r.id, 'closed', 'driver_deleted');
      update public.rides
         set status = 'CREATED',
             driver_id = null,
             vehicle_id = null,
             dispatch_wave = 0,
             dispatch_radius_m = null,
             dispatch_started_at = null,
             next_dispatch_at = null,
             accepted_at = null,
             driver_en_route_at = null,
             driver_arrived_at = null,
             no_driver_at = null
       where id = r.id;
      perform private.close_ride_alerts(r.id, 'auto_resolved', null);
      perform private.log_event(r.organization_id, r.id, 'ride.driver_deleted',
        format('Course retirée au chauffeur #%s, qui a supprimé son compte (centrale inactive) — à attribuer manuellement', d.number),
        'timeline', 'warning', jsonb_build_object('previous_driver_id', d.id, 'previous_status', r.status),
        case when v_admin then 'super_admin' else 'driver' end::public.actor_type,
        case when v_admin then p_actor else d.id end);
      v_released := v_released + 1;
    end loop;
  end if;

  -- Commissions encore dues à la centrale : empreintes gardées tant que la dette est ouverte (avant l'effacement
  -- des identifiants), jamais la valeur en clair
  select o.owed_cents, o.owed_count into v_owed_cents, v_owed_count from private.driver_open_debt(d.id) o;
  if coalesce(v_owed_count, 0) > 0 then
    insert into private.debtor_identities (organization_id, driver_id, driver_number, kind, value_hash)
    select d.organization_id, d.id, d.number, i.kind, i.value_hash
      from private.driver_identities(d.id, false) i
     where i.kind in ('phone', 'email', 'vtc_card')
    on conflict (driver_id, kind, value_hash) do nothing;
    get diagnostics v_debtor_ids = row_count;
  end if;

  -- Offres en attente closes (le chauffeur ne peut plus répondre)
  update public.ride_offers
     set status = 'closed', closed_reason = 'driver_deleted', responded_at = now()
   where driver_id = d.id and status = 'pending';

  -- Nom et identification retirés de tout ce qui les a recopiés (avant l'anonymisation : noms encore connus)
  perform private.scrub_driver_traces(d.id, d.organization_id, d.created_at, d.first_name, d.last_name, d.number, v_alias);

  -- Données personnelles supprimées (les fichiers des justificatifs : dossier purgé via la file)
  select count(*) into v_files from public.driver_documents x where x.driver_id = d.id;
  delete from public.driver_documents where driver_id = d.id;
  delete from public.push_tokens where driver_id = d.id;
  delete from public.driver_devices where driver_id = d.id;
  delete from public.driver_locations where driver_id = d.id;
  delete from public.driver_location_history where driver_id = d.id;
  delete from public.notifications where driver_id = d.id;
  delete from public.chat_report_votes where voter_key = v_key;
  delete from public.chat_reads where reader_key = v_key or thread_key = v_key;
  delete from public.chat_messages where driver_id = d.id or author_driver_id = d.id;

  -- Véhicule personnel (inscription par lien), utilisé par aucun autre chauffeur
  if d.vehicle_id is not null and d.joined_via = 'join_link'
     and not exists (select 1 from public.drivers x where x.vehicle_id = d.vehicle_id and x.id <> d.id) then
    v_vehicle := d.vehicle_id;
  end if;

  -- Fiche anonymisée, détachée du compte de connexion ; conservée pour les courses et règlements passés.
  -- Membre de centrale : ses sessions de gestion ne sont pas coupées (drivers_revoke_sessions).
  if v_keep then
    perform set_config('rydar.keep_sessions', d.user_id::text, true);
  end if;
  update public.drivers
     set first_name = 'Chauffeur',
         last_name = 'supprimé',
         phone = '',
         email = null,
         photo_url = null,
         vtc_card_number = null,
         notes = null,
         application_status = null,
         application_message = null,
         application_note = null,
         suspended_reason = case when v_admin then 'Compte supprimé à la demande du chauffeur' else 'Compte supprimé par le chauffeur' end,
         -- (motif de bannissement conservé contre la fraude, son nom déjà retiré par scrub_driver_traces)
         status = 'inactive',
         presence = 'offline',
         online_since = null,
         last_seen_at = null,
         current_ride_id = null,
         vehicle_id = null,
         user_id = null,
         deleted_at = now()
   where id = d.id;
  perform set_config('rydar.keep_sessions', '', true);

  if v_vehicle is not null then
    if exists (select 1 from public.rides r1 where r1.vehicle_id = v_vehicle)
       or exists (select 1 from public.ride_assignments a where a.vehicle_id = v_vehicle) then
      update public.vehicles
         set plate = 'SUPPR-' || upper(left(replace(v_vehicle::text, '-', ''), 10)),
             brand = null,
             model = 'Véhicule supprimé',
             color = null,
             year = null,
             is_active = false
       where id = v_vehicle;
      v_vehicle_action := 'anonymized';
    else
      delete from public.vehicles where id = v_vehicle;
      v_vehicle_action := 'deleted';
    end if;
  end if;

  -- Compte de connexion (supprimé par la file) : nom et téléphone effacés dès maintenant
  if d.user_id is not null and not v_keep then
    update public.users set full_name = null, phone = null, avatar_url = null where id = d.user_id;
    begin
      update auth.users
         set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) - array['full_name', 'name', 'phone', 'avatar_url']
       where id = d.user_id;
    exception when insufficient_privilege or undefined_table or undefined_column then
      raise warning 'delete_driver_account: métadonnées Auth non effacées (privilèges)';
    end;
  end if;

  insert into private.account_deletions (driver_id, organization_id, driver_number, user_id, keep_auth, storage_prefix,
    source, requested_by, auth_done_at, next_attempt_at)
  values (d.id, d.organization_id, d.number, d.user_id, v_keep, format('%s/%s/', d.organization_id, d.id),
    p_source, case when v_admin then p_actor end,
    case when d.user_id is null or v_keep then now() end,
    -- traitée aussitôt par l'appelant ; le worker ne la reprend qu'en cas d'échec
    now() + interval '2 minutes')
  returning * into q;

  -- Journal d'audit du chauffeur et de son véhicule d'inscription : valeurs personnelles, adresse IP et navigateur
  -- retirés (l'action reste tracée)
  perform private.redact_driver_audit(d.id, d.user_id, v_keep, v_vehicle);

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (d.organization_id, case when v_admin then 'super_admin' else 'driver' end::public.actor_type,
    case when v_admin then p_actor end, 'driver.deleted', 'drivers', d.id::text, 'warning',
    jsonb_build_object('number', d.number, 'source', p_source, 'documents', v_files, 'keep_auth', v_keep,
      'vehicle', v_vehicle_action, 'deletion_id', q.id, 'rides_released', v_released,
      'owed_cents', v_owed_cents, 'owed_settlements', v_owed_count, 'debtor_identities', v_debtor_ids));

  perform private.log_event(d.organization_id, null, 'driver.deleted',
    case when v_admin then format('Compte du chauffeur #%s supprimé à sa demande (traité par Rydar Drive)', d.number)
         else format('Le chauffeur #%s a supprimé son compte', d.number) end
    || case when coalesce(v_owed_count, 0) > 0
            then format(' — reste dû : %s de commissions (%s règlement%s au nom de « %s »)',
                   private.fmt_eur(least(v_owed_cents, 2147483647)::integer), v_owed_count,
                   case when v_owed_count > 1 then 's' else '' end, v_alias)
            else '' end,
    'system', 'warning',
    jsonb_build_object('driver_id', d.id, 'source', p_source, 'rides_released', v_released,
      'owed_cents', v_owed_cents, 'owed_settlements', v_owed_count),
    case when v_admin then 'super_admin' else 'driver' end::public.actor_type,
    case when v_admin then p_actor else d.id end);

  return jsonb_build_object('ok', true, 'code', 'DELETED', 'already_deleted', false, 'documents', v_files,
      'vehicle', v_vehicle_action, 'rides_released', v_released)
    || private.account_deletion_json(q);
end;
$$;

-- =============================================================================
-- 13. Chien de garde et organisations indisponibles (§9.8, C3, C12)
-- =============================================================================

-- Chien de garde (private.watch_rides, worker toutes les 30 s ; appel protégé). Courses de A tenues par un chauffeur
-- partenaire qui ne peut plus les faire — fiche du chauffeur inactive, organisation B inactive (suspendue, archivée)
-- ou suspendue du réseau par Rydar (« executor_unavailable »), chauffeur retiré du réseau par B (org_allowed,
-- « executor_released ») :
--  * pas encore commencée (acceptée, en route, arrivé) : rendue à A (private.unassign_network_ride) ;
--  * client à bord : alerte chez A seulement, une fois par exécution (« network.executor_unavailable ») — le chauffeur
--    termine (public.driver_update_ride_status, même fiche ou B inactive), sinon A la clôture (public.close_network_ride).
-- Coupure du réseau, partage ou réception arrêtés, exclusions, A suspendue : les courses acceptées vont au bout.
-- A suspendue ou archivée : chauffeurs partenaires prévenus une fois (courses acceptées, règlements réseau ouverts ;
-- notification « network_giver_suspended »). Offres réseau en attente devenues inacceptables (paire d'organisations
-- non éligible — interrupteur coupé, organisation suspendue, partage ou réception arrêtés, exclusion… —, chauffeur
-- inactif, interrupteur du chauffeur coupé ou retiré par B : mêmes cas qu'OFFER_CLOSED à l'acceptation) : fermées
-- (« network_unavailable », notification d'offre supprimée) — filet de sécurité des coupures (§9.6). Parcours « skip
-- locked » (course en cours de modification : au passage suivant) ; chaque course dans un bloc protégé (une course en
-- erreur n'empêche pas les autres). Ne dépend pas de l'interrupteur : une coupure globale laisse finir les courses
-- déjà acceptées, qu'il faut toujours surveiller.
create or replace function private.network_watch()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  x record;
  r public.rides;
  d public.drivers;
  v_cause text;
  v_execution uuid;
  v_label text;
  v_partner text;
  v_res jsonb;
  v_released integer := 0;
  v_alerts integer := 0;
  v_notified integer := 0;
  v_skipped integer := 0;
  v_errors integer := 0;
  v_closed integer := 0;
begin
  -- Offres réseau en attente devenues inacceptables (peu nombreuses : index des offres en attente)
  with pairs as (
    select distinct o.organization_id as giver, o.driver_org_id as executor
      from public.ride_offers o
     where o.status = 'pending' and o.is_network
  ),
  broken as (
    select p.giver, p.executor from pairs p where not private.network_pair_ok(p.giver, p.executor)
  ),
  gone as (
    update public.ride_offers o
       set status = 'closed', closed_reason = 'network_unavailable', responded_at = coalesce(o.responded_at, now())
      from public.drivers dr
     where o.status = 'pending' and o.is_network and dr.id = o.driver_id
       and ((o.organization_id, o.driver_org_id) in (select b.giver, b.executor from broken b)
            or dr.status <> 'active'
            or exists (select 1 from public.driver_network_settings n
                        where n.driver_id = dr.id and not (n.enabled and n.org_allowed)))
    returning o.id
  )
  select count(*)::integer into v_closed from gone;

  for x in
    select r0.id
      from public.rides r0
     where r0.driver_org_id <> r0.organization_id
       and r0.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS')
     order by r0.id
  loop
    select * into r from public.rides where id = x.id for update skip locked;
    if not found then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    continue when r.driver_id is null or r.driver_org_id = r.organization_id
      or r.status not in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS');
    select * into d from public.drivers y where y.id = r.driver_id;
    v_cause := case
      when d.id is null or d.status <> 'active' or d.deleted_at is not null then 'driver_inactive'
      when exists (select 1 from public.organizations o where o.id = r.driver_org_id and o.status <> 'active')
        then 'executor_inactive'
      when exists (select 1 from public.network_memberships m
                    where m.organization_id = r.driver_org_id and m.suspended_at is not null) then 'executor_suspended'
      when exists (select 1 from public.driver_network_settings n where n.driver_id = r.driver_id and not n.org_allowed)
        then 'driver_withdrawn'
    end;
    continue when v_cause is null;
    begin
      if r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED') then
        v_res := private.unassign_network_ride(r.driver_id, r.id,
          case when v_cause = 'driver_withdrawn' then 'executor_released' else 'executor_unavailable' end);
        if coalesce((v_res ->> 'ok')::boolean, false) then
          v_released := v_released + 1;
        end if;
      else
        select e.id, e.driver_label, e.operator ->> 'name' into v_execution, v_label, v_partner
          from public.ride_network_executions e where e.ride_id = r.id and e.ended_at is null;
        if not exists (select 1 from public.ride_events ev
                        where ev.ride_id = r.id and ev.type = 'network.executor_unavailable'
                          and ev.data ->> 'execution_id' is not distinct from v_execution::text) then
          perform private.log_event(r.organization_id, r.id, 'network.executor_unavailable',
            format('Chauffeur partenaire indisponible, client à bord (%s, %s : %s) — il peut terminer la course ; sinon, clôturez-la',
              coalesce(v_label, 'chauffeur'), coalesce(v_partner, 'organisation partenaire'),
              case v_cause
                when 'driver_inactive' then 'chauffeur désactivé'
                when 'executor_inactive' then 'organisation suspendue'
                when 'executor_suspended' then 'organisation suspendue du réseau partagé'
                else 'retiré du réseau partagé par son organisation'
              end),
            'timeline', 'warning',
            jsonb_build_object('network', true, 'execution_id', v_execution, 'cause', v_cause, 'status', r.status),
            'system', null);
          v_alerts := v_alerts + 1;
        end if;
      end if;
    exception when others then
      v_errors := v_errors + 1;
    end;
  end loop;

  -- A suspendue ou archivée : chaque chauffeur partenaire concerné prévenu une fois depuis la suspension (courses
  -- acceptées : rattachée à la plus proche ; sinon règlement réseau ouvert, G4)
  for x in
    select o.id as org_id, o.name, p.driver_id,
           (select r1.id from public.rides r1
             where r1.organization_id = o.id and r1.driver_id = p.driver_id and r1.driver_org_id <> r1.organization_id
               and r1.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS')
             order by r1.pickup_at, r1.id limit 1) as ride_id
      from public.organizations o
     cross join lateral (
       select r2.driver_id from public.rides r2
        where r2.organization_id = o.id and r2.driver_org_id <> r2.organization_id
          and r2.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS')
       union
       select s.network_driver_id from public.ride_settlements s
        where s.organization_id = o.id and s.network_driver_org_id is not null and s.network_driver_id is not null
          and s.status in ('due', 'declared', 'disputed')
     ) p
     where o.status in ('suspended', 'archived')
       and p.driver_id is not null
       and not exists (
         select 1 from public.notifications n
          where n.organization_id = o.id and n.driver_id = p.driver_id and n.type = 'network_giver_suspended'
            and n.created_at >= coalesce(o.suspended_at, o.archived_at, '-infinity'::timestamptz))
  loop
    begin
      perform private.queue_notification(x.org_id, x.driver_id, x.ride_id, null, 'network_giver_suspended',
        'ORGANISATION SUSPENDUE — ' || x.name,
        format('%s est suspendue : vos courses déjà acceptées restent à faire, vos règlements avec elle restent dus ou attendus.',
          x.name),
        jsonb_build_object('type', 'network_giver_suspended', 'network', true, 'giver', x.name)
          || case when x.ride_id is not null then jsonb_build_object('ride_id', x.ride_id) else '{}'::jsonb end,
        'normal', null);
      v_notified := v_notified + 1;
    exception when others then
      v_errors := v_errors + 1;
    end;
  end loop;

  return jsonb_build_object('released', v_released, 'alerts', v_alerts, 'notified', v_notified, 'closed_offers', v_closed,
    'skipped', v_skipped, 'errors', v_errors);
end;
$$;

-- Surveillance des courses attribuées (worker, ~30 s)
-- Dernière définition : 20260924002200_ride_alerts.sql. Réseau partagé : seul ajout, private.network_watch en fin de
-- passage, dans un bloc protégé ; clé « network » de la réponse seulement s'il a agi (sinon réponse inchangée).
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

-- « Clôturer la course » (§9.8, C3) : propriétaire ou administrateur de A (private.assert_network_creditor : A
-- suspendue ou archivée comprise). Course de A tenue par un chauffeur partenaire, arrivé ou client à bord, qui ne peut
-- plus la terminer : fiche du chauffeur ou organisation B inactive, ou aucune position depuis 30 min. La course est
-- terminée (déclencheurs de fin inchangés : exécution « completed », règlement, frais Rydar de A), « à vérifier »
-- (closed_by_giver ; versement prépayé retenu 72 h), chauffeur libéré, rappels annulés ; journal (« ride.network_closed »)
-- et audit (« network.ride_closed ») chez A. Sinon NETWORK_CLOSE_NOT_ALLOWED (55000).
create or replace function public.close_network_ride(p_ride uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  d public.drivers;
  v_exec_status public.org_status;
  v_last timestamptz;
  v_cause text;
  v_execution uuid;
  v_label text;
begin
  select * into r from public.rides where id = p_ride for update;
  if not found then
    raise exception 'RIDE_NOT_FOUND: course introuvable' using errcode = 'P0002';
  end if;
  perform private.assert_network_creditor(r.organization_id);
  perform private.set_actor('user', auth.uid());
  if r.driver_id is null or r.driver_org_id = r.organization_id
     or r.status not in ('DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS') then
    raise exception 'NETWORK_CLOSE_NOT_ALLOWED: course non tenue par un chauffeur partenaire, ou pas en cours'
      using errcode = '55000';
  end if;

  select * into d from public.drivers y where y.id = r.driver_id;
  select o.status into v_exec_status from public.organizations o where o.id = r.driver_org_id;
  select l.updated_at into v_last from public.driver_locations l where l.driver_id = r.driver_id;
  v_cause := case
    when d.id is null or d.status <> 'active' or d.deleted_at is not null then 'driver_inactive'
    when v_exec_status is distinct from 'active' then 'executor_inactive'
    when v_last is null or v_last < now() - interval '30 minutes' then 'no_position'
  end;
  if v_cause is null then
    raise exception 'NETWORK_CLOSE_NOT_ALLOWED: chauffeur partenaire actif, position reçue depuis moins de 30 min'
      using errcode = '55000';
  end if;

  -- « À vérifier » avant la fin (le règlement du lot argent lit la retenue à la fin de course)
  update public.ride_network_executions e
     set suspect_reasons = array(select distinct z from unnest(e.suspect_reasons || array['closed_by_giver']::text[]) as z
                                  order by z),
         hold_until = case when (e.terms ->> 'direction') = 'centrale_owes'
                           then coalesce(e.hold_until, now() + interval '72 hours') else e.hold_until end
   where e.ride_id = r.id and e.ended_at is null
  returning e.id, e.driver_label into v_execution, v_label;

  update public.rides set status = 'COMPLETED', completed_at = now() where id = r.id;
  perform private.network_release_driver(r.driver_id, r.id);
  update public.notifications set status = 'cancelled'
   where ride_id = r.id and type = 'ride_reminder' and status = 'queued';

  perform private.log_event(r.organization_id, r.id, 'ride.network_closed',
    format('Course clôturée par l''organisation (chauffeur partenaire %s %s) — à vérifier', coalesce(v_label, ''),
      case v_cause when 'driver_inactive' then 'désactivé'
                   when 'executor_inactive' then 'dont l''organisation est suspendue'
                   else 'sans position depuis 30 min' end),
    'timeline', 'warning',
    jsonb_build_object('network', true, 'execution_id', v_execution, 'cause', v_cause, 'previous_status', r.status),
    'user', auth.uid());
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity,
                                 metadata)
  values (r.organization_id, 'user', auth.uid(), 'network.ride_closed', 'rides', r.id::text, 'warning',
          jsonb_build_object('execution_id', v_execution, 'cause', v_cause, 'previous_status', r.status));

  return jsonb_build_object('ok', true, 'ride_id', r.id, 'status', 'COMPLETED');
end;
$$;

-- =============================================================================
-- 14. Contrôles de fin de course (§9.9, S10)
-- =============================================================================

-- Étape déclarée par le chauffeur partenaire (public.driver_update_ride_status), AVANT l'écriture du statut, sans
-- jamais la refuser : arrivé (DRIVER_ARRIVED) ou fin (COMPLETED) sans position fraîche (≤ 120 s) → no_gps ; arrivé à
-- plus de 500 m du départ → far_from_pickup ; terminée à plus de 1 km de l'arrivée (si connue) → far_from_dropoff ;
-- moins de 30 % de la durée estimée depuis le départ (IN_PROGRESS) → too_fast. Raisons ajoutées à l'exécution ouverte
-- (suspect_reasons : course « à vérifier » chez A) ; à la fin, course à vérifier dont A verse la part au chauffeur
-- (prépayée, centrale_owes) : versement retenu 72 h (hold_until, lu par le règlement du lot argent). Renvoie les raisons
-- relevées à cette étape.
create or replace function private.network_completion_checks(r public.rides, p_status public.ride_status)
returns text[]
language plpgsql
set search_path = ''
as $$
declare
  l public.driver_locations;
  v_fresh boolean;
  v_reasons text[] := '{}';
begin
  if r.driver_id is null or r.driver_org_id = r.organization_id or p_status not in ('DRIVER_ARRIVED', 'COMPLETED') then
    return v_reasons;
  end if;
  select * into l from public.driver_locations x where x.driver_id = r.driver_id;
  v_fresh := found and l.updated_at >= now() - interval '120 seconds';
  if not v_fresh then
    v_reasons := v_reasons || 'no_gps'::text;
  elsif p_status = 'DRIVER_ARRIVED' then
    if extensions.st_distance(l.location, r.pickup_location) > 500 then
      v_reasons := v_reasons || 'far_from_pickup'::text;
    end if;
  elsif r.dropoff_location is not null and extensions.st_distance(l.location, r.dropoff_location) > 1000 then
    v_reasons := v_reasons || 'far_from_dropoff'::text;
  end if;
  if p_status = 'COMPLETED' and coalesce(r.estimated_duration_s, 0) > 0 and r.started_at is not null
     and extract(epoch from (now() - r.started_at)) < 0.3 * r.estimated_duration_s then
    v_reasons := v_reasons || 'too_fast'::text;
  end if;

  if cardinality(v_reasons) > 0 then
    update public.ride_network_executions e
       set suspect_reasons = array(select distinct z from unnest(e.suspect_reasons || v_reasons) as z order by z)
     where e.ride_id = r.id and e.ended_at is null
       and not (e.suspect_reasons @> v_reasons);
  end if;
  if p_status = 'COMPLETED' then
    update public.ride_network_executions e
       set hold_until = now() + interval '72 hours'
     where e.ride_id = r.id and e.ended_at is null and e.hold_until is null
       and cardinality(e.suspect_reasons) > 0 and (e.terms ->> 'direction') = 'centrale_owes';
  end if;
  return v_reasons;
end;
$$;

-- Cycle de course (chauffeur)
-- Dernière définition : 20260924004500_audit_dispatch.sql. Réseau partagé, course d'une autre organisation que le
-- chauffeur : contrôles de fin (private.network_completion_checks, jamais un refus) avant l'écriture du statut ;
-- journal de A sans son identifiant (private.log_partner_event) ; client à bord et fiche ou organisation du chauffeur
-- devenue inactive : le compte qui tient la course la démarre et la termine quand même (C3), puis hors ligne. Course
-- propre : inchangée.
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
  -- Réseau partagé
  v_partner boolean;
  v_fallback boolean := false;
begin
  select d.* into v_driver from public.drivers d where d.id = private.current_driver_id();
  if not found then
    -- Réseau partagé (C3) : client à bord d'une course d'une autre organisation, fiche ou organisation du chauffeur
    -- devenue inactive (suspension) entre-temps : le compte dont la fiche tient la course la termine quand même
    -- (démarrage et fin seulement). Aucune course partenaire : refus d'avant, inchangé.
    select d.* into v_driver
      from public.drivers d
      join public.rides x on x.driver_id = d.id
     where d.user_id = auth.uid()
       and d.deleted_at is null
       and x.id = p_ride_id
       and x.organization_id <> d.organization_id
       and x.status in ('PASSENGER_ONBOARD', 'IN_PROGRESS')
       and p_status in ('IN_PROGRESS', 'COMPLETED');
    if not found then
      raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
    end if;
    v_fallback := true;
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

  -- Réseau partagé (S10) : contrôles de fin d'une course d'une autre organisation, AVANT l'écriture du statut (retenue
  -- du versement lue par le règlement), jamais un refus — une erreur des contrôles n'empêche pas l'étape
  v_partner := r.organization_id <> v_driver.organization_id;
  if v_partner then
    begin
      perform private.network_completion_checks(r, p_status);
    exception when others then
      null;
    end;
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
  if v_partner then
    -- Réseau partagé : journal de A sans l'identifiant du chauffeur partenaire (S3)
    perform private.log_partner_event(r.organization_id, r.id, 'ride.' || lower(p_status::text), v_message,
      'timeline', case when p_status = 'COMPLETED' then 'success' else 'info' end::public.event_level,
      jsonb_build_object('status', p_status));
  else
    perform private.log_event(r.organization_id, r.id, 'ride.' || lower(p_status::text), v_message,
      'timeline', case when p_status = 'COMPLETED' then 'success' else 'info' end::public.event_level,
      jsonb_build_object('status', p_status), 'driver', v_driver.id);
  end if;

  if p_status = 'COMPLETED' then
    perform private.release_driver_ride(v_driver.id, r.id, false);
    -- Réseau partagé (C3) : fiche ou organisation inactive, course terminée quand même → hors ligne
    if v_fallback then
      update public.drivers set presence = 'offline', current_ride_id = null where id = v_driver.id;
    end if;
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

-- =============================================================================
-- 15. Droits de la partie 3b : fonctions serveur seulement, sauf public.close_network_ride (owner / admin de A, contrôle
-- dans la fonction). Fonctions redéfinies : droits conservés (même signature).
-- =============================================================================
revoke all on function
  private.assert_network_creditor(uuid),
  private.network_release_driver(uuid, uuid),
  private.unassign_network_ride(uuid, uuid, text, text),
  private.network_watch(),
  private.network_completion_checks(public.rides, public.ride_status)
from public, anon, authenticated;
grant execute on function
  private.assert_network_creditor(uuid),
  private.network_release_driver(uuid, uuid),
  private.unassign_network_ride(uuid, uuid, text, text),
  private.network_watch(),
  private.network_completion_checks(public.rides, public.ride_status)
to service_role;
revoke all on function public.close_network_ride(uuid) from public, anon;
grant execute on function public.close_network_ride(uuid) to authenticated;
