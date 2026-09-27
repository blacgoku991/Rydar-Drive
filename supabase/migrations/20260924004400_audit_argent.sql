-- =============================================================================
-- Rydar Drive — Audit « argent » : règlements chauffeur (mode centrale) et frais plateforme
--
-- Aucune migration existante modifiée ; fonctions redéfinies depuis leur dernière version.
--
-- Règlements chauffeur (ride_settlements) :
--   • « J'ai payé » fictif : une déclaration ne suspend le blocage « commission en retard » qu'une
--     fois ; après un « Pas reçu » (disputed_at), une nouvelle déclaration ne débloque plus : seuls
--     « Reçu » ou « Annuler » de la centrale débloquent. Plafond d'encours : les montants signalés
--     payés comptent une fois la déclaration vieille de 72 h (ou tout de suite s'ils ont été
--     contestés) — un chauffeur honnête n'est pas bloqué le temps que la centrale confirme ;
--   • règlement à 0 € ignoré par le blocage ; annulation d'office (prix corrigé à 0 €) recalculable
--     quand le prix est de nouveau corrigé ; réouverture d'un règlement à 0 € refusée ;
--   • prix modifié pendant une déclaration concurrente : verrou du règlement (FOR UPDATE) ;
--   • sens du règlement changé (en ligne ↔ espèces) : nouvelle échéance, relances remises à zéro,
--     chauffeur prévenu ;
--   • plafond de prix « nouveau chauffeur » : une course sans prix n'est plus proposée à un
--     nouveau chauffeur (prix inconnu = au-dessus du plafond) ;
--   • part chauffeur annulée / rouverte : chauffeur prévenu ; confirmation groupée : montants
--     reçus et versés séparés ;
--   • retour centrale → flotte refusé tant qu'il reste des règlements ouverts.
-- Frais plateforme :
--   • blocage « frais en retard » : la suspension par une déclaration est ancrée sur la PREMIÈRE
--     déclaration des 30 derniers jours (retrait + redéclaration ou déclarations successives ne
--     relancent plus les 7 jours) ;
--   • passage flotte → centrale : répartition calculée pour les courses non clôturées ; course
--     terminée sans répartition : frais du règlement chauffeur ; rattrapage des courses déjà
--     terminées dans ce cas ;
--   • prix fixé après la fin de la course : échéance jamais rétroactive ;
--   • indicateurs super admin : prix symbolique (≤ frais) compté avec les courses à 0 €, courses
--     annulées après la prise en charge du client.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Contestation mémorisée : ride_settlements.disputed_at
-- -----------------------------------------------------------------------------
alter table public.ride_settlements add column if not exists disputed_at timestamptz;
comment on column public.ride_settlements.disputed_at is
  'Dernier « Pas reçu » de la centrale ; remis à zéro à la réouverture. Une redéclaration après contestation ne débloque pas le chauffeur.';

-- Reprise de l'historique : dernière contestation non suivie d'une réouverture (journal ride_events).
-- updated_at inchangé (déclencheur de mise à jour suspendu le temps de cette seule reprise).
alter table public.ride_settlements disable trigger ride_settlements_touch_updated_at;
update public.ride_settlements x
   set disputed_at = coalesce(
         (select max(e.created_at) from public.ride_events e
           where e.ride_id = x.ride_id and e.type = 'settlement.disputed' and e.data ->> 'settlement_id' = x.id::text
             and not exists (select 1 from public.ride_events r
                              where r.ride_id = x.ride_id and r.type = 'settlement.reopened'
                                and r.data ->> 'settlement_id' = x.id::text and r.created_at > e.created_at)),
         case when x.status = 'disputed' then x.updated_at end)
 where x.status in ('declared', 'disputed') and x.disputed_at is null;
alter table public.ride_settlements enable trigger ride_settlements_touch_updated_at;

-- « Pas reçu » → disputed_at ; réouverture (encaissé / annulé → à régler) → remis à zéro ;
-- ligne insérée déjà contestée (import, démonstration) → marquée aussi
create or replace function private.ride_settlements_dispute_mark()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'disputed' and new.disputed_at is null then
      new.disputed_at := now();
    end if;
  elsif new.status = 'disputed' and old.status is distinct from 'disputed' then
    new.disputed_at := now();
  elsif new.status = 'due' and old.status in ('paid', 'waived') then
    new.disputed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists ride_settlements_dispute_mark on public.ride_settlements;
create trigger ride_settlements_dispute_mark
  before insert or update of status on public.ride_settlements
  for each row execute function private.ride_settlements_dispute_mark();

