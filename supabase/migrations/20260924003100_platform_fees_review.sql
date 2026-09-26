-- =============================================================================
-- Rydar Drive — Frais plateforme : corrections de la revue (argent)
--
-- Complète 20260924003000_platform_fees (déjà publiée : on ne la modifie pas, une base où elle a
-- tourné doit recevoir ces corrections). Aucune table ni colonne ne change ; fonctions redéfinies :
--   • une nouvelle modification du prix remplace la baisse encore en attente (sinon une hausse pouvait
--     compter deux fois) ; baisses verrouillées pendant le calcul (décision du super admin concurrente) ;
--   • private.platform_position : paiements reçus ET écritures négatives (avoirs, baisses acceptées)
--     soldent d'abord les échéances les plus anciennes (échu, retard et blocage exacts) ; plus léger que
--     private.platform_account pour le contrôle à chaque création de course ;
--   • blocage : une déclaration « J'ai payé » ne le suspend que 7 jours, et plus du tout dans les 7 jours
--     qui suivent un « Pas reçu » (pas de contournement par déclarations en boucle) ;
--   • centrale archivée qui doit encore de l'argent : toujours listée pour le super admin ;
--   • déclaration déjà traitée par Rydar puis rouverte : plus annulable par la centrale ;
--   • relevé : mois hors limites → mois courant ;
--   • rattrapage sans échéance rétroactive (fin du cycle en cours + délai) et réparation des
--     écritures rattrapées par la première version (« en retard depuis 120 jours » dès la mise en ligne).
-- Nouvelles clés JSON : account.block_suspended, entry.superseded.
-- =============================================================================

