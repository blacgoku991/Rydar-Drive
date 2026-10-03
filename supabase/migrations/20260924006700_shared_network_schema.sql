-- =============================================================================
-- Rydar Drive — Réseau partagé, lot 2 : schéma, gardes et droits. Interrupteur plateforme COUPÉ.
--
-- Réseau partagé entre organisations (flottes et centrales) : une course qu'aucun chauffeur de l'organisation A
-- n'accepte peut être proposée aux chauffeurs des organisations B qui ont accepté la même convention. Ce lot ne pose
-- que le SCHÉMA : rien ne propose ni n'accepte encore de course partagée (dispatch : 006800, argent : 006900, accès :
-- 007000, administration : 007100). Tant que public.shared_network_enabled() est faux (défaut), le comportement est
-- strictement celui d'avant : aucune garde n'agit sur une course, une offre ou un règlement de l'organisation.
--
-- Principes (spécification « Réseau partagé », §4 et §8) :
--  * la course ne déménage jamais : rides.organization_id = A à vie. Second axe rides.driver_org_id = organisation du
--    chauffeur, posé par trigger depuis drivers, jamais par l'appelant ; même colonne sur les tables filles qui
--    pointent un chauffeur (offres, attributions, notifications, alertes). Les clés étrangères (organization_id,
--    driver_id) y sont REMPLACÉES, sous le même nom, par (driver_org_id, driver_id) : jamais une seconde clé rides →
--    drivers (embed PostgREST « drivers!rides_organization_id_driver_id_fkey » de lib/api/v1.ts et de la liste des
--    courses inchangé, jamais ambigu) ;
--  * un règlement réseau (ride_settlements) a network_driver_org_id non NULL et driver_id NULL : les fonctions des
--    règlements propres l'ignorent par construction ; contrepartie TOUJOURS le chauffeur (décision Q2 : colonnes
--    contraintes à 'driver', une extension se fera par une nouvelle migration) ;
--  * termes figés : network_terms d'une offre et terms d'une exécution complets et cohérents (contrôlés à l'insertion,
--    private.network_terms_insert_check), jamais modifiés ensuite (G2) ;
--  * gardes G1 à G13 (§8.4) en triggers private, search_path vide ; sans definer quand elles ne s'exécutent qu'en
--    contexte privilégié (RPC definer, worker, service role), definer quand elles lisent ou écrivent, pendant une
--    écriture du tableau de bord, des lignes que l'appelant ne voit pas (G6, G7, G9, G10, G11, G12, G13) ;
--  * policies : aucune ne s'ouvre à l'autre organisation ; tables réseau sans lecture client, sauf
--    network_memberships, network_exclusions et driver_network_settings (lignes de sa propre organisation) ;
--    network_terms d'une offre illisible côté client (commission et frais Rydar de A : jamais montrés au chauffeur).
--
-- Déploiement (deploy/migrate.sh : ce fichier en UNE transaction, ancien worker et web encore en service) : tous les
-- verrous pris d'emblée dans un ordre fixe, lock_timeout de 5 s (section 0) ; remplissage des nouvelles colonnes par
-- un UPDATE par table, sans diffusion temps réel ni date de modification touchée (rides_c_broadcast /
-- ride_alerts_broadcast et touch_updated_at désactivés le temps du remplissage), puis clés étrangères reconstruites
-- « not valid » + « validate constraint ». Mesuré : 0,3 s sur le seed ; 19 s pour 96 000 courses, 235 000 offres et
-- 340 000 notifications, toutes ces tables bloquées pendant ce temps (au-delà de quelques dizaines de milliers d'offres
-- ou de notifications en production, arrêter le worker pendant la migration).
-- Supabase hébergé : rien sur auth.*, storage.*, realtime.messages ; trigger seulement sur public.users.
-- =============================================================================

-- =============================================================================
-- 0. Verrous
-- =============================================================================
-- Pris d'emblée, dans l'ordre des RPC (course, offres, chauffeur…) : aucune montée de verrou en cours de route (clé
-- étrangère vers rides puis ALTER TABLE rides), donc pas d'interblocage avec une RPC qui lit puis écrit une course.
-- Un verrou indisponible plus de 5 s fait échouer la migration proprement (rien n'est appliqué, à relancer) au lieu de
-- faire attendre tout le trafic derrière elle. Bloc DO : sans transaction englobante (scripts/db-local.sh, une
-- instruction à la fois), sans effet et sans erreur.
do $$
begin
  perform set_config('lock_timeout', '5s', true);
  lock table public.rides, public.ride_offers, public.drivers, public.ride_assignments, public.notifications,
    public.ride_alerts, public.ride_settlements, public.driver_locations, public.driver_location_history,
    public.platform_settings, public.legal_acceptances
    in access exclusive mode;
  -- Tables seulement référencées (clés étrangères) ou dotées d'un déclencheur : écritures suspendues, lectures libres
  lock table public.organizations, public.organization_settings, public.users, public.vehicles
    in share row exclusive mode;
end;
$$;

-- =============================================================================
-- 1. Plateforme : interrupteur et version de la convention (§8.1, §6.3)
-- =============================================================================
alter table public.platform_settings
  add column shared_network_enabled boolean not null default false,
  add column network_terms_version text not null default '2026-11-01'
    check (char_length(network_terms_version) between 1 and 40),
  add column network_terms_min_version text
    check (network_terms_min_version is null or char_length(network_terms_min_version) between 1 and 40),
  add column network_terms_grace_until timestamptz,
  add constraint platform_settings_network_terms_grace_check
    check ((network_terms_min_version is null) = (network_terms_grace_until is null));

comment on column public.platform_settings.shared_network_enabled is
  'Réseau partagé ouvert (super admin, svc_set_shared_network_enabled). Coupé : aucune course n''est partagée, les courses déjà acceptées vont à leur terme.';
comment on column public.platform_settings.network_terms_version is
  'Version courante de la convention du réseau (documents « network » et « network_driver ») ; = NETWORK_TERMS_VERSION de @rydar/shared. Changée par migration avec le texte.';
comment on column public.platform_settings.network_terms_min_version is
  'Version précédente encore valable jusqu''à network_terms_grace_until (délai de grâce d''une nouvelle convention).';

-- Absent ou illisible = coupé (jamais un réseau ouvert par défaut). Modèle : public.booking_sites_enabled (006200).
create or replace function public.shared_network_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.shared_network_enabled from public.platform_settings s where s.id), false);
$$;

revoke all on function public.shared_network_enabled() from public, anon, authenticated;
grant execute on function public.shared_network_enabled() to authenticated, service_role;

-- Convention acceptée encore valable : version courante, ou version précédente pendant le délai de grâce
-- (miroir : networkTermsOk de @rydar/shared). Appelée par des fonctions privilégiées (platform_settings : lecture
-- super admin seulement par RLS).
create or replace function private.network_terms_ok(p_version text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select p_version = s.network_terms_version
        or (p_version = s.network_terms_min_version and now() < s.network_terms_grace_until)
      from public.platform_settings s
     where s.id), false);
$$;

-- =============================================================================
-- 2. Preuves d'acceptation : convention (organisation) et conditions chauffeur (§8.1, §7.2, §7.3)
-- =============================================================================
-- Acceptées par des RPC dédiées (lot administration) ; public.accept_legal_documents n'accepte toujours que
-- cgu / privacy / cgv / dpa (liste fermée dans la fonction, inchangée).
alter table public.legal_acceptances drop constraint legal_acceptances_document_check;
alter table public.legal_acceptances add constraint legal_acceptances_document_check
  check (document in ('cgu', 'privacy', 'cgv', 'dpa', 'network', 'network_driver'));
comment on table public.legal_acceptances is
  'Preuve d''acceptation des documents légaux (CGU, confidentialité, CGV, accord de traitement, convention du réseau partagé, conditions chauffeur du réseau) par version. Ajout seul.';

