-- =============================================================================
-- Rydar Drive — Frais Rydar aussi pour les FLOTTES (abonnement + X € / Y % par course)
--
-- Modèle voulu par le propriétaire : « un abonnement de 49,99 € et 2 € de commission sur chaque course », flottes
-- comprises. L'abonnement existe déjà (offres, inchangé). Jusqu'ici, les frais plateforme (% du prix + fixe par
-- course, réglés par le super admin) ne naissaient qu'en mode centrale, dans la répartition du prix (rides.
-- platform_fee_cents). Désormais une flotte doit aussi ses frais à Rydar, avec EXACTEMENT les mêmes règles d'argent
-- (registre immuable platform_fee_entries, corrections en delta, baisses en attente du super admin, paiements FIFO,
-- « J'ai payé » / reçu / pas reçu, relances, blocage facultatif, relevés, temps réel platform.updated) :
--
--   • dus par la FLOTTE dès la fin de la course (COMPLETED) ; une course annulée ne doit rien ;
--   • montant = arrondi(prix × % / 100) + fixe. Sans prix (fréquent en flotte : clients en compte, facturés hors
--     Rydar), la part en % vaut 0 mais le fixe reste dû : « 2 € sur chaque course », et ne pas saisir de prix ne
--     doit pas annuler les frais. Pas de plafond au prix : en centrale les frais sont PRÉLEVÉS sur le prix (la part
--     chauffeur ne peut pas devenir négative, d'où least(prix, …) et « sans prix = sans répartition ») ; en flotte
--     ils sont FACTURÉS à la flotte, indépendamment de ce qu'elle encaisse. Le mode centrale ne change pas ;
--   • taux FIGÉS à la fin de la course (private.fleet_fee_basis) : un changement de réglage ne s'applique qu'aux
--     courses terminées après lui ; un prix corrigé après la course recalcule avec les taux figés de CETTE course
--     (hausse comptée tout de suite, baisse en attente du super admin, comme en centrale) ;
--   • le modèle qui compte est celui de la fin de la course : terminée en flotte → règle flotte (aucune base
--     n'est écrite si la flotte n'a aucun frais ni répartition héritée : rien à figer) ; terminée en centrale →
--     règle centrale (inchangée). Si une course terminée en flotte reçoit plus tard un règlement chauffeur (compte
--     repassé en centrale puis prix corrigé : répartition + règlement créés par la logique existante), la règle
--     centrale reprend la main (les frais suivent ce que le chauffeur verse à la centrale) — par correction en delta :
--     jamais de double frais, jamais de frais perdus (une baisse attend le super admin) ;
--   • courses terminées avant cette migration : jamais facturées en flotte (aucune base) ;
--   • taux figés = règle de la course tant qu'aucun règlement chauffeur n'existe : une course terminée en flotte
--     puis corrigée après un passage en centrale SANS règlement (aucun chauffeur, ou répartition à 0 % de commission
--     et 0 € de frais) garde ses taux de flotte, même si rides.platform_fee_cents vaut alors 0 ;
--   • rides.platform_fee_cents reste NULL en flotte : l'app chauffeur (select * sur rides) n'affiche jamais de frais
--     Rydar à un chauffeur de flotte.
-- Écrans : « Frais Rydar » (owner / admin) et compte super admin activés pour une flotte dès que des frais sont
-- réglés, ou qu'elle a un historique (private.platform_fees_enabled ; menu : public.org_platform_fees_enabled, le
-- seul booléen) ; le compte, le relevé et l'écriture disent si la course relève de la flotte (dispatch_model,
-- ride.fleet_fee) ; frais ou modèle changés → « platform.updated » (action « rates ») ; relance du super admin :
-- « la flotte » / « la centrale ». Les taux restent lisibles par tous les membres (GRANT par colonne de
-- organizations, nécessaire au select('*')) : ce sont les conditions de l'organisation, pas des montants dus ;
-- compte, écritures et paiements restent réservés à l'owner / admin.
-- Flottes existantes : des taux restés d'un ancien passage en centrale (« sans effet en mode flotte » jusqu'ici)
-- sont remis à 0 (journalisé) : aucune facturation surprise, le super admin règle ceux des flottes.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Base figée des frais d'une course terminée en flotte (taux en vigueur à la fin de la course)
-- -----------------------------------------------------------------------------
create table private.fleet_fee_basis (
  ride_id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  fee_percent numeric(5, 2) not null check (fee_percent between 0 and 50),
  fee_fixed_cents integer not null check (fee_fixed_cents between 0 and 100000),
  created_at timestamptz not null default now(),
  foreign key (organization_id, ride_id) references public.rides (organization_id, id) on delete cascade
);
comment on table private.fleet_fee_basis is
  'Taux des frais Rydar figés à la fin d''une course terminée en mode flotte (un changement de réglage ne touche que les courses terminées après lui).';
