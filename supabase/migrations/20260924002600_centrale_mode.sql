-- =============================================================================
-- Rydar Drive — Modèle « Centrale à commission » (option 2)
--
-- Deux modèles d'exploitation par compte rattacheur, choisis par le super admin
-- (organizations.dispatch_model, aucun droit client) :
--   fleet     (option 1) : flotte de la société — comportement historique inchangé ;
--   centrale  (option 2) : réseau de chauffeurs indépendants (groupes WhatsApp / Telegram).
--
-- En mode centrale :
--   • répartition de chaque course (trigger) : part chauffeur / commission de la centrale /
--     frais plateforme (réglés par le super admin) — le chauffeur voit « Vous gagnez 40 € »
--     dans l'offre ; commission automatique (% + fixe) ou saisie à la course ;
--   • règlement à la fin de la course (ride_settlements) : le chauffeur doit commission + frais
--     s'il a encaissé le client (espèces / carte à bord) ; la centrale doit la part chauffeur si
--     le client l'a payée (en ligne / facture / compte). Lien de paiement ({montant},
--     {montant_centimes}, {reference} : Revolut, PayPal, Lydia…), espèces ou virement ;
--     « J'ai payé » côté chauffeur, confirmation / contestation par la centrale, relances ;
--   • blocage des offres (GPS et flotte) et de l'acceptation : commission en retard ou
--     contestée, encours au-delà du plafond, nouveau chauffeur au-dessus du prix plafond ;
--     passage automatique « confirmé » après N courses réglées ;
--   • bannissement définitif : identités hachées (téléphone, e-mail, carte VTC, permis, pièce
--     d'identité, appareil, plaque en option) refusées à toute nouvelle inscription ; un appareil
--     banni suspend le compte qui l'utilise ; signalement au super admin, qui peut bannir de
--     toute la plateforme (toutes les centrales) ;
--   • inscription par lien /rejoindre/{code} : candidature (compte + véhicule) rattachée à la
--     centrale → validation manuelle (ou automatique) ; documents déposables depuis l'app avant
--     validation.
-- Chaque centrale reste un tenant isolé (RLS) : rien n'est visible d'une centrale à l'autre ;
-- seul le super admin voit les signalements et bannissements plateforme (identités hachées).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Colonnes
-- -----------------------------------------------------------------------------
-- Modèle d'exploitation + frais plateforme : super admin uniquement (service role, audit).
-- Lien d'inscription : via set_join_link (owner / admin).
alter table public.organizations
  add column dispatch_model text not null default 'fleet'
    check (dispatch_model in ('fleet', 'centrale')),
  add column platform_fee_percent numeric(5, 2) not null default 0
    check (platform_fee_percent between 0 and 50),
  add column platform_fee_fixed_cents integer not null default 0
    check (platform_fee_fixed_cents between 0 and 100000),
  add column join_code text unique
    check (join_code is null or join_code ~ '^[a-z0-9]{10,32}$'),
  add column join_enabled boolean not null default false,
  add column join_auto_approve boolean not null default false;

-- Réglages de la centrale (owner / admin, via la RLS existante)
alter table public.organization_settings
  add column driver_commission_fixed_cents integer
    check (driver_commission_fixed_cents is null or driver_commission_fixed_cents between 0 and 100000),
  add column settlement_grace_hours integer not null default 24
    check (settlement_grace_hours between 0 and 720),
  add column settlement_credit_limit_cents integer
    check (settlement_credit_limit_cents is null or settlement_credit_limit_cents between 0 and 10000000),
  add column block_unpaid boolean not null default true,
  add column new_driver_max_price_cents integer
    check (new_driver_max_price_cents is null or new_driver_max_price_cents between 0 and 10000000),
  add column trust_after_rides integer default 10
    check (trust_after_rides is null or trust_after_rides between 1 and 1000),
  add column settlement_methods text[] not null default '{link,cash}'
    check (cardinality(settlement_methods) between 1 and 3
           and settlement_methods <@ array['link', 'cash', 'transfer']::text[]),
  add column settlement_link text
    check (settlement_link is null or (char_length(settlement_link) <= 500 and settlement_link ~ '^https://\S+$')),
  add column settlement_instructions text
    check (settlement_instructions is null or char_length(settlement_instructions) <= 500);

grant update (driver_commission_fixed_cents, settlement_grace_hours, settlement_credit_limit_cents, block_unpaid,
  new_driver_max_price_cents, trust_after_rides, settlement_methods, settlement_link, settlement_instructions)
  on public.organization_settings to authenticated;

-- Chauffeurs : confiance, candidature par lien, bannissement (hors trust_level : RPC uniquement)
alter table public.drivers
  add column trust_level text not null default 'trusted' check (trust_level in ('new', 'trusted')),
  add column joined_via text not null default 'dashboard' check (joined_via in ('dashboard', 'join_link')),
  add column application_status text check (application_status in ('pending', 'approved', 'rejected')),
  add column application_message text check (application_message is null or char_length(application_message) <= 1000),
  add column applied_at timestamptz,
  add column application_reviewed_at timestamptz,
  add column application_reviewed_by uuid references public.users (id) on delete set null,
  add column application_note text check (application_note is null or char_length(application_note) <= 500),
  add column banned_at timestamptz,
  add column banned_by uuid references public.users (id) on delete set null,
  add column ban_reason text check (ban_reason is null or char_length(ban_reason) <= 500),
  add column ban_scope text check (ban_scope is null or ban_scope in ('org', 'platform')),
  add column ban_report_id uuid;

grant update (trust_level) on public.drivers to authenticated;

create index drivers_applications_idx on public.drivers (organization_id, applied_at desc)
  where application_status = 'pending';
create index drivers_banned_idx on public.drivers (organization_id, banned_at desc) where banned_at is not null;

-- Courses : répartition (calculée par trigger ; commission saisissable à la course)
alter table public.rides
  add column commission_cents integer check (commission_cents is null or commission_cents between 0 and 10000000),
  add column platform_fee_cents integer check (platform_fee_cents is null or platform_fee_cents between 0 and 10000000),
  add column driver_payout_cents integer check (driver_payout_cents is null or driver_payout_cents between 0 and 10000000),
  add column commission_manual boolean not null default false;

grant insert (commission_cents), update (commission_cents) on public.rides to authenticated;

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
create table public.ride_settlements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  ride_id uuid not null,
  driver_id uuid,
  driver_label text not null,
  direction text not null check (direction in ('driver_owes', 'centrale_owes')),
  amount_cents integer not null check (amount_cents between 0 and 10000000),
  price_cents integer not null check (price_cents between 0 and 10000000),
  commission_cents integer not null check (commission_cents >= 0),
  platform_fee_cents integer not null default 0 check (platform_fee_cents >= 0),
  driver_payout_cents integer not null check (driver_payout_cents >= 0),
  currency text not null default 'EUR',
  payment_method public.payment_method not null,
  reference text not null check (char_length(reference) between 2 and 40),
  status text not null default 'due' check (status in ('due', 'declared', 'paid', 'waived', 'disputed')),
  due_at timestamptz not null,
  declared_at timestamptz,
  declared_method text check (declared_method is null or declared_method in ('link', 'cash', 'transfer')),
  declared_note text check (declared_note is null or char_length(declared_note) <= 300),
  settled_at timestamptz,
  settled_by uuid references public.users (id) on delete set null,
  settled_method text check (settled_method is null or settled_method in ('link', 'cash', 'transfer', 'other')),
  note text check (note is null or char_length(note) <= 500),
  reminders_sent smallint not null default 0,
  last_reminded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ride_id),
  unique (organization_id, id),
  foreign key (organization_id, ride_id) references public.rides (organization_id, id) on delete cascade,
  foreign key (organization_id, driver_id) references public.drivers (organization_id, id) on delete set null (driver_id)
);
comment on table public.ride_settlements is
  'Mode centrale : commission due par le chauffeur (driver_owes) ou part chauffeur due par la centrale (centrale_owes), une ligne par course terminée.';

create index ride_settlements_org_status_idx on public.ride_settlements (organization_id, status, created_at desc);
create index ride_settlements_driver_open_idx on public.ride_settlements (driver_id, due_at)
  where status in ('due', 'declared', 'disputed');
create index ride_settlements_driver_idx on public.ride_settlements (driver_id, created_at desc);

