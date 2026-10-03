-- =============================================================================
-- Rydar Drive — Réseau partagé, lot 7 : corrections transverses (relecture adverse de 006700 à 007100, cycle complet,
-- balayage des fuites, temps réel). Interrupteur plateforme COUPÉ : comportement strictement identique tant qu'il
-- l'est (chaque branche ajoutée exige une course, une offre ou une ligne réseau).
--
--  1. Signalement routier pendant une course partenaire (Q5, §11.6, résidu du lot 5b) : un chauffeur qui tient une
--     course d'une autre organisation ne publie pas de signalement sur le fil flotte de la sienne (sa position y
--     serait lue) et aucun de ses messages n'y porte de coordonnées (NETWORK_RIDE_REPORT_BLOCKED). Déclencheur sur
--     chat_messages : public.send_chat_message (004100) reste inchangée.
--  2. Performance de l'étape réseau (interrupteur ouvert, mesures en tête de section) : private.network_identity_block
--     (contrôle « banni » par index, plus de parcours de banned_identities par chauffeur), private.network_candidates
--     (paire évaluée une fois par organisation ; nouvelle surcharge à limite : contrôles arrêtés aux N plus proches
--     éligibles), private.network_offer (limite de la vague), private.network_search_exhausted (un candidat suffit) et
--     private.network_open (compteur « partenaires à proximité » plafonné à 50, NETWORK_PARTNERS_NEARBY_MAX).
--  3. Fusion de l'audit 20260924006650 (fonctions nouvelles ou redéfinies par l'audit, sans version réseau) :
--     public.svc_platform_ban rend une course partenaire à son organisation (private.unassign_network_ride, jamais
--     private.platform_unassign_ride, UPDATE direct refusé par G6 ou laissant l'exécution ouverte) ;
--     public.svc_platform_set_org_status compte aussi les courses d'autres organisations tenues par ses chauffeurs
--     (DRIVER_ON_RIDE, même règle que ses propres courses).
--
-- Supabase hébergé : rien sur auth.*, storage.*, realtime.messages.
-- =============================================================================

-- =============================================================================
-- 1. Signalements routiers pendant une course partenaire
-- =============================================================================
-- Seule voie d'écriture : public.send_chat_message (definer) et le service role ; private.driver_on_foreign_ride (006700,
-- definer, interrupteur coupé : toujours faux) lit la course en cours du chauffeur.
create or replace function private.chat_messages_network_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.driver_on_foreign_ride(new.author_driver_id) then
    if new.report_type is not null then
      raise exception 'NETWORK_RIDE_REPORT_BLOCKED: pas de signalement pendant une course confiée par une autre organisation (votre position n''est pas partagée avec votre flotte pendant cette course)'
        using errcode = '55000';
    end if;
    new.lat := null;
    new.lng := null;
  end if;
  return new;
end;
$$;
revoke all on function private.chat_messages_network_guard() from public, anon, authenticated;

create trigger chat_messages_network_guard
  before insert on public.chat_messages
  for each row
  when (new.author_driver_id is not null)
  execute function private.chat_messages_network_guard();

