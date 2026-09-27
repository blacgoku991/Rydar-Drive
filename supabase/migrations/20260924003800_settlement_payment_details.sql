-- =============================================================================
-- Rydar Drive — Moyens de paiement de la centrale : lien, virement (RIB), espèces, autre.
-- « NovaLink met son lien de paiement, son RIB ou autre ; Rydar met ses moyens ; le chauffeur paie NovaLink,
--   NovaLink paie Rydar. » (les moyens de Rydar : platform_billing, 20260924003000.)
--
--  * organization_settings : bénéficiaire, IBAN, BIC de la centrale (mêmes règles que platform_billing).
--  * Nouveau moyen « other » (autre moyen : Wero, Lydia au 06…, au bureau…) décrit par les instructions.
--  * Moyens proposés au chauffeur = moyens cochés ET renseignés (private.settlement_methods_available) :
--    lien → lien saisi ; virement → IBAN (ou instructions, réglages antérieurs) ; autre → instructions.
--    Avant : un moyen coché sans lien laissait le chauffeur avec le seul bouton « J'ai payé en espèces ».
--  * driver_settlements renvoie les coordonnées bancaires (pay.bank) ; driver_declare_payment accepte « other ».
-- =============================================================================

alter table public.organization_settings
  add column if not exists settlement_payee_name text
    check (settlement_payee_name is null or char_length(settlement_payee_name) between 2 and 120),
  add column if not exists settlement_iban text
    check (settlement_iban is null or settlement_iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$'),
  add column if not exists settlement_bic text
    check (settlement_bic is null or settlement_bic ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$');
grant update (settlement_payee_name, settlement_iban, settlement_bic) on public.organization_settings to authenticated;

alter table public.organization_settings drop constraint if exists organization_settings_settlement_methods_check;
alter table public.organization_settings add constraint organization_settings_settlement_methods_check
  check (cardinality(settlement_methods) between 1 and 4
         and settlement_methods <@ array['link', 'cash', 'transfer', 'other']::text[]);

alter table public.ride_settlements drop constraint if exists ride_settlements_declared_method_check;
alter table public.ride_settlements add constraint ride_settlements_declared_method_check
  check (declared_method is null or declared_method in ('link', 'cash', 'transfer', 'other'));

-- Moyens réellement utilisables par le chauffeur (cochés et renseignés), dans l'ordre des réglages.
-- Aucun (ex. seul « lien » coché, sans lien) : espèces, pour que le chauffeur puisse toujours signaler son paiement.
create or replace function private.settlement_methods_available(s public.organization_settings)
returns text[]
language sql
stable
set search_path = ''
as $$
  select case when cardinality(x.m) > 0 then x.m else '{cash}'::text[] end
  from (
    select array(
      select m from unnest(coalesce(s.settlement_methods, '{cash}'::text[])) with ordinality as t(m, i)
      where case m
        when 'link' then s.settlement_link is not null
        when 'transfer' then s.settlement_iban is not null or s.settlement_instructions is not null
        when 'other' then s.settlement_instructions is not null
        else true end
      order by i
    ) as m
  ) x;
$$;

-- Dernière définition : 20260924002600 (moyens disponibles + coordonnées bancaires).
create or replace function public.driver_settlements(p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  o public.organizations;
  s public.organization_settings;
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200));
  v_month timestamptz;
  v_items jsonb;
  v_summary jsonb;
  v_block text;
  v_payable integer;
  v_ids uuid[];
  v_ref text;
  v_methods text[];
begin
  select * into d from public.drivers where id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  select * into o from public.organizations where id = d.organization_id;
  select * into s from public.organization_settings where organization_id = d.organization_id;
  v_month := date_trunc('month', now() at time zone o.timezone) at time zone o.timezone;

  select coalesce(jsonb_agg(private.settlement_json(q.st) || jsonb_build_object(
      'ride', jsonb_build_object(
        'number', r.number,
        'pickup', coalesce(private.short_address(r.pickup_address), r.pickup_address),
        'dropoff', coalesce(private.short_address(r.dropoff_address), r.dropoff_address),
        'completed_at', r.completed_at))
      order by ((q.st).status in ('due', 'disputed', 'declared')) desc, (q.st).created_at desc), '[]'::jsonb)
    into v_items
  from (
    select y as st
    from public.ride_settlements y
    where y.driver_id = d.id
    order by (y.status in ('due', 'disputed', 'declared')) desc, y.created_at desc
    limit v_limit
  ) q
  join public.rides r on r.id = (q.st).ride_id;

  select jsonb_build_object(
      'owed_cents', coalesce(sum(x.amount_cents) filter (where x.direction = 'driver_owes' and x.status in ('due', 'disputed')), 0),
      'overdue_cents', coalesce(sum(x.amount_cents) filter (where x.direction = 'driver_owes'
        and (x.status = 'disputed' or (x.status = 'due' and x.due_at <= now()))), 0),
      'declared_cents', coalesce(sum(x.amount_cents) filter (where x.direction = 'driver_owes' and x.status = 'declared'), 0),
      'to_receive_cents', coalesce(sum(x.amount_cents) filter (where x.direction = 'centrale_owes' and x.status = 'due'), 0),
      'paid_month_cents', coalesce(sum(x.amount_cents) filter (where x.direction = 'driver_owes' and x.status = 'paid'
        and x.settled_at >= v_month), 0),
      'received_month_cents', coalesce(sum(x.amount_cents) filter (where x.direction = 'centrale_owes' and x.status = 'paid'
        and x.settled_at >= v_month), 0),
      'next_due_at', min(x.due_at) filter (where x.direction = 'driver_owes' and x.status = 'due' and x.due_at > now()))
    into v_summary
  from public.ride_settlements x
  where x.driver_id = d.id;

  select coalesce(sum(x.amount_cents), 0), coalesce(array_agg(x.id order by x.created_at), '{}')
    into v_payable, v_ids
  from public.ride_settlements x
  where x.driver_id = d.id and x.direction = 'driver_owes' and x.status in ('due', 'disputed');

  v_ref := case
    when cardinality(v_ids) = 1 then (select y.reference from public.ride_settlements y where y.id = v_ids[1])
    when cardinality(v_ids) > 1 then format('CH%s-%s', d.number, to_char(now() at time zone o.timezone, 'DDMM'))
  end;
  v_methods := private.settlement_methods_available(s);
  v_block := private.driver_blocker(d.id, null);

  return jsonb_build_object(
    'model', o.dispatch_model,
    'currency', o.currency,
    'organization', jsonb_build_object('name', o.name, 'phone', o.phone),
    'grace_hours', s.settlement_grace_hours,
    'summary', v_summary,
    'pay', jsonb_build_object(
      'amount_cents', v_payable,
      'count', cardinality(v_ids),
      'settlement_ids', to_jsonb(v_ids),
      'reference', v_ref,
      'link', private.settlement_payment_link(s.settlement_link, v_payable, v_ref),
      'methods', to_jsonb(v_methods),
      'instructions', s.settlement_instructions,
      -- Virement : coordonnées bancaires de la centrale (null sans IBAN)
      'bank', case when s.settlement_iban is not null then jsonb_build_object(
        'payee_name', coalesce(s.settlement_payee_name, o.legal_name, o.name),
        'iban', s.settlement_iban,
        'bic', s.settlement_bic) end),
    'blocked', v_block,
    'blocked_message', private.blocker_message(v_block),
    'items', v_items
  );
end;
$$;

-- Dernière définition : 20260924002600 (« other » accepté, moyens disponibles seulement).
create or replace function public.driver_declare_payment(p_ids uuid[], p_method text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
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
  perform private.set_actor('driver', d.id);
  select * into s from public.organization_settings where organization_id = d.organization_id;

  if p_method is null or not (p_method = any (private.settlement_methods_available(s))) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_METHOD', 'message', 'Moyen de paiement non accepté par la centrale.');
  end if;
  if coalesce(cardinality(p_ids), 0) = 0 or cardinality(p_ids) > 200 then
    return jsonb_build_object('ok', false, 'code', 'NOTHING_TO_DECLARE', 'message', 'Aucune commission à régler.');
  end if;

  with upd as (
    update public.ride_settlements y
       set status = 'declared', declared_at = now(), declared_method = p_method, declared_note = v_note
     where y.id = any (p_ids)
       and y.driver_id = d.id
       and y.direction = 'driver_owes'
       and y.status in ('due', 'disputed')
    returning y.id, y.amount_cents
  )
  select coalesce(array_agg(u.id), '{}'), coalesce(sum(u.amount_cents), 0) into v_ids, v_total from upd u;

  if cardinality(v_ids) = 0 then
    return jsonb_build_object('ok', false, 'code', 'NOTHING_TO_DECLARE', 'message', 'Aucune commission à régler.');
  end if;

  for x in select * from public.ride_settlements where id = any (v_ids) order by created_at loop
    perform private.log_event(x.organization_id, x.ride_id, 'settlement.declared',
      format('%s %s (#%s) signale avoir réglé %s (%s)', d.first_name, d.last_name, d.number,
        private.fmt_eur(x.amount_cents), private.settlement_method_label(p_method)),
      'timeline', 'info', jsonb_build_object('settlement_id', x.id, 'method', p_method, 'note', v_note), 'driver', d.id);
    perform private.broadcast_settlement(x, 'declared');
  end loop;

  return jsonb_build_object('ok', true, 'code', 'DECLARED', 'count', cardinality(v_ids), 'amount_cents', v_total,
    'message', 'Paiement signalé : la centrale va le confirmer.');
end;
$$;

revoke execute on function private.settlement_methods_available(public.organization_settings) from public, anon, authenticated;
grant execute on function private.settlement_methods_available(public.organization_settings) to service_role;