-- Dernière définition : 20260924003900_legal_compliance.sql. Seul ajout : signataire recopié aussi pour la
-- convention du réseau partagé (« network », acceptée au nom de l'organisation par owner / admin). Les conditions
-- chauffeur (« network_driver ») restent personnelles, comme les CGU.
create or replace function private.legal_acceptances_signatory()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.accepted_by_email := case
    when new.document in ('cgv', 'dpa', 'network') and new.user_id is not null
    then (select u.email from public.users u where u.id = new.user_id)
  end;
  return new;
end;
$$;

revoke execute on function private.legal_acceptances_signatory() from public, anon, authenticated, service_role;

-- =============================================================================
-- 3. Termes figés d'une course partagée : contrôle de cohérence (§10.1, contrat NetworkTerms de @rydar/shared)
-- =============================================================================
-- Part de A = commission + frais Rydar ; part du chauffeur = prix − part de A (> 0) ; le chauffeur encaisse à bord
-- (espèces, carte) → il reverse la part de A (driver_owes), sinon A lui verse sa part (centrale_owes). Montants en
-- centimes entiers. Appelée à l'INSERTION seulement (private.network_terms_insert_check : ride_offers.network_terms,
-- ride_network_executions.terms), jamais dans une contrainte CHECK : PostgreSQL réévalue un CHECK à chaque UPDATE de
-- la ligne, et une fonction durcie plus tard (clé ajoutée…) bloquerait alors l'expiration des offres et la fin des
-- courses partagées. Les termes sont figés ensuite (G2).
create or replace function private.network_terms_complete(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text;
  v_price numeric;
  v_commission numeric;
  v_fee numeric;
  v_cut numeric;
  v_payout numeric;
  v_amount numeric;
  v_collects boolean;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    return false;
  end if;
  foreach k in array array['price_cents', 'commission_cents', 'platform_fee_cents', 'giver_cut_cents',
                           'driver_payout_cents', 'amount_cents'] loop
    -- Deux instructions : la conversion n'est évaluée que sur un nombre JSON
    if jsonb_typeof(p -> k) is distinct from 'number' then
      return false;
    end if;
    if (p ->> k)::numeric <> trunc((p ->> k)::numeric) then
      return false;
    end if;
  end loop;
  if jsonb_typeof(p -> 'collects') is distinct from 'boolean'
     or (p ->> 'payment_method') is null or (p ->> 'payment_method') not in ('cash', 'card', 'online', 'invoice', 'account')
     or (p ->> 'direction') is null or (p ->> 'direction') not in ('driver_owes', 'centrale_owes') then
    return false;
  end if;
  v_price := (p ->> 'price_cents')::numeric;
  v_commission := (p ->> 'commission_cents')::numeric;
  v_fee := (p ->> 'platform_fee_cents')::numeric;
  v_cut := (p ->> 'giver_cut_cents')::numeric;
  v_payout := (p ->> 'driver_payout_cents')::numeric;
  v_amount := (p ->> 'amount_cents')::numeric;
  v_collects := (p ->> 'collects')::boolean;
  return v_price between 1 and 10000000
     and v_commission >= 0
     and v_fee >= 0
     and v_cut = v_commission + v_fee
     and v_payout > 0
     and v_payout = v_price - v_cut
     and v_collects = ((p ->> 'payment_method') in ('cash', 'card'))
     and (p ->> 'direction') = case when v_collects then 'driver_owes' else 'centrale_owes' end
     and v_amount = case when v_collects then v_cut else v_payout end;
end;
$$;

-- Déclencheur BEFORE INSERT de ride_offers (network_terms, offre réseau) et ride_network_executions (terms) : termes
-- complets et cohérents, sinon 23514 (même code qu'un CHECK).
create or replace function private.network_terms_insert_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_terms jsonb;
begin
  -- Champ propre à chaque table lu dans une instruction séparée (préparée seulement pour cette table)
  if tg_table_name = 'ride_offers' then
    v_terms := new.network_terms;
  else
    v_terms := new.terms;
  end if;
  if v_terms is not null and not private.network_terms_complete(v_terms) then
    raise exception 'termes du réseau partagé incomplets ou incohérents (contrat NetworkTerms)'
      using errcode = '23514', table = tg_table_name,
            constraint = case tg_table_name when 'ride_offers' then 'ride_offers_network_terms_check'
                                            else 'ride_network_executions_terms_check' end;
  end if;
  return new;
end;
$$;

-- =============================================================================
-- 4. Nouvelles tables (§8.2)
-- =============================================================================

-- ----------------------------------------------------------------- adhésion d'une organisation
create table public.network_memberships (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  share_out boolean not null default false,
  share_in boolean not null default false,
  terms_version text check (terms_version is null or char_length(terms_version) between 1 and 40),
  terms_accepted_at timestamptz,
  terms_accepted_by uuid references public.users (id) on delete set null,
  requested_at timestamptz,
  approved_at timestamptz,
  approved_by uuid references public.users (id) on delete set null,
  -- Instantané validé par Rydar, montré aux partenaires (un changement de nom ou de n° fait perdre la validation, G11)
  approved_legal_name text check (approved_legal_name is null or char_length(approved_legal_name) between 2 and 160),
  approved_siret text check (approved_siret is null or approved_siret ~ '^[0-9]{14}$'),
  approved_vtc_registration text
    check (approved_vtc_registration is null or char_length(approved_vtc_registration) between 3 and 120),
  fee_waiver boolean not null default false,
  refused_reason text check (refused_reason is null or char_length(refused_reason) <= 300),
  insurance_confirmed_at timestamptz,
  insurance_confirmed_by uuid references public.users (id) on delete set null,
  executor_credit_limit_cents integer not null default 15000 check (executor_credit_limit_cents between 0 and 100000),
  suspended_at timestamptz,
  suspended_reason text check (suspended_reason is null or char_length(suspended_reason) <= 300),
  suspended_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users (id) on delete set null,
  constraint network_memberships_terms_check check (not (share_out or share_in) or terms_version is not null),
  constraint network_memberships_terms_pair_check check ((terms_version is null) = (terms_accepted_at is null)),
  constraint network_memberships_approval_check
    check (approved_at is null
           or (approved_legal_name is not null and approved_siret is not null and approved_vtc_registration is not null))
);
comment on table public.network_memberships is
  'Réseau partagé : réglages d''une organisation (partager / recevoir, convention, validation Rydar et son instantané, assurance, plafond par chauffeur, suspension). Lecture : membres ; écriture : RPC.';

-- ----------------------------------------------------------------- exclusions entre organisations (symétriques)
create table public.network_exclusions (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  excluded_org_id uuid not null references public.organizations (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references public.users (id) on delete set null,
  primary key (organization_id, excluded_org_id),
  constraint network_exclusions_self_check check (organization_id <> excluded_org_id)
);
create index network_exclusions_excluded_idx on public.network_exclusions (excluded_org_id);
comment on table public.network_exclusions is
  'Réseau partagé : organisation exclue par organization_id, dans les deux sens. Visible seulement par l''organisation qui l''a posée.';

-- ----------------------------------------------------------------- partage d'une course (cycle courant)
create table public.ride_network_shares (
  ride_id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'accepted', 'completed', 'closed')),
  cycle smallint not null default 1 check (cycle >= 1),
  opened_at timestamptz not null default now(),
  opened_stage text not null check (opened_stage in ('instant', 'scheduled_window', 'scheduled_geo')),
  giver_terms_version text not null check (char_length(giver_terms_version) between 1 and 40),
  partners_offered integer not null default 0 check (partners_offered >= 0),
  errors smallint not null default 0 check (errors >= 0),
  closed_at timestamptz,
  closed_reason text check (closed_reason is null or closed_reason in ('cancelled', 'no_driver', 'redispatch',
    'removed_by_giver', 'reassigned_own', 'executor_unavailable', 'executor_released', 'window_elapsed',
    'flight_rescheduled', 'error', 'not_performed', 'sharing_stopped')),
  updated_at timestamptz not null default now(),
  constraint ride_network_shares_closed_check check ((status in ('open', 'accepted')) = (closed_at is null)),
  constraint ride_network_shares_reason_check check ((status = 'closed') = (closed_reason is not null)),
  foreign key (organization_id, ride_id) references public.rides (organization_id, id) on delete cascade
);
create index ride_network_shares_org_idx on public.ride_network_shares (organization_id, opened_at desc);
comment on table public.ride_network_shares is
  'Réseau partagé : état du partage d''une course de A (cycle courant). Tenu par private.ride_network_share_sync seulement. Aucune lecture client.';

-- ----------------------------------------------------------------- exécution par un partenaire (preuve, termes figés)
create table public.ride_network_executions (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null,
  organization_id uuid not null references public.organizations (id) on delete cascade,      -- A
  executor_org_id uuid not null references public.organizations (id) on delete restrict,     -- B
  executor_driver_id uuid,
  offer_id uuid,
  -- Contrepartie du règlement : toujours le chauffeur (décision Q2) ; une extension = nouvelle migration
  counterparty text not null default 'driver' constraint ride_network_executions_counterparty_check
    check (counterparty = 'driver'),
  driver_label text not null check (char_length(driver_label) between 2 and 120),
  operator jsonb not null check (jsonb_typeof(operator) = 'object'),
  vehicle jsonb not null check (jsonb_typeof(vehicle) = 'object'),
  checks jsonb not null check (jsonb_typeof(checks) = 'object'),
  -- Complets et cohérents : contrôlés à l'insertion (private.network_terms_insert_check), figés ensuite (G2)
  terms jsonb not null constraint ride_network_executions_terms_check check (jsonb_typeof(terms) = 'object'),
  giver_terms_version text not null check (char_length(giver_terms_version) between 1 and 40),
  executor_terms_version text not null check (char_length(executor_terms_version) between 1 and 40),
  driver_terms_version text check (driver_terms_version is null or char_length(driver_terms_version) between 1 and 40),
  accepted_at timestamptz not null default now(),
  -- Une course partagée terminée = « completed », quelle que soit la voie (chauffeur, close_network_ride : motif
  -- « closed_by_giver » dans suspect_reasons) : prédicat unique des règlements et frais (lot argent)
  ended_at timestamptz,
  end_reason text check (end_reason is null or end_reason in ('completed', 'cancelled_by_giver', 'removed_by_giver',
    'reassigned_own', 'executor_released', 'executor_unavailable', 'not_performed')),
  suspect_reasons text[] not null default '{}'
    check (suspect_reasons <@ array['no_gps', 'far_from_pickup', 'far_from_dropoff', 'too_fast', 'closed_by_giver']::text[]),
  hold_until timestamptz,
  contested_at timestamptz,
  contested_by uuid references public.users (id) on delete set null,
  contested_reason text check (contested_reason is null or char_length(contested_reason) between 5 and 300),
  driver_disputed_at timestamptz,
  driver_dispute_reason text check (driver_dispute_reason is null or char_length(driver_dispute_reason) between 5 and 300),
  client_data_first_read_at timestamptz,
  client_data_last_read_at timestamptz,
  client_data_reads integer not null default 0 check (client_data_reads >= 0),
  -- Empreinte du RIB du chauffeur à la création du règlement (contrepartie chauffeur, lot argent), posée une fois
  -- (G2) et comparée à driver_payout_details.iban_hash (alerte « IBAN modifié », S16). Ici, sans lecture client, et
  -- non dans ride_settlements, que lit tout membre de A (select('*') de la fiche course) : un sha256 d'IBAN se
  -- retrouve par force brute.
  payout_iban_hash text check (payout_iban_hash is null or payout_iban_hash ~ '^[0-9a-f]{64}$'),
  payout_iban_at timestamptz,
  constraint ride_network_executions_partner_check check (executor_org_id <> organization_id),
  constraint ride_network_executions_payout_iban_check check ((payout_iban_hash is null) = (payout_iban_at is null)),
  constraint ride_network_executions_end_check check ((ended_at is null) = (end_reason is null)),
  constraint ride_network_executions_contest_check check ((contested_at is null) = (contested_reason is null)),
  constraint ride_network_executions_dispute_check check ((driver_disputed_at is null) = (driver_dispute_reason is null)),
  foreign key (organization_id, ride_id) references public.rides (organization_id, id) on delete cascade,
  foreign key (executor_org_id, executor_driver_id) references public.drivers (organization_id, id)
    on delete set null (executor_driver_id)
);
create unique index ride_network_executions_open_idx on public.ride_network_executions (ride_id) where ended_at is null;
create index ride_network_executions_ride_idx on public.ride_network_executions (ride_id, accepted_at desc);
create index ride_network_executions_org_idx on public.ride_network_executions (organization_id, accepted_at desc);
create index ride_network_executions_exec_idx on public.ride_network_executions (executor_org_id, accepted_at desc);
create index ride_network_executions_driver_idx on public.ride_network_executions (executor_driver_id, accepted_at desc);
comment on table public.ride_network_executions is
  'Réseau partagé : une ligne par acceptation d''une course de A par un chauffeur de B (instantanés validés, contrôles, termes figés, fin). Close par private.ride_network_share_sync seulement. Aucune lecture client.';

-- ----------------------------------------------------------------- réglages réseau d'un chauffeur
create table public.driver_network_settings (
  driver_id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,      -- B
  enabled boolean not null default false,
  accepted_version text check (accepted_version is null or char_length(accepted_version) between 1 and 40),
  accepted_at timestamptz,
  org_allowed boolean not null default true,
  org_updated_at timestamptz,
  org_updated_by uuid references public.users (id) on delete set null,
  capable_at timestamptz,
  excluded_until timestamptz,
  updated_at timestamptz not null default now(),
  constraint driver_network_settings_consent_check check (not enabled or accepted_version is not null),
  foreign key (organization_id, driver_id) references public.drivers (organization_id, id) on delete cascade
);
create index driver_network_settings_org_idx on public.driver_network_settings (organization_id);
comment on table public.driver_network_settings is
  'Réseau partagé : interrupteur et conditions acceptées du chauffeur, autorisation de son organisation, capacité de l''app (capable_at), exclusion temporaire (retraits répétés). Lecture : membres de son organisation et le chauffeur.';

-- ----------------------------------------------------------------- RIB du chauffeur (versements de A)
create table public.driver_payout_details (
  driver_id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  payee_name text not null check (char_length(payee_name) between 2 and 120),
  iban text not null check (iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$'),
  bic text check (bic is null or bic ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
  -- sha256 de l'IBAN normalisé, comparé à ride_network_executions.payout_iban_hash (alerte « IBAN modifié ») ; jamais
  -- lisible côté client (table sans policy, exécutions de même)
  iban_hash text not null check (iban_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, driver_id) references public.drivers (organization_id, id) on delete cascade
);
create index driver_payout_details_org_idx on public.driver_payout_details (organization_id);
comment on table public.driver_payout_details is
  'Réseau partagé : coordonnées bancaires du chauffeur pour les versements des courses prépayées. Aucune lecture client (RPC driver_payout_info / org_network_payout_info).';

-- ----------------------------------------------------------------- index d'identités (S2), jamais lu par un client
create table private.driver_identity_keys (
  driver_id uuid not null references public.drivers (id) on delete cascade,
  organization_id uuid not null,
  kind text not null check (kind in ('phone', 'email', 'vtc_card', 'account')),
  -- private.identity_hashes (toutes les formes du téléphone) ; « account » : private.account_identity_hash(user_id)
  value_hash text not null check (value_hash ~ '^[0-9a-f]{64}$'),
  primary key (driver_id, kind, value_hash)
);
create index driver_identity_keys_lookup_idx on private.driver_identity_keys (kind, value_hash, organization_id);
comment on table private.driver_identity_keys is
  'Empreintes d''identité de chaque fiche chauffeur (téléphone sous toutes ses formes, e-mails, carte VTC, compte), tenues par private.sync_driver_identity_keys (G13). Contrôles du réseau partagé (bannis, débiteurs, fiches de A).';

-- ----------------------------------------------------------------- chauffeurs partenaires exclus par A
create table private.network_driver_exclusions (
  id uuid primary key default gen_random_uuid(),
  giver_org_id uuid not null references public.organizations (id) on delete cascade,
  execution_id uuid references public.ride_network_executions (id) on delete set null,
  label text not null check (char_length(label) between 2 and 200),
  kinds text[] not null,
  value_hashes text[] not null,
  reason text check (reason is null or char_length(reason) <= 300),
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  lifted_at timestamptz,
  constraint network_driver_exclusions_keys_check
    check (cardinality(kinds) between 1 and 50 and cardinality(kinds) = cardinality(value_hashes)
           and kinds <@ array['phone', 'email', 'vtc_card', 'account']::text[])
);
create index network_driver_exclusions_giver_idx on private.network_driver_exclusions (giver_org_id)
  where lifted_at is null;
create index network_driver_exclusions_execution_idx on private.network_driver_exclusions (execution_id)
  where execution_id is not null;
comment on table private.network_driver_exclusions is
  'Réseau partagé : chauffeur partenaire exclu des courses de A, par ses empreintes d''identité (valable même s''il change d''organisation).';

-- ----------------------------------------------------------------- débiteurs réseau au compte supprimé (S2)
create table private.network_debtor_identities (
  id uuid primary key default gen_random_uuid(),
  creditor_org_id uuid not null references public.organizations (id) on delete cascade,     -- A
  driver_id uuid not null references public.drivers (id) on delete cascade,                 -- fiche figée de B
  kind text not null check (kind in ('phone', 'email', 'vtc_card')),
  value_hash text not null check (value_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (creditor_org_id, driver_id, kind, value_hash)
);
create index network_debtor_identities_lookup_idx on private.network_debtor_identities (creditor_org_id, kind, value_hash);
create index network_debtor_identities_driver_idx on private.network_debtor_identities (driver_id);
comment on table private.network_debtor_identities is
  'Réseau partagé : empreintes d''un chauffeur qui a supprimé son compte en devant encore une somme à une organisation donneuse, gardées tant que la dette est ouverte.';

alter table public.network_memberships enable row level security;
alter table public.network_exclusions enable row level security;
alter table public.ride_network_shares enable row level security;
alter table public.ride_network_executions enable row level security;
alter table public.driver_network_settings enable row level security;
alter table public.driver_payout_details enable row level security;
alter table private.driver_identity_keys enable row level security;
alter table private.network_driver_exclusions enable row level security;
alter table private.network_debtor_identities enable row level security;

-- =============================================================================
-- 5. Colonnes ajoutées (§8.3)
-- =============================================================================
alter table public.rides
  add column driver_org_id uuid,
  add column network_at timestamptz;
comment on column public.rides.driver_org_id is
  'Organisation du chauffeur (= organization_id pour une course propre ; B pour une course partagée). Posée par private.rides_executor_guard, jamais par l''appelant.';
comment on column public.rides.network_at is
  'Ouverture du cycle courant de partage au réseau (NULL : course hors réseau). Posée par le dispatch.';

-- is_network : colonne ordinaire (et non « generated » : pas de réécriture de la table sous verrou exclusif), posée
-- par private.set_driver_org_id, figée par private.forbid_driver_org_change, cohérente par contrainte.
alter table public.ride_offers
  add column driver_org_id uuid,
  add column is_network boolean not null default false,
  add column network_terms jsonb;
comment on column public.ride_offers.network_terms is
  'Offre réseau : termes figés montrés au partenaire (contrat NetworkTerms). Illisible côté client (droits par colonne).';

alter table public.ride_assignments add column driver_org_id uuid;
alter table public.notifications add column driver_org_id uuid;
alter table public.ride_alerts add column driver_org_id uuid;

alter table public.ride_settlements
  add column network_driver_id uuid,
  add column network_driver_org_id uuid,
  add column network_execution_id uuid references public.ride_network_executions (id) on delete restrict,
  add column network_counterparty text constraint ride_settlements_network_counterparty_check
    check (network_counterparty is null or network_counterparty = 'driver'),
  add column driver_disputed_at timestamptz,
  add column driver_dispute_reason text check (driver_dispute_reason is null or char_length(driver_dispute_reason) <= 300);
comment on column public.ride_settlements.network_driver_org_id is
  'Règlement réseau (course de A exécutée par un chauffeur de B) : B. Identifie une ligne réseau (jamais driver_id IS NULL). driver_id est alors NULL.';

alter table public.drivers
  add column vtc_operator_registration text
    check (vtc_operator_registration is null or char_length(vtc_operator_registration) between 3 and 80);
comment on column public.drivers.vtc_operator_registration is
  'N° d''inscription au registre des exploitants VTC du chauffeur indépendant (centrale) : champ « exploitant » du bon de réservation d''une course partagée.';

alter table public.driver_location_history add column ride_org_id uuid;
comment on column public.driver_location_history.ride_org_id is
  'Organisation de la course en cours au moment du point : un point d''une course partenaire (≠ organization_id) est invisible pour l''organisation du chauffeur.';

-- =============================================================================
-- 6. Remplissage, sans diffusion temps réel (C22)
-- =============================================================================
-- Toutes les lignes existantes sont des lignes propres : driver_org_id = organization_id dès qu'un chauffeur est
-- cité (is_network reste faux, network_at NULL). Diffusions et date de modification coupées le temps du remplissage.
-- Un UPDATE par table : dans une seule transaction (verrous gardés jusqu'au COMMIT), des lots n'apporteraient rien.
alter table public.rides disable trigger rides_c_broadcast;
alter table public.rides disable trigger rides_touch_updated_at;
alter table public.ride_alerts disable trigger ride_alerts_broadcast;
alter table public.ride_alerts disable trigger ride_alerts_touch_updated_at;

update public.rides set driver_org_id = organization_id where driver_id is not null;
update public.ride_offers set driver_org_id = organization_id where driver_id is not null;
update public.ride_assignments set driver_org_id = organization_id where driver_id is not null;
update public.notifications set driver_org_id = organization_id where driver_id is not null;
update public.ride_alerts set driver_org_id = organization_id where driver_id is not null;

alter table public.rides enable trigger rides_c_broadcast;
alter table public.rides enable trigger rides_touch_updated_at;
alter table public.ride_alerts enable trigger ride_alerts_broadcast;
alter table public.ride_alerts enable trigger ride_alerts_touch_updated_at;

-- =============================================================================
-- 7. Clés étrangères reconstruites sous le même nom, contraintes (§8.3)
-- =============================================================================
-- rides → drivers / vehicles : par l'organisation du chauffeur (le chauffeur et son véhicule appartiennent toujours
-- à l'organisation exécutante). Jamais une seconde clé vers drivers ou vehicles.
alter table public.rides drop constraint rides_organization_id_driver_id_fkey;
alter table public.rides add constraint rides_organization_id_driver_id_fkey
  foreign key (driver_org_id, driver_id) references public.drivers (organization_id, id)
  on delete set null (driver_org_id, driver_id) not valid;
alter table public.rides validate constraint rides_organization_id_driver_id_fkey;

-- Clé simple « MATCH SIMPLE » : une course SANS chauffeur (driver_org_id NULL) n'est plus contrôlée par elle. Même
-- garantie qu'avant par G3 (véhicule d'une course sans chauffeur = véhicule de l'organisation de la course ; véhicule
-- d'un partenaire retiré avec lui) et private.vehicles_detach_rides (véhicule supprimé : courses sans chauffeur
-- détachées, comme le faisait l'ancienne clé (organization_id, vehicle_id)).
alter table public.rides drop constraint rides_organization_id_vehicle_id_fkey;
alter table public.rides add constraint rides_organization_id_vehicle_id_fkey
  foreign key (driver_org_id, vehicle_id) references public.vehicles (organization_id, id)
  on delete set null (vehicle_id) not valid;
alter table public.rides validate constraint rides_organization_id_vehicle_id_fkey;
-- Suppression d'un véhicule (clé ci-dessus et vehicles_detach_rides) : sans index, parcours de toutes les courses
create index rides_vehicle_idx on public.rides (vehicle_id) where vehicle_id is not null;

alter table public.rides add constraint rides_driver_org_check
  check ((driver_id is null) = (driver_org_id is null)) not valid;
alter table public.rides validate constraint rides_driver_org_check;

-- Course en cours d'un chauffeur : clé SIMPLE (une course partagée est d'une autre organisation que le chauffeur) ;
-- G8 (private.drivers_current_ride_guard) : course de son organisation (comme avant) ou tenue par ce chauffeur.
alter table public.drivers drop constraint drivers_current_ride_fk;
alter table public.drivers add constraint drivers_current_ride_fk
  foreign key (current_ride_id) references public.rides (id) on delete set null not valid;
alter table public.drivers validate constraint drivers_current_ride_fk;
create index if not exists drivers_current_ride_idx on public.drivers (current_ride_id) where current_ride_id is not null;

-- Offres
alter table public.ride_offers drop constraint ride_offers_organization_id_driver_id_fkey;
alter table public.ride_offers add constraint ride_offers_organization_id_driver_id_fkey
  foreign key (driver_org_id, driver_id) references public.drivers (organization_id, id) on delete cascade not valid;
alter table public.ride_offers validate constraint ride_offers_organization_id_driver_id_fkey;
alter table public.ride_offers alter column driver_org_id set not null;
alter table public.ride_offers add constraint ride_offers_network_check
  check (is_network = (driver_org_id <> organization_id)) not valid;
alter table public.ride_offers validate constraint ride_offers_network_check;
-- Termes présents si et seulement si offre réseau ; complets et cohérents : contrôlés à l'insertion
-- (private.network_terms_insert_check), jamais par ce CHECK (réévalué à chaque UPDATE de la ligne)
alter table public.ride_offers add constraint ride_offers_network_terms_check
  check (is_network = (network_terms is not null)) not valid;
alter table public.ride_offers validate constraint ride_offers_network_terms_check;

-- Attributions
alter table public.ride_assignments drop constraint ride_assignments_organization_id_driver_id_fkey;
alter table public.ride_assignments add constraint ride_assignments_organization_id_driver_id_fkey
  foreign key (driver_org_id, driver_id) references public.drivers (organization_id, id) on delete cascade not valid;
alter table public.ride_assignments validate constraint ride_assignments_organization_id_driver_id_fkey;
alter table public.ride_assignments alter column driver_org_id set not null;

-- Notifications (driver_org_id NULL si et seulement si driver_id NULL)
alter table public.notifications drop constraint notifications_organization_id_driver_id_fkey;
alter table public.notifications add constraint notifications_organization_id_driver_id_fkey
  foreign key (driver_org_id, driver_id) references public.drivers (organization_id, id) on delete cascade not valid;
alter table public.notifications validate constraint notifications_organization_id_driver_id_fkey;
alter table public.notifications add constraint notifications_driver_org_check
  check ((driver_id is null) = (driver_org_id is null)) not valid;
alter table public.notifications validate constraint notifications_driver_org_check;

-- Alertes de course
alter table public.ride_alerts drop constraint ride_alerts_organization_id_driver_id_fkey;
alter table public.ride_alerts add constraint ride_alerts_organization_id_driver_id_fkey
  foreign key (driver_org_id, driver_id) references public.drivers (organization_id, id)
  on delete set null (driver_id, driver_org_id) not valid;
alter table public.ride_alerts validate constraint ride_alerts_organization_id_driver_id_fkey;
alter table public.ride_alerts add constraint ride_alerts_driver_org_check
  check ((driver_id is null) = (driver_org_id is null)) not valid;
alter table public.ride_alerts validate constraint ride_alerts_driver_org_check;

-- Règlements : clé (organization_id, driver_id) INCHANGÉE (règlements propres) ; ligne réseau par une NOUVELLE clé
-- nommée (tout embed ride_settlements → drivers doit désormais nommer sa clé).
alter table public.ride_settlements add constraint ride_settlements_network_driver_fkey
  foreign key (network_driver_org_id, network_driver_id) references public.drivers (organization_id, id)
  on delete set null (network_driver_id);
alter table public.ride_settlements add constraint ride_settlements_network_check
  check (network_driver_org_id is null
         or (driver_id is null and network_driver_org_id <> organization_id
             and network_counterparty is not null and network_execution_id is not null));
alter table public.ride_settlements add constraint ride_settlements_network_columns_check
  check (network_driver_org_id is not null
         or (network_driver_id is null and network_execution_id is null and network_counterparty is null));

-- =============================================================================
-- 8. Index (§8.3)
-- =============================================================================
create index rides_network_exec_idx on public.rides (driver_org_id, status) where driver_org_id <> organization_id;
create index rides_network_open_idx on public.rides (organization_id, network_at desc) where network_at is not null;
create index ride_offers_network_idx on public.ride_offers (ride_id) where is_network;
create index ride_settlements_network_driver_idx on public.ride_settlements (network_driver_id, due_at)
  where network_driver_org_id is not null and status in ('due', 'declared', 'disputed');
create index ride_settlements_network_org_idx on public.ride_settlements (organization_id, created_at desc)
  where network_driver_org_id is not null;
create index ride_settlements_network_exec_org_idx on public.ride_settlements (network_driver_org_id, created_at desc)
  where network_driver_org_id is not null;
create index ride_settlements_network_execution_idx on public.ride_settlements (network_execution_id)
  where network_execution_id is not null;

-- =============================================================================
-- 9. Aides (§9.1, §9.6, §11.6) : éligibilité d'une organisation, paire, offres réseau, position masquée
-- =============================================================================

-- Raison pour laquelle une organisation ne peut pas partager (p_dir 'out') ou recevoir ('in') ; NULL = éligible.
-- Ordre : network_off, org_inactive, not_sharing / not_receiving, approval_pending, suspended, terms, puis 'out' :
-- online_payment_method, platform_fee, payouts_overdue ; 'in' : insurance (NETWORK_ORG_REASONS de @rydar/shared).
create or replace function private.network_org_reason(p_org uuid, p_dir text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  o record;
  m public.network_memberships;
  s public.organization_settings;
begin
  if p_dir is null or p_dir not in ('out', 'in') then
    raise exception 'network_org_reason : sens inconnu (%)', p_dir using errcode = '22023';
  end if;
  if not public.shared_network_enabled() then
    return 'network_off';
  end if;
  select x.status, x.platform_fee_percent, x.platform_fee_fixed_cents into o
    from public.organizations x where x.id = p_org;
  if not found or o.status <> 'active' then
    return 'org_inactive';
  end if;
  select * into m from public.network_memberships x where x.organization_id = p_org;
  if not found or (p_dir = 'out' and not m.share_out) then
    return case p_dir when 'out' then 'not_sharing' else 'not_receiving' end;
  end if;
  if p_dir = 'in' and not m.share_in then
    return 'not_receiving';
  end if;
  if m.approved_at is null then
    return 'approval_pending';
  end if;
  if m.suspended_at is not null then
    return 'suspended';
  end if;
  if not private.network_terms_ok(m.terms_version) then
    return 'terms';
  end if;
  if p_dir = 'out' then
    select * into s from public.organization_settings x where x.organization_id = p_org;
    if not (coalesce(private.settlement_methods_available(s), '{}'::text[]) && array['link', 'transfer']::text[]) then
      return 'online_payment_method';
    end if;
    if o.platform_fee_percent = 0 and o.platform_fee_fixed_cents = 0 and not m.fee_waiver then
      return 'platform_fee';
    end if;
    if exists (
      select 1 from public.ride_settlements x
       where x.organization_id = p_org
         and x.network_driver_org_id is not null
         and x.direction = 'centrale_owes'
         and x.status = 'due'
         and x.due_at < now() - interval '7 days'
    ) then
      return 'payouts_overdue';
    end if;
  elsif m.insurance_confirmed_at is null then
    return 'insurance';
  end if;
  return null;
end;
$$;

-- Deux organisations peuvent partager dans ce sens (A donne, B exécute) : deux raisons NULL, aucune exclusion.
create or replace function private.network_pair_ok(p_giver uuid, p_exec uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    p_giver <> p_exec
    and private.network_org_reason(p_giver, 'out') is null
    and private.network_org_reason(p_exec, 'in') is null
    and not exists (
      select 1 from public.network_exclusions x
       where (x.organization_id = p_giver and x.excluded_org_id = p_exec)
          or (x.organization_id = p_exec and x.excluded_org_id = p_giver)),
    false);
$$;

-- Ferme les offres réseau en attente (filtres NULL = tous) ; notifications d'offre supprimées par
-- ride_offers_network_closed ; chauffeurs « sollicités » libérés. Renvoie le nombre d'offres fermées.
-- Motifs propres à une course : terms_changed, flight_rescheduled (p_ride obligatoire), driver_busy (p_ride et
-- p_driver) ; network_unavailable, sharing_stopped : par organisation, chauffeur ou course (coupure globale : aucun
-- filtre). Un motif de course sans sa course fermerait les offres de TOUTES les courses de l'organisation.
create or replace function private.close_network_offers(p_giver uuid, p_exec_org uuid, p_driver uuid, p_reason text,
                                                        p_ride uuid default null)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_drivers uuid[];
  v_count integer;
begin
  if p_reason is null
     or p_reason not in ('terms_changed', 'network_unavailable', 'flight_rescheduled', 'sharing_stopped', 'driver_busy') then
    raise exception 'close_network_offers : motif inconnu (%)', p_reason using errcode = '22023';
  end if;
  if (p_reason in ('terms_changed', 'flight_rescheduled') and p_ride is null)
     or (p_reason = 'driver_busy' and (p_ride is null or p_driver is null)) then
    raise exception 'close_network_offers : motif % propre à une course (course, et chauffeur pour driver_busy, obligatoires)',
      p_reason using errcode = '22023';
  end if;
  with upd as (
    update public.ride_offers o
       set status = 'closed', closed_reason = p_reason, responded_at = coalesce(o.responded_at, now())
     where o.is_network
       and o.status = 'pending'
       and (p_ride is null or o.ride_id = p_ride)
       and (p_giver is null or o.organization_id = p_giver)
       and (p_exec_org is null or o.driver_org_id = p_exec_org)
       and (p_driver is null or o.driver_id = p_driver)
    returning o.driver_id
  )
  select count(*)::integer, coalesce(array_agg(distinct upd.driver_id), '{}') into v_count, v_drivers from upd;
  perform private.release_offered_drivers(v_drivers);
  return v_count;
end;
$$;

-- Q5 : le chauffeur fait en ce moment une course d'une autre organisation (sa course en cours) : sa position n'est
-- pas diffusée à son organisation (diffusions du lot accès, fonctions definer). Fonctions serveur seulement : elle
-- répond pour n'importe quel chauffeur (la policy passe par member_drivers_on_foreign_ride, bornée aux organisations
-- du lecteur).
create or replace function private.driver_on_foreign_ride(p_driver uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.drivers d
      join public.rides r on r.id = d.current_ride_id
     where d.id = p_driver
       and r.organization_id <> d.organization_id
       and r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS'));
$$;

-- Même règle, pour la policy driver_locations_select en une fois : chauffeurs des organisations de l'appelant en
-- course partenaire en ce moment (évaluée une seule fois par requête, pas une fois par position lue). Definer :
-- appelée avec le rôle du lecteur, qui ne voit pas la course de l'autre organisation.
create or replace function private.member_drivers_on_foreign_ride()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.id
    from public.drivers d
    join public.rides r on r.id = d.current_ride_id
   where d.organization_id in (select private.member_org_ids())
     and d.current_ride_id is not null
     and r.organization_id <> d.organization_id
     and r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS');
$$;

-- Empreinte du compte de connexion d'une fiche (clé « account » de l'index d'identités).
create or replace function private.account_identity_hash(p_user uuid)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select encode(sha256(convert_to('rydar:account:' || p_user::text, 'UTF8')), 'hex');
$$;

-- Empreintes d'une fiche : téléphone (toutes ses formes), e-mail de la fiche et du compte, carte VTC, compte.
-- Fiche supprimée (anonyme) : aucune.
create or replace function private.driver_identity_keys_of(d public.drivers)
returns table (kind text, value_hash text)
language sql
stable
set search_path = ''
as $$
  select distinct x.kind, x.value_hash
    from (
      select 'phone'::text as kind, unnest(private.identity_hashes('phone', d.phone)) as value_hash
      union all
      select 'email', unnest(private.identity_hashes('email', d.email))
      union all
      select 'email', unnest(private.identity_hashes('email', (select u.email from public.users u where u.id = d.user_id)))
      union all
      select 'vtc_card', unnest(private.identity_hashes('vtc_card', d.vtc_card_number))
      union all
      select 'account', private.account_identity_hash(d.user_id)
    ) x
   where x.value_hash is not null
     and d.deleted_at is null;
$$;

create or replace function private.refresh_driver_identity_keys(p_driver uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  delete from private.driver_identity_keys k where k.driver_id = p_driver;
  insert into private.driver_identity_keys (driver_id, organization_id, kind, value_hash)
  select d.id, d.organization_id, k.kind, k.value_hash
    from public.drivers d
   cross join lateral private.driver_identity_keys_of(d) k
   where d.id = p_driver
  on conflict do nothing;
end;
$$;

-- =============================================================================
-- 10. Gardes G1 à G13 (§8.4) — ne contrôlent que si la colonne change réellement (C17)
-- =============================================================================

-- ----------------------------------------------------------------- G1 : organisation du chauffeur, posée par la base
-- Les insertions existantes (dispatch, attributions, notifications, alertes) restent valides sans changement :
-- driver_org_id (et is_network d'une offre) toujours recalculés depuis drivers, jamais fournis par l'appelant.
-- Chauffeur inconnu : organisation de la ligne (la clé étrangère le refuse alors, comme avant).
create or replace function private.set_driver_org_id()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.driver_id is null then
    new.driver_org_id := null;
  else
    new.driver_org_id := coalesce((select d.organization_id from public.drivers d where d.id = new.driver_id),
                                  new.organization_id);
  end if;
  if tg_table_name = 'ride_offers' then
    new.is_network := new.driver_org_id is distinct from new.organization_id;
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------- G2 : colonnes figées
-- Colonnes passées en arguments du trigger, avec un préfixe éventuel :
--  « ? » seul le passage à NULL est permis (clés étrangères « on delete set null ») ;
--  « + » seule la première valeur est permise (NULL → valeur, posée une fois) ;
--  « * » modifiable seulement par l'effacement des traces d'un compte supprimé (réglage local rydar.network_scrub =
--        on, posé par private.scrub_network_traces, lot administration).
-- Même code que l'organisation d'une ligne : FORBIDDEN_TENANT_CHANGE (42501).
create or replace function private.forbid_driver_org_change()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  c text;
  v_col text;
  v_new jsonb := to_jsonb(new);
  v_old jsonb := to_jsonb(old);
begin
  foreach c in array tg_argv loop
    v_col := ltrim(c, '?+*');
    -- Réglage absent = NULL : coalesce, sinon « not (vrai and NULL) » laisserait passer le changement
    if (v_new -> v_col) is distinct from (v_old -> v_col)
       and not (left(c, 1) = '?' and (v_new -> v_col) = 'null'::jsonb)
       and not (left(c, 1) = '+' and (v_old -> v_col) = 'null'::jsonb)
       and not (left(c, 1) = '*' and coalesce(current_setting('rydar.network_scrub', true), '') = 'on') then
      raise exception 'FORBIDDEN_TENANT_CHANGE: % est immuable', v_col using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;

-- ----------------------------------------------------------------- G3 : chauffeur exécutant d'une course
-- Insertion : network_at et driver_org_id jamais fournis (service role compris). Toujours : driver_org_id =
-- organisation du chauffeur. Chauffeur d'une autre organisation que la course, nouvellement posé : réseau ouvert pour
-- la course (network_at), paire éligible (private.network_pair_ok : interrupteur, adhésions, validations,
-- convention, exclusions) ET offre réseau de CE chauffeur sur cette course, du cycle courant (envoyée depuis
-- network_at), en attente ou acceptée ; sinon FORBIDDEN_TENANT (42501), même pour une fonction definer.
-- Course tenue par un partenaire : network_at ne change qu'avec le chauffeur (retrait, réattribution), sinon
-- FORBIDDEN_TENANT_CHANGE (le partage serait clos ou rouvert sous une exécution ouverte).
-- Véhicule (la clé (driver_org_id, vehicle_id) ne contrôle pas une course sans chauffeur) : partenaire retiré → son
-- véhicule part avec lui ; course sans chauffeur → véhicule de l'organisation de la course (ancienne clé
-- (organization_id, vehicle_id), 23503 sinon).
create or replace function private.rides_executor_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if tg_op = 'INSERT' then
    new.network_at := null;
  elsif old.driver_id is not null and old.driver_org_id <> old.organization_id
        and new.driver_id is not distinct from old.driver_id
        and new.network_at is distinct from old.network_at then
    raise exception 'FORBIDDEN_TENANT_CHANGE: network_at d''une course tenue par un chauffeur partenaire'
      using errcode = '42501';
  end if;
  if new.driver_id is null then
    new.driver_org_id := null;
    if tg_op = 'UPDATE' and old.driver_id is not null and old.driver_org_id <> old.organization_id then
      new.vehicle_id := null;
    end if;
    if new.vehicle_id is not null
       and (tg_op = 'INSERT' or new.vehicle_id is distinct from old.vehicle_id)
       and not exists (select 1 from public.vehicles v
                        where v.id = new.vehicle_id and v.organization_id = new.organization_id) then
      raise exception 'rides_organization_id_vehicle_id_fkey : véhicule absent de l''organisation d''une course sans chauffeur'
        using errcode = '23503', constraint = 'rides_organization_id_vehicle_id_fkey';
    end if;
    return new;
  end if;
  select d.organization_id into v_org from public.drivers d where d.id = new.driver_id;
  -- Chauffeur inconnu : la clé étrangère le refuse (23503), comme avant
  new.driver_org_id := coalesce(v_org, new.organization_id);
  if new.driver_org_id <> new.organization_id
     and (tg_op = 'INSERT' or new.driver_id is distinct from old.driver_id) then
    if new.network_at is null
       or not private.network_pair_ok(new.organization_id, new.driver_org_id)
       or not exists (
         select 1 from public.ride_offers o
          where o.ride_id = new.id
            and o.driver_id = new.driver_id
            and o.is_network
            and o.sent_at >= new.network_at
            and o.status in ('pending', 'accepted')) then
      raise exception 'FORBIDDEN_TENANT: chauffeur d''une autre organisation sans offre du réseau partagé pour cette course'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- G3 (suite) : véhicule supprimé → courses SANS chauffeur qui le citent détachées (la clé (driver_org_id, vehicle_id)
-- ne détache que celles qui ont un chauffeur ; l'ancienne clé (organization_id, vehicle_id) les détachait toutes).
-- Definer : rides.vehicle_id sans droit client en écriture (véhicule supprimé par owner / admin).
create or replace function private.vehicles_detach_rides()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.rides r set vehicle_id = null where r.vehicle_id = old.id and r.driver_id is null;
  return null;
end;
$$;

-- ----------------------------------------------------------------- G4 : lignes filles d'un chauffeur partenaire
-- Chauffeur de l'organisation de la ligne (ou aucun) : règles actuelles, rien à contrôler. Sinon :
--  * offre réseau en attente : réseau ouvert pour la course et paire éligible ;
--  * marqueur d'offre close (« retiré », C1), attribution, alerte : course tenue (ou en cours d'exécution) par ce
--    chauffeur — même après une coupure, une exclusion ou une suspension ;
--  * notification : course liée au chauffeur (offre, attribution, exécution) ; sans course, une ligne réseau
--    existe entre l'organisation et ce chauffeur, quel que soit son statut (C2).
create or replace function private.network_child_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_pending boolean := false;
  v_ok boolean;
begin
  if new.driver_id is null or new.driver_org_id is not distinct from new.organization_id then
    return new;
  end if;
  -- Champs propres à une table lus dans des instructions séparées (préparées seulement pour cette table)
  if tg_table_name = 'ride_offers' then
    v_pending := new.status = 'pending';
  end if;

  if tg_table_name = 'notifications' and new.ride_id is null then
    v_ok := exists (
      select 1 from public.ride_settlements x
       where x.organization_id = new.organization_id and x.network_driver_id = new.driver_id);
  else
    select x.driver_id, x.network_at into r
      from public.rides x
     where x.id = new.ride_id and x.organization_id = new.organization_id;
    if v_pending then
      v_ok := r.network_at is not null and private.network_pair_ok(new.organization_id, new.driver_org_id);
    elsif tg_table_name = 'notifications' then
      v_ok := r.driver_id is not distinct from new.driver_id
        or exists (select 1 from public.ride_offers o where o.ride_id = new.ride_id and o.driver_id = new.driver_id)
        or exists (select 1 from public.ride_assignments a where a.ride_id = new.ride_id and a.driver_id = new.driver_id)
        or exists (select 1 from public.ride_network_executions e
                    where e.ride_id = new.ride_id and e.executor_driver_id = new.driver_id);
    else
      v_ok := r.driver_id is not distinct from new.driver_id
        or exists (select 1 from public.ride_network_executions e
                    where e.ride_id = new.ride_id and e.executor_driver_id = new.driver_id and e.ended_at is null);
    end if;
  end if;

  if not coalesce(v_ok, false) then
    raise exception 'FORBIDDEN_TENANT: chauffeur d''une autre organisation sans lien réseau avec cette course'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------- G5 : règlement réseau
-- Exécution de CETTE course, même organisation, même chauffeur, même organisation exécutante et contrepartie.
create or replace function private.network_settlement_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.network_driver_org_id is null then
    return new;
  end if;
  if not exists (
    select 1 from public.ride_network_executions e
     where e.id = new.network_execution_id
       and e.ride_id = new.ride_id
       and e.organization_id = new.organization_id
       and e.executor_org_id = new.network_driver_org_id
       and e.executor_driver_id = new.network_driver_id
       and e.counterparty = new.network_counterparty) then
    raise exception 'FORBIDDEN_TENANT: règlement réseau sans exécution correspondante' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------- G6 : course confiée verrouillée
-- Exécution réseau ouverte, ou close en « completed », et prix, paiement, adresses, coordonnées, heure, catégorie,
-- passagers, bagages, n° de vol ou commission SAISIE modifiés : NETWORK_RIDE_LOCKED (55000). Le n° de vol aussi : le
-- suivi de vol déplacerait ensuite l'heure selon le retard du NOUVEAU vol (jusqu'à 12 h). Exceptions : heure SEULE
-- changée par le suivi de vol (réglage local rydar.network_flight_update = on, posé par apply_flight_status ; n° de vol
-- inchangé) ; commission recalculée par le système (répartition automatique, ni avant ni après saisie manuelle :
-- changement de modèle de A, termes figés de toute façon). Definer : l'exécution est illisible pour le membre qui
-- modifie la course.
-- Déclenchée (clause WHEN) seulement sur une course passée par le réseau ou tenue par un chauffeur d'une autre
-- organisation, et si l'une de ces valeurs change : coût nul pour les autres courses.
create or replace function private.rides_network_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('rydar.network_flight_update', true) = 'on'
     and (new.price_cents, new.payment_method, new.pickup_address, new.pickup_lat, new.pickup_lng, new.dropoff_address,
          new.dropoff_lat, new.dropoff_lng, new.vehicle_category, new.passengers, new.luggage, new.flight_number)
         is not distinct from
         (old.price_cents, old.payment_method, old.pickup_address, old.pickup_lat, old.pickup_lng, old.dropoff_address,
          old.dropoff_lat, old.dropoff_lng, old.vehicle_category, old.passengers, old.luggage, old.flight_number)
     and not ((new.commission_manual or old.commission_manual) and new.commission_cents is distinct from old.commission_cents) then
    return new;
  end if;
  if exists (
    select 1 from public.ride_network_executions e
     where e.ride_id = old.id
       and (e.ended_at is null or e.end_reason = 'completed')) then
    raise exception 'NETWORK_RIDE_LOCKED: course confiée à un partenaire : retirez-la-lui pour la modifier'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------- G7 : fiche avec des obligations réseau
-- Course d'une autre organisation attribuée et non terminée, ou ligne réseau ouverte (dans les deux sens) :
-- suppression refusée (seul l'archivage reste possible, S5). Definer : lignes de A illisibles pour B.
create or replace function private.drivers_network_delete_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
       select 1 from public.rides r
        where r.driver_id = old.id
          and r.organization_id <> old.organization_id
          and r.status not in ('COMPLETED', 'CANCELLED', 'NO_DRIVER_FOUND'))
     or exists (
       select 1 from public.ride_settlements x
        where x.network_driver_id = old.id
          and x.network_driver_org_id is not null
          and x.status in ('due', 'declared', 'disputed')) then
    raise exception 'DRIVER_HAS_NETWORK_OBLIGATIONS: course ou règlement en cours avec une organisation partenaire'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

-- G7 (suite) : statut retiré DIRECTEMENT (droit par colonne des owner / admin de B, écriture sans RPC) alors que le
-- chauffeur tient une course d'une autre organisation non terminée : refusé (fiche inactive → plus de session, la
-- course de A resterait attribuée sans que personne ne puisse la finir). Les RPC (set_driver_status, ban_driver :
-- definer, lot dispatch) retirent d'abord la course partagée (unassign_network_ride) ou refusent si le client est à
-- bord. Clause WHEN (current_user = 'authenticated') : clients seulement. Definer : courses de A illisibles pour B.
create or replace function private.drivers_network_status_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.rides r
     where r.driver_id = old.id
       and r.organization_id <> old.organization_id
       and r.status not in ('COMPLETED', 'CANCELLED', 'NO_DRIVER_FOUND')) then
    raise exception 'DRIVER_HAS_NETWORK_OBLIGATIONS: course d''une organisation partenaire en cours, statut à changer par set_driver_status'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------- G8 : course en cours d'un chauffeur
-- Clé étrangère simple (une course partagée est d'une autre organisation) : une course de son organisation, comme
-- l'ancienne clé composite (comportement inchangé), ou une course d'une autre organisation qu'il tient lui-même.
-- Contrôle immédiat, pas de clé différée (qui ferait échouer dispatch_tick au COMMIT).
create or replace function private.drivers_current_ride_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.current_ride_id is not null
     and (tg_op = 'INSERT' or new.current_ride_id is distinct from old.current_ride_id)
     and not exists (
       select 1 from public.rides r
        where r.id = new.current_ride_id
          and (r.organization_id = new.organization_id or r.driver_id = new.id)) then
    raise exception 'FORBIDDEN_TENANT: course en cours d''une autre organisation, tenue par un autre chauffeur'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------- G9 : termes modifiés pendant la recherche réseau
-- Course proposée au réseau, sans chauffeur, et dont un élément de l'offre change : offres réseau en attente de CETTE
-- course fermées (« terms_changed », notifications d'offre supprimées, chauffeurs libérés : close_network_offers) ;
-- reproposées à la vague suivante avec les nouveaux termes (une offre « terms_changed » n'exclut pas le chauffeur).
-- Definer : écriture depuis le tableau de bord.
create or replace function private.rides_network_terms_watch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.close_network_offers(new.organization_id, null, null, 'terms_changed', new.id);
  return null;
end;
$$;

-- ----------------------------------------------------------------- G10 : état du partage et fin d'exécution
-- Seul endroit qui tient ride_network_shares et clôt ride_network_executions :
--  * network_at posé ou changé : ouverture (cycle 1) ou réouverture (cycle + 1, compteurs remis à zéro) ;
--  * chauffeur partenaire posé : « accepted » ; retiré, réseau toujours ouvert : de nouveau « open » ;
--  * chauffeur propre posé : « reassigned_own » ; network_at → NULL : « closed » ;
--  * COMPLETED (partenaire) : « completed », quelle que soit la voie (close_network_ride : motif « closed_by_giver »
--    dans suspect_reasons, posé par elle) ; CANCELLED : « cancelled » ou « not_performed »
--    (private.expire_unstarted_rides, C24) ; NO_DRIVER_FOUND : « no_driver ».
-- Motif précis passé par l'appelant (réglage local rydar.network_reason : removed_by_giver, executor_released,
-- executor_unavailable, not_performed, window_elapsed, flight_rescheduled, error, sharing_stopped, redispatch…),
-- sinon motif par défaut. Étape (rydar.network_stage) déduite sinon : instantanée ; planifiée avant
-- prise en charge − scheduled_dispatch_lead_minutes de A : « scheduled_window », après : « scheduled_geo ».
-- Émet « network.updated » sur org:{A} avec l'id de la course seulement. Definer : tables sans droits client.
-- Nommé rides_c_network (avant rides_d_settlement et rides_e_platform_fee) : à la fin de course, règlement et frais
-- Rydar lisent une exécution déjà close « completed ».
create or replace function private.ride_network_share_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := nullif(current_setting('rydar.network_reason', true), '');
  v_old_partner boolean := old.driver_id is not null and old.driver_org_id <> old.organization_id;
  v_new_partner boolean := new.driver_id is not null and new.driver_org_id <> new.organization_id;
  v_own boolean := new.driver_id is not null and new.driver_org_id = new.organization_id;
  v_driver_changed boolean := new.driver_id is distinct from old.driver_id;
  v_ended boolean := new.status is distinct from old.status
                     and new.status in ('COMPLETED', 'CANCELLED', 'NO_DRIVER_FOUND');
  v_not_performed boolean := new.status = 'CANCELLED'
    and (v_reason = 'not_performed' or (new.cancelled_by_type = 'system' and new.cancel_reason like 'Non effectuée%'));
  v_closed_reasons text[] := array['cancelled', 'no_driver', 'redispatch', 'removed_by_giver', 'reassigned_own',
    'executor_unavailable', 'executor_released', 'window_elapsed', 'flight_rescheduled', 'error', 'not_performed',
    'sharing_stopped'];
  v_end text;
  v_close text;
  v_stage text;
  v_version text;
  v_lead integer;
  s public.ride_network_shares;
  v_touched boolean := false;
begin
  -- 1. Exécution du partenaire close (la course n'est plus tenue par lui, ou elle est finie)
  if v_old_partner and (v_driver_changed or v_ended) then
    v_end := case
      when not v_driver_changed and new.status = 'COMPLETED' then 'completed'
      when v_ended and new.status = 'CANCELLED' then
        case when v_not_performed then 'not_performed' else 'cancelled_by_giver' end
      when v_own then 'reassigned_own'
      when v_reason in ('removed_by_giver', 'executor_released', 'executor_unavailable') then v_reason
      else 'removed_by_giver'
    end;
    update public.ride_network_executions e
       set ended_at = now(), end_reason = v_end
     where e.ride_id = new.id and e.ended_at is null;
  end if;

  -- 2. Partage de la course
  select * into s from public.ride_network_shares x where x.ride_id = new.id for update;

  if new.network_at is not null and new.network_at is distinct from old.network_at then
    v_stage := nullif(current_setting('rydar.network_stage', true), '');
    if v_stage is null or v_stage not in ('instant', 'scheduled_window', 'scheduled_geo') then
      select coalesce(x.scheduled_dispatch_lead_minutes, 60) into v_lead
        from public.organization_settings x where x.organization_id = new.organization_id;
      v_stage := case
        when new.type = 'instant' then 'instant'
        when now() < new.pickup_at - make_interval(mins => coalesce(v_lead, 60)) then 'scheduled_window'
        else 'scheduled_geo'
      end;
    end if;
    v_version := coalesce(
      (select m.terms_version from public.network_memberships m where m.organization_id = new.organization_id),
      (select p.network_terms_version from public.platform_settings p where p.id));
    if s.ride_id is null then
      insert into public.ride_network_shares (ride_id, organization_id, status, cycle, opened_at, opened_stage,
                                              giver_terms_version)
      values (new.id, new.organization_id, 'open', 1, new.network_at, v_stage, v_version);
    else
      update public.ride_network_shares x
         set status = 'open', cycle = x.cycle + 1, opened_at = new.network_at, opened_stage = v_stage,
             giver_terms_version = v_version, partners_offered = 0, errors = 0, closed_at = null,
             closed_reason = null, updated_at = now()
       where x.ride_id = new.id;
    end if;
    v_touched := true;
  elsif s.ride_id is not null and s.status in ('open', 'accepted') then
    if v_ended then
      if new.status = 'COMPLETED' and v_new_partner then
        update public.ride_network_shares x
           set status = 'completed', closed_at = now(), updated_at = now()
         where x.ride_id = new.id;
        v_touched := true;
      else
        v_close := case new.status
          when 'CANCELLED' then case when v_not_performed then 'not_performed' else 'cancelled' end
          when 'NO_DRIVER_FOUND' then 'no_driver'
          else 'reassigned_own'
        end;
      end if;
    elsif v_driver_changed then
      if v_own then
        v_close := 'reassigned_own';
      elsif v_new_partner then
        update public.ride_network_shares x set status = 'accepted', updated_at = now() where x.ride_id = new.id;
        v_touched := true;
      elsif new.network_at is null then
        v_close := case when v_reason = any (v_closed_reasons) then v_reason else 'removed_by_giver' end;
      else
        update public.ride_network_shares x set status = 'open', updated_at = now() where x.ride_id = new.id;
        v_touched := true;
      end if;
    elsif new.network_at is null and old.network_at is not null then
      v_close := case when v_reason = any (v_closed_reasons) then v_reason else 'redispatch' end;
    end if;
    if v_close is not null then
      update public.ride_network_shares x
         set status = 'closed', closed_at = now(), closed_reason = v_close, updated_at = now()
       where x.ride_id = new.id;
      v_touched := true;
    end if;
  end if;

  if v_touched and current_setting('rydar.bypass_ride_rules', true) is distinct from 'on' then
    perform realtime.send(jsonb_build_object('ride_id', new.id), 'network.updated',
      'org:' || new.organization_id::text, true);
  end if;
  return null;
end;
$$;

-- Exécution créée ou changée d'état : org:{A} reçoit l'id de la course, org:{B} l'id de l'exécution SEULEMENT (S14).
create or replace function private.broadcast_network_execution()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('rydar.bypass_ride_rules', true) = 'on' then
    return null;
  end if;
  perform realtime.send(jsonb_build_object('ride_id', new.ride_id), 'network.updated',
    'org:' || new.organization_id::text, true);
  perform realtime.send(jsonb_build_object('execution_id', new.id), 'network.updated',
    'org:' || new.executor_org_id::text, true);
  return null;
end;
$$;

-- Offre réseau fermée (ni en attente, ni acceptée) : notifications d'offre de ce chauffeur pour cette course
-- supprimées (le push déjà parti ne contient pas d'adresse précise, §9.6).
create or replace function private.ride_offers_network_closed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.notifications n
   where n.ride_id = new.ride_id
     and n.driver_id = new.driver_id
     and n.type in ('ride_offer', 'ride_offer_scheduled');
  return null;
end;
$$;

-- ----------------------------------------------------------------- G11 : identité de l'organisation modifiée
-- Nom, raison sociale, SIRET ou n° VTC modifié d'une organisation validée : validation perdue (instantané conservé :
-- « nouvelle vérification nécessaire »), offres réseau fermées dans les deux sens, audit « network.approval_lost »
-- (compteur « à revalider » du super admin, S11). Definer : écriture depuis le tableau de bord (owner / admin).
create or replace function private.organizations_network_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fields text[];
  v_closed integer;
begin
  v_fields := array_remove(array[
    case when new.name is distinct from old.name then 'name' end,
    case when new.legal_name is distinct from old.legal_name then 'legal_name' end,
    case when new.siret is distinct from old.siret then 'siret' end,
    case when new.vtc_registration is distinct from old.vtc_registration then 'vtc_registration' end], null);
  if cardinality(v_fields) = 0 then
    return null;
  end if;
  update public.network_memberships m
     set approved_at = null, updated_at = now(), updated_by = auth.uid()
   where m.organization_id = new.id and m.approved_at is not null;
  if not found then
    return null;
  end if;
  v_closed := private.close_network_offers(new.id, null, null, 'sharing_stopped')
            + private.close_network_offers(null, new.id, null, 'sharing_stopped');
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (new.id,
          case when auth.uid() is null then 'system' when private.is_super_admin() then 'super_admin' else 'user' end::public.actor_type,
          auth.uid(), 'network.approval_lost', 'network_memberships', new.id::text, 'warning',
          jsonb_build_object('fields', to_jsonb(v_fields), 'closed_offers', v_closed));
  return null;
end;
$$;

-- ----------------------------------------------------------------- G12 : moyens de paiement pendant le partage
-- Partage demandé (share_out), réseau ouvert : retirer le dernier moyen « en ligne » (lien, virement) proposé aux
-- chauffeurs partenaires est refusé (S21). Definer : settlement_methods_available réservée aux fonctions serveur.
create or replace function private.organization_settings_network_methods()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.settlement_methods, new.settlement_link, new.settlement_iban, new.settlement_bic, new.settlement_payee_name,
      new.settlement_instructions)
     is not distinct from
     (old.settlement_methods, old.settlement_link, old.settlement_iban, old.settlement_bic, old.settlement_payee_name,
      old.settlement_instructions) then
    return new;
  end if;
  if public.shared_network_enabled()
     and exists (select 1 from public.network_memberships m where m.organization_id = new.organization_id and m.share_out)
     and (coalesce(private.settlement_methods_available(old), '{}'::text[]) && array['link', 'transfer']::text[])
     and not (coalesce(private.settlement_methods_available(new), '{}'::text[]) && array['link', 'transfer']::text[]) then
    raise exception 'NETWORK_PAYMENT_METHODS_REQUIRED: dernier moyen de paiement en ligne retiré pendant le partage'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------- G13 : index d'identités
-- Fiche créée, téléphone / e-mail / carte VTC / compte changés, fiche supprimée (anonyme) ; e-mail du compte changé.
-- Definer : écrit une table private depuis le tableau de bord (fiche modifiée par un membre).
create or replace function private.sync_driver_identity_keys()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_driver uuid;
begin
  if tg_table_name = 'users' then
    if new.email is not distinct from old.email then
      return null;
    end if;
    for v_driver in select d.id from public.drivers d where d.user_id = new.id loop
      perform private.refresh_driver_identity_keys(v_driver);
    end loop;
    return null;
  end if;
  if tg_op = 'UPDATE'
     and (new.phone, new.email, new.vtc_card_number, new.user_id, new.deleted_at)
         is not distinct from (old.phone, old.email, old.vtc_card_number, old.user_id, old.deleted_at) then
    return null;
  end if;
  perform private.refresh_driver_identity_keys(new.id);
  return null;
end;
$$;

-- ----------------------------------------------------------------- triggers
-- G1 + G4 (noms : *_driver_org avant *_network_guard, ordre alphabétique des déclencheurs BEFORE)
create trigger ride_offers_driver_org before insert on public.ride_offers
  for each row execute function private.set_driver_org_id();
create trigger ride_offers_network_guard before insert on public.ride_offers
  for each row execute function private.network_child_guard();
create trigger ride_assignments_driver_org before insert on public.ride_assignments
  for each row execute function private.set_driver_org_id();
create trigger ride_assignments_network_guard before insert on public.ride_assignments
  for each row execute function private.network_child_guard();
create trigger notifications_driver_org before insert on public.notifications
  for each row execute function private.set_driver_org_id();
create trigger notifications_network_guard before insert on public.notifications
  for each row execute function private.network_child_guard();
create trigger ride_alerts_driver_org before insert on public.ride_alerts
  for each row execute function private.set_driver_org_id();
create trigger ride_alerts_network_guard before insert on public.ride_alerts
  for each row execute function private.network_child_guard();

-- Termes figés validés à l'insertion seulement (après G1, qui pose is_network)
create trigger ride_offers_network_terms before insert on public.ride_offers
  for each row execute function private.network_terms_insert_check();
create trigger ride_network_executions_terms before insert on public.ride_network_executions
  for each row execute function private.network_terms_insert_check();

-- G2 : colonnes figées (préfixes : « ? » passage à NULL permis, « + » posée une fois, « * » effacement des traces)
create trigger ride_offers_driver_org_frozen before update of driver_org_id, driver_id, is_network, network_terms
  on public.ride_offers
  for each row execute function private.forbid_driver_org_change('driver_org_id', 'driver_id', 'is_network', 'network_terms');
create trigger ride_assignments_driver_org_frozen before update of driver_org_id, driver_id on public.ride_assignments
  for each row execute function private.forbid_driver_org_change('driver_org_id', 'driver_id');
-- Notifications : clé « on delete cascade », jamais de passage à NULL (une notification de partenaire, organization_id
-- = A, deviendrait lisible par tous les membres de A par la clause « driver_id is null » de notifications_select)
create trigger notifications_driver_org_frozen before update of driver_org_id, driver_id on public.notifications
  for each row execute function private.forbid_driver_org_change('driver_org_id', 'driver_id');
create trigger ride_alerts_driver_org_frozen before update of driver_org_id, driver_id on public.ride_alerts
  for each row execute function private.forbid_driver_org_change('?driver_org_id', '?driver_id');
create trigger ride_settlements_network_frozen
  before update of network_driver_org_id, network_driver_id, network_execution_id, network_counterparty
  on public.ride_settlements
  for each row execute function private.forbid_driver_org_change(
    'network_driver_org_id', '?network_driver_id', 'network_execution_id', 'network_counterparty');
-- Exécutions : termes et instantanés (étiquette montrée à A, contrôles des documents U3, exploitant, véhicule) figés ;
-- étiquette et contrôles réduits seulement par l'effacement des traces (§10.10) ; empreinte du RIB posée une fois
create trigger ride_network_executions_frozen
  before update of ride_id, executor_org_id, executor_driver_id, offer_id, counterparty, driver_label, operator, vehicle,
    checks, terms, giver_terms_version, executor_terms_version, driver_terms_version, accepted_at, payout_iban_hash,
    payout_iban_at
  on public.ride_network_executions
  for each row execute function private.forbid_driver_org_change(
    'ride_id', 'executor_org_id', '?executor_driver_id', 'offer_id', 'counterparty', '*driver_label', 'operator',
    'vehicle', '*checks', 'terms', 'giver_terms_version', 'executor_terms_version', 'driver_terms_version', 'accepted_at',
    '+payout_iban_hash', '+payout_iban_at');
create trigger ride_network_shares_frozen before update of ride_id on public.ride_network_shares
  for each row execute function private.forbid_driver_org_change('ride_id');
create trigger network_exclusions_frozen before update of excluded_org_id on public.network_exclusions
  for each row execute function private.forbid_driver_org_change('excluded_org_id');
create trigger driver_network_settings_frozen before update of driver_id on public.driver_network_settings
  for each row execute function private.forbid_driver_org_change('driver_id');
create trigger driver_payout_details_frozen before update of driver_id on public.driver_payout_details
  for each row execute function private.forbid_driver_org_change('driver_id');

-- organization_id immuable, updated_at des nouvelles tables
do $$
declare
  t text;
begin
  foreach t in array array['network_memberships', 'network_exclusions', 'ride_network_shares', 'ride_network_executions',
                           'driver_network_settings', 'driver_payout_details'] loop
    execute format('create trigger %I before update of organization_id on public.%I for each row execute function private.forbid_org_change()',
      t || '_forbid_org_change', t);
  end loop;
  foreach t in array array['network_memberships', 'ride_network_shares', 'driver_network_settings', 'driver_payout_details'] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.touch_updated_at()',
      t || '_touch_updated_at', t);
  end loop;
end;
$$;

-- G3 (après rides_before_insert, qui retire le chauffeur d'une course créée par l'API ou le tableau de bord)
create trigger rides_executor_guard before insert or update of driver_id, driver_org_id, network_at, vehicle_id
  on public.rides
  for each row execute function private.rides_executor_guard();
create trigger vehicles_detach_rides after delete on public.vehicles
  for each row execute function private.vehicles_detach_rides();

-- G5
create trigger ride_settlements_network_guard before insert on public.ride_settlements
  for each row execute function private.network_settlement_guard();

-- G6 : clause WHEN évaluée sur la ligne déjà modifiée par les déclencheurs précédents (répartition, vol)
create trigger rides_network_lock before update on public.rides
  for each row
  when ((old.network_at is not null or old.driver_org_id <> old.organization_id)
        and ((new.price_cents, new.payment_method, new.pickup_address, new.pickup_lat, new.pickup_lng,
              new.dropoff_address, new.dropoff_lat, new.dropoff_lng, new.pickup_at, new.vehicle_category, new.passengers,
              new.luggage, new.flight_number)
             is distinct from
             (old.price_cents, old.payment_method, old.pickup_address, old.pickup_lat, old.pickup_lng,
              old.dropoff_address, old.dropoff_lat, old.dropoff_lng, old.pickup_at, old.vehicle_category, old.passengers,
              old.luggage, old.flight_number)
             or ((new.commission_manual or old.commission_manual)
                 and new.commission_cents is distinct from old.commission_cents)))
  execute function private.rides_network_lock();

-- G7
create trigger drivers_network_delete_guard before delete on public.drivers
  for each row execute function private.drivers_network_delete_guard();
create trigger drivers_network_status_guard before update of status on public.drivers
  for each row
  when (current_user = 'authenticated' and old.status = 'active' and new.status is distinct from 'active')
  execute function private.drivers_network_status_guard();

-- G8
create trigger drivers_current_ride_guard before insert or update of current_ride_id on public.drivers
  for each row execute function private.drivers_current_ride_guard();

-- G9 : éléments de l'offre (§9.4) modifiés pendant la recherche réseau
create trigger rides_h_network_terms after update on public.rides
  for each row
  when (new.network_at is not null and new.driver_id is null
        and (new.price_cents, new.payment_method, new.commission_cents, new.platform_fee_cents, new.driver_payout_cents,
             new.pickup_address, new.pickup_lat, new.pickup_lng, new.dropoff_address, new.dropoff_lat, new.dropoff_lng,
             new.pickup_at, new.vehicle_category, new.passengers, new.luggage)
            is distinct from
            (old.price_cents, old.payment_method, old.commission_cents, old.platform_fee_cents, old.driver_payout_cents,
             old.pickup_address, old.pickup_lat, old.pickup_lng, old.dropoff_address, old.dropoff_lat, old.dropoff_lng,
             old.pickup_at, old.vehicle_category, old.passengers, old.luggage))
  execute function private.rides_network_terms_watch();

-- G10 : seulement pour une course passée par le réseau ou tenue par un chauffeur d'une autre organisation
create trigger rides_c_network after update of network_at, driver_id, status on public.rides
  for each row
  when (new.network_at is not null or old.network_at is not null
        or new.driver_org_id <> new.organization_id or old.driver_org_id <> old.organization_id)
  execute function private.ride_network_share_sync();

-- Acceptation, fin, contrôles de fin, retenue, contestations (pas les compteurs de lecture des données client)
create trigger ride_network_executions_broadcast
  after insert or update of ended_at, end_reason, suspect_reasons, hold_until, contested_at, driver_disputed_at
  on public.ride_network_executions
  for each row execute function private.broadcast_network_execution();

create trigger ride_offers_network_closed after update of status on public.ride_offers
  for each row
  when (new.is_network and new.status not in ('pending', 'accepted') and new.status is distinct from old.status)
  execute function private.ride_offers_network_closed();

-- G11
create trigger organizations_network_identity after update of name, legal_name, siret, vtc_registration
  on public.organizations
  for each row execute function private.organizations_network_identity();

-- G12
create trigger organization_settings_network_methods
  before update of settlement_methods, settlement_link, settlement_iban, settlement_bic, settlement_payee_name,
    settlement_instructions
  on public.organization_settings
  for each row execute function private.organization_settings_network_methods();

-- G13
create trigger drivers_identity_keys after insert or update of phone, email, vtc_card_number, user_id, deleted_at
  on public.drivers
  for each row execute function private.sync_driver_identity_keys();
create trigger users_driver_identity_keys after update of email on public.users
  for each row execute function private.sync_driver_identity_keys();

-- ----------------------------------------------------------------- n° d'exploitant VTC : owner / admin
-- Dernière définition : 20260924004300_audit_droits.sql. Seul ajout : drivers.vtc_operator_registration (réseau
-- partagé) réservé aux owner / admin, comme statut, confiance et suspension (droit par colonne ci-dessous).
create or replace function private.drivers_admin_columns_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated'
     and (new.status, new.trust_level, new.suspended_reason, new.vtc_operator_registration)
         is distinct from (old.status, old.trust_level, old.suspended_reason, old.vtc_operator_registration)
     and not private.has_org_role(old.organization_id, array['owner', 'admin']::public.org_role[]) then
    raise exception 'FORBIDDEN_ROLE: statut, niveau de confiance, suspension et n° d''exploitant d''un chauffeur réservés aux administrateurs de l''organisation'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists drivers_admin_columns_guard on public.drivers;
create trigger drivers_admin_columns_guard
  before update of status, trust_level, suspended_reason, vtc_operator_registration on public.drivers
  for each row execute function private.drivers_admin_columns_guard();

-- =============================================================================
-- 11. Policies (§8.5)
-- =============================================================================
-- Dernières définitions : 20260924000300_security.sql (ride_offers, ride_assignments, driver_locations,
-- driver_location_history), 20260924004300_audit_droits.sql (notifications) et 20260924006650_audit_fixes.sql (rides :
-- clause chauffeur limitée à 24 h après la fin, gardée à l'identique).
-- Inchangées : ride_settlements_select (A lit ses lignes réseau, sans aucune donnée bancaire : l'empreinte du RIB est
-- dans ride_network_executions) et ride_alerts_select. Identifiant résiduel accepté chez A (§8.5) : l'UUID de la fiche
-- EXÉCUTANTE dans rides.driver_id, ride_settlements.network_driver_id et ride_alerts.driver_id (alerte de la course
-- qu'il tient : même valeur que rides.driver_id, gardée pour la clé « on delete set null » et l'effacement des
-- traces) ; opaque, sans chemin d'accès ; jamais celui d'un partenaire non retenu.

-- Courses : la clause chauffeur ne couvre que SES courses propres (course partagée : RPC driver_ride, lot accès)
drop policy rides_select on public.rides;
create policy rides_select on public.rides for select to authenticated
  using (
    organization_id in (select private.member_org_ids())
    or (driver_id is not null and driver_id = (select private.current_driver_id()) and driver_org_id = organization_id
        and (status not in ('COMPLETED', 'CANCELLED', 'NO_DRIVER_FOUND') or updated_at > now() - interval '24 hours'))
    or (select private.is_super_admin())
  );

-- Offres : les membres de A ne voient pas les offres réseau (ni qui chez B a été sollicité)
drop policy ride_offers_select on public.ride_offers;
create policy ride_offers_select on public.ride_offers for select to authenticated
  using (
    (organization_id in (select private.member_org_ids()) and not is_network)
    or driver_id = (select private.current_driver_id())
    or (select private.is_super_admin())
  );

-- Attributions : les membres ne voient que celles de leurs chauffeurs
drop policy ride_assignments_select on public.ride_assignments;
create policy ride_assignments_select on public.ride_assignments for select to authenticated
  using (
    (organization_id in (select private.member_org_ids()) and driver_org_id = organization_id)
    or driver_id = (select private.current_driver_id())
    or (select private.is_super_admin())
  );

-- Notifications : celles d'un chauffeur partenaire (organization_id = A) lisibles par lui seul
drop policy notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated
  using (
    (organization_id in (select private.member_org_ids())
      and (driver_id is null or driver_org_id = organization_id)
      and (data ->> 'sender' is distinct from 'platform'
           or organization_id in (select private.admin_org_ids())
           or user_id = (select auth.uid())))
    or driver_id = (select private.current_driver_id())
    or (select private.is_super_admin())
  );

-- Historique des positions : points d'une course partenaire invisibles pour l'organisation du chauffeur (S8)
drop policy driver_location_history_select on public.driver_location_history;
create policy driver_location_history_select on public.driver_location_history for select to authenticated
  using (
    (organization_id in (select private.member_org_ids()) and (ride_org_id is null or ride_org_id = organization_id))
    or driver_id = (select private.current_driver_id())
  );

-- Position en direct : masquée à l'organisation du chauffeur pendant une course partenaire (Q5)
drop policy driver_locations_select on public.driver_locations;
create policy driver_locations_select on public.driver_locations for select to authenticated
  using (
    (organization_id in (select private.member_org_ids())
      and driver_id not in (select private.member_drivers_on_foreign_ride()))
    or driver_id = (select private.current_driver_id())
    or (select private.is_super_admin())
  );

-- Nouvelles tables lisibles : lignes de sa propre organisation (l'exclue ne voit jamais l'exclusion)
create policy network_memberships_select on public.network_memberships for select to authenticated
  using (organization_id in (select private.member_org_ids()) or (select private.is_super_admin()));
create policy network_exclusions_select on public.network_exclusions for select to authenticated
  using (organization_id in (select private.member_org_ids()) or (select private.is_super_admin()));
create policy driver_network_settings_select on public.driver_network_settings for select to authenticated
  using (
    organization_id in (select private.member_org_ids())
    or driver_id = (select private.current_driver_id())
    or (select private.is_super_admin())
  );
-- ride_network_shares, ride_network_executions, driver_payout_details : AUCUNE policy (RPC seulement)

-- =============================================================================
-- 12. Droits
-- =============================================================================
revoke all on public.network_memberships, public.network_exclusions, public.driver_network_settings
  from public, anon, authenticated;
grant select on public.network_memberships, public.network_exclusions, public.driver_network_settings to authenticated;
revoke all on public.ride_network_shares, public.ride_network_executions, public.driver_payout_details
  from public, anon, authenticated;
grant all on public.network_memberships, public.network_exclusions, public.driver_network_settings,
  public.ride_network_shares, public.ride_network_executions, public.driver_payout_details to service_role;
revoke all on private.driver_identity_keys, private.network_driver_exclusions, private.network_debtor_identities
  from public, anon, authenticated, service_role;

-- Offres : termes figés (commission et frais Rydar de A) illisibles côté client, même pour le chauffeur sollicité ;
-- toute nouvelle colonne lue côté client doit être ajoutée ici (aucun select('*') sur ride_offers).
revoke select on public.ride_offers from authenticated;
grant select (id, organization_id, ride_id, driver_id, status, mode, wave, radius_m, distance_m, sent_at, expires_at,
  responded_at, closed_reason, missed_at, driver_org_id, is_network)
  on public.ride_offers to authenticated;

-- N° d'exploitant VTC : modifiable par owner / admin (drivers_admin_columns_guard), jamais par le chauffeur
grant update (vtc_operator_registration) on public.drivers to authenticated;
-- Aucun droit client sur driver_org_id, network_at, network_* (écriture par les fonctions seulement)

-- Aides : fonctions serveur seulement (RPC definer, worker, service role). driver_on_foreign_ride répond pour
-- n'importe quel chauffeur : jamais pour un client.
revoke all on function
  private.network_terms_ok(text),
  private.network_terms_complete(jsonb),
  private.network_org_reason(uuid, text),
  private.network_pair_ok(uuid, uuid),
  private.close_network_offers(uuid, uuid, uuid, text, uuid),
  private.driver_on_foreign_ride(uuid),
  private.account_identity_hash(uuid),
  private.driver_identity_keys_of(public.drivers),
  private.refresh_driver_identity_keys(uuid)
from public, anon, authenticated;
grant execute on function
  private.network_terms_ok(text),
  private.network_terms_complete(jsonb),
  private.network_org_reason(uuid, text),
  private.network_pair_ok(uuid, uuid),
  private.close_network_offers(uuid, uuid, uuid, text, uuid),
  private.driver_on_foreign_ride(uuid),
  private.account_identity_hash(uuid),
  private.driver_identity_keys_of(public.drivers),
  private.refresh_driver_identity_keys(uuid)
to service_role;

-- Position masquée (Q5) : la policy driver_locations_select est évaluée avec le rôle du lecteur (chauffeurs de SES
-- organisations seulement)
revoke all on function private.member_drivers_on_foreign_ride() from public, anon;
grant execute on function private.member_drivers_on_foreign_ride() to authenticated, service_role;

-- Déclencheurs : jamais appelés directement
revoke all on function
  private.set_driver_org_id(),
  private.forbid_driver_org_change(),
  private.rides_executor_guard(),
  private.network_child_guard(),
  private.network_settlement_guard(),
  private.rides_network_lock(),
  private.drivers_network_delete_guard(),
  private.drivers_network_status_guard(),
  private.drivers_current_ride_guard(),
  private.network_terms_insert_check(),
  private.vehicles_detach_rides(),
  private.rides_network_terms_watch(),
  private.ride_network_share_sync(),
  private.broadcast_network_execution(),
  private.ride_offers_network_closed(),
  private.organizations_network_identity(),
  private.organization_settings_network_methods(),
  private.sync_driver_identity_keys(),
  private.drivers_admin_columns_guard()
from public, anon, authenticated, service_role;

-- =============================================================================
-- 13. Index d'identités : remplissage depuis drivers et users
-- =============================================================================
insert into private.driver_identity_keys (driver_id, organization_id, kind, value_hash)
select d.id, d.organization_id, k.kind, k.value_hash
  from public.drivers d
 cross join lateral private.driver_identity_keys_of(d) k
on conflict do nothing;