-- =============================================================================
-- 2. Performance de l'étape réseau du dispatch (interrupteur ouvert)
-- =============================================================================
-- Mesuré (scratchpad lot 7) sur 30 organisations, 800 chauffeurs autour de Paris, 40 000 courses passées, 50 000
-- bannissements : la recherche des partenaires évaluait les contrôles de chaque chauffeur dans le rayon (jusqu'à 16 km)
-- à chaque vague, chaque test d'arrêt anticipé et chaque ouverture, et le contrôle « banni » parcourait toute la table
-- banned_identities pour chacun (9,7 ms par chauffeur). Mêmes résultats, mêmes règles ; seule l'évaluation change.

-- Dernière définition : 20260924006900_shared_network_money.sql. Seul changement : contrôle « banned » par index.
create or replace function private.network_identity_block(p_driver uuid, p_giver uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
begin
  -- Réseau partagé, lot 7 (performance) : une recherche par empreinte dans banned_identities_lookup_idx (sous-requête
  -- LATERAL limitée, jamais aplatie en jointure par hachage : celle-ci parcourait toute la table des bannissements pour
  -- chaque chauffeur en lice, private.driver_identities étant estimée à 1 000 lignes) ; même résultat.
  if exists (
    select 1
      from (select k.kind, k.value_hash from private.driver_identity_keys k
             where k.driver_id = p_driver and k.kind <> 'account'
            union
            select i.kind, i.value_hash from private.driver_identities(p_driver, true) i) x
     cross join lateral (
       select 1 from public.banned_identities b
        where b.kind = x.kind and b.value_hash = x.value_hash and b.lifted_at is null
          and (b.scope = 'platform' or b.organization_id = p_giver)
        limit 1) b) then
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
                         -- prédicat de l'index partiel ride_settlements_network_driver_idx (lignes réseau seulement)
                         and x.network_driver_org_id is not null
                         and x.direction = 'driver_owes'
                         and x.amount_cents > 0
                         and x.status in ('due', 'declared', 'disputed')))
     -- Réseau partagé, lot argent : AUTRE fiche non supprimée du même chauffeur (mêmes empreintes : il a changé
     -- d'organisation) avec un reversement réseau envers A qui le bloquerait chez A (règle de A, block_unpaid : « Pas
     -- reçu », échu, ou redéclaré après « Pas reçu ») — un débiteur de A ne revient pas par une autre organisation
     or (coalesce((select s.block_unpaid from public.organization_settings s where s.organization_id = p_giver), true)
         and exists (
           select 1
             from private.driver_identity_keys k
             join private.driver_identity_keys o
               on o.kind = k.kind and o.value_hash = k.value_hash and o.driver_id <> k.driver_id
             join public.ride_settlements x
               on x.network_driver_id = o.driver_id
              -- prédicat de l'index partiel ride_settlements_network_driver_idx (lignes réseau seulement)
              and x.network_driver_org_id is not null
              and x.status in ('due', 'declared', 'disputed')
            where k.driver_id = p_driver
              and x.organization_id = p_giver
              and x.direction = 'driver_owes'
              and x.amount_cents > 0
              and (x.status = 'disputed'
                   or (x.status = 'due' and x.due_at <= now())
                   or (x.status = 'declared' and x.disputed_at is not null)))) then
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

