-- =============================================================================
-- Rydar Drive — Audit RGPD : conservation réellement appliquée, suppression de compte, textes légaux.
--
--  * journal d'audit de Supabase Auth (auth.audit_log_entries : nom, e-mail, adresse IP de chaque connexion, trace
--    de la suppression d'un compte) : 1 an (private.housekeeping, une fois par heure au plus) et effacé dès la
--    suppression du compte de connexion d'un chauffeur (private.complete_account_deletion). DML seulement (autorisé
--    sur Supabase hébergé) ; RLS activée par GoTrue sur cette table : sans BYPASSRLS, rien n'est supprimé (voir
--    docs/DEPLOYMENT.md, contrôle après déploiement). Droits insuffisants ou table absente : erreur consignée, le
--    reste continue ;
--  * courses de plus de 10 ans purgées QUEL QUE SOIT leur statut (une course jamais clôturée gardait les
--    coordonnées du client indéfiniment) ;
--  * position du chauffeur recopiée dans une alerte de course close (immobile, GPS muet) et dans son journal :
--    30 jours, comme l'historique des positions ;
--  * signalement retiré par la centrale : texte, auteur et position effacés aussi des alertes déjà envoyées
--    (notifications) ; à la suppression du compte de l'auteur, ses signalements retirés sont retrouvés (et leurs
--    alertes effacées) ; rattrapage des alertes existantes ;
--  * suppression du compte d'un chauffeur d'une centrale suspendue ou archivée : ses courses acceptées non
--    commencées sont libérées (la centrale ne peut plus les réattribuer) au lieu de bloquer la suppression ;
--  * chauffeur qui supprime son compte en devant encore des commissions à sa centrale : empreintes (hachages) de
--    son téléphone, de son e-mail et de sa carte VTC gardées tant que la dette reste ouverte, pour le compte de la
--    centrale (constatation, exercice ou défense de droits en justice) ; une candidature par lien qui les porte dans
--    la même centrale n'est jamais validée automatiquement et la centrale voit le montant restant dû.
-- Fonctions private sans security definer (CLAUDE.md), sauf private.housekeeping (déjà definer, worker).
-- =============================================================================

-- ----------------------------------------------------------------- débiteurs : empreintes d'un compte supprimé
-- Chauffeur supprimé avec des commissions dues (règlements driver_owes due / declared / disputed) : empreintes de
-- ses identifiants (sha256 de la valeur normalisée, private.identity_hash, comme pour un banni ; jamais la valeur ni
-- d'indice en clair), rattachées à sa fiche anonyme « Chauffeur supprimé (#N) ». Purgées par private.housekeeping dès
-- que plus aucun règlement n'est ouvert (payé, annulé, ou course purgée au bout de 10 ans). Aucun accès client.
create table private.debtor_identities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  driver_id uuid not null,
  driver_number integer not null,
  kind text not null check (kind in ('phone', 'email', 'vtc_card')),
  value_hash text not null check (value_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (driver_id, kind, value_hash),
  foreign key (organization_id, driver_id) references public.drivers (organization_id, id) on delete cascade
);
comment on table private.debtor_identities is
  'Empreintes (hachages) d''un chauffeur qui a supprimé son compte en devant encore des commissions à sa centrale, gardées tant que la dette est ouverte (candidature par lien : validation manuelle).';
create index debtor_identities_lookup_idx on private.debtor_identities (organization_id, kind, value_hash);

alter table private.debtor_identities enable row level security;
revoke all on private.debtor_identities from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------- ménage : dernier passage des purges espacées
-- Purge du journal Auth (table sans index sur la date, DDL interdit sur auth.*) : une fois par heure au plus.
create table private.housekeeping_runs (
  task text primary key check (char_length(task) between 1 and 40),
  last_run_at timestamptz not null
);
comment on table private.housekeeping_runs is 'Dernier passage des purges espacées de private.housekeeping.';
alter table private.housekeeping_runs enable row level security;
revoke all on private.housekeeping_runs from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------- index des purges
-- Alertes closes et leur journal qui portent encore la position du chauffeur (retirée au bout de 30 jours)
create index if not exists ride_alerts_position_idx on public.ride_alerts (created_at)
  where status <> 'open' and (data ? 'lat' or data ? 'lng');
create index if not exists ride_events_alert_position_idx on public.ride_events (created_at)
  where type in ('alert.stalled', 'alert.no_gps') and (data ? 'lat' or data ? 'lng');

-- ----------------------------------------------------------------- débiteurs : outils
-- Commissions encore dues par un chauffeur (règlements ouverts, montant non nul).
create or replace function private.driver_open_debt(p_driver uuid)
returns table (owed_cents bigint, owed_count integer)
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(s.amount_cents), 0)::bigint, count(*)::integer
  from public.ride_settlements s
  where s.driver_id = p_driver
    and s.direction = 'driver_owes'
    and s.status in ('due', 'declared', 'disputed')
    and s.amount_cents > 0;