create table public.fraud_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  driver_id uuid references public.drivers (id) on delete set null,
  driver_label text not null,
  category text not null check (category in ('unpaid', 'fraud', 'behavior', 'documents', 'other')),
  reason text not null check (char_length(reason) between 3 and 500),
  identities jsonb not null default '[]'::jsonb,
  status text not null default 'open' check (status in ('open', 'platform_banned', 'dismissed', 'lifted')),
  reported_by uuid references public.users (id) on delete set null,
  reviewed_by uuid references public.users (id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (review_note is null or char_length(review_note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.fraud_reports is
  'Signalements d''un chauffeur banni par une centrale, soumis au super admin (bannissement plateforme). Identités hachées.';

create index fraud_reports_status_idx on public.fraud_reports (status, created_at desc);
create index fraud_reports_org_idx on public.fraud_reports (organization_id, created_at desc);

alter table public.drivers
  add constraint drivers_ban_report_fk foreign key (ban_report_id) references public.fraud_reports (id) on delete set null;

-- Identités bannies : jamais la valeur en clair (sha256 de la valeur normalisée) + indice masqué.
-- scope org : refusées dans cette centrale ; scope platform (super admin) : refusées partout.
create table public.banned_identities (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('org', 'platform')),
  organization_id uuid references public.organizations (id) on delete cascade,
  kind text not null check (kind in ('phone', 'email', 'vtc_card', 'driving_license', 'identity_doc', 'plate', 'device')),
  value_hash text not null check (value_hash ~ '^[0-9a-f]{64}$'),
  hint text,
  driver_id uuid references public.drivers (id) on delete set null,
  report_id uuid references public.fraud_reports (id) on delete set null,
  reason text check (reason is null or char_length(reason) <= 500),
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  lifted_at timestamptz,
  lifted_by uuid references public.users (id) on delete set null,
  lift_reason text check (lift_reason is null or char_length(lift_reason) <= 500),
  check ((scope = 'org') = (organization_id is not null))
);
comment on table public.banned_identities is
  'Bannissements : identités hachées (sha256) refusées à l''inscription / la création, dans la centrale (org) ou partout (platform).';

create unique index banned_identities_active_uidx on public.banned_identities
  (scope, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, value_hash)
  where lifted_at is null;
create index banned_identities_lookup_idx on public.banned_identities (kind, value_hash) where lifted_at is null;
create index banned_identities_driver_idx on public.banned_identities (driver_id);
create index banned_identities_report_idx on public.banned_identities (report_id) where report_id is not null;

create trigger ride_settlements_touch_updated_at
  before update on public.ride_settlements
  for each row execute function private.touch_updated_at();
create trigger ride_settlements_forbid_org_change
  before update of organization_id on public.ride_settlements
  for each row execute function private.forbid_org_change();
create trigger fraud_reports_touch_updated_at
  before update on public.fraud_reports
  for each row execute function private.touch_updated_at();
create trigger fraud_reports_forbid_org_change
  before update of organization_id on public.fraud_reports
  for each row execute function private.forbid_org_change();
create trigger banned_identities_forbid_org_change
  before update of organization_id on public.banned_identities
  for each row execute function private.forbid_org_change();

-- RLS : lecture seule ; toutes les écritures passent par les RPC ci-dessous (ou le service role)
alter table public.ride_settlements enable row level security;
alter table public.fraud_reports enable row level security;
alter table public.banned_identities enable row level security;

create policy ride_settlements_select on public.ride_settlements for select to authenticated
  using (
    organization_id in (select private.member_org_ids())
    or (driver_id is not null and driver_id = (select private.current_driver_id()))
    or (select private.is_super_admin())
  );
create policy fraud_reports_select on public.fraud_reports for select to authenticated
  using (organization_id in (select private.admin_org_ids()) or (select private.is_super_admin()));
create policy banned_identities_select on public.banned_identities for select to authenticated
  using (
    (scope = 'org' and organization_id in (select private.admin_org_ids()))
    or (select private.is_super_admin())
  );

revoke all on public.ride_settlements, public.fraud_reports, public.banned_identities from public, anon, authenticated;
grant select on public.ride_settlements, public.fraud_reports, public.banned_identities to authenticated;
grant all on public.ride_settlements, public.fraud_reports, public.banned_identities to service_role;

-- Retour au modèle flotte : le lien d'inscription est coupé
create or replace function private.organizations_dispatch_model_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.dispatch_model = 'fleet' then
    new.join_enabled := false;
  end if;
  return new;
end;
$$;

create trigger organizations_dispatch_model_guard
  before insert or update of dispatch_model, join_enabled on public.organizations
  for each row execute function private.organizations_dispatch_model_guard();

-- -----------------------------------------------------------------------------
-- Identités : normalisation, empreinte, indice masqué
-- -----------------------------------------------------------------------------
-- « 06 12 34 56 78 », « +33 6 12… », « 0033612… » → « +33612345678 » ; e-mails en minuscules,
-- sans « +étiquette » (et sans points pour Gmail) ; numéros / plaques en majuscules sans séparateurs.
create or replace function private.identity_normalize(p_kind text, p_value text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := btrim(coalesce(p_value, ''));
  v_local text;
  v_domain text;
begin
  if v = '' then
    return null;
  end if;
  if p_kind = 'phone' then
    v := case when left(v, 1) = '+' then '+' || regexp_replace(v, '[^0-9]', '', 'g')
              else regexp_replace(v, '[^0-9]', '', 'g') end;
    if left(v, 2) = '00' then
      v := '+' || substr(v, 3);
    elsif v ~ '^0[1-9][0-9]{8}$' then
      v := '+33' || substr(v, 2);
    end if;
    if char_length(regexp_replace(v, '[^0-9]', '', 'g')) < 6 then
      return null;
    end if;
  elsif p_kind = 'email' then
    v := lower(v);
    v_local := split_part(split_part(v, '@', 1), '+', 1);
    v_domain := split_part(v, '@', 2);
    if v_domain in ('gmail.com', 'googlemail.com') then
      v_local := replace(v_local, '.', '');
      v_domain := 'gmail.com';
    end if;
    if v_local = '' or v_domain = '' then
      return null;
    end if;
    v := v_local || '@' || v_domain;
  elsif p_kind = 'device' then
    if char_length(v) < 8 then
      return null;
    end if;
  else
    v := upper(regexp_replace(v, '[^0-9A-Za-z]', '', 'g'));
    if char_length(v) < 4 then
      return null;
    end if;
  end if;
  return v;
end;
$$;

create or replace function private.identity_hash(p_kind text, p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to('rydar:' || p_kind || ':' || x.n, 'UTF8')), 'hex')
  from (select private.identity_normalize(p_kind, p_value) as n) x
  where x.n is not null;
$$;

create or replace function private.identity_hint(p_kind text, p_value text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := private.identity_normalize(p_kind, p_value);
  n integer;
begin
  if v is null then
    return null;
  end if;
  n := char_length(v);
  if p_kind = 'email' then
    return left(v, 1) || '•••@' || split_part(v, '@', 2);
  elsif p_kind = 'device' then
    return 'appareil ' || left(v, 4) || '…';
  elsif n <= 4 then
    return repeat('•', n);
  end if;
  return left(v, 3) || repeat('•', least(n - 5, 6)) || right(v, 2);
end;
$$;

create or replace function private.identity_kind_label(p_kind text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_kind
    when 'phone' then 'téléphone'
    when 'email' then 'e-mail'
    when 'vtc_card' then 'carte VTC'
    when 'driving_license' then 'permis de conduire'
    when 'identity_doc' then 'pièce d''identité'
    when 'plate' then 'plaque d''immatriculation'
    when 'device' then 'appareil'
    else coalesce(p_kind, '?')
  end;
$$;

-- Bannissement actif pour cette identité : 'platform' (prioritaire), 'org' ou null
create or replace function private.identity_ban_scope(p_org uuid, p_kind text, p_value text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select b.scope
  from public.banned_identities b
  where b.lifted_at is null
    and b.kind = p_kind
    and b.value_hash = private.identity_hash(p_kind, p_value)
    and (b.scope = 'platform' or b.organization_id = p_org)
  order by (b.scope = 'platform') desc
  limit 1;
$$;

-- Toutes les identités connues d'un chauffeur (fiche, compte, documents, appareils ; plaque en option)
create or replace function private.driver_identities(p_driver_id uuid, p_include_vehicle boolean default false)
returns table (kind text, value_hash text, hint text)
language sql
stable
security definer
set search_path = ''
as $$
  with raw (kind, value) as (
    select 'phone'::text, d.phone from public.drivers d where d.id = p_driver_id
    union all
    select 'email'::text, d.email from public.drivers d where d.id = p_driver_id
    union all
    select 'email'::text, u.email from public.drivers d join public.users u on u.id = d.user_id where d.id = p_driver_id
    union all
    select 'vtc_card'::text, d.vtc_card_number from public.drivers d where d.id = p_driver_id
    union all
    select case x.type when 'identity' then 'identity_doc' else x.type::text end, x.number
    from public.driver_documents x
    where x.driver_id = p_driver_id and x.type in ('vtc_card', 'driving_license', 'identity')
    union all
    select 'device'::text, dv.installation_id from public.driver_devices dv where dv.driver_id = p_driver_id
    union all
    select 'plate'::text, v.plate
    from public.drivers d join public.vehicles v on v.id = d.vehicle_id
    where d.id = p_driver_id and coalesce(p_include_vehicle, false)
  ),
  hashed as (
    select r.kind, private.identity_hash(r.kind, r.value) as value_hash, private.identity_hint(r.kind, r.value) as hint
    from raw r
  )
  select distinct on (h.kind, h.value_hash) h.kind, h.value_hash, h.hint
  from hashed h
  where h.value_hash is not null
  order by h.kind, h.value_hash;
$$;

-- Garde en base : une identité bannie ne revient pas (création par la centrale, inscription
-- par lien, réactivation, changement de téléphone / e-mail / carte VTC / plaque / document).
create or replace function private.enforce_identity_bans()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_value text;
  v_scope text;
begin
  if current_setting('rydar.bypass_ride_rules', true) = 'on' and auth.role() is null then
    return new;
  end if;

  if tg_table_name = 'drivers' then
    if new.banned_at is not null and new.status in ('active', 'invited')
       and (tg_op = 'INSERT' or new.status is distinct from old.status or old.banned_at is null) then
      raise exception 'DRIVER_BANNED: chauffeur banni — levez d''abord le bannissement' using errcode = '42501';
    end if;
    if tg_op = 'INSERT'
       or new.phone is distinct from old.phone
       or new.email is distinct from old.email
       or new.vtc_card_number is distinct from old.vtc_card_number
       or (new.status in ('active', 'invited') and old.status not in ('active', 'invited')) then
      foreach v_kind in array array['phone', 'email', 'vtc_card'] loop
        v_value := case v_kind when 'phone' then new.phone when 'email' then new.email else new.vtc_card_number end;
        v_scope := private.identity_ban_scope(new.organization_id, v_kind, v_value);
        if v_scope is not null then
          raise exception 'IDENTITY_BANNED: identité bannie (%)%', private.identity_kind_label(v_kind),
            case when v_scope = 'platform' then ' — plateforme Rydar' else ' — cette centrale' end
            using errcode = '42501';
        end if;
      end loop;
    end if;

  elsif tg_table_name = 'vehicles' then
    if tg_op = 'INSERT' or new.plate is distinct from old.plate then
      v_scope := private.identity_ban_scope(new.organization_id, 'plate', new.plate);
      if v_scope is not null then
        raise exception 'IDENTITY_BANNED: identité bannie (plaque d''immatriculation)%',
          case when v_scope = 'platform' then ' — plateforme Rydar' else ' — cette centrale' end
          using errcode = '42501';
      end if;
    end if;

  elsif tg_table_name = 'driver_documents' then
    if new.type in ('vtc_card', 'driving_license', 'identity')
       and (tg_op = 'INSERT' or new.number is distinct from old.number or new.type is distinct from old.type) then
      v_kind := case new.type when 'identity' then 'identity_doc' else new.type::text end;
      v_scope := private.identity_ban_scope(new.organization_id, v_kind, new.number);
      if v_scope is not null then
        raise exception 'IDENTITY_BANNED: identité bannie (%)%', private.identity_kind_label(v_kind),
          case when v_scope = 'platform' then ' — plateforme Rydar' else ' — cette centrale' end
          using errcode = '42501';
      end if;
    end if;
  end if;

  return new;
end;
$$;

create trigger drivers_identity_bans
  before insert or update of phone, email, vtc_card_number, status, banned_at on public.drivers
  for each row execute function private.enforce_identity_bans();
create trigger vehicles_identity_bans
  before insert or update of plate on public.vehicles
  for each row execute function private.enforce_identity_bans();
create trigger driver_documents_identity_bans
  before insert or update of type, number on public.driver_documents
  for each row execute function private.enforce_identity_bans();

-- Appareil déjà utilisé par un compte banni : le nouveau compte est suspendu (vérification
-- par la centrale : un téléphone peut être partagé) et la centrale est alertée.
create or replace function private.flag_banned_device()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_scope text;
begin
  v_scope := private.identity_ban_scope(new.organization_id, 'device', new.installation_id);
  if v_scope is null then
    return null;
  end if;
  select * into d from public.drivers where id = new.driver_id for update;
  if not found or d.banned_at is not null then
    return null;
  end if;

  if d.status = 'active' and d.current_ride_id is null then
    update public.drivers
       set status = 'suspended', presence = 'offline', online_since = null,
           suspended_reason = 'Appareil déjà utilisé par un compte banni — vérification requise'
     where id = d.id;
    update public.ride_offers
       set status = 'closed', closed_reason = 'driver_suspended', responded_at = now()
     where driver_id = d.id and status = 'pending';
  end if;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (d.organization_id, 'system', null, 'driver.banned_device', 'drivers', d.id::text, 'critical',
    jsonb_build_object('device_id', new.id, 'scope', v_scope, 'platform', new.platform, 'device_name', new.device_name,
      'suspended', d.status = 'active' and d.current_ride_id is null));
  perform realtime.send(
    jsonb_build_object('driver_id', d.id, 'number', d.number, 'first_name', d.first_name, 'last_name', d.last_name,
      'reason', 'banned_device'),
    'driver.flagged', 'org:' || d.organization_id::text, true);
  return null;
end;
$$;

create trigger driver_devices_banned_check
  after insert on public.driver_devices
  for each row execute function private.flag_banned_device();

-- -----------------------------------------------------------------------------
-- Répartition du prix : part chauffeur / commission centrale / frais plateforme
-- -----------------------------------------------------------------------------
-- Frais plateforme = % + fixe (super admin), plafonnés au prix. Commission = saisie (p_commission)
-- ou % + fixe des réglages, plafonnée à ce qui reste ; COMMISSION_TOO_HIGH si la saisie dépasse.
create or replace function private.compute_ride_split(
  p_org uuid,
  p_price integer,
  p_commission integer default null,
  out commission_cents integer,
  out platform_fee_cents integer,
  out driver_payout_cents integer,
  out error text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_fee_pct numeric;
  v_fee_fixed integer;
  v_pct numeric;
  v_fixed integer;
begin
  if p_price is null then
    error := 'PRICE_REQUIRED';
    return;
  end if;
  select o.platform_fee_percent, o.platform_fee_fixed_cents, s.driver_commission_percent, s.driver_commission_fixed_cents
    into v_fee_pct, v_fee_fixed, v_pct, v_fixed
  from public.organizations o
  left join public.organization_settings s on s.organization_id = o.id
  where o.id = p_org;

  platform_fee_cents := least(p_price, round(p_price * coalesce(v_fee_pct, 0) / 100)::integer + coalesce(v_fee_fixed, 0));
  if p_commission is not null then
    if p_commission < 0 or p_commission + platform_fee_cents > p_price then
      error := 'COMMISSION_TOO_HIGH';
      return;
    end if;
    commission_cents := p_commission;
  else
    commission_cents := least(p_price - platform_fee_cents,
      round(p_price * coalesce(v_pct, 0) / 100)::integer + coalesce(v_fixed, 0));
  end if;
  driver_payout_cents := p_price - commission_cents - platform_fee_cents;
end;
$$;

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
      select x.status into v_settlement from public.ride_settlements x where x.ride_id = new.id;
      if v_settlement is not null and v_settlement <> 'due' then
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

-- Nommé après rides_before_insert (ordre alphabétique) : source / tenant déjà imposés
create trigger rides_centrale_split
  before insert or update of price_cents, commission_cents, payment_method on public.rides
  for each row execute function private.rides_centrale_split();

-- -----------------------------------------------------------------------------
-- Règlements : sérialisation, diffusion, création à la fin de la course
-- -----------------------------------------------------------------------------
create or replace function private.settlement_direction(p_method public.payment_method)
returns text
language sql
immutable
set search_path = ''
as $$
  -- Espèces / carte à bord : le chauffeur a encaissé → il doit la commission.
  -- En ligne / facture / compte : la centrale a encaissé → elle doit la part chauffeur.
  select case when p_method in ('cash', 'card') then 'driver_owes' else 'centrale_owes' end;
$$;

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
    'blocking', x.direction = 'driver_owes' and (x.status = 'disputed' or (x.status = 'due' and x.due_at <= now())),
    'due_at', x.due_at,
    'declared_at', x.declared_at,
    'declared_method', x.declared_method,
    'declared_note', x.declared_note,
    'settled_at', x.settled_at,
    'settled_method', x.settled_method,
    'note', x.note,
    'reminders_sent', x.reminders_sent,
    'last_reminded_at', x.last_reminded_at,
    'created_at', x.created_at,
    'updated_at', x.updated_at
  );
$$;

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
end;
$$;

-- Lien de paiement : {montant} (19.00), {montant_centimes} (1900), {reference} (C1783)
create or replace function private.settlement_payment_link(p_template text, p_amount integer, p_reference text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_template is null or coalesce(p_amount, 0) <= 0 then null
    else replace(replace(replace(p_template,
           '{montant_centimes}', p_amount::text),
           '{montant}', to_char(p_amount / 100.0, 'FM999999990.00')),
           '{reference}', coalesce(p_reference, ''))
  end;
$$;

-- Passage « chauffeur confirmé » après N courses terminées et réglées, sans impayé en cours
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
    where x.driver_id = d.id and x.direction = 'driver_owes'
      and (x.status = 'disputed' or (x.status = 'due' and x.due_at <= now()))
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

-- Course terminée (mode centrale) : règlement créé, chauffeur et centrale prévenus.
-- Prix / commission / encaissement corrigés ensuite : règlement « à régler » recalculé.
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
    if x.status = 'due'
       and (new.price_cents is distinct from old.price_cents
            or new.commission_cents is distinct from old.commission_cents
            or new.payment_method is distinct from old.payment_method) then
      update public.ride_settlements
         set direction = v_direction,
             amount_cents = v_amount,
             price_cents = new.price_cents,
             commission_cents = coalesce(v_split.commission_cents, 0),
             platform_fee_cents = coalesce(v_split.platform_fee_cents, 0),
             driver_payout_cents = coalesce(v_split.driver_payout_cents, 0),
             payment_method = new.payment_method,
             status = case when v_amount = 0 then 'waived' else 'due' end,
             note = case when v_amount = 0 then 'Montant nul après correction' else note end
       where id = x.id
      returning * into x;
      perform private.log_event(new.organization_id, new.id, 'settlement.updated',
        format('Règlement recalculé : %s %s', private.fmt_eur(v_amount),
          case when v_direction = 'driver_owes' then 'dus par le chauffeur' else 'à verser au chauffeur' end),
        'timeline', 'info',
        jsonb_build_object('settlement_id', x.id, 'amount_cents', v_amount, 'direction', v_direction), 'system', null);
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

create trigger rides_d_settlement
  after update of status, price_cents, commission_cents, payment_method on public.rides
  for each row
  when (new.status = 'COMPLETED')
  execute function private.sync_ride_settlement();

-- -----------------------------------------------------------------------------
-- Blocages (mode centrale) : qui reçoit / peut accepter des courses
-- -----------------------------------------------------------------------------
-- 'unpaid'       : commission contestée, ou « à régler » dont l'échéance est passée (si block_unpaid)
-- 'credit_limit' : encours (à régler + contesté) au-delà du plafond
-- 'new_driver'   : chauffeur non confirmé et course au-dessus du prix plafond
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
      where x.driver_id = p_driver and x.direction = 'driver_owes'
        and (x.status = 'disputed' or (x.status = 'due' and x.due_at <= now()))
    ) then 'unpaid'
    when p_credit_limit is not null and (
      select coalesce(sum(x.amount_cents), 0) from public.ride_settlements x
      where x.driver_id = p_driver and x.direction = 'driver_owes' and x.status in ('due', 'disputed')
    ) > p_credit_limit then 'credit_limit'
    when p_trust = 'new' and p_new_max is not null and coalesce(p_price, 0) > p_new_max then 'new_driver'
  end;
$$;

-- Même règle, réglages lus pour le chauffeur (null hors mode centrale)
create or replace function private.driver_blocker(p_driver uuid, p_price integer default null)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when o.dispatch_model = 'centrale' then
           private.centrale_blocker(d.id, d.trust_level, p_price, s.block_unpaid, s.settlement_credit_limit_cents,
             s.new_driver_max_price_cents)
         end
  from public.drivers d
  join public.organizations o on o.id = d.organization_id
  left join public.organization_settings s on s.organization_id = d.organization_id
  where d.id = p_driver;
$$;

create or replace function private.blocker_message(p_reason text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_reason
    when 'unpaid' then 'Commission en retard : réglez-la pour recevoir de nouvelles courses.'
    when 'credit_limit' then 'Plafond de commissions à régler atteint : réglez-les pour recevoir de nouvelles courses.'
    when 'new_driver' then 'Course réservée aux chauffeurs confirmés de la centrale.'
  end;
$$;

-- -----------------------------------------------------------------------------
-- Dispatch : blocages + « Vous gagnez … » dans la notification (mode centrale)
-- Dernières définitions : run_geo_wave / offer_to_fleet / accept_ride_offer 20260924002200.
-- -----------------------------------------------------------------------------
create or replace function private.run_geo_wave(p_ride_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  s public.organization_settings;
  v_radii integer[];
  v_n integer;
  v_wave integer;
  v_radius integer;
  v_online integer;
  v_eligible integer;
  v_blocked integer := 0;
  v_count integer := 0;
  v_pending integer := 0;
  v_drivers uuid[] := '{}';
  v_timeout interval;
  v_max_age interval;
  v_max_accuracy constant real := 1500;
  v_from text;
  v_to text;
  v_centrale boolean;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.status not in ('SEARCHING_DRIVER', 'OFFERED') or r.driver_id is not null then
    return 0;
  end if;

  select * into s from public.organization_settings where organization_id = r.organization_id;
  select coalesce(o.dispatch_model = 'centrale', false) into v_centrale from public.organizations o where o.id = r.organization_id;
  v_radii := coalesce(s.dispatch_radii_m, '{4000,8000,12000,16000}');
  v_n := greatest(1, coalesce(cardinality(v_radii), 1));
  v_timeout := make_interval(secs => coalesce(s.offer_timeout_seconds, 30));
  v_max_age := make_interval(secs => coalesce(s.location_max_age_seconds, 180));
  v_from := coalesce(private.short_address(r.pickup_address), r.pickup_address);
  v_to := coalesce(private.short_address(r.dropoff_address), r.dropoff_address);
  v_wave := r.dispatch_wave;

  select count(*) into v_online
  from public.drivers d
  join public.driver_locations l on l.driver_id = d.id
  where d.organization_id = r.organization_id
    and d.status = 'active'
    and d.presence <> 'offline'
    and l.updated_at > now() - v_max_age;

  -- Journalisé une fois par recherche (pas à chaque relance après la dernière vague)
  if v_wave < v_n then
    perform private.log_event(r.organization_id, r.id, 'dispatch.online',
      format('%s %s en ligne', v_online, private.pl(v_online, 'chauffeur', 'chauffeurs')),
      'timeline', 'info', jsonb_build_object('online', v_online), 'system', null);
  end if;

  loop
    v_wave := v_wave + 1;
    v_radius := v_radii[least(v_wave, v_n)];

    if v_wave <= v_n then
      perform private.log_event(r.organization_id, r.id, 'dispatch.search',
        format('Recherche GPS — rayon %s (vague %s)', private.fmt_km(v_radius), v_wave),
        'timeline', 'info', jsonb_build_object('wave', v_wave, 'radius_m', v_radius), 'system', null);

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
        and l.updated_at > now() - v_max_age
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
          'passengers', r.passengers, 'upgrade', s.allow_category_upgrade, 'max_location_age_s', s.location_max_age_seconds),
        'system', null);
    end if;

    with candidates as (
      select d.id as driver_id,
             round(extensions.st_distance(l.location, r.pickup_location))::integer as distance_m
      from public.drivers d
      join public.driver_locations l on l.driver_id = d.id
      left join public.vehicles v on v.id = d.vehicle_id
      where d.organization_id = r.organization_id
        and d.status = 'active'
        and d.presence = 'available'
        and l.updated_at > now() - v_max_age
        and coalesce(l.accuracy_m, 0) <= v_max_accuracy
        and extensions.st_dwithin(l.location, r.pickup_location, v_radius)
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
              -- déjà sollicité pendant CETTE recherche (hors offre expirée : ex. repassé en ligne),
              -- ou offre laissée sans réponse (ignorée) pendant cette recherche
              or (o.sent_at >= r.dispatch_started_at and (o.status <> 'expired' or o.closed_reason = 'ignored'))
            )
        )
      order by distance_m
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
      select r.organization_id, i.driver_id, r.id, i.id, 'ride_offer', 'NOUVELLE COURSE',
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
      returning 1
    )
    select count(*)::integer, coalesce(array_agg(i.driver_id), '{}') into v_count, v_drivers from ins i;

    select count(*) into v_pending from public.ride_offers o where o.ride_id = r.id and o.status = 'pending' and o.mode = 'geo';

    if v_wave <= v_n or v_count > 0 then
      perform private.log_event(r.organization_id, r.id, 'dispatch.candidates',
        case when v_pending > v_count
             then format('%s %s à moins de %s, dont %s %s', v_pending,
                    private.pl(v_pending, 'chauffeur sollicité', 'chauffeurs sollicités'), private.fmt_km(v_radius),
                    v_count, private.pl(v_count, 'nouveau', 'nouveaux'))
             else format('%s %s à moins de %s', v_count, private.pl(v_count, 'chauffeur', 'chauffeurs'), private.fmt_km(v_radius))
        end,
        'timeline', case when v_count > 0 or v_pending > 0 then 'info' else 'warning' end::public.event_level,
        jsonb_build_object('candidates', v_count, 'pending', v_pending, 'radius_m', v_radius, 'wave', v_wave, 'driver_ids', to_jsonb(v_drivers)),
        'system', null);
    end if;

    exit when v_count > 0 or v_wave >= v_n;
  end loop;

  if v_count > 0 then
    update public.drivers
       set presence = 'offered'
     where id in (
       select x.id from public.drivers x
       where x.id = any (v_drivers) and x.presence = 'available'
       order by x.id
       for update
     );

    perform private.log_event(r.organization_id, r.id, 'dispatch.notified',
      format('%s %s', v_count, private.pl(v_count, 'notification envoyée', 'notifications envoyées')),
      'timeline', 'success', jsonb_build_object('count', v_count, 'expires_in_s', s.offer_timeout_seconds), 'system', null);
    perform pg_notify('rydar_notifications', r.id::text);
  elsif v_pending = 0 and v_wave <= v_n then
    perform private.log_event(r.organization_id, r.id, 'dispatch.retry',
      format('Aucun chauffeur disponible dans un rayon de %s — nouvelle recherche dans %s s', private.fmt_km(v_radius), s.offer_timeout_seconds),
      'timeline', 'warning', jsonb_build_object('radius_m', v_radius), 'system', null);
  end if;

  update public.rides
     set dispatch_wave = v_wave,
         dispatch_radius_m = v_radius,
         status = case when v_pending > 0 then 'OFFERED' else 'SEARCHING_DRIVER' end::public.ride_status,
         offered_at = case when v_pending > 0 then coalesce(offered_at, now()) else offered_at end,
         next_dispatch_at = now() + v_timeout
   where id = r.id;

  return v_count;
end;
$$;

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

  update public.rides
     set status = case when v_pending > 0 then 'OFFERED' else 'SEARCHING_DRIVER' end::public.ride_status,
         offered_at = case when v_pending > 0 then coalesce(offered_at, now()) else offered_at end,
         dispatch_wave = 1,
         -- nouveau passage dans 5 min (nouveaux chauffeurs), au plus tard à T-lead (bascule GPS)
         next_dispatch_at = least(v_expires, now() + interval '5 minutes')
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
    if o.status = 'pending' then
      update public.ride_offers
         set status = 'closed', closed_reason = 'already_assigned', responded_at = now()
       where id = o.id;
      perform private.release_offered_drivers(array[v_driver.id]);
    end if;
    perform private.log_event(r.organization_id, r.id, 'offer.rejected_late',
      format('%s (#%s) a tenté d''accepter — course déjà attribuée', v_driver.first_name, v_driver.number),
      'dispatch', 'warning', jsonb_build_object('driver_id', v_driver.id, 'offer_id', o.id, 'latency_ms', v_latency),
      'driver', v_driver.id);
    return jsonb_build_object('ok', false, 'code', 'RIDE_ALREADY_ASSIGNED', 'message', 'Course déjà attribuée.');
  end if;

  if o.status in ('declined', 'closed', 'accepted') then
    return jsonb_build_object('ok', false, 'code', 'OFFER_CLOSED', 'message', 'Cette offre n''est plus disponible.');
  end if;
  -- Offre retirée (chauffeur passé hors ligne, relance, fin de fenêtre) ou périmée
  if o.status = 'expired' or (o.status = 'pending' and o.expires_at < now() - interval '3 seconds') then
    return jsonb_build_object('ok', false, 'code', 'OFFER_EXPIRED', 'message', 'Cette offre a expiré.');
  end if;

  -- Mode centrale : commission en retard / contestée, plafond d'encours, plafond « nouveau chauffeur ».
  -- L'offre reste ouverte : le chauffeur peut régler (ou signaler son paiement) puis accepter.
  v_block := private.driver_blocker(v_driver.id, r.price_cents);
  if v_block is not null then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_BLOCKED', 'reason', v_block,
      'message', private.blocker_message(v_block));
  end if;

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

  perform private.log_event(r.organization_id, r.id, 'offer.accepted', format('%s accepte', v_driver.first_name),
    'timeline', 'success',
    jsonb_build_object('driver_id', v_driver.id, 'driver_number', v_driver.number, 'offer_id', o.id,
      'distance_m', o.distance_m, 'response_ms', v_latency),
    'driver', v_driver.id);
  perform private.log_event(r.organization_id, r.id, 'ride.locked', 'Course verrouillée',
    'timeline', 'info', jsonb_build_object('mechanism', 'row_lock+compare_and_set'), 'system', null);
  perform private.log_event(r.organization_id, r.id, 'dispatch.assigned',
    format('Assignment lock acquired — ride assigned to driver #%s', v_driver.number),
    'dispatch', 'debug', jsonb_build_object('driver_id', v_driver.id), 'system', null);

  v_closed := private.close_pending_offers(r.id, 'closed', 'assigned_to_other', o.id);
  if cardinality(v_closed) > 0 then
    perform private.log_event(r.organization_id, r.id, 'offers.closed',
      format('%s %s', cardinality(v_closed), private.pl(cardinality(v_closed), 'autre offre fermée', 'autres offres fermées')),
      'timeline', 'info', jsonb_build_object('count', cardinality(v_closed), 'driver_ids', to_jsonb(v_closed)), 'system', null);
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

-- ----------------------------------------------------------------- offres chauffeur
-- Dernière définition : 20260924002100. Ajout : répartition (part chauffeur, commission, frais),
-- encaissement par le chauffeur, blocage éventuel (mode centrale).
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
    'blocked', case when g.dispatch_model = 'centrale' then private.driver_blocker(o.driver_id, r.price_cents) end
  ) order by r.type, o.sent_at desc), '[]'::jsonb)
  from public.ride_offers o
  join public.rides r on r.id = o.ride_id
  join public.organizations g on g.id = r.organization_id
  where o.driver_id = private.current_driver_id()
    and o.status = 'pending'
    and r.driver_id is null
    and r.status in ('SEARCHING_DRIVER', 'OFFERED');
