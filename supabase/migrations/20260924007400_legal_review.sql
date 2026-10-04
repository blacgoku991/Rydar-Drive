-- =============================================================================
-- Rydar Drive — Relecture juridique avant l'ouverture (04/10/2026) : le code rejoint ce que les textes promettent.
--
--  1. File des e-mails : deux types de plus, « platform_ban » (décision motivée envoyée au chauffeur interdit sur toute
--     la plateforme) et « booking_receipt » (accusé de réception d'une réservation du mini-site, mis en file par le web).
--  2. Bannissement de toute la plateforme (svc_platform_ban) : seulement pour une fraude ou un faux document (catégories
--     « fraud » et « documents ») — une dette ou un comportement reste propre à la centrale, aucune liste commune de
--     mauvais payeurs ; chaque chauffeur touché reçoit par e-mail la décision, ses motifs, son fondement (CGU art. 10 et
--     11), l'absence de décision automatisée et les voies de recours (règlement (UE) 2022/2065, art. 17).
--  3. Bannissement par la centrale (ban_driver) : le signalement à Rydar n'est possible que pour ces deux catégories.
--  4. État du compte dans l'application (driver_account_state) : « ban_scope » dit qui a décidé du bannissement.
--  5. CGV et accord de traitement (accept_legal_documents) : refusés tant que l'éditeur n'est pas identifié
--     (/admin/legal : raison sociale, siège, immatriculation) — LEGAL_EDITOR_MISSING.
--  6. Positions : la vitesse n'est plus gardée dans l'historique (update_driver_location) ; historique existant effacé.
--  7. E-mail de validation du réseau partagé : constat daté, ni sélection ni garantie.
--  8. Relances WhatsApp de Rydar au propriétaire : refus noté par le super admin (private.platform_whatsapp_refusals,
--     svc_platform_whatsapp_refusal), respecté par svc_platform_remind (WHATSAPP_OPTED_OUT) et affiché par
--     admin_platform_whatsapp (OPTED_OUT).
--  9. Ménage : téléphone, e-mail et précisions du client effacés 3 ans après la fin de l'année de la course.
--
-- Supabase hébergé : rien sur auth.*, storage.*, realtime.messages. Aucune signature changée : droits conservés.
-- =============================================================================

-- =============================================================================
-- 1. File des e-mails : décision de bannissement plateforme, accusé de réception d'une réservation
-- =============================================================================
-- Dernière définition de la contrainte : 20260924007100_shared_network_admin.sql (mêmes types + « platform_ban »,
-- « booking_receipt »). Conservation : 1 an une fois envoyés ou en échec (private.purge_contact_data, inchangée).
alter table public.email_outbox drop constraint if exists email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check
  check (kind in ('contact_notify', 'contact_ack', 'contact_reply', 'test', 'platform_fee_change', 'org_terms_update', 'network_review', 'platform_ban', 'booking_receipt'));
comment on column public.email_outbox.organization_id is
  'Organisation prévenue (platform_fee_change, org_terms_update, network_review) ou dont le mini-site a reçu la réservation (booking_receipt) ; null : e-mails du formulaire de contact, de test et de bannissement plateforme.';
-- Accusés de réception récents d'une adresse (plafond par adresse, contrôlé par le web avant l'envoi)
create index if not exists email_outbox_booking_receipt_idx on public.email_outbox (lower(to_email), created_at) where kind = 'booking_receipt';

-- =============================================================================
-- 2. Bannissement de toute la plateforme : fraude seulement, décision motivée envoyée au chauffeur
-- =============================================================================

