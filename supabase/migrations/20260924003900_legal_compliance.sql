-- =============================================================================
-- Rydar Drive — Conformité : identité légale de l'éditeur, acceptation des conditions, inscription VTC des centrales,
-- durées de conservation annoncées par /confidentialite et /dpa.
--
--  * public.platform_legal (ligne unique) : éditeur (raison sociale, forme, capital, siège, RCS/SIREN, TVA,
--    directeur de la publication, contacts) et hébergeurs, affichés dans les mentions légales, la politique de
--    confidentialité, les CGU / CGV et l'accord de traitement des données. Lecture publique par
--    public.public_legal_info() (ce sont des informations publiques par nature) ; écriture : super admin
--    (svc_platform_legal_update, service role, audit).
--  * public.legal_acceptances : preuve d'acceptation (qui, quel document, quelle version, quand, au nom de quelle
--    centrale). Chauffeurs : CGU + politique de confidentialité à l'inscription ; centrales : CGV + accord de
--    traitement des données (art. 28 RGPD) par le propriétaire ou un administrateur. Preuve en AJOUT SEUL : ni
--    modification ni suppression ; compte supprimé → la ligne reste, détachée du compte (avec l'e-mail du
--    signataire pour les CGV et l'accord de traitement) ; une centrale qui a accepté ne se supprime plus (archivage).
--  * organizations.vtc_registration : numéro d'inscription au registre VTC / déclaration de centrale de
--    réservation (Code des transports), affiché sur le mini-site de réservation.
--  * Durées de conservation (private.housekeeping, dernière définition 20260924003300) : signalements de la flotte
--    recopiés dans le journal 180 jours, notifications 90 jours quel que soit leur statut, adresse IP et navigateur
--    du journal d'audit 1 an, courses 10 ans après la fin de leur année, bannissements 3 ans
--    (private.purge_expired_bans).
-- =============================================================================

-- ----------------------------------------------------------------- identité légale de l'éditeur
create table public.platform_legal (
  id boolean primary key default true check (id),
  company_name text check (company_name is null or char_length(company_name) between 2 and 160),
  legal_form text check (legal_form is null or char_length(legal_form) <= 60),
  share_capital text check (share_capital is null or char_length(share_capital) <= 60),
  address text check (address is null or char_length(address) <= 300),
  registration text check (registration is null or char_length(registration) <= 120),
  vat_number text check (vat_number is null or char_length(vat_number) <= 40),
  publication_director text check (publication_director is null or char_length(publication_director) <= 120),
  email text check (email is null or (char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  phone text check (phone is null or char_length(phone) <= 40),
  privacy_email text check (privacy_email is null or (char_length(privacy_email) <= 254 and privacy_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  host_name text check (host_name is null or char_length(host_name) <= 160),
  host_address text check (host_address is null or char_length(host_address) <= 300),
  host_phone text check (host_phone is null or char_length(host_phone) <= 40),
  data_host text check (data_host is null or char_length(data_host) <= 300),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users (id) on delete set null
);
comment on table public.platform_legal is
  'Éditeur et hébergeurs (mentions légales, confidentialité, CGU/CGV) — lecture publique via public_legal_info(), écriture : super admin.';
insert into public.platform_legal (id) values (true) on conflict do nothing;

alter table public.platform_legal enable row level security;
create policy platform_legal_select on public.platform_legal for select to authenticated
  using ((select private.is_super_admin()));
revoke all on public.platform_legal from anon, authenticated;
grant select on public.platform_legal to authenticated;
grant all on public.platform_legal to service_role;

-- Informations publiques (pages légales, sans connexion)
create or replace function public.public_legal_info()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select jsonb_build_object(
      'company_name', l.company_name, 'legal_form', l.legal_form, 'share_capital', l.share_capital, 'address', l.address,
      'registration', l.registration, 'vat_number', l.vat_number, 'publication_director', l.publication_director,
      'email', l.email, 'phone', l.phone, 'privacy_email', l.privacy_email,
      'host_name', l.host_name, 'host_address', l.host_address, 'host_phone', l.host_phone, 'data_host', l.data_host,
      'updated_at', l.updated_at)
    from public.platform_legal l where l.id), '{}'::jsonb);
$$;

-- Super admin (web, service role) : champs vides = non renseignés
create or replace function public.svc_platform_legal_update(p_actor uuid, p_info jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_in jsonb := coalesce(p_info, '{}'::jsonb);
  v jsonb := '{}'::jsonb;
  f text;
begin
  perform private.assert_platform_actor(p_actor);
  if jsonb_typeof(v_in) <> 'object' then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'message', 'Informations légales invalides.');
  end if;
  -- Champs connus seulement, texte nettoyé, vide → null ; e-mails en minuscules (journal = valeurs enregistrées)
  foreach f in array array['company_name', 'legal_form', 'share_capital', 'address', 'registration', 'vat_number',
    'publication_director', 'email', 'phone', 'privacy_email', 'host_name', 'host_address', 'host_phone', 'data_host'] loop
    v := v || jsonb_build_object(f, nullif(btrim(regexp_replace(coalesce(v_in ->> f, ''), '\s+', ' ', 'g')), ''));
  end loop;
  v := v || jsonb_build_object('email', lower(v ->> 'email'), 'privacy_email', lower(v ->> 'privacy_email'));
  perform private.set_actor('super_admin', p_actor);
  insert into public.platform_legal (id) values (true) on conflict do nothing;
  begin
    update public.platform_legal set
      company_name = v ->> 'company_name', legal_form = v ->> 'legal_form', share_capital = v ->> 'share_capital',
      address = v ->> 'address', registration = v ->> 'registration', vat_number = v ->> 'vat_number',
      publication_director = v ->> 'publication_director', email = v ->> 'email', phone = v ->> 'phone',
      privacy_email = v ->> 'privacy_email', host_name = v ->> 'host_name', host_address = v ->> 'host_address',
      host_phone = v ->> 'host_phone', data_host = v ->> 'data_host', updated_at = now(), updated_by = p_actor
    where id;
  exception when check_violation then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'message', 'Valeur invalide (e-mail, longueur) : vérifiez les champs.');
  end;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (null, 'super_admin', p_actor, 'platform_legal.updated', 'platform_legal', 'platform', 'info', v);
  return jsonb_build_object('ok', true, 'code', 'SAVED', 'message', 'Informations légales enregistrées.');
end;
$$;

-- ----------------------------------------------------------------- acceptation des documents
create table public.legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  -- Compte supprimé : la preuve reste, détachée du compte
  user_id uuid references public.users (id) on delete set null,
  -- Centrale qui a accepté : suppression refusée (preuve du contrat ; la centrale s'archive, elle ne se supprime pas)
  organization_id uuid references public.organizations (id) on delete restrict,
  document text not null check (document in ('cgu', 'privacy', 'cgv', 'dpa')),
  version text not null check (char_length(version) between 1 and 40),
  accepted_at timestamptz not null default now(),
  source text not null default 'web' check (source in ('web', 'app', 'join', 'admin')),
  -- Signataire des CGV et de l'accord de traitement d'une centrale, copié du compte à l'acceptation
  accepted_by_email text check (accepted_by_email is null or char_length(accepted_by_email) <= 254)
);
-- Une acceptation par personne, centrale, document et version : pas de doublon, même en cas d'appels simultanés
create unique index legal_acceptances_uniq on public.legal_acceptances
  (user_id, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), document, version);
create index legal_acceptances_org_idx on public.legal_acceptances (organization_id, document, accepted_at desc) where organization_id is not null;
comment on table public.legal_acceptances is
  'Preuve d''acceptation des documents légaux (CGU, confidentialité, CGV, accord de traitement) par version. Ajout seul.';
comment on column public.legal_acceptances.accepted_by_email is
  'Signataire des CGV / de l''accord de traitement d''une centrale : conservé si son compte est supprimé (preuve du contrat).';

-- Signataire copié à l'insertion, jamais fourni par l'appelant : CGV et accord de traitement seulement (une
-- acceptation personnelle des CGU ou de la politique devient anonyme quand le compte est supprimé)
create or replace function private.legal_acceptances_signatory()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.accepted_by_email := case
    when new.document in ('cgv', 'dpa') and new.user_id is not null
    then (select u.email from public.users u where u.id = new.user_id)
  end;
  return new;
end;
$$;

-- Preuve en ajout seul : seule la perte du lien vers un compte supprimé (clé étrangère « on delete set null ») est
-- permise ; ni autre modification ni suppression, service role compris.
create or replace function private.legal_acceptances_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'LEGAL_PROOF_IMMUTABLE: une preuve d''acceptation ne se supprime pas' using errcode = '55000';
  end if;
  if (to_jsonb(new) - 'user_id') is distinct from (to_jsonb(old) - 'user_id')
     or (new.user_id is not null and new.user_id is distinct from old.user_id) then
    raise exception 'LEGAL_PROOF_IMMUTABLE: une preuve d''acceptation ne se modifie pas' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger legal_acceptances_signatory
  before insert on public.legal_acceptances
  for each row execute function private.legal_acceptances_signatory();
create trigger legal_acceptances_guard
  before update or delete on public.legal_acceptances
  for each row execute function private.legal_acceptances_guard();

alter table public.legal_acceptances enable row level security;
create policy legal_acceptances_select on public.legal_acceptances for select to authenticated
  using (user_id = auth.uid() or organization_id in (select private.admin_org_ids()) or (select private.is_super_admin()));
-- Service role (inscription par lien) : lecture et ajout seulement ; ni modification, ni suppression, ni vidage
revoke all on public.legal_acceptances from anon, authenticated, service_role;
grant select on public.legal_acceptances to authenticated;
grant select, insert on public.legal_acceptances to service_role;

-- Acceptation par l'utilisateur connecté. CGV et accord de traitement : au nom d'une centrale (owner / admin).
create or replace function public.accept_legal_documents(p_documents text[], p_version text, p_org uuid default null, p_source text default 'web')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_version text := left(nullif(btrim(coalesce(p_version, '')), ''), 40);
begin
  if v_uid is null then
    raise exception 'FORBIDDEN: connexion requise' using errcode = '42501';
  end if;
  if v_version is null or coalesce(cardinality(p_documents), 0) = 0
     or not p_documents <@ array['cgu', 'privacy', 'cgv', 'dpa']::text[] then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'message', 'Documents à accepter invalides.');
  end if;
  if (p_documents && array['cgv', 'dpa']::text[]) then
    if p_org is null then
      return jsonb_build_object('ok', false, 'code', 'ORG_REQUIRED', 'message', 'Centrale manquante.');
    end if;
    perform private.assert_org_member(p_org, array['owner', 'admin']::public.org_role[]);
  elsif p_org is not null then
    perform private.assert_org_member(p_org);
  end if;
  -- Idempotent, même en cas d'appels simultanés (double clic, deux onglets) : l'index unique garde la première
  -- acceptation (même personne, centrale, document et version) et sa date
  insert into public.legal_acceptances (user_id, organization_id, document, version, source)
  select v_uid, p_org, d.document, v_version, case when p_source in ('web', 'app') then p_source else 'web' end
  from (select distinct x as document from unnest(p_documents) x) d
  on conflict do nothing;
  return jsonb_build_object('ok', true, 'code', 'ACCEPTED', 'message', 'Conditions acceptées.');
