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
-- Tant que public.shared_network_enabled() est faux, ou que A ne partage pas, tous les chemins et leurs effets sont
-- ceux d'avant (fonctions redéfinies : seules des branches réseau sont ajoutées, commentées « Réseau partagé »).
-- Suite du lot (fermetures, retraits, chien de garde, fin de course) : même migration, partie 3b.
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
-- 8. Attribution manuelle : créneau pris par une course partenaire (§9.5 point 6, C4)
-- =============================================================================
-- Dernière définition : 20260924006600_platform_fee_schedule.sql (corps gardé À L'IDENTIQUE : version provisoire du
-- chantier CGV). Réseau partagé : seul ajout, DRIVER_BUSY_AT_TIME quand le chauffeur choisi tient une course d'une
-- autre organisation qui chevauche celle-ci (private.driver_time_conflict ; sans course partenaire : jamais).
-- Le reste du réseau (network_at remis à NULL, partenaire libéré « reassigned_own ») : partie 3b du lot.
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
