-- =============================================================================
-- Rydar Drive — Réseau partagé, lot 4 : argent. Interrupteur plateforme COUPÉ.
--
-- Partie 4a (spécification §10.1 à §10.4, §11.2) : règlement réseau créé à la fin d'une course de A exécutée par un
-- chauffeur de B, sérialisation et diffusion (A : settlement_json avec son bloc « network » ; chauffeur :
-- driver:{network_driver_id}, jamais settlement_json ni org:{B}), côté chauffeur (règlements partenaires par
-- organisation, déclaration de paiement avec les SEULS moyens de A, « Je conteste », coordonnées de versement),
-- accueil et gains du chauffeur (net PAR COURSE avec les termes figés). La partie 4b (côté A, blocages, relances,
-- frais Rydar, exports) complète ce fichier.
--
-- Décisions du propriétaire appliquées :
--  * Q1 : le chauffeur partenaire est traité comme les chauffeurs de A ; B ne prend rien. Montants = termes figés à
--    l'acceptation (ride_network_executions.terms, private.network_terms du lot 3) : A centrale, part de A = commission
--    + frais Rydar ; A flotte, part de A = frais Rydar seulement. Le chauffeur ne voit jamais « frais Rydar » ni
--    « commission » : un seul montant « part de {A} » (giver_part_cents) à côté de sa part (driver_part_cents) ;
--  * Q2 : contrepartie TOUJOURS le chauffeur (constante 'driver', contrainte du schéma 006700) : payé à bord → il
--    reverse la part de A à A avec les moyens de paiement de A (échéance : délai de A, au moins 48 h) ; prépayé → A
--    lui verse sa part (7 jours ; retenue tant que la course est « à vérifier », hold_until de l'exécution) ;
--  * une ligne réseau a driver_id NULL : toutes les fonctions des règlements propres (driver_settlements,
--    driver_declare_payment, driver_home().settlement, blocages propres, relances) l'ignorent par construction.
-- Interrupteur coupé et aucune course partagée : aucune ligne réseau, réponses des fonctions redéfinies identiques
-- (clés « network » ajoutées seulement quand il y a du réseau à montrer).
-- =============================================================================

-- =============================================================================
-- 1. Aides (private, sans definer : appelées par des fonctions privilégiées)
-- =============================================================================

-- Échéance d'un reversement par le chauffeur partenaire : délai de A (settlement_grace_hours, 24 h par défaut), au
-- moins 48 h (NETWORK_PARAMS.minDriverGraceHours) — un partenaire ne passe pas aux bureaux de A.
create or replace function private.network_grace_hours(p_org uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select greatest(coalesce((select s.settlement_grace_hours from public.organization_settings s
                             where s.organization_id = p_org), 24), 48);
$$;

-- Part du chauffeur d'une course partenaire : termes figés de l'exécution en cours ou terminée (jamais les colonnes
-- vivantes de la course, qui portent la répartition des chauffeurs de A). NULL sans exécution.
create or replace function private.network_driver_part(p_ride uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select (e.terms ->> 'driver_payout_cents')::integer
    from public.ride_network_executions e
   where e.ride_id = p_ride
     and (e.ended_at is null or e.end_reason = 'completed')
   order by e.accepted_at desc
   limit 1;
$$;

-- IBAN valide : format du schéma (driver_payout_details_iban_check) et clé ISO 13616 (mod 97 = 1). Miroir de
-- isValidIban (@rydar/shared, format.ts) ; p_iban déjà normalisé (majuscules, sans espace).
create or replace function private.iban_ok(p_iban text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_moved text;
  v_ch text;
  v_rest integer := 0;
begin
  if p_iban is null or p_iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$' then
    return false;
  end if;
  v_moved := substr(p_iban, 5) || substr(p_iban, 1, 4);
  foreach v_ch in array regexp_split_to_array(v_moved, '') loop
    v_rest := ((v_rest::text || case when v_ch between 'A' and 'Z' then (ascii(v_ch) - 55)::text else v_ch end)::bigint
               % 97)::integer;
  end loop;
  return v_rest = 1;
end;
$$;

-- Empreinte du RIB d'un chauffeur (driver_payout_details.iban_hash, ride_network_executions.payout_iban_hash) :
-- salée par le chauffeur (un même IBAN n'a pas la même empreinte d'un chauffeur à l'autre). Jamais lisible côté client.
create or replace function private.payout_iban_hash(p_driver uuid, p_iban text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to('rydar:payout:' || p_driver::text || ':' || p_iban, 'UTF8')), 'hex');
$$;

-- « Je conteste » encore possible sur une ligne réseau (une fois par ligne ; ne change ni le statut ni les blocages,
-- A reste seule juge de ses encaissements, §10.4) :
--  * reversement (driver_owes) marqué « Pas reçu » par A (« j'ai bien payé »), encore ouvert ;
--  * versement de A (centrale_owes) signalé versé (« pas reçu »), annulé (contestation de la course par A) ou échu.
create or replace function private.network_settlement_disputable(x public.ride_settlements)
returns boolean
language sql
stable
set search_path = ''
as $$
  select x.network_driver_org_id is not null
     and x.driver_disputed_at is null
     and case x.direction
           when 'driver_owes' then x.disputed_at is not null and x.status in ('disputed', 'declared')
           else x.status in ('paid', 'waived') or (x.status = 'due' and x.due_at <= now())
         end;
$$;

-- Ligne réseau vue par le chauffeur (contrat DriverNetworkSettlementItem de @rydar/shared) : UN montant par sens — sa
-- part (driver_part_cents) et la part de A (giver_part_cents = commission + frais Rydar de A, jamais détaillés, U4) —,
-- communes seulement (l'adresse exacte n'est plus montrée après la course). Aussi la charge utile de
-- « settlement.updated » sur driver:{network_driver_id}.
create or replace function private.network_settlement_item(x public.ride_settlements)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', x.id,
    'ride_id', x.ride_id,
    'reference', x.reference,
    'direction', x.direction,
    'amount_cents', x.amount_cents,
    'price_cents', x.price_cents,
    'driver_part_cents', x.driver_payout_cents,
    'giver_part_cents', x.commission_cents + x.platform_fee_cents,
    'currency', x.currency,
    'payment_method', x.payment_method,
    'status', x.status,
    'overdue', x.direction = 'driver_owes' and x.status = 'due' and x.due_at <= now(),
    'on_hold', h.held,
    'hold_until', case when h.held then h.hold_until end,
    'due_at', x.due_at,
    'declared_at', x.declared_at,
    'declared_method', x.declared_method,
    'settled_at', x.settled_at,
    'settled_method', x.settled_method,
    'disputed_at', x.disputed_at,
    'driver_disputed_at', x.driver_disputed_at,
    'driver_dispute_reason', x.driver_dispute_reason,
    'can_dispute', private.network_settlement_disputable(x),
    'ride', jsonb_build_object(
      'number', r.number,
      'pickup', coalesce(private.address_area(r.pickup_address), '—'),
      'dropoff', coalesce(private.address_city(r.dropoff_address), private.address_area(r.dropoff_address), '—'),
      'completed_at', r.completed_at))
  from (select e.hold_until,
               x.direction = 'centrale_owes' and x.status = 'due' and coalesce(e.hold_until > now(), false) as held
          from (select 1) one
          left join public.ride_network_executions e on e.id = x.network_execution_id) h
  left join public.rides r on r.id = x.ride_id;
$$;

-- Coordonnées de versement du chauffeur (contrat DriverPayoutInfo) : IBAN TOUJOURS masqué (4 derniers caractères ; il
-- se ressaisit en entier pour être modifié) ; in_use : versement réseau de A encore ouvert (suppression refusée).
create or replace function private.driver_payout_json(p_driver uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'configured', p.driver_id is not null,
    'payee_name', p.payee_name,
    'iban_last4', right(p.iban, 4),
    'bic', p.bic,
    'updated_at', p.updated_at,
    'in_use', exists (
      select 1 from public.ride_settlements x
       where x.network_driver_id = p_driver
         and x.network_driver_org_id is not null
         and x.direction = 'centrale_owes'
         and x.status in ('due', 'declared', 'disputed')))
  from (select 1) one
  left join public.driver_payout_details p on p.driver_id = p_driver;
$$;

-- Lisibilité côté chauffeur (contrat NetworkDriverReadiness ; codes et ordre de DRIVER_NETWORK_READINESS_CODES) : TOUTES
-- les conditions manquantes, chacune une fois, mêmes règles que private.network_driver_reason (lot 3) hors des
-- conditions propres à une course ou à une donneuse (identité, créneau, blocages envers A). Documents : validés et
-- valables aujourd'hui (fuseau de B). Avertissement « terms_grace » : conditions précédentes acceptées, encore valables
-- jusqu'à la fin de la grâce. Les RPC de lisibilité (driver_network_state, network_driver_readiness, org_network_drivers)
-- l'enveloppent.
create or replace function private.network_driver_readiness(p_driver uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  d public.drivers;
  o public.organizations;
  n public.driver_network_settings;
  p public.platform_settings;
  v_missing text[] := '{}';
  v_warnings text[] := '{}';
  v_reason text;
  v_today date;
  v_type text;
  v_limit integer;
begin
  select * into d from public.drivers x where x.id = p_driver;
  if not found then
    return null;
  end if;
  select * into o from public.organizations x where x.id = d.organization_id;
  select * into n from public.driver_network_settings x where x.driver_id = d.id;
  select * into p from public.platform_settings x where x.id;

  if not public.shared_network_enabled() then
    v_missing := v_missing || 'network_off'::text;
  end if;
  v_reason := private.network_org_reason(d.organization_id, 'in');
  if v_reason is not null and v_reason <> 'network_off' then
    v_missing := v_missing || 'org_reception_off'::text;
  end if;
  if d.status <> 'active' or d.deleted_at is not null then
    v_missing := v_missing || 'inactive'::text;
  end if;
  if n.driver_id is not null and not n.org_allowed then
    v_missing := v_missing || 'org_disallowed'::text;
  end if;
  if n.driver_id is null or not n.enabled then
    v_missing := v_missing || 'driver_off'::text;
  end if;
  if not private.network_terms_ok(n.accepted_version) then
    v_missing := v_missing || 'terms'::text;
  elsif n.accepted_version is distinct from p.network_terms_version then
    v_warnings := v_warnings || 'terms_grace'::text;
  end if;
  if n.capable_at is null or n.capable_at < now() - interval '7 days' then
    v_missing := v_missing || 'app_update'::text;
  end if;
  v_today := (now() at time zone coalesce(o.timezone, 'Europe/Paris'))::date;
  foreach v_type in array array['vtc_card', 'insurance', 'vehicle_registration', 'driving_license'] loop
    if not exists (
      select 1 from public.driver_documents x
       where x.driver_id = d.id
         and x.type = v_type::public.document_type
         and x.status = 'valid'
         and (x.expires_at is null or x.expires_at >= v_today)) then
      v_missing := v_missing || v_type;
    end if;
  end loop;
  if nullif(btrim(coalesce(d.vtc_card_number, '')), '') is null then
    v_missing := v_missing || 'vtc_card_number'::text;
  end if;
  if o.dispatch_model = 'centrale' and nullif(btrim(coalesce(d.vtc_operator_registration, '')), '') is null then
    v_missing := v_missing || 'operator_registration'::text;
  end if;
  if n.excluded_until is not null and n.excluded_until > now() then
    v_missing := v_missing || 'excluded_until'::text;
  end if;
  -- Blocages communs à toutes les donneuses (private.network_blocker, montant nul) : dettes propres chez B, plafond de B
  if private.driver_blocker(d.id) is not null then
    v_missing := v_missing || 'blocked:own_unpaid'::text;
  end if;
  select m.executor_credit_limit_cents into v_limit
    from public.network_memberships m where m.organization_id = d.organization_id;
  if v_limit is not null and (
    select coalesce(sum(x.amount_cents), 0) from public.ride_settlements x
     where x.network_driver_id = d.id
       and x.network_driver_org_id is not null
       and x.direction = 'driver_owes'
       and x.status in ('due', 'declared', 'disputed')) > v_limit then
    v_missing := v_missing || 'blocked:executor_limit'::text;
  end if;

  return jsonb_build_object(
    'ready', cardinality(v_missing) = 0,
    'missing', to_jsonb(v_missing),
    'warnings', to_jsonb(v_warnings),
    'terms_grace_until', case when 'terms_grace' = any (v_warnings) then p.network_terms_grace_until end,
    'excluded_until', case when n.excluded_until > now() then n.excluded_until end);
end;
$$;

-- Bloc « network » de driver_home() (contrat DriverHomeNetwork) : sommes ouvertes des courses partenaires (à régler,
-- dont en retard ; à recevoir, hors retenue), organisations concernées (créancières ET débitrices) avec leur blocage
-- (private.network_blocker, montant nul) et lisibilité. NULL (clé absente) : réseau fermé et aucune somme partenaire
-- ouverte — réponse de driver_home() inchangée.
create or replace function private.driver_home_network(d public.drivers)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_totals record;
  v_creditors jsonb;
begin
  if not public.shared_network_enabled() and not exists (
    select 1 from public.ride_settlements x
     where x.network_driver_id = d.id
       and x.network_driver_org_id is not null
       and x.status in ('due', 'declared', 'disputed')) then
    return null;
  end if;

  with open_lines as (
    select x.organization_id, x.direction, x.status, x.amount_cents, x.due_at,
           coalesce(e.hold_until > now(), false) as held
      from public.ride_settlements x
      left join public.ride_network_executions e on e.id = x.network_execution_id
     where x.network_driver_id = d.id
       and x.network_driver_org_id is not null
       and x.status in ('due', 'declared', 'disputed')
  ),
  per_org as (
    select l.organization_id,
           coalesce(sum(l.amount_cents) filter (where l.direction = 'driver_owes' and l.status in ('due', 'disputed')), 0)::integer as owed,
           coalesce(sum(l.amount_cents) filter (where l.direction = 'driver_owes'
             and (l.status = 'disputed' or (l.status = 'due' and l.due_at <= now()))), 0)::integer as overdue,
           coalesce(sum(l.amount_cents) filter (where l.direction = 'centrale_owes' and l.status = 'due' and not l.held), 0)::integer as payout
      from open_lines l
     group by l.organization_id
  )
  select coalesce(sum(g.owed), 0)::integer as owed, coalesce(sum(g.overdue), 0)::integer as overdue,
         coalesce(sum(g.payout), 0)::integer as payout,
         coalesce(jsonb_agg(jsonb_build_object(
             'id', o.id, 'name', o.name, 'owed_cents', g.owed, 'overdue_cents', g.overdue,
             'blocked', private.network_blocker(d.id, o.id, 0))
           order by g.overdue desc, g.owed desc, g.payout desc, o.name) filter (where o.id is not null), '[]'::jsonb) as creditors
    into v_totals
    from per_org g
    join public.organizations o on o.id = g.organization_id;

  return jsonb_build_object(
    'owed_cents', coalesce(v_totals.owed, 0),
    'overdue_cents', coalesce(v_totals.overdue, 0),
    'payout_due_cents', coalesce(v_totals.payout, 0),
    'creditors', coalesce(v_totals.creditors, '[]'::jsonb),
    'readiness', private.network_driver_readiness(d.id));
end;
$$;

-- =============================================================================
-- 2. Création du règlement réseau à la fin de course (§10.3, S1, C5, C7)
-- =============================================================================
-- Course de A terminée par un chauffeur de B (private.sync_ride_settlement l'y envoie, avant toute logique propre) :
-- termes figés de l'exécution close « completed » (G10, rides_c_network, s'exécute avant rides_d_settlement), JAMAIS
-- les colonnes vivantes de la course ; montant = terms.amount_cents (0 : pas de ligne) ; driver_id NULL, chauffeur et
-- organisation exécutante dans les colonnes network_* ; libellé « Prénom I. · {B} » (jamais le nom de famille ni le n°
-- interne, S3) ; référence « R{n° de course} » ; échéance :
--  * driver_owes (payé à bord) : délai de A, au moins 48 h ;
--  * centrale_owes (prépayé) : 7 jours, et pas avant la fin de la retenue d'une course « à vérifier » (hold_until).
-- Empreinte du RIB du chauffeur posée sur l'exécution (versement prépayé ; alerte « IBAN modifié » chez A, S16).
-- Notification au chauffeur (ligne chez A, data.network = true, aucun montant interne), journal chez A sans
-- identifiant du chauffeur, diffusion (org:{A} : settlement_json ; driver:{chauffeur} : son élément). Jamais
-- private.maybe_promote_driver (niveau de confiance de la fiche de B inchangé). Une seule fois : pas de recalcul
-- ensuite (prix verrouillé, G6).
create or replace function private.sync_network_settlement(r public.rides, p_old public.rides)
returns void
language plpgsql
set search_path = ''
as $$
declare
  e public.ride_network_executions;
  g public.organizations;
  b public.organizations;
  x public.ride_settlements;
  v_amount integer;
  v_direction text;
  v_due timestamptz;
  v_held boolean;
  v_label text;
begin
  if r.status <> 'COMPLETED' or p_old.status = 'COMPLETED' or r.driver_id is null then
    return;
  end if;
  if current_setting('rydar.bypass_ride_rules', true) = 'on' and auth.role() is null then
    return;   -- import / seed : pas de règlement automatique (comme les règlements propres)
  end if;
  select * into e from public.ride_network_executions y
   where y.ride_id = r.id and y.end_reason = 'completed'
   order by y.ended_at desc
   limit 1;
  if not found or e.executor_driver_id is null then
    return;
  end if;
  v_amount := coalesce((e.terms ->> 'amount_cents')::integer, 0);
  v_direction := e.terms ->> 'direction';
  if v_amount <= 0 or v_direction is null then
    return;
  end if;
  select * into g from public.organizations y where y.id = r.organization_id;
  select * into b from public.organizations y where y.id = e.executor_org_id;
  v_held := v_direction = 'centrale_owes' and coalesce(e.hold_until > now(), false);
  v_due := case when v_direction = 'driver_owes'
                then now() + make_interval(hours => private.network_grace_hours(r.organization_id))
                else greatest(now() + interval '7 days', coalesce(e.hold_until, now())) end;
  v_label := left(e.driver_label || ' · ' || coalesce(nullif(btrim(e.operator ->> 'name'), ''), b.name, 'partenaire'), 200);

  insert into public.ride_settlements (organization_id, ride_id, driver_id, driver_label, direction, amount_cents,
    price_cents, commission_cents, platform_fee_cents, driver_payout_cents, currency, payment_method, reference, due_at,
    network_driver_id, network_driver_org_id, network_execution_id, network_counterparty)
  values (r.organization_id, r.id, null, v_label, v_direction, v_amount,
    (e.terms ->> 'price_cents')::integer, (e.terms ->> 'commission_cents')::integer,
    (e.terms ->> 'platform_fee_cents')::integer, (e.terms ->> 'driver_payout_cents')::integer,
    coalesce(r.currency, g.currency, 'EUR'), (e.terms ->> 'payment_method')::public.payment_method,
    'R' || r.number::text, v_due,
    e.executor_driver_id, e.executor_org_id, e.id, e.counterparty)
  on conflict (ride_id) do nothing
  returning * into x;
  if not found then
    return;
  end if;

  -- Versement prépayé : empreinte du RIB du chauffeur à cet instant (posée une fois, G2)
  if v_direction = 'centrale_owes' then
    update public.ride_network_executions y
       set payout_iban_hash = p.iban_hash, payout_iban_at = now()
      from public.driver_payout_details p
     where y.id = e.id and p.driver_id = e.executor_driver_id and y.payout_iban_hash is null;
  end if;

  if v_direction = 'driver_owes' then
    perform private.log_event(r.organization_id, r.id, 'settlement.due',
      format('%s à reverser par le chauffeur partenaire %s — à régler avant %s', private.fmt_eur(v_amount), v_label,
        private.fmt_local_time(v_due, g.timezone, now())),
      'timeline', 'info',
      jsonb_build_object('settlement_id', x.id, 'amount_cents', v_amount, 'commission_cents', x.commission_cents,
        'platform_fee_cents', x.platform_fee_cents, 'driver_payout_cents', x.driver_payout_cents, 'due_at', v_due,
        'network', true, 'execution_id', e.id),
      'system', null);
    perform private.queue_notification(r.organization_id, e.executor_driver_id, r.id, null, 'settlement_due',
      'À RÉGLER À ' || g.name,
      format('Course #%s · %s à régler à %s avant %s', r.number, private.fmt_eur(v_amount), g.name,
        private.fmt_local_time(v_due, coalesce(b.timezone, g.timezone), now())),
      jsonb_build_object('type', 'settlement_due', 'network', true, 'settlement_id', x.id, 'ride_id', r.id,
        'amount_cents', v_amount),
      'normal', null);
  else
    perform private.log_event(r.organization_id, r.id, 'settlement.payout_due',
      format('%s à verser au chauffeur partenaire %s — course déjà payée%s', private.fmt_eur(v_amount), v_label,
        case when v_held
             then format(' ; course à vérifier : versement retenu jusqu''au %s',
                         to_char(e.hold_until at time zone coalesce(g.timezone, 'Europe/Paris'), 'DD/MM à HH24:MI'))
             else '' end),
      'timeline', 'info',
      jsonb_build_object('settlement_id', x.id, 'amount_cents', v_amount, 'commission_cents', x.commission_cents,
        'platform_fee_cents', x.platform_fee_cents, 'due_at', v_due, 'network', true, 'execution_id', e.id,
        'on_hold', v_held),
      'system', null);
    perform private.queue_notification(r.organization_id, e.executor_driver_id, r.id, null, 'settlement_payout',
      'GAIN À RECEVOIR DE ' || g.name,
      format('Course #%s · %s vous seront versés par %s%s', r.number, private.fmt_eur(v_amount), g.name,
        case when v_held then ' après vérification de la course' else '' end),
      jsonb_build_object('type', 'settlement_payout', 'network', true, 'settlement_id', x.id, 'ride_id', r.id,
        'amount_cents', v_amount),
      'normal', null);
  end if;
  perform private.broadcast_settlement(x, 'created');
end;
$$;

-- Dernière définition : 20260924004400_audit_argent.sql. Réseau partagé — seul ajout, en PREMIÈRE instruction : course
-- tenue par un chauffeur d'une autre organisation → private.sync_network_settlement (termes figés), et la logique
-- propre ne voit jamais une course partagée (auparavant : 23503 pour une A centrale, clé (organization_id, driver_id)
-- vers drivers ; rien pour une A flotte). Course propre : corps identique.
create or replace function private.sync_ride_settlement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  s public.organization_settings;
  d public.drivers;
  x public.ride_settlements;
  v_split record;
  v_direction text;
  v_amount integer;
  v_due timestamptz;
  v_grace integer;
  v_was_waived boolean;
  v_reset boolean;
begin
  -- Réseau partagé : règlement réseau (termes figés de l'exécution), jamais la logique propre
  if new.driver_org_id is not null and new.driver_org_id <> new.organization_id then
    perform private.sync_network_settlement(new, old);
    return null;
  end if;

  if new.status <> 'COMPLETED' or new.driver_id is null or new.price_cents is null then
    return null;
  end if;
  if current_setting('rydar.bypass_ride_rules', true) = 'on' and auth.role() is null then
    return null;   -- import / seed : pas de règlement automatique
  end if;

  -- Répartition de la course ; à défaut (course créée avant le passage en mode centrale), calculée maintenant
  if new.driver_payout_cents is not null then
    select new.commission_cents as commission_cents, new.platform_fee_cents as platform_fee_cents,
           new.driver_payout_cents as driver_payout_cents, null::text as error
      into v_split;
  else
    select * into v_split from private.compute_ride_split(new.organization_id, new.price_cents, null);
  end if;
  v_direction := private.settlement_direction(new.payment_method);
  v_amount := case when v_direction = 'driver_owes'
                   then coalesce(v_split.commission_cents, 0) + coalesce(v_split.platform_fee_cents, 0)
                   else coalesce(v_split.driver_payout_cents, 0) end;

  select * into x from public.ride_settlements where ride_id = new.id for update;
  if found then
    -- Annulé d'office (ni date ni auteur) : recalculable, en mode centrale seulement (écrans et relances)
    v_was_waived := x.status = 'waived' and x.settled_at is null and x.settled_by is null
      and exists (select 1 from public.organizations g where g.id = new.organization_id and g.dispatch_model = 'centrale');
    if (x.status = 'due' or v_was_waived)
       and (new.price_cents is distinct from old.price_cents
            or new.commission_cents is distinct from old.commission_cents
            or new.payment_method is distinct from old.payment_method) then
      v_reset := v_amount > 0 and (v_direction <> x.direction or v_was_waived);
      if v_reset then
        select * into o from public.organizations where id = new.organization_id;
        select * into s from public.organization_settings where organization_id = new.organization_id;
        v_grace := coalesce(s.settlement_grace_hours, 24);
        v_due := case when v_direction = 'driver_owes' then now() + make_interval(hours => v_grace)
                      else now() + interval '7 days' end;
      end if;
      update public.ride_settlements
         set direction = v_direction,
             amount_cents = v_amount,
             price_cents = new.price_cents,
             commission_cents = coalesce(v_split.commission_cents, 0),
             platform_fee_cents = coalesce(v_split.platform_fee_cents, 0),
             driver_payout_cents = coalesce(v_split.driver_payout_cents, 0),
             payment_method = new.payment_method,
             status = case when v_amount = 0 then 'waived' else 'due' end,
             note = case when v_amount = 0 then 'Montant nul après correction'
                         when v_was_waived then null
                         else note end,
             due_at = case when v_reset then v_due else due_at end,
             reminders_sent = case when v_reset then 0 else reminders_sent end,
             last_reminded_at = case when v_reset then null else last_reminded_at end
       where id = x.id
      returning * into x;
      perform private.log_event(new.organization_id, new.id, 'settlement.updated',
        format('Règlement recalculé : %s %s', private.fmt_eur(v_amount),
          case when v_direction = 'driver_owes' then 'dus par le chauffeur' else 'à verser au chauffeur' end),
        'timeline', 'info',
        jsonb_build_object('settlement_id', x.id, 'amount_cents', v_amount, 'direction', v_direction), 'system', null);
      if v_reset and x.driver_id is not null then
        if v_direction = 'driver_owes' then
          perform private.queue_notification(new.organization_id, x.driver_id, new.id, null, 'settlement_due', 'COMMISSION À RÉGLER',
            format('Course #%s corrigée · %s à régler à %s%s', new.number, private.fmt_eur(v_amount), o.name,
              case when v_grace = 0 then '' else ' avant ' || private.fmt_local_time(v_due, o.timezone, now()) end),
            jsonb_build_object('type', 'settlement_due', 'settlement_id', x.id, 'ride_id', new.id, 'amount_cents', v_amount),
            'normal', null);
        else
          perform private.queue_notification(new.organization_id, x.driver_id, new.id, null, 'settlement_payout', 'GAIN À RECEVOIR',
            format('Course #%s corrigée · %s vous seront versés par %s', new.number, private.fmt_eur(v_amount), o.name),
            jsonb_build_object('type', 'settlement_payout', 'settlement_id', x.id, 'ride_id', new.id, 'amount_cents', v_amount),
            'normal', null);
        end if;
      end if;
      perform private.broadcast_settlement(x, 'updated');
    end if;
    return null;
  end if;

  select * into o from public.organizations where id = new.organization_id;
  if o.dispatch_model is distinct from 'centrale' or v_split.error is not null or v_split.driver_payout_cents is null then
    return null;
  end if;
  select * into s from public.organization_settings where organization_id = new.organization_id;
  select * into d from public.drivers where id = new.driver_id;
  if v_amount <= 0 then
    perform private.maybe_promote_driver(d.id);
    return null;
  end if;

  v_grace := coalesce(s.settlement_grace_hours, 24);
  v_due := case when v_direction = 'driver_owes' then now() + make_interval(hours => v_grace)
                else now() + interval '7 days' end;

  insert into public.ride_settlements (organization_id, ride_id, driver_id, driver_label, direction, amount_cents,
    price_cents, commission_cents, platform_fee_cents, driver_payout_cents, currency, payment_method, reference, due_at)
  values (new.organization_id, new.id, d.id, format('%s %s (#%s)', d.first_name, d.last_name, d.number), v_direction,
    v_amount, new.price_cents, v_split.commission_cents, v_split.platform_fee_cents, v_split.driver_payout_cents,
    new.currency, new.payment_method, 'C' || new.number::text, v_due)
  on conflict (ride_id) do nothing
  returning * into x;
  if not found then
    return null;
  end if;

  if v_direction = 'driver_owes' then
    perform private.log_event(new.organization_id, new.id, 'settlement.due',
      format('Commission de %s due par %s %s (#%s) — %s', private.fmt_eur(v_amount), d.first_name, d.last_name, d.number,
        case when v_grace = 0 then 'à régler maintenant'
             else 'à régler avant ' || private.fmt_local_time(v_due, o.timezone, now()) end),
      'timeline', 'info',
      jsonb_build_object('settlement_id', x.id, 'amount_cents', v_amount, 'commission_cents', x.commission_cents,
        'platform_fee_cents', x.platform_fee_cents, 'driver_payout_cents', x.driver_payout_cents, 'due_at', v_due),
      'system', null);
    perform private.queue_notification(new.organization_id, d.id, new.id, null, 'settlement_due', 'COMMISSION À RÉGLER',
      format('Course #%s · %s à régler à %s%s', new.number, private.fmt_eur(v_amount), o.name,
        case when v_grace = 0 then '' else ' avant ' || private.fmt_local_time(v_due, o.timezone, now()) end),
      jsonb_build_object('type', 'settlement_due', 'settlement_id', x.id, 'ride_id', new.id, 'amount_cents', v_amount),
      'normal', null);
  else
    perform private.log_event(new.organization_id, new.id, 'settlement.payout_due',
      format('%s à verser à %s %s (#%s) — course payée à la centrale', private.fmt_eur(v_amount), d.first_name,
        d.last_name, d.number),
      'timeline', 'info',
      jsonb_build_object('settlement_id', x.id, 'amount_cents', v_amount, 'commission_cents', x.commission_cents,
        'platform_fee_cents', x.platform_fee_cents), 'system', null);
    perform private.queue_notification(new.organization_id, d.id, new.id, null, 'settlement_payout', 'GAIN À RECEVOIR',
      format('Course #%s · %s vous seront versés par %s', new.number, private.fmt_eur(v_amount), o.name),
      jsonb_build_object('type', 'settlement_payout', 'settlement_id', x.id, 'ride_id', new.id, 'amount_cents', v_amount),
      'normal', null);
    perform private.maybe_promote_driver(d.id);
  end if;
  perform private.broadcast_settlement(x, 'created');
  return null;
end;
$$;

-- =============================================================================
-- 3. Sérialisation et diffusion (§10.3, §10.5, §13)
-- =============================================================================

-- Dernière définition : 20260924004400_audit_argent.sql. Réseau partagé — seul ajout : ligne réseau
-- (network_driver_org_id non NULL, vue par A) → bloc « network » (contrat SettlementNetworkInfo : exécution,
-- contrepartie, nom validé de B, libellé court du chauffeur, retenue, raisons « à vérifier », contestations, RIB
-- renseigné ou non — jamais l'IBAN ni son empreinte). Ligne propre : objet identique (pas de clé « network »).
create or replace function private.settlement_json(x public.ride_settlements)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', x.id,
    'ride_id', x.ride_id,
    'driver_id', x.driver_id,
    'driver_label', x.driver_label,
    'direction', x.direction,
    'amount_cents', x.amount_cents,
    'price_cents', x.price_cents,
    'commission_cents', x.commission_cents,
    'platform_fee_cents', x.platform_fee_cents,
    'driver_payout_cents', x.driver_payout_cents,
    'currency', x.currency,
    'payment_method', x.payment_method,
    'reference', x.reference,
    'status', x.status,
    'overdue', x.direction = 'driver_owes' and x.status = 'due' and x.due_at <= now(),
    'blocking', x.direction = 'driver_owes' and x.amount_cents > 0
      and (x.status = 'disputed' or (x.status = 'due' and x.due_at <= now())
           or (x.status = 'declared' and x.disputed_at is not null)),
    'due_at', x.due_at,
    'declared_at', x.declared_at,
    'declared_method', x.declared_method,
    'declared_note', x.declared_note,
    'disputed_at', x.disputed_at,
    'settled_at', x.settled_at,
    'settled_method', x.settled_method,
    'note', x.note,
    'reminders_sent', x.reminders_sent,
    'last_reminded_at', x.last_reminded_at,
    'created_at', x.created_at,
    'updated_at', x.updated_at
  )
  -- Réseau partagé : bloc « network » des lignes réseau seulement
  || case when x.network_driver_org_id is null then '{}'::jsonb else jsonb_build_object('network', (
    select jsonb_build_object(
      'execution_id', e.id,
      'counterparty', e.counterparty,
      'partner_name', coalesce(e.operator ->> 'name', ''),
      'driver_label', e.driver_label,
      'on_hold', x.direction = 'centrale_owes' and x.status = 'due' and coalesce(e.hold_until > now(), false),
      'hold_until', e.hold_until,
      'suspect_reasons', to_jsonb(e.suspect_reasons),
      'contested', e.contested_at is not null,
      'driver_disputed', x.driver_disputed_at is not null,
      'driver_dispute_reason', x.driver_dispute_reason,
      'payout_configured', case when x.direction = 'centrale_owes' then exists (
        select 1 from public.driver_payout_details p where p.driver_id = x.network_driver_id) end)
      from public.ride_network_executions e
     where e.id = x.network_execution_id)) end;
$$;

-- Dernière définition : 20260924002600_centrale_mode.sql. Réseau partagé — seul ajout : ligne réseau → le chauffeur
-- partenaire reçoit sur driver:{network_driver_id} son élément (contrat DriverNetworkSettlementEvent : un montant par
-- sens, jamais settlement_json qui détaille la commission et les frais Rydar de A, U4) ; jamais org:{B}. org:{A} :
-- settlement_json (bloc « network » compris), comme avant.
create or replace function private.broadcast_settlement(x public.ride_settlements, p_action text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb := jsonb_build_object('action', p_action, 'settlement', private.settlement_json(x));
begin
  perform realtime.send(v_payload, 'settlement.updated', 'org:' || x.organization_id::text, true);
  if x.driver_id is not null then
    perform realtime.send(v_payload, 'settlement.updated', 'driver:' || x.driver_id::text, true);
  end if;
  -- Réseau partagé : le chauffeur partenaire, jamais son organisation
  if x.network_driver_org_id is not null and x.network_driver_id is not null then
    perform realtime.send(jsonb_build_object('action', p_action, 'network', true, 'item', private.network_settlement_item(x)),
      'settlement.updated', 'driver:' || x.network_driver_id::text, true);
  end if;
end;
$$;

-- =============================================================================
-- 4. Coordonnées de versement du chauffeur (§10.4, C19, S16)
-- =============================================================================
-- Indépendantes de l'interrupteur (NETWORK_CLOSED_RPCS : sommes en cours réglées même réseau fermé). Portée :
-- private.current_driver_id() (fiche active, organisation active). Aucune écriture client sur driver_payout_details
-- (table sans droits) : ces RPC seulement.

create or replace function public.driver_payout_info()
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
  return private.driver_payout_json(v_driver);
end;
$$;

-- Titulaire (2 à 120 caractères), IBAN complet (clé contrôlée), BIC facultatif (8 ou 11) ; espaces retirés, majuscules.
-- Même saisie qu'avant : rien ne change (updated_at gardé : pas de fausse alerte « RIB modifié » chez A). Changement :
-- nouvelle empreinte (iban_hash), updated_at, audit chez B sans aucune coordonnée (« warning » si un versement est en
-- cours : A est avertie par org_network_payout_info).
create or replace function public.driver_set_payout_details(p_payee text, p_iban text, p_bic text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  p public.driver_payout_details;
  v_payee text := nullif(btrim(regexp_replace(coalesce(p_payee, ''), '\s+', ' ', 'g')), '');
  v_iban text := upper(regexp_replace(coalesce(p_iban, ''), '\s+', '', 'g'));
  v_bic text := nullif(upper(regexp_replace(coalesce(p_bic, ''), '\s+', '', 'g')), '');
  v_changed boolean;
  v_iban_changed boolean;
  v_info jsonb;
begin
  select * into d from public.drivers where id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  if v_payee is null or char_length(v_payee) not between 2 and 120 or v_payee ~ '[[:cntrl:]]'
     or not private.iban_ok(v_iban)
     or (v_bic is not null and v_bic !~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$') then
    raise exception 'PAYOUT_DETAILS_INVALID: titulaire, IBAN ou BIC invalide' using errcode = '22023';
  end if;

  select * into p from public.driver_payout_details x where x.driver_id = d.id for update;
  v_changed := p.driver_id is null or (p.payee_name, p.iban, p.bic) is distinct from (v_payee, v_iban, v_bic);
  v_iban_changed := p.driver_id is not null and p.iban is distinct from v_iban;
  if v_changed then
    insert into public.driver_payout_details (driver_id, organization_id, payee_name, iban, bic, iban_hash)
    values (d.id, d.organization_id, v_payee, v_iban, v_bic, private.payout_iban_hash(d.id, v_iban))
    on conflict (driver_id) do update
      set payee_name = excluded.payee_name, iban = excluded.iban, bic = excluded.bic, iban_hash = excluded.iban_hash;
  end if;
  v_info := private.driver_payout_json(d.id);
  if v_changed then
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity,
                                   metadata)
    values (d.organization_id, 'driver', auth.uid(), 'driver.payout_details_updated', 'drivers', d.id::text,
            case when v_iban_changed and (v_info ->> 'in_use')::boolean then 'warning' else 'info' end,
            jsonb_build_object('created', p.driver_id is null, 'iban_changed', v_iban_changed,
                               'payout_in_progress', (v_info ->> 'in_use')::boolean));
  end if;
  return v_info;
end;
$$;

-- Suppression refusée tant qu'un versement réseau de A est attendu (PAYOUT_DETAILS_IN_USE, 55000) : modifier reste
-- possible. Rien à supprimer : même réponse.
create or replace function public.driver_delete_payout_details()
returns jsonb
language plpgsql
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
  perform 1 from public.driver_payout_details x where x.driver_id = d.id for update;
  if not found then
    return private.driver_payout_json(d.id);
  end if;
  if (private.driver_payout_json(d.id) ->> 'in_use')::boolean then
    raise exception 'PAYOUT_DETAILS_IN_USE: un versement réseau est encore attendu' using errcode = '55000';
  end if;
  delete from public.driver_payout_details x where x.driver_id = d.id;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity,
                                 metadata)
  values (d.organization_id, 'driver', auth.uid(), 'driver.payout_details_deleted', 'drivers', d.id::text, 'info',
          '{}'::jsonb);
  return private.driver_payout_json(d.id);
end;
$$;

-- =============================================================================
-- 5. Règlements partenaires du chauffeur (§10.4)
-- =============================================================================

-- Contrat DriverNetworkSettlements : un bloc par organisation qui a confié des courses au chauffeur (créancière ou
-- débitrice), avec SES moyens de paiement (lien prérempli et son domaine affiché, virement + RIB de A, espèces, autre +
-- instructions), son délai (au moins 48 h), son blocage éventuel (private.network_blocker, montant nul) et ses lignes
-- (ouvertes, puis les 100 dernières réglées ou annulées des 180 derniers jours). Téléphone de A : tant qu'une ligne est
-- ouverte ou qu'une ligne a bougé ces 48 dernières heures (§11.1). Jamais commission ni frais Rydar (un montant par
-- sens). Indépendante de l'interrupteur (NETWORK_CLOSED_RPCS).
create or replace function public.driver_network_settlements()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  b public.organizations;
  g record;
  s public.organization_settings;
  t record;
  v_ids uuid[];
  v_blocks jsonb := '[]'::jsonb;
  v_items jsonb;
  v_ref text;
  v_link text;
  v_methods text[];
  v_blocked text;
  v_owed integer := 0;
  v_overdue integer := 0;
  v_declared integer := 0;
  v_payout integer := 0;
  v_on_hold integer := 0;
begin
  select * into d from public.drivers where id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  select * into b from public.organizations where id = d.organization_id;

  select coalesce(array_agg(y.id), '{}') into v_ids
    from (select x.id from public.ride_settlements x
           where x.network_driver_id = d.id and x.network_driver_org_id is not null
             and x.status in ('due', 'declared', 'disputed')
          union all
          (select x.id from public.ride_settlements x
            where x.network_driver_id = d.id and x.network_driver_org_id is not null
              and x.status in ('paid', 'waived') and x.created_at > now() - interval '180 days'
            order by x.created_at desc
            limit 100)) y;

  for g in
    select o.id, o.name, o.phone, o.currency, o.timezone, o.legal_name,
           coalesce(sum(x.amount_cents) filter (where x.direction = 'driver_owes' and x.status in ('due', 'disputed')), 0)::integer as owed,
           coalesce(sum(x.amount_cents) filter (where x.direction = 'centrale_owes' and x.status = 'due'), 0)::integer as payout,
           bool_or(x.status in ('due', 'declared', 'disputed') or x.updated_at > now() - interval '48 hours') as phone_ok
      from public.ride_settlements x
      join public.organizations o on o.id = x.organization_id
     where x.id = any (v_ids)
     group by o.id
     order by 7 desc, 8 desc, o.name
  loop
    select * into s from public.organization_settings y where y.organization_id = g.id;
    select coalesce(sum(x.amount_cents) filter (where x.direction = 'driver_owes' and x.status in ('due', 'disputed')), 0)::integer as owed,
           coalesce(sum(x.amount_cents) filter (where x.direction = 'driver_owes'
             and (x.status = 'disputed' or (x.status = 'due' and x.due_at <= now()))), 0)::integer as overdue,
           coalesce(sum(x.amount_cents) filter (where x.direction = 'driver_owes' and x.status = 'declared'), 0)::integer as declared,
           coalesce(sum(x.amount_cents) filter (where x.direction = 'centrale_owes' and x.status = 'due'
             and not coalesce(e.hold_until > now(), false)), 0)::integer as payout,
           coalesce(sum(x.amount_cents) filter (where x.direction = 'centrale_owes' and x.status = 'due'
             and coalesce(e.hold_until > now(), false)), 0)::integer as on_hold,
           coalesce(array_agg(x.id order by x.created_at, x.id)
             filter (where x.direction = 'driver_owes' and x.status in ('due', 'disputed')), '{}') as pay_ids
      into t
      from public.ride_settlements x
      left join public.ride_network_executions e on e.id = x.network_execution_id
     where x.id = any (v_ids) and x.organization_id = g.id;

    v_ref := case
      when cardinality(t.pay_ids) = 1 then (select y.reference from public.ride_settlements y where y.id = t.pay_ids[1])
      when cardinality(t.pay_ids) > 1 then format('RP-%s-%s',
        upper(left(encode(sha256(convert_to('rydar:payref:' || d.id::text || ':' || g.id::text, 'UTF8')), 'hex'), 4)),
        to_char(now() at time zone coalesce(g.timezone, 'Europe/Paris'), 'DDMM'))
    end;
    v_methods := private.settlement_methods_available(s);
    v_link := case when 'link' = any (v_methods) then private.settlement_payment_link(s.settlement_link, t.owed, v_ref) end;
    v_blocked := private.network_blocker(d.id, g.id, 0);

    select coalesce(jsonb_agg(private.network_settlement_item(x)
             order by (x.status in ('due', 'declared', 'disputed')) desc, x.created_at desc, x.id), '[]'::jsonb)
      into v_items
      from public.ride_settlements x
     where x.id = any (v_ids) and x.organization_id = g.id;

    v_blocks := v_blocks || jsonb_build_array(jsonb_build_object(
      'organization', jsonb_build_object('id', g.id, 'name', g.name, 'phone', case when g.phone_ok then g.phone end),
      'currency', coalesce(g.currency, 'EUR'),
      'grace_hours', private.network_grace_hours(g.id),
      'summary', jsonb_build_object('owed_cents', t.owed, 'overdue_cents', t.overdue, 'declared_cents', t.declared,
        'payout_due_cents', t.payout, 'on_hold_cents', t.on_hold),
      'pay', case when t.owed > 0 and cardinality(t.pay_ids) > 0 then jsonb_build_object(
        'amount_cents', t.owed,
        'count', cardinality(t.pay_ids),
        'settlement_ids', to_jsonb(t.pay_ids),
        'reference', v_ref,
        'link', v_link,
        'link_domain', lower((regexp_match(v_link, '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#@]*@)?([^/?#:]+)'))[1]),
        'methods', to_jsonb(v_methods),
        'bank', case when 'transfer' = any (v_methods) and s.settlement_iban is not null then jsonb_build_object(
          'payee_name', coalesce(s.settlement_payee_name, g.legal_name, g.name),
          'iban', s.settlement_iban,
          'bic', s.settlement_bic) end,
        'instructions', s.settlement_instructions) end,
      'blocked', v_blocked,
      'blocked_message', private.network_blocker_message(v_blocked, g.name, b.name),
      'items', v_items));
    v_owed := v_owed + t.owed;
    v_overdue := v_overdue + t.overdue;
    v_declared := v_declared + t.declared;
    v_payout := v_payout + t.payout;
    v_on_hold := v_on_hold + t.on_hold;
  end loop;

  return jsonb_build_object(
    'currency', coalesce(b.currency, 'EUR'),
    'summary', jsonb_build_object('owed_cents', v_owed, 'overdue_cents', v_overdue, 'declared_cents', v_declared,
      'payout_due_cents', v_payout, 'on_hold_cents', v_on_hold),
    'organizations', v_blocks);
end;
$$;

-- « J'ai payé » (contrat DriverDeclareNetworkPaymentResult) : mêmes règles que driver_declare_payment (003800) —
-- lignes à moi, reversements (driver_owes) à régler ou « Pas reçu » ; une redéclaration après « Pas reçu » ne débloque
-- pas (disputed_at gardé) — pour UNE organisation (p_org) : moyen validé contre ses SEULS moyens
-- (private.settlement_methods_available de p_org) ; des lignes d'une autre organisation → refus sans rien changer
-- (FORBIDDEN_TENANT, comme confirm_settlements). Journal de A sans identifiant du chauffeur ; diffusion.
create or replace function public.driver_declare_network_payment(p_org uuid, p_ids uuid[], p_method text,
                                                                 p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  g public.organizations;
  s public.organization_settings;
  x public.ride_settlements;
  v_ids uuid[];
  v_total integer;
  v_note text := left(nullif(btrim(coalesce(p_note, '')), ''), 300);
begin
  select * into d from public.drivers where id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  if p_org is null or coalesce(cardinality(p_ids), 0) = 0 or cardinality(p_ids) > 200 then
    return jsonb_build_object('ok', false, 'code', 'NOTHING_TO_DECLARE', 'message', 'Aucune course à régler.');
  end if;
  if exists (select 1 from public.ride_settlements y
              where y.id = any (p_ids) and y.network_driver_id = d.id and y.network_driver_org_id is not null
                and y.organization_id <> p_org) then
    raise exception 'FORBIDDEN_TENANT: règlements de plusieurs organisations' using errcode = '42501';
  end if;
  -- Lignes de p_org à moi, verrouillées (une confirmation de A en même temps attend ou l'emporte)
  perform 1 from public.ride_settlements y
   where y.id = any (p_ids) and y.organization_id = p_org and y.network_driver_id = d.id
     and y.network_driver_org_id is not null
   order by y.id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOTHING_TO_DECLARE', 'message', 'Aucune course à régler.');
  end if;
  select * into g from public.organizations where id = p_org;
  select * into s from public.organization_settings where organization_id = p_org;
  if p_method is null or not (p_method = any (private.settlement_methods_available(s))) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_METHOD',
      'message', format('Moyen de paiement non accepté par %s.', g.name));
  end if;

  with upd as (
    update public.ride_settlements y
       set status = 'declared', declared_at = now(), declared_method = p_method, declared_note = v_note
     where y.id = any (p_ids)
       and y.organization_id = p_org
       and y.network_driver_id = d.id
       and y.network_driver_org_id is not null
       and y.direction = 'driver_owes'
       and y.status in ('due', 'disputed')
    returning y.id, y.amount_cents
  )
  select coalesce(array_agg(u.id), '{}'), coalesce(sum(u.amount_cents), 0) into v_ids, v_total from upd u;

  if cardinality(v_ids) = 0 then
    return jsonb_build_object('ok', false, 'code', 'NOTHING_TO_DECLARE', 'message', 'Aucune course à régler.');
  end if;

  for x in select * from public.ride_settlements where id = any (v_ids) order by created_at, id loop
    perform private.log_partner_event(x.organization_id, x.ride_id, 'settlement.declared',
      format('Le chauffeur partenaire %s signale avoir réglé %s (%s)', x.driver_label, private.fmt_eur(x.amount_cents),
        private.settlement_method_label(p_method)),
      'timeline', 'info',
      jsonb_build_object('settlement_id', x.id, 'method', p_method, 'note', v_note, 'network', true));
    perform private.broadcast_settlement(x, 'declared');
  end loop;

  return jsonb_build_object('ok', true, 'code', 'DECLARED', 'count', cardinality(v_ids), 'amount_cents', v_total,
    'settlement_ids', to_jsonb(v_ids), 'message', format('Paiement signalé : %s va le confirmer.', g.name));
end;
$$;

-- « Je conteste » (C6, S9) : une fois par ligne à moi (private.network_settlement_disputable), motif de 5 à 300
-- caractères ; pose driver_disputed_at / driver_dispute_reason (règlement et exécution) — visible chez A (settlement_json,
-- journal) et du super admin ; ne change ni le statut ni les blocages. Refus : NETWORK_DISPUTE_NOT_ALLOWED (ligne
-- introuvable, pas à moi, déjà contestée ou rien à contester) ; NETWORK_DISPUTE_REASON_INVALID.
create or replace function public.driver_dispute_network_settlement(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  x public.ride_settlements;
  v_reason text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g')), '');
begin
  select * into d from public.drivers where id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  select * into x from public.ride_settlements y
   where y.id = p_id and y.network_driver_id = d.id and y.network_driver_org_id is not null
   for update;
  if not found then
    raise exception 'NETWORK_DISPUTE_NOT_ALLOWED: règlement introuvable' using errcode = 'P0002';
  end if;
  if v_reason is null or char_length(v_reason) not between 5 and 300 then
    raise exception 'NETWORK_DISPUTE_REASON_INVALID: motif de 5 à 300 caractères' using errcode = '22023';
  end if;
  if not private.network_settlement_disputable(x) then
    raise exception 'NETWORK_DISPUTE_NOT_ALLOWED: déjà contesté, ou rien à contester' using errcode = '55000';
  end if;

  update public.ride_settlements y
     set driver_disputed_at = now(), driver_dispute_reason = v_reason
   where y.id = x.id
  returning * into x;
  update public.ride_network_executions e
     set driver_disputed_at = now(), driver_dispute_reason = v_reason
   where e.id = x.network_execution_id and e.driver_disputed_at is null;

  perform private.log_partner_event(x.organization_id, x.ride_id, 'settlement.driver_disputed',
    format('Le chauffeur partenaire %s conteste (%s) : %s', x.driver_label,
      case when x.direction = 'driver_owes' then 'paiement signalé non reçu'
           when x.status = 'paid' then 'versement non reçu'
           when x.status = 'waived' then 'versement annulé'
           else 'versement en retard' end,
      v_reason),
    'timeline', 'warning',
    jsonb_build_object('settlement_id', x.id, 'reason', v_reason, 'status', x.status, 'direction', x.direction,
      'network', true));
  perform private.broadcast_settlement(x, 'updated');
  return jsonb_build_object('ok', true, 'item', private.network_settlement_item(x));
end;
$$;

-- =============================================================================
-- 6. Accueil et gains du chauffeur (§11.2) : net PAR COURSE avec les termes figés d'une course partenaire
-- =============================================================================

-- Dernière définition : 20260924002600_centrale_mode.sql. Réseau partagé — ajouts : course d'une autre organisation
-- (partenaire) → part du chauffeur = termes figés (private.network_driver_part ; aujourd'hui en centrale, prochaine
-- planifiée), jamais la répartition des chauffeurs de A ; bloc « network » (private.driver_home_network) seulement s'il
-- y a du réseau à montrer. « settlement » : règlements propres seulement (driver_id = le chauffeur), inchangé. Sans
-- course partenaire ni réseau : réponse identique.
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

  return jsonb_build_object(
    'driver', jsonb_build_object(
      'id', d.id, 'number', d.number, 'first_name', d.first_name, 'last_name', d.last_name,
      'presence', d.presence, 'photo_url', d.photo_url, 'current_ride_id', d.current_ride_id,
      'trust_level', d.trust_level),
    'organization', jsonb_build_object('id', o.id, 'name', o.name, 'logo_url', o.logo_url, 'phone', o.phone,
      'timezone', o.timezone, 'dispatch_model', o.dispatch_model),
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
  ) || case when v_network is null then '{}'::jsonb else jsonb_build_object('network', v_network) end;
end;
$$;

-- Dernière définition : 20260924002600_centrale_mode.sql. Réseau partagé — ajouts : course d'une autre organisation
-- (partenaire) → net = sa part aux termes figés (private.network_driver_part), quel que soit le modèle de B ; dans
-- « recent » : communes seulement (comme ses règlements partenaires), commission et frais Rydar de A jamais renvoyés
-- (NULL), nom de l'organisation qui l'a confiée (« network_giver », clé ajoutée seulement pour une course partenaire),
-- statut et sens de SA ligne réseau. Sans course partenaire : réponse identique.
create or replace function public.driver_earnings(p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_tz text;
  v_currency text;
  v_rate numeric;
  v_model text;
  v_has_net boolean;
  v_days integer := greatest(1, least(coalesce(p_days, 7), 92));
  v_today date;
  v_day timestamptz;
  v_week timestamptz;
  v_month timestamptz;
  v_series_from date;
  v_from timestamptz;
  v_periods jsonb;
  v_series jsonb;
  v_recent jsonb;
  v_upcoming jsonb;
begin
  select * into d from public.drivers where id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;

  select coalesce(o.timezone, 'Europe/Paris'), coalesce(o.currency, 'EUR'), s.driver_commission_percent, o.dispatch_model
    into v_tz, v_currency, v_rate, v_model
  from public.organizations o
  left join public.organization_settings s on s.organization_id = o.id
  where o.id = d.organization_id;
  v_has_net := v_model = 'centrale' or v_rate is not null;

  v_today := (now() at time zone v_tz)::date;
  v_day := v_today::timestamp at time zone v_tz;
  v_week := date_trunc('week', v_today::timestamp) at time zone v_tz;   -- lundi
  v_month := date_trunc('month', v_today::timestamp) at time zone v_tz;
  v_series_from := v_today - (v_days - 1);
  v_from := least(v_week, v_month, v_series_from::timestamp at time zone v_tz);

  with done as (
    select coalesce(r.completed_at, r.pickup_at) as done_at,
           r.price_cents,
           r.payment_method,
           r.estimated_distance_m,
           r.estimated_duration_s,
           -- Réseau partagé : course partenaire → sa part aux termes figés
           case when r.organization_id <> d.organization_id then private.network_driver_part(r.id)
                else private.ride_net_cents(r.price_cents, r.driver_payout_cents, v_rate) end as net_cents
    from public.rides r
    where r.driver_id = d.id
      and r.status = 'COMPLETED'
      and coalesce(r.completed_at, r.pickup_at) >= v_from
  ),
  periods (key, since) as (
    values ('today', v_day), ('week', v_week), ('month', v_month)
  ),
  agg as (
    select p.key,
           p.since,
           count(x.done_at) as rides,
           coalesce(sum(x.price_cents), 0) as revenue_cents,
           coalesce(sum(x.net_cents), 0) as net_cents,
           coalesce(sum(x.price_cents) filter (where x.net_cents is not null), 0) as netted_revenue_cents,
           coalesce(sum(x.price_cents) filter (where x.payment_method = 'cash'), 0) as cash_cents,
           coalesce(sum(x.estimated_distance_m), 0) as distance_m,
           coalesce(sum(x.estimated_duration_s), 0) as duration_s,
           count(x.done_at) filter (where x.price_cents is null) as unpriced
    from periods p
    left join done x on x.done_at >= p.since
    group by p.key, p.since
  ),
  daily as (
    select (x.done_at at time zone v_tz)::date as day,
           count(*) as rides,
           coalesce(sum(x.price_cents), 0) as revenue_cents,
           coalesce(sum(x.net_cents), 0) as net_cents,
           coalesce(sum(x.estimated_distance_m), 0) as distance_m
    from done x
    where x.done_at >= v_series_from::timestamp at time zone v_tz
    group by 1
  )
  select
    (select jsonb_object_agg(a.key, jsonb_build_object(
        'from', a.since,
        'rides', a.rides,
        'revenue_cents', a.revenue_cents,
        'net_cents', case when v_has_net then a.net_cents end,
        'commission_cents', case when v_has_net then a.netted_revenue_cents - a.net_cents end,
        'cash_cents', a.cash_cents,
        'distance_m', a.distance_m,
        'duration_s', a.duration_s,
        'unpriced_rides', a.unpriced))
     from agg a),
    (select jsonb_agg(jsonb_build_object(
        'date', to_char(g.day, 'YYYY-MM-DD'),
        'rides', coalesce(y.rides, 0),
        'revenue_cents', coalesce(y.revenue_cents, 0),
        'net_cents', case when v_has_net then coalesce(y.net_cents, 0) end,
        'distance_m', coalesce(y.distance_m, 0)) order by g.day)
     from generate_series(v_series_from::timestamp, v_today::timestamp, interval '1 day') as g (day)
     left join daily y on y.day = g.day::date)
  into v_periods, v_series;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id,
      'number', x.number,
      -- Réseau partagé : course partenaire terminée → communes seulement (historique sans l'adresse du client de A)
      'pickup', case when x.partner then coalesce(private.address_area(x.pickup_address), '—')
                     else coalesce(private.short_address(x.pickup_address), x.pickup_address) end,
      'dropoff', case when x.partner
                      then coalesce(private.address_city(x.dropoff_address), private.address_area(x.dropoff_address), '—')
                      else coalesce(private.short_address(x.dropoff_address), x.dropoff_address) end,
      'completed_at', x.done_at,
      'price_cents', x.price_cents,
      'net_cents', case when x.partner then private.network_driver_part(x.id)
                        else private.ride_net_cents(x.price_cents, x.driver_payout_cents, v_rate) end,
      -- Réseau partagé : commission et frais Rydar de A jamais montrés au chauffeur partenaire (U4)
      'commission_cents', case when x.partner then null else x.commission_cents end,
      'platform_fee_cents', case when x.partner then null else x.platform_fee_cents end,
      'settlement_status', x.settlement_status,
      'settlement_direction', x.settlement_direction,
      'currency', x.currency,
      'payment_method', x.payment_method,
      'vehicle_category', x.vehicle_category,
      'distance_m', x.estimated_distance_m,
      'duration_s', x.estimated_duration_s)
      || case when x.partner then jsonb_build_object('network_giver', x.giver_name) else '{}'::jsonb end
      order by x.done_at desc, x.number desc), '[]'::jsonb)
    into v_recent
  from (
    select r.id, r.number, r.pickup_address, r.dropoff_address, r.price_cents, r.currency, r.payment_method,
           r.vehicle_category, r.estimated_distance_m, r.estimated_duration_s, r.driver_payout_cents,
           r.commission_cents, r.platform_fee_cents,
           st.status as settlement_status, st.direction as settlement_direction,
           coalesce(r.completed_at, r.pickup_at) as done_at,
           r.organization_id <> d.organization_id as partner,
           case when r.organization_id <> d.organization_id
                then (select g.name from public.organizations g where g.id = r.organization_id) end as giver_name
    from public.rides r
    left join public.ride_settlements st on st.ride_id = r.id
    where r.driver_id = d.id and r.status = 'COMPLETED'
    order by coalesce(r.completed_at, r.pickup_at) desc, r.number desc
    limit 20
  ) x;

  select jsonb_build_object(
      'rides', count(*),
      'revenue_cents', coalesce(sum(r.price_cents), 0),
      'net_cents', case when v_has_net
                        then coalesce(sum(case when r.organization_id <> d.organization_id
                                               then private.network_driver_part(r.id)
                                               else private.ride_net_cents(r.price_cents, r.driver_payout_cents, v_rate) end), 0) end)
    into v_upcoming
  from public.rides r
  where r.driver_id = d.id
    and r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS');

  return jsonb_build_object(
    'currency', v_currency,
    'timezone', v_tz,
    'model', v_model,
    'commission_percent', v_rate,
    'days', v_days,
    'today', v_periods -> 'today',
    'week', v_periods -> 'week',
    'month', v_periods -> 'month',
    'upcoming', v_upcoming,
    'series', coalesce(v_series, '[]'::jsonb),
    'recent', v_recent
  );
end;
$$;

-- =============================================================================
-- 7. Index et droits
-- =============================================================================
-- Historique des règlements partenaires d'un chauffeur (lignes réglées comprises ; l'index partiel du schéma ne couvre
-- que les lignes ouvertes)
create index if not exists ride_settlements_network_driver_all_idx
  on public.ride_settlements (network_driver_id, created_at desc)
  where network_driver_org_id is not null;

-- Aides : fonctions serveur seulement
revoke all on function
  private.network_grace_hours(uuid),
  private.network_driver_part(uuid),
  private.iban_ok(text),
  private.payout_iban_hash(uuid, text),
  private.network_settlement_disputable(public.ride_settlements),
  private.network_settlement_item(public.ride_settlements),
  private.driver_payout_json(uuid),
  private.network_driver_readiness(uuid),
  private.driver_home_network(public.drivers),
  private.sync_network_settlement(public.rides, public.rides)
from public, anon, authenticated;
grant execute on function
  private.network_grace_hours(uuid),
  private.network_driver_part(uuid),
  private.iban_ok(text),
  private.payout_iban_hash(uuid, text),
  private.network_settlement_disputable(public.ride_settlements),
  private.network_settlement_item(public.ride_settlements),
  private.driver_payout_json(uuid),
  private.network_driver_readiness(uuid),
  private.driver_home_network(public.drivers),
  private.sync_network_settlement(public.rides, public.rides)
to service_role;

-- RPC du chauffeur (contrôle dans la fonction : private.current_driver_id()). Fonctions redéfinies (même signature) :
-- droits conservés.
revoke all on function
  public.driver_payout_info(),
  public.driver_set_payout_details(text, text, text),
  public.driver_delete_payout_details(),
  public.driver_network_settlements(),
  public.driver_declare_network_payment(uuid, uuid[], text, text),
  public.driver_dispute_network_settlement(uuid, text)
from public, anon;
grant execute on function
  public.driver_payout_info(),
  public.driver_set_payout_details(text, text, text),
  public.driver_delete_payout_details(),
  public.driver_network_settlements(),
  public.driver_declare_network_payment(uuid, uuid[], text, text),
  public.driver_dispute_network_settlement(uuid, text)
to authenticated, service_role;
