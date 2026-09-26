-- =============================================================================
-- Rydar Drive — Frais plateforme : reversement des centrales à Rydar (super admin)
--
-- Chaque course terminée d'une centrale porte des frais plateforme (% + fixe réglés par le
-- super admin, rides.platform_fee_cents). Le chauffeur les verse à la centrale avec la
-- commission (ou le client les a payés à la centrale) : la centrale doit ensuite les
-- reverser à Rydar. Jusqu'ici, rien ne suivait cette dette.
--
-- Règles d'argent (« le super admin ne peut pas perdre 1 € ») :
--   • les frais sont DUS PAR LA CENTRALE dès la fin de la course, que le chauffeur l'ait
--     payée ou non (annuler / contester un règlement chauffeur ne touche pas aux frais) ;
--   • registre immuable (platform_fee_entries) : une écriture par course, puis une écriture
--     de correction par changement de montant ; jamais de modification ni de suppression ;
--   • une BAISSE de frais (prix corrigé à la baisse après la course) reste « en attente »
--     et ne compte qu'une fois acceptée par le super admin ; une hausse compte tout de suite ;
--   • solde = écritures comptabilisées − paiements CONFIRMÉS par le super admin (montant
--     reçu, éventuellement partiel) ; la centrale ne peut que déclarer « J'ai payé » ;
--   • échéance par écriture : fin du cycle (mois ou semaine, fuseau de la centrale) + délai ;
--     les paiements soldent les échéances les plus anciennes d'abord ;
--   • levier facultatif : création de courses refusée après N jours de retard
--     (PLATFORM_FEES_OVERDUE), suspendu tant qu'un paiement déclaré attend confirmation ;
--   • tout est journalisé (audit_logs) ; la centrale est prévenue en temps réel
--     (platform.updated sur org:{id}).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Colonnes (super admin uniquement : absentes du GRANT UPDATE des rattacheurs)
-- -----------------------------------------------------------------------------
alter table public.organizations
  add column platform_billing_cycle text not null default 'monthly'
    check (platform_billing_cycle in ('weekly', 'monthly')),
  add column platform_payment_days integer not null default 5
    check (platform_payment_days between 0 and 60),
  add column platform_block_after_days integer
    check (platform_block_after_days is null or platform_block_after_days between 1 and 90),
  add column platform_reminded_at timestamptz,
  add column platform_reminder_note text
    check (platform_reminder_note is null or char_length(platform_reminder_note) <= 300);

comment on column public.organizations.platform_block_after_days is
  'Frais plateforme en retard depuis plus de N jours (hors paiement déclaré en attente) : création de courses refusée. Null : jamais.';

