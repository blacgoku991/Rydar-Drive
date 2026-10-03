-- =============================================================================
-- Rydar Drive — Réseau partagé, lot 4 : argent. Interrupteur plateforme COUPÉ.
--
-- Partie 4a (spécification §10.1 à §10.4, §11.2) : règlement réseau créé à la fin d'une course de A exécutée par un
-- chauffeur de B, sérialisation et diffusion (A : settlement_json avec son bloc « network » ; chauffeur :
-- driver:{network_driver_id}, jamais settlement_json ni org:{B}), côté chauffeur (règlements partenaires par
-- organisation, déclaration de paiement avec les SEULS moyens de A, « Je conteste », coordonnées de versement),
-- accueil et gains du chauffeur (net PAR COURSE avec les termes figés).
-- Partie 4b (§10.5, §10.7 à §10.11, section 8) : côté A — « Reçu » / « Versé », « Pas reçu », « Annuler », « Rouvrir »
-- (owner / admin de A, même suspendue : private.assert_network_creditor), RIB du chauffeur pour un versement
-- (org_network_payout_info, consultation journalisée et notifiée), « Valider » / « Contester la course » (retenue levée ;
-- versement annulé + demande de baisse des frais Rydar), « Relancer » ; blocage d'un débiteur de A revenu par une autre
-- fiche ; relances automatiques (application seulement) ; frais Rydar d'une course partagée aux termes figés chez A ;
-- dette rappelée avant la suppression du compte et empreintes gardées pour chaque créancière ; Encaissements et garde
-- de changement de modèle (déclencheur et svc_platform_set_fees) sans les lignes réseau ; mois des relevés (identique
-- chez A et chez B).
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

-- =============================================================================
-- 8. Partie 4b — côté A (donneuse), blocages, relances, frais Rydar, dette et suppression, exports (§10.5, §10.7 à
--    §10.11)
-- =============================================================================
-- Toutes les actions d'argent réseau de A passent par private.assert_network_creditor (propriétaire ou administrateur,
-- jwt_issued_after, organisation active, suspendue OU archivée ; lot dispatch) : « Reçu », « Pas reçu », « Annuler »,
-- « Rouvrir », RIB, « Valider », « Contester la course ». Seule « Relancer » est ouverte à tout membre (dispatcher
-- compris). Le chauffeur partenaire est prévenu (notification chez A, data.network) ; jamais de promotion « chauffeur
-- confirmé » chez B. Rien ne dépend de l'interrupteur (NETWORK_CLOSED_RPCS) ; sans ligne réseau, les fonctions
-- redéfinies répondent comme avant (branches gardées par « network_driver_org_id is not null » ou par une course
-- tenue par un chauffeur d'une autre organisation).

-- -----------------------------------------------------------------------------------------------------------------
-- 8.1 Validation d'une course « à vérifier » par A (validate_network_ride)
-- -----------------------------------------------------------------------------------------------------------------
alter table public.ride_network_executions
  add column validated_at timestamptz,
  add column validated_by uuid references public.users (id) on delete set null;
comment on column public.ride_network_executions.validated_at is
  'Course « à vérifier » validée par A (public.validate_network_ride) : versement retenu libéré (hold_until ramené à la validation), plus « à vérifier », y compris une course payée à bord (sans retenue).';

-- Diffusion de l'exécution (org:{A} : id de la course ; org:{B} : id de l'exécution seulement, S14), aussi à la
-- validation. Dernière définition du déclencheur : 20260924006700 (même fonction, colonne validated_at ajoutée).
drop trigger ride_network_executions_broadcast on public.ride_network_executions;
create trigger ride_network_executions_broadcast
  after insert or update of ended_at, end_reason, suspect_reasons, hold_until, contested_at, driver_disputed_at, validated_at
  on public.ride_network_executions
  for each row execute function private.broadcast_network_execution();

-- -----------------------------------------------------------------------------------------------------------------
-- 8.2 Aides (private, sans definer : appelées par des fonctions privilégiées)
-- -----------------------------------------------------------------------------------------------------------------