-- Nouvelle surcharge (limite) de private.network_candidates (dernière définition de la version à 3 arguments :
-- 20260924006800_shared_network_dispatch.sql, corps repris À L'IDENTIQUE hors les deux commentaires « Lot 7 »).
create or replace function private.network_candidates(r public.rides, p_radius_m integer, p_scheduled boolean,
                                                      p_limit integer)
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
  -- Lot 7 (performance) : paire évaluée une fois par organisation (OFFSET 0 : la condition n'est plus descendue sous le
  -- DISTINCT, où elle était évaluée pour chaque chauffeur)
  partners as materialized (
    select g.n_org
      from (select distinct n.n_org from near n offset 0) g
     where private.network_pair_ok(r.organization_id, g.n_org)
  )
  -- Lot 7 (performance) : contrôles par chauffeur (private.network_driver_reason, les plus coûteux) évalués du plus proche
  -- au plus loin et arrêtés à p_limit éligibles (NULL : tous) — OFFSET 0 : la condition reste au-dessus du tri ; même
  -- liste, dans le même ordre, que l'ancienne fonction suivie de « limit p_limit »
  select z.n_driver, z.n_org, z.n_distance
    from (select n.n_driver, n.n_org, n.n_distance, d as n_row
            from near n
            join partners p on p.n_org = n.n_org
            join public.drivers d on d.id = n.n_driver
           order by n.n_distance, n.n_driver
          offset 0) z
   where private.network_driver_reason(z.n_row, r, v_amount) is null
   order by z.n_distance, z.n_driver
   limit p_limit;
end;
$$;
revoke all on function private.network_candidates(public.rides, integer, boolean, integer) from public, anon, authenticated;
grant execute on function private.network_candidates(public.rides, integer, boolean, integer) to service_role;

-- Dernière définition : 20260924006800_shared_network_dispatch.sql. Même liste complète (p_limit NULL) ; droits inchangés.
create or replace function private.network_candidates(r public.rides, p_radius_m integer, p_scheduled boolean default false)
returns table (driver_id uuid, organization_id uuid, distance_m integer)
language sql
stable
set search_path = ''
as $$
  select c.driver_id, c.organization_id, c.distance_m from private.network_candidates(r, p_radius_m, p_scheduled, null) c;
$$;

-- Dernière définition : 20260924006800_shared_network_dispatch.sql. Seul changement : limite passée aux candidats.
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
      -- Lot 7 (performance) : contrôles arrêtés aux p_limit plus proches éligibles
      from private.network_candidates(r, p_radius, v_scheduled, p_limit) x
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

-- Dernière définition : 20260924006800_shared_network_dispatch.sql. Seul changement : un candidat suffit.
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
  -- Lot 7 (performance) : un seul partenaire éligible suffit (contrôles arrêtés au premier)
  return not exists (select 1 from private.network_candidates(r, v_radius, false, 1))
     and not exists (select 1 from private.own_geo_candidates(r, v_radius, false));
end;
$$;

-- Dernière définition : 20260924006800_shared_network_dispatch.sql. Seul changement : compteur partners_nearby plafonné
-- à 50 (contrôles arrêtés au 50e partenaire éligible ; journal dispatch.network : « 50 ou plus »).
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
    -- Lot 7 (performance) : compteur plafonné à 50 (NETWORK_PARTNERS_NEARBY_MAX de @rydar/shared, « 50 ou plus ») —
    -- les contrôles s'arrêtent au 50e partenaire éligible au lieu de porter sur tous ceux du rayon maximal
    select count(*)::integer into v_nearby
      from private.network_candidates(r, private.network_max_radius(s.dispatch_radii_m), p_stage = 'scheduled_window', 50);
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

-- =============================================================================
-- 3. Fusion de l'audit 20260924006650 : bannissement plateforme, suspension d'une organisation
-- =============================================================================
-- Dernière définition : 20260924006650_audit_fixes.sql (corps gardé À L'IDENTIQUE). Réseau partagé, seul ajout : une
-- course d'une autre organisation tenue par une fiche bannie (attribuée, pas commencée) est rendue à son organisation
-- par private.unassign_network_ride (« executor_unavailable » : exécution et partage clos, chauffeurs de A d'abord,
-- journal de A sans identifiant) ; private.platform_unassign_ride (UPDATE direct de rides.driver_id, journal nominatif
-- chez A) reste pour les courses de son organisation. Client à bord (DRIVER_ON_RIDE) : inchangé, toutes courses.
create or replace function public.svc_platform_ban(
  p_report_id uuid,
  p_actor uuid,
  p_note text default null,
  p_extend_driver_ids uuid[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.fraud_reports;
  x record;
  v_count integer;
  v_identities_skipped integer;
  v_drivers integer := 0;
  v_users uuid[] := '{}';
  v_kept uuid[] := '{}';
  v_note text := left(nullif(btrim(coalesce(p_note, '')), ''), 500);
  v_extend uuid[] := coalesce(p_extend_driver_ids, '{}');
  v_same uuid[];
  v_confirmed uuid[];
  v_skipped uuid[];
  v_blocked text[];
  v_ride record;
  v_reassigned integer := 0;
  v_onboard text;
begin
  perform private.assert_platform_actor(p_actor);
  select * into f from public.fraud_reports where id = p_report_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Signalement introuvable.');
  end if;
  if f.status = 'platform_banned' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_BANNED', 'message', 'Déjà banni de la plateforme.');
  end if;
  if exists (select 1 from public.drivers d where d.id = f.driver_id and d.deleted_at is null and d.banned_at is null) then
    return jsonb_build_object('ok', false, 'code', 'REPORTED_DRIVER_NOT_BANNED',
      'message', 'Sa centrale a levé le bannissement de ce chauffeur : classez le signalement.');
  end if;
  perform private.set_actor('super_admin', p_actor);

  -- Fiches qui partagent une identité : même centrale (automatique), autres centrales confirmées / écartées
  select coalesce(array_agg(distinct c.driver_id) filter (where c.same_org), '{}') into v_same
  from private.fraud_report_carriers(f.id) c;
  with c as (select * from private.fraud_report_carriers(f.id) k where not (k.driver_id = any (v_same)))
  select coalesce(array_agg(distinct c.driver_id) filter (where c.driver_id = any (v_extend)), '{}'),
         coalesce(array_agg(distinct c.driver_id) filter (where not (c.driver_id = any (v_extend))), '{}'),
         coalesce(array_agg(distinct c.kind || ':' || c.value_hash) filter (where not (c.driver_id = any (v_extend))), '{}')
    into v_confirmed, v_skipped, v_blocked
  from c;

  -- Client à bord d'une fiche visée : rien n'est fait (même règle que ban_driver)
  select string_agg(distinct format('%s %s (#%s)', d.first_name, d.last_name, d.number), ', ') into v_onboard
  from public.drivers d
  join public.rides r on r.driver_id = d.id and r.status in ('PASSENGER_ONBOARD', 'IN_PROGRESS')
  where d.deleted_at is null
    and d.ban_scope is distinct from 'platform'
    and (d.id = f.driver_id or d.id = any (v_same) or d.id = any (v_confirmed));
  if v_onboard is not null then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_ON_RIDE',
      'message', 'Client à bord (' || v_onboard || ') : attendez la fin de la course avant de bannir de la plateforme.');
  end if;

  insert into public.banned_identities (scope, organization_id, kind, value_hash, hint, driver_id, report_id, reason, created_by)
  select 'platform', null, e ->> 'kind', e ->> 'hash', e ->> 'hint', f.driver_id, f.id, f.reason, p_actor
  from jsonb_array_elements(f.identities) e
  where e ->> 'kind' in ('phone', 'email', 'vtc_card', 'driving_license', 'identity_doc', 'plate', 'device')
    and e ->> 'hash' ~ '^[0-9a-f]{64}$'
    and not (((e ->> 'kind') || ':' || (e ->> 'hash')) = any (v_blocked))
  on conflict do nothing;
  get diagnostics v_count = row_count;

  select count(*) into v_identities_skipped
  from jsonb_array_elements(f.identities) e
  where ((e ->> 'kind') || ':' || (e ->> 'hash')) = any (v_blocked);

  update public.fraud_reports
     set status = 'platform_banned', reviewed_by = p_actor, reviewed_at = now(), review_note = v_note
   where id = f.id;

  -- Chauffeur signalé, fiches de sa centrale et fiches confirmées d'autres centrales ; fiches supprimées exclues
  -- (anonymes, non modifiables)
  for x in
    select d.id, d.user_id, d.organization_id
    from public.drivers d
    where d.deleted_at is null
      and d.ban_scope is distinct from 'platform'
      and (d.id = f.driver_id or d.id = any (v_same) or d.id = any (v_confirmed))
  loop
    for v_ride in
      select r.id, r.organization_id from public.rides r
      where r.driver_id = x.id and r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED')
      order by r.pickup_at
    loop
      -- Réseau partagé : course d'une autre organisation (confiée à ce chauffeur) rendue à son organisation, qui la
      -- relance (private.unassign_network_ride, « executor_unavailable ») ; jamais un UPDATE direct de rides.driver_id
      if v_ride.organization_id <> x.organization_id then
        if coalesce((private.unassign_network_ride(x.id, v_ride.id, 'executor_unavailable') ->> 'ok')::boolean, false) then
          v_reassigned := v_reassigned + 1;
        end if;
      elsif coalesce((private.platform_unassign_ride(v_ride.id, 'Chauffeur banni de la plateforme Rydar', p_actor) ->> 'ok')::boolean, false) then
        v_reassigned := v_reassigned + 1;
      end if;
    end loop;
    update public.drivers
       set status = case when status = 'inactive' then 'inactive' else 'suspended' end::public.driver_status,
           presence = 'offline',
           online_since = null,
           current_ride_id = null,
           banned_at = coalesce(banned_at, now()),
           banned_by = coalesce(banned_by, p_actor),
           ban_reason = coalesce(ban_reason, 'Banni de la plateforme Rydar'),
           ban_scope = 'platform',
           ban_report_id = f.id,
           suspended_reason = 'Banni de la plateforme Rydar',
           application_status = case when application_status = 'pending' then 'rejected' else application_status end
     where id = x.id;
    update public.ride_offers
       set status = 'closed', closed_reason = 'driver_banned', responded_at = now()
     where driver_id = x.id and status = 'pending';
    if x.user_id is not null then
      if private.keeps_login_account(x.user_id) then
        v_kept := v_kept || x.user_id;
      else
        v_users := v_users || x.user_id;
      end if;
    end if;
    v_drivers := v_drivers + 1;
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
    values (x.organization_id, 'super_admin', p_actor, 'driver.platform_banned', 'drivers', x.id::text, 'critical',
      jsonb_build_object('report_id', f.id, 'extended', x.id = any (v_confirmed),
        'login_kept', x.user_id is not null and x.user_id = any (v_kept)));
  end loop;

  return jsonb_build_object('ok', true, 'code', 'PLATFORM_BANNED', 'identities', v_count,
    'identities_skipped', v_identities_skipped, 'drivers', v_drivers, 'reassigned_rides', v_reassigned,
    'extended', coalesce(cardinality(v_confirmed), 0), 'skipped_drivers', coalesce(cardinality(v_skipped), 0),
    'user_ids', to_jsonb(v_users), 'kept_user_ids', to_jsonb(v_kept),
    'message', case when v_identities_skipped > 0
      then 'Banni de la plateforme, sauf les identités partagées avec des fiches d''autres centrales non confirmées.'
      else 'Banni de toute la plateforme.' end);
end;
$$;

-- Dernière définition : 20260924006650_audit_fixes.sql (corps gardé À L'IDENTIQUE). Réseau partagé, seul ajout : les
-- courses d'autres organisations tenues par ses chauffeurs (en route, client à bord) comptent dans DRIVER_ON_RIDE —
-- suspendue, l'organisation passerait ses chauffeurs hors ligne en pleine course partenaire (alerte chez A, course
-- bloquée). Courses de l'organisation tenues par des partenaires : déjà comptées (r.organization_id).
create or replace function public.svc_platform_set_org_status(p_org uuid, p_actor uuid, p_status text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
  v_busy integer := 0;
  v_offers uuid[] := '{}';
  v_drivers integer := 0;
  v_upcoming integer := 0;
begin
  perform private.assert_platform_actor(p_actor);
  if p_status is null or p_status not in ('active', 'suspended', 'archived') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_STATUS', 'message', 'Statut invalide.');
  end if;
  select * into o from public.organizations where id = p_org for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Organisation introuvable.');
  end if;
  if p_status <> 'active' then
    select count(*) into v_busy
      from public.rides r
     where (r.organization_id = p_org
            -- Réseau partagé : course d'une autre organisation tenue par un de ses chauffeurs (même règle)
            or r.driver_org_id = p_org)
       and r.driver_id is not null
       and (r.status in ('DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS')
            or (r.status = 'ACCEPTED' and r.type = 'instant'));
    if v_busy > 0 then
      return jsonb_build_object('ok', false, 'code', 'DRIVER_ON_RIDE', 'count', v_busy,
        'message', private.fr_typo(format('%s %s : chauffeur en route ou client à bord. Attendez la fin (ou faites annuler) avant de %s cette organisation.',
          v_busy, private.pl(v_busy, 'course en cours', 'courses en cours'),
          case p_status when 'archived' then 'archiver' else 'suspendre' end)));
    end if;
  end if;
  perform private.set_actor('super_admin', p_actor);

  update public.organizations
     set status = p_status::public.org_status,
         suspended_at = case p_status when 'suspended' then now() when 'active' then null else suspended_at end,
         suspended_reason = case p_status when 'suspended' then v_reason when 'active' then null else suspended_reason end,
         archived_at = case p_status when 'archived' then now() when 'active' then null else archived_at end
   where id = p_org;

  if p_status <> 'active' then
    with closed as (
      update public.ride_offers x
         set status = 'closed', closed_reason = 'org_suspended', responded_at = now()
       where x.organization_id = p_org and x.status = 'pending'
      returning x.driver_id
    )
    select coalesce(array_agg(distinct closed.driver_id), '{}') into v_offers from closed;
    update public.notifications n
       set status = 'cancelled', last_error = 'org_suspended'
     where n.organization_id = p_org and n.status = 'queued' and n.type in ('ride_offer', 'ride_offer_scheduled');
    update public.drivers
       set presence = 'offline', online_since = null
     where organization_id = p_org and presence <> 'offline';
    get diagnostics v_drivers = row_count;
    select count(*) into v_upcoming
      from public.rides r
     where r.organization_id = p_org and r.status = 'ACCEPTED' and r.driver_id is not null;
  end if;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, 'super_admin', p_actor, 'organization.' || p_status, 'organizations', p_org::text,
    case when p_status = 'active' then 'info' else 'warning' end,
    jsonb_build_object('reason', v_reason, 'previous_status', o.status, 'closed_offers', cardinality(v_offers),
      'drivers_offline', v_drivers, 'upcoming_rides', v_upcoming));

  return jsonb_build_object('ok', true, 'code', 'UPDATED', 'status', p_status, 'closed_offers', cardinality(v_offers),
    'drivers_offline', v_drivers, 'upcoming_rides', v_upcoming,
    'message', case when v_upcoming > 0
      then private.fr_typo(format('Statut enregistré. %s %s à venir %s attribuée%s : la centrale ne peut pas la%s servir tant qu''elle n''est pas réactivée.',
        v_upcoming, private.pl(v_upcoming, 'course', 'courses'), private.pl(v_upcoming, 'reste', 'restent'),
        case when v_upcoming > 1 then 's' else '' end, case when v_upcoming > 1 then 's' else '' end))
      else 'Statut enregistré.' end);
end;
$$;