-- -----------------------------------------------------------------------------
-- Blocages (mode centrale)
-- -----------------------------------------------------------------------------
-- Dernière définition : 20260924002600_centrale_mode.sql
-- 'unpaid'       : commission contestée, « à régler » échue, ou redéclarée après un « Pas reçu »
--                  (montant > 0 ; si block_unpaid) ;
-- 'credit_limit' : encours au-delà du plafond = à régler + contesté + signalé payé depuis plus de
--                  72 h (ou après une contestation) ;
-- 'new_driver'   : chauffeur non confirmé et course au-dessus du prix plafond, ou sans prix.
create or replace function private.centrale_blocker(
  p_driver uuid,
  p_trust text,
  p_price integer,
  p_block_unpaid boolean,
  p_credit_limit integer,
  p_new_max integer
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when coalesce(p_block_unpaid, true) and exists (
      select 1 from public.ride_settlements x
      where x.driver_id = p_driver and x.direction = 'driver_owes' and x.amount_cents > 0
        and (x.status = 'disputed'
             or (x.status = 'due' and x.due_at <= now())
             or (x.status = 'declared' and x.disputed_at is not null))
    ) then 'unpaid'
    when p_credit_limit is not null and (
      select coalesce(sum(x.amount_cents), 0) from public.ride_settlements x
      where x.driver_id = p_driver and x.direction = 'driver_owes'
        and (x.status in ('due', 'disputed')
             or (x.status = 'declared'
                 and (x.disputed_at is not null or coalesce(x.declared_at, x.created_at) <= now() - interval '72 hours')))
    ) > p_credit_limit then 'credit_limit'
    when p_trust = 'new' and p_new_max is not null and (p_price is null or p_price > p_new_max) then 'new_driver'
  end;
$$;

-- Dernière définition : 20260924002600_centrale_mode.sql
-- Appelée sans prix = hors course (accueil, Commissions, vue d'ensemble) : jamais 'new_driver'.
create or replace function private.driver_blocker(p_driver uuid, p_price integer default null)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when o.dispatch_model = 'centrale' then
           private.centrale_blocker(d.id, d.trust_level, coalesce(p_price, 0), s.block_unpaid,
             s.settlement_credit_limit_cents, s.new_driver_max_price_cents)
         end
  from public.drivers d
  join public.organizations o on o.id = d.organization_id
  left join public.organization_settings s on s.organization_id = d.organization_id
  where d.id = p_driver;
$$;

-- Dernière définition : 20260924002600_centrale_mode.sql
create or replace function private.blocker_message(p_reason text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_reason
    when 'unpaid' then 'Commission en retard ou contestée : réglez-la pour recevoir de nouvelles courses (après une contestation, la centrale doit confirmer votre paiement).'
    when 'credit_limit' then 'Plafond de commissions à régler atteint : réglez-les ou attendez leur confirmation par la centrale pour recevoir de nouvelles courses.'
    when 'new_driver' then 'Course réservée aux chauffeurs confirmés de la centrale.'
  end;
$$;

-- Dernière définition : 20260924002600_centrale_mode.sql (ajouts : disputed_at, « blocking » = règle du blocage)
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
  );
$$;

-- Dernière définition : 20260924002600_centrale_mode.sql (impayé en cours = même règle que le blocage)
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

-- -----------------------------------------------------------------------------
-- Répartition et règlement de fin de course
-- -----------------------------------------------------------------------------
-- Dernière définition : 20260924002600_centrale_mode.sql
-- Ajouts : règlement lu avec FOR UPDATE (une déclaration / confirmation concurrente est attendue,
-- puis SETTLEMENT_LOCKED) ; un règlement annulé d'office (prix corrigé à 0 €, ni date ni auteur)
-- reste recalculable.
create or replace function private.rides_centrale_split()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_model text;
  v_manual boolean;
  v_settlement text;
  v_auto_waived boolean;
  v_split record;
  v_bypass boolean := current_setting('rydar.bypass_ride_rules', true) = 'on' and auth.role() is null;
begin
  select o.dispatch_model into v_model from public.organizations o where o.id = new.organization_id;

  if v_model is distinct from 'centrale' then
    if tg_op = 'INSERT' then
      new.commission_cents := null;
      new.platform_fee_cents := null;
      new.driver_payout_cents := null;
      new.commission_manual := false;
    elsif new.commission_cents is distinct from old.commission_cents then
      new.commission_cents := old.commission_cents;   -- sans objet en mode flotte
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- Répartition figée dès que le règlement a été déclaré, encaissé, annulé ou contesté
    if new.price_cents is distinct from old.price_cents
       or new.commission_cents is distinct from old.commission_cents
       or new.payment_method is distinct from old.payment_method then
      select x.status, (x.status = 'waived' and x.settled_at is null and x.settled_by is null)
        into v_settlement, v_auto_waived
      from public.ride_settlements x
      where x.ride_id = new.id
      for update;
      if v_settlement is not null and v_settlement <> 'due' and not coalesce(v_auto_waived, false) then
        raise exception 'SETTLEMENT_LOCKED: règlement déjà déclaré, encaissé ou contesté — prix et commission verrouillés'
          using errcode = '55000';
      end if;
    end if;
    v_manual := case when new.commission_cents is distinct from old.commission_cents
                     then new.commission_cents is not null
                     else old.commission_manual end;
  else
    v_manual := new.commission_cents is not null;
  end if;

  if new.price_cents is null then
    -- Tableau de bord : prix obligatoire (le chauffeur doit voir sa part). API / mini-site :
    -- toléré, la répartition est calculée dès que la centrale fixe le prix.
    if new.source = 'dashboard' and not v_bypass and (tg_op = 'INSERT' or old.price_cents is not null) then
      raise exception 'PRICE_REQUIRED: prix obligatoire en mode centrale (le chauffeur doit voir sa part)'
        using errcode = '22023';
    end if;
    if not v_manual then
      new.commission_cents := null;
    end if;
    new.platform_fee_cents := null;
    new.driver_payout_cents := null;
    new.commission_manual := v_manual;
    return new;
  end if;

  select * into v_split
  from private.compute_ride_split(new.organization_id, new.price_cents, case when v_manual then new.commission_cents end);
  if v_split.error is not null then
    raise exception 'COMMISSION_TOO_HIGH: la commission et les frais dépassent le prix de la course' using errcode = '22023';
  end if;
  new.commission_cents := v_split.commission_cents;
  new.platform_fee_cents := v_split.platform_fee_cents;
  new.driver_payout_cents := v_split.driver_payout_cents;
  new.commission_manual := v_manual;
  return new;
end;
$$;

-- Dernière définition : 20260924002600_centrale_mode.sql
-- Ajouts (règlement existant recalculé) : annulé d'office à 0 € → de nouveau dû quand le montant
-- redevient positif ; sens changé (en ligne ↔ espèces) ou retour à « à régler » → nouvelle échéance
-- comme à la création, relances remises à zéro, chauffeur prévenu.
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

-- -----------------------------------------------------------------------------
-- Actions de la centrale sur les règlements
-- -----------------------------------------------------------------------------
-- Dernière définition : 20260924002600_centrale_mode.sql
-- Ajout : montants reçus (commissions) et versés (parts chauffeur) séparés ; amount_cents conservé.
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
begin
  if coalesce(cardinality(p_ids), 0) = 0 or cardinality(p_ids) > 500 then
    return jsonb_build_object('ok', false, 'code', 'NOTHING_TO_CONFIRM', 'message', 'Aucun règlement sélectionné.');
  end if;
  select count(distinct y.organization_id), (array_agg(distinct y.organization_id))[1]
    into v_orgs, v_org
  from public.ride_settlements y
  where y.id = any (p_ids);
  if v_orgs = 0 then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Règlement introuvable.');
  end if;
  if v_orgs > 1 then
    raise exception 'FORBIDDEN_TENANT: règlements de plusieurs organisations' using errcode = '42501';
  end if;
  perform private.assert_org_member(v_org, array['owner', 'admin', 'dispatcher']::public.org_role[]);
  perform private.set_actor('user', auth.uid());
  if p_method is not null and p_method not in ('link', 'cash', 'transfer', 'other') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_METHOD', 'message', 'Moyen de paiement invalide.');
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
      case when x.direction = 'driver_owes'
           then format('Commission de %s encaissée (%s)', private.fmt_eur(x.amount_cents), private.settlement_method_label(x.settled_method))
           else format('%s versés au chauffeur (%s)', private.fmt_eur(x.amount_cents), private.settlement_method_label(x.settled_method))
      end,
      'timeline', 'success', jsonb_build_object('settlement_id', x.id, 'method', x.settled_method), 'user', auth.uid());
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

  return jsonb_build_object('ok', true, 'code', 'CONFIRMED', 'count', cardinality(v_ids), 'amount_cents', v_total,
    'received_cents', v_received, 'paid_out_cents', v_paid_out,
    'message', format('%s %s', cardinality(v_ids), private.pl(cardinality(v_ids), 'règlement confirmé', 'règlements confirmés')));
end;
$$;

-- Dernière définition : 20260924002600_centrale_mode.sql
-- Ajout : part chauffeur (centrale_owes) annulée → chauffeur prévenu (« VERSEMENT ANNULÉ »).
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
begin
  select * into x from public.ride_settlements where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Règlement introuvable.');
  end if;
  perform private.assert_org_member(x.organization_id, array['owner', 'admin']::public.org_role[]);
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
    format('%s annulé%s par la centrale : %s', case when x.direction = 'driver_owes' then 'Commission' else 'Versement' end,
      case when x.direction = 'driver_owes' then 'e' else '' end, v_reason),
    'timeline', 'warning', jsonb_build_object('settlement_id', x.id, 'reason', v_reason), 'user', auth.uid());
  perform private.broadcast_settlement(x, 'waived');
  if x.driver_id is not null and x.direction = 'driver_owes' then
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

