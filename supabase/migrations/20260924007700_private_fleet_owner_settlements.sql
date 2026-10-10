-- =============================================================================
-- Rydar Drive — Flotte Privée : la fiche du gérant ne se doit jamais de commission (spécification :
-- docs/FLOTTE-PRIVEE.md § 4.4, à déployer avec 20260924007600, avant toute première bascule d'une Flotte Privée en
-- centrale).
--
-- En centrale, organizations_centrale_split et private.sync_ride_settlement feraient du gérant qui roule (fiche
-- drivers.owner_driver, même compte que le propriétaire, gardée après la bascule) le débiteur de sa propre centrale.
-- Désormais une course terminée par cette fiche n'ouvre aucun règlement chauffeur (ride_settlements) : rien à régler,
-- et ni private.driver_blocker ni private.centrale_blocker ne le bloquent (aucune ligne, fiche « confirmée »). Les frais
-- Rydar restent dus (registre séparé platform_fee_entries). Les autres chauffeurs suivent les règles de la centrale.
-- Seul créateur de règlements propres : cette fonction (l'autre insertion, private.sync_network_settlement, est réseau).
-- Organisations et fiches sans owner_driver : comportement identique.
-- =============================================================================

-- Dernière définition : 20260924006900_shared_network_money.sql. Seul ajout, juste après le contrôle « course
-- terminée, avec chauffeur et prix » : fiche du gérant (owner_driver) → aucun règlement. Corps 006900 gardé à
-- l'identique ; droits conservés (même signature).
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
  -- Flotte Privée (20260924007700) : le gérant qui roule ne se doit jamais de commission
  if exists (select 1 from public.drivers own where own.id = new.driver_id and own.owner_driver) then
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