-- -----------------------------------------------------------------------------
-- Coordonnées de paiement de Rydar (une ligne) — affichées aux centrales
-- -----------------------------------------------------------------------------
create table public.platform_billing (
  id boolean primary key default true check (id),
  payee_name text check (payee_name is null or char_length(payee_name) between 2 and 120),
  iban text check (iban is null or iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$'),
  bic text check (bic is null or bic ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
  payment_link text check (payment_link is null or (char_length(payment_link) <= 500 and payment_link ~ '^https://\S+$')),
  instructions text check (instructions is null or char_length(instructions) <= 500),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users (id) on delete set null
);
comment on table public.platform_billing is
  'Coordonnées de paiement des frais plateforme (IBAN, lien {montant} {montant_centimes} {reference}) — écriture : super admin.';
insert into public.platform_billing (id) values (true) on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Registre des frais (immuable) et paiements des centrales
-- -----------------------------------------------------------------------------
create table public.platform_fee_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  ride_id uuid,
  kind text not null check (kind in ('ride', 'correction', 'adjustment')),
  amount_cents integer not null check (amount_cents <> 0 and amount_cents between -10000000 and 10000000),
  status text not null default 'posted' check (status in ('posted', 'pending', 'rejected')),
  label text not null check (char_length(label) between 2 and 200),
  reason text check (reason is null or char_length(reason) <= 500),
  occurred_at timestamptz not null default now(),
  due_at timestamptz not null,
  created_by uuid references public.users (id) on delete set null,
  reviewed_by uuid references public.users (id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (review_note is null or char_length(review_note) <= 500),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  -- Seules les corrections (baisses) passent par une validation du super admin
  check (status = 'posted' or kind = 'correction'),
  check (status <> 'pending' or amount_cents < 0),
  check (kind <> 'adjustment' or ride_id is null),
  foreign key (organization_id, ride_id) references public.rides (organization_id, id) on delete set null (ride_id)
);
comment on table public.platform_fee_entries is
  'Frais plateforme dus par une centrale : une écriture par course terminée, corrections (delta) et avoirs du super admin. Immuable.';

create unique index platform_fee_entries_ride_uidx on public.platform_fee_entries (ride_id) where kind = 'ride';
create index platform_fee_entries_org_idx on public.platform_fee_entries (organization_id, occurred_at desc);
create index platform_fee_entries_org_due_idx on public.platform_fee_entries (organization_id, due_at) where status = 'posted';
create index platform_fee_entries_ride_idx on public.platform_fee_entries (ride_id) where ride_id is not null;
create index platform_fee_entries_pending_idx on public.platform_fee_entries (created_at) where status = 'pending';

create table public.platform_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  amount_cents integer not null check (amount_cents between 1 and 100000000),
  received_cents integer check (received_cents is null or received_cents between 1 and 100000000),
  method text not null check (method in ('transfer', 'link', 'cash', 'card', 'other')),
  reference text check (reference is null or char_length(reference) <= 80),
  note text check (note is null or char_length(note) <= 500),
  paid_on date,
  status text not null default 'declared' check (status in ('declared', 'confirmed', 'rejected', 'cancelled')),
  source text not null default 'centrale' check (source in ('centrale', 'admin')),
  declared_by uuid references public.users (id) on delete set null,
  declared_at timestamptz not null default now(),
  reviewed_by uuid references public.users (id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (review_note is null or char_length(review_note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check ((status = 'confirmed') = (received_cents is not null))
);
comment on table public.platform_payments is
  'Reversements des frais plateforme : déclarés par la centrale (« J''ai payé »), confirmés / refusés par le super admin, ou saisis par lui.';

create index platform_payments_org_idx on public.platform_payments (organization_id, declared_at desc);
create index platform_payments_declared_idx on public.platform_payments (declared_at) where status = 'declared';

create trigger platform_fee_entries_forbid_org_change
  before update on public.platform_fee_entries
  for each row execute function private.forbid_org_change();
create trigger platform_payments_forbid_org_change
  before update on public.platform_payments
  for each row execute function private.forbid_org_change();
create trigger platform_payments_touch_updated_at
  before update on public.platform_payments
  for each row execute function private.touch_updated_at();

-- Registre immuable : seules la décision sur une baisse (pending → posted / rejected) et la
-- perte du lien vers une course supprimée sont permises ; suppression seulement avec l'organisation.
create or replace function private.platform_entry_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.organizations o where o.id = old.organization_id) then
      raise exception 'PLATFORM_LEDGER_IMMUTABLE: une écriture de frais plateforme ne se supprime pas' using errcode = '55000';
    end if;
    return old;
  end if;
  if new.kind is distinct from old.kind
     or new.amount_cents is distinct from old.amount_cents
     or new.label is distinct from old.label
     or new.reason is distinct from old.reason
     or new.occurred_at is distinct from old.occurred_at
     or new.due_at is distinct from old.due_at
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or (new.ride_id is distinct from old.ride_id and new.ride_id is not null) then
    raise exception 'PLATFORM_LEDGER_IMMUTABLE: une écriture de frais plateforme ne se modifie pas (ajoutez une correction)'
      using errcode = '55000';
  end if;
  if new.status is distinct from old.status and not (old.status = 'pending' and new.status in ('posted', 'rejected')) then
    raise exception 'PLATFORM_LEDGER_IMMUTABLE: seule une baisse en attente peut être acceptée ou refusée' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger platform_fee_entries_guard
  before update or delete on public.platform_fee_entries
  for each row execute function private.platform_entry_guard();

-- -----------------------------------------------------------------------------
-- RLS : lecture super admin + owner / admin de la centrale ; écritures par fonctions
-- -----------------------------------------------------------------------------
alter table public.platform_billing enable row level security;
alter table public.platform_fee_entries enable row level security;
alter table public.platform_payments enable row level security;

create policy platform_billing_select on public.platform_billing for select to authenticated
  using ((select private.is_super_admin()));
create policy platform_fee_entries_select on public.platform_fee_entries for select to authenticated
  using (organization_id in (select private.admin_org_ids()) or (select private.is_super_admin()));
create policy platform_payments_select on public.platform_payments for select to authenticated
  using (organization_id in (select private.admin_org_ids()) or (select private.is_super_admin()));

revoke all on public.platform_billing, public.platform_fee_entries, public.platform_payments from public, anon, authenticated;
grant select on public.platform_billing, public.platform_fee_entries, public.platform_payments to authenticated;
grant all on public.platform_billing, public.platform_fee_entries, public.platform_payments to service_role;

-- -----------------------------------------------------------------------------
-- Calculs
-- -----------------------------------------------------------------------------
-- Échéance d'une écriture : fin du cycle (lundi 0 h / 1er du mois, fuseau de la centrale)
-- + N jours de délai ; dernière seconde du dernier jour (« à régler au plus tard le 5 octobre »).
create or replace function private.platform_due_at(p_org uuid, p_at timestamptz)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select ((case when o.platform_billing_cycle = 'weekly'
                then date_trunc('week', p_at at time zone o.timezone) + interval '7 days'
                else date_trunc('month', p_at at time zone o.timezone) + interval '1 month' end)
          + make_interval(days => o.platform_payment_days) - interval '1 second') at time zone o.timezone
  from public.organizations o
  where o.id = p_org;
$$;

-- Référence à indiquer sur le virement : RYD-{identifiant de la centrale}
create or replace function private.platform_reference(p_org uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select 'RYD-' || upper(left(coalesce(nullif(regexp_replace(o.slug, '[^a-z0-9]', '', 'g'), ''), replace(o.id::text, '-', '')), 12))
  from public.organizations o
  where o.id = p_org;
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
  v_posted bigint;
  v_due_posted bigint;
  v_pending bigint;
  v_pending_n integer;
  v_received bigint;
  v_declared bigint;
  v_declared_n integer;
  v_last_confirmed timestamptz;
  v_oldest timestamptz;
  v_oldest_cum bigint;
  v_balance bigint;
  v_due bigint;
  v_overdue_since timestamptz;
  v_next_due_at timestamptz;
  v_next_due bigint;
  v_blocked boolean := false;
  v_origin record;
  v_month_stats record;
begin
  select * into o from public.organizations where id = p_org;
  if not found then
    return null;
  end if;
  v_month := date_trunc('month', now() at time zone o.timezone) at time zone o.timezone;

  select coalesce(sum(e.amount_cents) filter (where e.status = 'posted'), 0),
         coalesce(sum(e.amount_cents) filter (where e.status = 'posted' and e.due_at <= now()), 0),
         coalesce(sum(e.amount_cents) filter (where e.status = 'pending'), 0),
         count(*) filter (where e.status = 'pending')
    into v_posted, v_due_posted, v_pending, v_pending_n
  from public.platform_fee_entries e
  where e.organization_id = p_org;

  select coalesce(sum(p.received_cents) filter (where p.status = 'confirmed'), 0),
         coalesce(sum(p.amount_cents) filter (where p.status = 'declared'), 0),
         count(*) filter (where p.status = 'declared'),
         max(p.reviewed_at) filter (where p.status = 'confirmed')
    into v_received, v_declared, v_declared_n, v_last_confirmed
  from public.platform_payments p
  where p.organization_id = p_org;

  -- Plus ancienne échéance non couverte par les paiements reçus (soldées dans l'ordre des échéances)
  select t.due_at, t.cum into v_oldest, v_oldest_cum
  from (
    select e.due_at, sum(sum(e.amount_cents)) over (order by e.due_at) as cum
    from public.platform_fee_entries e
    where e.organization_id = p_org and e.status = 'posted'
    group by e.due_at
  ) t
  where t.cum > v_received
  order by t.due_at
  limit 1;

  v_balance := v_posted - v_received;
  v_due := greatest(0, v_due_posted - v_received);
  if v_oldest is not null and v_oldest <= now() and v_due > 0 then
    v_overdue_since := v_oldest;
  end if;
  -- Prochaine échéance à venir et montant à régler d'ici là
  select t.due_at, t.cum - v_received into v_next_due_at, v_next_due
  from (
    select e.due_at, sum(sum(e.amount_cents)) over (order by e.due_at) as cum
    from public.platform_fee_entries e
    where e.organization_id = p_org and e.status = 'posted'
    group by e.due_at
  ) t
  where t.due_at > now() and t.cum > v_received
  order by t.due_at
  limit 1;

  if o.platform_block_after_days is not null and v_overdue_since is not null
     and v_due - v_declared > 0
     and v_overdue_since <= now() - make_interval(days => o.platform_block_after_days) then
    v_blocked := true;
  end if;

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
    'balance_cents', v_balance,
    'due_cents', v_due,
    'overdue_since', v_overdue_since,
    'days_overdue', case when v_overdue_since is null then 0
                         else greatest(0, extract(day from now() - v_overdue_since)::integer) end,
    'next_due_at', v_next_due_at,
    'next_due_cents', coalesce(v_next_due, 0),
    'declared_cents', v_declared,
    'declared_count', v_declared_n,
    'pending_reductions_cents', v_pending,
    'pending_reductions_count', v_pending_n,
    'posted_cents', v_posted,
    'received_cents', v_received,
    'last_payment_at', v_last_confirmed,
    'collected_by_centrale_cents', v_origin.collected,
    'with_drivers_cents', v_origin.with_drivers,
    'waived_by_centrale_cents', v_origin.waived,
    'held_by_centrale_cents', greatest(0, v_origin.collected - v_received),
    'blocked', v_blocked,
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
  select coalesce((private.platform_account(p_org) ->> 'blocked')::boolean, false);
$$;

create or replace function private.platform_payment_json(p public.platform_payments)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id,
    'organization_id', p.organization_id,
    'amount_cents', p.amount_cents,
    'received_cents', p.received_cents,
    'method', p.method,
    'reference', p.reference,
    'note', p.note,
    'paid_on', p.paid_on,
    'status', p.status,
    'source', p.source,
    'declared_at', p.declared_at,
    'declared_by', p.declared_by,
    'declared_by_name', (select u.full_name from public.users u where u.id = p.declared_by),
    'reviewed_at', p.reviewed_at,
    'reviewed_by_name', (select u.full_name from public.users u where u.id = p.reviewed_by),
    'review_note', p.review_note);
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

create or replace function private.broadcast_platform(p_org uuid, p_action text, p_data jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(jsonb_build_object('action', p_action, 'organization_id', p_org) || coalesce(p_data, '{}'::jsonb),
    'platform.updated', 'org:' || p_org::text, true);
end;
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
  v_recorded integer;
  v_count integer;
  v_delta integer;
  v_at timestamptz;
  e public.platform_fee_entries;
begin
  if new.status <> 'COMPLETED' then
    return null;
  end if;
  select coalesce(sum(x.amount_cents) filter (where x.status in ('posted', 'pending')), 0)::integer, count(*)
    into v_recorded, v_count
  from public.platform_fee_entries x
  where x.ride_id = new.id;
  v_delta := v_target - v_recorded;
  if v_delta = 0 then
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
      format('Correction course %s : frais %s → %s', new.number, private.fmt_eur(v_recorded), private.fmt_eur(v_target)),
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

-- Après rides_d_settlement (ordre alphabétique des déclencheurs AFTER)
create trigger rides_e_platform_fee
  after insert or update of status, price_cents, commission_cents, payment_method on public.rides
  for each row
  when (new.status = 'COMPLETED')
  execute function private.sync_platform_fee();

-- Levier du super admin : plus de nouvelles courses après N jours de retard
create or replace function private.rides_platform_block()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('rydar.bypass_ride_rules', true) = 'on' and auth.role() is null then
    return new;
  end if;
  if exists (select 1 from public.organizations o where o.id = new.organization_id and o.platform_block_after_days is not null)
     and private.platform_blocked(new.organization_id) then
    raise exception 'PLATFORM_FEES_OVERDUE: frais plateforme en retard — réglez Rydar Drive pour créer de nouvelles courses'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger rides_platform_block
  before insert on public.rides
  for each row execute function private.rides_platform_block();

-- Rattrapage : courses déjà terminées (y compris avant le passage en mode centrale)
insert into public.platform_fee_entries (organization_id, ride_id, kind, amount_cents, status, label, occurred_at, due_at)
select r.organization_id, r.id, 'ride', r.platform_fee_cents, 'posted', format('Course %s', r.number),
       coalesce(r.completed_at, r.updated_at),
       private.platform_due_at(r.organization_id, coalesce(r.completed_at, r.updated_at))
from public.rides r
where r.status = 'COMPLETED' and coalesce(r.platform_fee_cents, 0) > 0
on conflict (ride_id) where kind = 'ride' do nothing;

-- -----------------------------------------------------------------------------
-- Centrale (owner / admin, y compris centrale suspendue : elle doit pouvoir régler)
-- -----------------------------------------------------------------------------
create or replace function private.assert_platform_payer(p_org uuid)
returns void
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
    where ou.organization_id = p_org
      and ou.user_id = auth.uid()
      and ou.status = 'active'
      and ou.role in ('owner', 'admin')
      and o.status in ('active', 'suspended')
  ) then
    raise exception 'FORBIDDEN_ROLE: réservé au propriétaire ou à un administrateur de la centrale' using errcode = '42501';
  end if;
end;
$$;

-- Paiement : coordonnées de Rydar + lien prérempli (montant suggéré : échu, sinon solde)
create or replace function private.platform_pay_info(p_org uuid, p_account jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b public.platform_billing;
  v_amount integer;
  v_ref text := p_account ->> 'reference';
begin
  select * into b from public.platform_billing where id;
  v_amount := greatest(0, case when (p_account ->> 'due_cents')::bigint > 0 then (p_account ->> 'due_cents')::bigint
                               else (p_account ->> 'balance_cents')::bigint end)::integer;
  return jsonb_build_object(
    'amount_cents', v_amount,
    'reference', v_ref,
    'payee_name', b.payee_name,
    'iban', b.iban,
    'bic', b.bic,
    'instructions', b.instructions,
    'link', private.settlement_payment_link(b.payment_link, v_amount, v_ref),
    'configured', b.iban is not null or b.payment_link is not null);
end;
$$;

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
  if o.dispatch_model is distinct from 'centrale'
     and not exists (select 1 from public.platform_fee_entries e where e.organization_id = p_org)
     and not exists (select 1 from public.platform_payments p where p.organization_id = p_org) then
    return jsonb_build_object('enabled', false);
  end if;
  v_account := private.platform_account(p_org);

  select coalesce(jsonb_agg(private.platform_payment_json(p) order by p.declared_at desc), '[]'::jsonb) into v_payments
  from (select * from public.platform_payments where organization_id = p_org order by declared_at desc limit 30) p;

  select coalesce(jsonb_agg(private.platform_entry_json(e) order by e.occurred_at desc, e.created_at desc), '[]'::jsonb) into v_entries
  from (select * from public.platform_fee_entries where organization_id = p_org
        order by occurred_at desc, created_at desc limit 60) e;

  -- 6 derniers mois (fuseau de la centrale) : frais comptabilisés et paiements reçus
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
    'organization', jsonb_build_object('id', o.id, 'name', o.name, 'status', o.status, 'timezone', o.timezone),
    'account', v_account,
    'pay', private.platform_pay_info(p_org, v_account),
    'payments', v_payments,
    'entries', v_entries,
    'months', v_months);
end;
$$;

-- Bandeau du tableau de bord : état du compte seulement (owner / admin ; les autres rôles ne voient rien)
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
      and ou.role in ('owner', 'admin') and o.status in ('active', 'suspended')
  ) then
    return jsonb_build_object('enabled', false);
  end if;
  if not exists (select 1 from public.organizations o where o.id = p_org and o.dispatch_model = 'centrale')
     and not exists (select 1 from public.platform_fee_entries e where e.organization_id = p_org)
     and not exists (select 1 from public.platform_payments p where p.organization_id = p_org) then
    return jsonb_build_object('enabled', false);
  end if;
  return jsonb_build_object('enabled', true, 'account', private.platform_account(p_org));
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
  if p_month is null or p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
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

create or replace function public.org_platform_statement(p_org uuid, p_month text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_payer(p_org);
  return private.platform_statement(p_org, p_month);
end;
$$;

-- « J'ai payé » : déclaration de la centrale, à confirmer par le super admin
create or replace function public.declare_platform_payment(
  p_org uuid,
  p_amount integer,
  p_method text,
  p_reference text default null,
  p_note text default null,
  p_paid_on date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  p public.platform_payments;
  v_ref text := left(nullif(btrim(coalesce(p_reference, '')), ''), 80);
  v_note text := left(nullif(btrim(coalesce(p_note, '')), ''), 500);
  v_today date;
begin
  perform private.assert_platform_payer(p_org);
  perform private.set_actor('user', auth.uid());
  select * into o from public.organizations where id = p_org for update;
  v_today := (now() at time zone o.timezone)::date;
  if p_amount is null or p_amount < 1 or p_amount > 10000000 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_AMOUNT', 'message', 'Montant invalide.');
  end if;
  if p_method is null or p_method not in ('transfer', 'link', 'cash', 'card', 'other') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_METHOD', 'message', 'Moyen de paiement invalide.');
  end if;
  if p_paid_on is not null and (p_paid_on > v_today or p_paid_on < v_today - 366) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DATE', 'message', 'Date de paiement invalide.');
  end if;
  if (select count(*) from public.platform_payments x where x.organization_id = p_org and x.status = 'declared') >= 5 then
    return jsonb_build_object('ok', false, 'code', 'TOO_MANY_PENDING',
      'message', 'Déjà 5 paiements en attente de confirmation : attendez la réponse de Rydar.');
  end if;
  if exists (select 1 from public.platform_payments x where x.organization_id = p_org and x.declared_by = auth.uid()
             and x.declared_at > now() - interval '30 seconds') then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED', 'message', 'Paiement déjà déclaré à l''instant.');
  end if;

  insert into public.platform_payments (organization_id, amount_cents, method, reference, note, paid_on, source, declared_by)
  values (p_org, p_amount, p_method, v_ref, v_note, coalesce(p_paid_on, v_today), 'centrale', auth.uid())
  returning * into p;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, 'user', auth.uid(), 'platform_payment.declared', 'platform_payments', p.id::text, 'info',
    jsonb_build_object('amount_cents', p_amount, 'method', p_method, 'reference', v_ref, 'paid_on', p.paid_on));
  perform private.broadcast_platform(p_org, 'declared', jsonb_build_object('payment', private.platform_payment_json(p)));
  return jsonb_build_object('ok', true, 'code', 'DECLARED', 'id', p.id, 'amount_cents', p_amount,
    'message', format('Paiement de %s signalé : Rydar va le confirmer.', private.fmt_eur(p_amount)));
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
  if p.status <> 'declared' or p.source <> 'centrale' then
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

  -- Centrales, et toute organisation qui a eu des frais (une centrale repassée en flotte reste suivie)
  select coalesce(jsonb_agg(t.j order by (t.j ->> 'due_cents')::bigint desc, (t.j ->> 'balance_cents')::bigint desc, t.name), '[]'::jsonb)
    into v_orgs
  from (
    select o.name, private.platform_account(o.id) || jsonb_build_object(
        'id', o.id, 'name', o.name, 'slug', o.slug, 'status', o.status, 'dispatch_model', o.dispatch_model) as j
    from public.organizations o
    where o.status <> 'archived'
      and (o.dispatch_model = 'centrale'
           or exists (select 1 from public.platform_fee_entries e where e.organization_id = o.id)
           or exists (select 1 from public.platform_payments p where p.organization_id = o.id))
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

create or replace function public.admin_platform_account(p_org uuid, p_month text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  v_payments jsonb;
begin
  if not private.is_super_admin() then
    raise exception 'FORBIDDEN: réservé au super admin' using errcode = '42501';
  end if;
  select * into o from public.organizations where id = p_org;
  if not found then
    return null;
  end if;
  select coalesce(jsonb_agg(private.platform_payment_json(p) order by p.declared_at desc), '[]'::jsonb) into v_payments
  from (select * from public.platform_payments where organization_id = p_org order by declared_at desc limit 200) p;

  return jsonb_build_object(
    'organization', jsonb_build_object('id', o.id, 'name', o.name, 'slug', o.slug, 'status', o.status,
      'dispatch_model', o.dispatch_model, 'timezone', o.timezone, 'currency', o.currency),
    'account', private.platform_account(p_org),
    'payments', v_payments,
    'statement', private.platform_statement(p_org, p_month));
end;
$$;

-- -----------------------------------------------------------------------------
-- Super admin : écritures (service role, auteur p_actor, journal d'audit)
-- -----------------------------------------------------------------------------
create or replace function private.assert_platform_actor(p_actor uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_actor is null or not exists (select 1 from public.users u where u.id = p_actor and u.is_super_admin) then
    raise exception 'FORBIDDEN: réservé au super admin' using errcode = '42501';
  end if;
end;
$$;

-- « Reçu » : montant réellement reçu (partiel possible)
create or replace function public.svc_platform_confirm_payment(
  p_id uuid,
  p_actor uuid,
  p_received_cents integer default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.platform_payments;
  v_received integer;
  v_note text := left(nullif(btrim(coalesce(p_note, '')), ''), 500);
begin
  perform private.assert_platform_actor(p_actor);
  select * into p from public.platform_payments where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Paiement introuvable.');
  end if;
  if p.status <> 'declared' then
    return jsonb_build_object('ok', false, 'code', 'NOT_PENDING', 'message', 'Ce paiement a déjà été traité.');
  end if;
  v_received := coalesce(p_received_cents, p.amount_cents);
  if v_received < 1 or v_received > 100000000 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_AMOUNT', 'message', 'Montant reçu invalide.');
  end if;
  perform private.set_actor('super_admin', p_actor);
  update public.platform_payments
     set status = 'confirmed', received_cents = v_received, reviewed_by = p_actor, reviewed_at = now(), review_note = v_note
   where id = p.id
  returning * into p;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p.organization_id, 'super_admin', p_actor, 'platform_payment.confirmed', 'platform_payments', p.id::text,
    case when v_received <> p.amount_cents then 'warning' else 'info' end,
    jsonb_build_object('declared_cents', p.amount_cents, 'received_cents', v_received, 'note', v_note));
  perform private.broadcast_platform(p.organization_id, 'confirmed', jsonb_build_object('payment', private.platform_payment_json(p)));
  return jsonb_build_object('ok', true, 'code', 'CONFIRMED', 'received_cents', v_received,
    'message', case when v_received <> p.amount_cents
                    then format('Reçu %s sur %s déclarés.', private.fmt_eur(v_received), private.fmt_eur(p.amount_cents))
                    else format('Paiement de %s confirmé.', private.fmt_eur(v_received)) end);
end;
$$;

-- « Pas reçu »
create or replace function public.svc_platform_reject_payment(p_id uuid, p_actor uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.platform_payments;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
begin
  perform private.assert_platform_actor(p_actor);
  select * into p from public.platform_payments where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Paiement introuvable.');
  end if;
  if p.status <> 'declared' then
    return jsonb_build_object('ok', false, 'code', 'NOT_PENDING', 'message', 'Ce paiement a déjà été traité.');
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'message', 'Précisez ce qui ne va pas.');
  end if;
  perform private.set_actor('super_admin', p_actor);
  update public.platform_payments
     set status = 'rejected', reviewed_by = p_actor, reviewed_at = now(), review_note = v_reason
   where id = p.id
  returning * into p;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p.organization_id, 'super_admin', p_actor, 'platform_payment.rejected', 'platform_payments', p.id::text, 'warning',
    jsonb_build_object('amount_cents', p.amount_cents, 'reason', v_reason));
  perform private.broadcast_platform(p.organization_id, 'rejected', jsonb_build_object('payment', private.platform_payment_json(p)));
  return jsonb_build_object('ok', true, 'code', 'REJECTED', 'message', 'Paiement marqué non reçu : la centrale est prévenue.');
end;
$$;

-- Erreur de saisie : une décision (reçu / pas reçu) redevient « à confirmer »
create or replace function public.svc_platform_reopen_payment(p_id uuid, p_actor uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.platform_payments;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
  v_before text;
  v_received integer;
begin
  perform private.assert_platform_actor(p_actor);
  select * into p from public.platform_payments where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Paiement introuvable.');
  end if;
  if p.status not in ('confirmed', 'rejected') then
    return jsonb_build_object('ok', false, 'code', 'NOT_CLOSED', 'message', 'Ce paiement est déjà à confirmer.');
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'message', 'Indiquez pourquoi vous rouvrez ce paiement.');
  end if;
  v_before := p.status;
  v_received := p.received_cents;
  perform private.set_actor('super_admin', p_actor);
  update public.platform_payments
     set status = 'declared', received_cents = null, reviewed_by = null, reviewed_at = null, review_note = v_reason
   where id = p.id
  returning * into p;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p.organization_id, 'super_admin', p_actor, 'platform_payment.reopened', 'platform_payments', p.id::text, 'warning',
    jsonb_build_object('from', v_before, 'received_cents', v_received, 'reason', v_reason));
  perform private.broadcast_platform(p.organization_id, 'reopened', jsonb_build_object('payment', private.platform_payment_json(p)));
  return jsonb_build_object('ok', true, 'code', 'REOPENED', 'message', 'Paiement de nouveau à confirmer.');
end;
$$;

-- Paiement reçu directement par Rydar (espèces, virement non déclaré…)
create or replace function public.svc_platform_record_payment(
  p_org uuid,
  p_actor uuid,
  p_amount integer,
  p_method text,
  p_reference text default null,
  p_note text default null,
  p_paid_on date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.platform_payments;
  v_ref text := left(nullif(btrim(coalesce(p_reference, '')), ''), 80);
  v_note text := left(nullif(btrim(coalesce(p_note, '')), ''), 500);
begin
  perform private.assert_platform_actor(p_actor);
  if not exists (select 1 from public.organizations o where o.id = p_org) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Organisation introuvable.');
  end if;
  if p_amount is null or p_amount < 1 or p_amount > 10000000 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_AMOUNT', 'message', 'Montant invalide.');
  end if;
  if p_method is null or p_method not in ('transfer', 'link', 'cash', 'card', 'other') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_METHOD', 'message', 'Moyen de paiement invalide.');
  end if;
  if p_paid_on is not null and (p_paid_on > current_date + 1 or p_paid_on < current_date - 366) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DATE', 'message', 'Date de paiement invalide.');
  end if;
  perform private.set_actor('super_admin', p_actor);
  insert into public.platform_payments (organization_id, amount_cents, received_cents, method, reference, note, paid_on, status,
    source, declared_by, declared_at, reviewed_by, reviewed_at)
  values (p_org, p_amount, p_amount, p_method, v_ref, v_note, coalesce(p_paid_on, current_date), 'confirmed', 'admin',
    p_actor, now(), p_actor, now())
  returning * into p;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, 'super_admin', p_actor, 'platform_payment.recorded', 'platform_payments', p.id::text, 'info',
    jsonb_build_object('amount_cents', p_amount, 'method', p_method, 'reference', v_ref));
  perform private.broadcast_platform(p_org, 'confirmed', jsonb_build_object('payment', private.platform_payment_json(p)));
  return jsonb_build_object('ok', true, 'code', 'RECORDED', 'id', p.id,
    'message', format('Paiement de %s enregistré.', private.fmt_eur(p_amount)));
end;
$$;

-- Avoir (montant négatif) ou frais ajoutés (positif), motif obligatoire
create or replace function public.svc_platform_adjust(p_org uuid, p_actor uuid, p_amount integer, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.platform_fee_entries;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
begin
  perform private.assert_platform_actor(p_actor);
  if not exists (select 1 from public.organizations o where o.id = p_org) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Organisation introuvable.');
  end if;
  if p_amount is null or p_amount = 0 or abs(p_amount) > 10000000 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_AMOUNT', 'message', 'Montant invalide.');
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'message', 'Indiquez le motif.');
  end if;
  perform private.set_actor('super_admin', p_actor);
  insert into public.platform_fee_entries (organization_id, kind, amount_cents, status, label, reason, occurred_at, due_at, created_by)
  values (p_org, 'adjustment', p_amount, 'posted',
    left(case when p_amount < 0 then 'Avoir : ' else 'Frais ajoutés : ' end || v_reason, 200), v_reason, now(),
    private.platform_due_at(p_org, now()), p_actor)
  returning * into e;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, 'super_admin', p_actor, 'platform_fee.adjusted', 'platform_fee_entries', e.id::text, 'warning',
    jsonb_build_object('amount_cents', p_amount, 'reason', v_reason));
  perform private.broadcast_platform(p_org, 'adjusted', jsonb_build_object('entry', private.platform_entry_json(e)));
  return jsonb_build_object('ok', true, 'code', 'ADJUSTED', 'id', e.id,
    'message', case when p_amount < 0 then format('Avoir de %s accordé.', private.fmt_eur(-p_amount))
                    else format('%s de frais ajoutés.', private.fmt_eur(p_amount)) end);
end;
$$;

-- Baisse de frais (prix corrigé après la course) : acceptée → comptée ; refusée → ignorée
create or replace function public.svc_platform_review_entry(p_id uuid, p_actor uuid, p_approve boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.platform_fee_entries;
  v_note text := left(nullif(btrim(coalesce(p_note, '')), ''), 500);
begin
  perform private.assert_platform_actor(p_actor);
  select * into e from public.platform_fee_entries where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Écriture introuvable.');
  end if;
  if e.status <> 'pending' then
    return jsonb_build_object('ok', false, 'code', 'NOT_PENDING', 'message', 'Cette baisse a déjà été traitée.');
  end if;
  if p_approve is null then
    return jsonb_build_object('ok', false, 'code', 'DECISION_REQUIRED', 'message', 'Acceptez ou refusez la baisse.');
  end if;
  if not p_approve and (v_note is null or char_length(v_note) < 3) then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'message', 'Indiquez pourquoi vous refusez la baisse.');
  end if;
  perform private.set_actor('super_admin', p_actor);
  update public.platform_fee_entries
     set status = case when p_approve then 'posted' else 'rejected' end,
         reviewed_by = p_actor, reviewed_at = now(), review_note = v_note
   where id = e.id
  returning * into e;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (e.organization_id, 'super_admin', p_actor,
    case when p_approve then 'platform_fee.reduction_approved' else 'platform_fee.reduction_rejected' end,
    'platform_fee_entries', e.id::text, 'warning', jsonb_build_object('amount_cents', e.amount_cents, 'note', v_note));
  perform private.broadcast_platform(e.organization_id, case when p_approve then 'reduction_approved' else 'reduction_rejected' end,
    jsonb_build_object('entry', private.platform_entry_json(e)));
  return jsonb_build_object('ok', true, 'code', case when p_approve then 'APPROVED' else 'REJECTED' end,
    'message', case when p_approve then 'Baisse acceptée.' else 'Baisse refusée : les frais restent dus.' end);
end;
$$;

-- Relance de la centrale (affichée dans son tableau de bord) — au plus une par heure
create or replace function public.svc_platform_remind(p_org uuid, p_actor uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  v_note text := left(nullif(btrim(coalesce(p_note, '')), ''), 300);
  v_account jsonb;
begin
  perform private.assert_platform_actor(p_actor);
  select * into o from public.organizations where id = p_org for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Organisation introuvable.');
  end if;
  if o.platform_reminded_at > now() - interval '1 hour' then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED', 'message', 'Relance déjà envoyée il y a moins d''une heure.');
  end if;
  v_account := private.platform_account(p_org);
  if (v_account ->> 'balance_cents')::bigint <= 0 then
    return jsonb_build_object('ok', false, 'code', 'NOTHING_DUE', 'message', 'Rien à régler pour cette centrale.');
  end if;
  perform private.set_actor('super_admin', p_actor);
  update public.organizations set platform_reminded_at = now(), platform_reminder_note = v_note where id = p_org;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, 'super_admin', p_actor, 'platform_fee.reminded', 'organizations', p_org::text, 'info',
    jsonb_build_object('balance_cents', v_account -> 'balance_cents', 'due_cents', v_account -> 'due_cents', 'note', v_note));
  perform private.broadcast_platform(p_org, 'reminded', jsonb_build_object('note', v_note));
  return jsonb_build_object('ok', true, 'code', 'REMINDED', 'message', 'Relance affichée à la centrale.');
end;
$$;

-- Conditions de la centrale : cycle, délai, blocage
create or replace function public.svc_platform_terms(
  p_org uuid,
  p_actor uuid,
  p_cycle text,
  p_payment_days integer,
  p_block_after_days integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.organizations;
begin
  perform private.assert_platform_actor(p_actor);
  select * into o from public.organizations where id = p_org for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Organisation introuvable.');
  end if;
  if p_cycle is null or p_cycle not in ('weekly', 'monthly') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CYCLE', 'message', 'Cycle invalide (hebdomadaire ou mensuel).');
  end if;
  if p_payment_days is null or p_payment_days not between 0 and 60 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DAYS', 'message', 'Délai de paiement : entre 0 et 60 jours.');
  end if;
  if p_block_after_days is not null and p_block_after_days not between 1 and 90 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_BLOCK', 'message', 'Blocage : entre 1 et 90 jours de retard.');
  end if;
  perform private.set_actor('super_admin', p_actor);
  update public.organizations
     set platform_billing_cycle = p_cycle, platform_payment_days = p_payment_days, platform_block_after_days = p_block_after_days
   where id = p_org;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, 'super_admin', p_actor, 'platform_fee.terms_changed', 'organizations', p_org::text, 'info',
    jsonb_build_object(
      'before', jsonb_build_object('cycle', o.platform_billing_cycle, 'payment_days', o.platform_payment_days,
        'block_after_days', o.platform_block_after_days),
      'after', jsonb_build_object('cycle', p_cycle, 'payment_days', p_payment_days, 'block_after_days', p_block_after_days)));
  perform private.broadcast_platform(p_org, 'terms');
  return jsonb_build_object('ok', true, 'code', 'SAVED',
    'message', 'Conditions enregistrées (les frais déjà enregistrés gardent leur échéance).');
end;
$$;

-- Coordonnées de paiement de Rydar
create or replace function public.svc_platform_billing_update(
  p_actor uuid,
  p_payee_name text,
  p_iban text,
  p_bic text,
  p_payment_link text,
  p_instructions text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payee text := left(nullif(btrim(coalesce(p_payee_name, '')), ''), 120);
  v_iban text := nullif(upper(regexp_replace(coalesce(p_iban, ''), '\s', '', 'g')), '');
  v_bic text := nullif(upper(regexp_replace(coalesce(p_bic, ''), '\s', '', 'g')), '');
  v_link text := nullif(btrim(coalesce(p_payment_link, '')), '');
  v_instructions text := left(nullif(btrim(coalesce(p_instructions, '')), ''), 500);
begin
  perform private.assert_platform_actor(p_actor);
  if v_payee is not null and char_length(v_payee) < 2 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PAYEE', 'field', 'payeeName', 'message', 'Bénéficiaire trop court.');
  end if;
  if v_iban is not null and v_iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IBAN', 'field', 'iban', 'message', 'IBAN invalide.');
  end if;
  if v_bic is not null and v_bic !~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_BIC', 'field', 'bic', 'message', 'BIC invalide.');
  end if;
  if v_link is not null and (char_length(v_link) > 500 or v_link !~ '^https://\S+$') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_LINK', 'field', 'paymentLink',
      'message', 'Lien de paiement invalide (https://…).');
  end if;
  perform private.set_actor('super_admin', p_actor);
  update public.platform_billing
     set payee_name = v_payee, iban = v_iban, bic = v_bic, payment_link = v_link, instructions = v_instructions,
         updated_at = now(), updated_by = p_actor
   where id;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (null, 'super_admin', p_actor, 'platform_billing.updated', 'platform_billing', 'platform', 'warning',
    jsonb_build_object('payee_name', v_payee, 'iban_end', right(v_iban, 4), 'bic', v_bic, 'payment_link', v_link));
  return jsonb_build_object('ok', true, 'code', 'SAVED', 'message', 'Coordonnées de paiement enregistrées.');
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
        'platform_balance_cents', (a ->> 'balance_cents')::bigint,
        'platform_due_cents', (a ->> 'due_cents')::bigint,
        'platform_declared_cents', (a ->> 'declared_cents')::bigint,
        'platform_overdue_since', a -> 'overdue_since') as j
    from public.organizations o
    cross join lateral private.platform_account(o.id) a
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

-- -----------------------------------------------------------------------------
-- Droits d'exécution (deny-by-default, cf. 20260924000900)
-- -----------------------------------------------------------------------------
revoke execute on function
  private.platform_entry_guard(),
  private.platform_due_at(uuid, timestamptz),
  private.platform_reference(uuid),
  private.platform_account(uuid),
  private.platform_blocked(uuid),
  private.platform_payment_json(public.platform_payments),
  private.platform_entry_json(public.platform_fee_entries),
  private.broadcast_platform(uuid, text, jsonb),
  private.sync_platform_fee(),
  private.rides_platform_block(),
  private.assert_platform_payer(uuid),
  private.platform_pay_info(uuid, jsonb),
  private.platform_statement(uuid, text),
  private.assert_platform_actor(uuid)
from public, anon, authenticated;
grant execute on function
  private.platform_entry_guard(),
  private.platform_due_at(uuid, timestamptz),
  private.platform_reference(uuid),
  private.platform_account(uuid),
  private.platform_blocked(uuid),
  private.platform_payment_json(public.platform_payments),
  private.platform_entry_json(public.platform_fee_entries),
  private.broadcast_platform(uuid, text, jsonb),
  private.sync_platform_fee(),
  private.rides_platform_block(),
  private.assert_platform_payer(uuid),
  private.platform_pay_info(uuid, jsonb),
  private.platform_statement(uuid, text),
  private.assert_platform_actor(uuid)
to service_role;

-- Tableau de bord (centrale) et super admin (contrôles dans chaque fonction)
revoke execute on function
  public.org_platform_status(uuid),
  public.org_platform_account(uuid),
  public.org_platform_statement(uuid, text),
  public.declare_platform_payment(uuid, integer, text, text, text, date),
  public.cancel_platform_payment(uuid),
  public.admin_platform_overview(),
  public.admin_platform_account(uuid, text),
  public.admin_centrale_overview(timestamptz)
from public, anon;
grant execute on function
  public.org_platform_status(uuid),
  public.org_platform_account(uuid),
  public.org_platform_statement(uuid, text),
  public.declare_platform_payment(uuid, integer, text, text, text, date),
  public.cancel_platform_payment(uuid),
  public.admin_platform_overview(),
  public.admin_platform_account(uuid, text),
  public.admin_centrale_overview(timestamptz)
to authenticated, service_role;

-- Serveur uniquement (routes du super admin) : service role
revoke execute on function
  public.svc_platform_confirm_payment(uuid, uuid, integer, text),
  public.svc_platform_reject_payment(uuid, uuid, text),
  public.svc_platform_reopen_payment(uuid, uuid, text),
  public.svc_platform_record_payment(uuid, uuid, integer, text, text, text, date),
  public.svc_platform_adjust(uuid, uuid, integer, text),
  public.svc_platform_review_entry(uuid, uuid, boolean, text),
  public.svc_platform_remind(uuid, uuid, text),
  public.svc_platform_terms(uuid, uuid, text, integer, integer),
  public.svc_platform_billing_update(uuid, text, text, text, text, text)
from public, anon, authenticated;
grant execute on function
  public.svc_platform_confirm_payment(uuid, uuid, integer, text),
  public.svc_platform_reject_payment(uuid, uuid, text),
  public.svc_platform_reopen_payment(uuid, uuid, text),
  public.svc_platform_record_payment(uuid, uuid, integer, text, text, text, date),
  public.svc_platform_adjust(uuid, uuid, integer, text),
  public.svc_platform_review_entry(uuid, uuid, boolean, text),
  public.svc_platform_remind(uuid, uuid, text),
  public.svc_platform_terms(uuid, uuid, text, integer, integer),
  public.svc_platform_billing_update(uuid, text, text, text, text, text)
to service_role;