end;
$$;

-- ----------------------------------------------------------------- centrales : inscription VTC
alter table public.organizations
  add column if not exists vtc_registration text
    check (vtc_registration is null or char_length(vtc_registration) <= 120);
comment on column public.organizations.vtc_registration is
  'N° d''inscription au registre des exploitants VTC et/ou de déclaration de centrale de réservation (Code des transports).';
grant update (vtc_registration) on public.organizations to authenticated;

-- ----------------------------------------------------------------- bannissements : 3 ans au plus
-- Durée annoncée par /confidentialite et /dpa. Empreintes des identifiants (banned_identities, levées comprises) et
-- signalements de fraude (fraud_reports : nom, motif, empreintes) effacés 3 ANS après leur création, que le compte
-- existe encore ou non ; une fiche bannie depuis 3 ans perd son bannissement (elle reste suspendue : la centrale
-- décide de la réactiver) ; le journal d'audit de ces bannissements est caviardé (l'action et sa date restent).
-- Appelée par private.housekeeping : quand rien n'a expiré (cas courant), trois lectures courtes et aucune écriture.
-- private.purge_deleted_driver_bans (20260924004000, comptes supprimés depuis 3 ans) reste un filet.
create or replace function private.purge_expired_bans(p_older_than interval default interval '3 years')
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_cutoff timestamptz := now() - coalesce(p_older_than, interval '3 years');
  -- Colonnes du bannissement dans le journal des modifications de la fiche (drivers.update)
  v_keys constant text[] := array['banned_at', 'banned_by', 'ban_reason', 'ban_scope', 'ban_report_id'];
  v_identities uuid[];
  v_reports uuid[];
  v_expired uuid[];
  v_expired_ids text[];
  v_drivers text[];
  v_audit integer;
  v_changes integer;
