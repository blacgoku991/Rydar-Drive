-- =============================================================================
-- Audit « bannissement » (flux-comptes#4/#10/#11, sql-rpc-argent#2/#4/#7, actions-admin#1/#3)
--  1. Téléphone : « +33 (0)6… », « +33 06… », « 0033 (0)6… » = « 06… » (mêmes règles que normalizePhone de
--     @rydar/shared) ; empreintes existantes recalculées (private.rehash_phone_identities, idempotente).
--  2. ban_driver : les autres fiches de la centrale déjà enregistrées sur l'appareil du banni sont signalées
--     (vérification requise) ; chaque identité du signalement porte la date de sa dernière saisie par la centrale.
--  3. Justificatifs : numéro de pièce saisi / modifié journalisé (empreinte et indice masqué seulement).
--  4. Bannissement plateforme : aperçu super admin des fiches d'autres centrales (admin_fraud_report_matches) ;
--     svc_platform_ban ne touche une fiche d'une AUTRE centrale que confirmée (p_extend_driver_ids) et ne
--     verrouille jamais (Auth) un compte qui gère une centrale ; svc_platform_unban rend à chaque centrale le
--     bannissement qu'elle avait elle-même posé.
-- =============================================================================

-- ----------------------------------------------------------------- 1. normalisation du téléphone
-- Dernière définition : 20260924002600. Téléphone : « (0) » retiré d'un numéro international, « + » implicite à
-- partir de 10 chiffres (« 33612345678 »), 0 de préfixe national retiré après +33 et les indicatifs des DOM
-- (+262, +590, +594, +596 : numérotation française, jamais de 0 après l'indicatif). Le reste est inchangé.
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
    if v ~ '^(\+|00)' then
      v := regexp_replace(v, '\(\s*0\s*\)', '', 'g');
    end if;
    v := case when left(v, 1) = '+' then '+' || regexp_replace(v, '[^0-9]', '', 'g')
              else regexp_replace(v, '[^0-9]', '', 'g') end;
    if left(v, 2) = '00' then
      v := '+' || substr(v, 3);
    elsif v ~ '^0[1-9][0-9]{8}$' then
      v := '+33' || substr(v, 2);
    elsif v ~ '^[1-9][0-9]{9,}$' then
      v := '+' || v;
    end if;
    v := regexp_replace(v, '^\+(33|262|590|594|596)0([1-9])', '+\1\2');
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

-- ----------------------------------------------------------------- 2. fiche liée à un compte banni
-- Fiche sur l'appareil (ou avec le téléphone) d'un compte banni : candidature refusée d'office, chauffeur actif
-- sans course suspendu « vérification requise » (un téléphone peut être partagé : la centrale décide), alerte et
-- journal. Corps repris de private.flag_banned_device (dernière définition : 20260924002600) ; fiche supprimée
-- ignorée (figée). Renvoie true si la fiche a été signalée.
create or replace function private.flag_driver_banned_match(p_driver_id uuid, p_kind text, p_scope text, p_meta jsonb default '{}'::jsonb)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  d public.drivers;
begin
  select * into d from public.drivers where id = p_driver_id for update;
  if not found or d.banned_at is not null or d.deleted_at is not null then
    return false;
  end if;

  if d.status = 'inactive' and d.application_status = 'pending' then
    -- Candidat inscrit par lien : candidature refusée d'office (motif neutre côté chauffeur) ;
    -- la centrale est alertée et peut la reconsidérer (téléphone partagé…)
    update public.drivers
       set application_status = 'rejected', application_reviewed_at = now(), application_reviewed_by = null,
           application_note = 'Candidature non retenue : contactez la centrale.'
     where id = d.id;
  elsif d.status = 'active' and d.current_ride_id is null then
    update public.drivers
       set status = 'suspended', presence = 'offline', online_since = null,
           suspended_reason = case when p_kind = 'phone' then 'Téléphone' else 'Appareil' end
             || ' déjà utilisé par un compte banni — vérification requise'
     where id = d.id;
    update public.ride_offers
       set status = 'closed', closed_reason = 'driver_suspended', responded_at = now()
     where driver_id = d.id and status = 'pending';
  end if;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (d.organization_id, 'system', null,
    case when p_kind = 'device' then 'driver.banned_device' else 'driver.banned_identity' end,
    'drivers', d.id::text, 'critical',
    coalesce(p_meta, '{}'::jsonb) || jsonb_build_object('scope', p_scope,
      'applicant', d.application_status = 'pending',
      'suspended', d.status = 'active' and d.current_ride_id is null)
      || case when p_kind = 'device' then '{}'::jsonb else jsonb_build_object('kind', p_kind) end);
  -- Alerte temps réel du tableau de bord (texte « appareil déjà utilisé ») : appareils seulement
  if p_kind = 'device' then
    perform realtime.send(
      jsonb_build_object('driver_id', d.id, 'number', d.number, 'first_name', d.first_name, 'last_name', d.last_name,
        'reason', 'banned_device'),
      'driver.flagged', 'org:' || d.organization_id::text, true);
  end if;
  return true;
end;
$$;

-- Dernière définition : 20260924002600. Corps déplacé dans private.flag_driver_banned_match (aussi appelé par
-- ban_driver pour les fiches DÉJÀ enregistrées sur l'appareil au moment du bannissement).
create or replace function private.flag_banned_device()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope text;
begin
  v_scope := private.identity_ban_scope(new.organization_id, 'device', new.installation_id);
  if v_scope is not null then
    perform private.flag_driver_banned_match(new.driver_id, 'device', v_scope,
      jsonb_build_object('device_id', new.id, 'platform', new.platform, 'device_name', new.device_name));
  end if;
  return null;
end;
$$;

-- ----------------------------------------------------------------- 3. numéros de pièce saisis (journal)
-- Numéro d'une carte VTC, d'un permis ou d'une pièce d'identité saisi ou modifié : qui l'a saisi (centrale,
-- chauffeur, système), rattaché à la FICHE (caviardé avec elle à la suppression du compte) ; empreinte et indice
-- masqué seulement, jamais le numéro. Sert à dater la saisie par la centrale d'une identité signalée.
create or replace function private.audit_driver_document_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_hash text;
begin
  if new.type not in ('vtc_card', 'driving_license', 'identity') then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.number is not distinct from old.number and new.type is not distinct from old.type then
    return null;
  end if;
  v_kind := case new.type when 'identity' then 'identity_doc' else new.type::text end;
  v_hash := private.identity_hash(v_kind, new.number);
  if v_hash is null then
    return null;
  end if;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (new.organization_id,
    case when auth.uid() is null then 'system' when private.is_super_admin() then 'super_admin' else 'user' end::public.actor_type,
    auth.uid(), 'driver_documents.number_set', 'drivers', new.driver_id::text, 'info',
    jsonb_build_object('document_id', new.id, 'type', new.type, 'kind', v_kind, 'hash', v_hash,
      'hint', private.identity_hint(v_kind, new.number)));
  return null;
end;
$$;

create trigger driver_documents_number_audit
  after insert or update of type, number on public.driver_documents
  for each row execute function private.audit_driver_document_number();

-- ----------------------------------------------------------------- 4. bannissement par la centrale
-- Dernière définition : 20260924002600. Ajouts : (a) les autres fiches de la centrale déjà enregistrées sur un
-- appareil du banni sont signalées (le contrôle d'appareil ne jouait qu'à l'enregistrement d'un NOUVEL appareil) ;
-- (b) chaque identité du signalement porte « edited_by_org_at » : dernière saisie de cette valeur par un membre de
-- la centrale (fiche, véhicule, justificatif), figée au signalement pour le super admin ; (c) message exact.
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
  v_other record;
  v_res jsonb;
  v_reassigned integer := 0;
  v_flagged integer := 0;
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

  -- Signalement au super admin (bannissement de toute la plateforme sur décision). Pour chaque identité : date
  -- de la dernière saisie de CETTE valeur par un membre de la centrale (journal de la fiche, du véhicule, des
  -- numéros de pièce ; justificatif déposé depuis le tableau de bord) — une identité recopiée depuis la fiche
  -- d'un chauffeur d'une autre centrale juste avant le signalement se voit.
  if coalesce(p_report_to_platform, false) then
    insert into public.fraud_reports (organization_id, driver_id, driver_label, category, reason, identities, reported_by)
    values (d.organization_id, d.id, format('%s %s (#%s)', d.first_name, d.last_name, d.number), v_category, v_reason,
      (select coalesce(jsonb_agg(jsonb_build_object('kind', i.kind, 'hash', i.value_hash, 'hint', i.hint)
                || case when e.at is null then '{}'::jsonb else jsonb_build_object('edited_by_org_at', e.at) end), '[]'::jsonb)
       from private.driver_identities(d.id, p_ban_vehicle) i
       left join lateral (
         select max(t.at) as at
         from (
           select a.created_at as at
           from public.audit_logs a
           where i.kind in ('phone', 'email', 'vtc_card')
             and a.entity_type = 'drivers' and a.entity_id = d.id::text
             and a.action in ('drivers.insert', 'drivers.update')
             and a.actor_user_id is not null
             and private.identity_hash(i.kind, case a.action
                   when 'drivers.insert' then a.metadata -> 'new' ->> (case i.kind when 'vtc_card' then 'vtc_card_number' else i.kind end)
                   else a.metadata -> 'changes' -> (case i.kind when 'vtc_card' then 'vtc_card_number' else i.kind end) ->> 'to'
                 end) = i.value_hash
             and exists (select 1 from public.organization_users m
                         where m.organization_id = d.organization_id and m.user_id = a.actor_user_id)
           union all
           select a.created_at
           from public.audit_logs a
           where i.kind = 'plate' and d.vehicle_id is not null
             and a.entity_type = 'vehicles' and a.entity_id = d.vehicle_id::text
             and a.action in ('vehicles.insert', 'vehicles.update')
             and a.actor_user_id is not null
             and private.identity_hash('plate', case a.action
                   when 'vehicles.insert' then a.metadata -> 'new' ->> 'plate'
                   else a.metadata -> 'changes' -> 'plate' ->> 'to'
                 end) = i.value_hash
             and exists (select 1 from public.organization_users m
                         where m.organization_id = d.organization_id and m.user_id = a.actor_user_id)
           union all
           select a.created_at
           from public.audit_logs a
           where a.entity_type = 'drivers' and a.entity_id = d.id::text
             and a.action = 'driver_documents.number_set'
             and a.metadata ->> 'kind' = i.kind and a.metadata ->> 'hash' = i.value_hash
             and a.actor_user_id is not null
             and exists (select 1 from public.organization_users m
                         where m.organization_id = d.organization_id and m.user_id = a.actor_user_id)
           union all
           -- Justificatifs antérieurs au journal des numéros : déposés depuis le tableau de bord
           select x.created_at
           from public.driver_documents x
           where x.driver_id = d.id and x.source = 'dashboard'
             and i.kind = case x.type when 'identity' then 'identity_doc' else x.type::text end
             and private.identity_hash(i.kind, x.number) = i.value_hash
             and not exists (select 1 from public.audit_logs a
                             where a.entity_type = 'drivers' and a.entity_id = d.id::text
                               and a.action = 'driver_documents.number_set'
                               and a.metadata ->> 'document_id' = x.id::text)
         ) t
       ) e on true),
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

  -- Autres fiches de la centrale déjà enregistrées sur un appareil du banni (révoqué ou non) : même traitement
  -- qu'un nouveau compte sur cet appareil (suspendue « vérification requise », candidature refusée, alerte)
  for v_other in
    select distinct on (o.id) o.id, dv2.id as device_id, dv2.platform, dv2.device_name
    from public.driver_devices dv
    join public.driver_devices dv2
      on dv2.organization_id = d.organization_id
     and dv2.driver_id <> d.id
     and private.identity_hash('device', dv2.installation_id) = private.identity_hash('device', dv.installation_id)
    join public.drivers o on o.id = dv2.driver_id
    where dv.driver_id = d.id
      and o.banned_at is null
      and o.deleted_at is null
    order by o.id, dv2.last_seen_at desc
  loop
    if private.flag_driver_banned_match(v_other.id, 'device', 'org',
         jsonb_build_object('device_id', v_other.device_id, 'platform', v_other.platform, 'device_name', v_other.device_name,
           'banned_driver_id', d.id)) then
      v_flagged := v_flagged + 1;
    end if;
  end loop;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (d.organization_id, 'user', auth.uid(), 'driver.banned', 'drivers', d.id::text, 'critical',
    jsonb_build_object('reason', v_reason, 'category', v_category, 'identities', v_count,
      'reassigned_rides', v_reassigned, 'report_id', v_report, 'vehicle', coalesce(p_ban_vehicle, false),
      'flagged_drivers', v_flagged));

  return jsonb_build_object('ok', true, 'code', 'BANNED',
    'message', 'Chauffeur banni : ses identifiants connus (téléphone, e-mail, carte VTC, appareils) sont refusés à toute nouvelle inscription dans votre centrale.'
      || case when v_flagged = 1 then ' Une autre fiche de votre centrale utilise le même appareil : bloquée en attendant votre vérification.'
              when v_flagged > 1 then format(' %s autres fiches de votre centrale utilisent le même appareil : bloquées en attendant votre vérification.', v_flagged)
              else '' end,
    'identities', v_count, 'reassigned_rides', v_reassigned, 'report_id', v_report, 'user_id', d.user_id,
    'flagged_drivers', v_flagged);
end;
$$;

-- ----------------------------------------------------------------- 5. bannissement plateforme
-- Fiches qui portent une identité d'un signalement (chauffeur signalé, fiches supprimées et fiches déjà bannies de
-- la plateforme exclus) : une ligne par identité commune ; same_org = centrale qui a signalé.
create or replace function private.fraud_report_carriers(p_report_id uuid)
returns table (driver_id uuid, organization_id uuid, same_org boolean, kind text, value_hash text)
language sql
stable
set search_path = ''
as $$
  select d.id, d.organization_id, d.organization_id = f.organization_id, i.kind, i.value_hash
  from public.fraud_reports f
  join public.drivers d
    on d.deleted_at is null
   and d.id is distinct from f.driver_id
   and d.ban_scope is distinct from 'platform'
  cross join lateral private.driver_identities(d.id, true) i
  where f.id = p_report_id
    and exists (select 1 from jsonb_array_elements(f.identities) e
                where e ->> 'kind' = i.kind and e ->> 'hash' = i.value_hash);
$$;

-- Aperçu AVANT décision (super admin, contrôle ici) : identités du signalement (avec la date de saisie par la
-- centrale) et fiches qui les portent — celles de la centrale qui signale (suspendues avec lui) et celles des
-- AUTRES centrales (touchées seulement si le super admin les confirme).
create or replace function public.admin_fraud_report_matches(p_report_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  f public.fraud_reports;
begin
  if not private.is_super_admin() then
    raise exception 'FORBIDDEN: réservé au super admin' using errcode = '42501';
  end if;
  select * into f from public.fraud_reports where id = p_report_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Signalement introuvable.');
  end if;

  return jsonb_build_object(
    'ok', true,
    'report_id', f.id,
    'reported_at', f.created_at,
    'identities', (
      select coalesce(jsonb_agg(jsonb_build_object('kind', t.e ->> 'kind', 'hint', t.e ->> 'hint',
               'edited_by_org_at', t.e -> 'edited_by_org_at') order by t.n), '[]'::jsonb)
      from jsonb_array_elements(f.identities) with ordinality t(e, n)),
    'matches', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'driver_id', d.id, 'number', d.number, 'first_name', d.first_name, 'last_name', d.last_name,
               'organization_id', d.organization_id, 'organization_name', o.name, 'same_org', m.same_org,
               'created_at', d.created_at, 'status', d.status, 'application_status', d.application_status,
               'banned', d.banned_at is not null, 'kinds', to_jsonb(m.kinds),
               'manages_org', private.keeps_login_account(d.user_id))
             order by m.same_org desc, o.name, d.number), '[]'::jsonb)
      from (select c.driver_id, bool_or(c.same_org) as same_org, array_agg(distinct c.kind order by c.kind) as kinds
            from private.fraud_report_carriers(f.id) c
            group by c.driver_id) m
      join public.drivers d on d.id = m.driver_id
      join public.organizations o on o.id = d.organization_id));