-- Notification au chauffeur partenaire au sujet d'une course ou d'un règlement de A (ligne chez A ; G1 pose
-- driver_org_id = B : lisible par lui seul) : data { type, network: true, … } (contrat NetworkSettlementNotificationData :
-- l'app ouvre « Courses partenaires ») — jamais commission, frais Rydar ni détail de la part de A (U4). Fiche supprimée
-- (compte effacé) ou absente : personne à prévenir.
create or replace function private.network_notify(p_org uuid, p_driver uuid, p_ride uuid, p_type text, p_title text,
                                                  p_body text, p_data jsonb default '{}'::jsonb,
                                                  p_priority text default 'normal')
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_driver is null or not exists (select 1 from public.drivers d where d.id = p_driver and d.deleted_at is null) then
    return;
  end if;
  perform private.queue_notification(p_org, p_driver, p_ride, null, p_type, p_title, p_body,
    jsonb_build_object('type', p_type, 'network', true) || coalesce(p_data, '{}'::jsonb), p_priority, null);
end;
$$;

-- Mois d'une course partagée pour les relevés et exports (§10.11, U14) : fin de l'exécution (sinon acceptation) dans
-- le fuseau de A — la MÊME valeur chez A (« Courses confiées ») et chez B (« Courses reçues ») : mêmes courses, et donc
-- mêmes totaux, calculés des deux côtés depuis les termes figés de l'exécution. Les RPC org_network_given /
-- org_network_received (lot accès) filtrent p_month (« AAAA-MM ») avec elle.
create or replace function private.network_month(e public.ride_network_executions)
returns text
language sql
stable
set search_path = ''
as $$
  select to_char(coalesce(e.ended_at, e.accepted_at)
                 at time zone coalesce((select o.timezone from public.organizations o where o.id = e.organization_id),
                                       'Europe/Paris'), 'YYYY-MM');
$$;

-- -----------------------------------------------------------------------------------------------------------------
-- 8.3 Nouvelles RPC de A (security definer, contrôle d'accès DANS la fonction ; indépendantes de l'interrupteur :
--     NETWORK_CLOSED_RPCS — les sommes en cours se règlent même réseau fermé)
-- -----------------------------------------------------------------------------------------------------------------

-- RIB du chauffeur partenaire pour un versement de A (§10.5, S16, contrat OrgNetworkPayoutInfo) : propriétaire ou
-- administrateur de A, même suspendue ou archivée (private.assert_network_creditor, C12) ; ligne réseau prépayée
-- (centrale_owes) encore « à verser » (sinon FORBIDDEN_TENANT : aucune raison de lire le RIB), non retenue (course « à
-- vérifier » : validée ou retenue passée, sinon NETWORK_PAYOUT_ON_HOLD). Chauffeur sans RIB (facultatif) :
-- PAYOUT_DETAILS_MISSING, jamais une réponse NULL. Avertissements : « iban_changed » (empreinte du RIB ≠ celle figée à la
-- fin de la course), « recent_change » (RIB modifié il y a moins de 72 h). Chaque consultation : audit
-- « network.payout_info_viewed » chez A avec l'identifiant du règlement SEULEMENT (jamais l'IBAN) et notification au
-- chauffeur « {A} a consulté votre RIB pour vous verser {montant} ».
create or replace function public.org_network_payout_info(p_settlement uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  x public.ride_settlements;
  e public.ride_network_executions;
  p public.driver_payout_details;
  g public.organizations;
  v_warnings text[] := '{}';
begin
  select * into x from public.ride_settlements y where y.id = p_settlement and y.network_driver_org_id is not null;
  if not found then
    raise exception 'FORBIDDEN_TENANT: règlement réseau introuvable' using errcode = '42501';
  end if;
  perform private.assert_network_creditor(x.organization_id);
  if x.direction <> 'centrale_owes' or x.status <> 'due' then
    raise exception 'FORBIDDEN_TENANT: coordonnées bancaires réservées à un versement en attente' using errcode = '42501';
  end if;
  select * into e from public.ride_network_executions y where y.id = x.network_execution_id;
  if coalesce(e.hold_until > now(), false) then
    raise exception 'NETWORK_PAYOUT_ON_HOLD: versement retenu, course à vérifier' using errcode = '55000';
  end if;
  select * into p from public.driver_payout_details y where y.driver_id = x.network_driver_id;
  if not found then
    raise exception 'PAYOUT_DETAILS_MISSING: coordonnées bancaires non renseignées par le chauffeur' using errcode = 'P0002';
  end if;
  if e.payout_iban_hash is not null and e.payout_iban_hash <> p.iban_hash then
    v_warnings := v_warnings || 'iban_changed'::text;
  end if;
  if p.updated_at > now() - interval '72 hours' then
    v_warnings := v_warnings || 'recent_change'::text;
  end if;

  select * into g from public.organizations o where o.id = x.organization_id;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (x.organization_id, 'user', auth.uid(), 'network.payout_info_viewed', 'ride_settlements', x.id::text,
          case when cardinality(v_warnings) > 0 then 'warning' else 'info' end,
          jsonb_build_object('settlement_id', x.id));
  perform private.network_notify(x.organization_id, x.network_driver_id, x.ride_id, 'settlement_payout_info',
    'RIB CONSULTÉ PAR ' || g.name,
    format('%s a consulté votre RIB pour vous verser %s', g.name, private.fmt_eur(x.amount_cents)),
    jsonb_build_object('settlement_id', x.id, 'ride_id', x.ride_id, 'amount_cents', x.amount_cents));

  return jsonb_build_object(
    'settlement_id', x.id,
    'amount_cents', x.amount_cents,
    'currency', x.currency,
    'reference', x.reference,
    'payee_name', p.payee_name,
    'iban', p.iban,
    'bic', p.bic,
    'updated_at', p.updated_at,
    'warnings', to_jsonb(v_warnings));
end;
$$;

-- « Valider » une course partagée « à vérifier » (§10.5, §10.9, S10, contrat ValidateNetworkRideResult) : propriétaire
-- ou administrateur de A (même suspendue) ; course terminée par un partenaire (exécution « completed », sinon
-- RIDE_NOT_FOUND), non contestée (NETWORK_RIDE_CONTESTED). La retenue d'un versement prépayé est levée (hold_until
-- ramené à maintenant : « retenu » se lit partout hold_until > now()) et la course n'est plus « à vérifier »
-- (validated_at, aussi pour une course payée à bord, sans retenue). Une seule fois (appel répété : même réponse).
-- Journal « ride.network_validated » et audit « network.ride_validated » chez A ; chauffeur prévenu si son versement
-- est libéré ; diffusion du règlement (A et chauffeur) et de l'exécution (network.updated).
create or replace function public.validate_network_ride(p_ride uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  e public.ride_network_executions;
  x public.ride_settlements;
  g public.organizations;
  v_released boolean := false;
begin
  select * into r from public.rides y where y.id = p_ride;
  if not found then
    raise exception 'RIDE_NOT_FOUND: course introuvable' using errcode = 'P0002';
  end if;
  perform private.assert_network_creditor(r.organization_id);
  select * into e from public.ride_network_executions y
   where y.ride_id = r.id and y.end_reason = 'completed'
   order by y.ended_at desc
   limit 1
   for update;
  if not found then
    raise exception 'RIDE_NOT_FOUND: course partagée terminée introuvable' using errcode = 'P0002';
  end if;
  if e.contested_at is not null then
    raise exception 'NETWORK_RIDE_CONTESTED: course contestée, elle ne peut plus être validée' using errcode = '55000';
  end if;
  select * into x from public.ride_settlements y where y.ride_id = r.id and y.network_driver_org_id is not null for update;

  if e.validated_at is null then
    v_released := coalesce(e.hold_until > now(), false) and x.id is not null and x.direction = 'centrale_owes'
                  and x.status = 'due';
    perform private.set_actor('user', auth.uid());
    update public.ride_network_executions y
       set validated_at = now(), validated_by = auth.uid(),
           hold_until = case when y.hold_until > now() then now() else y.hold_until end
     where y.id = e.id
    returning * into e;
    select * into g from public.organizations o where o.id = r.organization_id;
    perform private.log_event(r.organization_id, r.id, 'ride.network_validated',
      'Course partagée vérifiée et validée'
        || case when v_released
                then format(' : versement de %s au chauffeur partenaire %s libéré', private.fmt_eur(x.amount_cents),
                       x.driver_label)
                else '' end,
      'timeline', 'success',
      jsonb_build_object('network', true, 'execution_id', e.id, 'suspect_reasons', to_jsonb(e.suspect_reasons),
        'released', v_released),
      'user', auth.uid());
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
    values (r.organization_id, 'user', auth.uid(), 'network.ride_validated', 'rides', r.id::text, 'info',
            jsonb_build_object('execution_id', e.id, 'suspect_reasons', to_jsonb(e.suspect_reasons),
              'released_cents', case when v_released then x.amount_cents end));
    if x.id is not null then
      perform private.broadcast_settlement(x, 'updated');
    end if;
    if v_released then
      perform private.network_notify(r.organization_id, x.network_driver_id, r.id, 'settlement_payout',
        'GAIN À RECEVOIR DE ' || g.name,
        format('Course #%s · %s a validé la course : %s vous seront versés', r.number, g.name, private.fmt_eur(x.amount_cents)),
        jsonb_build_object('settlement_id', x.id, 'ride_id', r.id, 'amount_cents', x.amount_cents));
    end if;
  end if;

  return jsonb_build_object('ok', true, 'ride_id', r.id,
    'settlement', case when x.id is null then null else private.settlement_json(x) end);
end;
$$;

-- « Contester la course » (§10.9, S10, contrat ContestNetworkRideResult) : propriétaire ou administrateur de A (même
-- suspendue), course terminée par un partenaire (RIDE_NOT_FOUND sinon), au plus 7 jours après sa fin
-- (NETWORK_CONTEST_EXPIRED), motif de 5 à 300 caractères (NETWORK_DISPUTE_REASON_INVALID). Effets :
--  * contestation posée sur l'exécution (contested_at / by / reason : compteur « contestations » de B dans /admin/reseau) ;
--  * versement prépayé encore dû (centrale_owes) → annulé, motif « Course contestée : … » (le chauffeur peut répondre
--    « Je conteste ») ; un reversement (payé à bord, driver_owes) reste dû : A seule juge de ses encaissements ;
--  * frais Rydar de la course : demande de baisse = correction de −frais EN ATTENTE du super admin (mécanisme des
--    baisses du registre, /admin/frais ; acceptée d'office après 30 jours sans décision) — Rydar ne décide que de ses
--    propres frais, jamais de l'argent entre organisations ;
--  * journal « ride.network_contested », audit « network.ride_contested », chauffeur prévenu, diffusions.
-- Déjà contestée : même réponse, rien ne change (double envoi). fee_reduction.amount_cents : montant de la baisse
-- demandée (positif).
create or replace function public.contest_network_ride(p_ride uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  e public.ride_network_executions;
  x public.ride_settlements;
  g public.organizations;
  f public.platform_fee_entries;
  v_reason text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g')), '');
  v_posted integer;
  v_waived integer;
begin
  select * into r from public.rides y where y.id = p_ride;
  if not found then
    raise exception 'RIDE_NOT_FOUND: course introuvable' using errcode = 'P0002';
  end if;
  perform private.assert_network_creditor(r.organization_id);
  select * into e from public.ride_network_executions y
   where y.ride_id = r.id and y.end_reason = 'completed'
   order by y.ended_at desc
   limit 1
   for update;
  if not found then
    raise exception 'RIDE_NOT_FOUND: course partagée terminée introuvable' using errcode = 'P0002';
  end if;
  select * into x from public.ride_settlements y where y.ride_id = r.id and y.network_driver_org_id is not null for update;

  -- Déjà contestée : même réponse, rien ne change
  if e.contested_at is not null then
    select * into f from public.platform_fee_entries y
     where y.ride_id = r.id and y.kind = 'correction' and y.created_at >= e.contested_at
     order by y.created_at
     limit 1;
    return jsonb_build_object('ok', true, 'ride_id', r.id,
      'settlement', case when x.id is null then null else private.settlement_json(x) end,
      'fee_reduction', case when f.id is null then null
                            else jsonb_build_object('entry_id', f.id, 'amount_cents', -f.amount_cents) end);
  end if;
  if v_reason is null or char_length(v_reason) not between 5 and 300 then
    raise exception 'NETWORK_DISPUTE_REASON_INVALID: motif de 5 à 300 caractères' using errcode = '22023';
  end if;
  if e.ended_at < now() - interval '7 days' then
    raise exception 'NETWORK_CONTEST_EXPIRED: course terminée depuis plus de 7 jours' using errcode = '55000';
  end if;

  perform private.set_actor('user', auth.uid());
  select * into g from public.organizations o where o.id = r.organization_id;
  update public.ride_network_executions y
     set contested_at = now(), contested_by = auth.uid(), contested_reason = v_reason
   where y.id = e.id
  returning * into e;

  -- Versement prépayé encore dû : annulé
  if x.id is not null and x.direction = 'centrale_owes' and x.status in ('due', 'declared', 'disputed') then
    update public.ride_settlements y
       set status = 'waived', note = left('Course contestée : ' || v_reason, 500), settled_at = now(),
           settled_by = auth.uid(), settled_method = null
     where y.id = x.id
    returning * into x;
    v_waived := x.amount_cents;
  end if;

  -- Frais Rydar de la course : demande de baisse au super admin (jamais une baisse directe ; une demande en attente
  -- n'est pas doublée)
  perform 1 from public.platform_fee_entries y where y.ride_id = r.id and y.status = 'pending' for update;
  select * into f from public.platform_fee_entries y
   where y.ride_id = r.id and y.status = 'pending'
   order by y.created_at desc
   limit 1;
  if f.id is null then
    select coalesce(sum(y.amount_cents) filter (where y.status = 'posted'), 0)::integer into v_posted
      from public.platform_fee_entries y where y.ride_id = r.id;
    if v_posted > 0 then
      insert into public.platform_fee_entries (organization_id, ride_id, kind, amount_cents, status, label, reason,
                                               occurred_at, due_at, created_by)
      values (r.organization_id, r.id, 'correction', -v_posted, 'pending',
        format('Contestation course %s · réseau partagé : frais %s → %s', r.number, private.fmt_eur(v_posted),
          private.fmt_eur(0)),
        left('Course contestée : ' || v_reason, 500), now(), private.platform_due_at(r.organization_id, now()), auth.uid())
      returning * into f;
      perform private.broadcast_platform(r.organization_id, 'reduction_pending',
        jsonb_build_object('entry', private.platform_entry_json(f)));
    end if;
  end if;

  perform private.log_event(r.organization_id, r.id, 'ride.network_contested',
    format('Course partagée contestée : %s', v_reason)
      || case when v_waived is not null
              then format(' — versement de %s au chauffeur partenaire %s annulé', private.fmt_eur(v_waived), x.driver_label)
              else '' end
      || case when f.id is not null
              then format(' ; baisse des frais Rydar de %s demandée à Rydar', private.fmt_eur(-f.amount_cents))
              else '' end,
    'timeline', 'warning',
    jsonb_build_object('network', true, 'execution_id', e.id, 'reason', v_reason, 'payout_waived_cents', v_waived,
      'fee_reduction_cents', case when f.id is not null then -f.amount_cents end),
    'user', auth.uid());
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (r.organization_id, 'user', auth.uid(), 'network.ride_contested', 'rides', r.id::text, 'warning',
          jsonb_build_object('execution_id', e.id, 'payout_waived_cents', v_waived, 'fee_entry_id', f.id,
            'fee_reduction_cents', case when f.id is not null then -f.amount_cents end));
  if x.id is not null then
    perform private.broadcast_settlement(x, case when v_waived is not null then 'waived' else 'updated' end);
  end if;
  perform private.network_notify(r.organization_id, e.executor_driver_id, r.id,
    case when v_waived is not null then 'settlement_payout_cancelled' else 'settlement_contested' end,
    case when v_waived is not null then 'VERSEMENT ANNULÉ — ' || g.name else 'COURSE CONTESTÉE — ' || g.name end,
    case when v_waived is not null
         then format('Course #%s · %s conteste la course (%s) : les %s prévus ne vous seront pas versés', r.number, g.name,
                v_reason, private.fmt_eur(v_waived))
         else format('Course #%s · %s conteste la course : %s', r.number, g.name, v_reason) end,
    jsonb_build_object('ride_id', r.id)
      || case when x.id is not null then jsonb_build_object('settlement_id', x.id, 'amount_cents', x.amount_cents)
              else '{}'::jsonb end);

  return jsonb_build_object('ok', true, 'ride_id', r.id,
    'settlement', case when x.id is null then null else private.settlement_json(x) end,
    'fee_reduction', case when f.id is null then null
                          else jsonb_build_object('entry_id', f.id, 'amount_cents', -f.amount_cents) end);
end;
$$;

-- « Relancer » un chauffeur partenaire (§10.5, §10.8, S19, contrat RemindNetworkDriverResult) : tout membre de A,
-- dispatcher compris (organisation active : private.assert_org_member) ; seulement pour une ligne réseau de p_org (jamais
-- celle d'une autre organisation) ; APPLICATION seulement (aucun WhatsApp en v1) ; rappelle tout ce que ce chauffeur
-- doit à p_org (reversements à régler ou « Pas reçu ») ; une relance par 30 min au plus (TOO_SOON, next_allowed_at).
-- Journal de A sans identifiant du chauffeur.
create or replace function public.remind_network_driver(p_org uuid, p_settlement uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  x public.ride_settlements;
  g public.organizations;
  v_total integer;
  v_n integer;
  v_ids uuid[];
  v_last timestamptz;
begin
  perform private.assert_org_member(p_org);
  select * into x from public.ride_settlements y
   where y.id = p_settlement
     and y.organization_id = p_org
     and y.network_driver_org_id is not null
     and y.direction = 'driver_owes';
  if not found or x.network_driver_id is null
     or not exists (select 1 from public.drivers d where d.id = x.network_driver_id and d.deleted_at is null) then
    return jsonb_build_object('ok', false, 'code', 'NOTHING_DUE', 'message', 'Rien à relancer pour ce règlement.');
  end if;
  -- Lignes de ce chauffeur envers p_org, verrouillées : deux relances simultanées, la seconde voit la première
  perform 1 from public.ride_settlements y
   where y.organization_id = p_org
     and y.network_driver_id = x.network_driver_id
     and y.network_driver_org_id is not null
     and y.direction = 'driver_owes'
     and y.status in ('due', 'disputed')
   order by y.id
   for update;
  select coalesce(sum(y.amount_cents), 0)::integer, count(*)::integer, coalesce(array_agg(y.id), '{}'), max(y.last_reminded_at)
    into v_total, v_n, v_ids, v_last
    from public.ride_settlements y
   where y.organization_id = p_org
     and y.network_driver_id = x.network_driver_id
     and y.network_driver_org_id is not null
     and y.direction = 'driver_owes'
     and y.status in ('due', 'disputed')
     and y.amount_cents > 0;
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'code', 'NOTHING_DUE', 'message', 'Rien à relancer pour ce règlement.');
  end if;
  if v_last > now() - interval '30 minutes' then
    return jsonb_build_object('ok', false, 'code', 'TOO_SOON', 'message', 'Rappel déjà envoyé il y a moins de 30 minutes.',
      'next_allowed_at', v_last + interval '30 minutes');
  end if;

  perform private.set_actor('user', auth.uid());
  select * into g from public.organizations o where o.id = p_org;
  perform private.network_notify(p_org, x.network_driver_id, null, 'settlement_reminder', 'RAPPEL — À RÉGLER À ' || g.name,
    format('Rappel : %s à régler à %s (%s %s)', private.fmt_eur(v_total), g.name, v_n,
      private.pl(v_n, 'course partenaire', 'courses partenaires')),
    jsonb_build_object('amount_cents', v_total, 'count', v_n), 'high');
  update public.ride_settlements
     set last_reminded_at = now(), reminders_sent = reminders_sent + 1
   where id = any (v_ids);
  perform private.log_event(p_org, null, 'settlement.reminded',
    format('Rappel envoyé par l''application au chauffeur partenaire %s : %s à régler (%s %s)', x.driver_label,
      private.fmt_eur(v_total), v_n, private.pl(v_n, 'course', 'courses')),
    'timeline', 'info',
    jsonb_build_object('network', true, 'amount_cents', v_total, 'count', v_n, 'channels', jsonb_build_array('app'),
      'settlement_ids', to_jsonb(v_ids)),
    'user', auth.uid());
  return jsonb_build_object('ok', true, 'code', 'REMINDED', 'amount_cents', v_total, 'count', v_n,
    'channels', jsonb_build_array('app'), 'message', 'Rappel envoyé au chauffeur (application).');
end;
$$;

-- -----------------------------------------------------------------------------------------------------------------
-- 8.4 Actions de A sur un règlement : « Reçu » / « Versé », « Pas reçu », « Annuler », « Rouvrir » (§10.5, S9, C6, C7, C12)
-- -----------------------------------------------------------------------------------------------------------------

-- Dernière définition : 20260924004400_audit_argent.sql. Réseau partagé — ajouts pour une ligne réseau
-- (network_driver_org_id non NULL) : owner / admin de A seulement, même suspendue (private.assert_network_creditor ;
-- lot mêlé : les deux contrôles, un dispatcher est refusé) ; versement retenu (course « à vérifier ») refusé
-- (NETWORK_PAYOUT_ON_HOLD) ; journal au libellé court du chauffeur partenaire ; une notification par chauffeur
-- partenaire (data.network, nom de A) ; jamais private.maybe_promote_driver (niveau de confiance de la fiche de B
-- inchangé). Lignes propres : corps et réponses identiques.
create or replace function public.confirm_settlements(p_ids uuid[], p_method text default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_orgs integer;
  v_ids uuid[];
  v_total integer;
  v_received integer;
  v_paid_out integer;
  v_name text;
  v_note text := left(nullif(btrim(coalesce(p_note, '')), ''), 500);
  x public.ride_settlements;
  v record;
  -- Réseau partagé
  v_network boolean;
  v_own boolean;
begin
  if coalesce(cardinality(p_ids), 0) = 0 or cardinality(p_ids) > 500 then
    return jsonb_build_object('ok', false, 'code', 'NOTHING_TO_CONFIRM', 'message', 'Aucun règlement sélectionné.');
  end if;
  select count(distinct y.organization_id), (array_agg(distinct y.organization_id))[1],
         coalesce(bool_or(y.network_driver_org_id is not null), false), coalesce(bool_or(y.network_driver_org_id is null), false)
    into v_orgs, v_org, v_network, v_own
  from public.ride_settlements y
  where y.id = any (p_ids);
  if v_orgs = 0 then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Règlement introuvable.');
  end if;
  if v_orgs > 1 then
    raise exception 'FORBIDDEN_TENANT: règlements de plusieurs organisations' using errcode = '42501';
  end if;
  -- Réseau partagé : une ligne réseau → owner / admin de A, même suspendue ou archivée (private.assert_network_creditor,
  -- S9, C12 : un dispatcher est refusé, lot mêlé compris) ; lignes propres : contrôle inchangé
  if v_own then
    perform private.assert_org_member(v_org, array['owner', 'admin', 'dispatcher']::public.org_role[]);
  end if;
  if v_network then
    perform private.assert_network_creditor(v_org);
  end if;
  perform private.set_actor('user', auth.uid());
  if p_method is not null and p_method not in ('link', 'cash', 'transfer', 'other') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_METHOD', 'message', 'Moyen de paiement invalide.');
  end if;
  -- Réseau partagé : versement au chauffeur partenaire retenu (course « à vérifier », ni validée ni 72 h passées)
  if v_network and exists (
    select 1
      from public.ride_settlements y
      join public.ride_network_executions e on e.id = y.network_execution_id
     where y.id = any (p_ids)
       and y.organization_id = v_org
       and y.network_driver_org_id is not null
       and y.direction = 'centrale_owes'
       and y.status in ('due', 'declared', 'disputed')
       and e.hold_until > now()) then
    raise exception 'NETWORK_PAYOUT_ON_HOLD: versement retenu, course à vérifier (validez-la, ou attendez la fin de la retenue)'
      using errcode = '55000';
  end if;

  with upd as (
    update public.ride_settlements y
       set status = 'paid',
           settled_at = now(),
           settled_by = auth.uid(),
           settled_method = coalesce(p_method, y.declared_method, 'other'),
           note = coalesce(v_note, y.note)
     where y.id = any (p_ids)
       and y.organization_id = v_org
       and y.status in ('due', 'declared', 'disputed')
    returning y.id, y.amount_cents, y.direction
  )
  select coalesce(array_agg(u.id), '{}'), coalesce(sum(u.amount_cents), 0),
         coalesce(sum(u.amount_cents) filter (where u.direction = 'driver_owes'), 0),
         coalesce(sum(u.amount_cents) filter (where u.direction = 'centrale_owes'), 0)
    into v_ids, v_total, v_received, v_paid_out
  from upd u;
  if cardinality(v_ids) = 0 then
    return jsonb_build_object('ok', false, 'code', 'NOTHING_TO_CONFIRM', 'message', 'Ces règlements sont déjà traités.');
  end if;

  for x in select * from public.ride_settlements where id = any (v_ids) order by created_at loop
    perform private.log_event(x.organization_id, x.ride_id, 'settlement.paid',
      case -- Réseau partagé : libellé court du chauffeur partenaire, jamais « commission »
           when x.network_driver_org_id is not null and x.direction = 'driver_owes'
           then format('%s reçus du chauffeur partenaire %s (%s)', private.fmt_eur(x.amount_cents), x.driver_label,
                  private.settlement_method_label(x.settled_method))
           when x.network_driver_org_id is not null
           then format('%s versés au chauffeur partenaire %s (%s)', private.fmt_eur(x.amount_cents), x.driver_label,
                  private.settlement_method_label(x.settled_method))
           when x.direction = 'driver_owes'
           then format('Commission de %s encaissée (%s)', private.fmt_eur(x.amount_cents), private.settlement_method_label(x.settled_method))
           else format('%s versés au chauffeur (%s)', private.fmt_eur(x.amount_cents), private.settlement_method_label(x.settled_method))
      end,
      'timeline', 'success',
      jsonb_build_object('settlement_id', x.id, 'method', x.settled_method)
        || case when x.network_driver_org_id is not null then jsonb_build_object('network', true) else '{}'::jsonb end,
      'user', auth.uid());
    perform private.broadcast_settlement(x, 'paid');
  end loop;

  -- Une notification par chauffeur (+ passage « confirmé » éventuel)
  select o.name into v_name from public.organizations o where o.id = v_org;
  for v in
    select y.driver_id,
           coalesce(sum(y.amount_cents) filter (where y.direction = 'driver_owes'), 0)::integer as received,
           coalesce(sum(y.amount_cents) filter (where y.direction = 'centrale_owes'), 0)::integer as paid_out
    from public.ride_settlements y
    where y.id = any (v_ids) and y.driver_id is not null
    group by y.driver_id
  loop
    if v.received > 0 then
      perform private.queue_notification(v_org, v.driver_id, null, null, 'settlement_paid', 'PAIEMENT REÇU',
        format('%s a bien reçu %s — merci !', v_name, private.fmt_eur(v.received)),
        jsonb_build_object('type', 'settlement_paid', 'amount_cents', v.received), 'normal', null);
    end if;
    if v.paid_out > 0 then
      perform private.queue_notification(v_org, v.driver_id, null, null, 'settlement_payout_sent', 'VERSEMENT EFFECTUÉ',
        format('%s vous a versé %s', v_name, private.fmt_eur(v.paid_out)),
        jsonb_build_object('type', 'settlement_payout_sent', 'amount_cents', v.paid_out), 'normal', null);
    end if;
    perform private.maybe_promote_driver(v.driver_id);
  end loop;

  -- Réseau partagé : une notification par chauffeur partenaire (ligne chez A, data.network, nom de A) ; jamais de
  -- passage « confirmé » chez B (private.maybe_promote_driver : règlements et courses propres seulement)
  for v in
    select y.network_driver_id as driver_id, count(*)::integer as n,
           (array_agg(y.id))[1] as settlement_id, (array_agg(y.ride_id))[1] as ride_id,
           coalesce(sum(y.amount_cents) filter (where y.direction = 'driver_owes'), 0)::integer as received,
           coalesce(sum(y.amount_cents) filter (where y.direction = 'centrale_owes'), 0)::integer as paid_out
    from public.ride_settlements y
    where y.id = any (v_ids) and y.network_driver_org_id is not null and y.network_driver_id is not null
    group by y.network_driver_id
  loop
    if v.received > 0 then
      perform private.network_notify(v_org, v.driver_id, case when v.n = 1 then v.ride_id end, 'settlement_paid',
        'PAIEMENT REÇU PAR ' || v_name, format('%s a bien reçu %s — merci !', v_name, private.fmt_eur(v.received)),
        jsonb_build_object('amount_cents', v.received)
          || case when v.n = 1 then jsonb_build_object('settlement_id', v.settlement_id, 'ride_id', v.ride_id) else '{}'::jsonb end);
    end if;
    if v.paid_out > 0 then
      perform private.network_notify(v_org, v.driver_id, case when v.n = 1 then v.ride_id end, 'settlement_payout_sent',
        'VERSEMENT DE ' || v_name, format('%s vous a versé %s', v_name, private.fmt_eur(v.paid_out)),
        jsonb_build_object('amount_cents', v.paid_out)
          || case when v.n = 1 then jsonb_build_object('settlement_id', v.settlement_id, 'ride_id', v.ride_id) else '{}'::jsonb end);
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'code', 'CONFIRMED', 'count', cardinality(v_ids), 'amount_cents', v_total,
    'received_cents', v_received, 'paid_out_cents', v_paid_out,
    'message', format('%s %s', cardinality(v_ids), private.pl(cardinality(v_ids), 'règlement confirmé', 'règlements confirmés')));
end;
$$;

-- Dernière définition : 20260924002600_centrale_mode.sql. Réseau partagé — « Pas reçu » sur une ligne réseau : owner /
-- admin de A seulement (S9), effet limité aux courses de A (private.network_blocker, « giver_unpaid »), chauffeur
-- partenaire prévenu (il peut répondre « Je conteste »). Ligne propre : inchangé.
create or replace function public.dispute_settlement(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  x public.ride_settlements;
  v_number bigint;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
  -- Réseau partagé
  v_giver text;
begin
  select * into x from public.ride_settlements where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Règlement introuvable.');
  end if;
  -- Réseau partagé : « Pas reçu » sur une ligne réseau réservé au propriétaire et aux administrateurs de A (S9 : un
  -- dispatcher ne coupe pas un chauffeur partenaire ; A suspendue comprise, C12) ; effet limité aux courses de A
  -- (private.network_blocker, « giver_unpaid »). Ligne propre : inchangé.
  if x.network_driver_org_id is not null then
    perform private.assert_network_creditor(x.organization_id);
  else
    perform private.assert_org_member(x.organization_id, array['owner', 'admin', 'dispatcher']::public.org_role[]);
  end if;
  perform private.set_actor('user', auth.uid());
  if x.direction <> 'driver_owes' or x.status not in ('due', 'declared') then
    return jsonb_build_object('ok', false, 'code', 'NOT_DISPUTABLE',
      'message', case when x.network_driver_org_id is not null   -- Réseau partagé
                      then 'Seul un reversement à régler ou signalé payé par le chauffeur partenaire peut être contesté.'
                      else 'Seule une commission à régler ou signalée payée peut être contestée.' end);
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'message', 'Précisez ce qui ne va pas.');
  end if;

  update public.ride_settlements set status = 'disputed', note = v_reason where id = x.id returning * into x;
  select r.number into v_number from public.rides r where r.id = x.ride_id;

  perform private.log_event(x.organization_id, x.ride_id, 'settlement.disputed',
    case when x.network_driver_org_id is not null   -- Réseau partagé
         then format('Paiement de %s du chauffeur partenaire %s contesté : %s', private.fmt_eur(x.amount_cents), x.driver_label,
                v_reason)
         else format('Paiement de %s contesté par la centrale : %s', private.fmt_eur(x.amount_cents), v_reason) end,
    'timeline', 'warning',
    jsonb_build_object('settlement_id', x.id, 'reason', v_reason)
      || case when x.network_driver_org_id is not null then jsonb_build_object('network', true) else '{}'::jsonb end,
    'user', auth.uid());
  perform private.broadcast_settlement(x, 'disputed');
  -- Réseau partagé : le chauffeur partenaire est prévenu (ligne chez A), il peut répondre « Je conteste »
  if x.network_driver_org_id is not null then
    select o.name into v_giver from public.organizations o where o.id = x.organization_id;
    perform private.network_notify(x.organization_id, x.network_driver_id, x.ride_id, 'settlement_disputed',
      'NON REÇU PAR ' || v_giver,
      format('Course #%s · %s non reçus par %s : %s', v_number, private.fmt_eur(x.amount_cents), v_giver, v_reason),
      jsonb_build_object('settlement_id', x.id, 'ride_id', x.ride_id, 'amount_cents', x.amount_cents), 'high');
  elsif x.driver_id is not null then
    perform private.queue_notification(x.organization_id, x.driver_id, x.ride_id, null, 'settlement_disputed', 'PAIEMENT NON REÇU',
      format('Course #%s · %s non reçus par la centrale : %s', v_number, private.fmt_eur(x.amount_cents), v_reason),
      jsonb_build_object('type', 'settlement_disputed', 'settlement_id', x.id, 'amount_cents', x.amount_cents), 'high', null);
  end if;
  return jsonb_build_object('ok', true, 'code', 'DISPUTED', 'message', 'Paiement contesté : le chauffeur est prévenu.');
end;
$$;

-- Dernière définition : 20260924004400_audit_argent.sql. Réseau partagé — « Annuler » une ligne réseau : owner / admin
-- de A ; un versement dû au chauffeur partenaire (prépayé) ne s'annule jamais (NETWORK_SETTLEMENT_ACTION_FORBIDDEN :
-- seule voie, « Contester la course ») ; un reversement (payé à bord, favorable au chauffeur) s'annule, motif
-- obligatoire ; chauffeur partenaire prévenu. Ligne propre : inchangé.
create or replace function public.waive_settlement(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  x public.ride_settlements;
  v_number bigint;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
  -- Réseau partagé
  v_giver text;
begin
  select * into x from public.ride_settlements where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Règlement introuvable.');
  end if;
  -- Réseau partagé : ligne réseau → owner / admin de A (même suspendue, C12) ; un versement dû au chauffeur
  -- partenaire (prépayé) ne s'annule jamais (C6 : seule voie, « Contester la course », contest_network_ride) ; un
  -- reversement (payé à bord) s'annule, motif obligatoire. Ligne propre : inchangé.
  if x.network_driver_org_id is not null then
    perform private.assert_network_creditor(x.organization_id);
    if x.direction = 'centrale_owes' then
      raise exception 'NETWORK_SETTLEMENT_ACTION_FORBIDDEN: versement dû au chauffeur partenaire, contestez la course'
        using errcode = '42501';
    end if;
  else
    perform private.assert_org_member(x.organization_id, array['owner', 'admin']::public.org_role[]);
  end if;
  perform private.set_actor('user', auth.uid());
  if x.status not in ('due', 'declared', 'disputed') then
    return jsonb_build_object('ok', false, 'code', 'NOT_OPEN', 'message', 'Ce règlement est déjà traité.');
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'message', 'Indiquez le motif de l''annulation.');
  end if;

  update public.ride_settlements
     set status = 'waived', note = v_reason, settled_at = now(), settled_by = auth.uid(), settled_method = null
   where id = x.id
  returning * into x;
  select r.number into v_number from public.rides r where r.id = x.ride_id;

  perform private.log_event(x.organization_id, x.ride_id, 'settlement.waived',
    case when x.network_driver_org_id is not null   -- Réseau partagé
         then format('Reversement de %s du chauffeur partenaire %s annulé : %s', private.fmt_eur(x.amount_cents), x.driver_label,
                v_reason)
         else format('%s annulé%s par la centrale : %s', case when x.direction = 'driver_owes' then 'Commission' else 'Versement' end,
                case when x.direction = 'driver_owes' then 'e' else '' end, v_reason) end,
    'timeline', 'warning',
    jsonb_build_object('settlement_id', x.id, 'reason', v_reason)
      || case when x.network_driver_org_id is not null then jsonb_build_object('network', true) else '{}'::jsonb end,
    'user', auth.uid());
  perform private.broadcast_settlement(x, 'waived');
  -- Réseau partagé : le chauffeur partenaire est prévenu (somme annulée par A)
  if x.network_driver_org_id is not null then
    select o.name into v_giver from public.organizations o where o.id = x.organization_id;
    perform private.network_notify(x.organization_id, x.network_driver_id, x.ride_id, 'settlement_waived',
      'ANNULÉ PAR ' || v_giver,
      format('Course #%s · %s a annulé les %s à régler', v_number, v_giver, private.fmt_eur(x.amount_cents)),
      jsonb_build_object('settlement_id', x.id, 'ride_id', x.ride_id, 'amount_cents', x.amount_cents));
  elsif x.driver_id is not null and x.direction = 'driver_owes' then
    perform private.queue_notification(x.organization_id, x.driver_id, x.ride_id, null, 'settlement_waived', 'COMMISSION ANNULÉE',
      format('Course #%s · la centrale a annulé les %s à régler', v_number, private.fmt_eur(x.amount_cents)),
      jsonb_build_object('type', 'settlement_waived', 'settlement_id', x.id), 'normal', null);
  elsif x.driver_id is not null then
    perform private.queue_notification(x.organization_id, x.driver_id, x.ride_id, null, 'settlement_payout_cancelled', 'VERSEMENT ANNULÉ',
      format('Course #%s · les %s prévus ne vous seront pas versés : %s', v_number, private.fmt_eur(x.amount_cents), v_reason),
      jsonb_build_object('type', 'settlement_payout_cancelled', 'settlement_id', x.id, 'ride_id', x.ride_id,
        'amount_cents', x.amount_cents), 'normal', null);
  end if;
  return jsonb_build_object('ok', true, 'code', 'WAIVED', 'message', 'Règlement annulé.');
end;
$$;

-- Dernière définition : 20260924004400_audit_argent.sql. Réseau partagé — « Rouvrir » une ligne réseau : owner / admin
-- de A ; reversement → nouvelle échéance (délai de A, au moins 48 h : private.network_grace_hours, C7) et relances
-- remises à zéro ; versement d'une course contestée : refusé (NETWORK_RIDE_CONTESTED) ; chauffeur partenaire prévenu.
-- Ligne propre : inchangé (échéance d'origine gardée).
create or replace function public.reopen_settlement(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  x public.ride_settlements;
  v_number bigint;
  v_name text;
  -- Réseau partagé
  g public.organizations;
  v_tz text;
begin
  select * into x from public.ride_settlements where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Règlement introuvable.');
  end if;
  -- Réseau partagé : ligne réseau → owner / admin de A (même suspendue, C12) ; le versement d'une course contestée
  -- (annulé par contest_network_ride) ne se rouvre pas. Ligne propre : inchangé.
  if x.network_driver_org_id is not null then
    perform private.assert_network_creditor(x.organization_id);
    if x.direction = 'centrale_owes' and exists (
      select 1 from public.ride_network_executions e where e.id = x.network_execution_id and e.contested_at is not null) then
      raise exception 'NETWORK_RIDE_CONTESTED: course contestée, versement annulé' using errcode = '55000';
    end if;
  else
    perform private.assert_org_member(x.organization_id, array['owner', 'admin']::public.org_role[]);
  end if;
  perform private.set_actor('user', auth.uid());
  if x.status not in ('paid', 'waived') then
    return jsonb_build_object('ok', false, 'code', 'NOT_CLOSED', 'message', 'Ce règlement est déjà ouvert.');
  end if;
  if x.amount_cents <= 0 then
    return jsonb_build_object('ok', false, 'code', 'ZERO_AMOUNT',
      'message', 'Montant nul : corrigez le prix de la course, le règlement sera recalculé.');
  end if;

  if x.network_driver_org_id is not null and x.direction = 'driver_owes' then
    -- Réseau partagé : reversement rouvert → nouvelle échéance (délai de A, au moins 48 h, C7), relances remises à zéro
    update public.ride_settlements
       set status = 'due', settled_at = null, settled_by = null, settled_method = null,
           due_at = now() + make_interval(hours => private.network_grace_hours(x.organization_id)),
           reminders_sent = 0, last_reminded_at = null
     where id = x.id
    returning * into x;
  else
    update public.ride_settlements
       set status = 'due', settled_at = null, settled_by = null, settled_method = null
     where id = x.id
    returning * into x;
  end if;
  select r.number into v_number from public.rides r where r.id = x.ride_id;

  if x.network_driver_org_id is not null then
    -- Réseau partagé : journal de A (libellé court du chauffeur partenaire), chauffeur partenaire prévenu
    select * into g from public.organizations o where o.id = x.organization_id;
    perform private.log_event(x.organization_id, x.ride_id, 'settlement.reopened',
      format('Règlement de %s avec le chauffeur partenaire %s rouvert%s', private.fmt_eur(x.amount_cents), x.driver_label,
        case when x.direction = 'driver_owes'
             then ' — à régler avant ' || private.fmt_local_time(x.due_at, g.timezone, now()) else '' end),
      'timeline', 'warning', jsonb_build_object('settlement_id', x.id, 'network', true, 'due_at', x.due_at), 'user', auth.uid());
    perform private.broadcast_settlement(x, 'reopened');
    select b.timezone into v_tz from public.organizations b where b.id = x.network_driver_org_id;
    if x.direction = 'driver_owes' then
      perform private.network_notify(x.organization_id, x.network_driver_id, x.ride_id, 'settlement_due',
        'À RÉGLER À ' || g.name,
        format('Course #%s · %s attend toujours %s, à régler avant %s', v_number, g.name, private.fmt_eur(x.amount_cents),
          private.fmt_local_time(x.due_at, coalesce(v_tz, g.timezone), now())),
        jsonb_build_object('settlement_id', x.id, 'ride_id', x.ride_id, 'amount_cents', x.amount_cents));
    else
      perform private.network_notify(x.organization_id, x.network_driver_id, x.ride_id, 'settlement_payout',
        'GAIN À RECEVOIR DE ' || g.name,
        format('Course #%s · %s vous seront versés par %s', v_number, private.fmt_eur(x.amount_cents), g.name),
        jsonb_build_object('settlement_id', x.id, 'ride_id', x.ride_id, 'amount_cents', x.amount_cents));
    end if;
    return jsonb_build_object('ok', true, 'code', 'REOPENED', 'message', 'Règlement rouvert.');
  end if;

  perform private.log_event(x.organization_id, x.ride_id, 'settlement.reopened',
    format('Règlement de %s rouvert par la centrale', private.fmt_eur(x.amount_cents)),
    'timeline', 'warning', jsonb_build_object('settlement_id', x.id), 'user', auth.uid());
  perform private.broadcast_settlement(x, 'reopened');
  if x.driver_id is not null and x.direction = 'driver_owes' then
    perform private.queue_notification(x.organization_id, x.driver_id, x.ride_id, null, 'settlement_due', 'COMMISSION À RÉGLER',
      format('Course #%s · la centrale attend toujours %s', v_number, private.fmt_eur(x.amount_cents)),
      jsonb_build_object('type', 'settlement_due', 'settlement_id', x.id, 'amount_cents', x.amount_cents), 'normal', null);
  elsif x.driver_id is not null then
    select o.name into v_name from public.organizations o where o.id = x.organization_id;
    perform private.queue_notification(x.organization_id, x.driver_id, x.ride_id, null, 'settlement_payout', 'GAIN À RECEVOIR',
      format('Course #%s · %s vous seront versés par %s', v_number, private.fmt_eur(x.amount_cents), v_name),
      jsonb_build_object('type', 'settlement_payout', 'settlement_id', x.id, 'ride_id', x.ride_id,
        'amount_cents', x.amount_cents), 'normal', null);
  end if;
  return jsonb_build_object('ok', true, 'code', 'REOPENED', 'message', 'Règlement rouvert.');
end;
$$;

-- -----------------------------------------------------------------------------------------------------------------
-- 8.5 Encaissements = règlements propres ; changement de modèle ; promotion propre à B (§10.5, P4)
-- -----------------------------------------------------------------------------------------------------------------

-- Dernière définition : 20260924002600_centrale_mode.sql. Réseau partagé — totaux sans les lignes réseau (réglées dans
-- l'onglet « Réseau partagé ») ; chiffres du mois sans les courses tenues par un chauffeur d'une autre organisation
-- (réglées aux termes figés). Sans réseau : réponse identique.
create or replace function public.org_settlement_overview(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  s public.organization_settings;
  v_month timestamptz;
  v_totals jsonb;
  v_month_rides jsonb;
  v_drivers jsonb;
begin
  perform private.assert_org_member(p_org);
  select * into o from public.organizations where id = p_org;
  select * into s from public.organization_settings where organization_id = p_org;
  v_month := date_trunc('month', now() at time zone o.timezone) at time zone o.timezone;

  select jsonb_build_object(
      'to_collect_cents', coalesce(sum(x.amount_cents) filter (where x.direction = 'driver_owes'
        and x.status in ('due', 'declared', 'disputed')), 0),
      'overdue_cents', coalesce(sum(x.amount_cents) filter (where x.direction = 'driver_owes'
        and (x.status = 'disputed' or (x.status = 'due' and x.due_at <= now()))), 0),
      'declared_cents', coalesce(sum(x.amount_cents) filter (where x.direction = 'driver_owes' and x.status = 'declared'), 0),
      'declared_count', count(*) filter (where x.direction = 'driver_owes' and x.status = 'declared'),
      'disputed_count', count(*) filter (where x.status = 'disputed'),
      'open_count', count(*) filter (where x.status in ('due', 'declared', 'disputed')),
      'to_pay_cents', coalesce(sum(x.amount_cents) filter (where x.direction = 'centrale_owes' and x.status = 'due'), 0),
      'collected_month_cents', coalesce(sum(x.amount_cents) filter (where x.direction = 'driver_owes' and x.status = 'paid'
        and x.settled_at >= v_month), 0),
      'paid_out_month_cents', coalesce(sum(x.amount_cents) filter (where x.direction = 'centrale_owes' and x.status = 'paid'
        and x.settled_at >= v_month), 0),
      'waived_month_cents', coalesce(sum(x.amount_cents) filter (where x.status = 'waived' and x.updated_at >= v_month), 0))
    into v_totals
  from public.ride_settlements x
  where x.organization_id = p_org
    -- Réseau partagé : Encaissements = règlements propres (lignes réseau : onglet « Réseau partagé »)
    and x.network_driver_org_id is null;

  select jsonb_build_object(
      'rides', count(*),
      'volume_cents', coalesce(sum(r.price_cents), 0),
      'commission_cents', coalesce(sum(r.commission_cents), 0),
      'platform_fee_cents', coalesce(sum(r.platform_fee_cents), 0),
      'driver_payout_cents', coalesce(sum(r.driver_payout_cents), 0))
    into v_month_rides
  from public.rides r
  where r.organization_id = p_org
    and r.status = 'COMPLETED'
    and r.completed_at >= v_month
    and r.driver_payout_cents is not null
    -- Réseau partagé : courses de ses chauffeurs (une course partagée se règle aux termes figés, hors Encaissements)
    and (r.driver_org_id is null or r.driver_org_id = r.organization_id);

  select coalesce(jsonb_agg(t.j order by t.overdue desc, t.owed desc, t.label), '[]'::jsonb)
    into v_drivers
  from (
    select jsonb_build_object(
        'driver_id', d.id,
        'number', d.number,
        'first_name', d.first_name,
        'last_name', d.last_name,
        'phone', d.phone,
        'status', d.status,
        'trust_level', d.trust_level,
        'banned', d.banned_at is not null,
        'owed_cents', coalesce(sum(x.amount_cents) filter (where x.direction = 'driver_owes' and x.status in ('due', 'disputed')), 0),
        'overdue_cents', coalesce(sum(x.amount_cents) filter (where x.direction = 'driver_owes'
          and (x.status = 'disputed' or (x.status = 'due' and x.due_at <= now()))), 0),
        'declared_cents', coalesce(sum(x.amount_cents) filter (where x.direction = 'driver_owes' and x.status = 'declared'), 0),
        'to_pay_cents', coalesce(sum(x.amount_cents) filter (where x.direction = 'centrale_owes' and x.status = 'due'), 0),
        'open_count', count(*),
        'oldest_due_at', min(x.due_at) filter (where x.direction = 'driver_owes' and x.status in ('due', 'disputed')),
        'last_reminded_at', max(x.last_reminded_at),
        'blocked', private.driver_blocker(d.id, null)) as j,
      coalesce(sum(x.amount_cents) filter (where x.direction = 'driver_owes'
        and (x.status = 'disputed' or (x.status = 'due' and x.due_at <= now()))), 0) as overdue,
      coalesce(sum(x.amount_cents) filter (where x.direction = 'driver_owes'), 0) as owed,
      d.last_name || ' ' || d.first_name as label
    from public.ride_settlements x
    join public.drivers d on d.id = x.driver_id
    where x.organization_id = p_org and x.status in ('due', 'declared', 'disputed')
    group by d.id
  ) t;

  return jsonb_build_object(
    'model', o.dispatch_model,
    'currency', o.currency,
    'month_start', v_month,
    'platform_fee', jsonb_build_object('percent', o.platform_fee_percent, 'fixed_cents', o.platform_fee_fixed_cents),
    'settings', jsonb_build_object(
      'commission_percent', s.driver_commission_percent,
      'commission_fixed_cents', s.driver_commission_fixed_cents,
      'grace_hours', s.settlement_grace_hours,
      'credit_limit_cents', s.settlement_credit_limit_cents,
      'block_unpaid', s.block_unpaid,
      'new_driver_max_price_cents', s.new_driver_max_price_cents,
      'trust_after_rides', s.trust_after_rides,
      'methods', to_jsonb(s.settlement_methods),
      'link', s.settlement_link,
      'instructions', s.settlement_instructions),
    'totals', v_totals,
    'month', v_month_rides,
    'drivers', v_drivers
  );
end;
$$;

-- Dernière définition : 20260924002600_centrale_mode.sql. Réseau partagé — liste sans les lignes réseau (Encaissements
-- = règlements propres). Sans réseau : réponse identique.
create or replace function public.org_settlements(
  p_org uuid,
  p_filter text default 'open',
  p_driver uuid default null,
  p_limit integer default 100,
  p_before timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_filter text := coalesce(nullif(p_filter, ''), 'open');
  v_items jsonb;
begin
  perform private.assert_org_member(p_org);
  if v_filter not in ('open', 'declared', 'overdue', 'disputed', 'to_pay', 'paid', 'waived', 'all') then
    v_filter := 'open';
  end if;

  select coalesce(jsonb_agg(private.settlement_json(q.st) || jsonb_build_object(
      'ride', jsonb_build_object(
        'number', r.number,
        'pickup', coalesce(private.short_address(r.pickup_address), r.pickup_address),
        'dropoff', coalesce(private.short_address(r.dropoff_address), r.dropoff_address),
        'completed_at', r.completed_at,
        'customer_name', r.customer_name),
      'driver', case when d.id is null then null else jsonb_build_object(
        'id', d.id, 'number', d.number, 'first_name', d.first_name, 'last_name', d.last_name, 'phone', d.phone,
        'trust_level', d.trust_level, 'banned', d.banned_at is not null) end)
      order by (q.st).created_at desc), '[]'::jsonb)
    into v_items
  from (
    select y as st
    from public.ride_settlements y
    where y.organization_id = p_org
      -- Réseau partagé : Encaissements = règlements propres (lignes réseau : onglet « Réseau partagé »)
      and y.network_driver_org_id is null
      and (p_driver is null or y.driver_id = p_driver)
      and (p_before is null or y.created_at < p_before)
      and case v_filter
            when 'open' then y.status in ('due', 'declared', 'disputed')
            when 'declared' then y.status = 'declared'
            when 'overdue' then y.direction = 'driver_owes'
              and (y.status = 'disputed' or (y.status = 'due' and y.due_at <= now()))
            when 'disputed' then y.status = 'disputed'
            when 'to_pay' then y.direction = 'centrale_owes' and y.status = 'due'
            when 'paid' then y.status = 'paid'
            when 'waived' then y.status = 'waived'
            else true
          end
    order by y.created_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  ) q
  join public.rides r on r.id = (q.st).ride_id
  left join public.drivers d on d.id = (q.st).driver_id;

  return jsonb_build_object('filter', v_filter, 'items', v_items);
end;
$$;

-- Dernière définition : 20260924006300_fleet_join_link.sql. Réseau partagé — lignes réseau ignorées : réglées dans
-- l'onglet « Réseau partagé » quel que soit le modèle de A (centrale → flotte permis avec des règlements réseau ouverts).
create or replace function private.organizations_dispatch_model_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_open integer;
begin
  if tg_op = 'UPDATE' and old.dispatch_model = 'centrale' and new.dispatch_model = 'fleet' then
    select count(*) into v_open
    from public.ride_settlements x
    where x.organization_id = new.id and x.status in ('due', 'declared', 'disputed')
      -- Réseau partagé : lignes réseau ignorées (réglées dans l'onglet « Réseau partagé », quel que soit le modèle de A)
      and x.network_driver_org_id is null;
    if v_open > 0 then
      raise exception 'SETTLEMENTS_OPEN: % règlement(s) chauffeur encore ouvert(s) — soldez-les ou annulez-les avant le retour au mode flotte', v_open
        using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

-- Dernière définition : 20260924006600_platform_fee_schedule.sql. Réseau partagé — même garde que le déclencheur
-- organizations_dispatch_model_guard ci-dessus : le retour au mode flotte ignore les lignes réseau (sinon le super admin
-- serait refusé là où le déclencheur l'accepte). Corps 006600 gardé À L'IDENTIQUE ; sans ligne réseau : identique.
create or replace function public.svc_platform_set_fees(
  p_org uuid,
  p_actor uuid,
  p_percent numeric,
  p_fixed_cents integer,
  p_dispatch_model text default null,
  p_mode text default 'notice',
  p_effective_on date default null,
  p_consent_note text default null,
  p_org_legal_version text default null,
  p_org_legal_effective_on date default null,
  p_app_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  c public.platform_fee_changes;   -- changement en attente (verrouillé)
  n public.platform_fee_changes;   -- nouveau changement programmé
  a public.platform_fee_changes;   -- changement appliqué tout de suite
  v_mode text := lower(coalesce(nullif(btrim(p_mode), ''), 'notice'));
  v_note text := left(nullif(btrim(regexp_replace(coalesce(p_consent_note, ''), '\s+', ' ', 'g')), ''), 500);
  v_percent numeric(5, 2);
  v_fixed integer := p_fixed_cents;
  v_model text;
  v_tz text;
  v_today date;
  v_version text := nullif(btrim(coalesce(p_org_legal_version, '')), '');
  v_rates_given boolean := p_percent is not null or p_fixed_cents is not null;
  v_accepted boolean;
  v_increase boolean;
  v_now_percent numeric(5, 2);
  v_now_fixed integer;
  v_model_changed boolean;
  v_rates_changed boolean;
  v_schedule boolean := false;
  v_keep boolean := false;
  v_close boolean := false;
  v_pending_on date;
  v_min date;
  v_std date;
  v_30 date;
  v_reason text;
  v_on date;
  v_open integer;
  v_mail jsonb;
  v_emails integer := 0;
  v_code text;
  v_msg text;
begin
  perform private.assert_platform_actor(p_actor);
  if v_mode not in ('initial', 'notice', 'consent') then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'field', 'mode', 'message', 'Mode de réglage inconnu.');
  end if;
  -- Taux : les deux, ou aucun (changement de modèle seul : taux et changement en attente inchangés)
  if v_rates_given and (p_percent is null or round(p_percent, 2) < 0 or round(p_percent, 2) > 50) then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'field', 'platformFeePercent',
      'message', private.fr_typo('Frais plateforme (%) : entre 0 et 50.'));
  end if;
  v_percent := round(p_percent, 2);
  if v_rates_given and (v_fixed is null or v_fixed < 0 or v_fixed > 100000) then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'field', 'platformFeeFixedCents',
      'message', private.fr_typo('Frais fixes par course : entre 0 et 1 000 €.'));
  end if;
  if p_dispatch_model is not null and p_dispatch_model not in ('fleet', 'centrale') then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'field', 'dispatchModel', 'message', 'Modèle d''exploitation inconnu.');
  end if;
  if v_version is not null and not private.legal_version_ok(v_version) then
    return jsonb_build_object('ok', false, 'code', 'TERMS_VERSION_INVALID', 'message', 'Version des CGV invalide.');
  end if;

  -- Organisation puis changement en attente : même ordre de verrouillage que l'annulation et le ménage (« no key
  -- update », comme un UPDATE : les insertions qui référencent l'organisation, courses ou écritures, ne sont pas bloquées)
  select * into o from public.organizations where id = p_org for no key update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Organisation introuvable.');
  end if;
  select * into c from public.platform_fee_changes x where x.organization_id = p_org and x.status = 'scheduled' for no key update;
  v_tz := coalesce(o.timezone, 'Europe/Paris');
  v_today := (now() at time zone v_tz)::date;
  v_pending_on := (c.effective_at at time zone v_tz)::date;
  v_accepted := case when v_version is not null then private.org_terms_accepted(p_org, v_version) end;
  v_model := coalesce(p_dispatch_model, o.dispatch_model);
  v_model_changed := v_model is distinct from o.dispatch_model;
  if not v_rates_given then
    v_percent := o.platform_fee_percent;
    v_fixed := o.platform_fee_fixed_cents;
  end if;

  -- Création : seulement une organisation tout juste créée, sans aucune course
  if v_mode = 'initial' and (o.created_at < now() - interval '1 hour'
                             or exists (select 1 from public.rides r where r.organization_id = p_org)) then
    return jsonb_build_object('ok', false, 'code', 'ORG_NOT_NEW',
      'message', private.fr_typo('Réglage initial réservé à une organisation tout juste créée, sans course : programmez la hausse ou indiquez l''accord écrit.'));
  end if;

  -- Changement de modèle d'exploitation (hors création) : seulement à la demande de l'organisation ou avec son accord
  -- écrit (CGV art. 3), noté (date et forme) et journalisé — passer de centrale à flotte peut augmenter ses frais (fixe
  -- dû même sans prix, plus de plafond au prix)
  if v_model_changed and v_mode <> 'initial' and (v_note is null or char_length(v_note) < 3) then
    return jsonb_build_object('ok', false, 'code', 'CONSENT_REQUIRED', 'field', 'consentNote',
      'message', private.fr_typo('Changement de modèle : précisez la demande ou l''accord écrit de l''organisation (date et forme : e-mail, courrier…), CGV article 3.'));
  end if;

  -- Retour au mode flotte : refusé tant qu'un règlement chauffeur est ouvert (même garde que le déclencheur
  -- organizations_dispatch_model_guard, qui reste le dernier rempart)
  if o.dispatch_model = 'centrale' and v_model = 'fleet' then
    select count(*) into v_open from public.ride_settlements x
     where x.organization_id = p_org and x.status in ('due', 'declared', 'disputed')
       -- Réseau partagé : lignes réseau ignorées (réglées dans l'onglet « Réseau partagé », quel que soit le modèle de A)
       and x.network_driver_org_id is null;
    if v_open > 0 then
      return jsonb_build_object('ok', false, 'code', 'SETTLEMENTS_OPEN', 'count', v_open, 'field', 'dispatchModel',
        'message', private.fr_typo(format('%s règlement%s chauffeur encore ouvert%s (à régler, signalé%s payé%s ou contesté%s) : la centrale doit les solder ou les annuler dans Encaissements avant le retour au mode flotte.',
          v_open, case when v_open > 1 then 's' else '' end, case when v_open > 1 then 's' else '' end,
          case when v_open > 1 then 's' else '' end, case when v_open > 1 then 's' else '' end, case when v_open > 1 then 's' else '' end)));
    end if;
  end if;

  -- Hausse : l'un des deux taux augmente (une baisse du % compensée par une hausse du fixe reste une hausse)
  v_increase := v_mode <> 'initial' and (v_percent > o.platform_fee_percent or v_fixed > o.platform_fee_fixed_cents);
  v_now_percent := o.platform_fee_percent;
  v_now_fixed := o.platform_fee_fixed_cents;

  if not v_increase then
    -- Création, baisse ou taux inchangés : tout de suite ; un changement en attente est remplacé (sauf modèle seul,
    -- sans taux : il reste prévu)
    v_now_percent := v_percent;
    v_now_fixed := v_fixed;
    v_close := v_rates_given and c.id is not null;
    v_keep := not v_rates_given and c.id is not null;
  elsif v_mode = 'consent' then
    -- Accord écrit de l'organisation : tout de suite, note obligatoire
    if v_note is null or char_length(v_note) < 3 then
      return jsonb_build_object('ok', false, 'code', 'CONSENT_REQUIRED', 'field', 'consentNote',
        'message', private.fr_typo('Accord écrit : précisez sa date et sa forme (e-mail, courrier…) pour appliquer la hausse tout de suite.'));
    end if;
    v_now_percent := v_percent;
    v_now_fixed := v_fixed;
    v_close := c.id is not null;
  else
    -- Hausse avec préavis
    if v_version is null or p_org_legal_effective_on is null then
      return jsonb_build_object('ok', false, 'code', 'TERMS_VERSION_INVALID',
        'message', 'Version des CGV et date de leur entrée en vigueur requises pour programmer une hausse.');
    end if;
    -- CGV en vigueur ni acceptées ni annoncées à cette organisation : aucune hausse annoncée (elle ne lui sont pas
    -- opposables) ; accord écrit possible
    if not v_accepted and not private.org_terms_notified(p_org, v_version) then
      return jsonb_build_object('ok', false, 'code', 'TERMS_NOT_NOTIFIED', 'field', 'mode', 'terms_accepted', false,
        'message', private.fr_typo(format('CGV du %s ni acceptées par l''organisation ni annoncées par e-mail : prévenez-la d''abord (Informations légales, « Prévenir par e-mail »), ou appliquez la hausse sur son accord écrit.',
          private.fr_long_date(v_version::date))));
    end if;
    -- Annonce par e-mail impossible (CGV art. 5 : annoncée au propriétaire par e-mail, à défaut à l'organisation)
    if private.org_owner_emails(p_org) is null then
      return jsonb_build_object('ok', false, 'code', 'NO_EMAIL', 'field', 'mode',
        'message', private.fr_typo('Aucune adresse e-mail valide pour le propriétaire ni pour l''organisation : corrigez l''adresse pour annoncer la hausse, ou appliquez-la sur son accord écrit.'));
    end if;
    v_std := private.platform_fee_min_effective_on(p_org, v_version, p_org_legal_effective_on);
    v_30 := private.platform_fee_min_effective_on(p_org, null, null);
    v_min := v_std;
    v_reason := case when v_std > v_30 then 'terms_effective' else 'notice_30_days' end;
    -- Hausse moindre ou égale à celle déjà annoncée : la date annoncée reste possible
    if c.id is not null and v_percent <= c.to_percent and v_fixed <= c.to_fixed_cents and v_pending_on < v_min then
      v_min := v_pending_on;
      v_reason := 'already_announced';
    end if;
    -- Par défaut : la date déjà annoncée quand elle est permise, sinon la plus proche possible
    v_on := coalesce(p_effective_on, case when c.id is not null then greatest(v_min, v_pending_on) else v_min end);
    if v_on < v_min then
      return jsonb_build_object('ok', false, 'code', 'NOTICE_TOO_SHORT', 'field', 'effectiveOn',
        'min_effective_on', v_min, 'min_reason', v_reason, 'terms_accepted', v_accepted,
        'message', private.fr_typo(format('Préavis insuffisant : cette hausse peut s''appliquer au plus tôt le %s (%s). Pour l''appliquer avant, indiquez l''accord écrit de l''organisation.',
          to_char(v_min, 'DD/MM/YYYY'),
          case v_reason
            when 'terms_effective' then 'entrée en vigueur des CGV, que l''organisation n''a pas encore acceptées'
            when 'already_announced' then 'date déjà annoncée'
            else '30 jours après l''annonce' end)));
    end if;
    if v_on > v_today + 366 then
      return jsonb_build_object('ok', false, 'code', 'INVALID', 'field', 'effectiveOn',
        'message', private.fr_typo('Date d''effet trop lointaine : un an au plus.'));
    end if;
    if c.id is not null and c.to_percent = v_percent and c.to_fixed_cents = v_fixed and v_pending_on = v_on then
      v_keep := true;
    else
      v_schedule := true;
      v_close := c.id is not null;
    end if;
  end if;

  v_rates_changed := (v_now_percent, v_now_fixed) is distinct from (o.platform_fee_percent, o.platform_fee_fixed_cents);
  perform private.set_actor('super_admin', p_actor);

  -- Modèle et / ou taux appliqués tout de suite (diffusion « platform.updated » model / rates par le déclencheur)
  if v_model_changed or v_rates_changed then
    update public.organizations
       set dispatch_model = v_model, platform_fee_percent = v_now_percent, platform_fee_fixed_cents = v_now_fixed
     where id = p_org;
  end if;

  if v_close then
    update public.platform_fee_changes
       set status = 'replaced', closed_at = now(), closed_by = p_actor,
           close_reason = case when v_schedule then 'Remplacé par un nouveau changement programmé'
                               when v_rates_changed then 'Remplacé par des frais appliqués tout de suite'
                               else 'Annulé : frais actuels maintenus' end
     where id = c.id;
  end if;

  if v_rates_changed then
    insert into public.platform_fee_changes (organization_id, mode, status, from_percent, from_fixed_cents, to_percent,
      to_fixed_cents, effective_at, consent_note, terms_version, terms_accepted, created_by, applied_at)
    values (p_org, case when v_mode = 'initial' then 'initial' when v_increase then 'consent' else 'decrease' end, 'applied',
      o.platform_fee_percent, o.platform_fee_fixed_cents, v_now_percent, v_now_fixed, now(),
      case when v_increase then v_note end, v_version, v_accepted, p_actor, now())
    returning * into a;
  end if;

  if v_schedule then
    -- Date gardée d'une hausse déjà annoncée, plus proche que 30 jours : le préavis repose sur la première annonce
    insert into public.platform_fee_changes (organization_id, mode, status, from_percent, from_fixed_cents, to_percent,
      to_fixed_cents, effective_at, terms_version, terms_accepted, created_by, notice_change_id)
    values (p_org, 'notice', 'scheduled', o.platform_fee_percent, o.platform_fee_fixed_cents, v_percent, v_fixed,
      v_on::timestamp at time zone v_tz, v_version, v_accepted, p_actor,
      case when v_on < v_std then coalesce(c.notice_change_id, c.id) end)
    returning * into n;
  end if;

  -- E-mails aux propriétaires : annonce, confirmation d'une hausse sur accord écrit, frais à l'ouverture du compte, ou
  -- annulation d'une annonce
  if v_schedule then
    v_mail := private.platform_fee_change_email('notice', p_org, v_model, o.platform_fee_percent, o.platform_fee_fixed_cents,
      v_percent, v_fixed, v_on, case when v_close then v_pending_on end, p_app_url);
    v_emails := private.queue_org_emails(p_org, 'platform_fee_change', v_mail ->> 'subject', v_mail ->> 'body', n.id, p_actor);
    update public.platform_fee_changes set emails_queued = v_emails where id = n.id returning * into n;
  elsif a.mode in ('consent', 'initial') then
    v_mail := private.platform_fee_change_email(a.mode, p_org, v_model, a.from_percent, a.from_fixed_cents,
      a.to_percent, a.to_fixed_cents, v_today, case when v_close then v_pending_on end, p_app_url);
    v_emails := private.queue_org_emails(p_org, 'platform_fee_change', v_mail ->> 'subject', v_mail ->> 'body', a.id, p_actor);
    update public.platform_fee_changes set emails_queued = v_emails where id = a.id returning * into a;
  elsif v_close then
    v_mail := private.platform_fee_change_email('cancel', p_org, v_model, o.platform_fee_percent, o.platform_fee_fixed_cents,
      v_now_percent, v_now_fixed, null, v_pending_on, p_app_url);
    v_emails := private.queue_org_emails(p_org, 'platform_fee_change', v_mail ->> 'subject', v_mail ->> 'body', c.id, p_actor);
  end if;

  -- Temps réel (identifiants seulement) : annonce ou annulation sans changement de taux
  if v_schedule then
    perform private.broadcast_platform(p_org, 'rates_scheduled');
  elsif v_close and not v_rates_changed then
    perform private.broadcast_platform(p_org, 'rates_cancelled');
  end if;

  -- Journal d'audit
  if v_model_changed or v_rates_changed then
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
    values (p_org, 'super_admin', p_actor,
      case when v_model_changed then 'organization.dispatch_model_changed' else 'organization.platform_fee_changed' end,
      'organizations', p_org::text,
      case when v_model_changed or a.mode = 'consent' then 'warning' else 'info' end,
      jsonb_build_object(
        'before', jsonb_build_object('dispatch_model', o.dispatch_model, 'platform_fee_percent', o.platform_fee_percent,
          'platform_fee_fixed_cents', o.platform_fee_fixed_cents),
        'after', jsonb_build_object('dispatch_model', v_model, 'platform_fee_percent', v_now_percent,
          'platform_fee_fixed_cents', v_now_fixed),
        'mode', a.mode, 'change_id', a.id, 'consent_note', a.consent_note,
        -- Demande ou accord écrit de l'organisation pour le changement de modèle (CGV art. 3)
        'model_note', case when v_model_changed then v_note end,
        'terms_version', v_version, 'terms_accepted', v_accepted,
        'emails', case when a.mode in ('consent', 'initial') then v_emails end,
        -- Lien d'inscription conservé tel quel lors d'un changement de modèle (20260924006300)
        'join_link_enabled', o.join_enabled));
  end if;
  if v_schedule then
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
    values (p_org, 'super_admin', p_actor, 'organization.platform_fee_scheduled', 'organizations', p_org::text, 'info',
      jsonb_build_object('change_id', n.id,
        'from', jsonb_build_object('platform_fee_percent', n.from_percent, 'platform_fee_fixed_cents', n.from_fixed_cents),
        'to', jsonb_build_object('platform_fee_percent', n.to_percent, 'platform_fee_fixed_cents', n.to_fixed_cents),
        'effective_at', n.effective_at, 'effective_on', v_on, 'min_effective_on', v_min, 'min_reason', v_reason,
        'notice_change_id', n.notice_change_id,
        'terms_version', v_version, 'terms_accepted', v_accepted, 'emails', v_emails,
        'replaced_change_id', case when v_close then c.id end));
  end if;
  if v_close then
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
    values (p_org, 'super_admin', p_actor, 'organization.platform_fee_schedule_cancelled', 'organizations', p_org::text, 'info',
      jsonb_build_object('change_id', c.id, 'reason', 'replaced',
        'to', jsonb_build_object('platform_fee_percent', c.to_percent, 'platform_fee_fixed_cents', c.to_fixed_cents),
        'effective_at', c.effective_at, 'replaced_by', coalesce(n.id, a.id),
        'emails', case when not v_schedule and a.mode is distinct from 'consent' then v_emails end));
  end if;

  v_code := case when v_schedule then 'SCHEDULED'
                 when v_model_changed or v_rates_changed then 'APPLIED'
                 when v_close then 'CANCELLED'
                 else 'UNCHANGED' end;
  v_msg := case v_code
    when 'SCHEDULED' then
      format('Hausse programmée : %s à partir du %s. ', private.platform_fee_terms_text(v_percent, v_fixed), to_char(v_on, 'DD/MM/YYYY'))
      || case when v_emails > 0 then format('Annonce envoyée par e-mail au propriétaire (%s e-mail%s).', v_emails, case when v_emails > 1 then 's' else '' end)
              else 'Aucune adresse e-mail valide pour le propriétaire : prévenez l''organisation vous-même.' end
    when 'APPLIED' then
      concat_ws(' ',
        case when v_model_changed then 'Modèle d''exploitation enregistré.' end,
        case when a.mode = 'consent' then format('Accord écrit enregistré : %s dès maintenant.', private.platform_fee_terms_text(v_now_percent, v_now_fixed))
                                         || case when v_emails > 0 then ' Confirmation envoyée par e-mail au propriétaire.' else '' end
             when a.mode = 'initial' then format('Frais par course : %s.', private.platform_fee_terms_text(v_now_percent, v_now_fixed))
                                         || case when v_emails > 0 then ' Communiqués par e-mail au propriétaire.'
                                                 else ' Aucune adresse e-mail valide : communiquez-les vous-même à l''organisation.' end
             when v_rates_changed then format('Frais par course enregistrés dès maintenant : %s.', private.platform_fee_terms_text(v_now_percent, v_now_fixed)) end,
        case when v_close and a.mode is distinct from 'consent' then 'Le changement programmé est annulé.' end,
        case when v_keep then format('Le changement programmé reste prévu le %s.', to_char(v_pending_on, 'DD/MM/YYYY')) end)
    when 'CANCELLED' then
      format('Changement programmé annulé. Frais inchangés : %s.', private.platform_fee_terms_text(v_now_percent, v_now_fixed))
    else
      'Aucun changement.' || case when v_keep then format(' Le changement programmé reste prévu le %s.', to_char(v_pending_on, 'DD/MM/YYYY')) else '' end
  end;

  return jsonb_build_object(
    'ok', true,
    'code', v_code,
    'message', private.fr_typo(v_msg),
    'dispatch_model', v_model,
    'fee_percent', v_now_percent,
    'fee_fixed_cents', v_now_fixed,
    'scheduled_change', private.platform_scheduled_change_json(p_org, v_tz),
    'applied_change_id', a.id,
    'replaced_change_id', case when v_close then c.id end,
    'emails_queued', v_emails,
    'terms_accepted', v_accepted,
    'min_effective_on', v_min,
    'min_reason', v_reason);
end;
$$;

-- Dernière définition : 20260924004400_audit_argent.sql. Réseau partagé — seules les courses de SON organisation
-- comptent pour devenir « chauffeur confirmé » (règle propre à B : une course partenaire n'y entre pas). Sans course
-- partenaire : identique.
create or replace function private.maybe_promote_driver(p_driver uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_after integer;
  v_done integer;
begin
  select * into d from public.drivers where id = p_driver for update;
  if not found or d.trust_level <> 'new' or d.status <> 'active' or d.banned_at is not null then
    return false;
  end if;
  select s.trust_after_rides into v_after from public.organization_settings s where s.organization_id = d.organization_id;
  if v_after is null then
    return false;
  end if;
  if exists (
    select 1 from public.ride_settlements x
    where x.driver_id = d.id and x.direction = 'driver_owes' and x.amount_cents > 0
      and (x.status = 'disputed' or (x.status = 'due' and x.due_at <= now())
           or (x.status = 'declared' and x.disputed_at is not null))
  ) then
    return false;
  end if;

  select count(*) into v_done
  from public.rides r
  where r.driver_id = d.id
    and r.status = 'COMPLETED'
    -- Réseau partagé : courses de son organisation seulement (une course partenaire ne compte pas chez B)
    and r.organization_id = d.organization_id
    and not exists (
      select 1 from public.ride_settlements x
      where x.ride_id = r.id and x.direction = 'driver_owes' and x.status <> 'paid'
    );
  if v_done < v_after then
    return false;
  end if;

  update public.drivers set trust_level = 'trusted' where id = d.id;
  perform private.log_event(d.organization_id, null, 'driver.trusted',
    format('%s %s (#%s) devient chauffeur confirmé (%s %s)', d.first_name, d.last_name, d.number,
      v_done, private.pl(v_done, 'course réglée', 'courses réglées')),
    'timeline', 'success', jsonb_build_object('driver_id', d.id, 'rides', v_done), 'system', null);
  perform private.queue_notification(d.organization_id, d.id, null, null, 'driver_trusted', 'CHAUFFEUR CONFIRMÉ',
    'Merci pour votre sérieux : toutes les courses de la centrale vous sont désormais proposées.',
    jsonb_build_object('type', 'driver_trusted'), 'normal', null);
  return true;
end;
$$;

-- -----------------------------------------------------------------------------------------------------------------
-- 8.6 Blocages (§10.7, S2, critère 12)
-- -----------------------------------------------------------------------------------------------------------------
-- private.network_blocker (lot dispatch, 20260924006800) applique déjà les règles locales : own_unpaid (dettes propres
-- chez B → plus d'offre réseau), giver_unpaid (impayé envers A → courses de A seulement), giver_credit_limit (plafond de
-- A), executor_limit (plafond de B, toutes donneuses). Échéance d'au moins 48 h : private.sync_network_settlement (4a) ;
-- réouverture → nouvelle échéance : public.reopen_settlement (ci-dessus).

-- Dernière définition : 20260924006800_shared_network_dispatch.sql. Seul ajout (« debtor ») : une AUTRE fiche non
-- supprimée du même chauffeur (mêmes empreintes : il a changé d'organisation) qui doit à A un reversement réseau
-- bloquant selon la règle de A (block_unpaid : « Pas reçu », échu, ou redéclaré après « Pas reçu ») — un débiteur de A
-- ne revient pas par une autre organisation (le lot dispatch ne couvrait que les comptes supprimés).
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

-- -----------------------------------------------------------------------------------------------------------------
-- 8.7 Relances automatiques (§10.8)
-- -----------------------------------------------------------------------------------------------------------------

-- Dernière définition : 20260924003700_whatsapp_reminders.sql. Réseau partagé — seconde boucle sur les lignes réseau
-- (application seulement) ; la boucle propre et ses relances WhatsApp sont inchangées (jointure sur driver_id : jamais
-- une ligne réseau). Clé « network » seulement s'il y a eu une relance réseau.
create or replace function private.settlement_reminders()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_count integer := 0;
  v_wa integer := 0;
  v_res jsonb;
  -- Réseau partagé
  v_network integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('rydar.settlement_reminders', 0)) then
    return jsonb_build_object('ok', false, 'code', 'BUSY', 'reminders', 0);
  end if;
  for v in
    select x.driver_id, x.organization_id, o.name as org_name, d.first_name,
           coalesce(s.reminder_channels, '{app}') as channels,
           sum(x.amount_cents)::integer as total, count(*) as n, array_agg(x.id) as ids
    from public.ride_settlements x
    join public.organizations o on o.id = x.organization_id
    join public.drivers d on d.id = x.driver_id
    left join public.organization_settings s on s.organization_id = x.organization_id
    where x.direction = 'driver_owes'
      and x.status in ('due', 'disputed')
      and x.due_at <= now()
      and o.status = 'active'
      and o.dispatch_model = 'centrale'
      and d.status = 'active'
    group by x.driver_id, x.organization_id, o.name, d.first_name, s.reminder_channels
    having min(x.reminders_sent) < 3
       and coalesce(max(x.last_reminded_at), '-infinity'::timestamptz) < now() - interval '23 hours'
  loop
    v_res := private.remind_driver(v.organization_id, v.driver_id, v.channels, 'settlement_reminder', 'COMMISSION EN RETARD',
      format('%s à régler à %s — réglez-les pour continuer à recevoir des courses', private.fmt_eur(v.total), v.org_name),
      jsonb_build_object('type', 'settlement_reminder', 'amount_cents', v.total, 'count', v.n),
      array[v.first_name, private.fmt_eur(v.total), v.org_name, format('%s %s', v.n, private.pl(v.n, 'course', 'courses'))]);
    update public.ride_settlements
       set reminders_sent = reminders_sent + 1, last_reminded_at = now()
     where id = any (v.ids);
    v_count := v_count + 1;
    if v_res -> 'channels' ? 'whatsapp' then
      v_wa := v_wa + 1;
    end if;
  end loop;

  -- Réseau partagé (§10.8) : reversements échus des chauffeurs partenaires (lignes réseau : la boucle ci-dessus ne les
  -- voit jamais, jointure sur driver_id), par chauffeur et par organisation créancière A, quel que soit son modèle :
  -- APPLICATION seulement (aucun WhatsApp en v1 : modèles non approuvés), 3 relances au plus, 23 h d'écart ; chauffeur
  -- actif (fiche non supprimée), A active. Jamais de mot « commission » : « Rappel : X à régler à {A} ».
  for v in
    select x.network_driver_id as driver_id, x.organization_id, o.name as org_name,
           sum(x.amount_cents)::integer as total, count(*) as n, array_agg(x.id) as ids
    from public.ride_settlements x
    join public.organizations o on o.id = x.organization_id
    join public.drivers d on d.id = x.network_driver_id
    where x.network_driver_org_id is not null
      and x.direction = 'driver_owes'
      and x.status in ('due', 'disputed')
      and x.due_at <= now()
      and x.amount_cents > 0
      and o.status = 'active'
      and d.status = 'active'
      and d.deleted_at is null
    group by x.network_driver_id, x.organization_id, o.name
    having min(x.reminders_sent) < 3
       and coalesce(max(x.last_reminded_at), '-infinity'::timestamptz) < now() - interval '23 hours'
  loop
    perform private.network_notify(v.organization_id, v.driver_id, null, 'settlement_reminder',
      'RAPPEL — À RÉGLER À ' || v.org_name,
      format('Rappel : %s à régler à %s (%s %s)', private.fmt_eur(v.total), v.org_name, v.n,
        private.pl(v.n, 'course partenaire', 'courses partenaires')),
      jsonb_build_object('amount_cents', v.total, 'count', v.n), 'high');
    update public.ride_settlements
       set reminders_sent = reminders_sent + 1, last_reminded_at = now()
     where id = any (v.ids);
    v_network := v_network + 1;
  end loop;

  -- Réseau partagé : relances réseau comptées dans « reminders » (le worker traite alors la file) et détaillées dans
  -- « network » (clé absente sans relance réseau : réponse d'avant)
  return jsonb_build_object('ok', true, 'reminders', v_count + v_network, 'whatsapp', v_wa)
    || case when v_network > 0 then jsonb_build_object('network', v_network) else '{}'::jsonb end;
end;
$$;

-- -----------------------------------------------------------------------------------------------------------------
-- 8.8 Frais Rydar d'une course partagée (§10.9)
-- -----------------------------------------------------------------------------------------------------------------

-- Dernière définition : 20260924006400_fleet_platform_fees.sql. Réseau partagé — course tenue par un chauffeur d'une
-- autre organisation : cible = frais Rydar des termes FIGÉS de l'exécution « completed » (taux de A à l'acceptation,
-- flotte comme centrale), écriture « Course N · réseau partagé » dans le registre de A, une seule fois (aucune base
-- « flotte » figée, aucun recalcul : la baisse demandée par contest_network_ride reste en attente du super admin).
-- Course propre : corps identique.
create or replace function private.sync_platform_fee()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target integer;
  v_posted integer;
  v_pending integer;
  v_count integer;
  v_delta integer;
  v_at timestamptz;
  o public.organizations;
  b private.fleet_fee_basis;
  e public.platform_fee_entries;
  s public.platform_fee_entries;
  -- Réseau partagé
  v_network boolean := false;
  v_network_fee integer;
begin
  if new.status <> 'COMPLETED' then
    return null;
  end if;

  -- Réseau partagé : course exécutée par un chauffeur d'une autre organisation → frais Rydar de A aux termes FIGÉS de
  -- l'exécution « completed » (taux de A à l'acceptation : jamais rides.platform_fee_cents ni les taux du moment),
  -- une seule écriture « Course N · réseau partagé », dans le registre de A seulement (rien chez B), due même si le
  -- règlement avec le chauffeur est contesté ; jamais de recalcul ensuite (prix verrouillé, G6 : la baisse demandée par
  -- contest_network_ride reste en attente du super admin) ; aucune base « flotte » figée.
  if new.driver_org_id is not null and new.driver_org_id <> new.organization_id then
    select (x.terms ->> 'platform_fee_cents')::integer into v_network_fee
      from public.ride_network_executions x
     where x.ride_id = new.id and x.end_reason = 'completed'
     order by x.ended_at desc
     limit 1;
    v_network := found;
    if v_network and exists (select 1 from public.platform_fee_entries x where x.ride_id = new.id) then
      return null;
    end if;
  end if;

  -- Flotte : base figée à la fin de la course (seulement à cet instant : une course terminée avant, ou en centrale,
  -- n'en reçoit jamais). Rien à figer pour une flotte sans frais ni répartition héritée d'un passage en centrale.
  select * into b from private.fleet_fee_basis where ride_id = new.id;
  if not found and not v_network and (tg_op = 'INSERT' or old.status is distinct from 'COMPLETED') then
    select * into o from public.organizations where id = new.organization_id;
    if o.dispatch_model = 'fleet'
       and (o.platform_fee_percent > 0 or o.platform_fee_fixed_cents > 0 or new.platform_fee_cents is not null) then
      insert into private.fleet_fee_basis (ride_id, organization_id, fee_percent, fee_fixed_cents)
      values (new.id, new.organization_id, o.platform_fee_percent, o.platform_fee_fixed_cents)
      on conflict (ride_id) do nothing;
      select * into b from private.fleet_fee_basis where ride_id = new.id;
    end if;
  end if;

  if v_network then
    v_target := coalesce(v_network_fee, 0);   -- Réseau partagé : termes figés
  elsif b.ride_id is not null and not exists (select 1 from public.ride_settlements x where x.ride_id = new.id) then
    v_target := private.fleet_platform_fee(new.price_cents, b.fee_percent, b.fee_fixed_cents);
  elsif new.platform_fee_cents is not null then
    v_target := new.platform_fee_cents;
  else
    -- Répartition calculée à la fin par sync_ride_settlement (déclenché avant), non écrite sur la course
    select x.platform_fee_cents into v_target from public.ride_settlements x where x.ride_id = new.id;
    v_target := coalesce(v_target, 0);
  end if;
  -- Baisses encore à valider verrouillées AVANT le calcul (décision du super admin en parallèle :
  -- l'une attend l'autre, jamais les deux sur le même état)
  perform 1 from public.platform_fee_entries x where x.ride_id = new.id and x.status = 'pending' for update;
  select coalesce(sum(x.amount_cents) filter (where x.status = 'posted'), 0)::integer,
         coalesce(sum(x.amount_cents) filter (where x.status = 'pending'), 0)::integer,
         count(*)
    into v_posted, v_pending, v_count
  from public.platform_fee_entries x
  where x.ride_id = new.id;
  if v_target = v_posted + v_pending then
    return null;
  end if;

  -- Nouveau montant : la baisse encore en attente est REMPLACÉE (sinon, refusée après une correction
  -- ultérieure calculée en la supposant acceptée, la hausse suivante compterait deux fois) ;
  -- la nouvelle correction se calcule sur les seuls frais comptabilisés
  for s in
    update public.platform_fee_entries
       set status = 'rejected', reviewed_at = now(),
           review_note = 'Remplacée : le prix de la course a de nouveau été modifié'
     where ride_id = new.id and status = 'pending'
    returning *
  loop
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
    values (new.organization_id, 'system', auth.uid(), 'platform_fee.reduction_superseded', 'platform_fee_entries', s.id::text,
      'info', jsonb_build_object('ride_id', new.id, 'amount_cents', s.amount_cents, 'target_cents', v_target));
  end loop;
  v_delta := v_target - v_posted;
  if v_delta = 0 then
    if s.id is not null then
      perform private.broadcast_platform(new.organization_id, 'fee', jsonb_build_object('entry', private.platform_entry_json(s)));
    end if;
    return null;
  end if;

  if v_count = 0 then
    v_at := coalesce(new.completed_at, now());
    -- Course déjà terminée (prix fixé après coup) : échéance à partir de maintenant ; course qui se
    -- termine maintenant : identique (completed_at = maintenant) ; import d'historique : inchangé
    insert into public.platform_fee_entries (organization_id, ride_id, kind, amount_cents, status, label, occurred_at, due_at)
    values (new.organization_id, new.id, 'ride', v_delta, 'posted',
      format('Course %s', new.number) || case when v_network then ' · réseau partagé' else '' end, v_at,
      private.platform_due_at(new.organization_id,
        case when tg_op = 'UPDATE' and old.status = 'COMPLETED' then greatest(v_at, now()) else v_at end))
    returning * into e;
  else
    -- Hausse : comptée tout de suite ; baisse : en attente de l'accord du super admin
    insert into public.platform_fee_entries (organization_id, ride_id, kind, amount_cents, status, label, reason, occurred_at, due_at)
    values (new.organization_id, new.id, 'correction', v_delta, case when v_delta > 0 then 'posted' else 'pending' end,
      format('Correction course %s : frais %s → %s', new.number, private.fmt_eur(v_posted), private.fmt_eur(v_target)),
      case when new.price_cents is distinct from old.price_cents
           then format('Prix modifié après la course : %s → %s', private.fmt_eur(old.price_cents), private.fmt_eur(new.price_cents))
           else 'Répartition recalculée après la course' end,
      now(), private.platform_due_at(new.organization_id, now()))
    returning * into e;
  end if;
  perform private.broadcast_platform(new.organization_id, case when e.status = 'pending' then 'reduction_pending' else 'fee' end,
    jsonb_build_object('entry', private.platform_entry_json(e)));
  return null;
end;
$$;

-- -----------------------------------------------------------------------------------------------------------------
-- 8.9 Dette et suppression de compte (§10.10, S2)
-- -----------------------------------------------------------------------------------------------------------------

-- Dernière définition : 20260924005500_contre_audit_app.sql. Réseau partagé — clé « network » (sommes dues aux
-- organisations partenaires) ajoutée seulement s'il y en a : rappelées avant la suppression du compte (app,
-- src/lib/debt.ts), aussi par public.driver_deletion_debt() et public.svc_driver_deletion_debt (inchangées).
create or replace function private.driver_deletion_debt(p_user_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
      'owed_cents', coalesce(sum(s.amount_cents) filter (where s.status in ('due', 'disputed')), 0),
      'declared_cents', coalesce(sum(s.amount_cents) filter (where s.status = 'declared'), 0),
      'currency', o.currency,
      'organization', o.name)
    -- Réseau partagé : sommes dues aux organisations partenaires (reversements des courses partenaires payées à bord,
    -- même périmètre) — contrat DriverDeletionNetworkDebt ; clé ajoutée seulement s'il y en a (réponse d'avant sinon)
    || coalesce((
      select jsonb_build_object('network', jsonb_agg(jsonb_build_object(
               'organization', g.name, 'owed_cents', n.owed, 'declared_cents', n.declared) order by g.name, g.id))
        from (select x.organization_id,
                     coalesce(sum(x.amount_cents) filter (where x.status in ('due', 'disputed')), 0)::integer as owed,
                     coalesce(sum(x.amount_cents) filter (where x.status = 'declared'), 0)::integer as declared
                from public.ride_settlements x
               where x.network_driver_id = d.id
                 and x.network_driver_org_id is not null
                 and x.direction = 'driver_owes'
                 and x.status in ('due', 'declared', 'disputed')
                 and x.amount_cents > 0
               group by x.organization_id) n
        join public.organizations g on g.id = n.organization_id
      having count(*) > 0), '{}'::jsonb)
    from public.drivers d
    join public.organizations o on o.id = d.organization_id
    left join public.ride_settlements s
      on s.driver_id = d.id
     and s.direction = 'driver_owes'
     and s.status in ('due', 'declared', 'disputed')
     and s.amount_cents > 0
   where p_user_id is not null
     and d.user_id = p_user_id
     and d.deleted_at is null
   group by d.id, o.currency, o.name;
$$;

-- Dernière définition : 20260924006800_shared_network_dispatch.sql. Réseau partagé — seul ajout : reversements réseau
-- encore dus → empreintes gardées pour chaque organisation créancière (private.network_debtor_identities ; audit :
-- « network_debtor_identities » seulement s'il y en a). L'effacement des traces chez A (private.scrub_network_traces)
-- et private.debtor_match restent au lot administration, qui part de cette version.
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
  v_network_debtor_ids integer := 0;
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

  -- Réseau partagé (§10.10, S2) : sommes encore dues à des organisations partenaires (reversements réseau ouverts) →
  -- empreintes (téléphone, e-mail, carte VTC ; jamais la valeur) gardées pour CHAQUE créancière dans
  -- private.network_debtor_identities, avant l'effacement des identifiants : le chauffeur ne revient pas chez elle par
  -- une autre organisation (private.network_identity_block, « debtor ») ; purgées par private.housekeeping une fois tout
  -- réglé. Empreintes de l'index d'identités (toutes les formes du téléphone) et des pièces.
  insert into private.network_debtor_identities (creditor_org_id, driver_id, kind, value_hash)
  select c.organization_id, d.id, i.kind, i.value_hash
    from (select distinct x.organization_id
            from public.ride_settlements x
           where x.network_driver_id = d.id
             and x.network_driver_org_id is not null
             and x.direction = 'driver_owes'
             and x.status in ('due', 'declared', 'disputed')
             and x.amount_cents > 0) c
   cross join (select k.kind, k.value_hash from private.driver_identity_keys k
                where k.driver_id = d.id and k.kind in ('phone', 'email', 'vtc_card')
               union
               select y.kind, y.value_hash from private.driver_identities(d.id, false) y
                where y.kind in ('phone', 'email', 'vtc_card')) i
  on conflict (creditor_org_id, driver_id, kind, value_hash) do nothing;
  get diagnostics v_network_debtor_ids = row_count;

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
      'owed_cents', v_owed_cents, 'owed_settlements', v_owed_count, 'debtor_identities', v_debtor_ids)
      -- Réseau partagé : empreintes gardées pour des organisations partenaires (clé absente sinon)
      || case when v_network_debtor_ids > 0 then jsonb_build_object('network_debtor_identities', v_network_debtor_ids)
              else '{}'::jsonb end);

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

-- Dernière définition : 20260924006600_platform_fee_schedule.sql. Corps 006600 gardé À L'IDENTIQUE ; seul ajout
-- (« Réseau partagé ») : empreintes réseau d'un compte supprimé purgées quand plus rien n'est dû à leur créancière
-- (comptées dans debtor_identities_purged : réponse de même forme).
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

-- -----------------------------------------------------------------------------------------------------------------
-- 8.10 Droits de la partie 4b
-- -----------------------------------------------------------------------------------------------------------------
-- Aides : fonctions serveur seulement
revoke all on function
  private.network_notify(uuid, uuid, uuid, text, text, text, jsonb, text),
  private.network_month(public.ride_network_executions)
from public, anon, authenticated;
grant execute on function
  private.network_notify(uuid, uuid, uuid, text, text, text, jsonb, text),
  private.network_month(public.ride_network_executions)
to service_role;

-- RPC de A (contrôle dans la fonction : assert_network_creditor ; « Relancer » : assert_org_member). Fonctions
-- redéfinies (même signature) : droits conservés.
revoke all on function
  public.org_network_payout_info(uuid),
  public.validate_network_ride(uuid),
  public.contest_network_ride(uuid, text),
  public.remind_network_driver(uuid, uuid)
from public, anon;
grant execute on function
  public.org_network_payout_info(uuid),
  public.validate_network_ride(uuid),
  public.contest_network_ride(uuid, text),
  public.remind_network_driver(uuid, uuid)
to authenticated, service_role;