begin
  select coalesce(array_agg(b.id), '{}') into v_identities from public.banned_identities b where b.created_at <= v_cutoff;
  select coalesce(array_agg(f.id), '{}') into v_reports from public.fraud_reports f where f.created_at <= v_cutoff;
  select coalesce(array_agg(d.id), '{}') into v_expired from public.drivers d where d.banned_at <= v_cutoff;
  if cardinality(v_identities) + cardinality(v_reports) + cardinality(v_expired) = 0 then
    return jsonb_build_object('identities', 0, 'reports', 0, 'drivers', 0, 'audit', 0);
  end if;
  perform private.set_actor('system', null);
  v_expired_ids := (select coalesce(array_agg(x::text), '{}') from unnest(v_expired) x);
  -- Fiches dont le journal décrit ces bannissements
  select coalesce(array_agg(distinct x.id::text), '{}') into v_drivers
    from (select unnest(v_expired) as id
          union all select b.driver_id from public.banned_identities b where b.id = any (v_identities)
          union all select f.driver_id from public.fraud_reports f where f.id = any (v_reports)) x
   where x.id is not null;

  -- Fiche : bannissement retiré (avant l'effacement des signalements : pas de mise à jour en cascade en plus)
  update public.drivers
     set banned_at = null, banned_by = null, ban_reason = null, ban_scope = null, ban_report_id = null,
         suspended_reason = case when deleted_at is null and suspended_reason ~ '^Banni'
                                 then 'Bannissement expiré (3 ans)' else suspended_reason end
   where id = any (v_expired);

  delete from public.banned_identities where id = any (v_identities);
  delete from public.fraud_reports where id = any (v_reports);

  -- Journal : entrées propres à ces bannissements caviardées (motif, indices, nom) ; l'action et sa date restent
  update public.audit_logs a
     set metadata = jsonb_build_object('redacted', true)
   where not (a.metadata ? 'redacted')
     and ((a.entity_type = 'banned_identities' and a.entity_id = any (select x::text from unnest(v_identities) x))
          or (a.entity_type = 'fraud_reports' and a.entity_id = any (select x::text from unnest(v_reports) x))
          or (a.entity_type = 'drivers' and a.entity_id = any (v_drivers)
              and a.action in ('driver.banned', 'driver.account_locked', 'driver.ban_lifted', 'driver.platform_banned',
                               'driver.platform_unbanned', 'driver.banned_device')
              and (a.created_at <= v_cutoff or a.entity_id = any (v_expired_ids))));
  get diagnostics v_audit = row_count;
  -- Modifications de la fiche : colonnes du bannissement retirées, ainsi que le motif recopié dans suspended_reason
  -- (« Banni : … », « Bannissement levé : … ») ; le reste (statut…) est conservé
  update public.audit_logs a
     set metadata = jsonb_build_object('changes',
           (a.metadata -> 'changes') - v_keys
             - case when coalesce(a.metadata #>> '{changes,suspended_reason,from}', '') ~ '^Bann'
                      or coalesce(a.metadata #>> '{changes,suspended_reason,to}', '') ~ '^Bann'
                    then 'suspended_reason' else '' end,
           'ban_redacted', true)
   where a.entity_type = 'drivers' and a.action = 'drivers.update'
     and a.entity_id = any (v_drivers)
     and (a.created_at <= v_cutoff or a.entity_id = any (v_expired_ids))
     and ((a.metadata -> 'changes') ?| v_keys
          or coalesce(a.metadata #>> '{changes,suspended_reason,from}', '') ~ '^Bann'
          or coalesce(a.metadata #>> '{changes,suspended_reason,to}', '') ~ '^Bann');
  get diagnostics v_changes = row_count;

  return jsonb_build_object('identities', cardinality(v_identities), 'reports', cardinality(v_reports),
    'drivers', cardinality(v_expired), 'audit', v_audit + v_changes);
end;
$$;

-- ----------------------------------------------------------------- index des purges
-- Signalements de la flotte recopiés dans le journal des courses : purgés sans parcourir tout le journal
create index if not exists ride_events_fleet_reports_idx on public.ride_events (created_at)
  where type in ('fleet.report', 'fleet.report_cleared');
-- Journal d'audit : lignes qui portent encore une adresse IP ou un navigateur
create index if not exists audit_logs_network_idx on public.audit_logs (created_at)
  where ip is not null or user_agent is not null;

-- ----------------------------------------------------------------- ménage : durées de conservation annoncées
-- Dernière définition : 20260924003300. Ajouts (durées de /confidentialite § 9 et /dpa § 11) :
--  * signalements de la flotte recopiés dans le journal de la centrale (ride_events fleet.report et
--    fleet.report_cleared : texte, auteur, position) : 180 jours, comme les messages ;
--  * notifications : 90 jours après leur envoi prévu, quel que soit leur statut (en échec, bloquées, en file
--    périmée) ; un rappel planifié reste jusqu'à son envoi ;
--  * adresse IP et navigateur du journal d'audit (inscription par lien, actions sensibles) : 1 an ;
--  * courses terminées, annulées ou sans chauffeur : 10 ans après la fin de l'année de la prise en charge
--    (obligations comptables), supprimées avec leur journal, offres, attributions, alertes, notifications et
--    règlements ; le registre des frais plateforme garde ses écritures, sans lien vers la course ;
--  * bannissements : 3 ans (private.purge_expired_bans).
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
  v_rides integer := 0;
  v_count integer;
  v_org uuid;
  v_rides_before timestamptz := date_trunc('year', now() - interval '10 years');
  v_bans jsonb;
  v_errors jsonb := '{}'::jsonb;
begin
  -- Le ménage ne met jamais un chauffeur hors ligne : application fermée, c'est private.watch_driver_gps qui s'en
  -- charge (20260924003400).

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
  -- Courses : 10 ans après la fin de l'année de la prise en charge. Par centrale (index organization_id, pickup_at).
  -- Purges longues (courses, bannissements) : un échec est journalisé par le worker et n'empêche pas le reste du
  -- ménage ; elles sont retentées au passage suivant.
  begin
    for v_org in select o.id from public.organizations o loop
      delete from public.rides r
       where r.organization_id = v_org and r.pickup_at < v_rides_before
         and r.status in ('COMPLETED', 'CANCELLED', 'NO_DRIVER_FOUND');
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

  return jsonb_build_object('history_purged', v_history, 'api_logs_purged', v_logs,
    'documents_expired', v_docs, 'notifications_purged', v_notifs, 'chat_purged', v_chat,
    'fleet_events_purged', v_fleet, 'audit_network_purged', v_network, 'rides_purged', v_rides,
    'bans_purged', v_bans)
    || case when v_errors = '{}'::jsonb then '{}'::jsonb else jsonb_build_object('errors', v_errors) end;
end;
$$;

-- ----------------------------------------------------------------- droits
revoke execute on function public.public_legal_info() from public;
grant execute on function public.public_legal_info() to anon, authenticated, service_role;
revoke execute on function public.svc_platform_legal_update(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.svc_platform_legal_update(uuid, jsonb) to service_role;
revoke execute on function public.accept_legal_documents(text[], text, uuid, text) from public, anon;
grant execute on function public.accept_legal_documents(text[], text, uuid, text) to authenticated, service_role;
-- Déclencheurs et purge : jamais appelés par un client (housekeeping, déjà réservé au worker, garde ses droits)
revoke execute on function
  private.legal_acceptances_signatory(),
  private.legal_acceptances_guard(),
  private.purge_expired_bans(interval)
from public, anon, authenticated, service_role;