-- Position d'une centrale envers Rydar : cœur des calculs, partagé par le compte (écrans) et le
-- contrôle de blocage (chaque création de course) — léger : deux agrégats et une fenêtre.
--   • crédits = paiements REÇUS + écritures négatives comptabilisées (avoirs, baisses acceptées) :
--     ils soldent d'abord les frais dont l'échéance est la plus ancienne (FIFO) ; un avoir accordé
--     sur une dette en retard la solde tout de suite (sinon « échu » > solde, blocage maintenu) ;
--   • un paiement déclaré (« J'ai payé ») ne suspend le blocage que 7 jours, et plus du tout dans
--     les 7 jours qui suivent un « Pas reçu » (sinon : déclaration fictive, refus, nouvelle
--     déclaration… et le levier ne bloque jamais).
create or replace function private.platform_position(
  p_org uuid,
  out posted_cents bigint,
  out pending_cents bigint,
  out pending_count integer,
  out received_cents bigint,
  out last_payment_at timestamptz,
  out declared_cents bigint,
  out declared_count integer,
  out due_cents bigint,
  out overdue_since timestamptz,
  out next_due_at timestamptz,
  out next_due_cents bigint,
  out blocked boolean,
  out block_suspended boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_block_after integer;
  v_credits bigint;
  v_due_debits bigint;
  v_suspending bigint;
  v_last_rejected timestamptz;
  v_oldest timestamptz;
begin
  select o.platform_block_after_days into v_block_after from public.organizations o where o.id = p_org;

  select coalesce(sum(e.amount_cents) filter (where e.status = 'posted'), 0),
         coalesce(sum(e.amount_cents) filter (where e.status = 'pending'), 0),
         count(*) filter (where e.status = 'pending'),
         coalesce(-sum(e.amount_cents) filter (where e.status = 'posted' and e.amount_cents < 0), 0),
         coalesce(sum(e.amount_cents) filter (where e.status = 'posted' and e.amount_cents > 0 and e.due_at <= now()), 0)
    into posted_cents, pending_cents, pending_count, v_credits, v_due_debits
  from public.platform_fee_entries e
  where e.organization_id = p_org;

  select coalesce(sum(p.received_cents) filter (where p.status = 'confirmed'), 0),
         max(p.reviewed_at) filter (where p.status = 'confirmed'),
         coalesce(sum(p.amount_cents) filter (where p.status = 'declared'), 0),
         count(*) filter (where p.status = 'declared'),
         coalesce(sum(p.amount_cents) filter (where p.status = 'declared' and p.declared_at > now() - interval '7 days'), 0),
         max(p.reviewed_at) filter (where p.status = 'rejected')
    into received_cents, last_payment_at, declared_cents, declared_count, v_suspending, v_last_rejected
  from public.platform_payments p
  where p.organization_id = p_org;

  v_credits := v_credits + received_cents;
  due_cents := greatest(0, v_due_debits - v_credits);

  -- Échéances (frais positifs) dans l'ordre : le cumul est croissant, la première dont le cumul
  -- dépasse les crédits est la plus ancienne non couverte
  select min(t.due_at) filter (where t.cum > v_credits),
         min(t.due_at) filter (where t.cum > v_credits and t.due_at > now()),
         min(t.cum) filter (where t.cum > v_credits and t.due_at > now()) - v_credits
    into v_oldest, next_due_at, next_due_cents
  from (
    select e.due_at, sum(sum(e.amount_cents)) over (order by e.due_at) as cum
    from public.platform_fee_entries e
    where e.organization_id = p_org and e.status = 'posted' and e.amount_cents > 0
    group by e.due_at
  ) t;
  next_due_cents := coalesce(next_due_cents, 0);
  if v_oldest is not null and v_oldest <= now() and due_cents > 0 then
    overdue_since := v_oldest;
  end if;

  if v_last_rejected > now() - interval '7 days' then
    v_suspending := 0;
  end if;
  blocked := false;
  block_suspended := false;
  if v_block_after is not null and overdue_since is not null
     and overdue_since <= now() - make_interval(days => v_block_after) then
    if due_cents - v_suspending > 0 then
      blocked := true;
    else
      block_suspended := true;
    end if;
  end if;
end;
$$;

-- Compte d'une centrale envers Rydar : solde, échu, retard, déclaré, et d'où vient l'argent.
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

  -- D'où vient l'argent (frais comptabilisés des courses) : encaissé par la centrale (course payée à la
  -- centrale ou règlement chauffeur confirmé), encore chez les chauffeurs, annulé par la centrale
  select
      coalesce(sum(e.amount_cents) filter (where r.payment_method not in ('cash', 'card') or x.status = 'paid'), 0) as collected,
      coalesce(sum(e.amount_cents) filter (where r.payment_method in ('cash', 'card')
        and (x.status is null or x.status in ('due', 'declared', 'disputed'))), 0) as with_drivers,
      coalesce(sum(e.amount_cents) filter (where r.payment_method in ('cash', 'card') and x.status = 'waived'), 0) as waived
    into v_origin
  from public.platform_fee_entries e
  join public.rides r on r.id = e.ride_id
  left join public.ride_settlements x on x.ride_id = e.ride_id
  where e.organization_id = p_org and e.status = 'posted' and e.kind in ('ride', 'correction');

  select
      coalesce(sum(e.amount_cents) filter (where e.status = 'posted'), 0) as fees,
      count(*) filter (where e.kind = 'ride') as rides,
      (select coalesce(sum(p.received_cents), 0) from public.platform_payments p
        where p.organization_id = p_org and p.status = 'confirmed' and p.reviewed_at >= v_month) as received,
      (select count(*) from public.rides r where r.organization_id = p_org and r.status = 'COMPLETED'
        and r.completed_at >= v_month and coalesce(r.price_cents, 0) = 0) as zero_price,
      (select count(*) from public.rides r where r.organization_id = p_org and r.status = 'CANCELLED'
        and r.driver_id is not null and r.updated_at >= v_month) as cancelled_assigned
    into v_month_stats
  from public.platform_fee_entries e
  where e.organization_id = p_org and e.occurred_at >= v_month;

  return jsonb_build_object(
    'organization_id', o.id,
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
      'cancelled_assigned_rides', v_month_stats.cancelled_assigned)
  );
end;
$$;

create or replace function private.platform_blocked(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.blocked from private.platform_position(p_org) p), false);
$$;

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
               'settlement_status', (select x.status from public.ride_settlements x where x.ride_id = r.id))
             from public.rides r where r.id = e.ride_id));
$$;

-- -----------------------------------------------------------------------------
-- Écritures automatiques : course terminée, prix corrigé
-- -----------------------------------------------------------------------------
create or replace function private.sync_platform_fee()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target integer := coalesce(new.platform_fee_cents, 0);
  v_posted integer;
  v_pending integer;
  v_count integer;
  v_delta integer;
  v_at timestamptz;
  e public.platform_fee_entries;
  s public.platform_fee_entries;
begin
  if new.status <> 'COMPLETED' then
    return null;
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
    insert into public.platform_fee_entries (organization_id, ride_id, kind, amount_cents, status, label, occurred_at, due_at)
    values (new.organization_id, new.id, 'ride', v_delta, 'posted', format('Course %s', new.number), v_at,
      private.platform_due_at(new.organization_id, v_at))
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

-- Relevé d'un mois : solde d'ouverture, écritures, paiements reçus, solde de clôture
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
      'reference', private.platform_reference(o.id)),
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