end;
$$;

-- Dernière définition : 20260924004000. Signature changée (p_extend_driver_ids) → drop + droits refaits.
-- (a) Fiches d'AUTRES centrales qui portent une identité du signalement : touchées seulement si confirmées une à
--     une (p_extend_driver_ids, vide par défaut) ; une identité portée par une fiche NON confirmée n'est pas
--     bannie de la plateforme (elle reste refusée dans la centrale qui signale : ban_driver). Le chauffeur signalé
--     et les autres fiches de SA centrale sont suspendus comme avant.
-- (b) Comptes de connexion : user_ids = verrouillables (Auth) ; kept_user_ids = comptes qui gèrent une centrale ou
--     la plateforme (private.keeps_login_account) : fiche suspendue et bannie, connexion conservée.
drop function if exists public.svc_platform_ban(uuid, uuid, text);
create function public.svc_platform_ban(
  p_report_id uuid,
  p_actor uuid,
  p_note text default null,
  p_extend_driver_ids uuid[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.fraud_reports;
  x record;
  v_count integer;
  v_identities_skipped integer;
  v_drivers integer := 0;
  v_users uuid[] := '{}';
  v_kept uuid[] := '{}';
  v_note text := left(nullif(btrim(coalesce(p_note, '')), ''), 500);
  v_extend uuid[] := coalesce(p_extend_driver_ids, '{}');
  v_same uuid[];
  v_confirmed uuid[];
  v_skipped uuid[];
  v_blocked text[];
begin
  perform private.assert_platform_actor(p_actor);
  select * into f from public.fraud_reports where id = p_report_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Signalement introuvable.');
  end if;
  if f.status = 'platform_banned' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_BANNED', 'message', 'Déjà banni de la plateforme.');
  end if;
  perform private.set_actor('super_admin', p_actor);

  -- Fiches qui partagent une identité : même centrale (automatique), autres centrales confirmées / écartées
  with c as (select * from private.fraud_report_carriers(f.id))
  select coalesce(array_agg(distinct c.driver_id) filter (where c.same_org), '{}'),
         coalesce(array_agg(distinct c.driver_id) filter (where not c.same_org and (c.driver_id = any (v_extend))), '{}'),
         coalesce(array_agg(distinct c.driver_id) filter (where not c.same_org and not (c.driver_id = any (v_extend))), '{}'),
         coalesce(array_agg(distinct c.kind || ':' || c.value_hash)
                    filter (where not c.same_org and not (c.driver_id = any (v_extend))), '{}')
    into v_same, v_confirmed, v_skipped, v_blocked
  from c;

  insert into public.banned_identities (scope, organization_id, kind, value_hash, hint, driver_id, report_id, reason, created_by)
  select 'platform', null, e ->> 'kind', e ->> 'hash', e ->> 'hint', f.driver_id, f.id, f.reason, p_actor
  from jsonb_array_elements(f.identities) e
  where e ->> 'kind' in ('phone', 'email', 'vtc_card', 'driving_license', 'identity_doc', 'plate', 'device')
    and e ->> 'hash' ~ '^[0-9a-f]{64}$'
    and not (((e ->> 'kind') || ':' || (e ->> 'hash')) = any (v_blocked))
  on conflict do nothing;
  get diagnostics v_count = row_count;

  select count(*) into v_identities_skipped
  from jsonb_array_elements(f.identities) e
  where ((e ->> 'kind') || ':' || (e ->> 'hash')) = any (v_blocked);

  update public.fraud_reports
     set status = 'platform_banned', reviewed_by = p_actor, reviewed_at = now(), review_note = v_note
   where id = f.id;

  -- Chauffeur signalé, fiches de sa centrale et fiches confirmées d'autres centrales ; fiches supprimées exclues
  -- (anonymes, non modifiables)
  for x in
    select d.id, d.user_id, d.organization_id
    from public.drivers d
    where d.deleted_at is null
      and d.ban_scope is distinct from 'platform'
      and (d.id = f.driver_id or d.id = any (v_same) or d.id = any (v_confirmed))
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
      if private.keeps_login_account(x.user_id) then
        v_kept := v_kept || x.user_id;
      else
        v_users := v_users || x.user_id;
      end if;
    end if;
    v_drivers := v_drivers + 1;
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
    values (x.organization_id, 'super_admin', p_actor, 'driver.platform_banned', 'drivers', x.id::text, 'critical',
      jsonb_build_object('report_id', f.id, 'extended', x.id = any (v_confirmed),
        'login_kept', x.user_id is not null and x.user_id = any (v_kept)));
  end loop;

  return jsonb_build_object('ok', true, 'code', 'PLATFORM_BANNED', 'identities', v_count,
    'identities_skipped', v_identities_skipped, 'drivers', v_drivers,
    'extended', coalesce(cardinality(v_confirmed), 0), 'skipped_drivers', coalesce(cardinality(v_skipped), 0),
    'user_ids', to_jsonb(v_users), 'kept_user_ids', to_jsonb(v_kept),
    'message', case when v_identities_skipped > 0
      then 'Banni de la plateforme, sauf les identités partagées avec des fiches d''autres centrales non confirmées.'
      else 'Banni de toute la plateforme.' end);
end;
$$;

-- Dernière définition : 20260924004000. Toute fiche touchée (pas seulement le chauffeur signalé) que sa propre
-- centrale avait bannie (empreintes « org » actives) lui est rendue : bannissement de centrale, motif conservé,
-- compte non déverrouillé ; les autres sont débannies (toujours suspendues : leur centrale décide).
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
  perform private.assert_platform_actor(p_actor);
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

  for x in select d.id, d.user_id from public.drivers d where d.ban_report_id = f.id and d.deleted_at is null loop
    if exists (
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

-- ----------------------------------------------------------------- 6. rattrapage des empreintes « phone »
-- Idempotent (rejouable). Pour chaque fiche encore présente dont le numéro s'écrit autrement avec la nouvelle règle
-- (« +330612… », « +33 (0)6… », « 33612… ») : (a) ses empreintes « phone » actives calculées avec l'ANCIENNE règle
-- prennent la nouvelle forme (même numéro ; en place : levées et signalements inchangés) ; (b) idem dans les
-- signalements ; (c) une fiche non bannie dont le numéro tombe désormais sur un bannissement actif (contournement
-- par l'écriture du numéro) est signalée comme un appareil de banni (vérification requise). Réécrire drivers.phone
-- est évité : le garde-fou des identités bannies le refuserait.
create or replace function private.rehash_phone_identities()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_rehashed uuid[] := '{}';
  v_reports integer := 0;
  v_flagged integer := 0;
begin
  -- (a) empreintes des bannissements
  for r in
    with p as (
      select q.id, q.new_hash, q.new_hint,
             case when char_length(regexp_replace(q.old_n, '[^0-9]', '', 'g')) >= 6
                  then encode(sha256(convert_to('rydar:phone:' || q.old_n, 'UTF8')), 'hex') end as old_hash
      from (
        select s.id, s.new_hash, s.new_hint,
               case when left(s.v, 2) = '00' then '+' || substr(s.v, 3)
                    when s.v ~ '^0[1-9][0-9]{8}$' then '+33' || substr(s.v, 2)
                    else s.v end as old_n
        from (
          select d.id, private.identity_hash('phone', d.phone) as new_hash, private.identity_hint('phone', d.phone) as new_hint,
                 case when left(btrim(d.phone), 1) = '+' then '+' || regexp_replace(d.phone, '[^0-9]', '', 'g')
                      else regexp_replace(d.phone, '[^0-9]', '', 'g') end as v
          from public.drivers d
          where d.deleted_at is null and btrim(coalesce(d.phone, '')) <> ''
        ) s
      ) q
    )
    select b.id, b.scope, b.organization_id, p.new_hash, p.new_hint
    from public.banned_identities b
    join p on p.id = b.driver_id
    where b.kind = 'phone' and b.lifted_at is null
      and p.new_hash is not null and p.old_hash is not null
      and b.value_hash = p.old_hash and p.new_hash <> p.old_hash
    order by b.created_at, b.id
  loop
    if not exists (select 1 from public.banned_identities b2
                   where b2.lifted_at is null and b2.scope = r.scope
                     and b2.organization_id is not distinct from r.organization_id
                     and b2.kind = 'phone' and b2.value_hash = r.new_hash) then
      update public.banned_identities set value_hash = r.new_hash, hint = r.new_hint where id = r.id;
      v_rehashed := v_rehashed || r.id;
    end if;
  end loop;

  -- (b) signalements (le super admin bannit ce qu'ils contiennent)
  for r in
    with p as (
      select q.id, q.new_hash, q.new_hint,
             case when char_length(regexp_replace(q.old_n, '[^0-9]', '', 'g')) >= 6
                  then encode(sha256(convert_to('rydar:phone:' || q.old_n, 'UTF8')), 'hex') end as old_hash
      from (
        select s.id, s.new_hash, s.new_hint,
               case when left(s.v, 2) = '00' then '+' || substr(s.v, 3)
                    when s.v ~ '^0[1-9][0-9]{8}$' then '+33' || substr(s.v, 2)
                    else s.v end as old_n
        from (
          select d.id, private.identity_hash('phone', d.phone) as new_hash, private.identity_hint('phone', d.phone) as new_hint,
                 case when left(btrim(d.phone), 1) = '+' then '+' || regexp_replace(d.phone, '[^0-9]', '', 'g')
                      else regexp_replace(d.phone, '[^0-9]', '', 'g') end as v
          from public.drivers d
          where d.deleted_at is null and btrim(coalesce(d.phone, '')) <> ''
        ) s
      ) q
    )
    select f.id, p.old_hash, p.new_hash, p.new_hint
    from public.fraud_reports f
    join p on p.id = f.driver_id
    where p.new_hash is not null and p.old_hash is not null and p.new_hash <> p.old_hash
      and exists (select 1 from jsonb_array_elements(f.identities) e where e ->> 'kind' = 'phone' and e ->> 'hash' = p.old_hash)
      and not exists (select 1 from jsonb_array_elements(f.identities) e where e ->> 'kind' = 'phone' and e ->> 'hash' = p.new_hash)
  loop
    update public.fraud_reports f
       set identities = (
         select coalesce(jsonb_agg(case when t.e ->> 'kind' = 'phone' and t.e ->> 'hash' = r.old_hash
                                        then t.e || jsonb_build_object('hash', r.new_hash, 'hint', r.new_hint)
                                        else t.e end order by t.n), '[]'::jsonb)
         from jsonb_array_elements(f.identities) with ordinality t(e, n))
     where f.id = r.id;
    v_reports := v_reports + 1;
  end loop;

  -- (c) fiches qui contournaient un bannissement par l'écriture du numéro
  for r in
    with p as (
      select q.id, q.new_hash,
             case when char_length(regexp_replace(q.old_n, '[^0-9]', '', 'g')) >= 6
                  then encode(sha256(convert_to('rydar:phone:' || q.old_n, 'UTF8')), 'hex') end as old_hash
      from (
        select s.id, s.new_hash,
               case when left(s.v, 2) = '00' then '+' || substr(s.v, 3)
                    when s.v ~ '^0[1-9][0-9]{8}$' then '+33' || substr(s.v, 2)
                    else s.v end as old_n
        from (
          select d.id, private.identity_hash('phone', d.phone) as new_hash,
                 case when left(btrim(d.phone), 1) = '+' then '+' || regexp_replace(d.phone, '[^0-9]', '', 'g')
                      else regexp_replace(d.phone, '[^0-9]', '', 'g') end as v
          from public.drivers d
          where d.deleted_at is null and d.banned_at is null and btrim(coalesce(d.phone, '')) <> ''
            and (d.status = 'active' or (d.status = 'inactive' and d.application_status = 'pending'))
        ) s
      ) q
    )
    select distinct on (d.id) d.id, b.scope
    from p
    join public.drivers d on d.id = p.id
    join public.banned_identities b
      on b.lifted_at is null and b.kind = 'phone' and b.value_hash = p.new_hash
     and (b.scope = 'platform' or b.organization_id = d.organization_id)
    where p.new_hash is not null
      and (p.old_hash is distinct from p.new_hash or b.id = any (v_rehashed))
    order by d.id, (b.scope = 'platform') desc
  loop
    if private.flag_driver_banned_match(r.id, 'phone', r.scope, '{}'::jsonb) then
      v_flagged := v_flagged + 1;
    end if;
  end loop;

  return jsonb_build_object('bans', coalesce(cardinality(v_rehashed), 0), 'reports', v_reports, 'flagged', v_flagged);
end;
$$;

select private.rehash_phone_identities();

-- ----------------------------------------------------------------- droits d'exécution
revoke execute on function
  private.identity_normalize(text, text),
  private.flag_driver_banned_match(uuid, text, text, jsonb),
  private.flag_banned_device(),
  private.audit_driver_document_number(),
  private.fraud_report_carriers(uuid),
  private.rehash_phone_identities()
from public, anon, authenticated;
grant execute on function
  private.identity_normalize(text, text),
  private.flag_driver_banned_match(uuid, text, text, jsonb),
  private.flag_banned_device(),
  private.audit_driver_document_number(),
  private.fraud_report_carriers(uuid),
  private.rehash_phone_identities()
to service_role;

-- Tableau de bord (owner / admin, contrôle dans la fonction) ; super admin (contrôle dans la fonction)
revoke execute on function
  public.ban_driver(uuid, text, text, boolean, boolean),
  public.admin_fraud_report_matches(uuid)
from public, anon;
grant execute on function
  public.ban_driver(uuid, text, text, boolean, boolean),
  public.admin_fraud_report_matches(uuid)
to authenticated, service_role;

-- Serveur uniquement (super admin, acteur revérifié en SQL) : service role
revoke execute on function
  public.svc_platform_ban(uuid, uuid, text, uuid[]),
  public.svc_platform_unban(uuid, uuid, text)
from public, anon, authenticated;
grant execute on function
  public.svc_platform_ban(uuid, uuid, text, uuid[]),
  public.svc_platform_unban(uuid, uuid, text)
to service_role;
