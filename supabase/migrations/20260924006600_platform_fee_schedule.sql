-- =============================================================================
-- Rydar Drive — Frais Rydar : hausses annoncées 30 jours à l'avance, annonce des CGV par e-mail, libellés neutres
--
-- Le propriétaire veut facturer « un abonnement + X € par course » aux flottes comme aux centrales, sans se mettre en
-- risque (CGV 2026-10-02, art. 16 : modification défavorable annoncée au moins 30 jours à l'avance ; risque de
-- déséquilibre significatif si Rydar peut augmenter seul et tout de suite les frais par course).
--
-- 1. Changement des frais par course (% et / ou € par course terminée) — public.platform_fee_changes, un seul
--    changement en attente par organisation (index unique partiel), écrit seulement par les RPC svc_* :
--    • création d'une organisation (p_mode 'initial', organisation de moins d'une heure, sans course) : taux appliqués
--      tout de suite ;
--    • baisse, ou taux égaux aux taux actuels : tout de suite (un changement en attente est remplacé, donc annulé) ;
--      aucun taux transmis (changement de modèle seul) : taux et changement en attente inchangés ;
--    • HAUSSE (l'un des deux taux augmente, y compris 0 → > 0) sur une organisation existante :
--        - par défaut PROGRAMMÉE (p_mode 'notice') : date d'effet = un jour (minuit, fuseau de l'organisation) au plus
--          tôt le premier minuit après max(maintenant + 30 jours, entrée en vigueur des CGV p_org_legal_effective_on
--          si l'organisation n'a pas accepté la version p_org_legal_version — CGV ET accord de traitement) ; date plus
--          proche refusée (NOTICE_TOO_SHORT) ; date choisie : un an au plus ; remplacement d'une hausse annoncée par
--          une hausse moindre ou égale (les deux taux ≤ ceux annoncés) : la date déjà annoncée reste possible (et
--          reste la date par défaut d'un remplacement quand elle est permise) ;
--        - ou tout de suite sur « accord écrit de l'organisation reçu » (p_mode 'consent', note obligatoire,
--          journalisée en « warning ») ;
--    • annulable (svc_platform_cancel_fee_change) ; un nouveau réglage remplace le changement en attente ; même
--      réglage (mêmes taux, même date) renvoyé : rien (UNCHANGED, aucun nouvel e-mail) ;
--    • changement de modèle d'exploitation (p_dispatch_model) : appliqué tout de suite, dans le même appel (garde
--      SETTLEMENTS_OPEN pour un retour en flotte) ; un changement de modèle seul n'est pas une hausse de taux ;
--    • garde SQL (organizations_platform_rates_guard) : une hausse écrite directement par le web (service role) ou un
--      client est refusée (PLATFORM_FEE_NOTICE_REQUIRED) ; une baisse directe reste possible.
--    La règle des taux APPLIQUÉS aux courses ne change pas : flotte = taux en vigueur à la fin de la course
--    (private.fleet_fee_basis) ; centrale = taux en vigueur au calcul de la répartition (création, puis chaque
--    changement de prix, de commission ou de mode de paiement, y compris après la course, par correction).
-- 2. Annonce automatique : e-mail aux propriétaires actifs (sinon à l'adresse de l'organisation) par la file
--    public.email_outbox (le web n'envoie rien lui-même), contenu FIXE (référence RYD-… issue du slug, taux, date
--    d'effet, règle du modèle ; jamais un texte saisi par l'organisation), adresses validées comme la colonne
--    to_email ; Reply-To = e-mail de l'éditeur (platform_legal) s'il est valide. Hausse programmée : annonce ;
--    hausse sur accord écrit : confirmation ; changement annoncé annulé ou remplacé par des frais immédiats : avis
--    d'annulation. Owner / admin : private.platform_account → « scheduled_change » (org_platform_account,
--    org_platform_status : encart « À partir du JJ/MM/AAAA »), menu « Frais Rydar » d'une flotte affiché dès
--    l'annonce (private.platform_fees_enabled). Temps réel : « platform.updated » rates_scheduled / rates_cancelled
--    (identifiants seulement) ; taux changés : action « rates » du déclencheur existant, une seule fois.
-- 3. Application à la date d'effet par le ménage (private.housekeeping, worker toutes les 5 min) :
--    private.apply_platform_fee_changes, idempotente (statut 'scheduled' → 'applied' une fois), organisation
--    verrouillée d'abord (même ordre que les RPC ; organisation occupée → passage suivant), diffusion « rates » par
--    le seul déclencheur organizations_platform_rates_broadcast. Une course qui se termine au même moment prend les
--    anciens taux (validée avant) ou les nouveaux (validée après) : jamais de double frais (base figée unique).
--    Les courses terminées entre minuit et le passage du ménage (5 min au plus) gardent les anciens taux.
-- 4. Annonce des CGV (svc_org_terms_notify) : e-mail aux propriétaires des organisations actives ou suspendues qui
--    n'ont pas accepté la version, une seule fois par organisation et par version (public.org_terms_notices).
-- 5. Libellés neutres (une flotte n'a pas de menu « Encaissements ») : « réglez vos frais Rydar (menu « Frais
--    Rydar » ou « Encaissements ») » dans private.rides_platform_block, assign_ride, redispatch_ride et
--    private.apply_flight_status ; relance WhatsApp de Rydar refusée pour une FLOTTE (modèle approuvé
--    « rappel_frais_plateforme » = « onglet Encaissements ») tant qu'un modèle neutre n'est pas approuvé.
--
-- Fonctions redéfinies (dernières définitions) : private.platform_fees_enabled, private.platform_account,
-- public.svc_platform_remind (20260924006400), public.admin_platform_whatsapp (20260924003700),
-- private.housekeeping (20260924005900), private.rides_platform_block (20260924003000), public.assign_ride,
-- public.redispatch_ride (20260924004500), private.apply_flight_status (20260924005400).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Outils (sans security definer : appelés par les RPC et le ménage)
-- -----------------------------------------------------------------------------
-- Typographie française d'un texte fixe : espace insécable avant « : ; ! ? » et à l'intérieur des guillemets
create or replace function private.fr_typo(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(replace(replace(replace(replace(replace(p_text,
    ' :', chr(160) || ':'), ' ;', chr(160) || ';'), ' !', chr(160) || '!'), ' ?', chr(160) || '?'),
    '« ', '«' || chr(160)), ' »', chr(160) || '»');
$$;

-- « 2 octobre 2026 », « 1er novembre 2026 »
create or replace function private.fr_long_date(p_date date)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when extract(day from p_date) = 1 then '1er' else extract(day from p_date)::integer::text end
    || ' ' || (array['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre',
                     'novembre', 'décembre'])[extract(month from p_date)::integer]
    || ' ' || extract(year from p_date)::integer::text;
$$;

-- Adresse acceptée par public.email_outbox.to_email (mêmes règles : une seule @, ni espace, ni séparateur)
create or replace function private.email_address_ok(p_email text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_email is not null
     and char_length(p_email) <= 254
     and p_email ~ '^[^@]+@[^@]+\.[^@]+$'
     and p_email !~ '[\x01-\x20\x7f-\xa0\x2028\x2029,;:<>()"\\]';
$$;

-- Adresse du site passée par le web (env.appUrl) pour les liens des e-mails : origine seule, sinon null (pas de lien)
create or replace function private.app_origin(p_url text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when v ~ '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' and char_length(v) <= 100 then v end
  from (select rtrim(btrim(coalesce(p_url, '')), '/') as v) x;
$$;

-- Reply-To des e-mails de Rydar aux organisations : e-mail de l'éditeur (/admin/legal), s'il est valide
create or replace function private.platform_reply_to()
returns text
language sql
stable
set search_path = ''
as $$
  select case when private.email_address_ok(lower(btrim(l.email))) then lower(btrim(l.email)) end
  from public.platform_legal l
  where l.id;
$$;

-- Version légale passée par le web (ORG_LEGAL_VERSION) : AAAA-MM-JJ, date réelle, au plus le lendemain (heure de
-- Paris) — mêmes règles que public.accept_legal_documents
create or replace function private.legal_version_ok(p_version text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_date date;
begin
  if p_version is null or p_version !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return false;
  end if;
  begin
    v_date := p_version::date;
  exception when others then
    return false;
  end;
  return v_date <= (now() at time zone 'Europe/Paris')::date + 1;
end;
$$;

-- L'organisation a accepté cette version des CGV ET de l'accord de traitement (enregistrés ensemble par
-- accept_legal_documents ; /admin/legal lit « dpa »)
create or replace function private.org_terms_accepted(p_org uuid, p_version text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_version is not null
     and exists (select 1 from public.legal_acceptances a
                  where a.organization_id = p_org and a.document = 'cgv' and a.version = p_version)
     and exists (select 1 from public.legal_acceptances a
                  where a.organization_id = p_org and a.document = 'dpa' and a.version = p_version);
$$;

-- Destinataires des e-mails de Rydar à une organisation : ses propriétaires ACTIFS (5 au plus, adresses valides,
-- sans doublon) ; à défaut, l'adresse de l'organisation. Null : aucune adresse utilisable.
create or replace function private.org_owner_emails(p_org uuid)
returns text[]
language plpgsql
stable
set search_path = ''
as $$
declare
  v_emails text[];
  v_org text;
begin
  select array_agg(x.email order by x.email) into v_emails
  from (
    select distinct lower(btrim(u.email)) as email
    from public.organization_users ou
    join public.users u on u.id = ou.user_id
    where ou.organization_id = p_org and ou.role = 'owner' and ou.status = 'active'
      and private.email_address_ok(lower(btrim(u.email)))
    order by 1
    limit 5
  ) x;
  if v_emails is not null then
    return v_emails;
  end if;
  select lower(btrim(o.email)) into v_org from public.organizations o where o.id = p_org;
  return case when private.email_address_ok(v_org) then array[v_org] end;
end;
$$;

-- « 10 % du prix + 2 € par course terminée » (miroir de feeTermsText, tableau de bord)
create or replace function private.platform_fee_terms_text(p_percent numeric, p_fixed integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(p_percent, 0) > 0 and coalesce(p_fixed, 0) > 0 then
      replace(trim_scale(p_percent)::text, '.', ',') || ' % du prix + ' || private.fmt_eur(p_fixed) || ' par course terminée'
    when coalesce(p_percent, 0) > 0 then replace(trim_scale(p_percent)::text, '.', ',') || ' % du prix de chaque course terminée'
    when coalesce(p_fixed, 0) > 0 then private.fmt_eur(p_fixed) || ' par course terminée'
    else 'aucuns frais par course'
  end;
$$;

-- Premier jour (minuit, fuseau de l'organisation) où une hausse annoncée maintenant peut s'appliquer : au moins
-- 30 jours après l'annonce et, si l'organisation n'a pas accepté la version p_version des CGV, pas avant leur
-- entrée en vigueur p_legal_on (version et date null : 30 jours seulement)
create or replace function private.platform_fee_min_effective_on(p_org uuid, p_version text, p_legal_on date)
returns date
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tz text;
  v_at timestamptz := now() + interval '30 days';
  v_local timestamp;
begin
  select coalesce(o.timezone, 'Europe/Paris') into v_tz from public.organizations o where o.id = p_org;
  v_tz := coalesce(v_tz, 'Europe/Paris');
  if p_legal_on is not null and not private.org_terms_accepted(p_org, p_version) then
    v_at := greatest(v_at, p_legal_on::timestamp at time zone v_tz);
  end if;
  v_local := v_at at time zone v_tz;
  return v_local::date + case when v_local::time > time '00:00' then 1 else 0 end;
end;
$$;

-- -----------------------------------------------------------------------------
-- Changements des frais par course (historique + changement en attente)
-- -----------------------------------------------------------------------------
create table public.platform_fee_changes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- initial : création de l'organisation ; decrease : baisse appliquée tout de suite ; notice : hausse annoncée,
  -- appliquée à sa date d'effet ; consent : hausse appliquée tout de suite sur accord écrit de l'organisation
  mode text not null check (mode in ('initial', 'decrease', 'notice', 'consent')),
  status text not null check (status in ('scheduled', 'applied', 'cancelled', 'replaced')),
  -- Taux en vigueur au moment du réglage, puis taux demandés
  from_percent numeric(5, 2) not null check (from_percent between 0 and 50),
  from_fixed_cents integer not null check (from_fixed_cents between 0 and 100000),
  to_percent numeric(5, 2) not null check (to_percent between 0 and 50),
  to_fixed_cents integer not null check (to_fixed_cents between 0 and 100000),
  -- Hausse annoncée : minuit (fuseau de l'organisation) du jour d'effet ; sinon : moment de l'application
  effective_at timestamptz not null,
  consent_note text check (consent_note is null or char_length(consent_note) between 3 and 500),
  terms_version text check (terms_version is null or char_length(terms_version) <= 40),
  terms_accepted boolean,
  emails_queued integer not null default 0 check (emails_queued >= 0),
  created_at timestamptz not null default now(),
  created_by uuid references public.users (id) on delete set null,
  applied_at timestamptz,
  closed_at timestamptz,
  closed_by uuid references public.users (id) on delete set null,
  close_reason text check (close_reason is null or char_length(close_reason) <= 300),
  check ((status = 'applied') = (applied_at is not null)),
  check ((status in ('cancelled', 'replaced')) = (closed_at is not null)),
  check (mode <> 'consent' or consent_note is not null),
  check (status <> 'scheduled' or mode = 'notice')
);
comment on table public.platform_fee_changes is
  'Changements des frais Rydar par course d''une organisation : hausse annoncée (au moins 30 jours) puis appliquée par le ménage, ou appliquée tout de suite (création, baisse, accord écrit). Lecture : super admin ; écriture : RPC svc_*.';
comment on column public.platform_fee_changes.effective_at is
  'Hausse annoncée : minuit (fuseau de l''organisation) du jour d''effet, appliquée par private.housekeeping ; sinon : moment de l''application.';
comment on column public.platform_fee_changes.terms_accepted is
  'L''organisation avait accepté terms_version (CGV + accord de traitement) au moment du réglage.';

-- Un seul changement en attente par organisation ; changements dus (ménage) ; historique d'une organisation
create unique index platform_fee_changes_one_scheduled on public.platform_fee_changes (organization_id) where status = 'scheduled';
create index platform_fee_changes_due_idx on public.platform_fee_changes (effective_at) where status = 'scheduled';
create index platform_fee_changes_org_idx on public.platform_fee_changes (organization_id, created_at desc);

alter table public.platform_fee_changes enable row level security;
create policy platform_fee_changes_select on public.platform_fee_changes for select to authenticated
  using ((select private.is_super_admin()));
revoke all on public.platform_fee_changes from public, anon, authenticated, service_role;
grant select on public.platform_fee_changes to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Garde : jamais de HAUSSE des frais par course écrite directement par le web (service role) ou par un client
-- -----------------------------------------------------------------------------
-- Une hausse passe par svc_platform_set_fees (préavis de 30 jours, ou accord écrit) ou par le ménage, qui s'exécutent
-- avec le rôle propriétaire des fonctions ; une baisse directe reste possible. Non concernés : connexions directes avec
-- le rôle propriétaire (migrations, seed, VPS) et création d'une organisation (INSERT).
create or replace function private.organizations_platform_rates_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('service_role', 'authenticated', 'anon')
     and (new.platform_fee_percent > old.platform_fee_percent or new.platform_fee_fixed_cents > old.platform_fee_fixed_cents) then
    raise exception 'PLATFORM_FEE_NOTICE_REQUIRED: hausse des frais par course : annonce de 30 jours ou accord écrit (svc_platform_set_fees)'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists organizations_platform_rates_guard on public.organizations;
create trigger organizations_platform_rates_guard
  before update of platform_fee_percent, platform_fee_fixed_cents on public.organizations
  for each row execute function private.organizations_platform_rates_guard();

-- -----------------------------------------------------------------------------
-- File des e-mails : annonces aux organisations
-- -----------------------------------------------------------------------------
alter table public.email_outbox drop constraint if exists email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check
  check (kind in ('contact_notify', 'contact_ack', 'contact_reply', 'test', 'platform_fee_change', 'org_terms_update'));
alter table public.email_outbox
  add column organization_id uuid references public.organizations (id) on delete cascade,
  add column platform_fee_change_id uuid references public.platform_fee_changes (id) on delete cascade;
comment on column public.email_outbox.organization_id is
  'Organisation prévenue (platform_fee_change, org_terms_update) ; null : e-mails du formulaire de contact et de test.';
comment on column public.email_outbox.platform_fee_change_id is 'Changement de frais annoncé, confirmé ou annulé par cet e-mail.';
create index email_outbox_org_idx on public.email_outbox (organization_id, created_at desc) where organization_id is not null;
create index email_outbox_fee_change_idx on public.email_outbox (platform_fee_change_id) where platform_fee_change_id is not null;

-- Annonces des CGV déjà envoyées : une par organisation et par version (svc_org_terms_notify)
create table public.org_terms_notices (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  version text not null check (version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  effective_on date not null,
  emails_queued integer not null check (emails_queued > 0),
  created_at timestamptz not null default now(),
  created_by uuid references public.users (id) on delete set null,
  primary key (organization_id, version)
);
comment on table public.org_terms_notices is
  'Annonce par e-mail d''une nouvelle version des CGV aux propriétaires d''une organisation (une fois par version). Lecture : super admin.';

alter table public.org_terms_notices enable row level security;
create policy org_terms_notices_select on public.org_terms_notices for select to authenticated
  using ((select private.is_super_admin()));
revoke all on public.org_terms_notices from public, anon, authenticated, service_role;
grant select on public.org_terms_notices to authenticated, service_role;

-- Une ligne par destinataire (private.org_owner_emails) ; renvoie le nombre d'e-mails mis en file
create or replace function private.queue_org_emails(p_org uuid, p_kind text, p_subject text, p_body text, p_change uuid, p_actor uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_to text;
  v_reply text := private.platform_reply_to();
  v_count integer := 0;
begin
  foreach v_to in array coalesce(private.org_owner_emails(p_org), '{}'::text[]) loop
    insert into public.email_outbox (kind, organization_id, platform_fee_change_id, to_email, reply_to, subject, body_text, created_by)
    values (p_kind, p_org, p_change, v_to, v_reply, p_subject, p_body, p_actor);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Textes des e-mails (contenu fixe : référence issue du slug, taux, dates, règle du modèle)
-- -----------------------------------------------------------------------------
-- p_kind : 'notice' (hausse annoncée, p_on = jour d'effet), 'consent' (hausse appliquée sur accord écrit, p_on = jour
-- de l'application), 'cancel' (changement annoncé pour p_replaced_on annulé ; p_to = frais désormais en vigueur).
-- p_replaced_on (notice, consent) : date du changement annoncé que celui-ci remplace.
create or replace function private.platform_fee_change_email(
  p_kind text,
  p_org uuid,
  p_model text,
  p_from_percent numeric,
  p_from_fixed integer,
  p_to_percent numeric,
  p_to_fixed integer,
  p_on date,
  p_replaced_on date,
  p_url text
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_ref text := private.platform_reference(p_org);
  v_fleet boolean := p_model = 'fleet';
  v_from text := private.platform_fee_terms_text(p_from_percent, p_from_fixed);
  v_to text := private.platform_fee_terms_text(p_to_percent, p_to_fixed);
  v_reply boolean := private.platform_reply_to() is not null;
  v_url text := private.app_origin(p_url);
  -- Annonce faite au moins 30 jours avant la date d'effet ? Sinon (seul cas possible : remplacement d'une hausse déjà
  -- annoncée par une hausse moindre ou plus tardive, svc_platform_set_fees « already_announced »), l'e-mail ne dit pas
  -- « au moins 30 jours à l'avance » (CGV art. 5 : réduite ou reportée sans nouveau délai).
  v_full_notice boolean := p_kind = 'notice' and p_on >= private.platform_fee_min_effective_on(p_org, null, null);
  v_links text;
  v_footer text;
  v_subject text;
  v_parts text[];
begin
  v_links := 'Calcul des frais : article 5 des conditions générales de vente (CGV) de Rydar Drive.'
    || coalesce(E'\n' || v_url || '/cgv', '')
    || E'\n' || format('Détail dans votre tableau de bord, menu « %s ».', case when v_fleet then 'Frais Rydar' else 'Encaissements' end)
    || coalesce(E'\n' || v_url || case when v_fleet then '/dashboard/rydar' else '/dashboard/settlements' end, '');
  v_footer := 'Message automatique de Rydar Drive. '
    || case when v_reply then 'Une question ? Répondez à cet e-mail.'
            else 'Une question ? Écrivez-nous depuis la page Contact du site Rydar Drive.' || coalesce(E'\n' || v_url || '/contact', '') end;

  if p_kind = 'notice' then
    v_subject := format('Rydar Drive : vos frais par course changent le %s', to_char(p_on, 'DD/MM/YYYY'));
    v_parts := array[
      'Bonjour,',
      format('Les frais plateforme (frais Rydar) de votre organisation, référence %s, vont changer.', v_ref),
      format('Frais actuels : %s.', v_from) || E'\n' || format('À partir du %s : %s.', to_char(p_on, 'DD/MM/YYYY'), v_to),
      case when v_fleet
        then 'Les nouveaux frais s''appliquent aux courses terminées à partir de cette date. Une course terminée avant garde ses frais.'
        else 'Les nouveaux frais s''appliquent aux répartitions du prix calculées à partir de cette date : courses créées à partir de cette date, et courses dont le prix, la commission ou le mode de paiement est saisi ou modifié à partir de cette date (y compris une course déjà terminée, par une écriture de correction).'
      end,
      case when p_replaced_on is not null
        then format('Ce message remplace l''annonce précédente (changement prévu le %s).', to_char(p_replaced_on, 'DD/MM/YYYY')) end,
      case when v_full_notice
        then 'Ce changement vous est annoncé au moins 30 jours à l''avance. Si vous ne l''acceptez pas, vous pouvez résilier avant cette date, sans frais.'
        else 'Ce changement ne dépasse pas celui annoncé précédemment et ne s''applique pas plus tôt : il ne demande donc pas de nouveau préavis (article 5 des CGV). Si vous ne l''acceptez pas, vous pouvez résilier avant cette date, sans frais.'
      end,
      v_links, v_footer, 'L''équipe Rydar Drive'];
  elsif p_kind = 'consent' then
    v_subject := 'Rydar Drive : vos frais par course ont changé';
    v_parts := array[
      'Bonjour,',
      format('Conformément à votre accord écrit, les frais plateforme (frais Rydar) de votre organisation, référence %s, changent dès aujourd''hui, %s.',
        v_ref, to_char(p_on, 'DD/MM/YYYY')),
      format('Anciens frais : %s.', v_from) || E'\n' || format('Nouveaux frais : %s.', v_to),
      case when v_fleet
        then 'Les nouveaux frais s''appliquent aux courses terminées à partir de maintenant. Une course déjà terminée garde ses frais.'
        else 'Les nouveaux frais s''appliquent aux répartitions du prix calculées à partir de maintenant : nouvelles courses, et courses dont le prix, la commission ou le mode de paiement est saisi ou modifié (y compris une course déjà terminée, par une écriture de correction).'
      end,
      case when p_replaced_on is not null
        then format('Ce changement remplace celui qui était annoncé pour le %s.', to_char(p_replaced_on, 'DD/MM/YYYY')) end,
      'Si vous n''avez pas donné cet accord, signalez-le sans attendre à Rydar Drive.',
      v_links, v_footer, 'L''équipe Rydar Drive'];
  else
    v_subject := 'Rydar Drive : changement de vos frais par course annulé';
    v_parts := array[
      'Bonjour,',
      format('Le changement des frais plateforme (frais Rydar) de votre organisation, référence %s, annoncé pour le %s, est annulé.',
        v_ref, to_char(p_replaced_on, 'DD/MM/YYYY')),
      case when (p_from_percent, p_from_fixed) is distinct from (p_to_percent, p_to_fixed)
        then format('Vos frais sont désormais : %s.', v_to)
        else format('Vos frais restent inchangés : %s.', v_to) end,
      v_links, v_footer, 'L''équipe Rydar Drive'];
  end if;
  -- array_to_string ignore les paragraphes absents (null)
  return jsonb_build_object('subject', private.fr_typo(v_subject), 'body', private.fr_typo(array_to_string(v_parts, E'\n\n')));
end;
$$;

-- Annonce d'une nouvelle version des CGV (et de l'accord de traitement) à une organisation qui ne l'a pas acceptée.
-- Organisation déjà cliente (créée avant le jour de la version, heure de Paris, ou qui avait accepté une version
-- antérieure — créée entre la date de la version et sa mise en ligne) : la version s'applique dès son acceptation et
-- au plus tard à p_effective_on, résiliation sans frais possible avant (préambule des CGV) ; sinon : dès son
-- acceptation (aucune date imposée).
create or replace function private.org_terms_email(p_org uuid, p_version text, p_effective_on date, p_url text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_ref text := private.platform_reference(p_org);
  v_reply boolean := private.platform_reply_to() is not null;
  v_url text := private.app_origin(p_url);
  v_before boolean;
  v_parts text[];
begin
  select o.created_at < (p_version::date)::timestamp at time zone 'Europe/Paris'
         or exists (select 1 from public.legal_acceptances a
                     where a.organization_id = p_org and a.document in ('cgv', 'dpa')
                       and a.version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and a.version < p_version)
    into v_before
  from public.organizations o where o.id = p_org;
  v_parts := array[
    'Bonjour,',
    format('Rydar Drive a publié une nouvelle version de ses conditions générales de vente (CGV), à accepter avec son accord de traitement des données : version du %s. Elle concerne votre organisation, référence %s.',
      private.fr_long_date(p_version::date), v_ref),
    -- Résumé propre à chaque version (contenu fixe)
    case p_version
      when '2026-10-02' then 'Ce qui change : des frais plateforme par course peuvent s''appliquer aux flottes comme aux centrales à commission, en plus de l''abonnement (articles 3 à 5 des CGV) ; ces frais s''entendent toutes taxes comprises. Toute hausse de ces frais vous sera annoncée au moins 30 jours à l''avance, sauf accord écrit de votre part. L''accord de traitement des données ne change pas.'
      else 'Les changements sont résumés au début des CGV.'
    end,
    case when coalesce(v_before, true)
      then format('Pour votre organisation, cette version s''applique dès son acceptation, et au plus tard le %s. Si vous ne l''acceptez pas, vous pouvez résilier sans frais avant cette date.',
        private.fr_long_date(p_effective_on))
      else 'Pour votre organisation, cette version s''applique dès son acceptation.' end,
    'Le propriétaire ou un administrateur l''accepte depuis le bandeau affiché dans le tableau de bord Rydar Drive.'
      || coalesce(E'\n' || v_url || '/dashboard', ''),
    'Texte complet, avec un lien vers la version précédente : page « Conditions générales de vente » du site Rydar Drive.'
      || coalesce(E'\n' || v_url || '/cgv', ''),
    'Message automatique de Rydar Drive. '
      || case when v_reply then 'Une question ? Répondez à cet e-mail.'
              else 'Une question ? Écrivez-nous depuis la page Contact du site Rydar Drive.' || coalesce(E'\n' || v_url || '/contact', '') end,
    'L''équipe Rydar Drive'];
  return jsonb_build_object(
    'subject', private.fr_typo(format('Rydar Drive : nouvelles conditions générales de vente (version du %s)', private.fr_long_date(p_version::date))),
    'body', private.fr_typo(array_to_string(v_parts, E'\n\n')));
end;
$$;

-- -----------------------------------------------------------------------------
-- Lecture : changement en attente (owner / admin par private.platform_account ; super admin)
-- -----------------------------------------------------------------------------
create or replace function private.platform_scheduled_change_json(p_org uuid, p_tz text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', c.id,
    'percent', c.to_percent,
    'fixed_cents', c.to_fixed_cents,
    'from_percent', c.from_percent,
    'from_fixed_cents', c.from_fixed_cents,
    'effective_at', c.effective_at,
    'effective_on', (c.effective_at at time zone coalesce(p_tz, 'Europe/Paris'))::date,
    'announced_at', c.created_at)
  from public.platform_fee_changes c
  where c.organization_id = p_org and c.status = 'scheduled';
$$;

-- Ligne d'historique (super admin) : réglage, auteur, accord écrit, e-mails envoyés
create or replace function private.platform_fee_change_admin_json(c public.platform_fee_changes, p_tz text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', c.id,
    'mode', c.mode,
    'status', c.status,
    'from_percent', c.from_percent,
    'from_fixed_cents', c.from_fixed_cents,
    'percent', c.to_percent,
    'fixed_cents', c.to_fixed_cents,
    'effective_at', c.effective_at,
    'effective_on', (c.effective_at at time zone coalesce(p_tz, 'Europe/Paris'))::date,
    'consent_note', c.consent_note,
    'terms_version', c.terms_version,
    'terms_accepted', c.terms_accepted,
    'emails_queued', c.emails_queued,
    'created_at', c.created_at,
    'created_by_name', (select u.full_name from public.users u where u.id = c.created_by),
    'applied_at', c.applied_at,
    'closed_at', c.closed_at,
    'closed_by_name', (select u.full_name from public.users u where u.id = c.closed_by),
    'close_reason', c.close_reason,
    'emails', coalesce((select jsonb_agg(jsonb_build_object('to_email', e.to_email, 'status', e.status, 'sent_at', e.sent_at,
                          'subject', e.subject, 'created_at', e.created_at) order by e.id)
                        from public.email_outbox e where e.platform_fee_change_id = c.id), '[]'::jsonb));
$$;

-- -----------------------------------------------------------------------------
-- Super admin : réglage des frais par course (et du modèle d'exploitation)
-- -----------------------------------------------------------------------------
-- Appelée par les actions serveur createOrganization (p_mode 'initial') et updateDispatchModel, avec la version des
-- CGV en vigueur (ORG_LEGAL_VERSION) et leur date d'entrée en vigueur pour les organisations déjà clientes
-- (ORG_LEGAL_EFFECTIVE_AT) : la base ne connaît aucune version. p_percent et p_fixed_cents : les deux, ou aucun
-- (changement de modèle seul : taux et changement en attente inchangés) ; des taux égaux aux taux ACTUELS alors qu'une
-- hausse est annoncée l'annulent (« un nouveau réglage la remplace »). p_app_url : origine du site pour les liens des
-- e-mails (facultatif). Champs d'erreur (« field ») : platformFeePercent, platformFeeFixedCents, dispatchModel,
-- effectiveOn, consentNote, mode.
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
      'message', 'Frais plateforme (%) : entre 0 et 50.');
  end if;
  v_percent := round(p_percent, 2);
  if v_rates_given and (v_fixed is null or v_fixed < 0 or v_fixed > 100000) then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'field', 'platformFeeFixedCents',
      'message', 'Frais fixes par course : entre 0 et 1 000 €.');
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
      'message', 'Réglage initial réservé à une organisation tout juste créée, sans course : programmez la hausse ou indiquez l''accord écrit.');
  end if;

  -- Retour au mode flotte : refusé tant qu'un règlement chauffeur est ouvert (même garde que le déclencheur
  -- organizations_dispatch_model_guard, qui reste le dernier rempart)
  if o.dispatch_model = 'centrale' and v_model = 'fleet' then
    select count(*) into v_open from public.ride_settlements x
     where x.organization_id = p_org and x.status in ('due', 'declared', 'disputed');
    if v_open > 0 then
      return jsonb_build_object('ok', false, 'code', 'SETTLEMENTS_OPEN', 'count', v_open, 'field', 'dispatchModel',
        'message', format('%s règlement%s chauffeur encore ouvert%s (à régler, signalé%s payé%s ou contesté%s) : la centrale doit les solder ou les annuler dans Encaissements avant le retour au mode flotte.',
          v_open, case when v_open > 1 then 's' else '' end, case when v_open > 1 then 's' else '' end,
          case when v_open > 1 then 's' else '' end, case when v_open > 1 then 's' else '' end, case when v_open > 1 then 's' else '' end));
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
        'message', 'Accord écrit : précisez sa date et sa forme (e-mail, courrier…) pour appliquer la hausse tout de suite.');
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
        'message', format('Préavis insuffisant : cette hausse peut s''appliquer au plus tôt le %s (%s). Pour l''appliquer avant, indiquez l''accord écrit de l''organisation.',
          to_char(v_min, 'DD/MM/YYYY'),
          case v_reason
            when 'terms_effective' then 'entrée en vigueur des CGV, que l''organisation n''a pas encore acceptées'
            when 'already_announced' then 'date déjà annoncée'
            else '30 jours après l''annonce' end));
    end if;
    if v_on > v_today + 366 then
      return jsonb_build_object('ok', false, 'code', 'INVALID', 'field', 'effectiveOn',
        'message', 'Date d''effet trop lointaine : un an au plus.');
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
    insert into public.platform_fee_changes (organization_id, mode, status, from_percent, from_fixed_cents, to_percent,
      to_fixed_cents, effective_at, terms_version, terms_accepted, created_by)
    values (p_org, 'notice', 'scheduled', o.platform_fee_percent, o.platform_fee_fixed_cents, v_percent, v_fixed,
      v_on::timestamp at time zone v_tz, v_version, v_accepted, p_actor)
    returning * into n;
  end if;

  -- E-mails aux propriétaires : annonce, confirmation d'une hausse sur accord écrit, ou annulation d'une annonce
  if v_schedule then
    v_mail := private.platform_fee_change_email('notice', p_org, v_model, o.platform_fee_percent, o.platform_fee_fixed_cents,
      v_percent, v_fixed, v_on, case when v_close then v_pending_on end, p_app_url);
    v_emails := private.queue_org_emails(p_org, 'platform_fee_change', v_mail ->> 'subject', v_mail ->> 'body', n.id, p_actor);
    update public.platform_fee_changes set emails_queued = v_emails where id = n.id returning * into n;
  elsif a.mode = 'consent' then
    v_mail := private.platform_fee_change_email('consent', p_org, v_model, a.from_percent, a.from_fixed_cents,
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
        'terms_version', v_version, 'terms_accepted', v_accepted,
        'emails', case when a.mode = 'consent' then v_emails end,
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
    'message', v_msg,
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

-- Annulation d'un changement programmé (p_change : celui affiché ; un autre entre-temps → refus, rien n'est annulé)
create or replace function public.svc_platform_cancel_fee_change(
  p_org uuid,
  p_actor uuid,
  p_change uuid,
  p_note text default null,
  p_app_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  c public.platform_fee_changes;
  v_note text := left(nullif(btrim(regexp_replace(coalesce(p_note, ''), '\s+', ' ', 'g')), ''), 300);
  v_tz text;
  v_mail jsonb;
  v_emails integer;
begin
  perform private.assert_platform_actor(p_actor);
  select * into o from public.organizations where id = p_org for no key update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Organisation introuvable.');
  end if;
  select * into c from public.platform_fee_changes x where x.organization_id = p_org and x.status = 'scheduled' for no key update;
  if not found or p_change is null or c.id <> p_change then
    return jsonb_build_object('ok', false, 'code', 'FEE_CHANGE_NOT_PENDING',
      'message', 'Ce changement n''est plus en attente (déjà appliqué, annulé ou remplacé) : rechargez la page.');
  end if;
  v_tz := coalesce(o.timezone, 'Europe/Paris');
  perform private.set_actor('super_admin', p_actor);
  update public.platform_fee_changes
     set status = 'cancelled', closed_at = now(), closed_by = p_actor, close_reason = coalesce(v_note, 'Annulé par Rydar')
   where id = c.id;

  v_mail := private.platform_fee_change_email('cancel', p_org, o.dispatch_model, o.platform_fee_percent, o.platform_fee_fixed_cents,
    o.platform_fee_percent, o.platform_fee_fixed_cents, null, (c.effective_at at time zone v_tz)::date, p_app_url);
  v_emails := private.queue_org_emails(p_org, 'platform_fee_change', v_mail ->> 'subject', v_mail ->> 'body', c.id, p_actor);

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, 'super_admin', p_actor, 'organization.platform_fee_schedule_cancelled', 'organizations', p_org::text, 'info',
    jsonb_build_object('change_id', c.id, 'reason', 'cancelled', 'note', v_note,
      'to', jsonb_build_object('platform_fee_percent', c.to_percent, 'platform_fee_fixed_cents', c.to_fixed_cents),
      'effective_at', c.effective_at, 'emails', v_emails));
  perform private.broadcast_platform(p_org, 'rates_cancelled');
  return jsonb_build_object('ok', true, 'code', 'CANCELLED', 'emails_queued', v_emails,
    'message', format('Changement annulé. Frais inchangés : %s.', private.platform_fee_terms_text(o.platform_fee_percent, o.platform_fee_fixed_cents))
      || case when v_emails > 0 then ' Le propriétaire est prévenu par e-mail.' else '' end);
end;
$$;

-- Super admin (session) : frais actuels, changement en attente, acceptation des CGV, date au plus tôt d'une hausse
-- annoncée maintenant, historique (20 derniers changements, e-mails compris). p_percent + p_fixed_cents (facultatifs) :
-- aperçu d'un réglage (« preview » : hausse / baisse / inchangé, date au plus tôt, date par défaut).
create or replace function public.admin_platform_fee_schedule(
  p_org uuid,
  p_org_legal_version text default null,
  p_org_legal_effective_on date default null,
  p_percent numeric default null,
  p_fixed_cents integer default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  c public.platform_fee_changes;
  v_tz text;
  v_version text := nullif(btrim(coalesce(p_org_legal_version, '')), '');
  v_ok boolean;
  v_std date;
  v_30 date;
  v_pending_on date;
  v_preview jsonb;
  v_percent numeric(5, 2);
  v_kind text;
  v_min date;
  v_reason text;
begin
  if not private.is_super_admin() then
    raise exception 'FORBIDDEN: réservé au super admin' using errcode = '42501';
  end if;
  select * into o from public.organizations where id = p_org;
  if not found then
    return null;
  end if;
  select * into c from public.platform_fee_changes x where x.organization_id = p_org and x.status = 'scheduled';
  v_tz := coalesce(o.timezone, 'Europe/Paris');
  v_pending_on := (c.effective_at at time zone v_tz)::date;
  v_ok := v_version is not null and private.legal_version_ok(v_version) and p_org_legal_effective_on is not null;
  v_std := private.platform_fee_min_effective_on(p_org, case when v_ok then v_version end, case when v_ok then p_org_legal_effective_on end);
  v_30 := private.platform_fee_min_effective_on(p_org, null, null);

  if p_percent is not null and p_fixed_cents is not null then
    v_percent := round(p_percent, 2);
    v_kind := case when v_percent > o.platform_fee_percent or p_fixed_cents > o.platform_fee_fixed_cents then 'increase'
                   when v_percent = o.platform_fee_percent and p_fixed_cents = o.platform_fee_fixed_cents then 'unchanged'
                   else 'decrease' end;
    if v_kind = 'increase' then
      v_min := v_std;
      v_reason := case when v_std > v_30 then 'terms_effective' else 'notice_30_days' end;
      if c.id is not null and v_percent <= c.to_percent and p_fixed_cents <= c.to_fixed_cents and v_pending_on < v_min then
        v_min := v_pending_on;
        v_reason := 'already_announced';
      end if;
    end if;
    v_preview := jsonb_build_object(
      'kind', v_kind,
      'same_as_scheduled', c.id is not null and v_percent = c.to_percent and p_fixed_cents = c.to_fixed_cents,
      'min_effective_on', v_min,
      'min_reason', v_reason,
      'default_effective_on', case when v_kind = 'increase' then
        case when c.id is not null then greatest(v_min, v_pending_on) else v_min end end,
      'terms_text', private.platform_fee_terms_text(v_percent, p_fixed_cents));
  end if;

  return jsonb_build_object(
    'organization_id', o.id,
    'dispatch_model', o.dispatch_model,
    'timezone', v_tz,
    'currency', o.currency,
    'current', jsonb_build_object('percent', o.platform_fee_percent, 'fixed_cents', o.platform_fee_fixed_cents,
      'terms_text', private.platform_fee_terms_text(o.platform_fee_percent, o.platform_fee_fixed_cents)),
    'scheduled', case when c.id is not null then private.platform_fee_change_admin_json(c, v_tz) end,
    'terms', case when v_ok then jsonb_build_object(
      'version', v_version,
      'accepted', private.org_terms_accepted(p_org, v_version),
      'accepted_at', (select min(la.accepted_at) from public.legal_acceptances la
                       where la.organization_id = p_org and la.document = 'cgv' and la.version = v_version),
      'effective_on', p_org_legal_effective_on) end,
    'min_effective_on', v_std,
    'min_reason', case when v_std > v_30 then 'terms_effective' else 'notice_30_days' end,
    'preview', v_preview,
    'history', coalesce((select jsonb_agg(private.platform_fee_change_admin_json(h, v_tz) order by h.created_at desc, h.id)
                         from (select * from public.platform_fee_changes x where x.organization_id = p_org
                               order by x.created_at desc, x.id limit 20) h), '[]'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- Ménage : hausses programmées arrivées à leur date d'effet
-- -----------------------------------------------------------------------------
-- Idempotente (statut 'scheduled' → 'applied' une seule fois). Organisation verrouillée d'abord, comme les RPC du super
-- admin (aucun interblocage) ; organisation occupée (réglage en cours…) : reprise au passage suivant. La diffusion
-- « platform.updated » (rates) part du seul déclencheur organizations_platform_rates_broadcast, une fois, et seulement
-- si les taux changent vraiment. Une course qui se termine en même temps lit les taux sans verrou : anciens taux si
-- elle est validée avant, nouveaux après (une seule base figée par course : jamais de double frais).
create or replace function private.apply_platform_fee_changes(p_limit integer default 100)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  x record;
  o public.organizations;
  c public.platform_fee_changes;
  v_count integer := 0;
begin
  for x in
    select f.id, f.organization_id
      from public.platform_fee_changes f
     where f.status = 'scheduled' and f.effective_at <= now()
     order by f.effective_at, f.id
     limit greatest(coalesce(p_limit, 100), 1)
  loop
    select * into o from public.organizations where id = x.organization_id for no key update skip locked;
    continue when not found;
    select * into c from public.platform_fee_changes where id = x.id for no key update;
    continue when not found or c.status <> 'scheduled' or c.effective_at > now();
    perform private.set_actor('system', null);
    update public.organizations
       set platform_fee_percent = c.to_percent, platform_fee_fixed_cents = c.to_fixed_cents
     where id = o.id
       and (platform_fee_percent, platform_fee_fixed_cents) is distinct from (c.to_percent, c.to_fixed_cents);
    update public.platform_fee_changes set status = 'applied', applied_at = now() where id = c.id;
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
    values (o.id, 'system', null, 'organization.platform_fee_changed', 'organizations', o.id::text, 'info',
      jsonb_build_object(
        'before', jsonb_build_object('dispatch_model', o.dispatch_model, 'platform_fee_percent', o.platform_fee_percent,
          'platform_fee_fixed_cents', o.platform_fee_fixed_cents),
        'after', jsonb_build_object('dispatch_model', o.dispatch_model, 'platform_fee_percent', c.to_percent,
          'platform_fee_fixed_cents', c.to_fixed_cents),
        'mode', 'notice', 'change_id', c.id, 'announced_at', c.created_at, 'announced_by', c.created_by,
        'effective_at', c.effective_at, 'emails', c.emails_queued));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Super admin : annonce des CGV par e-mail (bouton « Prévenir par e-mail », /admin/legal)
-- -----------------------------------------------------------------------------
-- Organisations actives ou suspendues qui n'ont pas accepté p_version (CGV + accord de traitement) : e-mail à leurs
-- propriétaires (sinon à l'adresse de l'organisation), une seule fois par organisation et par version
-- (public.org_terms_notices) ; une organisation sans adresse valide n'est pas notée (nouvel essai possible une fois
-- l'adresse corrigée). Refusé une fois la date d'entrée en vigueur passée (le texte dit « au plus tard le … »).
create or replace function public.svc_org_terms_notify(p_actor uuid, p_version text, p_effective_on date, p_app_url text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version text := btrim(coalesce(p_version, ''));
  x record;
  v_mail jsonb;
  v_n integer;
  v_orgs integer := 0;
  v_emails integer := 0;
  v_already integer := 0;
  v_no_email integer := 0;
  v_pending integer := 0;
begin
  perform private.assert_platform_actor(p_actor);
  if not private.legal_version_ok(v_version) then
    return jsonb_build_object('ok', false, 'code', 'TERMS_VERSION_INVALID', 'message', 'Version des CGV invalide.');
  end if;
  if p_effective_on is null or p_effective_on < v_version::date then
    return jsonb_build_object('ok', false, 'code', 'TERMS_VERSION_INVALID', 'message', 'Date d''entrée en vigueur des CGV invalide.');
  end if;
  if p_effective_on <= (now() at time zone 'Europe/Paris')::date then
    return jsonb_build_object('ok', false, 'code', 'TERMS_EFFECTIVE_PASSED',
      'message', format('Entrée en vigueur des CGV atteinte (%s) : l''annonce, qui dit « au plus tard le %s », n''est plus envoyée.',
        to_char(p_effective_on, 'DD/MM/YYYY'), private.fr_long_date(p_effective_on)));
  end if;
  -- Un envoi à la fois (double clic, deux onglets) ; la clé primaire (organisation, version) garde le premier
  perform pg_advisory_xact_lock(hashtextextended('rydar.org_terms_notify', 0));
  perform private.set_actor('super_admin', p_actor);

  for x in
    select o.id
      from public.organizations o
     where o.status in ('active', 'suspended')
       and not private.org_terms_accepted(o.id, v_version)
     order by o.created_at, o.id
  loop
    v_pending := v_pending + 1;
    if exists (select 1 from public.org_terms_notices t where t.organization_id = x.id and t.version = v_version) then
      v_already := v_already + 1;
      continue;
    end if;
    if private.org_owner_emails(x.id) is null then
      v_no_email := v_no_email + 1;
      continue;
    end if;
    v_mail := private.org_terms_email(x.id, v_version, p_effective_on, p_app_url);
    v_n := private.queue_org_emails(x.id, 'org_terms_update', v_mail ->> 'subject', v_mail ->> 'body', null, p_actor);
    insert into public.org_terms_notices (organization_id, version, effective_on, emails_queued, created_by)
    values (x.id, v_version, p_effective_on, v_n, p_actor);
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
    values (x.id, 'super_admin', p_actor, 'organization.terms_notice_sent', 'organizations', x.id::text, 'info',
      jsonb_build_object('version', v_version, 'effective_on', p_effective_on, 'emails', v_n));
    v_orgs := v_orgs + 1;
    v_emails := v_emails + v_n;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'code', case when v_orgs > 0 then 'NOTIFIED' else 'NOTHING_TO_NOTIFY' end,
    'organizations', v_orgs,
    'emails', v_emails,
    'already_notified', v_already,
    'without_email', v_no_email,
    'not_accepted', v_pending,
    'message', concat_ws(' ',
      case when v_orgs > 0
        then format('%s organisation%s prévenue%s par e-mail (%s e-mail%s).', v_orgs, case when v_orgs > 1 then 's' else '' end,
          case when v_orgs > 1 then 's' else '' end, v_emails, case when v_emails > 1 then 's' else '' end)
        else 'Aucune organisation à prévenir.' end,
      case when v_already > 0
        then format('%s déjà prévenue%s pour cette version.', v_already, case when v_already > 1 then 's' else '' end) end,
      case when v_no_email > 0
        then format('%s sans adresse e-mail valide (propriétaire ni organisation).', v_no_email) end));
end;
$$;

-- -----------------------------------------------------------------------------
-- Lecture owner / admin : hausse annoncée dans le compte (« Frais Rydar », « Encaissements », bandeau)
-- -----------------------------------------------------------------------------
-- Dernière définition : 20260924006400_fleet_platform_fees.sql. Seul ajout : une hausse annoncée (taux > 0) active
-- aussi le suivi (menu « Frais Rydar » d'une flotte à 0 €, compte, vue d'ensemble du super admin).
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
      or exists (select 1 from public.platform_payments p where p.organization_id = p_org)
      -- Hausse annoncée : une flotte à 0 € voit le menu « Frais Rydar » et l'annonce dès maintenant
      or exists (select 1 from public.platform_fee_changes c
                  where c.organization_id = p_org and c.status = 'scheduled' and (c.to_percent > 0 or c.to_fixed_cents > 0));
$$;

-- Dernière définition : 20260924006400_fleet_platform_fees.sql. Seul ajout : clé « scheduled_change » (hausse
-- annoncée : taux, taux actuels, date d'effet, date de l'annonce ; null s'il n'y en a pas).
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
    -- Hausse annoncée, pas encore appliquée (20260924006600) : encart « À partir du JJ/MM/AAAA » (null : aucune)
    'scheduled_change', private.platform_scheduled_change_json(p_org, o.timezone),
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

-- Dernière définition : 20260924005900_expire_unstarted_rides.sql. Seul ajout : hausses annoncées appliquées à leur
-- date d'effet (private.apply_platform_fee_changes, compteur « platform_fee_changes_applied », erreur isolée).
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

  -- Frais Rydar : hausses annoncées arrivées à leur date d'effet (20260924006600). Erreur isolée comme les purges ;
  -- retentée au passage suivant.
  begin
    v_fee_changes := private.apply_platform_fee_changes();
  exception when others then
    v_fee_changes := null;
    v_errors := v_errors || jsonb_build_object('platform_fee_changes', left(sqlerrm, 300));
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

  return jsonb_build_object('rides_expired', v_expired, 'platform_fee_changes_applied', v_fee_changes,
    'history_purged', v_history, 'api_logs_purged', v_logs,
    'documents_expired', v_docs, 'notifications_purged', v_notifs, 'chat_purged', v_chat,
    'fleet_events_purged', v_fleet, 'audit_network_purged', v_network, 'rides_purged', v_rides,
    'bans_purged', v_bans, 'alert_positions_purged', v_alert_positions, 'debtor_identities_purged', v_debtors,
    'auth_audit_purged', v_auth)
    || case when v_errors = '{}'::jsonb then '{}'::jsonb else jsonb_build_object('errors', v_errors) end;
end;
$$;

-- -----------------------------------------------------------------------------
-- Relance WhatsApp de Rydar : refusée pour une flotte (modèle approuvé = « onglet Encaissements »)
-- -----------------------------------------------------------------------------
-- Dernière définition : 20260924006400_fleet_platform_fees.sql. Seul ajout : p_whatsapp refusé pour une flotte
-- (WHATSAPP_FLEET_UNSUPPORTED), avant toute écriture.
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
    -- Flotte : le modèle approuvé (rappel_frais_plateforme) renvoie à l'« onglet Encaissements », absent d'une
    -- flotte → refusé tant qu'un modèle neutre n'est pas approuvé (docs/WHATSAPP.md), sans consommer la limite d'une
    -- relance par heure ; la relance sans WhatsApp reste possible (affichée dans son tableau de bord).
    if o.dispatch_model = 'fleet' then
      return jsonb_build_object('ok', false, 'code', 'WHATSAPP_FLEET_UNSUPPORTED',
        'message', 'WhatsApp indisponible pour une flotte : le modèle approuvé par Meta renvoie à l''onglet « Encaissements », absent d''une flotte. Relancez sans WhatsApp (rappel affiché dans son tableau de bord).');
    end if;
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

-- Dernière définition : 20260924003700_whatsapp_reminders.sql. Seul changement : flotte → ready = false, reason
-- « FLEET_UNSUPPORTED » (case « Envoyer aussi par WhatsApp » désactivée).
create or replace function public.admin_platform_whatsapp(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_target jsonb;
  v_fleet boolean;
begin
  if not private.is_super_admin() then
    raise exception 'FORBIDDEN: réservé au super admin' using errcode = '42501';
  end if;
  v_target := private.platform_whatsapp_target(p_org);
  select o.dispatch_model = 'fleet' into v_fleet from public.organizations o where o.id = p_org;
  v_fleet := coalesce(v_fleet, false);
  return jsonb_build_object(
    'ready', private.whatsapp_ready('platform', null) and not v_fleet,
    'to_display', private.wa_mask(v_target ->> 'to'),
    'source', v_target -> 'source',
    'name', v_target -> 'name',
    'reason', case
      when v_fleet then 'FLEET_UNSUPPORTED'
      when not private.whatsapp_ready('platform', null) then 'NOT_CONFIGURED'
      when v_target ->> 'to' is null then 'NO_PHONE' end);
end;
$$;

-- -----------------------------------------------------------------------------
-- Libellés neutres : une flotte n'a pas de menu « Encaissements » (elle a « Frais Rydar »)
-- -----------------------------------------------------------------------------
-- Dernière définition : 20260924003000_platform_fees.sql. Seul changement : texte de PLATFORM_FEES_OVERDUE.
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
    raise exception 'PLATFORM_FEES_OVERDUE: frais plateforme en retard — réglez vos frais Rydar (menu « Frais Rydar » ou « Encaissements ») pour créer de nouvelles courses'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

-- Dernière définition : 20260924004500_audit_dispatch.sql. Seul changement : message de PLATFORM_FEES_OVERDUE.
create or replace function public.assign_ride(p_ride_id uuid, p_driver_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  d public.drivers;
  v_previous uuid;
  v_closed uuid[];
  v_alerts integer;
  v_tz text;
  v_max bigint;
  v_count bigint;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_FOUND', 'message', 'Course introuvable.');
  end if;
  perform private.assert_org_member(r.organization_id);
  perform private.set_actor('user', auth.uid());

  select * into d from public.drivers where id = p_driver_id and organization_id = r.organization_id;
  if not found then
    raise exception 'FORBIDDEN_TENANT: chauffeur hors de votre organisation' using errcode = '42501';
  end if;
  if d.status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_INACTIVE', 'message', 'Ce chauffeur n''est pas actif.');
  end if;
  if r.status not in ('CREATED', 'SEARCHING_DRIVER', 'OFFERED', 'NO_DRIVER_FOUND', 'ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED') then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_ASSIGNABLE', 'message', 'Cette course ne peut plus être réattribuée.');
  end if;
  if r.driver_id = d.id then
    return jsonb_build_object('ok', true, 'code', 'UNCHANGED');
  end if;

  select timezone into v_tz from public.organizations where id = r.organization_id;

  -- Course sans chauffeur : l'attribuer = la (re)mettre en service, mêmes règles que la création
  -- (private.rides_platform_block, private.enforce_plan_limits) comptée comme si elle était créée maintenant.
  if r.driver_id is null then
    if exists (select 1 from public.organizations o where o.id = r.organization_id and o.platform_block_after_days is not null)
       and private.platform_blocked(r.organization_id) then
      return jsonb_build_object('ok', false, 'code', 'PLATFORM_FEES_OVERDUE',
        'message', 'Frais plateforme en retard : réglez vos frais Rydar (menu « Frais Rydar » ou « Encaissements ») pour relancer ou attribuer une course.');
    end if;
    v_max := nullif(coalesce(private.org_limits(r.organization_id), '{}'::jsonb) ->> 'max_rides_per_month', '')::bigint;
    if v_max is not null then
      select count(*) into v_count from public.rides x
      where x.organization_id = r.organization_id
        and x.id <> r.id
        and x.created_at >= date_trunc('month', now() at time zone coalesce(v_tz, 'Europe/Paris')) at time zone coalesce(v_tz, 'Europe/Paris');
      if v_count >= v_max then
        return jsonb_build_object('ok', false, 'code', 'PLAN_LIMIT_RIDES',
          'message', 'Limite mensuelle de courses atteinte pour votre offre.');
      end if;
    end if;
  end if;

  v_previous := r.driver_id;

  if v_previous is not null then
    update public.ride_assignments
       set is_active = false, released_at = now(), release_reason = 'reassigned'
     where ride_id = r.id and is_active;
    perform private.release_driver_ride(v_previous, r.id, true);
    update public.notifications set status = 'cancelled'
     where ride_id = r.id and driver_id = v_previous and status = 'queued';
    perform private.queue_notification(r.organization_id, v_previous, r.id, null, 'ride_unassigned', 'COURSE RETIRÉE',
      format('La centrale a réattribué la course #%s', r.number),
      jsonb_build_object('type', 'ride_unassigned', 'ride_id', r.id), 'high', null);
  end if;

  update public.rides
     set driver_id = d.id, vehicle_id = d.vehicle_id, status = 'ACCEPTED', accepted_at = now(), next_dispatch_at = null,
         driver_en_route_at = null, driver_arrived_at = null
   where id = r.id;

  insert into public.ride_assignments (organization_id, ride_id, driver_id, vehicle_id, method, assigned_by)
  values (r.organization_id, r.id, d.id, d.vehicle_id, 'manual', auth.uid());

  v_closed := private.close_pending_offers(r.id, 'closed', 'manual_assignment');

  if r.type = 'instant' and d.current_ride_id is null then
    update public.drivers set presence = 'en_route', current_ride_id = r.id where id = d.id;
  elsif r.type = 'scheduled' then
    perform private.schedule_reminders(r.id);
  end if;

  perform private.queue_notification(r.organization_id, d.id, r.id, null, 'ride_assigned', 'COURSE ATTRIBUÉE',
    format('#%s · %s · %s → %s', r.number, to_char(r.pickup_at at time zone coalesce(v_tz, 'Europe/Paris'), 'DD/MM HH24:MI'),
      coalesce(private.short_address(r.pickup_address), r.pickup_address),
      coalesce(private.short_address(r.dropoff_address), r.dropoff_address)),
    jsonb_build_object('type', 'ride_assigned', 'ride_id', r.id), 'high', null);

  v_alerts := private.close_ride_alerts(r.id, 'reassigned', auth.uid());

  perform private.log_event(r.organization_id, r.id, 'ride.assigned_manually',
    format('Course attribuée manuellement à %s %s (#%s)', d.first_name, d.last_name, d.number),
    'timeline', 'success',
    jsonb_build_object('driver_id', d.id, 'previous_driver_id', v_previous, 'previous_status', r.status,
      'closed_offers', cardinality(v_closed), 'closed_alerts', v_alerts),
    'user', auth.uid());

  return jsonb_build_object('ok', true, 'code', 'ASSIGNED', 'ride_id', r.id);
end;
$$;

-- Dernière définition : 20260924004500_audit_dispatch.sql. Seul changement : message de PLATFORM_FEES_OVERDUE.
create or replace function public.redispatch_ride(p_ride_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  v_threshold integer;
  v_type public.ride_type;
  v_tz text;
  v_max bigint;
  v_count bigint;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_FOUND', 'message', 'Course introuvable.');
  end if;
  perform private.assert_org_member(r.organization_id);
  perform private.set_actor('user', auth.uid());

  if r.driver_id is not null or r.status not in ('CREATED', 'SEARCHING_DRIVER', 'OFFERED', 'NO_DRIVER_FOUND') then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_DISPATCHABLE', 'message', 'Cette course ne peut pas être relancée.');
  end if;

  -- Relancer = remettre la course en service : mêmes règles que la création (private.rides_platform_block,
  -- private.enforce_plan_limits), comptée comme si elle était créée maintenant.
  if exists (select 1 from public.organizations o where o.id = r.organization_id and o.platform_block_after_days is not null)
     and private.platform_blocked(r.organization_id) then
    return jsonb_build_object('ok', false, 'code', 'PLATFORM_FEES_OVERDUE',
      'message', 'Frais plateforme en retard : réglez vos frais Rydar (menu « Frais Rydar » ou « Encaissements ») pour relancer ou attribuer une course.');
  end if;
  v_max := nullif(coalesce(private.org_limits(r.organization_id), '{}'::jsonb) ->> 'max_rides_per_month', '')::bigint;
  if v_max is not null then
    select timezone into v_tz from public.organizations where id = r.organization_id;
    select count(*) into v_count from public.rides x
    where x.organization_id = r.organization_id
      and x.id <> r.id
      and x.created_at >= date_trunc('month', now() at time zone coalesce(v_tz, 'Europe/Paris')) at time zone coalesce(v_tz, 'Europe/Paris');
    if v_count >= v_max then
      return jsonb_build_object('ok', false, 'code', 'PLAN_LIMIT_RIDES',
        'message', 'Limite mensuelle de courses atteinte pour votre offre.');
    end if;
  end if;

  select instant_threshold_minutes into v_threshold from public.organization_settings where organization_id = r.organization_id;
  v_type := case when r.pickup_at <= now() + make_interval(mins => coalesce(v_threshold, 45)) then 'instant' else 'scheduled' end;

  perform private.close_pending_offers(r.id, 'expired', 'redispatch');
  update public.rides
     set status = 'SEARCHING_DRIVER',
         type = v_type,
         pickup_at = greatest(pickup_at, now()),
         dispatch_mode = case when v_type = 'instant' then 'geo' else 'fleet' end::public.dispatch_mode,
         dispatch_wave = 0,
         dispatch_started_at = now(),
         no_driver_at = null,
         next_dispatch_at = null
   where id = r.id;

  perform private.log_event(r.organization_id, r.id, 'dispatch.relaunched', 'Dispatch relancé par le rattacheur',
    'timeline', 'info', jsonb_build_object('type', v_type), 'user', auth.uid());

  if v_type = 'instant' then
    perform private.run_geo_wave(r.id);
  else
    perform private.offer_to_fleet(r.id);
  end if;

  return jsonb_build_object('ok', true, 'code', 'RELAUNCHED');
end;
$$;

-- Dernière définition : 20260924005400_contre_audit_sql.sql. Seul changement : texte de l'événement
-- « dispatch.relaunch_blocked » pour PLATFORM_FEES_OVERDUE.
create or replace function private.apply_flight_status(
  p_ride_id uuid,
  p_status text,
  p_scheduled timestamptz default null,
  p_estimated timestamptz default null,
  p_actual timestamptz default null,
  p_terminal text default null,
  p_origin text default null,
  p_provider text default null,
  p_flight_number text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  s public.organization_settings;
  v_tz text;
  v_raw text := lower(btrim(coalesce(p_status, '')));
  v_status text;
  v_scheduled timestamptz;
  v_estimated timestamptz;
  v_actual timestamptz;
  v_terminal text;
  v_origin text;
  v_delay integer;
  v_delay_raw numeric;
  v_flight text;
  v_mode text;
  v_eta timestamptz;
  v_ideal timestamptz;
  v_target timestamptz;
  v_reference timestamptz;
  v_lead interval;
  v_shift boolean := false;
  v_relative boolean := false;
  v_requalified text;
  v_incoherent boolean := false;
  v_fleet boolean := false;
  v_restart_block text;
  v_changed boolean;
  v_status_changed boolean;
  v_terminal_changed boolean;
  v_at_label text;
  v_eta_label text;
  v_terminal_label text;
  v_shift_type text;
  v_shift_msg text;
  v_msg text;
  v_events text[] := '{}';
  v_data jsonb;
  v_notif_type text;
  v_notif_title text;
  v_notif_body text;
  v_notified boolean := false;
begin
  perform private.set_actor('system', null);

  -- Point de sérialisation (accept, dispatch_tick, annulation) : la ligne de la course
  select * into r from public.rides where id = p_ride_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_FOUND', 'message', 'Course introuvable.');
  end if;
  if nullif(btrim(r.flight_number), '') is null then
    return jsonb_build_object('ok', false, 'code', 'NO_FLIGHT', 'message', 'Aucun numéro de vol sur cette course.');
  end if;
  if r.status in ('COMPLETED', 'CANCELLED') then
    return jsonb_build_object('ok', false, 'code', 'RIDE_CLOSED', 'message', 'Course déjà clôturée.');
  end if;
  v_flight := upper(regexp_replace(r.flight_number, '\s+', '', 'g'));
  -- Numéro modifié au dashboard pendant l'interrogation du fournisseur : résultat obsolète
  if p_flight_number is not null and upper(regexp_replace(p_flight_number, '\s+', '', 'g')) <> v_flight then
    return jsonb_build_object('ok', false, 'code', 'FLIGHT_CHANGED', 'message', 'Le numéro de vol a changé entre-temps.');
  end if;

  select * into s from public.organization_settings where organization_id = r.organization_id;
  if not coalesce(s.flight_tracking_enabled, true) then
    return jsonb_build_object('ok', false, 'code', 'TRACKING_DISABLED', 'message', 'Suivi des vols désactivé.');
  end if;
  select o.timezone into v_tz from public.organizations o where o.id = r.organization_id;
  v_tz := coalesce(v_tz, 'Europe/Paris');
  v_lead := make_interval(mins => coalesce(s.scheduled_dispatch_lead_minutes, 60));

  v_mode := coalesce(r.flight_mode, case when private.is_airport_address(r.pickup_address) then 'arrival' else 'departure' end);

  -- Statut normalisé (vocabulaires fournisseurs courants) ; « inconnu » ne remplace pas un statut connu
  v_status := case
    when v_raw in ('scheduled', 'delayed', 'departed', 'landed', 'cancelled', 'diverted', 'unknown') then v_raw
    when v_raw in ('canceled', 'cancelled_flight') then 'cancelled'
    when v_raw in ('active', 'airborne', 'en-route', 'en_route', 'enroute', 'in_air', 'inflight', 'in-flight') then 'departed'
    when v_raw in ('arrived', 'landed_arrived') then 'landed'
    when v_raw in ('expected', 'on_time', 'ontime', 'on-time', 'planned') then 'scheduled'
    when v_raw in ('redirected') then 'diverted'
    else 'unknown'
  end;
  if v_status = 'unknown' and r.flight_status is not null then
    v_status := r.flight_status;
  end if;

  -- Valeurs absentes de la réponse : on garde la dernière valeur connue
  v_scheduled := coalesce(p_scheduled, r.flight_scheduled_arrival);
  v_estimated := coalesce(p_estimated, r.flight_estimated_arrival);
  v_actual := coalesce(p_actual, r.flight_actual_arrival);
  v_terminal := coalesce(left(nullif(btrim(p_terminal), ''), 20), r.flight_terminal);
  v_origin := coalesce(left(nullif(btrim(p_origin), ''), 60), r.flight_origin);

  -- Retard = arrivée (réelle, sinon estimée) − prévue
  if v_scheduled is not null and coalesce(v_actual, v_estimated) is not null then
    v_delay_raw := round(extract(epoch from (coalesce(v_actual, v_estimated) - v_scheduled)) / 60.0);
    v_delay := case when abs(v_delay_raw) <= 100000 then v_delay_raw::integer end;
  else
    v_delay := r.flight_delay_minutes;
  end if;
  if v_status = 'scheduled' and coalesce(v_delay, 0) >= 15 then
    v_status := 'delayed';
  end if;

  v_status_changed := v_status is distinct from r.flight_status;
  v_terminal_changed := r.flight_terminal is not null and v_terminal is distinct from r.flight_terminal;
  v_changed := v_status_changed
    or v_scheduled is distinct from r.flight_scheduled_arrival
    or v_estimated is distinct from r.flight_estimated_arrival
    or v_actual is distinct from r.flight_actual_arrival
    or v_terminal is distinct from r.flight_terminal
    or v_origin is distinct from r.flight_origin
    or v_delay is distinct from r.flight_delay_minutes;

  v_eta := coalesce(v_actual, v_estimated, v_scheduled);
  v_reference := coalesce(r.pickup_at_original, r.pickup_at);

  -- Mode arrivée : la prise en charge suit le RETARD du vol, à partir de l'heure demandée
  --   (heure demandée + (arrivée réelle | estimée − arrivée prévue)) : un vol à l'heure ne déplace
  --   jamais l'heure choisie par le client, même s'il a prévu plus (ou moins) que la marge.
  --   Sans horaire prévu, ou heure demandée AVANT l'arrivée prévue (réservation incohérente) :
  --   arrivée + marge bagages. Jamais dans le passé.
  if v_mode = 'arrival'
     and v_eta is not null
     and v_status not in ('cancelled', 'diverted')
     and r.status in ('CREATED', 'SEARCHING_DRIVER', 'OFFERED', 'ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'NO_DRIVER_FOUND')
  then
    v_relative := v_scheduled is not null and v_reference >= v_scheduled;
    v_ideal := case
      when v_relative then date_trunc('minute', v_reference + (v_eta - v_scheduled))
      else date_trunc('minute', v_eta) + make_interval(mins => coalesce(s.flight_pickup_buffer_minutes, 15))
    end;
    if abs(extract(epoch from (v_eta - v_reference))) > 86400
       or abs(extract(epoch from (v_ideal - v_reference))) > 12 * 3600 then
      -- Vol à plus de 24 h de l'heure demandée (mauvais vol / mauvaise date) ou décalage > 12 h : pas de recalage
      v_incoherent := true;
    else
      v_target := greatest(v_ideal, now());
      -- Comparaison des heures « effectives » (une heure déjà passée vaut maintenant) : pas de
      -- recalage répété vers now() quand l'heure idéale est déjà dépassée.
      v_shift := abs(extract(epoch from (v_target - greatest(r.pickup_at, now())))) >= 300;
    end if;
  end if;

  v_fleet := v_shift and r.dispatch_mode = 'fleet' and r.driver_id is null and r.status in ('SEARCHING_DRIVER', 'OFFERED');

  update public.rides
     set flight_status = v_status,
         flight_scheduled_arrival = v_scheduled,
         flight_estimated_arrival = v_estimated,
         flight_actual_arrival = v_actual,
         flight_terminal = v_terminal,
         flight_origin = v_origin,
         flight_delay_minutes = v_delay,
         flight_checked_at = now(),
         pickup_at_original = case when v_shift then coalesce(pickup_at_original, pickup_at) else pickup_at_original end,
         pickup_at = case when v_shift then v_target else pickup_at end,
         -- Planifiée proposée à la flotte : bascule GPS recalée (T-lead), au plus tard dans 5 min
         next_dispatch_at = case when v_fleet then least(v_target - v_lead, now() + interval '5 minutes') else next_dispatch_at end
   where id = r.id;

  if v_fleet then
    update public.ride_offers
       set expires_at = greatest(v_target - v_lead, now() + make_interval(secs => coalesce(s.offer_timeout_seconds, 30)))
     where ride_id = r.id and status = 'pending' and mode = 'fleet';
  end if;

  -- Retard qui repousse une course INSTANTANÉE au-delà du seuil « instantané » : elle redevient une
  -- planifiée, comme à la création ou à la relance. Sinon : vagues GPS et « aucun chauffeur » des heures
  -- avant la prise en charge, ou chauffeur bloqué « en route » pendant tout le retard.
  if v_shift and r.type = 'instant'
     and v_target > now() + make_interval(mins => coalesce(s.instant_threshold_minutes, 45)) then
    if r.driver_id is null and r.status in ('SEARCHING_DRIVER', 'OFFERED', 'NO_DRIVER_FOUND') then
      -- Recherche terminée (NO_DRIVER_FOUND) : la relancer = la remettre en service, mêmes règles que
      -- redispatch_ride / assign_ride (frais plateforme en retard, quota mensuel)
      if r.status = 'NO_DRIVER_FOUND' then
        v_restart_block := private.ride_restart_blocker(r.organization_id, r.id);
      end if;
      if v_restart_block is null then
        perform private.close_pending_offers(r.id, 'closed', 'flight_rescheduled');
        update public.rides
           set type = 'scheduled', dispatch_mode = 'fleet', status = 'SEARCHING_DRIVER', dispatch_wave = 0,
               dispatch_radius_m = null, dispatch_started_at = now(), no_driver_at = null, next_dispatch_at = null
         where id = r.id;
        perform private.offer_to_fleet(r.id);
        v_requalified := 'fleet';
      end if;
    elsif r.driver_id is not null and r.status = 'ACCEPTED' then
      -- Le chauffeur garde la course (planning, rappels) et redevient disponible d'ici là
      -- (ou enchaîne sur sa course suivante)
      update public.rides set type = 'scheduled' where id = r.id;
      perform private.release_driver_ride(r.driver_id, r.id, true);
      v_requalified := 'assigned';
    end if;
    if v_requalified is not null then
      perform private.log_event(r.organization_id, r.id, 'ride.requalified',
        format('Prise en charge repoussée à %s : course repassée en planifiée%s',
          private.fmt_local_time(v_target, v_tz, v_reference),
          case v_requalified when 'fleet' then ' et proposée à toute la flotte'
            else ' — le chauffeur reste attribué et redevient disponible d''ici là' end),
        'timeline', 'info', jsonb_build_object('type', 'scheduled', 'pickup_at', v_target, 'mode', v_requalified),
        'system', null);
    end if;
  end if;

  -- Retard qui repousse une PLANIFIÉE sans chauffeur, déjà passée en recherche GPS (T-lead), au-delà de la
  -- bascule : de nouveau proposée à toute la flotte (sinon vagues GPS puis « aucun chauffeur » des heures avant
  -- la prise en charge). La bascule GPS reviendra à la nouvelle heure − T-lead (offer_to_fleet).
  if v_shift and r.type = 'scheduled' and r.dispatch_mode = 'geo' and r.driver_id is null
     and r.status in ('SEARCHING_DRIVER', 'OFFERED', 'NO_DRIVER_FOUND')
     and v_target - v_lead > now() then
    -- Recherche terminée : mêmes règles que la relance (voir plus haut)
    if r.status = 'NO_DRIVER_FOUND' then
      v_restart_block := private.ride_restart_blocker(r.organization_id, r.id);
    end if;
    if v_restart_block is null then
      perform private.close_pending_offers(r.id, 'closed', 'flight_rescheduled');
      update public.rides
         set dispatch_mode = 'fleet', status = 'SEARCHING_DRIVER', dispatch_wave = 0,
             dispatch_radius_m = null, dispatch_started_at = now(), no_driver_at = null, next_dispatch_at = null
       where id = r.id;
      perform private.offer_to_fleet(r.id);
      v_requalified := 'fleet';
      perform private.log_event(r.organization_id, r.id, 'ride.requalified',
        format('Prise en charge repoussée à %s : course de nouveau proposée à toute la flotte',
          private.fmt_local_time(v_target, v_tz, v_reference)),
        'timeline', 'info', jsonb_build_object('type', 'scheduled', 'pickup_at', v_target, 'mode', 'fleet'),
        'system', null);
    end if;
  end if;

  -- Relance refusée (centrale bloquée pour frais plateforme en retard, ou quota mensuel atteint) : la course reste
  -- sans chauffeur (NO_DRIVER_FOUND), seule l'heure de prise en charge suit le vol ; la centrale la relance
  -- elle-même une fois la situation réglée.
  if v_restart_block is not null then
    perform private.log_event(r.organization_id, r.id, 'dispatch.relaunch_blocked',
      format('Prise en charge repoussée à %s : course non relancée — %s',
        private.fmt_local_time(v_target, v_tz, v_reference),
        case v_restart_block
          when 'PLATFORM_FEES_OVERDUE' then 'frais plateforme en retard (réglez vos frais Rydar, menu « Frais Rydar » ou « Encaissements », puis relancez-la)'
          else 'limite mensuelle de courses atteinte pour votre offre'
        end),
      'timeline', 'warning', jsonb_build_object('code', v_restart_block, 'pickup_at', v_target), 'system', null);
  end if;

  if v_shift and r.driver_id is not null then
    perform private.schedule_reminders(r.id);
  end if;

  -- ------------------------------------------------------------- journal
  v_at_label := private.fmt_local_time(v_target, v_tz, v_reference);
  v_eta_label := private.fmt_local_time(v_eta, v_tz, v_reference);
  v_terminal_label := case when v_terminal is not null then format(' (terminal %s)', v_terminal) else '' end;
  v_data := jsonb_build_object(
    'flight_number', v_flight, 'mode', v_mode, 'flight_status', v_status, 'previous_status', r.flight_status,
    'delay_minutes', v_delay, 'scheduled', v_scheduled, 'estimated', v_estimated, 'actual', v_actual,
    'terminal', v_terminal, 'origin', v_origin, 'provider', left(p_provider, 40),
    'pickup_at', case when v_shift then v_target else r.pickup_at end,
    'previous_pickup_at', r.pickup_at,
    'pickup_at_original', case when v_shift then coalesce(r.pickup_at_original, r.pickup_at) else r.pickup_at_original end);

  if v_shift then
    if coalesce(v_delay, 0) >= 5 then
      v_shift_type := 'flight.delayed';
      v_shift_msg := format('Vol %s retardé de %s — prise en charge à %s', v_flight, private.fmt_minutes(v_delay), v_at_label);
    elsif coalesce(v_delay, 0) <= -5 then
      v_shift_type := 'flight.early';
      v_shift_msg := format('Vol %s en avance de %s — prise en charge à %s', v_flight, private.fmt_minutes(v_delay), v_at_label);
    else
      v_shift_type := 'flight.updated';
      v_shift_msg := format('Vol %s — prise en charge ajustée à %s (arrivée %s%s)', v_flight, v_at_label, v_eta_label,
        case when v_relative then '' else format(' + %s min', coalesce(s.flight_pickup_buffer_minutes, 15)) end);
    end if;
    perform private.log_event(r.organization_id, r.id, v_shift_type, v_shift_msg, 'timeline',
      case when v_shift_type = 'flight.delayed' and v_delay >= 15 then 'warning' else 'info' end::public.event_level,
      v_data, 'system', null);
    v_events := v_events || v_shift_type;
  end if;

  if v_status_changed and v_status = 'landed' and v_mode = 'arrival' then
    v_msg := format('Vol %s atterri%s%s', v_flight,
      case when v_actual is not null then ' à ' || private.fmt_local_time(v_actual, v_tz, v_reference) else '' end, v_terminal_label);
    perform private.log_event(r.organization_id, r.id, 'flight.landed', v_msg, 'timeline', 'success', v_data, 'system', null);
    v_events := v_events || 'flight.landed'::text;
  end if;

  if v_status_changed and v_status = 'cancelled' then
    perform private.log_event(r.organization_id, r.id, 'flight.cancelled', format('Vol %s annulé', v_flight),
      'timeline', 'warning', v_data, 'system', null);
    v_events := v_events || 'flight.cancelled'::text;
  end if;

  if v_status_changed and v_status = 'diverted' then
    perform private.log_event(r.organization_id, r.id, 'flight.updated', format('Vol %s dérouté', v_flight),
      'timeline', 'warning', v_data, 'system', null);
    v_events := v_events || 'flight.diverted'::text;
  end if;

  -- Mode départ : information seulement (retard significatif au départ)
  if v_mode = 'departure' and v_status <> 'cancelled' and coalesce(v_delay, 0) >= 15
     and (r.flight_delay_minutes is null or r.flight_delay_minutes < 15 or abs(v_delay - r.flight_delay_minutes) >= 15)
  then
    perform private.log_event(r.organization_id, r.id, 'flight.delayed',
      format('Vol %s retardé de %s au départ — prise en charge inchangée', v_flight, private.fmt_minutes(v_delay)),
      'timeline', 'warning', v_data, 'system', null);
    v_events := v_events || 'flight.departure_delayed'::text;
  end if;

  if v_terminal_changed then
    perform private.log_event(r.organization_id, r.id, 'flight.updated',
      format('Vol %s : changement de terminal — %s (au lieu de %s)', v_flight, v_terminal, r.flight_terminal),
      'timeline', 'info', v_data, 'system', null);
    v_events := v_events || 'flight.terminal'::text;
  end if;

  if v_incoherent and (v_scheduled is distinct from r.flight_scheduled_arrival or v_status_changed) then
    perform private.log_event(r.organization_id, r.id, 'flight.updated',
      format('Horaires du vol %s incohérents avec la prise en charge — vérifiez le numéro de vol', v_flight),
      'timeline', 'warning', v_data, 'system', null);
    v_events := v_events || 'flight.incoherent'::text;
  end if;

  -- Autre changement de statut (1re information, décollage…) : une ligne de suivi
  if cardinality(v_events) = 0 and v_status_changed and v_status <> 'unknown' then
    v_msg := case
      when r.flight_status is null and v_mode = 'arrival' then
        format('Vol %s suivi — arrivée %s à %s%s', v_flight,
          case when v_actual is not null then 'effective' when v_estimated is not null then 'estimée' else 'prévue' end,
          v_eta_label, v_terminal_label)
      when r.flight_status is null then
        format('Vol %s suivi — départ %s à %s%s', v_flight,
          case when v_actual is not null then 'effectif' when v_estimated is not null then 'estimé' else 'prévu' end,
          v_eta_label, v_terminal_label)
      else
        format('Vol %s %s%s', v_flight,
          case v_status
            when 'scheduled' then 'à l''heure'
            when 'delayed' then 'annoncé en retard'
            when 'departed' then 'a décollé'
            when 'landed' then 'arrivé à destination'
            else v_status
          end,
          case when v_mode = 'arrival' and v_eta is not null and v_status <> 'landed' then ' — arrivée estimée à ' || v_eta_label else '' end)
    end;
    if v_eta is not null or r.flight_status is not null then
      perform private.log_event(r.organization_id, r.id, 'flight.updated', v_msg, 'timeline', 'info', v_data, 'system', null);
      v_events := v_events || 'flight.updated'::text;
    end if;
  end if;

  -- ------------------------------------------------------------- notification chauffeur (une seule)
  if r.driver_id is not null then
    if 'flight.cancelled' = any (v_events) then
      v_notif_type := 'flight.cancelled';
      v_notif_title := 'VOL ANNULÉ';
      v_notif_body := format('Le vol %s est annulé — attendez les consignes de la centrale', v_flight);
    elsif 'flight.landed' = any (v_events) then
      v_notif_type := 'flight.landed';
      v_notif_title := 'VOL ATTERRI';
      v_notif_body := format('Le vol %s a atterri%s', v_flight, v_terminal_label)
        || case when v_shift then ' — prise en charge à ' || v_at_label else '' end;
    elsif v_shift then
      v_notif_type := v_shift_type;
      v_notif_title := case v_shift_type when 'flight.delayed' then 'VOL RETARDÉ' when 'flight.early' then 'VOL EN AVANCE' else 'HORAIRE MODIFIÉ' end;
      v_notif_body := v_shift_msg;
    elsif 'flight.diverted' = any (v_events) and v_mode = 'arrival' then
      v_notif_type := 'flight.diverted';
      v_notif_title := 'VOL DÉROUTÉ';
      v_notif_body := format('Le vol %s est dérouté — attendez les consignes de la centrale', v_flight);
    elsif 'flight.departure_delayed' = any (v_events) then
      v_notif_type := 'flight.departure_delayed';
      v_notif_title := 'VOL RETARDÉ';
      v_notif_body := format('Vol %s retardé de %s au départ — prise en charge inchangée à %s', v_flight,
        private.fmt_minutes(v_delay), private.fmt_local_time(r.pickup_at, v_tz, null));
    elsif 'flight.terminal' = any (v_events) and v_mode = 'arrival' then
      v_notif_type := 'flight.terminal';
      v_notif_title := 'TERMINAL MODIFIÉ';
      v_notif_body := format('Vol %s : arrivée au terminal %s', v_flight, v_terminal);
    end if;

    if v_notif_title is not null then
      perform private.queue_notification(r.organization_id, r.driver_id, r.id, null, 'flight_update', v_notif_title, v_notif_body,
        jsonb_build_object(
          'type', 'flight_update', 'event', v_notif_type, 'ride_id', r.id, 'flight_number', v_flight,
          'flight_status', v_status, 'delay_minutes', v_delay, 'terminal', v_terminal,
          'pickup_at', case when v_shift then v_target else r.pickup_at end,
          'pickup_at_original', case when v_shift then coalesce(r.pickup_at_original, r.pickup_at) else r.pickup_at_original end),
        'high', null);
      v_notified := true;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'code', case when v_changed or v_shift then 'UPDATED' else 'UNCHANGED' end,
    'ride_id', r.id,
    'mode', v_mode,
    'flight_status', v_status,
    'delay_minutes', v_delay,
    'pickup_changed', v_shift,
    'pickup_at', case when v_shift then v_target else r.pickup_at end,
    'previous_pickup_at', r.pickup_at,
    'pickup_at_original', case when v_shift then coalesce(r.pickup_at_original, r.pickup_at) else r.pickup_at_original end,
    'events', to_jsonb(v_events),
    'notified', v_notified,
    -- 'fleet' : de nouveau proposée à toute la flotte (instantanée repassée en planifiée, ou planifiée repoussée
    -- après la bascule GPS) ; 'assigned' : instantanée attribuée repassée en planifiée ; sinon null
    'requalified', v_requalified);
end;
$$;

-- -----------------------------------------------------------------------------
-- Droits d'exécution (deny-by-default, cf. 20260924000900) — fonctions redéfinies : droits conservés
-- -----------------------------------------------------------------------------
-- Outils, textes et ménage : appelés seulement par les fonctions security definer ci-dessus et par
-- private.housekeeping ; ni client ni service role (un e-mail n'est jamais mis en file directement)
revoke execute on function
  private.fr_typo(text),
  private.fr_long_date(date),
  private.email_address_ok(text),
  private.app_origin(text),
  private.platform_reply_to(),
  private.legal_version_ok(text),
  private.org_terms_accepted(uuid, text),
  private.org_owner_emails(uuid),
  private.platform_fee_terms_text(numeric, integer),
  private.platform_fee_min_effective_on(uuid, text, date),
  private.queue_org_emails(uuid, text, text, text, uuid, uuid),
  private.platform_fee_change_email(text, uuid, text, numeric, integer, numeric, integer, date, date, text),
  private.org_terms_email(uuid, text, date, text),
  private.platform_scheduled_change_json(uuid, text),
  private.platform_fee_change_admin_json(public.platform_fee_changes, text),
  private.apply_platform_fee_changes(integer),
  private.organizations_platform_rates_guard()
from public, anon, authenticated, service_role;

-- Super admin : actions serveur (service role, auteur p_actor revérifié par private.assert_platform_actor)
revoke execute on function
  public.svc_platform_set_fees(uuid, uuid, numeric, integer, text, text, date, text, text, date, text),
  public.svc_platform_cancel_fee_change(uuid, uuid, uuid, text, text),
  public.svc_org_terms_notify(uuid, text, date, text)
from public, anon, authenticated;
grant execute on function
  public.svc_platform_set_fees(uuid, uuid, numeric, integer, text, text, date, text, text, date, text),
  public.svc_platform_cancel_fee_change(uuid, uuid, uuid, text, text),
  public.svc_org_terms_notify(uuid, text, date, text)
to service_role;

-- Super admin : lecture par sa session (contrôle private.is_super_admin dans la fonction)
revoke execute on function public.admin_platform_fee_schedule(uuid, text, date, numeric, integer) from public, anon;
grant execute on function public.admin_platform_fee_schedule(uuid, text, date, numeric, integer) to authenticated, service_role;