create index fleet_fee_basis_org_idx on private.fleet_fee_basis (organization_id);

alter table private.fleet_fee_basis enable row level security;
revoke all on private.fleet_fee_basis from public, anon, authenticated, service_role;

-- Frais d'une course de flotte : % du prix (0 sans prix) + fixe, sans plafond au prix
create or replace function private.fleet_platform_fee(p_price integer, p_percent numeric, p_fixed integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select least(10000000, round(greatest(coalesce(p_price, 0), 0) * coalesce(p_percent, 0) / 100)::integer + coalesce(p_fixed, 0));
$$;

-- Frais plateforme suivis pour une organisation : centrale, flotte avec des frais réglés, ou historique
-- (écritures / paiements : une ancienne centrale ou une flotte remise à 0 € reste suivie)
create or replace function private.platform_fees_enabled(p_org uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.organizations o
                 where o.id = p_org
                   and (o.dispatch_model = 'centrale' or o.platform_fee_percent > 0 or o.platform_fee_fixed_cents > 0))
      or exists (select 1 from public.platform_fee_entries e where e.organization_id = p_org)
      or exists (select 1 from public.platform_payments p where p.organization_id = p_org);
$$;

-- -----------------------------------------------------------------------------
-- Écritures automatiques : course terminée, prix corrigé
-- -----------------------------------------------------------------------------
-- Dernière définition : 20260924004400_audit_argent.sql
-- Ajout : course terminée en mode flotte → base figée (taux du moment) et frais = % du prix (0 sans prix) + fixe,
-- recalculés avec cette base si le prix change ; règlement chauffeur présent ou course terminée en centrale →
-- calcul inchangé (répartition, sinon frais du règlement). Le reste (baisse remplacée, hausse comptée, baisse en
-- attente, échéance jamais rétroactive) est identique.
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
begin
  if new.status <> 'COMPLETED' then
    return null;
  end if;

  -- Flotte : base figée à la fin de la course (seulement à cet instant : une course terminée avant, ou en centrale,
  -- n'en reçoit jamais). Rien à figer pour une flotte sans frais ni répartition héritée d'un passage en centrale.
  select * into b from private.fleet_fee_basis where ride_id = new.id;
  if not found and (tg_op = 'INSERT' or old.status is distinct from 'COMPLETED') then
    select * into o from public.organizations where id = new.organization_id;
    if o.dispatch_model = 'fleet'
       and (o.platform_fee_percent > 0 or o.platform_fee_fixed_cents > 0 or new.platform_fee_cents is not null) then
      insert into private.fleet_fee_basis (ride_id, organization_id, fee_percent, fee_fixed_cents)
      values (new.id, new.organization_id, o.platform_fee_percent, o.platform_fee_fixed_cents)
      on conflict (ride_id) do nothing;
      select * into b from private.fleet_fee_basis where ride_id = new.id;
    end if;
  end if;

  if b.ride_id is not null and not exists (select 1 from public.ride_settlements x where x.ride_id = new.id) then
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
    values (new.organization_id, new.id, 'ride', v_delta, 'posted', format('Course %s', new.number), v_at,
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

-- -----------------------------------------------------------------------------
-- Compte envers Rydar
-- -----------------------------------------------------------------------------
-- Dernière définition : 20260924004400_audit_argent.sql
-- Ajouts : frais d'une course de flotte (base figée, sans règlement chauffeur) = « encaissé par l'organisation »
-- (la flotte encaisse elle-même ses courses : jamais « chez les chauffeurs ») ; clé dispatch_model ;
-- month.zero_price_rides d'une flotte = courses sans prix dont la part en % est perdue (centrale : inchangé).
create or replace function private.platform_account(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  v_month timestamptz;
  v record;
  v_origin record;
  v_month_stats record;
begin
  select * into o from public.organizations where id = p_org;
  if not found then
    return null;
  end if;
  v_month := date_trunc('month', now() at time zone o.timezone) at time zone o.timezone;
  select * into v from private.platform_position(p_org);

  -- D'où vient l'argent (frais comptabilisés des courses) : encaissé par l'organisation (course de flotte, course
  -- payée à la centrale ou règlement chauffeur confirmé), encore chez les chauffeurs, annulé par la centrale
  select
      coalesce(sum(e.amount_cents) filter (where (b.ride_id is not null and x.id is null)
        or r.payment_method not in ('cash', 'card') or x.status = 'paid'), 0) as collected,
      coalesce(sum(e.amount_cents) filter (where not (b.ride_id is not null and x.id is null)
        and r.payment_method in ('cash', 'card')
        and (x.status is null or x.status in ('due', 'declared', 'disputed'))), 0) as with_drivers,
      coalesce(sum(e.amount_cents) filter (where r.payment_method in ('cash', 'card') and x.status = 'waived'), 0) as waived
    into v_origin
  from public.platform_fee_entries e
  join public.rides r on r.id = e.ride_id
  left join public.ride_settlements x on x.ride_id = e.ride_id
  left join private.fleet_fee_basis b on b.ride_id = e.ride_id
  where e.organization_id = p_org and e.status = 'posted' and e.kind in ('ride', 'correction');

  select
      coalesce(sum(e.amount_cents) filter (where e.status = 'posted'), 0) as fees,
      count(*) filter (where e.kind = 'ride') as rides,
      (select coalesce(sum(p.received_cents), 0) from public.platform_payments p
        where p.organization_id = p_org and p.status = 'confirmed' and p.reviewed_at >= v_month) as received,
      -- Courses « à surveiller » : centrale → à 0 €, sans prix ou frais plafonnés au prix (inchangé) ; course de
      -- flotte → sans prix (ou à 0 €) alors que ses taux figés ont une part en % : seule cette part est perdue (le fixe
      -- reste dû). Course d'une flotte sans base (aucun frais à sa fin) : rien n'était dû, rien à surveiller.
      (select count(*) from public.rides r
        left join private.fleet_fee_basis fb on fb.ride_id = r.id
          and not exists (select 1 from public.ride_settlements x where x.ride_id = r.id)
        where r.organization_id = p_org and r.status = 'COMPLETED'
        and r.completed_at >= v_month
        and case when fb.ride_id is not null then coalesce(r.price_cents, 0) = 0 and fb.fee_percent > 0
                 when o.dispatch_model = 'fleet' then false
                 else (coalesce(r.price_cents, 0) = 0 or r.platform_fee_cents >= r.price_cents) end) as zero_price,
      (select count(*) from public.rides r where r.organization_id = p_org and r.status = 'CANCELLED'
        and r.driver_id is not null and r.updated_at >= v_month) as cancelled_assigned,
      -- Sous-ensemble du précédent (chauffeur attribué, updated_at >= cancelled_at)
      (select count(*) from public.rides r where r.organization_id = p_org and r.status = 'CANCELLED'
        and r.driver_id is not null and (r.passenger_onboard_at is not null or r.started_at is not null)
        and coalesce(r.cancelled_at, r.updated_at) >= v_month) as cancelled_onboard
    into v_month_stats
  from public.platform_fee_entries e
  where e.organization_id = p_org and e.occurred_at >= v_month;

  return jsonb_build_object(
    'organization_id', o.id,
    'dispatch_model', o.dispatch_model,
    'currency', o.currency,
    'reference', private.platform_reference(o.id),
    'cycle', o.platform_billing_cycle,
    'payment_days', o.platform_payment_days,
    'block_after_days', o.platform_block_after_days,
    'fee_percent', o.platform_fee_percent,
    'fee_fixed_cents', o.platform_fee_fixed_cents,
    'balance_cents', v.posted_cents - v.received_cents,
    'due_cents', v.due_cents,
    'overdue_since', v.overdue_since,
    'days_overdue', case when v.overdue_since is null then 0
                         else greatest(0, extract(day from now() - v.overdue_since)::integer) end,
    'next_due_at', v.next_due_at,
    'next_due_cents', v.next_due_cents,
    'declared_cents', v.declared_cents,
    'declared_count', v.declared_count,
    'pending_reductions_cents', v.pending_cents,
    'pending_reductions_count', v.pending_count,
    'posted_cents', v.posted_cents,
    'received_cents', v.received_cents,
    'last_payment_at', v.last_payment_at,
    'collected_by_centrale_cents', v_origin.collected,
    'with_drivers_cents', v_origin.with_drivers,
    'waived_by_centrale_cents', v_origin.waived,
    'held_by_centrale_cents', greatest(0, v_origin.collected - v.received_cents),
    'blocked', v.blocked,
    -- Retard au-delà du seuil, mais blocage suspendu par un paiement déclaré récent
    'block_suspended', v.block_suspended,
    'reminded_at', o.platform_reminded_at,
    'reminder_note', o.platform_reminder_note,
    'month', jsonb_build_object(
      'start', v_month,
      'fees_cents', v_month_stats.fees,
      'rides', v_month_stats.rides,
      'received_cents', v_month_stats.received,
      'zero_price_rides', v_month_stats.zero_price,
      'cancelled_assigned_rides', v_month_stats.cancelled_assigned,
      'cancelled_onboard_rides', v_month_stats.cancelled_onboard)
  );
end;
$$;

-- Dernière définition : 20260924003100_platform_fees_review.sql
-- Ajout : ride.fleet_fee = taux figés d'une course de flotte (null : règle centrale, répartition / règlement).
create or replace function private.platform_entry_json(e public.platform_fee_entries)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', e.id,
    'organization_id', e.organization_id,
    'kind', e.kind,
    'amount_cents', e.amount_cents,
    'status', e.status,
    'label', e.label,
    'reason', e.reason,
    'occurred_at', e.occurred_at,
    'due_at', e.due_at,
    'created_at', e.created_at,
    'created_by_name', (select u.full_name from public.users u where u.id = e.created_by),
    'reviewed_at', e.reviewed_at,
    'review_note', e.review_note,
    -- Baisse remplacée par une correction plus récente (pas refusée par Rydar)
    'superseded', e.status = 'rejected' and e.reviewed_by is null and e.reviewed_at is not null,
    'ride', (select jsonb_build_object(
               'id', r.id,
               'number', r.number,
               'price_cents', r.price_cents,
               'payment_method', r.payment_method,
               'completed_at', r.completed_at,
               'pickup', coalesce(private.short_address(r.pickup_address), r.pickup_address),
               'dropoff', coalesce(private.short_address(r.dropoff_address), r.dropoff_address),
               'settlement_status', (select x.status from public.ride_settlements x where x.ride_id = r.id),
               'fleet_fee', (select jsonb_build_object('percent', b.fee_percent, 'fixed_cents', b.fee_fixed_cents)
                             from private.fleet_fee_basis b
                             where b.ride_id = r.id
                               and not exists (select 1 from public.ride_settlements x where x.ride_id = r.id)))
             from public.rides r where r.id = e.ride_id));
$$;

-- Dernière définition : 20260924003100_platform_fees_review.sql
-- Ajout : organization.dispatch_model (relevé d'une flotte : pas de colonne « règlement chauffeur »).
create or replace function private.platform_statement(p_org uuid, p_month text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  v_start timestamptz;
  v_end timestamptz;
  v_opening bigint;
  v_fees bigint;
  v_received bigint;
  v_entries jsonb;
  v_payments jsonb;
begin
  select * into o from public.organizations where id = p_org;
  if not found then
    return null;
  end if;
  if p_month is null or p_month !~ '^(19|2[0-9])[0-9]{2}-(0[1-9]|1[0-2])$' then
    p_month := to_char(now() at time zone o.timezone, 'YYYY-MM');
  end if;
  v_start := (p_month || '-01')::timestamp at time zone o.timezone;
  v_end := ((p_month || '-01')::timestamp + interval '1 month') at time zone o.timezone;

  select (select coalesce(sum(e.amount_cents), 0) from public.platform_fee_entries e
           where e.organization_id = p_org and e.status = 'posted' and e.occurred_at < v_start)
       - (select coalesce(sum(p.received_cents), 0) from public.platform_payments p
           where p.organization_id = p_org and p.status = 'confirmed' and p.reviewed_at < v_start)
    into v_opening;

  select coalesce(sum(e.amount_cents) filter (where e.status = 'posted'), 0),
         coalesce(jsonb_agg(private.platform_entry_json(e) order by e.occurred_at, e.created_at), '[]'::jsonb)
    into v_fees, v_entries
  from public.platform_fee_entries e
  where e.organization_id = p_org and e.occurred_at >= v_start and e.occurred_at < v_end;

  select coalesce(sum(p.received_cents) filter (where p.status = 'confirmed' and p.reviewed_at >= v_start and p.reviewed_at < v_end), 0),
         coalesce(jsonb_agg(private.platform_payment_json(p) order by p.declared_at), '[]'::jsonb)
    into v_received, v_payments
  from public.platform_payments p
  where p.organization_id = p_org
    and ((p.declared_at >= v_start and p.declared_at < v_end) or (p.reviewed_at >= v_start and p.reviewed_at < v_end));

  return jsonb_build_object(
    'organization', jsonb_build_object('id', o.id, 'name', o.name, 'currency', o.currency, 'timezone', o.timezone,
      'reference', private.platform_reference(o.id), 'dispatch_model', o.dispatch_model),
    'month', p_month,
    'from', v_start,
    'to', v_end,
    'opening_cents', v_opening,
    'fees_cents', v_fees,
    'received_cents', v_received,
    'closing_cents', v_opening + v_fees - v_received,
    'entries', v_entries,
    'payments', v_payments);
end;
$$;

-- -----------------------------------------------------------------------------
-- Tableau de bord (owner / admin) : centrale OU flotte avec des frais
-- -----------------------------------------------------------------------------
-- Dernière définition : 20260924003000_platform_fees.sql
-- Changements : activé aussi pour une flotte qui a des frais réglés (private.platform_fees_enabled) ;
-- organization.dispatch_model (écrans : « Frais Rydar » d'une flotte, sans répartition chauffeur).
create or replace function public.org_platform_account(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  v_account jsonb;
  v_payments jsonb;
  v_entries jsonb;
  v_months jsonb;
begin
  perform private.assert_platform_payer(p_org);
  select * into o from public.organizations where id = p_org;
  if not private.platform_fees_enabled(p_org) then
    return jsonb_build_object('enabled', false);
  end if;
  v_account := private.platform_account(p_org);

  select coalesce(jsonb_agg(private.platform_payment_json(p) order by p.declared_at desc), '[]'::jsonb) into v_payments
  from (select * from public.platform_payments where organization_id = p_org order by declared_at desc limit 30) p;

  select coalesce(jsonb_agg(private.platform_entry_json(e) order by e.occurred_at desc, e.created_at desc), '[]'::jsonb) into v_entries
  from (select * from public.platform_fee_entries where organization_id = p_org
        order by occurred_at desc, created_at desc limit 60) e;

  -- 6 derniers mois (fuseau de l'organisation) : frais comptabilisés et paiements reçus
  select coalesce(jsonb_agg(jsonb_build_object('month', m.month, 'fees_cents', m.fees, 'rides', m.rides, 'received_cents', m.received)
           order by m.month desc), '[]'::jsonb)
    into v_months
  from (
    select g.month,
           (select coalesce(sum(e.amount_cents), 0) from public.platform_fee_entries e
             where e.organization_id = p_org and e.status = 'posted'
               and e.occurred_at >= g.month_start and e.occurred_at < g.month_end) as fees,
           (select count(*) from public.platform_fee_entries e
             where e.organization_id = p_org and e.kind = 'ride'
               and e.occurred_at >= g.month_start and e.occurred_at < g.month_end) as rides,
           (select coalesce(sum(p.received_cents), 0) from public.platform_payments p
             where p.organization_id = p_org and p.status = 'confirmed'
               and p.reviewed_at >= g.month_start and p.reviewed_at < g.month_end) as received
    from (
      select to_char(d, 'YYYY-MM') as month, d at time zone o.timezone as month_start,
             (d + interval '1 month') at time zone o.timezone as month_end
      from generate_series(date_trunc('month', now() at time zone o.timezone) - interval '5 months',
                           date_trunc('month', now() at time zone o.timezone), interval '1 month') d
    ) g
  ) m;

  return jsonb_build_object(
    'enabled', true,
    'organization', jsonb_build_object('id', o.id, 'name', o.name, 'status', o.status, 'timezone', o.timezone,
      'dispatch_model', o.dispatch_model),
    'account', v_account,
    'pay', private.platform_pay_info(p_org, v_account),
    'payments', v_payments,
    'entries', v_entries,
    'months', v_months);
end;
$$;

-- Dernière définition : 20260924005400_contre_audit_sql.sql. Seul changement : activé aussi pour une flotte qui a
-- des frais réglés (private.platform_fees_enabled).
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
  if not private.platform_fees_enabled(p_org) then
    return jsonb_build_object('enabled', false);
  end if;
  return jsonb_build_object('enabled', true, 'account', private.platform_account(p_org));
end;
$$;

-- Menu « Frais Rydar » d'une flotte (layout du tableau de bord, à chaque rendu) : le seul booléen, sans calculer le
-- compte (private.platform_account = plusieurs agrégats). Mêmes conditions d'accès que org_platform_status : false
-- pour un dispatcher, un chauffeur, un non-membre ou un jeton émis avant l'activation de l'adhésion.
create or replace function public.org_platform_fees_enabled(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_org is not null
     and exists (
       select 1
       from public.organization_users ou
       join public.organizations o on o.id = ou.organization_id
       where ou.organization_id = p_org and ou.user_id = auth.uid() and ou.status = 'active'
         and private.jwt_issued_after(ou.activated_at)
         and ou.role in ('owner', 'admin') and o.status in ('active', 'suspended'))
     and private.platform_fees_enabled(p_org);
$$;

-- -----------------------------------------------------------------------------
-- Relance du super admin : messages selon le modèle (« la flotte » / « la centrale »)
-- -----------------------------------------------------------------------------
-- Dernière définition : 20260924003700_whatsapp_reminders.sql. Seul changement : les messages nomment la flotte ou la
-- centrale selon dispatch_model (codes, contrôles, limite d'une relance par heure et envoi WhatsApp inchangés).
create or replace function public.svc_platform_remind(p_org uuid, p_actor uuid, p_note text default null, p_whatsapp boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  v_note text := left(nullif(btrim(coalesce(p_note, '')), ''), 300);
  v_account jsonb;
  v_target jsonb;
  v_amount bigint;
  v_date timestamptz;
  v_who text;
begin
  perform private.assert_platform_actor(p_actor);
  select * into o from public.organizations where id = p_org for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Organisation introuvable.');
  end if;
  v_who := case when o.dispatch_model = 'fleet' then 'flotte' else 'centrale' end;
  if o.platform_reminded_at > now() - interval '1 hour' then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED', 'message', 'Relance déjà envoyée il y a moins d''une heure.');
  end if;
  v_account := private.platform_account(p_org);
  if (v_account ->> 'balance_cents')::bigint <= 0 then
    return jsonb_build_object('ok', false, 'code', 'NOTHING_DUE', 'message', format('Rien à régler pour cette %s.', v_who));
  end if;
  if coalesce(p_whatsapp, false) then
    if not private.whatsapp_ready('platform', null) then
      return jsonb_build_object('ok', false, 'code', 'WHATSAPP_NOT_CONFIGURED',
        'message', 'WhatsApp de Rydar non configuré : renseignez le numéro dans Frais plateforme › WhatsApp.');
    end if;
    v_target := private.platform_whatsapp_target(p_org);
    if v_target ->> 'to' is null then
      return jsonb_build_object('ok', false, 'code', 'NO_PHONE',
        'message', format('Aucun numéro valide pour le propriétaire ni pour la %s.', v_who));
    end if;
  end if;

  perform private.set_actor('super_admin', p_actor);
  update public.organizations set platform_reminded_at = now(), platform_reminder_note = v_note where id = p_org;

  if v_target is not null then
    v_amount := case when (v_account ->> 'due_cents')::bigint > 0 then (v_account ->> 'due_cents')::bigint
                     else (v_account ->> 'balance_cents')::bigint end;
    v_date := coalesce((v_account ->> 'overdue_since')::timestamptz, (v_account ->> 'next_due_at')::timestamptz);
    perform private.queue_whatsapp(p_org, null, (v_target ->> 'user_id')::uuid, 'platform', v_target ->> 'to',
      'platform_fee_reminder', 'RELANCE FRAIS PLATEFORME',
      format('%s à régler à Rydar Drive', private.fmt_eur(v_amount::integer)),
      array[o.name, private.fmt_eur(v_amount::integer),
            coalesce(to_char(v_date at time zone o.timezone, 'DD/MM/YYYY'), 'à réception')]);
  end if;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, 'super_admin', p_actor, 'platform_fee.reminded', 'organizations', p_org::text, 'info',
    jsonb_build_object('balance_cents', v_account -> 'balance_cents', 'due_cents', v_account -> 'due_cents', 'note', v_note,
      'whatsapp', v_target is not null, 'whatsapp_to', private.wa_mask(v_target ->> 'to')));
  perform private.broadcast_platform(p_org, 'reminded', jsonb_build_object('note', v_note));
  return jsonb_build_object('ok', true, 'code', 'REMINDED', 'whatsapp', v_target is not null,
    'message', case when v_target is not null
      then format('Relance affichée à la %s et envoyée par WhatsApp (%s).', v_who, private.wa_mask(v_target ->> 'to'))
      else format('Relance affichée à la %s.', v_who) end);
end;
$$;

-- -----------------------------------------------------------------------------
-- Super admin : vue d'ensemble (centrales ET flottes avec des frais)
-- -----------------------------------------------------------------------------
-- Dernière définition : 20260924003100_platform_fees_review.sql
-- Seul changement : liste aussi les flottes qui ont des frais réglés (private.platform_fees_enabled ; avant :
-- centrales et organisations avec historique seulement).
create or replace function public.admin_platform_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_orgs jsonb;
  v_payments jsonb;
  v_pending jsonb;
  b public.platform_billing;
begin
  if not private.is_super_admin() then
    raise exception 'FORBIDDEN: réservé au super admin' using errcode = '42501';
  end if;

  -- Centrales, flottes avec des frais, et toute organisation qui a eu des frais (archivée, tant qu'il reste un
  -- solde, un paiement à confirmer ou une baisse à valider)
  select coalesce(jsonb_agg(t.j order by (t.j ->> 'due_cents')::bigint desc, (t.j ->> 'balance_cents')::bigint desc, t.name), '[]'::jsonb)
    into v_orgs
  from (
    select o.name, a || jsonb_build_object(
        'id', o.id, 'name', o.name, 'slug', o.slug, 'status', o.status, 'dispatch_model', o.dispatch_model) as j
    from public.organizations o
    cross join lateral private.platform_account(o.id) a
    where private.platform_fees_enabled(o.id)
      and (o.status <> 'archived'
           or (a ->> 'balance_cents')::bigint <> 0
           or (a ->> 'declared_count')::integer > 0
           or (a ->> 'pending_reductions_count')::integer > 0)
  ) t;

  select coalesce(jsonb_agg(private.platform_payment_json(p) || jsonb_build_object('organization_name', o.name)
           order by p.declared_at), '[]'::jsonb)
    into v_payments
  from public.platform_payments p
  join public.organizations o on o.id = p.organization_id
  where p.status = 'declared';

  select coalesce(jsonb_agg(private.platform_entry_json(e) || jsonb_build_object('organization_name', o.name)
           order by e.created_at), '[]'::jsonb)
    into v_pending
  from public.platform_fee_entries e
  join public.organizations o on o.id = e.organization_id
  where e.status = 'pending';

  select * into b from public.platform_billing where id;

  return jsonb_build_object(
    'organizations', v_orgs,
    'payments_to_confirm', v_payments,
    'pending_reductions', v_pending,
    'billing', jsonb_build_object('payee_name', b.payee_name, 'iban', b.iban, 'bic', b.bic,
      'payment_link', b.payment_link, 'instructions', b.instructions, 'updated_at', b.updated_at),
    'totals', jsonb_build_object(
      'balance_cents', (select coalesce(sum(greatest(0, (e ->> 'balance_cents')::bigint)), 0) from jsonb_array_elements(v_orgs) e),
      'due_cents', (select coalesce(sum((e ->> 'due_cents')::bigint), 0) from jsonb_array_elements(v_orgs) e),
      'overdue_count', (select count(*) from jsonb_array_elements(v_orgs) e where e ->> 'overdue_since' is not null),
      'held_by_centrales_cents', (select coalesce(sum((e ->> 'held_by_centrale_cents')::bigint), 0) from jsonb_array_elements(v_orgs) e),
      'with_drivers_cents', (select coalesce(sum((e ->> 'with_drivers_cents')::bigint), 0) from jsonb_array_elements(v_orgs) e),
      'declared_cents', (select coalesce(sum((e ->> 'amount_cents')::bigint), 0) from jsonb_array_elements(v_payments) e),
      'declared_count', jsonb_array_length(v_payments),
      'pending_reductions_count', jsonb_array_length(v_pending),
      'fees_month_cents', (select coalesce(sum((e -> 'month' ->> 'fees_cents')::bigint), 0) from jsonb_array_elements(v_orgs) e),
      'received_month_cents', (select coalesce(sum((e -> 'month' ->> 'received_cents')::bigint), 0) from jsonb_array_elements(v_orgs) e),
      'blocked_count', (select count(*) from jsonb_array_elements(v_orgs) e where (e ->> 'blocked')::boolean))
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Flottes existantes : taux restés d'un ancien passage en centrale (« sans effet en mode flotte » jusqu'ici, champs
-- grisés) remis à 0 — jamais de facturation qui démarre en silence. Journalisé (avant / après).
-- -----------------------------------------------------------------------------
insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
select o.id, 'system', null, 'organization.platform_fee_changed', 'organizations', o.id::text, 'warning',
  jsonb_build_object(
    'before', jsonb_build_object('dispatch_model', o.dispatch_model, 'platform_fee_percent', o.platform_fee_percent,
      'platform_fee_fixed_cents', o.platform_fee_fixed_cents),
    'after', jsonb_build_object('dispatch_model', o.dispatch_model, 'platform_fee_percent', 0, 'platform_fee_fixed_cents', 0),
    'reason', 'Frais Rydar des flottes (20260924006400) : taux hérités du mode centrale remis à 0, à régler par le super admin')
from public.organizations o
where o.dispatch_model = 'fleet' and (o.platform_fee_percent <> 0 or o.platform_fee_fixed_cents <> 0);

update public.organizations
   set platform_fee_percent = 0, platform_fee_fixed_cents = 0
 where dispatch_model = 'fleet' and (platform_fee_percent <> 0 or platform_fee_fixed_cents <> 0);

-- -----------------------------------------------------------------------------
-- Temps réel : frais par course (action « rates ») ou modèle (« model ») changés par le super admin →
-- « platform.updated » (identifiants seulement) : le tableau de bord ouvert relit son layout (entrée « Frais Rydar »,
-- bandeau, menus du modèle) sans rechargement complet ; « rates » = aussi une alerte aux owner / admin. Créé APRÈS la
-- remise à 0 ci-dessus (rien à annoncer pendant la migration).
-- -----------------------------------------------------------------------------
create or replace function private.organizations_platform_rates_broadcast()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform private.broadcast_platform(new.id,
    case when old.dispatch_model is distinct from new.dispatch_model then 'model' else 'rates' end);
  return null;
end;
$$;

drop trigger if exists organizations_platform_rates_broadcast on public.organizations;
create trigger organizations_platform_rates_broadcast
  after update of dispatch_model, platform_fee_percent, platform_fee_fixed_cents on public.organizations
  for each row
  when (old.dispatch_model is distinct from new.dispatch_model
        or old.platform_fee_percent is distinct from new.platform_fee_percent
        or old.platform_fee_fixed_cents is distinct from new.platform_fee_fixed_cents)
  execute function private.organizations_platform_rates_broadcast();

-- -----------------------------------------------------------------------------
-- Droits d'exécution (deny-by-default, cf. 20260924000900) — fonctions redéfinies : droits conservés
-- -----------------------------------------------------------------------------
revoke execute on function
  private.fleet_platform_fee(integer, numeric, integer),
  private.platform_fees_enabled(uuid),
  private.organizations_platform_rates_broadcast()
from public, anon, authenticated;
grant execute on function
  private.fleet_platform_fee(integer, numeric, integer),
  private.platform_fees_enabled(uuid),
  private.organizations_platform_rates_broadcast()
to service_role;

-- Tableau de bord (owner / admin, contrôle dans la fonction)
revoke execute on function public.org_platform_fees_enabled(uuid) from public, anon;
grant execute on function public.org_platform_fees_enabled(uuid) to authenticated, service_role;
