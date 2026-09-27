-- =============================================================================
-- Rydar Drive — Audit « droits » : lectures et écritures directes resserrées
--
--  * drivers : statut, niveau de confiance et motif de suspension ne se modifient plus en écriture directe
--    (PostgREST, rôle authenticated) que par le propriétaire ou un administrateur de la centrale
--    (déclencheur drivers_admin_columns_guard). Le dispatcher garde « Modifier » (identité, téléphone, e-mail,
--    carte VTC, notes, véhicule). Les RPC security definer (confirm_settlements lancé par un dispatcher →
--    promotion « confirmé », validation des candidatures, bannissements, présence du chauffeur…) et le service
--    role ne sont pas concernés : le contrôle porte sur current_user, jamais sur auth.role().
--  * organizations : plus lisible par les chauffeurs (aucun lecteur : l'application passe par des RPC) ; colonnes
--    lisibles par le client accordées une à une. Réservées au serveur, aux RPC et au super admin (client admin) :
--    relance et conditions de paiement de Rydar (platform_reminder_note, platform_reminded_at,
--    platform_billing_cycle, platform_payment_days, platform_block_after_days), stripe_customer_id,
--    limits_override, suspended_reason, compteurs, created_by. Propriétaire / administrateur : relance et conditions
--    servies par org_platform_status / org_platform_account. Toute NOUVELLE colonne d'organizations lue par le
--    client (tableau de bord, super admin par sa session) doit être ajoutée au GRANT ci-dessous, sinon elle est
--    illisible et un select('*') échoue (42501).
--  * notifications : une notification envoyée par Rydar (data.sender = 'platform' : relance des frais plateforme au
--    propriétaire) n'est lisible que par son destinataire et les owner / admin de la centrale, plus par les
--    dispatchers.
--  * push_tokens et driver_devices : plus aucune lecture client (aucun lecteur : worker et RPC security definer) ;
--    driver_register_device ne réattribue plus un jeton rattaché à un autre compte que depuis la même installation
--    (téléphone partagé : identifiant d'installation stable, apps/driver/src/lib/device.ts) et garde au plus
--    5 jetons actifs et 10 appareils par chauffeur.
--  * Stockage des justificatifs : au plus 30 fichiers déposés par 24 h dans driver-documents/{org}/{chauffeur}/
--    (comptage par une fonction security definer : une sous-requête sur storage.objects dans sa propre politique
--    est une récursion infinie).
--  * driver_submit_document : le type « medical » (visite médicale, donnée de santé) n'est plus accepté
--    (TYPE_NOT_ALLOWED) ; les fiches existantes restent consultables.
--  * accept_legal_documents : version au format AAAA-MM-JJ, date réelle, jamais postérieure au lendemain (heure de
--    Paris) — aucune version en vigueur n'est stockée en base ; LEGAL_VERSION (@rydar/shared) est la date de
--    publication des documents, jamais une date future (sinon l'acceptation est refusée jusqu'à cette date).
--
--  Dernières définitions reprises : 20260924002600_centrale_mode (driver_register_device, driver_submit_document,
--  install_driver_document_storage_policy), 20260924003900_legal_compliance (accept_legal_documents),
--  20260924000300_security (politiques organizations_select, notifications_select, push_tokens_select,
--  driver_devices_select ; GRANT select de toutes les tables).
-- =============================================================================

-- ----------------------------------------------------------------- drivers : colonnes d'administration
-- Écriture directe (rôle authenticated) : statut, niveau de confiance et motif de suspension réservés au
-- propriétaire et aux administrateurs de la centrale (setDriverStatus, setDriverTrustLevel). Les fonctions
-- security definer s'exécutent en postgres (current_user) et gardent leurs propres contrôles.
create or replace function private.drivers_admin_columns_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated'
     and (new.status, new.trust_level, new.suspended_reason)
         is distinct from (old.status, old.trust_level, old.suspended_reason)
     and not private.has_org_role(old.organization_id, array['owner', 'admin']::public.org_role[]) then
    raise exception 'FORBIDDEN_ROLE: statut, niveau de confiance et suspension d''un chauffeur réservés aux administrateurs de la centrale'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists drivers_admin_columns_guard on public.drivers;
create trigger drivers_admin_columns_guard
  before update of status, trust_level, suspended_reason on public.drivers
  for each row execute function private.drivers_admin_columns_guard();

-- ----------------------------------------------------------------- organizations : lecture
drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations for select to authenticated
  using (
    id in (select private.membership_org_ids())
    or (select private.is_super_admin())
  );

revoke select on public.organizations from authenticated;
grant select (id, name, slug, status, plan_id, legal_name, siret, vat_number, email, phone, address, city, postal_code,
  country, timezone, currency, logo_url, brand_color, suspended_at, archived_at, created_at, updated_at, dispatch_model,
  platform_fee_percent, platform_fee_fixed_cents, join_code, join_enabled, join_auto_approve, vtc_registration)
  on public.organizations to authenticated;

-- ----------------------------------------------------------------- notifications : envois de Rydar
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated
  using (
    (organization_id in (select private.member_org_ids())
      and (data ->> 'sender' is distinct from 'platform'
           or organization_id in (select private.admin_org_ids())
           or user_id = (select auth.uid())))
    or driver_id = (select private.current_driver_id())
    or (select private.is_super_admin())
  );

-- ----------------------------------------------------------------- jetons push et appareils : aucune lecture client
drop policy if exists push_tokens_select on public.push_tokens;
drop policy if exists driver_devices_select on public.driver_devices;
revoke all on public.push_tokens, public.driver_devices from anon, authenticated;

-- Existant : au plus 5 jetons actifs par chauffeur (les plus récents)
update public.push_tokens t
   set is_active = false
  from (select x.id, row_number() over (partition by x.driver_id order by x.updated_at desc, x.id) as rn
          from public.push_tokens x
         where x.is_active) r
 where t.id = r.id and r.rn > 5;

-- Dernière définition : 20260924002600_centrale_mode.sql. Changements : un jeton rattaché à un autre compte n'est
-- réattribué que depuis la même installation (téléphone partagé) ; au plus 5 jetons actifs et 10 appareils par
-- chauffeur ; « push » indique si le jeton est enregistré pour ce compte.
create or replace function public.driver_register_device(
  p_installation_id text,
  p_platform public.device_platform,
  p_push_token text default null,
  p_provider public.push_provider default 'expo',
  p_device_name text default null,
  p_os_version text default null,
  p_app_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d record;
  v_device uuid;
  v_token uuid;
begin
  select x.id, x.organization_id into d from public.drivers x where x.id = private.current_driver_or_applicant_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  if p_installation_id is null or char_length(p_installation_id) not between 8 and 128 then
    raise exception 'INVALID_INSTALLATION_ID' using errcode = '22023';
  end if;

  insert into public.driver_devices (organization_id, driver_id, installation_id, platform, device_name, os_version, app_version, last_seen_at)
  values (d.organization_id, d.id, p_installation_id, p_platform, left(p_device_name, 120), left(p_os_version, 40), left(p_app_version, 40), now())
  on conflict (driver_id, installation_id) do update
    set platform = excluded.platform,
        device_name = excluded.device_name,
        os_version = excluded.os_version,
        app_version = excluded.app_version,
        last_seen_at = now(),
        revoked_at = null
  returning id into v_device;

  -- Au plus 10 appareils actifs par chauffeur (les plus récemment vus)
  update public.driver_devices x
     set revoked_at = now()
   where x.driver_id = d.id and x.revoked_at is null
     and x.id not in (select y.id from public.driver_devices y
                       where y.driver_id = d.id and y.revoked_at is null
                       order by (y.id = v_device) desc, y.last_seen_at desc, y.id
                       limit 10);

  if p_push_token is not null and char_length(p_push_token) between 10 and 512 then
    -- Téléphone partagé : le jeton suit l'appareil. Il ne quitte un autre compte que si ce compte l'a enregistré
    -- depuis la même installation (identifiant stable de l'appareil) ; jamais depuis un autre appareil.
    delete from public.push_tokens t
     where t.token = p_push_token and t.driver_id <> d.id
       and exists (select 1 from public.driver_devices dd
                    where dd.id = t.device_id and dd.installation_id = p_installation_id);
    if not exists (select 1 from public.push_tokens t where t.token = p_push_token and t.driver_id <> d.id) then
      update public.push_tokens set is_active = false
       where device_id = v_device and token <> p_push_token and is_active;
      insert into public.push_tokens (organization_id, driver_id, device_id, token, provider, platform, is_active)
      values (d.organization_id, d.id, v_device, p_push_token, p_provider, p_platform, true)
      on conflict (token) do update
        set device_id = excluded.device_id,
            provider = excluded.provider,
            platform = excluded.platform,
            is_active = true,
            last_error = null
      returning id into v_token;

      -- Au plus 5 jetons actifs par chauffeur (les plus récents) : une notification ne part pas vers des milliers
      update public.push_tokens x
         set is_active = false
       where x.driver_id = d.id and x.is_active
         and x.id not in (select y.id from public.push_tokens y
                           where y.driver_id = d.id and y.is_active
                           order by (y.id = v_token) desc, y.updated_at desc, y.id
                           limit 5);
    end if;
  end if;

  return jsonb_build_object('ok', true, 'device_id', v_device, 'push', v_token is not null);
end;
$$;

-- ----------------------------------------------------------------- justificatifs : visite médicale retirée
-- Dernière définition : 20260924002600_centrale_mode.sql. Seul changement : p_type = 'medical' refusé
-- (TYPE_NOT_ALLOWED) — donnée de santé que le produit ne collecte plus.
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
  -- Visite médicale (donnée de santé) : plus déposée dans l'application
  if p_type = 'medical' then
    return jsonb_build_object('ok', false, 'code', 'TYPE_NOT_ALLOWED',
      'message', 'Ce type de document ne se dépose plus dans l''application.');
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

-- ----------------------------------------------------------------- stockage : quota de dépôts de justificatifs
-- Fichiers déposés ces dernières 24 h dans le dossier du chauffeur (ou candidat) connecté. Security definer : lue
-- par la politique d'insertion de storage.objects, elle ne doit pas réappliquer les politiques de cette table
-- (récursion infinie) — même précédent que driver_submit_document. Sans schéma storage (tests) : 0.
create or replace function private.driver_document_uploads_24h()
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_driver_or_applicant_org_id();
  v_driver uuid := private.current_driver_or_applicant_id();
  v_count bigint;
begin
  if v_org is null or v_driver is null or to_regclass('storage.objects') is null then
    return 0;
  end if;
  execute 'select count(*) from storage.objects o
            where o.bucket_id = $1 and o.name like $2 and o.created_at > now() - interval ''1 day'''
    into v_count using 'driver-documents', v_org::text || '/' || v_driver::text || '/%';
  return v_count;
end;
$$;

-- Dernière définition : 20260924002600_centrale_mode.sql. Seul changement : au plus 30 dépôts par 24 h.
-- Les fichiers remplacés ou refusés ne sont pas purgés ici (purge du stockage à planifier, par le worker).
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
      and (select private.driver_document_uploads_24h()) < 30
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

-- ----------------------------------------------------------------- documents légaux : version valide
-- Dernière définition : 20260924003900_legal_compliance.sql. Seul changement : version au format AAAA-MM-JJ,
-- date réelle, au plus le lendemain (heure de Paris) ; sinon INVALID_VERSION, rien n'est enregistré.
create or replace function public.accept_legal_documents(p_documents text[], p_version text, p_org uuid default null, p_source text default 'web')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_version text := left(nullif(btrim(coalesce(p_version, '')), ''), 40);
  v_date date;
begin
  if v_uid is null then
    raise exception 'FORBIDDEN: connexion requise' using errcode = '42501';
  end if;
  if v_version is null or coalesce(cardinality(p_documents), 0) = 0
     or not p_documents <@ array['cgu', 'privacy', 'cgv', 'dpa']::text[] then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'message', 'Documents à accepter invalides.');
  end if;
  if v_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    begin
      v_date := v_version::date;
    exception when others then
      v_date := null;
    end;
  end if;
  if v_date is null or v_date > (now() at time zone 'Europe/Paris')::date + 1 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_VERSION', 'message', 'Version des documents invalide.');
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

-- ----------------------------------------------------------------- droits d'exécution
revoke execute on function private.drivers_admin_columns_guard() from public, anon, authenticated, service_role;

-- Évaluée par la politique de stockage avec le rôle de l'appelant
revoke execute on function private.driver_document_uploads_24h() from public, anon;
grant execute on function private.driver_document_uploads_24h() to authenticated, service_role;

revoke execute on function private.install_driver_document_storage_policy() from public, anon, authenticated;
grant execute on function private.install_driver_document_storage_policy() to service_role;

revoke execute on function
  public.driver_register_device(text, public.device_platform, text, public.push_provider, text, text, text),
  public.driver_submit_document(public.document_type, text, date, text, date, text),
  public.accept_legal_documents(text[], text, uuid, text)
from public, anon;
grant execute on function
  public.driver_register_device(text, public.device_platform, text, public.push_provider, text, text, text),
  public.driver_submit_document(public.document_type, text, date, text, date, text),
  public.accept_legal_documents(text[], text, uuid, text)
to authenticated, service_role;

select private.install_driver_document_storage_policy();