-- Dernière définition : 20260924002600_centrale_mode.sql
-- Ajouts : règlement à 0 € (prix corrigé à 0 €) → refus, corriger le prix le recalcule ;
-- part chauffeur rouverte → chauffeur prévenu (« GAIN À RECEVOIR »).
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
begin
  select * into x from public.ride_settlements where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Règlement introuvable.');
  end if;
  perform private.assert_org_member(x.organization_id, array['owner', 'admin']::public.org_role[]);
  perform private.set_actor('user', auth.uid());
  if x.status not in ('paid', 'waived') then
    return jsonb_build_object('ok', false, 'code', 'NOT_CLOSED', 'message', 'Ce règlement est déjà ouvert.');
  end if;
  if x.amount_cents <= 0 then
    return jsonb_build_object('ok', false, 'code', 'ZERO_AMOUNT',
      'message', 'Montant nul : corrigez le prix de la course, le règlement sera recalculé.');
  end if;

  update public.ride_settlements
     set status = 'due', settled_at = null, settled_by = null, settled_method = null
   where id = x.id
  returning * into x;
  select r.number into v_number from public.rides r where r.id = x.ride_id;

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

-- -----------------------------------------------------------------------------
-- Modèle d'exploitation : retour flotte refusé si règlements ouverts ; passage centrale → répartition
-- -----------------------------------------------------------------------------
-- Dernière définition : 20260924002600_centrale_mode.sql
-- Ajout : centrale → flotte refusé tant qu'un règlement est à régler, déclaré ou contesté (sinon
-- dettes et parts à verser deviennent invisibles : écrans et relances réservés au mode centrale).
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
    where x.organization_id = new.id and x.status in ('due', 'declared', 'disputed');
    if v_open > 0 then
      raise exception 'SETTLEMENTS_OPEN: % règlement(s) chauffeur encore ouvert(s) — soldez-les ou annulez-les avant le retour au mode flotte', v_open
        using errcode = '55000';
    end if;
  end if;
  if new.dispatch_model = 'fleet' then
    new.join_enabled := false;
  end if;
  return new;