$$;

-- ----------------------------------------------------------------- accueil chauffeur
-- Dernière définition : 20260924000400. Ajouts : modèle, niveau de confiance, gains nets du jour,
-- encours de commissions et blocage (mode centrale).
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
        'net_cents', case when v_centrale then coalesce(sum(x.driver_payout_cents), 0) end)
      from public.rides x
      where x.driver_id = d.id and x.status = 'COMPLETED' and x.completed_at >= v_day_start
    ),
    'next_scheduled', (
      select jsonb_build_object('id', x.id, 'number', x.number, 'pickup_at', x.pickup_at,
        'pickup_address', x.pickup_address, 'dropoff_address', x.dropoff_address, 'price_cents', x.price_cents,
        'driver_payout_cents', x.driver_payout_cents)
      from public.rides x
      where x.driver_id = d.id and x.status = 'ACCEPTED' and x.type = 'scheduled'
      order by x.pickup_at
      limit 1
    ),
    'pending_offers', (
      select count(*) from public.ride_offers x where x.driver_id = d.id and x.status = 'pending'
    ),
    'settlement', v_settlement
  );
end;
$$;

-- ----------------------------------------------------------------- gains du chauffeur
-- Dernière définition : 20260924002400. En mode centrale, le net d'une course est sa part
-- chauffeur réelle (driver_payout_cents) ; statut du règlement sur les dernières courses.
create or replace function private.ride_net_cents(p_price integer, p_payout integer, p_rate numeric)
returns integer
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_payout,
    case when p_rate is not null and p_price is not null then round(p_price * (100 - p_rate) / 100)::integer end);
