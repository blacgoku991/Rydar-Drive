-- =============================================================================
-- Rydar Drive — Suppression du compte chauffeur : corrections de la revue « stores ».
-- 20260924003500 est publiée : svc_delete_driver_account est redéfinie ici (dernière définition : 003500).
--
--  * identité retirée PARTOUT où elle était recopiée : règlements (libellé), journal des courses (message et
--    données : ses courses, offres, attributions, alertes, « non sollicités », événements dont il est l'acteur),
--    alertes (message, nom, position), signalement de fraude (libellé, motif conservé), notifications envoyées aux
--    autres chauffeurs pour ses signalements, journal d'audit (valeurs, adresse IP et navigateur) ; fiche
--    « Chauffeur supprimé (#N) » ;
--  * homonymes épargnés : le prénom seul n'est remplacé que dans les événements qui le concernent (acteur, fiche,
--    règlement, alerte ou offre à lui) ; ailleurs (événements d'un autre chauffeur sur une course partagée,
--    commentaire et motif d'annulation de la course, données de la centrale), seulement « Prénom Nom », « Prénom
--    Nom (#N) » ou « Prénom (#N) » ; « non sollicités » : son élément et son extrait du message seulement ;
--  * bannissement : empreintes conservées 3 ans, indices en clair effacés (initiale, domaine, chiffres) ;
--  * véhicule créé à l'inscription par lien : supprimé s'il n'a servi à aucune course, sinon plaque, marque,
--    modèle et couleur anonymisés (+ journal d'audit du véhicule caviardé) ;
--  * fiche détachée du compte de connexion (user_id = null) : la suppression du compte Auth (sauf membre actif ou
--    invité d'une centrale non archivée, ou super admin : seul le profil chauffeur est supprimé ; un ancien membre
--    désactivé perd son compte) et la purge du dossier de stockage
--    `{organisation}/{chauffeur}/` passent par une FILE (private.account_deletions) : la route web la traite
--    aussitôt, le worker reprend les échecs (10 essais), le super admin peut relancer (/admin/suppressions) ;
--  * membre de centrale : ses sessions de gestion ne sont plus coupées (GUC rydar.keep_sessions lu par
--    private.revoke_sessions_on_access_change) ;
--  * garde-fou : une fiche supprimée n'est plus modifiable (42501 DRIVER_DELETED), sauf effacements du système
--    (purge des bannissements, rattrapage) : ni réactivée, invitée ou suspendue, ni validée, ni rattachée à un compte
--    ou à un véhicule, ni nouvelles coordonnées ou nouveaux documents, ni niveau de confiance, motif de suspension,
--    bannissement (ban_driver) ou levée par la centrale (lift_driver_ban) ; approve / reject_driver_application la
--    refusent ; svc_platform_ban / svc_platform_unban traitent les empreintes du signalement sans toucher la fiche ;
--  * suppression demandée sans l'application (e-mail) : svc_admin_delete_driver (super admin, audit) ;
--  * compte suspendu, banni ou centrale suspendue (session révoquée, compte Auth banni) : vérification du mot de
--    passe côté serveur (svc_driver_password_check) pour que le chauffeur puisse quand même supprimer son compte ;
--  * rattrapage des fiches déjà supprimées par 003500 (file, user_id, candidature, métadonnées du compte Auth,
--    journal d'audit, traces : nom retrouvé dans les libellés, le compte et le journal des courses).
-- Fonctions private sans security definer (CLAUDE.md) : appelées par les RPC svc_* (definer), par le worker
-- (propriétaire) ou par la migration ; seul le déclencheur des sessions (auth.sessions) reste definer.
-- =============================================================================

-- Journal d'audit d'une fiche (caviardage à la suppression, purges) : sans parcourir tout le journal
create index if not exists audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);

-- ----------------------------------------------------------------- file de suppression
create table private.account_deletions (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null unique,
  organization_id uuid not null,
  driver_number integer not null,
  -- Compte de connexion à supprimer (null : fiche créée sans compte, ou compte déjà supprimé)
  user_id uuid,
  -- Compte conservé : il sert aussi à gérer une centrale ou la plateforme (seul le profil chauffeur est supprimé)
  keep_auth boolean not null default false,
  -- Dossier des justificatifs dans le bucket privé driver-documents : « {organisation}/{chauffeur}/ »
  storage_prefix text not null check (storage_prefix ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/$'),
  source text not null default 'app' check (source in ('app', 'admin', 'repair')),
  requested_by uuid,
  requested_at timestamptz not null default now(),
  storage_done_at timestamptz,
  auth_done_at timestamptz,
  done_at timestamptz,
  attempts integer not null default 0,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now()
);
comment on table private.account_deletions is
  'Suppressions de compte chauffeur à terminer : purge du dossier de stockage et suppression du compte de connexion (route web, worker, super admin).';
create index account_deletions_todo_idx on private.account_deletions (next_attempt_at) where done_at is null;
create index account_deletions_user_idx on private.account_deletions (user_id) where user_id is not null;

alter table private.account_deletions enable row level security;
revoke all on private.account_deletions from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------- outils de texte
-- Échappe les caractères spéciaux d'une expression régulière (ARE).
create or replace function private.regex_escape(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(p_text, '([.^$*+?()[\]{}|\\-])', '\\\1', 'g');
$$;

-- Motif des formes du nom d'un chauffeur dans les textes :
--  * complet (événements qui le concernent, ses alertes, ses règlements, les motifs le visant) : « Prénom Nom (#N) »,
--    « Prénom (#N) », « Prénom Nom », « Prénom N. » et « Prénom » seul ;
--  * strict (événements d'un autre chauffeur, commentaire et motif d'annulation de la course, données de la
--    centrale) : « Prénom Nom (#N) », « Prénom (#N) » et « Prénom Nom » seulement — ni le prénom seul ni
--    « Prénom N. », qu'un homonyme ou un client peut porter (« Mme Thomas », « Mohamed B. »).
-- Limites de mot explicites (lettres accentuées, chiffres, trait d'union) : « Karim » ne touche ni « Karima » ni
-- « Jean-Karim ». Un autre chauffeur est cité avec SON numéro (« Prénom Nom (#2) ») : une forme sans numéro n'est
-- jamais retenue quand elle ouvre une telle mention (suivie de mots de nom — majuscule initiale ou particule — puis
-- d'un numéro) : l'homonyme complet « Mohamed Dupont (#2) » est épargné, même dans un motif saisi sur l'un de SES
-- événements, où « Mohamed ne répond pas » reste remplacé. null si le prénom est inconnu.
create or replace function private.driver_name_pattern(p_first text, p_last text, p_number integer, p_strict boolean)
returns text
language sql
immutable
set search_path = ''
as $$
  with n as (
    select nullif(btrim(coalesce(p_first, '')), '') as first, nullif(btrim(coalesce(p_last, '')), '') as last,
           coalesce(p_strict, false) as strict,
           '(?!(?:\s+(?:[A-ZÀ-ÖØ-ÞŒŠŽŸ][^[:space:]()]*|de|du|des|la|le|el|al|ben|bin|ibn|van|von|da|di|dos|das)){0,4}\s*\(#[0-9])'::text as guard
  ),
  forms as (
    select distinct x.form, x.numbered, n.guard
    from n
    cross join lateral (values
      (n.first || ' ' || n.last || ' (#' || p_number || ')', true),
      (n.first || ' (#' || p_number || ')', true),
      (n.first || ' ' || n.last, false),
      (case when not n.strict then n.first || ' ' || left(n.last, 1) || '.' end, false),
      (case when not n.strict then n.first end, false)
    ) as x(form, numbered)
    where x.form is not null
  )
  select case when count(*) = 0 then null
    else '(?<![A-Za-z0-9_À-ÖØ-öø-ÿĀ-ž-])(?:'
         || string_agg(private.regex_escape(f.form) || case when f.numbered then '' else f.guard end,
                       '|' order by char_length(f.form) desc, f.form)
         || ')(?![A-Za-z0-9_À-ÖØ-öø-ÿĀ-ž-])'
  end
  from forms f;
$$;

-- Remplacement dans toutes les chaînes d'un document jsonb (objets et tableaux imbriqués).
create or replace function private.jsonb_scrub(p_doc jsonb, p_pattern text, p_alias text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_doc is null or p_pattern is null then
    return p_doc;
  end if;
  case jsonb_typeof(p_doc)
    when 'string' then
      return to_jsonb(regexp_replace(p_doc #>> '{}', p_pattern, p_alias, 'g'));
    when 'array' then
      return coalesce((select jsonb_agg(private.jsonb_scrub(t.e, p_pattern, p_alias) order by t.i)
                       from jsonb_array_elements(p_doc) with ordinality as t(e, i)), '[]'::jsonb);
    when 'object' then
      return coalesce((select jsonb_object_agg(t.k, private.jsonb_scrub(t.v, p_pattern, p_alias))
                       from jsonb_each(p_doc) as t(k, v)), '{}'::jsonb);
    else
      return p_doc;
  end case;
end;
$$;

-- « Non sollicités » (dispatch.excluded) : nom du chauffeur remplacé dans SON élément seulement.
create or replace function private.scrub_excluded(p_data jsonb, p_driver uuid, p_alias text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_data is null or jsonb_typeof(p_data -> 'excluded') is distinct from 'array' then
    return p_data;
  end if;
  return jsonb_set(p_data, '{excluded}', (
    select coalesce(jsonb_agg(case when t.e ->> 'driver_id' = p_driver::text
                                   then t.e || jsonb_build_object('name', p_alias) else t.e end order by t.i), '[]'::jsonb)
    from jsonb_array_elements(p_data -> 'excluded') with ordinality as t(e, i)));
end;
$$;

-- Message des « non sollicités » (private.explain_no_driver) : « N chauffeurs en ligne … — A (320 m) : motif ·
-- B (…) : motif · C … · et 2 autres ». Les 3 premiers éléments de data.excluded y sont cités, dans l'ordre, chacun
-- par son nom (« Prénom N. »). Seul l'extrait du chauffeur est réécrit : un homonyme de même initiale, cité juste à
-- côté, garde son nom. À appeler avec les données AVANT scrub_excluded (nom encore présent dans son élément).
create or replace function private.scrub_excluded_message(p_message text, p_data jsonb, p_driver uuid, p_alias text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_pos integer;
  v_idx bigint;
  v_name text;
  v_parts text[];
begin
  if p_message is null or p_data is null or jsonb_typeof(p_data -> 'excluded') is distinct from 'array' then
    return p_message;
  end if;
  select t.i, t.e ->> 'name' into v_idx, v_name
    from jsonb_array_elements(p_data -> 'excluded') with ordinality as t(e, i)
   where t.e ->> 'driver_id' = p_driver::text
   order by t.i
   limit 1;
  -- Absent, ou au-delà des 3 cités (seulement compté dans « et N autres »)
  if v_idx is null or v_idx > 3 or coalesce(v_name, '') = '' then
    return p_message;
  end if;
  v_pos := strpos(p_message, ' — ');
  if v_pos = 0 then
    return p_message;
  end if;
  v_parts := string_to_array(substr(p_message, v_pos + 3), ' · ');
  if coalesce(cardinality(v_parts), 0) < v_idx or left(v_parts[v_idx], char_length(v_name)) <> v_name then
    return p_message;
  end if;
  v_parts[v_idx] := p_alias || substr(v_parts[v_idx], char_length(v_name) + 1);
  return left(p_message, v_pos + 2) || array_to_string(v_parts, ' · ');
end;
$$;

-- Compte de connexion à conserver lors de la suppression du profil chauffeur : il sert aussi à gérer une centrale
-- (adhésion active ou invitée, centrale non archivée) ou la plateforme (super admin). Un ancien membre désactivé n'a
-- plus aucun accès : son compte est supprimé comme celui d'un chauffeur.
create or replace function private.keeps_login_account(p_user uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_user is not null and (
    exists (select 1
              from public.organization_users m
              join public.organizations o on o.id = m.organization_id
             where m.user_id = p_user and m.status <> 'disabled' and o.status <> 'archived')
    or exists (select 1 from public.users u where u.id = p_user and u.is_super_admin));
$$;

-- Journal d'audit d'une fiche supprimée (et de son véhicule d'inscription) : valeurs retirées, l'action et sa date
-- restent. Adresse IP et navigateur effacés quand ils sont ceux du chauffeur : acteur non identifié (inscription par
-- lien, lib/join.ts) ou son propre compte ; ceux d'un membre de la centrale ou du super admin qui a agi sur la fiche
-- restent (sécurité de LEUR compte). Compte de connexion supprimé : IP et navigateur retirés de toutes ses actions.
create or replace function private.redact_driver_audit(p_driver uuid, p_user uuid, p_keep boolean, p_vehicle uuid default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.audit_logs a
     set metadata = jsonb_build_object('redacted', true),
         actor_label = null,
         ip = case when a.actor_user_id is null or a.actor_user_id = p_user then null else a.ip end,
         user_agent = case when a.actor_user_id is null or a.actor_user_id = p_user then null else a.user_agent end
   where (a.entity_type = 'drivers' and a.entity_id = p_driver::text)
      or (p_vehicle is not null and a.entity_type = 'vehicles' and a.entity_id = p_vehicle::text);
  if p_user is not null and not coalesce(p_keep, false) then
    update public.audit_logs a
       set ip = null, user_agent = null
     where a.actor_user_id = p_user and (a.ip is not null or a.user_agent is not null);
  end if;
end;
$$;

-- ----------------------------------------------------------------- traces du chauffeur
-- Retire le nom (formes de p_first / p_last) et les données d'identification du chauffeur de tout ce qui les a
-- recopiés. Idempotent ; sans prénom connu (rattrapage), seules les parties structurelles sont traitées.
create or replace function private.scrub_driver_traces(
  p_driver uuid,
  p_org uuid,
  p_since timestamptz,
  p_first text,
  p_last text,
  p_number integer,
  p_alias text
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_id text := p_driver::text;
  v_full text := private.driver_name_pattern(p_first, p_last, p_number, false);
  v_strict text := private.driver_name_pattern(p_first, p_last, p_number, true);
  v_reports text[];
  v_settlements text[];
  v_alerts text[];
  v_offers text[];
begin
  -- Ses signalements (flotte) : événements « signalé / retiré » supprimés, comme les notifications qui en
  -- recopiaient le texte et son nom chez les autres chauffeurs
  select coalesce(array_agg(distinct e.data ->> 'message_id') filter (where e.data ? 'message_id'), '{}')
    into v_reports
    from public.ride_events e
   where e.organization_id = p_org and e.type = 'fleet.report' and e.data ->> 'author_driver_id' = v_id;
  delete from public.ride_events e
   where e.organization_id = p_org
     and e.type in ('fleet.report', 'fleet.report_cleared')
     and (e.data ->> 'author_driver_id' = v_id or e.data ->> 'message_id' = any (v_reports));
  if cardinality(v_reports) > 0 then
    delete from public.notifications n
     where n.organization_id = p_org and n.type = 'fleet_report' and n.data ->> 'message_id' = any (v_reports);
  end if;

  -- Journal des courses : ses courses, offres, attributions, règlements, alertes ; les événements dont il est
  -- l'acteur ; ceux qui citent son identifiant (driver_id, previous_driver_id, excluded…). Chaque événement a un
  -- SUJET : la fiche citée (driver_id ; à défaut previous_driver_id, pour un retrait), sinon le chauffeur du
  -- règlement, de l'alerte ou de l'offre cités, sinon l'acteur. Sujet = lui : forme complète du nom (prénom seul
  -- compris), nom et position retirés des données ; autre sujet ou sujet inconnu (course partagée, homonyme) :
  -- forme stricte ; « non sollicités » : son élément et son extrait du message seulement.
  select coalesce(array_agg(s.id::text), '{}') into v_settlements from public.ride_settlements s where s.driver_id = p_driver;
  select coalesce(array_agg(a.id::text), '{}') into v_alerts from public.ride_alerts a where a.driver_id = p_driver;
  select coalesce(array_agg(o.id::text), '{}') into v_offers from public.ride_offers o where o.driver_id = p_driver;
  with his_rides as (
    select o.ride_id from public.ride_offers o where o.driver_id = p_driver
    union
    select a.ride_id from public.ride_assignments a where a.driver_id = p_driver
    union
    select r.id from public.rides r where r.driver_id = p_driver and r.organization_id = p_org
    union
    select s.ride_id from public.ride_settlements s where s.driver_id = p_driver
    union
    select x.ride_id from public.ride_alerts x where x.driver_id = p_driver
  ),
  targets as (
    select e.id,
           case
             when e.type = 'dispatch.excluded' then 'excluded'
             when e.data ? 'driver_id' then case when e.data ->> 'driver_id' = v_id then 'own' else 'other' end
             when e.data ? 'previous_driver_id' then case when e.data ->> 'previous_driver_id' = v_id then 'own' else 'other' end
             when e.data ? 'settlement_id' then case when e.data ->> 'settlement_id' = any (v_settlements) then 'own' else 'other' end
             when e.data ? 'alert_id' then case when e.data ->> 'alert_id' = any (v_alerts) then 'own' else 'other' end
             when e.data ? 'offer_id' then case when e.data ->> 'offer_id' = any (v_offers) then 'own' else 'other' end
             when e.actor_type = 'driver' and e.actor_id = p_driver then 'own'
             else 'other'
           end as mode
    from public.ride_events e
    where e.organization_id = p_org
      and e.created_at >= p_since
      and (e.actor_id = p_driver
           or strpos(e.data::text, v_id) > 0
           or e.ride_id in (select h.ride_id from his_rides h))
  )
  update public.ride_events e
     set message = case t.mode
           when 'excluded' then private.scrub_excluded_message(e.message, e.data, p_driver, p_alias)
           when 'own' then coalesce(regexp_replace(e.message, v_full, p_alias, 'g'), e.message)
           else coalesce(regexp_replace(e.message, v_strict, p_alias, 'g'), e.message)
         end,
         data = case t.mode
           when 'excluded' then private.scrub_excluded(e.data, p_driver, p_alias)
           when 'own' then private.jsonb_scrub(
                  e.data - array['name', 'driver_name', 'author_name']
                         - case when e.type like 'alert.%' then array['lat', 'lng'] else array[]::text[] end,
                  v_full, p_alias)
           else private.jsonb_scrub(e.data, v_strict, p_alias)
         end
    from targets t
   where e.id = t.id;

  -- Alertes de course : message, nom et position du chauffeur
  update public.ride_alerts
     set message = left(coalesce(regexp_replace(message, v_full, p_alias, 'g'), message), 300),
         data = private.jsonb_scrub(data - array['driver_name', 'lat', 'lng'], v_full, p_alias)
   where organization_id = p_org and driver_id = p_driver;

  -- Règlements (conservés 10 ans) et signalement de fraude (motif conservé) : libellé anonyme
  update public.ride_settlements set driver_label = p_alias
   where driver_id = p_driver and driver_label is distinct from p_alias;
  update public.fraud_reports set driver_label = p_alias
   where driver_id = p_driver and driver_label is distinct from p_alias;

  -- Textes écrits à son sujet (sa note de paiement, notes des règlements, motifs de signalement et de
  -- bannissement) : son nom remplacé, le reste du texte conservé
  if v_full is not null then
    update public.ride_settlements
       set declared_note = left(regexp_replace(declared_note, v_full, p_alias, 'g'), 300),
           note = left(regexp_replace(note, v_full, p_alias, 'g'), 500)
     where driver_id = p_driver and (declared_note ~ v_full or note ~ v_full);
    update public.fraud_reports
       set reason = left(regexp_replace(reason, v_full, p_alias, 'g'), 500),
           review_note = left(regexp_replace(review_note, v_full, p_alias, 'g'), 500)
     where driver_id = p_driver and (reason ~ v_full or review_note ~ v_full);
    update public.banned_identities
       set reason = left(regexp_replace(reason, v_full, p_alias, 'g'), 500),
           lift_reason = left(regexp_replace(lift_reason, v_full, p_alias, 'g'), 500)
     where driver_id = p_driver and (reason ~ v_full or lift_reason ~ v_full);
    -- Motif de bannissement resté sur la fiche (conservé contre la fraude, sans son nom)
    update public.drivers
       set ban_reason = left(regexp_replace(ban_reason, v_full, p_alias, 'g'), 500)
     where id = p_driver and ban_reason ~ v_full;
  end if;
  -- Commentaire et motif d'annulation de ses courses : données de la centrale, qui décrivent souvent le client
  -- (« Client : Thomas Haddad », « Mme Thomas ») : forme stricte seulement, jamais le prénom seul
  if v_strict is not null then
    update public.rides
       set comment = left(regexp_replace(comment, v_strict, p_alias, 'g'), 2000),
           cancel_reason = regexp_replace(cancel_reason, v_strict, p_alias, 'g')
     where organization_id = p_org and driver_id = p_driver and (comment ~ v_strict or cancel_reason ~ v_strict);
  end if;
  -- Journal d'audit des signalements de fraude (libellé recopié, notes du super admin) : son nom remplacé
  update public.audit_logs a
     set metadata = private.jsonb_scrub(
           a.metadata || case when a.metadata ? 'driver' then jsonb_build_object('driver', p_alias) else '{}'::jsonb end,
           v_full, p_alias)
   where a.entity_type = 'fraud_reports'
     and (a.metadata ? 'driver' or (v_full is not null and a.metadata::text ~ v_full))
     and a.entity_id in (select f.id::text from public.fraud_reports f where f.driver_id = p_driver);

  -- Bannissement : les empreintes (hachages) restent 3 ans pour reconnaître une réinscription ; les indices en clair
  -- (initiale et domaine de l'e-mail, derniers chiffres du téléphone, lettres de la plaque) sont effacés, dans les
  -- identités, le signalement de fraude et le journal d'audit des levées
  update public.banned_identities set hint = null where driver_id = p_driver and hint is not null;
  update public.fraud_reports f
     set identities = (select coalesce(jsonb_agg(t.x - 'hint' order by t.i), '[]'::jsonb)
                         from jsonb_array_elements(f.identities) with ordinality as t(x, i))
   where f.driver_id = p_driver
     and jsonb_typeof(f.identities) = 'array'
     and exists (select 1 from jsonb_array_elements(f.identities) x where x ? 'hint');
  update public.audit_logs a
     set metadata = private.jsonb_scrub(a.metadata - 'hint', v_full, p_alias)
   where a.entity_type = 'banned_identities'
     and (a.metadata ? 'hint' or (v_full is not null and a.metadata::text ~ v_full))
     and a.entity_id in (select b.id::text from public.banned_identities b where b.driver_id = p_driver);
end;
$$;

-- ----------------------------------------------------------------- sessions : membre de centrale épargné
-- Dernière définition : 20260924001300. Ajout : rydar.keep_sessions (GUC local, posé par la suppression du
-- profil chauffeur d'un membre de centrale ou d'un super admin) → ses sessions de gestion ne sont pas coupées.
create or replace function private.revoke_sessions_on_access_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keep text := nullif(current_setting('rydar.keep_sessions', true), '');
begin
  if tg_table_name = 'drivers' then
    if tg_op = 'DELETE' then
      perform private.revoke_user_sessions(old.user_id);
    else
      if new.user_id is not null and old.status = 'active' and new.status <> 'active'
         and new.user_id::text is distinct from v_keep then
        perform private.revoke_user_sessions(new.user_id);
      end if;
      if old.user_id is not null and new.user_id is distinct from old.user_id
         and old.user_id::text is distinct from v_keep then
        perform private.revoke_user_sessions(old.user_id);
      end if;
    end if;

  elsif tg_table_name = 'organization_users' then
    if tg_op = 'DELETE' or (old.status = 'active' and new.status <> 'active') then
      perform private.revoke_user_sessions(old.user_id);
    end if;

  elsif tg_table_name = 'organizations' then
    if old.status = 'active' and new.status <> 'active' then
      -- Chauffeurs de l'organisation
      perform private.revoke_user_sessions(d.user_id)
        from public.drivers d
       where d.organization_id = new.id and d.user_id is not null;
      -- Membres qui n'ont pas d'autre organisation active (ni rôle Super Admin)
      perform private.revoke_user_sessions(m.user_id)
        from public.organization_users m
       where m.organization_id = new.id
         and not exists (
           select 1 from public.organization_users m2
           join public.organizations o2 on o2.id = m2.organization_id
           where m2.user_id = m.user_id and m2.organization_id <> new.id
             and m2.status = 'active' and o2.status = 'active')
         and not exists (select 1 from public.users u where u.id = m.user_id and u.is_super_admin);
    end if;
  end if;
  return null;
end;
$$;

-- ----------------------------------------------------------------- résultat commun
create or replace function private.account_deletion_json(q private.account_deletions)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'deletion_id', q.id,
    'driver_id', q.driver_id,
    'organization_id', q.organization_id,
    'number', q.driver_number,
    'user_id', q.user_id,
    'keep_auth', q.keep_auth,
    'storage_prefix', q.storage_prefix,
    'source', q.source,
    'storage_done', q.storage_done_at is not null,
    'auth_done', q.auth_done_at is not null,
    'done', q.done_at is not null,
    'pending', q.done_at is null,
    'abandoned', q.done_at is null and q.attempts >= 10,
    'attempts', q.attempts,
    'last_error', q.last_error,
    'requested_at', q.requested_at,
    'done_at', q.done_at);
$$;

-- ----------------------------------------------------------------- suppression (cœur)
-- p_source : 'app' (le chauffeur, route /api/driver/delete-account) | 'admin' (demande reçue par e-mail, traitée
-- par le super admin p_actor). La route (ou le worker) termine ensuite la file : stockage puis compte Auth.
create or replace function private.delete_driver_account(p_driver_id uuid, p_source text, p_actor uuid default null)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  d public.drivers;
  q private.account_deletions;
  v_rides integer;
  v_alias text;
  v_key text;
  v_keep boolean;
  v_files integer;
  v_vehicle uuid;
  v_vehicle_action text;
  v_admin boolean := p_source = 'admin';
begin
  if p_source is null or p_source not in ('app', 'admin') then
    raise exception 'INVALID_SOURCE' using errcode = '22023';
  end if;
  select * into d from public.drivers where id = p_driver_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_DRIVER', 'message', 'Aucun compte chauffeur associé.');
  end if;

  -- Déjà supprimé (appel rejoué) : état de la file
  if d.deleted_at is not null then
    select * into q from private.account_deletions where driver_id = d.id;
    if q.id is not null then
      return jsonb_build_object('ok', true, 'code', 'DELETED', 'already_deleted', true) || private.account_deletion_json(q);
    end if;
    return jsonb_build_object('ok', true, 'code', 'DELETED', 'already_deleted', true,
      'driver_id', d.id, 'organization_id', d.organization_id, 'number', d.number,
      'storage_prefix', format('%s/%s/', d.organization_id, d.id), 'keep_auth', false,
      'deletion_id', null, 'done', true, 'pending', false);
  end if;

  select count(*) into v_rides from public.rides r
  where r.driver_id = d.id
    and r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS');
  if v_rides > 0 or d.current_ride_id is not null then
    return jsonb_build_object('ok', false, 'code', 'RIDES_ASSIGNED', 'count', greatest(v_rides, 1),
      'message', case
        when v_admin and v_rides > 1
        then format('%s courses attribuées à ce chauffeur : la centrale doit d''abord les terminer ou les réattribuer.', v_rides)
        when v_admin then 'Une course attribuée à ce chauffeur : la centrale doit d''abord la terminer ou la réattribuer.'
        when v_rides > 1
        then format('Vous avez %s courses attribuées : terminez-les ou demandez à votre centrale de les réattribuer, puis supprimez votre compte.', v_rides)
        else 'Vous avez une course attribuée : terminez-la ou demandez à votre centrale de la réattribuer, puis supprimez votre compte.' end);
  end if;

  if v_admin then
    perform private.set_actor('super_admin', p_actor);
  else
    perform private.set_actor('driver', d.id);
  end if;
  v_key := 'driver:' || d.id::text;
  v_alias := format('Chauffeur supprimé (#%s)', d.number);
  -- Compte conservé s'il sert aussi à gérer une centrale ou la plateforme
  v_keep := private.keeps_login_account(d.user_id);

  -- Offres en attente closes (le chauffeur ne peut plus répondre)
  update public.ride_offers
     set status = 'closed', closed_reason = 'driver_deleted', responded_at = now()
   where driver_id = d.id and status = 'pending';

  -- Nom et identification retirés de tout ce qui les a recopiés (avant l'anonymisation : noms encore connus)
  perform private.scrub_driver_traces(d.id, d.organization_id, d.created_at, d.first_name, d.last_name, d.number, v_alias);

  -- Données personnelles supprimées (les fichiers des justificatifs : dossier purgé via la file)
  select count(*) into v_files from public.driver_documents x where x.driver_id = d.id;
  delete from public.driver_documents where driver_id = d.id;
  delete from public.push_tokens where driver_id = d.id;
  delete from public.driver_devices where driver_id = d.id;
  delete from public.driver_locations where driver_id = d.id;
  delete from public.driver_location_history where driver_id = d.id;
  delete from public.notifications where driver_id = d.id;
  delete from public.chat_report_votes where voter_key = v_key;
  delete from public.chat_reads where reader_key = v_key or thread_key = v_key;
  delete from public.chat_messages where driver_id = d.id or author_driver_id = d.id;

  -- Véhicule personnel (inscription par lien), utilisé par aucun autre chauffeur
  if d.vehicle_id is not null and d.joined_via = 'join_link'
     and not exists (select 1 from public.drivers x where x.vehicle_id = d.vehicle_id and x.id <> d.id) then
    v_vehicle := d.vehicle_id;
  end if;

  -- Fiche anonymisée, détachée du compte de connexion ; conservée pour les courses et règlements passés.
  -- Membre de centrale : ses sessions de gestion ne sont pas coupées (drivers_revoke_sessions).
  if v_keep then
    perform set_config('rydar.keep_sessions', d.user_id::text, true);
  end if;
  update public.drivers
     set first_name = 'Chauffeur',
         last_name = 'supprimé',
         phone = '',
         email = null,
         photo_url = null,
         vtc_card_number = null,
         notes = null,
         application_status = null,
         application_message = null,
         application_note = null,
         suspended_reason = case when v_admin then 'Compte supprimé à la demande du chauffeur' else 'Compte supprimé par le chauffeur' end,
         -- (motif de bannissement conservé contre la fraude, son nom déjà retiré par scrub_driver_traces)
         status = 'inactive',
         presence = 'offline',
         online_since = null,
         last_seen_at = null,
         current_ride_id = null,
         vehicle_id = null,
         user_id = null,
         deleted_at = now()
   where id = d.id;
  perform set_config('rydar.keep_sessions', '', true);

  if v_vehicle is not null then
    if exists (select 1 from public.rides r where r.vehicle_id = v_vehicle)
       or exists (select 1 from public.ride_assignments a where a.vehicle_id = v_vehicle) then
      update public.vehicles
         set plate = 'SUPPR-' || upper(left(replace(v_vehicle::text, '-', ''), 10)),
             brand = null,
             model = 'Véhicule supprimé',
             color = null,
             year = null,
             is_active = false
       where id = v_vehicle;
      v_vehicle_action := 'anonymized';
    else
      delete from public.vehicles where id = v_vehicle;
      v_vehicle_action := 'deleted';
    end if;
  end if;

  -- Compte de connexion (supprimé par la file) : nom et téléphone effacés dès maintenant
  if d.user_id is not null and not v_keep then
    update public.users set full_name = null, phone = null, avatar_url = null where id = d.user_id;
    begin
      update auth.users
         set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) - array['full_name', 'name', 'phone', 'avatar_url']
       where id = d.user_id;
    exception when insufficient_privilege or undefined_table or undefined_column then
      raise warning 'delete_driver_account: métadonnées Auth non effacées (privilèges)';
    end;
  end if;

  insert into private.account_deletions (driver_id, organization_id, driver_number, user_id, keep_auth, storage_prefix,
    source, requested_by, auth_done_at, next_attempt_at)
  values (d.id, d.organization_id, d.number, d.user_id, v_keep, format('%s/%s/', d.organization_id, d.id),
    p_source, case when v_admin then p_actor end,
    case when d.user_id is null or v_keep then now() end,
    -- traitée aussitôt par l'appelant ; le worker ne la reprend qu'en cas d'échec
    now() + interval '2 minutes')
  returning * into q;

  -- Journal d'audit du chauffeur et de son véhicule d'inscription : valeurs personnelles, adresse IP et navigateur
  -- retirés (l'action reste tracée)
  perform private.redact_driver_audit(d.id, d.user_id, v_keep, v_vehicle);

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (d.organization_id, case when v_admin then 'super_admin' else 'driver' end::public.actor_type,
    case when v_admin then p_actor end, 'driver.deleted', 'drivers', d.id::text, 'warning',
    jsonb_build_object('number', d.number, 'source', p_source, 'documents', v_files, 'keep_auth', v_keep,
      'vehicle', v_vehicle_action, 'deletion_id', q.id));

  perform private.log_event(d.organization_id, null, 'driver.deleted',
    case when v_admin then format('Compte du chauffeur #%s supprimé à sa demande (traité par Rydar Drive)', d.number)
         else format('Le chauffeur #%s a supprimé son compte', d.number) end,
    'system', 'warning', jsonb_build_object('driver_id', d.id, 'source', p_source),
    case when v_admin then 'super_admin' else 'driver' end::public.actor_type,
    case when v_admin then p_actor else d.id end);

  return jsonb_build_object('ok', true, 'code', 'DELETED', 'already_deleted', false, 'documents', v_files,
      'vehicle', v_vehicle_action)
    || private.account_deletion_json(q);
end;
$$;

-- Application : le chauffeur connecté (jeton ou e-mail + mot de passe vérifiés par la route).
create or replace function public.svc_delete_driver_account(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_driver uuid;
  q private.account_deletions;
begin
  if p_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_DRIVER', 'message', 'Aucun compte chauffeur associé.');
  end if;
  select d.id into v_driver from public.drivers d where d.user_id = p_user_id;
  if v_driver is null then
    -- Appel rejoué après la suppression (fiche déjà détachée du compte) : état de la file
    select * into q from private.account_deletions x where x.user_id = p_user_id order by x.requested_at desc limit 1;
    if found then
      return jsonb_build_object('ok', true, 'code', 'DELETED', 'already_deleted', true) || private.account_deletion_json(q);
    end if;
    return jsonb_build_object('ok', false, 'code', 'NOT_DRIVER', 'message', 'Aucun compte chauffeur associé.');
  end if;
  return private.delete_driver_account(v_driver, 'app', null);
end;
$$;

-- Super admin : demande reçue sans l'application (e-mail au contact « données personnelles »).
create or replace function public.svc_admin_delete_driver(p_driver_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_actor(p_actor);
  return private.delete_driver_account(p_driver_id, 'admin', p_actor);
end;
$$;

-- ----------------------------------------------------------------- avancement de la file
-- Étapes terminées (stockage, compte Auth) ou erreur ; nouvel essai espacé (5 min, 10, 20… 6 h au plus), abandon
-- après 10 essais (journal d'audit critique ; le super admin peut relancer).
create or replace function private.complete_account_deletion(p_id uuid, p_storage_done boolean, p_auth_done boolean, p_error text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  q private.account_deletions;
  v_error text := left(nullif(btrim(coalesce(p_error, '')), ''), 500);
begin
  update private.account_deletions x
     set storage_done_at = case when coalesce(p_storage_done, false) then coalesce(x.storage_done_at, now()) else x.storage_done_at end,
         auth_done_at = case when coalesce(p_auth_done, false) then coalesce(x.auth_done_at, now()) else x.auth_done_at end,
         attempts = x.attempts + 1,
         last_attempt_at = now(),
         last_error = v_error
   where x.id = p_id and x.done_at is null
  returning * into q;
  if not found then
    select * into q from private.account_deletions where id = p_id;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
    end if;
    return jsonb_build_object('ok', true) || private.account_deletion_json(q);
  end if;

  if q.storage_done_at is not null and q.auth_done_at is not null then
    update private.account_deletions set done_at = now(), last_error = null where id = q.id returning * into q;
  else
    update private.account_deletions
       set next_attempt_at = now() + least(interval '6 hours', interval '5 minutes' * power(2, least(q.attempts - 1, 10)))
     where id = q.id
    returning * into q;
    if q.attempts = 10 then
      insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
      values (q.organization_id, 'system', null, 'driver.deletion_failed', 'drivers', q.driver_id::text, 'critical',
        jsonb_build_object('number', q.driver_number, 'attempts', q.attempts, 'error', q.last_error,
          'storage_done', q.storage_done_at is not null, 'auth_done', q.auth_done_at is not null, 'deletion_id', q.id));
    end if;
  end if;
  return jsonb_build_object('ok', true) || private.account_deletion_json(q);
end;
$$;

-- Worker : suppressions à reprendre (verrou « skip locked » + bail de 15 min : un seul traitement à la fois).
create or replace function private.claim_account_deletions(p_limit integer default 10)
returns setof private.account_deletions
language plpgsql
set search_path = ''
as $$
begin
  return query
  update private.account_deletions x
     set next_attempt_at = now() + interval '15 minutes'
   where x.id in (
     select y.id from private.account_deletions y
      where y.done_at is null and y.attempts < 10 and y.next_attempt_at <= now()
      order by y.next_attempt_at
      limit greatest(1, least(coalesce(p_limit, 10), 100))
      for update skip locked)
  returning x.*;
end;
$$;

-- Route web / outil super admin : même avancement (service role).
create or replace function public.svc_account_deletion_progress(p_id uuid, p_storage_done boolean, p_auth_done boolean, p_error text default null)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.complete_account_deletion(p_id, p_storage_done, p_auth_done, p_error);
$$;

-- Super admin : « Réessayer » (compteur remis à zéro ; traitée aussitôt par l'appelant, sinon par le worker).
create or replace function public.svc_account_deletion_retry(p_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  q private.account_deletions;
begin
  perform private.assert_platform_actor(p_actor);
  update private.account_deletions
     set attempts = 0, next_attempt_at = now() + interval '2 minutes'
   where id = p_id and done_at is null
  returning * into q;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_PENDING', 'message', 'Cette suppression est déjà terminée ou introuvable.');
  end if;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (q.organization_id, 'super_admin', p_actor, 'driver.deletion_retry', 'drivers', q.driver_id::text, 'info',
    jsonb_build_object('number', q.driver_number, 'deletion_id', q.id, 'last_error', q.last_error));
  return jsonb_build_object('ok', true) || private.account_deletion_json(q);
end;
$$;

-- ----------------------------------------------------------------- super admin : lecture
-- File des suppressions : en cours, abandonnées (10 essais), terminées depuis 90 jours. « Bloquée » : en cours mais
-- sans reprise depuis plus de 30 min après l'échéance (le worker la reprend toutes les 5 min) : le worker ne traite
-- pas la file (API Supabase absente de son environnement ?) ; « Réessayer » la termine depuis le tableau de bord.
create or replace function public.admin_account_deletions(p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
begin
  if not private.is_super_admin() then
    raise exception 'FORBIDDEN: réservé au super admin' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(t.j order by t.rank, t.requested_at desc), '[]'::jsonb) into v_items
  from (
    select case when q.done_at is not null then 2 when q.attempts >= 10 then 0 else 1 end as rank,
           q.requested_at,
           (private.account_deletion_json(q) || jsonb_build_object(
             'status', case when q.done_at is not null then 'done' when q.attempts >= 10 then 'failed' else 'pending' end,
             'stalled', q.done_at is null and q.attempts < 10 and q.next_attempt_at < now() - interval '30 minutes',
             'has_account', q.user_id is not null,
             'next_attempt_at', q.next_attempt_at,
             'organization', (select jsonb_build_object('id', o.id, 'name', o.name) from public.organizations o
                              where o.id = q.organization_id))) - 'user_id' as j
    from private.account_deletions q
    where q.done_at is null or q.done_at > now() - interval '90 days'
    order by 1, q.requested_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  ) t;
  return jsonb_build_object(
    'items', v_items,
    'pending', (select count(*) from private.account_deletions q where q.done_at is null and q.attempts < 10),
    'failed', (select count(*) from private.account_deletions q where q.done_at is null and q.attempts >= 10),
    'stalled', (select count(*) from private.account_deletions q
                 where q.done_at is null and q.attempts < 10 and q.next_attempt_at < now() - interval '30 minutes'));
end;
$$;

-- Recherche d'un chauffeur (toutes centrales) par e-mail (fiche ou compte de connexion) ou téléphone.
create or replace function public.admin_find_drivers(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := left(btrim(coalesce(p_query, '')), 254);
  v_email text;
  v_phone text;
begin
  if not private.is_super_admin() then
    raise exception 'FORBIDDEN: réservé au super admin' using errcode = '42501';
  end if;
  if position('@' in v_q) > 0 then
    v_email := lower(v_q);
  else
    v_phone := private.identity_normalize('phone', v_q);
  end if;
  if v_email is null and v_phone is null then
    return '[]'::jsonb;
  end if;

  return (
    select coalesce(jsonb_agg(t.j order by t.created_at desc), '[]'::jsonb)
    from (
      select d.created_at, jsonb_build_object(
          'id', d.id,
          'number', d.number,
          'first_name', d.first_name,
          'last_name', d.last_name,
          'email', d.email,
          'phone', d.phone,
          'status', d.status,
          'application_status', d.application_status,
          'banned', d.banned_at is not null,
          'joined_via', d.joined_via,
          'created_at', d.created_at,
          'account_email', u.email,
          'has_account', d.user_id is not null,
          'keep_auth', private.keeps_login_account(d.user_id),
          'rides_assigned', (select count(*) from public.rides r where r.driver_id = d.id
                             and r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS')),
          'organization', jsonb_build_object('id', o.id, 'name', o.name, 'status', o.status)) as j
      from public.drivers d
      join public.organizations o on o.id = d.organization_id
      left join public.users u on u.id = d.user_id
      where d.deleted_at is null
        and (
          (v_email is not null and (lower(d.email) = v_email or lower(u.email) = v_email))
          or (v_phone is not null and (private.identity_normalize('phone', d.phone) = v_phone
                                       or private.identity_normalize('phone', u.phone) = v_phone)))
      order by d.created_at desc
      limit 20
    ) t);
end;
$$;

-- ----------------------------------------------------------------- mot de passe d'un compte bloqué
-- Compte suspendu, banni ou centrale suspendue : Supabase Auth refuse la connexion (compte banni) et les sessions
-- sont révoquées. Pour qu'il puisse quand même supprimer son compte, la route vérifie ici le mot de passe
-- (empreinte bcrypt de Supabase Auth). Chauffeur non supprimé uniquement ; service role seulement (la route
-- limite le débit par IP et par adresse).
create or replace function public.svc_driver_password_check(p_email text, p_password text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_hash text;
begin
  if p_email is null or p_password is null or char_length(p_password) not between 1 and 200 then
    return null;
  end if;
  begin
    select u.id, u.encrypted_password into v_id, v_hash
      from auth.users u
     where lower(u.email) = lower(btrim(p_email)) and u.encrypted_password is not null
     order by u.created_at
     limit 1;
  exception when insufficient_privilege or undefined_table or undefined_column then
    return null;
  end;
  if v_id is null or v_hash is null or v_hash !~ '^\$2[aby]\$[0-9]{2}\$' then
    return null;
  end if;
  if not exists (select 1 from public.drivers d where d.user_id = v_id and d.deleted_at is null) then
    return null;
  end if;
  -- pgcrypto ne connaît que le préfixe $2a$ (même algorithme que $2b$ / $2y$)
  v_hash := '$2a$' || substr(v_hash, 5);
  begin
    if extensions.crypt(p_password, v_hash) = v_hash then
      return v_id;
    end if;
  exception when others then
    return null;
  end;
  return null;
end;
$$;

-- ----------------------------------------------------------------- garde-fou : fiche supprimée
-- Fiche anonyme non modifiable, quelle que soit la voie (tableau de bord, RPC, service role) : tout est refusé sauf
-- ce que le système EFFACE — compte, véhicule, candidature, notes, présence (hors ligne), bannissement effacé en
-- entier (purges des 3 ans) — et le caviardage du motif de bannissement (nom retiré, rattrapage). Refusés donc :
-- réactivation, invitation, suspension (statut figé à « inactif » : une fiche suspendue compterait dans la limite de
-- l'offre), coordonnées, niveau de confiance, motif de suspension, compte, véhicule, course en cours, nouveau
-- bannissement (ban_driver) ou bannissement modifié, levée par la centrale (lift_driver_ban). La plateforme bannit
-- ou lève les IDENTITÉS d'un signalement sans toucher la fiche (svc_platform_ban / svc_platform_unban ci-dessous).
create or replace function private.drivers_deleted_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  -- Colonnes que le système peut encore modifier, selon les règles ci-dessous ; toute autre colonne est figée
  v_system constant text[] := array['updated_at', 'status', 'presence', 'online_since', 'last_seen_at', 'current_ride_id',
    'user_id', 'vehicle_id', 'notes', 'application_status', 'application_message', 'application_note',
    'banned_at', 'banned_by', 'ban_reason', 'ban_scope', 'ban_report_id'];
begin
  if old.deleted_at is null then
    return new;
  end if;
  if (to_jsonb(new) - v_system) is distinct from (to_jsonb(old) - v_system)
     or (new.status is distinct from old.status and new.status <> 'inactive')
     or (new.presence is distinct from old.presence and new.presence <> 'offline')
     -- effacement seulement
     or (new.online_since is not null and new.online_since is distinct from old.online_since)
     or (new.last_seen_at is not null and new.last_seen_at is distinct from old.last_seen_at)
     or (new.current_ride_id is not null and new.current_ride_id is distinct from old.current_ride_id)
     or (new.user_id is not null and new.user_id is distinct from old.user_id)
     or (new.vehicle_id is not null and new.vehicle_id is distinct from old.vehicle_id)
     or (new.notes is not null and new.notes is distinct from old.notes)
     or (new.application_status is not null and new.application_status is distinct from old.application_status)
     or (new.application_message is not null and new.application_message is distinct from old.application_message)
     or (new.application_note is not null and new.application_note is distinct from old.application_note)
     -- bannissement : inchangé (motif caviardé ou effacé au plus) ou effacé en entier
     or not (
       ((new.banned_at, new.banned_by, new.ban_scope, new.ban_report_id)
          is not distinct from (old.banned_at, old.banned_by, old.ban_scope, old.ban_report_id)
        and (new.ban_reason is null or old.ban_reason is not null))
       or (new.banned_at is null and new.banned_by is null and new.ban_reason is null and new.ban_scope is null
           and new.ban_report_id is null)) then
    raise exception 'DRIVER_DELETED: ce chauffeur a supprimé son compte (fiche anonyme, non modifiable)'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Justificatifs : aucun nouveau document (ni numéro de pièce) rattaché à une fiche supprimée, même par la centrale
create or replace function private.driver_documents_deleted_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.drivers d where d.id = new.driver_id and d.deleted_at is not null) then
    raise exception 'DRIVER_DELETED: ce chauffeur a supprimé son compte (fiche anonyme : aucun nouveau document)'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------- bannissement plateforme : fiche supprimée intacte
-- Dernière définition : 20260924002600. Ajouts : fiches supprimées ignorées (le garde-fou les refuserait et la
-- décision du super admin échouerait) — les EMPREINTES du signalement sont bannies ou levées quand même, c'est ce qui
-- empêche la réinscription ; acteur revérifié en SQL (super admin, CLAUDE.md).
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
  perform private.assert_platform_actor(p_actor);
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

  -- Tous les comptes (toutes centrales) partageant une identité bannie, dont le chauffeur signalé ; fiches
  -- supprimées exclues (anonymes, non modifiables)
  for x in
    select d.id, d.user_id, d.organization_id
    from public.drivers d
    where d.deleted_at is null
      and (d.id = f.driver_id or exists (
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

-- Dernière définition : 20260924002600. Mêmes ajouts : fiches supprimées ignorées, acteur revérifié.
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

-- ----------------------------------------------------------------- candidatures : fiche supprimée refusée
-- Dernière définition : 20260924002600. Ajout : refus si la fiche est supprimée (deleted_at).
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
  if d.deleted_at is not null then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_DELETED', 'message', 'Ce chauffeur a supprimé son compte : la candidature n''existe plus.');
  end if;
  if d.banned_at is not null then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_BANNED', 'message', 'Chauffeur banni : levez d''abord le bannissement.');
  end if;
  -- En attente, ou refusée puis reconsidérée
  if d.application_status is null or d.application_status not in ('pending', 'rejected') or d.status <> 'inactive' then
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
         application_note = null,
         trust_level = coalesce(v_trust, trust_level)
   where id = d.id;

  select o.name into v_name from public.organizations o where o.id = d.organization_id;
  perform private.queue_notification(d.organization_id, d.id, null, null, 'application_approved', 'CANDIDATURE ACCEPTÉE',
    format('Bienvenue chez %s : passez en ligne pour recevoir vos premières courses.', v_name),
    jsonb_build_object('type', 'application_approved'), 'high', null);
  perform private.log_event(d.organization_id, null, 'driver.approved',
    format('Candidature de %s %s (#%s) %s', d.first_name, d.last_name, d.number,
      case when d.application_status = 'rejected' then 'reconsidérée et acceptée' else 'acceptée' end),
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
  if d.deleted_at is not null then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_DELETED', 'message', 'Ce chauffeur a supprimé son compte : la candidature n''existe plus.');
  end if;
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

-- ----------------------------------------------------------------- rattrapage : fiches supprimées par 003500
-- Nom déjà effacé de la fiche : il est retrouvé dans les libellés (règlements, signalement), le compte de connexion
-- quand il existe encore, les alertes et le journal des courses — prénom : « Prénom accepte », « Prénom refuse la
-- course », « Prénom (#N) est en ligne », « Prénom N. » des non sollicités ; nom complet : « Prénom Nom (#N) » des
-- événements de sa fiche (inscription, candidature, document, attribution manuelle, déclaration de paiement).
-- Chaque découpage plausible « prénom / nom » est retiré, les prénoms les plus longs d'abord (« Jean Pierre »
-- avant « Jean »). File alimentée (dossier de stockage entier à purger, compte Auth restant), fiche détachée du
-- compte, candidature close, métadonnées du compte Auth et journal d'audit caviardés.
create or replace function private.repair_deleted_drivers()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  d public.drivers;
  c record;
  v_keep boolean;
  v_alias text;
  v_num text;
  v_firsts text[];
  v_fulls text[];
  v_count integer := 0;
begin
  for d in
    select x.* from public.drivers x
     where x.deleted_at is not null
       and (x.user_id is not null or x.application_status is not null
            or not exists (select 1 from private.account_deletions q where q.driver_id = x.id))
     order by x.deleted_at
  loop
    v_alias := format('Chauffeur supprimé (#%s)', d.number);
    v_num := d.number::text;
    v_keep := private.keeps_login_account(d.user_id);

    -- Prénoms
    select coalesce(array_agg(distinct x.first), '{}') into v_firsts
      from (
        select btrim(substring(e.message from '^(.+) accepte$')) as first
          from public.ride_events e
         where e.organization_id = d.organization_id and e.type = 'offer.accepted'
           and e.actor_type = 'driver' and e.actor_id = d.id
        union all
        select btrim(substring(e.message from '^(.+) refuse la course$'))
          from public.ride_events e
         where e.organization_id = d.organization_id and e.type = 'offer.declined'
           and e.actor_type = 'driver' and e.actor_id = d.id
        union all
        select btrim(substring(e.message from '^(.+) \(#' || v_num || '\) '))
          from public.ride_events e
         where e.organization_id = d.organization_id and e.type in ('offer.rejected_late', 'driver.online', 'driver.offline')
           and e.data ->> 'driver_id' = d.id::text
        union all
        select btrim(substring(t.x ->> 'name' from '^(.+) \S?\.$'))
          from public.ride_events e
          cross join lateral jsonb_array_elements(
            case when jsonb_typeof(e.data -> 'excluded') = 'array' then e.data -> 'excluded' else '[]'::jsonb end) as t(x)
         where e.organization_id = d.organization_id and e.type = 'dispatch.excluded'
           and t.x ->> 'driver_id' = d.id::text
        union all
        select btrim(a.data ->> 'driver_name') from public.ride_alerts a where a.driver_id = d.id
      ) x
     where x.first is not null and x.first <> '' and x.first not like 'Chauffeur supprimé%';

    -- Noms complets (« Prénom Nom »)
    select coalesce(array_agg(distinct x.full_name), '{}') into v_fulls
      from (
        select btrim(regexp_replace(s.driver_label, '\s*\(#[0-9]+\)\s*$', '')) as full_name
          from public.ride_settlements s where s.driver_id = d.id
        union all
        select btrim(regexp_replace(f.driver_label, '\s*\(#[0-9]+\)\s*$', '')) from public.fraud_reports f where f.driver_id = d.id
        union all
        select btrim(u.full_name) from public.users u where u.id = d.user_id and not v_keep
        union all
        select btrim(case e.type
                 when 'driver.approved' then substring(e.message from '^Candidature de (.+) \(#' || v_num || '\)')
                 when 'driver.rejected' then substring(e.message from '^Candidature de (.+) \(#' || v_num || '\)')
                 when 'ride.assigned_manually' then substring(e.message from '^Course attribuée manuellement à (.+) \(#' || v_num || '\)')
                 else substring(e.message from '^(.+) \(#' || v_num || '\) ')
               end)
          from public.ride_events e
         where e.organization_id = d.organization_id
           and (e.data ->> 'driver_id' = d.id::text or (e.actor_type = 'driver' and e.actor_id = d.id))
           and e.type in ('driver.applied', 'driver.approved', 'driver.rejected', 'driver.trusted', 'document.submitted',
                          'ride.assigned_manually', 'settlement.declared')
      ) x
     where x.full_name is not null and x.full_name <> '' and x.full_name not like 'Chauffeur supprimé%';

    for c in
      select p.first, p.last
        from (
          -- Nom complet découpé par un prénom connu
          select f.first, nullif(btrim(substr(u.full_name, char_length(f.first) + 2)), '') as last
            from unnest(v_fulls) as u(full_name)
            join unnest(v_firsts) as f(first) on left(u.full_name, char_length(f.first) + 1) = f.first || ' '
          union
          -- Sans prénom connu : toutes les coupures (« Jean » + « Pierre Martin », « Jean Pierre » + « Martin »)
          select array_to_string(w.words[1:k], ' '), nullif(array_to_string(w.words[k + 1:], ' '), '')
            from unnest(v_fulls) as u(full_name)
            cross join lateral (select regexp_split_to_array(u.full_name, '\s+') as words) w
            cross join lateral generate_series(1, greatest(cardinality(w.words) - 1, 1)) as k
           where not exists (select 1 from unnest(v_firsts) as f(first)
                              where left(u.full_name, char_length(f.first) + 1) = f.first || ' ')
          union
          -- Prénom seul
          select f.first, null from unnest(v_firsts) as f(first)
        ) p
       where p.first is not null and p.first <> ''
       order by char_length(p.first) desc, char_length(coalesce(p.last, '')) desc, p.first, p.last
    loop
      perform private.scrub_driver_traces(d.id, d.organization_id, d.created_at, c.first, c.last, d.number, v_alias);
    end loop;
    perform private.scrub_driver_traces(d.id, d.organization_id, d.created_at, null, null, d.number, v_alias);

    insert into private.account_deletions (driver_id, organization_id, driver_number, user_id, keep_auth, storage_prefix,
      source, requested_at, auth_done_at, next_attempt_at)
    values (d.id, d.organization_id, d.number, d.user_id, v_keep, format('%s/%s/', d.organization_id, d.id),
      'repair', d.deleted_at, case when d.user_id is null or v_keep then now() end, now())
    on conflict (driver_id) do nothing;

    -- Compte de connexion (supprimé par la file) : nom et téléphone effacés dès maintenant
    if d.user_id is not null and not v_keep then
      update public.users set full_name = null, phone = null, avatar_url = null where id = d.user_id;
      begin
        update auth.users
           set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) - array['full_name', 'name', 'phone', 'avatar_url']
         where id = d.user_id;
      exception when insufficient_privilege or undefined_table or undefined_column then
        raise warning 'repair_deleted_drivers: métadonnées Auth non effacées (privilèges)';
      end;
    end if;
    if v_keep then
      perform set_config('rydar.keep_sessions', d.user_id::text, true);
    end if;
    update public.drivers set user_id = null, application_status = null
     where id = d.id and (user_id is not null or application_status is not null);
    perform set_config('rydar.keep_sessions', '', true);
    -- Journal d'audit : valeurs, adresse IP et navigateur du chauffeur retirés (y compris la ligne ci-dessus)
    perform private.redact_driver_audit(d.id, d.user_id, v_keep, null);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

select private.repair_deleted_drivers();

-- ----------------------------------------------------------------- bannissement : durée de conservation
-- Chauffeur banni pour fraude qui a supprimé son compte : empreintes de ses identifiants et signalement (motif,
-- sans nom) conservés 3 ANS après la suppression pour empêcher une réinscription (durée affichée sur
-- /suppression-compte et /confidentialite), puis effacés, avec le motif resté sur la fiche anonyme (worker).
create or replace function private.purge_deleted_driver_bans(p_older_than interval default interval '3 years')
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_bans integer := 0;
  v_reports integer := 0;
begin
  select coalesce(array_agg(d.id), '{}') into v_ids
    from public.drivers d
   where d.deleted_at is not null and d.deleted_at <= now() - coalesce(p_older_than, interval '3 years')
     and (d.banned_at is not null
          or exists (select 1 from public.banned_identities b where b.driver_id = d.id)
          or exists (select 1 from public.fraud_reports f where f.driver_id = d.id));
  if cardinality(v_ids) = 0 then
    return jsonb_build_object('drivers', 0, 'identities', 0, 'reports', 0);
  end if;
  perform private.set_actor('system', null);
  delete from public.banned_identities where driver_id = any (v_ids);
  get diagnostics v_bans = row_count;
  delete from public.fraud_reports where driver_id = any (v_ids);
  get diagnostics v_reports = row_count;
  update public.drivers
     set banned_at = null, banned_by = null, ban_reason = null, ban_scope = null, ban_report_id = null
   where id = any (v_ids) and (banned_at is not null or ban_reason is not null);
  -- Journal des modifications de la fiche (valeurs brutes, dont le motif) : caviardé
  update public.audit_logs set metadata = jsonb_build_object('redacted', true)
   where entity_type = 'drivers' and action like 'drivers.%'
     and entity_id = any (select x::text from unnest(v_ids) x)
     and not (metadata ? 'redacted');
  return jsonb_build_object('drivers', cardinality(v_ids), 'identities', v_bans, 'reports', v_reports);
end;
$$;

drop trigger if exists drivers_deleted_guard on public.drivers;
create trigger drivers_deleted_guard
  before update on public.drivers
  for each row execute function private.drivers_deleted_guard();
drop trigger if exists driver_documents_deleted_guard on public.driver_documents;
create trigger driver_documents_deleted_guard
  before insert or update of driver_id on public.driver_documents
  for each row execute function private.driver_documents_deleted_guard();

-- -----------------------------------------------------------------------------
-- Droits d'exécution (deny-by-default, cf. 20260924000900)
-- -----------------------------------------------------------------------------
revoke execute on function
  private.regex_escape(text),
  private.driver_name_pattern(text, text, integer, boolean),
  private.jsonb_scrub(jsonb, text, text),
  private.scrub_excluded(jsonb, uuid, text),
  private.scrub_excluded_message(text, jsonb, uuid, text),
  private.keeps_login_account(uuid),
  private.redact_driver_audit(uuid, uuid, boolean, uuid),
  private.scrub_driver_traces(uuid, uuid, timestamptz, text, text, integer, text),
  private.revoke_sessions_on_access_change(),
  private.account_deletion_json(private.account_deletions),
  private.delete_driver_account(uuid, text, uuid),
  private.complete_account_deletion(uuid, boolean, boolean, text),
  private.claim_account_deletions(integer),
  private.purge_deleted_driver_bans(interval),
  private.repair_deleted_drivers(),
  private.drivers_deleted_guard(),
  private.driver_documents_deleted_guard()
from public, anon, authenticated, service_role;

revoke execute on function
  public.svc_delete_driver_account(uuid),
  public.svc_admin_delete_driver(uuid, uuid),
  public.svc_account_deletion_progress(uuid, boolean, boolean, text),
  public.svc_account_deletion_retry(uuid, uuid),
  public.svc_driver_password_check(text, text)
from public, anon, authenticated;
grant execute on function
  public.svc_delete_driver_account(uuid),
  public.svc_admin_delete_driver(uuid, uuid),
  public.svc_account_deletion_progress(uuid, boolean, boolean, text),
  public.svc_account_deletion_retry(uuid, uuid),
  public.svc_driver_password_check(text, text)
to service_role;

revoke execute on function public.admin_account_deletions(integer), public.admin_find_drivers(text) from public, anon;
grant execute on function public.admin_account_deletions(integer), public.admin_find_drivers(text) to authenticated;