end;
$$;

-- Passage en mode centrale : les courses non clôturées reçoivent leur répartition (sinon, à leur fin,
-- le chauffeur doit des frais plateforme que la centrale ne doit jamais à Rydar). La mise à jour
-- « à l'identique » du prix déclenche private.rides_centrale_split.
create or replace function private.organizations_centrale_split()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.rides r
     set price_cents = r.price_cents
   where r.organization_id = new.id
     and r.status not in ('COMPLETED', 'CANCELLED')
     and r.price_cents is not null
     and r.driver_payout_cents is null;
  return null;
end;
$$;

drop trigger if exists organizations_centrale_split on public.organizations;
create trigger organizations_centrale_split
  after update of dispatch_model on public.organizations
  for each row
  when (old.dispatch_model is distinct from 'centrale' and new.dispatch_model = 'centrale')
  execute function private.organizations_centrale_split();

-- -----------------------------------------------------------------------------
-- Frais plateforme
-- -----------------------------------------------------------------------------
-- Dernière définition : 20260924003100_platform_fees_review.sql
-- Blocage : une déclaration ne suspend le blocage que dans les 7 jours qui suivent la PREMIÈRE
-- déclaration non confirmée des 30 derniers jours (à confirmer, retirée ou refusée) : retirer puis
-- redéclarer, ou déclarer de nouveau, ne relance plus la fenêtre (au plus ~7 jours de suspension par
-- 30 jours sans décision de Rydar) ; jamais dans les 7 jours qui suivent un « Pas reçu ».
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
  v_first_declared timestamptz;
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
         max(p.reviewed_at) filter (where p.status = 'rejected'),
         min(p.declared_at) filter (where p.source = 'centrale' and p.status in ('declared', 'cancelled', 'rejected')
                                      and p.declared_at > now() - interval '30 days')
    into received_cents, last_payment_at, declared_cents, declared_count, v_suspending, v_last_rejected, v_first_declared
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

  if v_last_rejected > now() - interval '7 days' or v_first_declared <= now() - interval '7 days' then
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