-- Texte de l'e-mail au chauffeur interdit sur toute la plateforme (règlement (UE) 2022/2065, art. 17 : décision et
-- portée, faits, fondement contractuel, absence de décision automatisée, recours). Contenu fixe : catégorie du
-- signalement, date, précisions écrites par le super admin (montrées aussi à la centrale qui signale : jamais de donnée
-- d'un tiers), fiche touchée parce qu'elle partage un identifiant. Aucun nom : l'adresse est celle de la fiche ou du
-- compte, pas une preuve d'identité.
create or replace function private.platform_ban_email(p_category text, p_note text, p_shared boolean, p_org_name text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_reply boolean := private.platform_reply_to() is not null;
  v_parts text[];
begin
  v_parts := array[
    'Bonjour,',
    format('L''éditeur de Rydar Drive (logiciel utilisé par des centrales et des flottes de VTC) a décidé le %s d''interdire votre compte chauffeur sur toute la plateforme Rydar Drive.',
      private.fr_long_date((now() at time zone 'Europe/Paris')::date)),
    'Motif : ' || case p_category when 'documents' then 'document faux ou falsifié' else 'fraude constatée' end
      || ', signalé par une centrale qui utilise Rydar Drive et examiné par l''éditeur.'
      || coalesce(' Précisions : ' || nullif(btrim(coalesce(p_note, '')), ''), '')];
  if p_shared then
    v_parts := v_parts || format('Votre fiche chez %s est concernée parce qu''elle partage un identifiant (téléphone, e-mail, numéro de carte VTC, de permis ou de pièce d''identité, plaque ou appareil) avec le compte signalé.',
      coalesce(p_org_name, 'votre centrale'));
  end if;
  v_parts := v_parts || array[
    'Fondement : conditions générales d''utilisation de Rydar Drive, articles 10 (comportements interdits) et 11 (suspension, bannissement et recours).',
    'Cette décision a été prise par une personne de l''éditeur, après examen du signalement : elle n''a pas été prise de façon automatisée.',
    'Conséquences : vous ne pouvez plus utiliser l''application chauffeur, ni vous inscrire auprès d''une centrale ou d''une flotte qui utilise Rydar Drive avec ces identifiants ; vos courses à venir ont été remises à attribuer. Des empreintes (hachages) de vos identifiants sont conservées 3 ans au plus pour empêcher une nouvelle inscription.',
    'Recours : vous pouvez contester cette décision dans les 6 mois, '
      || case when v_reply then 'en répondant à cet e-mail'
              else 'en écrivant à l''éditeur depuis la page Contact du site Rydar Drive' end
      || ' : une autre personne de l''éditeur la réexaminera et vous recevrez une réponse motivée. Vous pouvez aussi saisir le juge compétent et, pour vos données personnelles, adresser une réclamation à la CNIL (www.cnil.fr).',
    'Vous pouvez supprimer votre compte à tout moment : voir la page « Supprimer son compte » du site Rydar Drive.',
    'L''équipe Rydar Drive'];
  return jsonb_build_object(
    'subject', private.fr_typo('Rydar Drive : décision concernant votre compte chauffeur'),
    'body', private.fr_typo(array_to_string(v_parts, E'\n\n')));
end;
$$;

-- Dernière définition : 20260924007200_shared_network_fixes.sql (corps gardé À L'IDENTIQUE). Seuls ajouts :
-- signalement d'une autre catégorie que « fraud » / « documents » refusé (PLATFORM_BAN_CATEGORY), décision motivée
-- envoyée par e-mail à chaque chauffeur touché (private.platform_ban_email, une fois par adresse), compteur « emails »
-- et « notified » dans le journal.
create or replace function public.svc_platform_ban(
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
  v_ride record;
  v_reassigned integer := 0;
  v_onboard text;
  -- Information du chauffeur (règlement (UE) 2022/2065, art. 17)
  v_email text;
  v_sent text[] := '{}';
  v_mail jsonb;
  v_mailed integer := 0;
begin
  perform private.assert_platform_actor(p_actor);
  select * into f from public.fraud_reports where id = p_report_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Signalement introuvable.');
  end if;
  if f.status = 'platform_banned' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_BANNED', 'message', 'Déjà banni de la plateforme.');
  end if;
  -- Liste d'exclusion commune limitée à la fraude : une dette, un comportement ou un autre motif reste propre à la
  -- centrale qui l'a constaté (convention du réseau partagé : « aucune liste commune de mauvais payeurs »)
  if f.category not in ('fraud', 'documents') then
    return jsonb_build_object('ok', false, 'code', 'PLATFORM_BAN_CATEGORY',
      'message', private.fr_typo('Seule une fraude ou un faux document peut entraîner une interdiction sur toute la plateforme. Une dette, un comportement ou un autre motif reste propre à la centrale : classez le signalement.'));
  end if;
  if exists (select 1 from public.drivers d where d.id = f.driver_id and d.deleted_at is null and d.banned_at is null) then
    return jsonb_build_object('ok', false, 'code', 'REPORTED_DRIVER_NOT_BANNED',
      'message', 'Sa centrale a levé le bannissement de ce chauffeur : classez le signalement.');
  end if;
  perform private.set_actor('super_admin', p_actor);

  -- Fiches qui partagent une identité : même centrale (automatique), autres centrales confirmées / écartées
  select coalesce(array_agg(distinct c.driver_id) filter (where c.same_org), '{}') into v_same
  from private.fraud_report_carriers(f.id) c;
  with c as (select * from private.fraud_report_carriers(f.id) k where not (k.driver_id = any (v_same)))
  select coalesce(array_agg(distinct c.driver_id) filter (where c.driver_id = any (v_extend)), '{}'),
         coalesce(array_agg(distinct c.driver_id) filter (where not (c.driver_id = any (v_extend))), '{}'),
         coalesce(array_agg(distinct c.kind || ':' || c.value_hash) filter (where not (c.driver_id = any (v_extend))), '{}')
    into v_confirmed, v_skipped, v_blocked
  from c;

  -- Client à bord d'une fiche visée : rien n'est fait (même règle que ban_driver)
  select string_agg(distinct format('%s %s (#%s)', d.first_name, d.last_name, d.number), ', ') into v_onboard
  from public.drivers d
  join public.rides r on r.driver_id = d.id and r.status in ('PASSENGER_ONBOARD', 'IN_PROGRESS')
  where d.deleted_at is null
    and d.ban_scope is distinct from 'platform'
    and (d.id = f.driver_id or d.id = any (v_same) or d.id = any (v_confirmed));
  if v_onboard is not null then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_ON_RIDE',
      'message', 'Client à bord (' || v_onboard || ') : attendez la fin de la course avant de bannir de la plateforme.');
  end if;

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
    select d.id, d.user_id, d.organization_id, d.email, o.name as org_name
    from public.drivers d
    join public.organizations o on o.id = d.organization_id
    where d.deleted_at is null
      and d.ban_scope is distinct from 'platform'
      and (d.id = f.driver_id or d.id = any (v_same) or d.id = any (v_confirmed))
  loop
    for v_ride in
      select r.id, r.organization_id from public.rides r
      where r.driver_id = x.id and r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED')
      order by r.pickup_at
    loop
      -- Réseau partagé : course d'une autre organisation (confiée à ce chauffeur) rendue à son organisation, qui la
      -- relance (private.unassign_network_ride, « executor_unavailable ») ; jamais un UPDATE direct de rides.driver_id
      if v_ride.organization_id <> x.organization_id then
        if coalesce((private.unassign_network_ride(x.id, v_ride.id, 'executor_unavailable') ->> 'ok')::boolean, false) then
          v_reassigned := v_reassigned + 1;
        end if;
      elsif coalesce((private.platform_unassign_ride(v_ride.id, 'Chauffeur banni de la plateforme Rydar', p_actor) ->> 'ok')::boolean, false) then
        v_reassigned := v_reassigned + 1;
      end if;
    end loop;
    update public.drivers
       set status = case when status = 'inactive' then 'inactive' else 'suspended' end::public.driver_status,
           presence = 'offline',
           online_since = null,
           current_ride_id = null,
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
    -- Décision motivée envoyée au chauffeur (adresse de la fiche, sinon celle du compte), une fois par adresse ; une
    -- fiche autre que celle signalée est touchée parce qu'elle partage un identifiant avec elle
    v_email := coalesce(nullif(lower(btrim(coalesce(x.email, ''))), ''),
                        (select lower(btrim(u.email)) from public.users u where u.id = x.user_id));
    if private.email_address_ok(v_email) and not (v_email = any (v_sent)) then
      v_sent := v_sent || v_email;
      v_mail := private.platform_ban_email(f.category, v_note, x.id <> f.driver_id, x.org_name);
      insert into public.email_outbox (kind, to_email, reply_to, subject, body_text, created_by)
      values ('platform_ban', v_email, private.platform_reply_to(), v_mail ->> 'subject', v_mail ->> 'body', p_actor);
      v_mailed := v_mailed + 1;
    end if;
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
    values (x.organization_id, 'super_admin', p_actor, 'driver.platform_banned', 'drivers', x.id::text, 'critical',
      jsonb_build_object('report_id', f.id, 'extended', x.id = any (v_confirmed),
        'login_kept', x.user_id is not null and x.user_id = any (v_kept),
        'notified', v_email is not null and v_email = any (v_sent)));
  end loop;

  return jsonb_build_object('ok', true, 'code', 'PLATFORM_BANNED', 'identities', v_count,
    'identities_skipped', v_identities_skipped, 'drivers', v_drivers, 'reassigned_rides', v_reassigned,
    'extended', coalesce(cardinality(v_confirmed), 0), 'skipped_drivers', coalesce(cardinality(v_skipped), 0),
    'user_ids', to_jsonb(v_users), 'kept_user_ids', to_jsonb(v_kept), 'emails', v_mailed,
    'message', case when v_identities_skipped > 0
      then 'Banni de la plateforme, sauf les identités partagées avec des fiches d''autres centrales non confirmées.'
      else 'Banni de toute la plateforme.' end);
end;
$$;

-- =============================================================================
-- 3. Bannissement par la centrale : signalement à Rydar réservé à la fraude et aux faux documents
-- =============================================================================
-- Dernière définition : 20260924006800_shared_network_dispatch.sql (corps gardé À L'IDENTIQUE). Seul ajout : un
-- signalement à Rydar (p_report_to_platform) pour une autre catégorie que « fraud » / « documents » est refusé
-- (PLATFORM_REPORT_CATEGORY), avant toute écriture ; le bannissement dans la centrale reste possible sans signalement.
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
  -- Signalement à Rydar (interdiction possible sur toute la plateforme) : fraude ou faux document seulement ; une
  -- dette, un comportement ou un autre motif reste propre à la centrale (aucune empreinte transmise à Rydar)
  if coalesce(p_report_to_platform, false) and v_category not in ('fraud', 'documents') then
    return jsonb_build_object('ok', false, 'code', 'PLATFORM_REPORT_CATEGORY',
      'message', private.fr_typo('Seule une fraude ou un faux document peut être signalé à Rydar : une dette, un comportement ou un autre motif reste propre à votre centrale.'));
  end if;
  if d.banned_at is not null then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_BANNED', 'message', 'Ce chauffeur est déjà banni.');
  end if;
  if exists (select 1 from public.rides r where r.driver_id = d.id and r.status in ('PASSENGER_ONBOARD', 'IN_PROGRESS')) then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_ON_RIDE',
      'message', case
        -- Réseau partagé : course d'une autre organisation, que la sienne ne peut pas annuler
        when exists (select 1 from public.rides r where r.driver_id = d.id and r.status in ('PASSENGER_ONBOARD', 'IN_PROGRESS')
                       and r.organization_id <> d.organization_id)
          then 'Client à bord d''une course partenaire : attendez la fin de la course avant de bannir ce chauffeur.'
        else 'Client à bord : attendez la fin de la course (ou annulez-la) avant de bannir ce chauffeur.' end);
  end if;

  -- Courses attribuées pas encore commencées : remises en recherche
  for v_ride in
    select r.id, r.organization_id from public.rides r
    where r.driver_id = d.id and r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED')
    order by r.pickup_at
  loop
    -- Réseau partagé : course d'une autre organisation (confiée à ce chauffeur) rendue à son organisation, qui la
    -- relance (private.unassign_network_ride, « executor_released » ; public.reassign_ride lèverait FORBIDDEN)
    if v_ride.organization_id <> d.organization_id then
      v_res := private.unassign_network_ride(d.id, v_ride.id, 'executor_released');
    else
      v_res := public.reassign_ride(v_ride.id, 'Chauffeur banni', d.id);
    end if;
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

-- =============================================================================
-- 4. État du compte dans l'application : qui a décidé du bannissement
-- =============================================================================
-- Dernière définition : 20260924002600_centrale_mode.sql. Seul ajout : clé « ban_scope » (org | platform) pour un compte
-- banni ; l'application ne présente plus un bannissement de l'éditeur comme une décision de la centrale.
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
    'organization', jsonb_build_object('id', o.id, 'name', o.name, 'logo_url', o.logo_url, 'phone', o.phone, 'email', o.email,
      'timezone', o.timezone, 'dispatch_model', o.dispatch_model),
    'reason', case v_state
      when 'banned' then d.ban_reason
      when 'rejected' then d.application_note
      when 'suspended' then d.suspended_reason
    end,
    'can_submit_documents', v_state = 'pending',
    -- Bannissement : « org » (décidé par la centrale) ou « platform » (décidé par l'éditeur, motifs envoyés par e-mail)
    'ban_scope', case when v_state = 'banned' then d.ban_scope end
  );
end;
$$;

-- =============================================================================
-- 5. CGV et accord de traitement : identité de l'éditeur exigée
-- =============================================================================
-- Dernière définition : 20260924006650_audit_fixes.sql. Seul ajout : « cgv » ou « dpa » refusés
-- (LEGAL_EDITOR_MISSING) tant que platform_legal n'a ni raison sociale, ni siège, ni immatriculation ; CGU et
-- politique de confidentialité inchangées.
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
  -- CGV et accord de traitement : jamais acceptés tant que l'éditeur, partie au contrat, n'est pas identifié
  -- (/admin/legal : raison sociale, siège, immatriculation)
  if (p_documents && array['cgv', 'dpa']::text[]) and not exists (
    select 1 from public.platform_legal l
     where l.id
       and nullif(btrim(coalesce(l.company_name, '')), '') is not null
       and nullif(btrim(coalesce(l.address, '')), '') is not null
       and nullif(btrim(coalesce(l.registration, '')), '') is not null) then
    return jsonb_build_object('ok', false, 'code', 'LEGAL_EDITOR_MISSING',
      'message', private.fr_typo('Conditions momentanément indisponibles : identité de l''éditeur à compléter.'));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('rydar.legal_accept:' || v_uid::text, 0));
  if not exists (select 1 from public.legal_acceptances a where a.user_id = v_uid and a.version = v_version)
     and (select count(distinct a.version) from public.legal_acceptances a where a.user_id = v_uid) >= 50 then
    return jsonb_build_object('ok', false, 'code', 'TOO_MANY_VERSIONS',
      'message', 'Trop de versions acceptées pour ce compte : contactez le support.');
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

-- =============================================================================
-- 6. Vitesse des chauffeurs : jamais dans l'historique des positions
-- =============================================================================
-- Dernière définition : 20260924007000_shared_network_access.sql (corps gardé À L'IDENTIQUE). Seul changement : la
-- vitesse n'est plus écrite dans driver_location_history (minimisation, CNIL : pas de contrôle des vitesses) ; elle
-- reste sur la dernière position (driver_locations, remplacée à chaque envoi) pour afficher « en mouvement ».
create or replace function public.update_driver_location(
  p_lat double precision,
  p_lng double precision,
  p_heading real default null,
  p_speed real default null,
  p_accuracy real default null,
  p_battery real default null,
  p_recorded_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d record;
  v_recorded timestamptz := least(coalesce(p_recorded_at, now()), now());
  v_has_recent_history boolean;
  -- Réseau partagé
  v_ride_org uuid;
begin
  select x.id, x.organization_id, x.presence, x.current_ride_id, x.last_seen_at into d
  from public.drivers x where x.id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'INVALID_COORDINATES' using errcode = '22023';
  end if;

  insert into public.driver_locations as dl
    (driver_id, organization_id, lat, lng, heading, speed_mps, accuracy_m, battery_level, recorded_at, updated_at)
  values (d.id, d.organization_id, p_lat, p_lng, p_heading, p_speed, p_accuracy, p_battery, v_recorded, now())
  on conflict (driver_id) do update
    set lat = excluded.lat,
        lng = excluded.lng,
        heading = excluded.heading,
        speed_mps = excluded.speed_mps,
        accuracy_m = excluded.accuracy_m,
        battery_level = coalesce(excluded.battery_level, dl.battery_level),
        recorded_at = excluded.recorded_at,
        updated_at = now()
    where dl.recorded_at <= excluded.recorded_at;

  -- Historique : chaque point en course, sinon 1 point / minute
  select exists (
    select 1 from public.driver_location_history h
    where h.driver_id = d.id and h.recorded_at > now() - interval '1 minute'
  ) into v_has_recent_history;
  if d.current_ride_id is not null or not v_has_recent_history then
    -- Réseau partagé (§11.6, Q5, S8) : point d'une course d'une AUTRE organisation marqué (ride_org_id) — invisible
    -- pour l'organisation du chauffeur (policy driver_location_history_select), supprimé 1 h après la fin
    -- (private.housekeeping) ; course propre ou aucune course : NULL, comme avant
    if d.current_ride_id is not null then
      select r.organization_id into v_ride_org from public.rides r
       where r.id = d.current_ride_id and r.organization_id <> d.organization_id;
    end if;
    insert into public.driver_location_history (organization_id, driver_id, ride_id, lat, lng, speed_mps, heading, accuracy_m, recorded_at,
                                                ride_org_id)
    values (d.organization_id, d.id, d.current_ride_id, p_lat, p_lng, null, p_heading, p_accuracy, v_recorded, v_ride_org);
  end if;

  if d.last_seen_at is null or d.last_seen_at < now() - interval '60 seconds' then
    update public.drivers set last_seen_at = now() where id = d.id;
  end if;

  -- Fréquence GPS adaptative suggérée à l'application (économie batterie)
  return jsonb_build_object(
    'ok', true,
    'presence', d.presence,
    'next_interval_s', case
      when d.current_ride_id is not null or d.presence = 'offered' then 5
      when d.presence = 'offline' then 120
      else 15
    end
  );
end;
$$;

-- Historique existant (30 jours au plus) : vitesse effacée
update public.driver_location_history set speed_mps = null where speed_mps is not null;

-- =============================================================================
-- 7. E-mail de validation du réseau partagé : constat daté, sans garantie
-- =============================================================================
-- Dernière définition : 20260924007100_shared_network_admin.sql. Seul changement : le texte d'une validation (constat
-- daté de la correspondance avec le registre, ni sélection ni garantie, convention art. 2) ; refus inchangé.
create or replace function private.network_review_email(p_org uuid, p_approved boolean, p_reason text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  o public.organizations;
  m public.network_memberships;
  v_ref text := private.platform_reference(p_org);
  v_reply boolean := private.platform_reply_to() is not null;
  v_parts text[];
begin
  select * into o from public.organizations x where x.id = p_org;
  select * into m from public.network_memberships x where x.organization_id = p_org;
  if p_approved then
    v_parts := array[
      'Bonjour,',
      format('Rydar a constaté, le %s, que la raison sociale, le SIRET et le numéro d''inscription déclarés pour votre organisation %s (référence %s) correspondent au registre des exploitants VTC consulté à cette date. Votre participation au réseau partagé est ouverte.',
        private.fr_long_date((now() at time zone 'Europe/Paris')::date), o.name, v_ref),
      'Cette vérification administrative ponctuelle n''est ni une sélection ni une garantie : chaque organisation reste seule responsable de ses chauffeurs, de leurs cartes professionnelles, de ses véhicules et de ses assurances.',
      format('Informations validées, montrées aux organisations partenaires : %s, SIRET %s, n° d''inscription au registre des exploitants VTC %s. Un changement du nom, de la raison sociale, du SIRET ou du n° d''inscription de votre organisation demandera une nouvelle vérification, et plus aucune course ne sera échangée d''ici là.',
        m.approved_legal_name, m.approved_siret, m.approved_vtc_registration),
      'Le partage de vos courses et la réception des courses du réseau se règlent dans l''onglet « Réseau partagé » du tableau de bord Rydar Drive : chaque sens devient actif dès que ses conditions sont remplies.'];
  else
    v_parts := array[
      'Bonjour,',
      format('Rydar n''a pas pu valider la participation de votre organisation %s (référence %s) au réseau partagé.', o.name, v_ref),
      'Motif : ' || coalesce(p_reason, '—'),
      'Corrigez si besoin la fiche de votre organisation (raison sociale, SIRET, n° d''inscription au registre des exploitants VTC), puis réactivez le partage ou la réception dans l''onglet « Réseau partagé » du tableau de bord Rydar Drive : une nouvelle vérification sera demandée.'];
  end if;
  v_parts := v_parts || array[
    'Message automatique de Rydar Drive. '
      || case when v_reply then 'Une question ? Répondez à cet e-mail.'
              else 'Une question ? Écrivez-nous depuis la page Contact du site Rydar Drive.' end,
    'L''équipe Rydar Drive'];
  return jsonb_build_object(
    'subject', private.fr_typo(case when p_approved then 'Rydar Drive : participation au réseau partagé validée'
                                    else 'Rydar Drive : participation au réseau partagé non validée' end),
    'body', private.fr_typo(array_to_string(v_parts, E'\n\n')));
end;
$$;

-- =============================================================================
-- 8. Relances WhatsApp de Rydar au propriétaire : refus noté et respecté
-- =============================================================================
-- CGV art. 10 : en renseignant le téléphone du propriétaire et de la centrale, la centrale accepte des messages de
-- service WhatsApp sur ses frais Rydar ; le propriétaire peut s'y opposer en écrivant à l'éditeur, qui le note ici.
-- Table privée (aucun accès client ni service role direct) : écriture par svc_platform_whatsapp_refusal, lecture par
-- admin_platform_whatsapp et svc_platform_remind.
create table if not exists private.platform_whatsapp_refusals (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  refused_at timestamptz not null default now(),
  noted_by uuid references public.users (id) on delete set null,
  note text check (note is null or char_length(note) <= 300)
);
comment on table private.platform_whatsapp_refusals is
  'Refus du propriétaire de recevoir les relances WhatsApp de Rydar (frais plateforme) — écriture : svc_platform_whatsapp_refusal (super admin).';
revoke all on private.platform_whatsapp_refusals from public, anon, authenticated, service_role;

-- Super admin (service role, auteur p_actor revérifié) : noter (p_refused) ou retirer le refus ; journal d'audit
create or replace function public.svc_platform_whatsapp_refusal(p_org uuid, p_actor uuid, p_refused boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_note text := left(nullif(btrim(coalesce(p_note, '')), ''), 300);
  v_changed integer;
begin
  perform private.assert_platform_actor(p_actor);
  if not exists (select 1 from public.organizations o where o.id = p_org) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Organisation introuvable.');
  end if;
  if coalesce(p_refused, false) then
    insert into private.platform_whatsapp_refusals (organization_id, noted_by, note)
    values (p_org, p_actor, v_note)
    on conflict (organization_id) do nothing;
  else
    delete from private.platform_whatsapp_refusals where organization_id = p_org;
  end if;
  get diagnostics v_changed = row_count;
  if v_changed > 0 then
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
    values (p_org, 'super_admin', p_actor,
      case when coalesce(p_refused, false) then 'platform_fee.whatsapp_refused' else 'platform_fee.whatsapp_allowed' end,
      'organizations', p_org::text, 'info', jsonb_build_object('note', v_note));
  end if;
  return jsonb_build_object('ok', true, 'code', case when coalesce(p_refused, false) then 'REFUSED' else 'ALLOWED' end,
    'message', case when coalesce(p_refused, false)
      then 'Refus noté : plus aucune relance par WhatsApp pour cette organisation.'
      else 'Refus retiré : les relances par WhatsApp sont de nouveau possibles.' end);
end;
$$;

-- Dernière définition : 20260924006600_platform_fee_schedule.sql (corps gardé À L'IDENTIQUE). Seul ajout : relance par
-- WhatsApp refusée (WHATSAPP_OPTED_OUT, sans consommer la limite d'une relance par heure) quand le propriétaire l'a
-- refusée ; la relance affichée dans le tableau de bord reste possible.
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
        'message', private.fr_typo('WhatsApp indisponible pour une flotte : le modèle approuvé par Meta renvoie à l''onglet « Encaissements », absent d''une flotte. Relancez sans WhatsApp (rappel affiché dans son tableau de bord).'));
    end if;
    -- Refus du propriétaire noté par le super admin (CGV art. 10) : aucune relance par WhatsApp
    if exists (select 1 from private.platform_whatsapp_refusals x where x.organization_id = p_org) then
      return jsonb_build_object('ok', false, 'code', 'WHATSAPP_OPTED_OUT',
        'message', private.fr_typo('Le propriétaire a refusé les messages WhatsApp de Rydar : relancez sans WhatsApp (rappel affiché dans son tableau de bord).'));
    end if;
    if not private.whatsapp_ready('platform', null) then
      return jsonb_build_object('ok', false, 'code', 'WHATSAPP_NOT_CONFIGURED',
        'message', private.fr_typo('WhatsApp de Rydar non configuré : renseignez le numéro dans Frais plateforme › WhatsApp.'));
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

-- Dernière définition : 20260924006600_platform_fee_schedule.sql. Seuls ajouts : « refused_at » et raison
-- « OPTED_OUT » (refus du propriétaire), « ready » faux dans ce cas.
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
  v_refused timestamptz;
begin
  if not private.is_super_admin() then
    raise exception 'FORBIDDEN: réservé au super admin' using errcode = '42501';
  end if;
  v_target := private.platform_whatsapp_target(p_org);
  select o.dispatch_model = 'fleet' into v_fleet from public.organizations o where o.id = p_org;
  v_fleet := coalesce(v_fleet, false);
  select x.refused_at into v_refused from private.platform_whatsapp_refusals x where x.organization_id = p_org;
  return jsonb_build_object(
    'ready', private.whatsapp_ready('platform', null) and not v_fleet and v_refused is null,
    'refused_at', v_refused,
    'to_display', private.wa_mask(v_target ->> 'to'),
    'source', v_target -> 'source',
    'name', v_target -> 'name',
    'reason', case
      when v_fleet then 'FLEET_UNSUPPORTED'
      when v_refused is not null then 'OPTED_OUT'
      when not private.whatsapp_ready('platform', null) then 'NOT_CONFIGURED'
      when v_target ->> 'to' is null then 'NO_PHONE' end);
end;
$$;

-- =============================================================================
-- 9. Coordonnées des clients : 3 ans après la fin de l'année de la course
-- =============================================================================
-- Dernière définition : 20260924007300_retention_purges.sql (corps gardé À L'IDENTIQUE). Seul ajout : une fois par
-- jour, téléphone (remplacé par « effacé » : colonne obligatoire), e-mail et précisions du client effacés 3 ans après
-- la fin de l'année de la prise en charge ; la course, le nom du client et les montants restent jusqu'à la purge des
-- 10 ans. Compteur « customer_contacts_purged ».
create or replace function private.housekeeping()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_history integer;
  v_last_positions integer;
  v_logs integer;
  v_docs integer;
  v_notifs integer;
  v_chat integer;
  v_fleet integer;
  v_network integer;
  v_alert_positions integer;
  v_debtors integer;
  v_auth integer;
  -- Conformité (RGPD)
  v_api_ips integer;
  v_sessions integer;
  v_contacts integer;
  v_contacts_before timestamptz := date_trunc('year', now() - interval '3 years');
  v_expired integer;
  v_fee_changes integer;
  v_reductions integer;
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

  delete from public.driver_location_history where recorded_at < now() - interval '30 days';
  get diagnostics v_history = row_count;
  delete from public.driver_locations l
   where l.updated_at < now() - interval '30 days'
     and not exists (select 1 from public.drivers d where d.id = l.driver_id and d.current_ride_id is not null);
  get diagnostics v_last_positions = row_count;
  -- Réseau partagé (Q5, §11.6, S8) : points GPS d'une course partenaire (ride_org_id, invisibles pour l'organisation du
  -- chauffeur) 1 h après la fin de son exécution pour ce chauffeur (private.network_ended_traces) ; comptés avec
  -- l'historique purgé (réponse inchangée)
  delete from public.driver_location_history h
   using private.network_ended_traces() n
   where h.ride_id = n.ride_id and h.driver_id = n.driver_id and h.ride_org_id is not null;
  get diagnostics v_count = row_count;
  v_history := v_history + v_count;
  delete from public.api_logs where created_at < now() - interval '90 days';
  get diagnostics v_logs = row_count;
  -- Conformité (RGPD, art. 5.1.c et 5.1.e) : dernière adresse IP d'une clé d'API effacée 90 jours après sa dernière
  -- utilisation, comme les journaux d'appels (la clé et sa date d'utilisation restent ; colonne hors du journal d'audit)
  update public.api_keys
     set last_used_ip = null
   where last_used_ip is not null
     and coalesce(last_used_at, created_at) < now() - interval '90 days';
  get diagnostics v_api_ips = row_count;
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
  -- Réseau partagé : rappels et notifications de vol du chauffeur partenaire (adresse, n° de vol), même délai ; comptés
  -- avec les notifications purgées
  delete from public.notifications x
   using private.network_ended_traces() n
   where x.ride_id = n.ride_id and x.driver_id = n.driver_id and x.driver_org_id <> x.organization_id
     and x.type in ('ride_reminder', 'flight_update');
  get diagnostics v_count = row_count;
  v_notifs := v_notifs + v_count;
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
  -- Réseau partagé : empreintes d'un chauffeur partenaire supprimé, plus rien d'ouvert envers CETTE organisation
  -- créancière (comptées avec les précédentes : réponse inchangée)
  delete from private.network_debtor_identities n
   where not exists (
     select 1 from public.ride_settlements s
      where s.organization_id = n.creditor_org_id and s.network_driver_id = n.driver_id
        and s.network_driver_org_id is not null and s.direction = 'driver_owes'
        and s.status in ('due', 'declared', 'disputed') and s.amount_cents > 0);
  get diagnostics v_count = row_count;
  v_debtors := v_debtors + v_count;
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
    -- Conformité (RGPD, art. 5.1.e) : sessions Auth inactives depuis plus de 400 jours (durée maximale du cookie de
    -- session) supprimées avec leur adresse IP et leur navigateur ; leurs jetons de rafraîchissement suivent
    -- (auth.refresh_tokens.session_id, on delete cascade). refreshed_at est un « timestamp » sans fuseau (UTC) chez Auth.
    begin
      v_sessions := 0;
      if to_regclass('auth.sessions') is not null then
        delete from auth.sessions s
         where coalesce(s.refreshed_at::timestamptz, s.updated_at, s.created_at) < now() - interval '400 days';
        get diagnostics v_sessions = row_count;
      end if;
    exception when others then
      v_sessions := null;
      v_errors := v_errors || jsonb_build_object('auth_sessions', left(sqlerrm, 300));
    end;
  end if;

  -- Conformité (RGPD art. 5.1.e ; CNIL, référentiel « gestion commerciale ») : une fois par jour, coordonnées du client
  -- (téléphone, e-mail) et précisions effacées 3 ans après la fin de l'année de la prise en charge ; la course, le nom
  -- du client et les montants restent jusqu'à la purge des 10 ans. Téléphone obligatoire en base : remplacé par
  -- « effacé ». Sans diffusion ni déclencheur métier (rydar.bypass_ride_rules, comme une reprise de données) ; aucune
  -- colonne verrouillée d'une course partagée n'est touchée. 5 000 courses au plus par passage (index partiel).
  if not exists (select 1 from private.housekeeping_runs h
                  where h.task = 'customer_contacts' and h.last_run_at > now() - interval '1 day') then
    insert into private.housekeeping_runs (task, last_run_at) values ('customer_contacts', now())
    on conflict (task) do update set last_run_at = excluded.last_run_at;
    begin
      perform set_config('rydar.bypass_ride_rules', 'on', true);
      with batch as (
        select r.id from public.rides r
         where r.pickup_at < v_contacts_before
           and (r.customer_phone <> 'effacé' or r.customer_email is not null or r.comment is not null)
         order by r.pickup_at
         limit 5000
      )
      update public.rides r
         set customer_phone = 'effacé', customer_email = null, comment = null
        from batch b
       where r.id = b.id;
      get diagnostics v_contacts = row_count;
      perform set_config('rydar.bypass_ride_rules', '', true);
    exception when others then
      perform set_config('rydar.bypass_ride_rules', '', true);
      v_contacts := null;
      v_errors := v_errors || jsonb_build_object('customer_contacts', left(sqlerrm, 300));
    end;
  end if;

  -- Frais Rydar (20260924006600) : baisses en attente depuis 30 jours sans décision du super admin acceptées (CGV
  -- art. 5)
  begin
    v_reductions := private.accept_stale_platform_reductions();
  exception when others then
    v_reductions := null;
    v_errors := v_errors || jsonb_build_object('platform_reductions', left(sqlerrm, 300));
  end;
  -- Hausses annoncées arrivées à leur date d'effet, EN DERNIER : le verrou de l'organisation (UPDATE des taux) est gardé
  -- jusqu'à la fin de la transaction, et la création d'une course de l'organisation l'attend
  begin
    v_fee_changes := private.apply_platform_fee_changes();
  exception when others then
    v_fee_changes := null;
    v_errors := v_errors || jsonb_build_object('platform_fee_changes', left(sqlerrm, 300));
  end;

  return jsonb_build_object('rides_expired', v_expired, 'platform_fee_changes_applied', v_fee_changes,
    'platform_reductions_accepted', v_reductions,
    'history_purged', v_history, 'last_positions_purged', v_last_positions, 'api_logs_purged', v_logs,
    'documents_expired', v_docs, 'notifications_purged', v_notifs, 'chat_purged', v_chat,
    'fleet_events_purged', v_fleet, 'audit_network_purged', v_network, 'rides_purged', v_rides,
    'bans_purged', v_bans, 'alert_positions_purged', v_alert_positions, 'debtor_identities_purged', v_debtors,
    'auth_audit_purged', v_auth,
    -- Conformité (RGPD) : NULL hors du passage horaire (comme auth_audit_purged)
    'api_key_ips_purged', v_api_ips, 'auth_sessions_purged', v_sessions,
    -- Coordonnées des clients de plus de 3 ans : NULL hors du passage quotidien
    'customer_contacts_purged', v_contacts)
    || case when v_errors = '{}'::jsonb then '{}'::jsonb else jsonb_build_object('errors', v_errors) end;
end;
$$;

-- =============================================================================
-- 10. Mini-site : accusé de réception de la réservation (Code civil, art. 1127-2)
-- =============================================================================
-- Le web (service role) appelle svc_booking_receipt juste après l'enregistrement d'une réservation du mini-site qui
-- porte une adresse e-mail. Contenu FIXE tiré de la base (n°, date, catégorie, passagers, prix, coordonnées de la
-- centrale) : jamais d'adresse ni de texte saisis par le visiteur (le formulaire ne sert pas à écrire à un tiers) ;
-- un accusé par réservation, 3 au plus par adresse et par 24 h.
alter table public.email_outbox add column if not exists ride_id uuid references public.rides (id) on delete cascade;
comment on column public.email_outbox.ride_id is 'Réservation du mini-site dont cet e-mail accuse réception (booking_receipt).';
create unique index if not exists email_outbox_booking_receipt_ride_key on public.email_outbox (ride_id) where kind = 'booking_receipt';

create or replace function private.booking_receipt_email(r public.rides, o public.organizations, s public.booking_sites)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tz text := coalesce(nullif(o.timezone, ''), 'Europe/Paris');
  v_operator text := coalesce(nullif(btrim(coalesce(o.legal_name, '')), ''), o.name);
  v_contact text := concat_ws(', ', nullif(btrim(coalesce(s.phone, '')), ''), nullif(btrim(coalesce(s.email, '')), ''));
  v_parts text[];
begin
  v_parts := array[
    'Bonjour,',
    format('%s a bien reçu votre réservation n° %s.', v_operator, r.number),
    format('Prise en charge : le %s à %s (heure locale du départ).',
      private.fr_long_date((r.pickup_at at time zone v_tz)::date), to_char(r.pickup_at at time zone v_tz, 'HH24:MI')),
    format('Véhicule : %s, %s.',
      case r.vehicle_category::text when 'standard' then 'Berline' when 'business' then 'Business' when 'first' then 'Prestige'
        when 'van' then 'Van' when 'green' then 'Électrique' else r.vehicle_category::text end,
      r.passengers || ' ' || private.pl(r.passengers, 'passager', 'passagers')),
    case when r.price_cents is not null
      then format('Prix : %s TTC, payable à %s selon ses conditions.', private.fmt_eur(r.price_cents), v_operator)
      else format('Prix : %s vous le confirme avant la course.', v_operator) end,
    format('Pour toute question, modification ou annulation, contactez %s%s. Conservez cet e-mail.',
      v_operator, coalesce(' : ' || nullif(v_contact, ''), '')),
    format('Message envoyé pour %s par Rydar Drive, éditeur du logiciel de réservation, qui n''est pas partie au contrat de transport.',
      v_operator)];
  return jsonb_build_object(
    'subject', left(private.fr_typo(format('Votre réservation n° %s auprès de %s', r.number, v_operator)), 200),
    'body', private.fr_typo(array_to_string(v_parts, E'\n\n')));
end;
$$;

create or replace function public.svc_booking_receipt(p_ride uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  o public.organizations;
  s public.booking_sites;
  v_to text;
  v_reply text;
  v_mail jsonb;
begin
  select * into r from public.rides where id = p_ride;
  -- Réservation du mini-site, tout juste enregistrée
  if not found or r.source <> 'booking_site' or r.created_at < now() - interval '1 hour' then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  v_to := lower(btrim(coalesce(r.customer_email, '')));
  if not private.email_address_ok(v_to) then
    return jsonb_build_object('ok', false, 'code', 'NO_EMAIL');
  end if;
  if exists (select 1 from public.email_outbox e where e.kind = 'booking_receipt' and e.ride_id = r.id) then
    return jsonb_build_object('ok', true, 'code', 'ALREADY_QUEUED');
  end if;
  if (select count(*) from public.email_outbox e
       where e.kind = 'booking_receipt' and lower(e.to_email) = v_to and e.created_at > now() - interval '24 hours') >= 3 then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED');
  end if;
  select * into o from public.organizations x where x.id = r.organization_id;
  select * into s from public.booking_sites x where x.organization_id = r.organization_id;
  v_reply := lower(btrim(coalesce(s.email, '')));
  v_mail := private.booking_receipt_email(r, o, s);
  insert into public.email_outbox (kind, organization_id, ride_id, to_email, reply_to, subject, body_text)
  values ('booking_receipt', r.organization_id, r.id, v_to,
    case when private.email_address_ok(v_reply) then v_reply end, v_mail ->> 'subject', v_mail ->> 'body')
  on conflict (ride_id) where kind = 'booking_receipt' do nothing;
  return jsonb_build_object('ok', true, 'code', 'QUEUED');
end;
$$;

-- Courses dont les coordonnées du client restent à effacer : parcours par date sans relire les courses déjà traitées
create index if not exists rides_customer_contacts_idx on public.rides (pickup_at)
  where customer_phone <> 'effacé' or customer_email is not null or comment is not null;

-- =============================================================================
-- Droits d'exécution (deny-by-default) — fonctions redéfinies : droits conservés
-- =============================================================================
-- Textes des e-mails : appelés seulement par les fonctions security definer ci-dessus
revoke execute on function
  private.platform_ban_email(text, text, boolean, text),
  private.booking_receipt_email(public.rides, public.organizations, public.booking_sites)
from public, anon, authenticated, service_role;

-- Super admin et web : service role seul (auteur revérifié dans la fonction pour le super admin)
revoke all on function
  public.svc_platform_whatsapp_refusal(uuid, uuid, boolean, text),
  public.svc_booking_receipt(uuid)
from public, anon, authenticated;
grant execute on function
  public.svc_platform_whatsapp_refusal(uuid, uuid, boolean, text),
  public.svc_booking_receipt(uuid)
to service_role;