$$;

-- Fiches supprimées de CETTE centrale dont une empreinte correspond (téléphone, e-mail ou carte VTC) et dont la
-- dette est encore ouverte.
create or replace function private.debtor_match(p_org uuid, p_phone text, p_email text, p_vtc_card text)
returns table (driver_id uuid, driver_number integer, owed_cents bigint, owed_count integer)
language sql
stable
set search_path = ''
as $$
  select x.driver_id, x.driver_number, o.owed_cents, o.owed_count
  from (
    select distinct i.driver_id, i.driver_number
    from private.debtor_identities i
    where i.organization_id = p_org
      and ((i.kind = 'phone' and i.value_hash = private.identity_hash('phone', p_phone))
        or (i.kind = 'email' and i.value_hash = private.identity_hash('email', p_email))
        or (i.kind = 'vtc_card' and i.value_hash = private.identity_hash('vtc_card', p_vtc_card)))
  ) x
  cross join lateral private.driver_open_debt(x.driver_id) o
  where o.owed_count > 0
  order by x.driver_number;
$$;

-- ----------------------------------------------------------------- traces du chauffeur
-- Dernière définition : 20260924004000. Ajout : ses signalements sont aussi retrouvés dans les messages
-- (chat_messages.author_driver_id, messages retirés compris : remove_chat_message réécrit leur journal sans
-- l'auteur), avant leur suppression par private.delete_driver_account — leurs alertes chez les autres chauffeurs
-- (notifications) sont ainsi effacées elles aussi.
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
  -- recopiaient le texte et son nom chez les autres chauffeurs. Retrouvés par le journal (auteur) et par les
  -- messages eux-mêmes (un signalement retiré par la centrale n'a plus d'auteur dans le journal).
  select coalesce(array_agg(distinct x.id), '{}') into v_reports
    from (
      select e.data ->> 'message_id' as id
        from public.ride_events e
       where e.organization_id = p_org and e.type = 'fleet.report' and e.data ->> 'author_driver_id' = v_id
         and e.data ? 'message_id'
      union
      select m.id::text
        from public.chat_messages m
       where m.organization_id = p_org and m.author_driver_id = p_driver and m.report_type is not null
    ) x;
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

-- ----------------------------------------------------------------- modération : signalement retiré
-- Dernière définition : 20260924004100. Ajout : texte, auteur et position effacés de TOUTES les alertes du
-- signalement (notifications déjà envoyées comprises, lisibles par leur destinataire, la centrale et le super
-- admin) ; celles encore en file restent annulées.
create or replace function public.remove_chat_message(p_message uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.chat_messages;
  v_org uuid;
  v_uid uuid := auth.uid();
  v_reports integer;
  v_notifs integer;
begin
  if p_message is null then
    raise exception 'INVALID_MESSAGE: message manquant' using errcode = '22023';
  end if;
  select x.organization_id into v_org from public.chat_messages x where x.id = p_message;
  if not found then
    raise exception 'MESSAGE_NOT_FOUND: message introuvable' using errcode = 'P0002';
  end if;
  -- Contrôle d'accès AVANT tout verrou
  perform private.assert_org_member(v_org, array['owner', 'admin', 'dispatcher']::public.org_role[]);
  if v_uid is null then
    raise exception 'FORBIDDEN: authentification requise' using errcode = '42501';
  end if;

  select * into m from public.chat_messages where id = p_message for update;
  -- Supprimé entre la première lecture et le verrou (compte de l'auteur supprimé, purge) : plus rien à retirer
  if not found then
    raise exception 'MESSAGE_NOT_FOUND: message introuvable' using errcode = 'P0002';
  end if;
  if m.channel <> 'fleet' then
    raise exception 'NOT_REMOVABLE: seuls les messages du fil « Chauffeurs » peuvent être supprimés' using errcode = '22023';
  end if;
  if m.deleted_at is not null then
    return jsonb_build_object('ok', true, 'code', 'ALREADY_REMOVED', 'message_id', m.id);
  end if;
  perform private.set_actor('user', v_uid);

  -- Signalement de la flotte (police, bouchon…) : expiré en même temps (carte, votes, diffusion « chat.report »)
  update public.chat_messages
     set deleted_at = now(),
         removed_by = v_uid,
         expires_at = case when report_type is not null then least(expires_at, now()) else expires_at end
   where id = m.id
  returning * into m;

  update public.chat_message_reports
     set status = 'removed', resolved_at = now(), resolved_by = v_uid
   where message_id = m.id and status = 'open';
  get diagnostics v_reports = row_count;

  -- Alertes « signalement » pas encore envoyées : annulées
  update public.notifications
     set status = 'cancelled', last_error = 'message retiré par la centrale'
   where organization_id = m.organization_id and status = 'queued' and data ->> 'message_id' = m.id::text;
  get diagnostics v_notifs = row_count;

  -- Toutes les alertes du signalement, envoyées comprises : texte, nom de l'auteur et position retirés
  update public.notifications
     set body = 'Signalement retiré par la centrale',
         data = jsonb_build_object('message_id', m.id, 'removed', true)
   where organization_id = m.organization_id and type = 'fleet_report' and data ->> 'message_id' = m.id::text;

  -- Journal de la centrale : le texte du signalement retiré n'y reste pas
  if m.report_type is not null then
    update public.ride_events
       set message = 'Signalement retiré par la centrale',
           data = jsonb_build_object('message_id', m.id, 'report_type', m.report_type, 'removed', true)
     where organization_id = m.organization_id
       and ride_id is null
       and type in ('fleet.report', 'fleet.report_cleared')
       and created_at >= m.created_at - interval '10 minutes'
       and data ->> 'message_id' = m.id::text;
  end if;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (m.organization_id, 'user', v_uid, 'chat.message_removed', 'chat_messages', m.id::text, 'warning',
    jsonb_build_object('author_type', m.author_type, 'author_driver_id', m.author_driver_id,
      'author_user_id', m.author_user_id, 'report_type', m.report_type, 'reports', v_reports,
      'notifications_cancelled', v_notifs));

  perform realtime.send(
    jsonb_build_object('action', 'removed', 'organization_id', m.organization_id, 'message_id', m.id),
    'chat.moderation', 'org:' || m.organization_id::text, true);
  perform realtime.send(jsonb_build_object('id', m.id, 'organization_id', m.organization_id),
    'chat.removed', 'fleet:' || m.organization_id::text, true);

  return jsonb_build_object('ok', true, 'code', 'REMOVED', 'message_id', m.id, 'reports', v_reports);
end;
$$;

-- Rattrapage : alertes des signalements déjà retirés (texte effacé) ou dont le message n'existe plus (compte de
-- l'auteur supprimé : elles auraient dû partir avec lui)
update public.notifications n
   set body = 'Signalement retiré par la centrale',
       data = jsonb_build_object('message_id', m.id, 'removed', true)
  from public.chat_messages m
 where n.type = 'fleet_report'
   and m.id::text = n.data ->> 'message_id'
   and m.organization_id = n.organization_id
   and m.deleted_at is not null
   and n.data is distinct from jsonb_build_object('message_id', m.id, 'removed', true);
delete from public.notifications n
 where n.type = 'fleet_report'
   and n.data ? 'message_id'
   and not exists (select 1 from public.chat_messages m where m.id::text = n.data ->> 'message_id');

-- ----------------------------------------------------------------- suppression (cœur)
-- Dernière définition : 20260924004000. Ajouts :
--  * centrale suspendue ou archivée (elle ne peut plus réattribuer, le chauffeur ne peut plus terminer) : ses courses
--    acceptées et pas encore commencées sont libérées (comme public.reassign_ride sans dispatch automatique : course
--    « à attribuer », journal ride.driver_deleted) puis la suppression continue ; une course commencée, ou toute
--    course attribuée d'une centrale active, la refuse toujours (RIDES_ASSIGNED, sans rien modifier) ;
--  * commissions encore dues (règlements driver_owes ouverts) : empreintes du téléphone, de l'e-mail et de la carte
--    VTC gardées dans private.debtor_identities tant que la dette est ouverte ; montant restant dû inscrit au journal
--    de la centrale (driver.deleted) et au journal d'audit.
create or replace function private.delete_driver_account(p_driver_id uuid, p_source text, p_actor uuid default null)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  d public.drivers;
  q private.account_deletions;
  r public.rides;
  v_rides integer;
  v_release integer;
  v_released integer := 0;
  v_org_active boolean;
  v_owed_cents bigint := 0;
  v_owed_count integer := 0;
  v_debtor_ids integer := 0;
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

  -- Courses attribuées. Centrale suspendue ou archivée : les courses acceptées non commencées seront libérées ;
  -- les autres (commencées, ou toute course d'une centrale active) bloquent la suppression.
  select coalesce(o.status = 'active', false) into v_org_active from public.organizations o where o.id = d.organization_id;
  v_org_active := coalesce(v_org_active, false);
  select count(*), count(*) filter (where r0.status = 'ACCEPTED' and not v_org_active)
    into v_rides, v_release
    from public.rides r0
   where r0.driver_id = d.id
     and r0.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS');
  v_rides := v_rides - v_release;
  if v_rides > 0
     or (d.current_ride_id is not null and not exists (
           select 1 from public.rides x
            where x.id = d.current_ride_id and x.driver_id = d.id and x.status = 'ACCEPTED' and not v_org_active)) then
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

  -- Centrale suspendue ou archivée : courses acceptées libérées (plus de dispatch pour elle : « à attribuer »)
  if v_release > 0 then
    for r in
      select * from public.rides x
       where x.driver_id = d.id and x.status = 'ACCEPTED'
       order by x.pickup_at, x.id
       for update
    loop
      update public.ride_assignments
         set is_active = false, released_at = now(), release_reason = 'driver_deleted'
       where ride_id = r.id and is_active;
      perform private.close_pending_offers(r.id, 'closed', 'driver_deleted');
      update public.rides
         set status = 'CREATED',
             driver_id = null,
             vehicle_id = null,
             dispatch_wave = 0,
             dispatch_radius_m = null,
             dispatch_started_at = null,
             next_dispatch_at = null,
             accepted_at = null,
             driver_en_route_at = null,
             driver_arrived_at = null,
             no_driver_at = null
       where id = r.id;
      perform private.close_ride_alerts(r.id, 'auto_resolved', null);
      perform private.log_event(r.organization_id, r.id, 'ride.driver_deleted',
        format('Course retirée au chauffeur #%s, qui a supprimé son compte (centrale inactive) — à attribuer manuellement', d.number),
        'timeline', 'warning', jsonb_build_object('previous_driver_id', d.id, 'previous_status', r.status),
        case when v_admin then 'super_admin' else 'driver' end::public.actor_type,
        case when v_admin then p_actor else d.id end);
      v_released := v_released + 1;
    end loop;
  end if;

  -- Commissions encore dues à la centrale : empreintes gardées tant que la dette est ouverte (avant l'effacement
  -- des identifiants), jamais la valeur en clair
  select o.owed_cents, o.owed_count into v_owed_cents, v_owed_count from private.driver_open_debt(d.id) o;
  if coalesce(v_owed_count, 0) > 0 then
    insert into private.debtor_identities (organization_id, driver_id, driver_number, kind, value_hash)
    select d.organization_id, d.id, d.number, i.kind, i.value_hash
      from private.driver_identities(d.id, false) i
     where i.kind in ('phone', 'email', 'vtc_card')
    on conflict (driver_id, kind, value_hash) do nothing;
    get diagnostics v_debtor_ids = row_count;
  end if;

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
    if exists (select 1 from public.rides r1 where r1.vehicle_id = v_vehicle)
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
      'vehicle', v_vehicle_action, 'deletion_id', q.id, 'rides_released', v_released,
      'owed_cents', v_owed_cents, 'owed_settlements', v_owed_count, 'debtor_identities', v_debtor_ids));

  perform private.log_event(d.organization_id, null, 'driver.deleted',
    case when v_admin then format('Compte du chauffeur #%s supprimé à sa demande (traité par Rydar Drive)', d.number)
         else format('Le chauffeur #%s a supprimé son compte', d.number) end
    || case when coalesce(v_owed_count, 0) > 0
            then format(' — reste dû : %s de commissions (%s règlement%s au nom de « %s »)',
                   private.fmt_eur(least(v_owed_cents, 2147483647)::integer), v_owed_count,
                   case when v_owed_count > 1 then 's' else '' end, v_alias)
            else '' end,
    'system', 'warning',
    jsonb_build_object('driver_id', d.id, 'source', p_source, 'rides_released', v_released,
      'owed_cents', v_owed_cents, 'owed_settlements', v_owed_count),
    case when v_admin then 'super_admin' else 'driver' end::public.actor_type,
    case when v_admin then p_actor else d.id end);

  return jsonb_build_object('ok', true, 'code', 'DELETED', 'already_deleted', false, 'documents', v_files,
      'vehicle', v_vehicle_action, 'rides_released', v_released)
    || private.account_deletion_json(q);
end;
$$;

-- ----------------------------------------------------------------- avancement de la file
-- Dernière définition : 20260924004000. Ajout : compte de connexion supprimé (et non conservé) → son historique
-- dans le journal d'audit de Supabase Auth (connexions : nom, e-mail, adresse IP ; trace de la suppression) est
-- effacé. Table absente ou droits insuffisants : avertissement et clé auth_log_error, sans faire échouer
-- l'avancement (la purge d'un an de private.housekeeping reste le filet).
create or replace function private.complete_account_deletion(p_id uuid, p_storage_done boolean, p_auth_done boolean, p_error text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  q private.account_deletions;
  v_error text := left(nullif(btrim(coalesce(p_error, '')), ''), 500);
  v_auth_error text;
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

  -- Compte de connexion supprimé par l'appelant : son historique de connexions part avec lui
  if coalesce(p_auth_done, false) and q.user_id is not null and not q.keep_auth then
    begin
      if to_regclass('auth.audit_log_entries') is not null then
        delete from auth.audit_log_entries a
         where a.payload ->> 'actor_id' = q.user_id::text
            or a.payload -> 'traits' ->> 'user_id' = q.user_id::text;
      end if;
    exception when others then
      v_auth_error := left(sqlerrm, 300);
      raise warning 'complete_account_deletion: journal Auth non effacé (%)', v_auth_error;
    end;
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
  return jsonb_build_object('ok', true) || private.account_deletion_json(q)
    || case when v_auth_error is null then '{}'::jsonb else jsonb_build_object('auth_log_error', v_auth_error) end;
end;
$$;

-- ----------------------------------------------------------------- candidature par lien
-- Dernière définition : 20260924002600. Ajout : identité (téléphone, e-mail ou carte VTC) d'un chauffeur de CETTE
-- centrale qui a supprimé son compte en devant encore des commissions → jamais de validation automatique ; la
-- centrale voit le montant restant dû (journal driver.applied_debtor, journal d'audit). Le candidat reçoit la même
-- réponse qu'une candidature en attente.
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
  v_debt_cents bigint;
  v_debt_count integer;
  v_debt_numbers integer[];
  v_debt_drivers uuid[];
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

  -- Ancien chauffeur de cette centrale parti avec des commissions dues (empreintes, private.debtor_identities)
  select coalesce(sum(m.owed_cents), 0)::bigint, coalesce(sum(m.owed_count), 0)::integer,
         coalesce(array_agg(m.driver_number order by m.driver_number), '{}'), coalesce(array_agg(m.driver_id), '{}')
    into v_debt_cents, v_debt_count, v_debt_numbers, v_debt_drivers
    from private.debtor_match(p_org, v_phone, v_email, p_vtc_card) m;

  -- Validation automatique (réglage de la centrale) ; limite de l'offre atteinte ou identité d'un débiteur →
  -- validation manuelle
  if o.join_auto_approve and v_debt_count = 0 then
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
  if v_debt_count > 0 then
    perform private.log_event(p_org, null, 'driver.applied_debtor',
      format('Candidature de %s %s (#%s) : même téléphone, e-mail ou carte VTC que %s, qui a supprimé son compte en devant encore %s de commissions — à valider manuellement',
        d.first_name, d.last_name, d.number,
        (select string_agg(format('« Chauffeur supprimé (#%s) »', n), ', ') from unnest(v_debt_numbers) n),
        private.fmt_eur(least(v_debt_cents, 2147483647)::integer)),
      'system', 'warning',
      jsonb_build_object('driver_id', d.id, 'debtor_driver_ids', to_jsonb(v_debt_drivers),
        'debtor_numbers', to_jsonb(v_debt_numbers), 'owed_cents', v_debt_cents, 'owed_settlements', v_debt_count),
      'system', null);
  end if;
  perform realtime.send(
    jsonb_build_object('action', case when v_approved then 'approved' else 'applied' end,
      'driver', jsonb_build_object('id', d.id, 'number', d.number, 'first_name', d.first_name, 'last_name', d.last_name,
        'phone', d.phone, 'applied_at', d.applied_at)),
    'driver.application', 'org:' || p_org::text, true);
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, 'system', null, 'driver.applied', 'drivers', d.id::text, case when v_debt_count > 0 then 'warning' else 'info' end,
    jsonb_build_object('auto_approved', v_approved, 'email', v_email)
      || case when v_debt_count > 0
              then jsonb_build_object('debtor', jsonb_build_object('numbers', to_jsonb(v_debt_numbers),
                     'owed_cents', v_debt_cents, 'owed_settlements', v_debt_count))
              else '{}'::jsonb end);

  return jsonb_build_object('ok', true, 'code', case when v_approved then 'APPROVED' else 'PENDING' end,
    'driver_id', d.id, 'number', d.number, 'organization', jsonb_build_object('name', o.name));
end;
$$;

-- ----------------------------------------------------------------- ménage : durées de conservation annoncées
-- Dernière définition : 20260924003900. Ajouts (durées de /confidentialite § 9, /dpa § 11, /suppression-compte) :
--  * courses : 10 ans après la fin de l'année de la prise en charge, QUEL QUE SOIT leur statut (une course jamais
--    clôturée — créée sans dispatch, acceptée ou en cours oubliée — garde sinon les coordonnées du client) ;
--  * position du chauffeur dans une alerte de course close (immobile, GPS muet) et dans l'événement d'alerte du
--    journal : retirée au bout de 30 jours, comme l'historique des positions (alertes : 500 par passage, chacune
--    diffusée en temps réel) ;
--  * journal d'audit de Supabase Auth (connexions : nom, e-mail, adresse IP) : 1 an, une fois par heure au plus
--    (private.housekeeping_runs). Droits insuffisants ou table absente : « errors.auth_audit », le reste continue ;
--    sans BYPASSRLS (RLS activée par GoTrue), rien n'est supprimé : contrôle dans docs/DEPLOYMENT.md ;
--  * empreintes d'un débiteur (private.debtor_identities) : effacées dès que plus aucune commission n'est due.
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

  return jsonb_build_object('history_purged', v_history, 'api_logs_purged', v_logs,
    'documents_expired', v_docs, 'notifications_purged', v_notifs, 'chat_purged', v_chat,
    'fleet_events_purged', v_fleet, 'audit_network_purged', v_network, 'rides_purged', v_rides,
    'bans_purged', v_bans, 'alert_positions_purged', v_alert_positions, 'debtor_identities_purged', v_debtors,
    'auth_audit_purged', v_auth)
    || case when v_errors = '{}'::jsonb then '{}'::jsonb else jsonb_build_object('errors', v_errors) end;
end;
$$;

-- -----------------------------------------------------------------------------
-- Droits d'exécution (deny-by-default, cf. 20260924000900)
-- -----------------------------------------------------------------------------
-- Outils internes : jamais appelés par un client (RPC svc_* definer, worker propriétaire, migrations)
revoke execute on function
  private.driver_open_debt(uuid),
  private.debtor_match(uuid, text, text, text),
  private.scrub_driver_traces(uuid, uuid, timestamptz, text, text, integer, text),
  private.delete_driver_account(uuid, text, uuid),
  private.complete_account_deletion(uuid, boolean, boolean, text)
from public, anon, authenticated, service_role;
-- Ménage : réservé au worker (service role, comme avant)
revoke execute on function private.housekeeping() from public, anon, authenticated;
grant execute on function private.housekeeping() to service_role;

revoke execute on function public.remove_chat_message(uuid) from public, anon;
grant execute on function public.remove_chat_message(uuid) to authenticated, service_role;
revoke execute on function public.svc_driver_apply(uuid, uuid, text, text, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.svc_driver_apply(uuid, uuid, text, text, text, text, text, jsonb, text) to service_role;