-- Erreur de saisie : la centrale retire sa déclaration tant qu'elle n'est pas traitée
create or replace function public.cancel_platform_payment(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.platform_payments;
begin
  select * into p from public.platform_payments where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Paiement introuvable.');
  end if;
  perform private.assert_platform_payer(p.organization_id);
  perform private.set_actor('user', auth.uid());
  -- review_note renseigné : déjà traité puis rouvert par Rydar (motif obligatoire) → décision de Rydar
  if p.status <> 'declared' or p.source <> 'centrale' or p.review_note is not null then
    return jsonb_build_object('ok', false, 'code', 'NOT_CANCELLABLE', 'message', 'Ce paiement a déjà été traité par Rydar.');
  end if;
  update public.platform_payments set status = 'cancelled' where id = p.id returning * into p;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p.organization_id, 'user', auth.uid(), 'platform_payment.cancelled', 'platform_payments', p.id::text, 'info',
    jsonb_build_object('amount_cents', p.amount_cents));
  perform private.broadcast_platform(p.organization_id, 'cancelled', jsonb_build_object('payment', private.platform_payment_json(p)));
  return jsonb_build_object('ok', true, 'code', 'CANCELLED', 'message', 'Déclaration retirée.');
end;
$$;

-- -----------------------------------------------------------------------------
-- Super admin : lecture (RPC authentifiée, contrôle is_super_admin)
-- -----------------------------------------------------------------------------
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

  -- Centrales, et toute organisation qui a eu des frais (une centrale repassée en flotte reste suivie ;
  -- archivée, tant qu'il reste un solde, un paiement à confirmer ou une baisse à valider)
  select coalesce(jsonb_agg(t.j order by (t.j ->> 'due_cents')::bigint desc, (t.j ->> 'balance_cents')::bigint desc, t.name), '[]'::jsonb)
    into v_orgs
  from (
    select o.name, a || jsonb_build_object(
        'id', o.id, 'name', o.name, 'slug', o.slug, 'status', o.status, 'dispatch_model', o.dispatch_model) as j
    from public.organizations o
    cross join lateral private.platform_account(o.id) a
    where (o.dispatch_model = 'centrale'
           or exists (select 1 from public.platform_fee_entries e where e.organization_id = o.id)
           or exists (select 1 from public.platform_payments p where p.organization_id = o.id))
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
-- Vue d'ensemble des centrales : période bornée au mois choisi + dette envers Rydar
-- Dernière définition : 20260924002600. Ajouts : fin de période (mois choisi seulement),
-- platform_balance_cents / platform_due_cents / platform_declared_cents / platform_overdue_since.
-- -----------------------------------------------------------------------------
create or replace function public.admin_centrale_overview(p_from timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from timestamptz := coalesce(p_from, date_trunc('month', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris');
  v_to timestamptz;
  v_orgs jsonb;
begin
  if not private.is_super_admin() then
    raise exception 'FORBIDDEN: réservé au super admin' using errcode = '42501';
  end if;
  v_to := ((v_from at time zone 'Europe/Paris') + interval '1 month') at time zone 'Europe/Paris';

  select coalesce(jsonb_agg(t.j order by t.name), '[]'::jsonb) into v_orgs
  from (
    select o.name, jsonb_build_object(
        'id', o.id,
        'name', o.name,
        'slug', o.slug,
        'status', o.status,
        'platform_fee_percent', o.platform_fee_percent,
        'platform_fee_fixed_cents', o.platform_fee_fixed_cents,
        'join_enabled', o.join_enabled,
        'join_auto_approve', o.join_auto_approve,
        'drivers_active', (select count(*) from public.drivers d where d.organization_id = o.id and d.status = 'active'),
        'applications_pending', (select count(*) from public.drivers d
                                 where d.organization_id = o.id and d.application_status = 'pending'),
        'drivers_banned', (select count(*) from public.drivers d where d.organization_id = o.id and d.banned_at is not null),
        'rides', coalesce(m.rides, 0),
        'volume_cents', coalesce(m.volume, 0),
        'commission_cents', coalesce(m.commission, 0),
        'platform_fee_cents', coalesce(m.fees, 0),
        'outstanding_cents', (select coalesce(sum(x.amount_cents), 0) from public.ride_settlements x
                              where x.organization_id = o.id and x.direction = 'driver_owes'
                                and x.status in ('due', 'declared', 'disputed')),
        'overdue_cents', (select coalesce(sum(x.amount_cents), 0) from public.ride_settlements x
                          where x.organization_id = o.id and x.direction = 'driver_owes'
                            and (x.status = 'disputed' or (x.status = 'due' and x.due_at <= now()))),
        'platform_balance_cents', a.posted_cents - a.received_cents,
        'platform_due_cents', a.due_cents,
        'platform_declared_cents', a.declared_cents,
        'platform_overdue_since', a.overdue_since) as j
    from public.organizations o
    cross join lateral private.platform_position(o.id) a
    left join lateral (
      select count(*) as rides, sum(y.price_cents) as volume, sum(y.commission_cents) as commission,
             sum(y.platform_fee_cents) as fees
      from public.rides y
      where y.organization_id = o.id and y.status = 'COMPLETED' and y.completed_at >= v_from and y.completed_at < v_to
        and y.driver_payout_cents is not null
    ) m on true
    where o.dispatch_model = 'centrale' and o.status <> 'archived'
  ) t;

  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'organizations', v_orgs,
    'totals', jsonb_build_object(
      'centrales', jsonb_array_length(v_orgs),
      'rides', (select coalesce(sum((e ->> 'rides')::bigint), 0) from jsonb_array_elements(v_orgs) e),
      'volume_cents', (select coalesce(sum((e ->> 'volume_cents')::bigint), 0) from jsonb_array_elements(v_orgs) e),
      'platform_fee_cents', (select coalesce(sum((e ->> 'platform_fee_cents')::bigint), 0) from jsonb_array_elements(v_orgs) e),
      'platform_due_cents', (select coalesce(sum((e ->> 'platform_due_cents')::bigint), 0) from jsonb_array_elements(v_orgs) e),
      'platform_balance_cents', (select coalesce(sum(greatest(0, (e ->> 'platform_balance_cents')::bigint)), 0)
                                 from jsonb_array_elements(v_orgs) e)),
    'reports_open', (select count(*) from public.fraud_reports f where f.status = 'open'),
    'platform_bans', (select count(*) from public.banned_identities b where b.scope = 'platform' and b.lifted_at is null)
  );
end;
$$;

-- Rattrapage : courses déjà terminées (y compris avant le passage en mode centrale). Montant dû, mais
-- aucune échéance rétroactive : rien n'était facturé avant cette migration, les frais passés sont à
-- régler à la fin du cycle en cours (sinon, dès la mise en production : « en retard depuis 120 jours »,
-- bandeau rouge et blocage immédiat si le super admin active le levier). Idempotent.
create or replace function private.platform_backfill()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.platform_fee_entries (organization_id, ride_id, kind, amount_cents, status, label, occurred_at, due_at)
  select r.organization_id, r.id, 'ride', r.platform_fee_cents, 'posted', format('Course %s', r.number),
         coalesce(r.completed_at, r.updated_at),
         private.platform_due_at(r.organization_id, greatest(coalesce(r.completed_at, r.updated_at), now()))
  from public.rides r
  where r.status = 'COMPLETED' and coalesce(r.platform_fee_cents, 0) > 0
    and not exists (select 1 from public.platform_fee_entries x where x.ride_id = r.id)
  on conflict (ride_id) where kind = 'ride' do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Temps réel : le canal org:{id} est lisible par tous les membres (dispatchers compris) alors que les frais
-- plateforme sont réservés au propriétaire et aux administrateurs → l'événement ne porte plus que l'action
-- et des identifiants ; les écrans relisent le détail par les fonctions qui contrôlent le rôle.
-- Dernière définition : 20260924003000.
create or replace function private.broadcast_platform(p_org uuid, p_action text, p_data jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_strip_nulls(jsonb_build_object(
      'action', p_action,
      'organization_id', p_org,
      'payment_id', p_data -> 'payment' ->> 'id',
      'entry_id', p_data -> 'entry' ->> 'id')),
    'platform.updated', 'org:' || p_org::text, true);
end;
$$;

-- Réparation : écritures enregistrées après leur échéance (rattrapage de la première version de
-- 20260924003000) → échéance recalculée depuis leur date d'enregistrement. Montants inchangés ;
-- garde d'immuabilité suspendue le temps de cette seule mise à jour (même transaction).
alter table public.platform_fee_entries disable trigger platform_fee_entries_guard;
update public.platform_fee_entries e
   set due_at = private.platform_due_at(e.organization_id, e.created_at)
 where e.kind = 'ride' and e.created_by is null and e.due_at < e.created_at;
alter table public.platform_fee_entries enable trigger platform_fee_entries_guard;

-- Courses terminées sans écriture (idempotent)
select private.platform_backfill();

-- -----------------------------------------------------------------------------
-- Droits d'exécution (deny-by-default, cf. 20260924000900)
-- -----------------------------------------------------------------------------
revoke execute on function private.platform_position(uuid) from public, anon, authenticated;
grant execute on function private.platform_position(uuid) to service_role;
revoke execute on function private.platform_backfill() from public, anon, authenticated, service_role;