-- Dernière définition : 20260924003100_platform_fees_review.sql
-- Ajouts (indicateurs du mois, super admin) : zero_price_rides compte aussi les courses dont le prix ne
-- dépasse pas les frais (frais plafonnés au prix : prix symbolique) ; cancelled_onboard_rides =
-- courses annulées après la prise en charge du client (aucun frais écrit).
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
        and r.completed_at >= v_month
        and (coalesce(r.price_cents, 0) = 0 or r.platform_fee_cents >= r.price_cents)) as zero_price,
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
-- Ajouts : course terminée sans répartition (créée avant le passage en mode centrale) → frais du
-- règlement chauffeur ; première écriture créée après coup (prix fixé tardivement) → échéance
-- jamais rétroactive (fin du cycle en cours + délai, comme private.platform_backfill).
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
  if new.platform_fee_cents is null then
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

-- Rattrapage : courses terminées en mode centrale sans répartition sur la course (créées en mode flotte) :
-- règlement chauffeur avec frais plateforme, mais aucune écriture. Montant = frais du règlement, aucune
-- échéance rétroactive. Idempotent.
create or replace function private.platform_backfill_settlements()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.platform_fee_entries (organization_id, ride_id, kind, amount_cents, status, label, occurred_at, due_at)
  select r.organization_id, r.id, 'ride', x.platform_fee_cents, 'posted', format('Course %s', r.number),
         coalesce(r.completed_at, r.updated_at),
         private.platform_due_at(r.organization_id, greatest(coalesce(r.completed_at, r.updated_at), now()))
  from public.rides r
  join public.ride_settlements x on x.ride_id = r.id
  where r.status = 'COMPLETED' and r.platform_fee_cents is null and x.platform_fee_cents > 0
    and not exists (select 1 from public.platform_fee_entries e where e.ride_id = r.id)
  on conflict (ride_id) where kind = 'ride' do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

select private.platform_backfill_settlements();

-- -----------------------------------------------------------------------------
-- Droits d'exécution (deny-by-default, cf. 20260924000900)
-- -----------------------------------------------------------------------------
revoke execute on function
  private.ride_settlements_dispute_mark(),
  private.centrale_blocker(uuid, text, integer, boolean, integer, integer),
  private.driver_blocker(uuid, integer),
  private.blocker_message(text),
  private.settlement_json(public.ride_settlements),
  private.maybe_promote_driver(uuid),
  private.rides_centrale_split(),
  private.sync_ride_settlement(),
  private.organizations_dispatch_model_guard(),
  private.organizations_centrale_split(),
  private.platform_position(uuid),
  private.platform_account(uuid),
  private.sync_platform_fee()
from public, anon, authenticated;
grant execute on function
  private.ride_settlements_dispute_mark(),
  private.centrale_blocker(uuid, text, integer, boolean, integer, integer),
  private.driver_blocker(uuid, integer),
  private.blocker_message(text),
  private.settlement_json(public.ride_settlements),
  private.maybe_promote_driver(uuid),
  private.rides_centrale_split(),
  private.sync_ride_settlement(),
  private.organizations_dispatch_model_guard(),
  private.organizations_centrale_split(),
  private.platform_position(uuid),
  private.platform_account(uuid),
  private.sync_platform_fee()
to service_role;
-- Rattrapage : interne, jamais exposé
revoke execute on function private.platform_backfill_settlements() from public, anon, authenticated, service_role;

revoke execute on function
  public.confirm_settlements(uuid[], text, text),
  public.waive_settlement(uuid, text),
  public.reopen_settlement(uuid)
from public, anon;
grant execute on function
  public.confirm_settlements(uuid[], text, text),
  public.waive_settlement(uuid, text),
  public.reopen_settlement(uuid)
to authenticated, service_role;