$$;

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
           private.ride_net_cents(r.price_cents, r.driver_payout_cents, v_rate) as net_cents
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
      'pickup', coalesce(private.short_address(x.pickup_address), x.pickup_address),
      'dropoff', coalesce(private.short_address(x.dropoff_address), x.dropoff_address),
      'completed_at', x.done_at,
      'price_cents', x.price_cents,
      'net_cents', private.ride_net_cents(x.price_cents, x.driver_payout_cents, v_rate),
      'commission_cents', x.commission_cents,
      'platform_fee_cents', x.platform_fee_cents,
      'settlement_status', x.settlement_status,
      'settlement_direction', x.settlement_direction,
      'currency', x.currency,
      'payment_method', x.payment_method,
      'vehicle_category', x.vehicle_category,
      'distance_m', x.estimated_distance_m,
      'duration_s', x.estimated_duration_s) order by x.done_at desc, x.number desc), '[]'::jsonb)
    into v_recent
  from (
    select r.id, r.number, r.pickup_address, r.dropoff_address, r.price_cents, r.currency, r.payment_method,
           r.vehicle_category, r.estimated_distance_m, r.estimated_duration_s, r.driver_payout_cents,
           r.commission_cents, r.platform_fee_cents,
           st.status as settlement_status, st.direction as settlement_direction,
           coalesce(r.completed_at, r.pickup_at) as done_at
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
                        then coalesce(sum(private.ride_net_cents(r.price_cents, r.driver_payout_cents, v_rate)), 0) end)
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

-- -----------------------------------------------------------------------------
-- Règlements — application chauffeur
-- -----------------------------------------------------------------------------
create or replace function private.settlement_method_label(p_method text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_method
    when 'link' then 'lien de paiement'
    when 'cash' then 'espèces'
    when 'transfer' then 'virement'
    else 'autre moyen'
  end;
$$;

-- Commissions à régler / gains à recevoir + de quoi payer (lien prérempli, moyens acceptés)
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
  v_methods := array(
    select m from unnest(coalesce(s.settlement_methods, '{cash}'::text[])) as m
    where m <> 'link' or s.settlement_link is not null
  );
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
      'instructions', s.settlement_instructions),
    'blocked', v_block,
    'blocked_message', private.blocker_message(v_block),
    'items', v_items
  );
end;
$$;

-- « J'ai payé » : commissions signalées réglées (à confirmer par la centrale). Ne bloque plus les offres.
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

  if p_method is null or not (p_method = any (coalesce(s.settlement_methods, '{}'::text[])))
     or (p_method = 'link' and s.settlement_link is null) then
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

-- -----------------------------------------------------------------------------
-- Règlements — tableau de bord de la centrale
-- -----------------------------------------------------------------------------
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
  where x.organization_id = p_org;

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
    and r.driver_payout_cents is not null;

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

-- Liste filtrée : open | declared | overdue | disputed | to_pay | paid | waived | all
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

-- « Reçu » (commission encaissée) / « Versé » (part chauffeur payée) — plusieurs à la fois
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
    returning y.id, y.amount_cents
  )
  select coalesce(array_agg(u.id), '{}'), coalesce(sum(u.amount_cents), 0) into v_ids, v_total from upd u;
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
    'message', format('%s %s', cardinality(v_ids), private.pl(cardinality(v_ids), 'règlement confirmé', 'règlements confirmés')));
end;
$$;

-- « Pas reçu » : le chauffeur est bloqué jusqu'à un nouveau règlement
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
begin
  select * into x from public.ride_settlements where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Règlement introuvable.');
  end if;
  perform private.assert_org_member(x.organization_id, array['owner', 'admin', 'dispatcher']::public.org_role[]);
  perform private.set_actor('user', auth.uid());
  if x.direction <> 'driver_owes' or x.status not in ('due', 'declared') then
    return jsonb_build_object('ok', false, 'code', 'NOT_DISPUTABLE',
      'message', 'Seule une commission à régler ou signalée payée peut être contestée.');
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'message', 'Précisez ce qui ne va pas.');
  end if;

  update public.ride_settlements set status = 'disputed', note = v_reason where id = x.id returning * into x;
  select r.number into v_number from public.rides r where r.id = x.ride_id;

  perform private.log_event(x.organization_id, x.ride_id, 'settlement.disputed',
    format('Paiement de %s contesté par la centrale : %s', private.fmt_eur(x.amount_cents), v_reason),
    'timeline', 'warning', jsonb_build_object('settlement_id', x.id, 'reason', v_reason), 'user', auth.uid());
  perform private.broadcast_settlement(x, 'disputed');
  if x.driver_id is not null then
    perform private.queue_notification(x.organization_id, x.driver_id, x.ride_id, null, 'settlement_disputed', 'PAIEMENT NON REÇU',
      format('Course #%s · %s non reçus par la centrale : %s', v_number, private.fmt_eur(x.amount_cents), v_reason),
      jsonb_build_object('type', 'settlement_disputed', 'settlement_id', x.id, 'amount_cents', x.amount_cents), 'high', null);
  end if;
  return jsonb_build_object('ok', true, 'code', 'DISPUTED', 'message', 'Paiement contesté : le chauffeur est prévenu.');
end;
$$;

-- Annuler une dette (geste commercial, course litigieuse…) — owner / admin
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
  end if;
  return jsonb_build_object('ok', true, 'code', 'WAIVED', 'message', 'Règlement annulé.');
end;
$$;

-- Erreur de saisie : un règlement confirmé / annulé redevient « à régler » — owner / admin
create or replace function public.reopen_settlement(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  x public.ride_settlements;
  v_number bigint;
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
  end if;
  return jsonb_build_object('ok', true, 'code', 'REOPENED', 'message', 'Règlement rouvert.');
end;
$$;

-- Relance manuelle (push) — au plus une toutes les 30 min par chauffeur
create or replace function public.remind_driver_settlements(p_driver_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_total integer;
  v_n integer;
  v_ids uuid[];
  v_last timestamptz;
  v_name text;
begin
  select * into d from public.drivers where id = p_driver_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Chauffeur introuvable.');
  end if;
  perform private.assert_org_member(d.organization_id);
  perform private.set_actor('user', auth.uid());

  select coalesce(sum(x.amount_cents), 0), count(*), coalesce(array_agg(x.id), '{}'), max(x.last_reminded_at)
    into v_total, v_n, v_ids, v_last
  from public.ride_settlements x
  where x.driver_id = d.id and x.direction = 'driver_owes' and x.status in ('due', 'disputed');
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'code', 'NOTHING_DUE', 'message', 'Aucune commission à régler pour ce chauffeur.');
  end if;
  if v_last > now() - interval '30 minutes' then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED', 'message', 'Rappel déjà envoyé il y a moins de 30 minutes.');
  end if;

  select o.name into v_name from public.organizations o where o.id = d.organization_id;
  perform private.queue_notification(d.organization_id, d.id, null, null, 'settlement_reminder', 'RAPPEL COMMISSION',
    format('%s à régler à %s (%s %s)', private.fmt_eur(v_total), v_name, v_n, private.pl(v_n, 'course', 'courses')),
    jsonb_build_object('type', 'settlement_reminder', 'amount_cents', v_total, 'count', v_n), 'high', null);
  update public.ride_settlements
     set last_reminded_at = now(), reminders_sent = reminders_sent + 1
   where id = any (v_ids);
  perform private.log_event(d.organization_id, null, 'settlement.reminded',
    format('Rappel envoyé à %s %s (#%s) : %s à régler', d.first_name, d.last_name, d.number, private.fmt_eur(v_total)),
    'timeline', 'info', jsonb_build_object('driver_id', d.id, 'amount_cents', v_total, 'count', v_n), 'user', auth.uid());
  return jsonb_build_object('ok', true, 'code', 'REMINDED', 'amount_cents', v_total, 'count', v_n,
    'message', 'Rappel envoyé au chauffeur.');
end;
$$;

-- Aperçu de la répartition (formulaire « Nouvelle course »)
create or replace function public.preview_ride_split(p_org uuid, p_price integer, p_commission integer default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_model text;
  v_split record;
begin
  perform private.assert_org_member(p_org);
  select o.dispatch_model into v_model from public.organizations o where o.id = p_org;
  if v_model is distinct from 'centrale' then
    return jsonb_build_object('model', coalesce(v_model, 'fleet'));
  end if;
  select * into v_split from private.compute_ride_split(p_org, p_price, p_commission);
  return jsonb_build_object(
    'model', v_model,
    'price_cents', p_price,
    'commission_cents', v_split.commission_cents,
    'platform_fee_cents', v_split.platform_fee_cents,
    'driver_payout_cents', v_split.driver_payout_cents,
    'manual', p_commission is not null,
    'error', v_split.error);
end;
$$;

-- Worker : commissions en retard → un rappel par chauffeur toutes les ~24 h, 3 au plus.
-- Verrou consultatif : plusieurs workers ne relancent jamais deux fois le même chauffeur.
create or replace function private.settlement_reminders()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_count integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('rydar.settlement_reminders', 0)) then
    return jsonb_build_object('ok', false, 'code', 'BUSY', 'reminders', 0);
  end if;
  for v in
    select x.driver_id, x.organization_id, o.name as org_name,
           sum(x.amount_cents)::integer as total, count(*) as n, array_agg(x.id) as ids
    from public.ride_settlements x
    join public.organizations o on o.id = x.organization_id
    join public.drivers d on d.id = x.driver_id
    where x.direction = 'driver_owes'
      and x.status in ('due', 'disputed')
      and x.due_at <= now()
      and o.status = 'active'
      and o.dispatch_model = 'centrale'
      and d.status = 'active'
    group by x.driver_id, x.organization_id, o.name
    having min(x.reminders_sent) < 3
       and coalesce(max(x.last_reminded_at), '-infinity'::timestamptz) < now() - interval '23 hours'
  loop
    perform private.queue_notification(v.organization_id, v.driver_id, null, null, 'settlement_reminder', 'COMMISSION EN RETARD',
      format('%s à régler à %s — réglez-les pour continuer à recevoir des courses', private.fmt_eur(v.total), v.org_name),
      jsonb_build_object('type', 'settlement_reminder', 'amount_cents', v.total, 'count', v.n), 'high', null);
    update public.ride_settlements
       set reminders_sent = reminders_sent + 1, last_reminded_at = now()
     where id = any (v.ids);
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('ok', true, 'reminders', v_count);
end;
$$;

-- -----------------------------------------------------------------------------
-- Bannissement définitif (centrale) + signalement plateforme
-- -----------------------------------------------------------------------------
create or replace function public.ban_driver(
  p_driver_id uuid,
  p_reason text,
  p_category text default 'fraud',
  p_report_to_platform boolean default false,
  p_ban_vehicle boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
  v_category text := coalesce(nullif(p_category, ''), 'fraud');
  v_ride record;
  v_res jsonb;
  v_reassigned integer := 0;
  v_count integer;
  v_report uuid;
begin
  select * into d from public.drivers where id = p_driver_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_FOUND', 'message', 'Chauffeur introuvable.');
  end if;
  perform private.assert_org_member(d.organization_id, array['owner', 'admin']::public.org_role[]);
  perform private.set_actor('user', auth.uid());

  if v_reason is null or char_length(v_reason) < 3 then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'message', 'Indiquez le motif du bannissement.');
  end if;
  if v_category not in ('unpaid', 'fraud', 'behavior', 'documents', 'other') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CATEGORY', 'message', 'Motif invalide.');
  end if;
  if d.banned_at is not null then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_BANNED', 'message', 'Ce chauffeur est déjà banni.');
  end if;
  if exists (select 1 from public.rides r where r.driver_id = d.id and r.status in ('PASSENGER_ONBOARD', 'IN_PROGRESS')) then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_ON_RIDE',
      'message', 'Client à bord : attendez la fin de la course (ou annulez-la) avant de bannir ce chauffeur.');
  end if;

  -- Courses attribuées pas encore commencées : remises en recherche
  for v_ride in
    select r.id from public.rides r
    where r.driver_id = d.id and r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED')
    order by r.pickup_at
  loop
    v_res := public.reassign_ride(v_ride.id, 'Chauffeur banni', d.id);
    if coalesce((v_res ->> 'ok')::boolean, false) then
      v_reassigned := v_reassigned + 1;
    end if;
  end loop;

  update public.ride_offers
     set status = 'closed', closed_reason = 'driver_banned', responded_at = now()
   where driver_id = d.id and status = 'pending';

  -- Identités refusées désormais dans cette centrale
  insert into public.banned_identities (scope, organization_id, kind, value_hash, hint, driver_id, reason, created_by)
  select 'org', d.organization_id, i.kind, i.value_hash, i.hint, d.id, v_reason, auth.uid()
  from private.driver_identities(d.id, p_ban_vehicle) i
  on conflict do nothing;
  get diagnostics v_count = row_count;

  -- Signalement au super admin (bannissement de toute la plateforme sur décision)
  if coalesce(p_report_to_platform, false) then
    insert into public.fraud_reports (organization_id, driver_id, driver_label, category, reason, identities, reported_by)
    values (d.organization_id, d.id, format('%s %s (#%s)', d.first_name, d.last_name, d.number), v_category, v_reason,
      (select coalesce(jsonb_agg(jsonb_build_object('kind', i.kind, 'hash', i.value_hash, 'hint', i.hint)), '[]'::jsonb)
       from private.driver_identities(d.id, p_ban_vehicle) i),
      auth.uid())
    returning id into v_report;
  end if;

  -- Compte coupé (sessions révoquées par drivers_revoke_sessions) ; « inactif » conservé pour un
  -- candidat (ne consomme pas de place dans l'offre)
  update public.drivers
     set status = case when status = 'inactive' then 'inactive' else 'suspended' end::public.driver_status,
         presence = 'offline',
         online_since = null,
         current_ride_id = null,
         banned_at = now(),
         banned_by = auth.uid(),
         ban_reason = v_reason,
         ban_scope = 'org',
         suspended_reason = 'Banni : ' || v_reason,
         application_status = case when application_status = 'pending' then 'rejected' else application_status end
   where id = d.id;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (d.organization_id, 'user', auth.uid(), 'driver.banned', 'drivers', d.id::text, 'critical',
    jsonb_build_object('reason', v_reason, 'category', v_category, 'identities', v_count,
      'reassigned_rides', v_reassigned, 'report_id', v_report, 'vehicle', coalesce(p_ban_vehicle, false)));

  return jsonb_build_object('ok', true, 'code', 'BANNED',
    'message', 'Chauffeur banni : il ne peut plus accéder à l''application, même avec un nouveau compte.',
    'identities', v_count, 'reassigned_rides', v_reassigned, 'report_id', v_report, 'user_id', d.user_id);
end;
$$;

-- Levée d'un bannissement décidé par la centrale (le chauffeur reste suspendu : réactivation manuelle)
create or replace function public.lift_driver_ban(p_driver_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
  v_count integer;
begin
  select * into d from public.drivers where id = p_driver_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_FOUND', 'message', 'Chauffeur introuvable.');
  end if;
  perform private.assert_org_member(d.organization_id, array['owner', 'admin']::public.org_role[]);
  if d.banned_at is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_BANNED', 'message', 'Ce chauffeur n''est pas banni.');
  end if;
  if d.ban_scope = 'platform' then
    return jsonb_build_object('ok', false, 'code', 'PLATFORM_BAN',
      'message', 'Bannissement décidé par la plateforme Rydar : contactez le support.');
  end if;

  update public.banned_identities
     set lifted_at = now(), lifted_by = auth.uid(), lift_reason = v_reason
   where scope = 'org' and organization_id = d.organization_id and driver_id = d.id and lifted_at is null;
  get diagnostics v_count = row_count;

  update public.drivers
     set banned_at = null, banned_by = null, ban_reason = null, ban_scope = null,
         suspended_reason = 'Bannissement levé' || coalesce(' : ' || v_reason, '')
   where id = d.id;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (d.organization_id, 'user', auth.uid(), 'driver.ban_lifted', 'drivers', d.id::text, 'warning',
    jsonb_build_object('reason', v_reason, 'identities', v_count));
  return jsonb_build_object('ok', true, 'code', 'LIFTED', 'identities', v_count, 'user_id', d.user_id,
    'message', 'Bannissement levé : le chauffeur reste suspendu, réactivez-le si besoin.');
end;
$$;

-- Levée d'une identité précise (ex. plaque d'une voiture de location reprise par un autre chauffeur)
create or replace function public.lift_identity_ban(p_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.banned_identities;
begin
  select * into b from public.banned_identities where id = p_id for update;
  if not found or b.scope <> 'org' then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Bannissement introuvable.');
  end if;
  perform private.assert_org_member(b.organization_id, array['owner', 'admin']::public.org_role[]);
  if b.lifted_at is not null then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_LIFTED', 'message', 'Déjà levé.');
  end if;
  update public.banned_identities
     set lifted_at = now(), lifted_by = auth.uid(), lift_reason = left(nullif(btrim(coalesce(p_reason, '')), ''), 500)
   where id = b.id;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (b.organization_id, 'user', auth.uid(), 'identity_ban.lifted', 'banned_identities', b.id::text, 'warning',
    jsonb_build_object('kind', b.kind, 'hint', b.hint, 'reason', p_reason));
  return jsonb_build_object('ok', true, 'code', 'LIFTED', 'message', 'Identité débloquée.');
end;
$$;

-- -----------------------------------------------------------------------------
-- Super admin (service role : routes serveur + audit) — bannissement plateforme
-- -----------------------------------------------------------------------------
create or replace function public.svc_platform_ban(p_report_id uuid, p_actor uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.fraud_reports;
  x record;
  v_count integer;
  v_drivers integer := 0;
  v_users uuid[] := '{}';
  v_note text := left(nullif(btrim(coalesce(p_note, '')), ''), 500);
begin
  select * into f from public.fraud_reports where id = p_report_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Signalement introuvable.');
  end if;
  if f.status = 'platform_banned' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_BANNED', 'message', 'Déjà banni de la plateforme.');
  end if;
  perform private.set_actor('super_admin', p_actor);

  insert into public.banned_identities (scope, organization_id, kind, value_hash, hint, driver_id, report_id, reason, created_by)
  select 'platform', null, e ->> 'kind', e ->> 'hash', e ->> 'hint', f.driver_id, f.id, f.reason, p_actor
  from jsonb_array_elements(f.identities) e
  where e ->> 'kind' in ('phone', 'email', 'vtc_card', 'driving_license', 'identity_doc', 'plate', 'device')
    and e ->> 'hash' ~ '^[0-9a-f]{64}$'
  on conflict do nothing;
  get diagnostics v_count = row_count;

  update public.fraud_reports
     set status = 'platform_banned', reviewed_by = p_actor, reviewed_at = now(), review_note = v_note
   where id = f.id;

  -- Tous les comptes (toutes centrales) partageant une identité bannie, dont le chauffeur signalé
  for x in
    select d.id, d.user_id, d.organization_id
    from public.drivers d
    where (d.id = f.driver_id or exists (
             select 1
             from private.driver_identities(d.id, true) i
             join jsonb_array_elements(f.identities) e on e ->> 'kind' = i.kind and e ->> 'hash' = i.value_hash
           ))
      and (d.ban_scope is distinct from 'platform')
  loop
    update public.drivers
       set status = case when status = 'inactive' then 'inactive' else 'suspended' end::public.driver_status,
           presence = 'offline',
           online_since = null,
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
      v_users := v_users || x.user_id;
    end if;
    v_drivers := v_drivers + 1;
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
    values (x.organization_id, 'super_admin', p_actor, 'driver.platform_banned', 'drivers', x.id::text, 'critical',
      jsonb_build_object('report_id', f.id));
  end loop;

  return jsonb_build_object('ok', true, 'code', 'PLATFORM_BANNED', 'identities', v_count, 'drivers', v_drivers,
    'user_ids', to_jsonb(v_users), 'message', 'Banni de toute la plateforme.');
end;
$$;

create or replace function public.svc_platform_dismiss_report(p_report_id uuid, p_actor uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.fraud_reports;
begin
  select * into f from public.fraud_reports where id = p_report_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Signalement introuvable.');
  end if;
  if f.status <> 'open' then
    return jsonb_build_object('ok', false, 'code', 'NOT_OPEN', 'message', 'Signalement déjà traité.');
  end if;
  update public.fraud_reports
     set status = 'dismissed', reviewed_by = p_actor, reviewed_at = now(),
         review_note = left(nullif(btrim(coalesce(p_note, '')), ''), 500)
   where id = f.id;
  return jsonb_build_object('ok', true, 'code', 'DISMISSED', 'message', 'Signalement classé : bannissement limité à la centrale.');
end;
$$;

-- Levée d'un bannissement plateforme : le chauffeur signalé reste banni par sa centrale ; les
-- autres comptes touchés par ricochet sont débannis (toujours suspendus : leur centrale décide)
create or replace function public.svc_platform_unban(p_report_id uuid, p_actor uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.fraud_reports;
  x record;
  v_count integer;
  v_users uuid[] := '{}';
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
begin
  select * into f from public.fraud_reports where id = p_report_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Signalement introuvable.');
  end if;
  if f.status <> 'platform_banned' then
    return jsonb_build_object('ok', false, 'code', 'NOT_BANNED', 'message', 'Aucun bannissement plateforme actif.');
  end if;
  perform private.set_actor('super_admin', p_actor);

  update public.banned_identities
     set lifted_at = now(), lifted_by = p_actor, lift_reason = v_reason
   where scope = 'platform' and report_id = f.id and lifted_at is null;
  get diagnostics v_count = row_count;

  update public.fraud_reports
     set status = 'lifted', reviewed_by = p_actor, reviewed_at = now(), review_note = coalesce(v_reason, review_note)
   where id = f.id;

  for x in select d.id, d.user_id from public.drivers d where d.ban_report_id = f.id loop
    if x.id = f.driver_id and exists (
      select 1 from public.banned_identities b
      where b.scope = 'org' and b.driver_id = x.id and b.lifted_at is null
    ) then
      update public.drivers
         set ban_scope = 'org', ban_report_id = null, suspended_reason = 'Banni : ' || coalesce(ban_reason, '')
       where id = x.id;
    else
      update public.drivers
         set banned_at = null, banned_by = null, ban_reason = null, ban_scope = null, ban_report_id = null,
             suspended_reason = 'Bannissement plateforme levé'
       where id = x.id;
      if x.user_id is not null then
        v_users := v_users || x.user_id;
      end if;
    end if;
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
    select d.organization_id, 'super_admin', p_actor, 'driver.platform_unbanned', 'drivers', d.id::text, 'warning',
      jsonb_build_object('report_id', f.id, 'reason', v_reason)
    from public.drivers d where d.id = x.id;
  end loop;

  return jsonb_build_object('ok', true, 'code', 'LIFTED', 'identities', v_count, 'user_ids', to_jsonb(v_users),
    'message', 'Bannissement plateforme levé.');
end;
$$;

-- Vue d'ensemble des centrales (super admin)
create or replace function public.admin_centrale_overview(p_from timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from timestamptz := coalesce(p_from, date_trunc('month', now()));
  v_orgs jsonb;
begin
  if not private.is_super_admin() then
    raise exception 'FORBIDDEN: réservé au super admin' using errcode = '42501';
  end if;

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
                            and (x.status = 'disputed' or (x.status = 'due' and x.due_at <= now())))) as j
    from public.organizations o
    left join lateral (
      select count(*) as rides, sum(y.price_cents) as volume, sum(y.commission_cents) as commission,
             sum(y.platform_fee_cents) as fees
      from public.rides y
      where y.organization_id = o.id and y.status = 'COMPLETED' and y.completed_at >= v_from
        and y.driver_payout_cents is not null
    ) m on true
    where o.dispatch_model = 'centrale' and o.status <> 'archived'
  ) t;

  return jsonb_build_object(
    'from', v_from,
    'organizations', v_orgs,
    'totals', jsonb_build_object(
      'centrales', jsonb_array_length(v_orgs),
      'rides', (select coalesce(sum((e ->> 'rides')::bigint), 0) from jsonb_array_elements(v_orgs) e),
      'volume_cents', (select coalesce(sum((e ->> 'volume_cents')::bigint), 0) from jsonb_array_elements(v_orgs) e),
      'platform_fee_cents', (select coalesce(sum((e ->> 'platform_fee_cents')::bigint), 0) from jsonb_array_elements(v_orgs) e)),
    'reports_open', (select count(*) from public.fraud_reports f where f.status = 'open'),
    'platform_bans', (select count(*) from public.banned_identities b where b.scope = 'platform' and b.lifted_at is null)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Inscription par lien (/rejoindre/{code})
-- -----------------------------------------------------------------------------
create or replace function private.random_join_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
$$;

-- Activer / couper / régénérer le lien, validation automatique ou non — owner / admin
create or replace function public.set_join_link(
  p_org uuid,
  p_enabled boolean,
  p_regenerate boolean default false,
  p_auto_approve boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.organizations;
begin
  perform private.assert_org_member(p_org, array['owner', 'admin']::public.org_role[]);
  select * into o from public.organizations where id = p_org for update;
  if o.dispatch_model <> 'centrale' then
    return jsonb_build_object('ok', false, 'code', 'CENTRALE_ONLY',
      'message', 'Le lien d''inscription est réservé aux comptes en mode centrale.');
  end if;

  update public.organizations
     set join_code = case when join_code is null or coalesce(p_regenerate, false) then private.random_join_code() else join_code end,
         join_enabled = coalesce(p_enabled, join_enabled),
         join_auto_approve = coalesce(p_auto_approve, join_auto_approve)
   where id = p_org
  returning * into o;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, 'user', auth.uid(), 'organization.join_link', 'organizations', p_org::text, 'info',
    jsonb_build_object('enabled', o.join_enabled, 'regenerated', coalesce(p_regenerate, false), 'auto_approve', o.join_auto_approve));

  return jsonb_build_object('ok', true, 'code', 'UPDATED', 'join_code', o.join_code, 'join_enabled', o.join_enabled,
    'join_auto_approve', o.join_auto_approve);
end;
$$;

-- Page publique : centrale derrière un code (service role, route serveur)
create or replace function public.svc_join_info(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o public.organizations;
begin
  select * into o from public.organizations
  where join_code = lower(btrim(coalesce(p_code, '')))
    and join_enabled
    and status = 'active'
    and dispatch_model = 'centrale';
  if not found then
    return jsonb_build_object('ok', false, 'code', 'JOIN_LINK_INVALID', 'message', 'Lien d''inscription invalide ou désactivé.');
  end if;
  return jsonb_build_object('ok', true,
    'organization', jsonb_build_object('id', o.id, 'name', o.name, 'logo_url', o.logo_url, 'brand_color', o.brand_color,
      'city', o.city, 'phone', o.phone, 'email', o.email),
    'auto_approve', o.join_auto_approve);
end;
$$;

-- Contrôle avant création du compte : identité bannie ? déjà inscrit dans cette centrale ?
create or replace function public.svc_identity_check(
  p_org uuid,
  p_phone text,
  p_email text,
  p_vtc_card text default null,
  p_plate text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_banned boolean;
  v_duplicate text;
begin
  v_banned := private.identity_ban_scope(p_org, 'phone', p_phone) is not null
    or private.identity_ban_scope(p_org, 'email', p_email) is not null
    or private.identity_ban_scope(p_org, 'vtc_card', p_vtc_card) is not null
    or private.identity_ban_scope(p_org, 'plate', p_plate) is not null;
  v_duplicate := case
    when exists (select 1 from public.drivers d where d.organization_id = p_org
                 and private.identity_normalize('phone', d.phone) = private.identity_normalize('phone', p_phone)) then 'phone'
    when exists (select 1 from public.drivers d where d.organization_id = p_org
                 and lower(d.email) = lower(btrim(coalesce(p_email, '')))) then 'email'
    when exists (select 1 from public.vehicles v where v.organization_id = p_org
                 and private.identity_normalize('plate', v.plate) = private.identity_normalize('plate', p_plate)) then 'plate'
  end;
  return jsonb_build_object('banned', v_banned, 'duplicate', v_duplicate);
end;
$$;

-- Candidature (compte Auth déjà créé par la route serveur) : véhicule + fiche « en attente »
create or replace function public.svc_driver_apply(
  p_org uuid,
  p_user_id uuid,
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_email text,
  p_vtc_card text,
  p_vehicle jsonb,
  p_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  d public.drivers;
  v_vehicle uuid;
  v_constraint text;
  v_approved boolean := false;
  v_first text := btrim(coalesce(p_first_name, ''));
  v_last text := btrim(coalesce(p_last_name, ''));
  v_phone text := btrim(coalesce(p_phone, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_model text := btrim(coalesce(p_vehicle ->> 'model', ''));
  v_plate text := upper(btrim(coalesce(p_vehicle ->> 'plate', '')));
begin
  select * into o from public.organizations where id = p_org;
  if not found or o.status <> 'active' or o.dispatch_model <> 'centrale' or not o.join_enabled then
    return jsonb_build_object('ok', false, 'code', 'JOIN_DISABLED', 'message', 'Ce lien d''inscription n''est plus actif.');
  end if;
  if p_user_id is null or exists (select 1 from public.drivers x where x.user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_REGISTERED', 'message', 'Ce compte est déjà rattaché à une centrale.');
  end if;
  if char_length(v_first) not between 1 and 80 or char_length(v_last) not between 1 and 80
     or char_length(v_phone) not between 6 and 30
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     or char_length(v_model) not between 1 and 80
     or char_length(v_plate) not between 4 and 16 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_FORM', 'message', 'Vérifiez le formulaire.');
  end if;
  if exists (select 1 from public.drivers x where x.organization_id = p_org
             and private.identity_normalize('phone', x.phone) = private.identity_normalize('phone', v_phone)) then
    return jsonb_build_object('ok', false, 'code', 'PHONE_TAKEN', 'message', 'Ce numéro est déjà inscrit dans cette centrale.');
  end if;
  perform private.set_actor('system', null);

  begin
    insert into public.vehicles (organization_id, brand, model, color, plate, category, seats, luggage_capacity)
    values (p_org, left(nullif(btrim(coalesce(p_vehicle ->> 'brand', '')), ''), 60), v_model,
      left(nullif(btrim(coalesce(p_vehicle ->> 'color', '')), ''), 40), v_plate,
      coalesce(nullif(p_vehicle ->> 'category', '')::public.vehicle_category, 'standard'),
      coalesce(nullif(p_vehicle ->> 'seats', '')::smallint, 4),
      coalesce(nullif(p_vehicle ->> 'luggage_capacity', '')::smallint, 3))
    returning id into v_vehicle;

    insert into public.drivers (organization_id, user_id, first_name, last_name, phone, email, vtc_card_number, status,
      presence, vehicle_id, trust_level, joined_via, application_status, application_message, applied_at)
    values (p_org, p_user_id, v_first, v_last, v_phone, v_email, left(nullif(btrim(coalesce(p_vtc_card, '')), ''), 40),
      'inactive', 'offline', v_vehicle, 'new', 'join_link', 'pending',
      left(nullif(btrim(coalesce(p_message, '')), ''), 1000), now())
    returning * into d;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      return jsonb_build_object('ok', false,
        'code', case when v_constraint like 'vehicles%' then 'PLATE_TAKEN'
                     when v_constraint like '%email%' then 'EMAIL_TAKEN'
                     else 'ALREADY_REGISTERED' end,
        'message', case when v_constraint like 'vehicles%' then 'Cette plaque est déjà enregistrée dans cette centrale.'
                        when v_constraint like '%email%' then 'Cette adresse e-mail est déjà inscrite dans cette centrale.'
                        else 'Ce compte est déjà inscrit.' end);
    when insufficient_privilege then
      -- identité bannie (trigger) : message volontairement neutre
      return jsonb_build_object('ok', false, 'code', 'IDENTITY_BANNED', 'message', 'Inscription impossible. Contactez la centrale.');
    when check_violation or invalid_text_representation or numeric_value_out_of_range or string_data_right_truncation then
      return jsonb_build_object('ok', false, 'code', 'INVALID_FORM', 'message', 'Vérifiez le formulaire.');
  end;

  -- Validation automatique (réglage de la centrale) ; limite de l'offre atteinte → validation manuelle
  if o.join_auto_approve then
    begin
      update public.drivers
         set status = 'active', application_status = 'approved', application_reviewed_at = now()
       where id = d.id;
      v_approved := true;
    exception when others then
      v_approved := false;
    end;
  end if;

  perform private.log_event(p_org, null, 'driver.applied',
    format('%s %s (#%s) %s via le lien d''inscription', d.first_name, d.last_name, d.number,
      case when v_approved then 'a rejoint la centrale' else 'demande à rejoindre la centrale' end),
    'timeline', 'info', jsonb_build_object('driver_id', d.id, 'auto_approved', v_approved), 'system', null);
  perform realtime.send(
    jsonb_build_object('action', case when v_approved then 'approved' else 'applied' end,
      'driver', jsonb_build_object('id', d.id, 'number', d.number, 'first_name', d.first_name, 'last_name', d.last_name,
        'phone', d.phone, 'applied_at', d.applied_at)),
    'driver.application', 'org:' || p_org::text, true);
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, 'system', null, 'driver.applied', 'drivers', d.id::text, 'info',
    jsonb_build_object('auto_approved', v_approved, 'email', v_email));

  return jsonb_build_object('ok', true, 'code', case when v_approved then 'APPROVED' else 'PENDING' end,
    'driver_id', d.id, 'number', d.number, 'organization', jsonb_build_object('name', o.name));
end;
$$;

create or replace function public.approve_driver_application(p_driver_id uuid, p_trust_level text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_name text;
  v_trust text := nullif(btrim(coalesce(p_trust_level, '')), '');
begin
  select * into d from public.drivers where id = p_driver_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_FOUND', 'message', 'Candidature introuvable.');
  end if;
  perform private.assert_org_member(d.organization_id, array['owner', 'admin']::public.org_role[]);
  perform private.set_actor('user', auth.uid());
  if d.application_status is distinct from 'pending' then
    return jsonb_build_object('ok', false, 'code', 'NOT_PENDING', 'message', 'Cette candidature a déjà été traitée.');
  end if;
  if v_trust is not null and v_trust not in ('new', 'trusted') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TRUST', 'message', 'Niveau de confiance invalide.');
  end if;

  -- Limite de l'offre / identité bannie depuis la candidature : erreurs levées par les triggers
  update public.drivers
     set status = 'active',
         application_status = 'approved',
         application_reviewed_at = now(),
         application_reviewed_by = auth.uid(),
         trust_level = coalesce(v_trust, trust_level)
   where id = d.id;

  select o.name into v_name from public.organizations o where o.id = d.organization_id;
  perform private.queue_notification(d.organization_id, d.id, null, null, 'application_approved', 'CANDIDATURE ACCEPTÉE',
    format('Bienvenue chez %s : passez en ligne pour recevoir vos premières courses.', v_name),
    jsonb_build_object('type', 'application_approved'), 'high', null);
  perform private.log_event(d.organization_id, null, 'driver.approved',
    format('Candidature de %s %s (#%s) acceptée', d.first_name, d.last_name, d.number),
    'timeline', 'success', jsonb_build_object('driver_id', d.id, 'trust_level', coalesce(v_trust, d.trust_level)),
    'user', auth.uid());
  perform realtime.send(
    jsonb_build_object('action', 'approved',
      'driver', jsonb_build_object('id', d.id, 'number', d.number, 'first_name', d.first_name, 'last_name', d.last_name)),
    'driver.application', 'org:' || d.organization_id::text, true);
  return jsonb_build_object('ok', true, 'code', 'APPROVED', 'message', 'Chauffeur validé : il peut recevoir des courses.');
end;
$$;

create or replace function public.reject_driver_application(p_driver_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
begin
  select * into d from public.drivers where id = p_driver_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_FOUND', 'message', 'Candidature introuvable.');
  end if;
  perform private.assert_org_member(d.organization_id, array['owner', 'admin']::public.org_role[]);
  perform private.set_actor('user', auth.uid());
  if d.application_status is distinct from 'pending' then
    return jsonb_build_object('ok', false, 'code', 'NOT_PENDING', 'message', 'Cette candidature a déjà été traitée.');
  end if;

  update public.drivers
     set application_status = 'rejected', application_reviewed_at = now(), application_reviewed_by = auth.uid(),
         application_note = v_reason
   where id = d.id;

  perform private.log_event(d.organization_id, null, 'driver.rejected',
    format('Candidature de %s %s (#%s) refusée%s', d.first_name, d.last_name, d.number, coalesce(' : ' || v_reason, '')),
    'timeline', 'warning', jsonb_build_object('driver_id', d.id, 'reason', v_reason), 'user', auth.uid());
  perform realtime.send(
    jsonb_build_object('action', 'rejected',
      'driver', jsonb_build_object('id', d.id, 'number', d.number, 'first_name', d.first_name, 'last_name', d.last_name)),
    'driver.application', 'org:' || d.organization_id::text, true);
  return jsonb_build_object('ok', true, 'code', 'REJECTED', 'message', 'Candidature refusée.');
end;
$$;

-- État du compte pour l'application (fonctionne aussi pour un compte en attente, refusé ou banni)
create or replace function public.driver_account_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  o public.organizations;
  v_state text;
begin
  select * into d from public.drivers where user_id = auth.uid();
  if not found then
    return jsonb_build_object('state', 'none', 'message', 'Aucun compte chauffeur n''est associé à cet identifiant.');
  end if;
  select * into o from public.organizations where id = d.organization_id;

  v_state := case
    when d.banned_at is not null then 'banned'
    when o.status <> 'active' then 'organization_suspended'
    when d.application_status = 'pending' then 'pending'
    when d.application_status = 'rejected' then 'rejected'
    when d.status = 'active' then 'active'
    when d.status = 'invited' then 'invited'
    when d.status = 'suspended' then 'suspended'
    else 'inactive'
  end;

  return jsonb_build_object(
    'state', v_state,
    'driver', jsonb_build_object('id', d.id, 'number', d.number, 'first_name', d.first_name, 'last_name', d.last_name,
      'applied_at', d.applied_at, 'trust_level', d.trust_level),
    'organization', jsonb_build_object('name', o.name, 'logo_url', o.logo_url, 'phone', o.phone, 'email', o.email,
      'dispatch_model', o.dispatch_model),
    'reason', case v_state
      when 'banned' then d.ban_reason
      when 'rejected' then d.application_note
      when 'suspended' then d.suspended_reason
    end,
    'can_submit_documents', v_state = 'pending'
  );
end;
$$;

-- Chauffeur actif, ou candidat en attente (dépôt de documents avant validation)
create or replace function private.current_driver_or_applicant_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.id
  from public.drivers d
  join public.organizations o on o.id = d.organization_id
  where d.user_id = auth.uid()
    and o.status = 'active'
    and d.banned_at is null
    and (d.status = 'active' or (d.status = 'inactive' and d.application_status = 'pending'))
  limit 1;
$$;

create or replace function private.current_driver_or_applicant_org_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.organization_id
  from public.drivers d
  join public.organizations o on o.id = d.organization_id
  where d.user_id = auth.uid()
    and o.status = 'active'
    and d.banned_at is null
    and (d.status = 'active' or (d.status = 'inactive' and d.application_status = 'pending'))
  limit 1;
$$;

-- ----------------------------------------------------------------- documents des candidats
-- Dernières définitions : 20260924002400. Seul changement : un candidat en attente (inscrit par
-- lien) peut consulter et déposer ses documents avant validation (private.current_driver_or_applicant_id).
create or replace function public.driver_documents()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_today date;
  v_docs jsonb;
begin
  select * into d from public.drivers where id = private.current_driver_or_applicant_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  v_today := private.org_today(d.organization_id);

  select coalesce(jsonb_agg(private.document_json(x, v_today)
           order by coalesce(array_position(private.required_document_types(), x.type), 99), x.type, x.created_at desc, x.id),
         '[]'::jsonb)
    into v_docs
  from public.driver_documents x
  where x.driver_id = d.id
    and not private.document_superseded(x);

  return jsonb_build_object(
    'today', v_today,
    'documents', v_docs,
    'summary', (
      select jsonb_build_object(
        'valid', count(*) filter (where e ->> 'status' = 'valid'),
        'expiring', count(*) filter (where e ->> 'status' = 'expiring'),
        'expired', count(*) filter (where e ->> 'status' = 'expired'),
        'pending', count(*) filter (where e ->> 'status' = 'pending'),
        'rejected', count(*) filter (where e ->> 'status' = 'rejected'))
      from jsonb_array_elements(v_docs) e
    ),
    -- Types exigés sans document utilisable (valide, bientôt échu ou en validation)
    'missing_types', (
      select coalesce(jsonb_agg(t order by u.ord), '[]'::jsonb)
      from unnest(private.required_document_types()) with ordinality as u (t, ord)
      where not exists (
        select 1 from jsonb_array_elements(v_docs) e
        where e ->> 'type' = u.t::text and e ->> 'status' in ('valid', 'expiring', 'pending')
      )
    )
  );
end;
$$;

create or replace function public.driver_submit_document(
  p_type public.document_type,
  p_number text,
  p_expires_at date,
  p_file_path text,
  p_issued_at date default null,
  p_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_path text := btrim(coalesce(p_file_path, ''));
  v_number text := nullif(btrim(coalesce(p_number, '')), '');
  v_label text := nullif(btrim(coalesce(p_label, '')), '');
  v_prefix text;
  v_today date;
  v_exists boolean;
  v_doc public.driver_documents;
  v_replaced_ids uuid[];
  v_json jsonb;
begin
  select * into d from public.drivers where id = private.current_driver_or_applicant_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  perform private.set_actor('driver', d.id);

  if p_type is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TYPE', 'message', 'Type de document manquant.');
  end if;
  if v_path = '' then
    return jsonb_build_object('ok', false, 'code', 'FILE_REQUIRED', 'message', 'Ajoutez une photo ou un PDF du document.');
  end if;

  v_prefix := d.organization_id::text || '/' || d.id::text || '/';
  if left(v_path, char_length(v_prefix)) <> v_prefix then
    raise exception 'FORBIDDEN_PATH: fichier hors de votre dossier' using errcode = '42501';
  end if;
  if char_length(v_path) > 300
     or char_length(v_path) = char_length(v_prefix)
     or right(v_path, 1) = '/'
     or strpos(v_path, '//') > 0
     or v_path ~ '(^|/)\.\.?(/|$)'
     or v_path ~ '[[:cntrl:]\\]' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_FILE_PATH', 'message', 'Fichier invalide.');
  end if;

  if v_number is not null and char_length(v_number) > 60 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_NUMBER', 'message', 'Numéro de document trop long.');
  end if;
  if v_label is not null and char_length(v_label) > 80 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_LABEL', 'message', 'Intitulé trop long.');
  end if;

  v_today := private.org_today(d.organization_id);
  if p_expires_at is not null and p_expires_at < v_today then
    return jsonb_build_object('ok', false, 'code', 'DOCUMENT_ALREADY_EXPIRED', 'message', 'Ce document est déjà expiré.');
  end if;
  if p_expires_at is not null and p_expires_at > v_today + 365 * 30 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_EXPIRY', 'message', 'Date d''expiration invalide.');
  end if;
  if p_issued_at is not null and (p_issued_at > v_today or p_issued_at > coalesce(p_expires_at, 'infinity'::date)) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ISSUE_DATE', 'message', 'Date de délivrance invalide.');
  end if;

  -- Le fichier doit exister dans le stockage (Supabase ; ignoré sans schéma storage)
  if to_regclass('storage.objects') is not null then
    execute 'select exists (select 1 from storage.objects o where o.bucket_id = $1 and o.name = $2)'
      into v_exists using 'driver-documents', v_path;
    if not v_exists then
      return jsonb_build_object('ok', false, 'code', 'FILE_NOT_FOUND', 'message', 'Fichier introuvable : renvoyez-le.');
    end if;
  end if;

  -- Dépôts d'un même chauffeur sérialisés (double appui, plusieurs appareils)
  perform pg_advisory_xact_lock(hashtextextended('rydar.driver_documents:' || d.id::text, 0));

  if (select count(*) from public.ride_events e
      where e.organization_id = d.organization_id
        and e.created_at > now() - interval '1 hour'
        and e.type = 'document.submitted'
        and e.data ->> 'driver_id' = d.id::text) >= 20 then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED', 'message', 'Trop d''envois : réessayez plus tard.');
  end if;

  -- Plafond vérifié AVANT tout retrait (un refus ne doit rien modifier)
  if (select count(*) from public.driver_documents x
      where x.driver_id = d.id and x.status = 'pending'
        and not (p_type <> 'other' and x.type = p_type and x.source = 'driver')) >= 10 then
    return jsonb_build_object('ok', false, 'code', 'TOO_MANY_PENDING',
      'message', 'Trop de documents en attente de validation.');
  end if;

  -- Un nouveau dépôt retire le précédent encore en attente (même type, hors « other »).
  -- Retrait plutôt que modification : la centrale ne peut jamais valider un fichier
  -- qu'elle n'a pas vu (sa validation de l'ancien renvoie DOCUMENT_NOT_FOUND).
  if p_type <> 'other' then
    with gone as (
      delete from public.driver_documents x
       where x.driver_id = d.id and x.type = p_type and x.status = 'pending' and x.source = 'driver'
      returning x.id
    )
    select array_agg(g.id) into v_replaced_ids from gone g;
  end if;

  insert into public.driver_documents (organization_id, driver_id, type, label, file_path, number, issued_at, expires_at, status, source)
  values (d.organization_id, d.id, p_type, v_label, v_path, v_number, p_issued_at, p_expires_at, 'pending', 'driver')
  returning * into v_doc;

  v_json := private.document_json(v_doc, v_today);

  perform private.log_event(d.organization_id, null, 'document.submitted',
    format('%s %s (#%s) a déposé un document à valider : %s', d.first_name, d.last_name, d.number,
      private.document_label(v_doc.type, v_doc.label)),
    'timeline', 'info',
    jsonb_build_object('driver_id', d.id, 'document_id', v_doc.id, 'document_type', v_doc.type,
      'expires_at', v_doc.expires_at, 'replaced_ids', coalesce(to_jsonb(v_replaced_ids), '[]'::jsonb)),
    'driver', d.id);

  perform realtime.send(
    jsonb_build_object('action', 'submitted', 'document', v_json,
      'replaced_ids', coalesce(to_jsonb(v_replaced_ids), '[]'::jsonb),
      'driver', jsonb_build_object('id', d.id, 'number', d.number, 'first_name', d.first_name, 'last_name', d.last_name)),
    'driver.document', 'org:' || d.organization_id::text, true);

  return jsonb_build_object(
    'ok', true,
    'code', case when v_replaced_ids is not null then 'DOCUMENT_UPDATED' else 'DOCUMENT_SUBMITTED' end,
    'message', 'Document envoyé à la centrale pour validation.',
    'replaced_id', v_replaced_ids[1],
    'document', v_json);
end;
$$;

-- Stockage : le candidat en attente dépose et relit ses fichiers dans driver-documents/{org}/{driver}/
create or replace function private.install_driver_document_storage_policy()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if to_regclass('storage.objects') is null then
    return false;
  end if;
  execute 'drop policy if exists rydar_storage_driver_upload_documents on storage.objects';
  execute $p$
    create policy rydar_storage_driver_upload_documents on storage.objects for insert to authenticated
    with check (
      bucket_id = 'driver-documents'
      and (storage.foldername(name))[1] = coalesce((select private.current_driver_or_applicant_org_id())::text, '-')
      and (storage.foldername(name))[2] = coalesce((select private.current_driver_or_applicant_id())::text, '-')
    )
  $p$;
  execute 'drop policy if exists rydar_storage_read_documents on storage.objects';
  execute $p$
    create policy rydar_storage_read_documents on storage.objects for select to authenticated
    using (
      bucket_id = 'driver-documents' and (
        (storage.foldername(name))[1] in (select m::text from private.member_org_ids() as m)
        or (storage.foldername(name))[2] = coalesce((select private.current_driver_or_applicant_id())::text, '-')
      )
    )
  $p$;
  return true;
end;
$$;

select private.install_driver_document_storage_policy();

-- -----------------------------------------------------------------------------
-- Droits d'exécution (deny-by-default, cf. 20260924000900)
-- -----------------------------------------------------------------------------
revoke execute on function
  private.organizations_dispatch_model_guard(),
  private.identity_normalize(text, text),
  private.identity_hash(text, text),
  private.identity_hint(text, text),
  private.identity_kind_label(text),
  private.identity_ban_scope(uuid, text, text),
  private.driver_identities(uuid, boolean),
  private.enforce_identity_bans(),
  private.flag_banned_device(),
  private.compute_ride_split(uuid, integer, integer),
  private.rides_centrale_split(),
  private.settlement_direction(public.payment_method),
  private.settlement_json(public.ride_settlements),
  private.broadcast_settlement(public.ride_settlements, text),
  private.settlement_payment_link(text, integer, text),
  private.maybe_promote_driver(uuid),
  private.sync_ride_settlement(),
  private.centrale_blocker(uuid, text, integer, boolean, integer, integer),
  private.driver_blocker(uuid, integer),
  private.blocker_message(text),
  private.ride_net_cents(integer, integer, numeric),
  private.settlement_method_label(text),
  private.settlement_reminders(),
  private.random_join_code(),
  private.current_driver_or_applicant_id(),
  private.current_driver_or_applicant_org_id(),
  private.install_driver_document_storage_policy()
from public, anon, authenticated;
grant execute on function
  private.organizations_dispatch_model_guard(),
  private.identity_normalize(text, text),
  private.identity_hash(text, text),
  private.identity_hint(text, text),
  private.identity_kind_label(text),
  private.identity_ban_scope(uuid, text, text),
  private.driver_identities(uuid, boolean),
  private.enforce_identity_bans(),
  private.flag_banned_device(),
  private.compute_ride_split(uuid, integer, integer),
  private.rides_centrale_split(),
  private.settlement_direction(public.payment_method),
  private.settlement_json(public.ride_settlements),
  private.broadcast_settlement(public.ride_settlements, text),
  private.settlement_payment_link(text, integer, text),
  private.maybe_promote_driver(uuid),
  private.sync_ride_settlement(),
  private.centrale_blocker(uuid, text, integer, boolean, integer, integer),
  private.driver_blocker(uuid, integer),
  private.blocker_message(text),
  private.ride_net_cents(integer, integer, numeric),
  private.settlement_method_label(text),
  private.settlement_reminders(),
  private.random_join_code(),
  private.current_driver_or_applicant_id(),
  private.current_driver_or_applicant_org_id(),
  private.install_driver_document_storage_policy()
to service_role;
-- Évaluées par les politiques de stockage avec le rôle de l'appelant
grant execute on function
  private.current_driver_or_applicant_id(),
  private.current_driver_or_applicant_org_id()
to authenticated;

-- Application chauffeur + tableau de bord (contrôles d'appartenance dans chaque fonction)
revoke execute on function
  public.driver_settlements(integer),
  public.driver_declare_payment(uuid[], text, text),
  public.driver_account_state(),
  public.driver_offers(),
  public.driver_home(),
  public.driver_earnings(integer),
  public.driver_documents(),
  public.driver_submit_document(public.document_type, text, date, text, date, text),
  public.accept_ride_offer(uuid),
  public.org_settlement_overview(uuid),
  public.org_settlements(uuid, text, uuid, integer, timestamptz),
  public.confirm_settlements(uuid[], text, text),
  public.dispute_settlement(uuid, text),
  public.waive_settlement(uuid, text),
  public.reopen_settlement(uuid),
  public.remind_driver_settlements(uuid),
  public.preview_ride_split(uuid, integer, integer),
  public.ban_driver(uuid, text, text, boolean, boolean),
  public.lift_driver_ban(uuid, text),
  public.lift_identity_ban(uuid, text),
  public.set_join_link(uuid, boolean, boolean, boolean),
  public.approve_driver_application(uuid, text),
  public.reject_driver_application(uuid, text),
  public.admin_centrale_overview(timestamptz)
from public, anon;
grant execute on function
  public.driver_settlements(integer),
  public.driver_declare_payment(uuid[], text, text),
  public.driver_account_state(),
  public.driver_offers(),
  public.driver_home(),
  public.driver_earnings(integer),
  public.driver_documents(),
  public.driver_submit_document(public.document_type, text, date, text, date, text),
  public.accept_ride_offer(uuid),
  public.org_settlement_overview(uuid),
  public.org_settlements(uuid, text, uuid, integer, timestamptz),
  public.confirm_settlements(uuid[], text, text),
  public.dispute_settlement(uuid, text),
  public.waive_settlement(uuid, text),
  public.reopen_settlement(uuid),
  public.remind_driver_settlements(uuid),
  public.preview_ride_split(uuid, integer, integer),
  public.ban_driver(uuid, text, text, boolean, boolean),
  public.lift_driver_ban(uuid, text),
  public.lift_identity_ban(uuid, text),
  public.set_join_link(uuid, boolean, boolean, boolean),
  public.approve_driver_application(uuid, text),
  public.reject_driver_application(uuid, text),
  public.admin_centrale_overview(timestamptz)
to authenticated, service_role;

-- Serveur uniquement (page d'inscription publique, super admin) : service role
revoke execute on function
  public.svc_join_info(text),
  public.svc_identity_check(uuid, text, text, text, text),
  public.svc_driver_apply(uuid, uuid, text, text, text, text, text, jsonb, text),
  public.svc_platform_ban(uuid, uuid, text),
  public.svc_platform_dismiss_report(uuid, uuid, text),
  public.svc_platform_unban(uuid, uuid, text)
from public, anon, authenticated;
grant execute on function
  public.svc_join_info(text),
  public.svc_identity_check(uuid, text, text, text, text),
  public.svc_driver_apply(uuid, uuid, text, text, text, text, text, jsonb, text),
  public.svc_platform_ban(uuid, uuid, text),
  public.svc_platform_dismiss_report(uuid, uuid, text),
  public.svc_platform_unban(uuid, uuid, text)
to service_role;
