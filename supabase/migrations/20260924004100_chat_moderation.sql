-- =============================================================================
-- Rydar Drive — Modération de la messagerie « Chauffeurs » (fil flotte)
--
--  Contenu publié par les utilisateurs (App Store 1.2, règles Google Play) : chaque chauffeur peut signaler
--  un message et masquer un auteur ; la centrale (owner / admin / dispatcher), responsable de son fil, retire
--  les messages ou classe les signalements. Rydar Drive fournit l'outil ; la modération appartient à la centrale.
--
--  * chat_message_reports : signalement d'un message du fil flotte par un chauffeur (ou un membre de la
--    centrale), motif court facultatif ; open → removed (message supprimé) | dismissed (classé).
--    Le message signalé disparaît aussitôt du fil de celui qui l'a signalé.
--  * chat_blocks : un chauffeur masque les messages et signalements d'un autre chauffeur de sa centrale ;
--    ils sont exclus de SES lectures (driver_chat_overview) et il ne reçoit plus leurs alertes de signalement.
--  * chat_messages.deleted_at / removed_by : message retiré par la centrale, exclu partout (RLS, RPC de lecture,
--    compteurs, votes) ; ses signalements passent à « removed », ses alertes encore en file sont annulées et son
--    texte est retiré du journal de la centrale.
--  * Compte chauffeur supprimé (drivers.deleted_at) : ses masquages et les signalements qu'il a rédigés sont
--    supprimés (déclencheur drivers_chat_forget_deleted).
--  * Règles du fil : driver_chat_overview renvoie rules_version, dernière version des CGU acceptée par le compte
--    (inscription par lien, ou application avant la première publication dans le fil). L'application la compare à
--    la version en vigueur (LEGAL_VERSION, @rydar/shared) et fait accepter les règles avant de publier.
--  * Chauffeur qui est aussi membre de sa centrale (petite centrale dont le gérant conduit) : l'application agit
--    en chauffeur (signalement, vote), comme send_chat_message appelé sans organisation.
--  * Temps réel (identifiants seulement, jamais le texte) :
--      'chat.moderation' → org:<org>   { action: reported | dismissed | removed, organization_id, message_id, report_id? }
--      'chat.removed'    → fleet:<org> { id, organization_id } (les applications relisent leur messagerie)
--
--  Dernières définitions reprises : 20260924002300_chat (send_chat_message, chat_overview, driver_chat_overview,
--  vote_fleet_report, politique chat_messages_select) — aucune redéfinition ultérieure.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Messages retirés par la centrale
-- -----------------------------------------------------------------------------
alter table public.chat_messages
  add column if not exists deleted_at timestamptz,
  add column if not exists removed_by uuid references public.users (id) on delete set null;

-- Lecture directe (RLS) : un message retiré n'est plus visible de personne
drop policy if exists chat_messages_select on public.chat_messages;
create policy chat_messages_select on public.chat_messages for select to authenticated
  using (
    deleted_at is null
    and (
      organization_id in (select private.member_org_ids())
      or (select private.is_super_admin())
      or (
        organization_id = (select private.current_driver_org_id())
        and (channel = 'fleet' or driver_id = (select private.current_driver_id()))
      )
    )
  );

-- -----------------------------------------------------------------------------
-- Signalements de messages
-- -----------------------------------------------------------------------------
create table public.chat_message_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  message_id uuid not null,
  reporter_type text not null check (reporter_type in ('driver', 'user')),
  reporter_driver_id uuid,
  reporter_user_id uuid references public.users (id) on delete cascade,
  reason text check (reason is null or char_length(reason) between 1 and 200),
  status text not null default 'open' check (status in ('open', 'dismissed', 'removed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.users (id) on delete set null,
  foreign key (organization_id, message_id) references public.chat_messages (organization_id, id) on delete cascade,
  foreign key (organization_id, reporter_driver_id) references public.drivers (organization_id, id) on delete cascade,
  constraint chat_message_reports_reporter_chk check (
    (reporter_type = 'driver' and reporter_driver_id is not null and reporter_user_id is null)
    or (reporter_type = 'user' and reporter_user_id is not null and reporter_driver_id is null)
  ),
  constraint chat_message_reports_resolved_chk check ((status = 'open') = (resolved_at is null))
);
-- Un signalement par message et par auteur
create unique index chat_message_reports_driver_uniq on public.chat_message_reports (message_id, reporter_driver_id)
  where reporter_driver_id is not null;
create unique index chat_message_reports_user_uniq on public.chat_message_reports (message_id, reporter_user_id)
  where reporter_user_id is not null;
create index chat_message_reports_open_idx on public.chat_message_reports (organization_id, created_at desc) where status = 'open';
create index chat_message_reports_message_idx on public.chat_message_reports (message_id);
create index chat_message_reports_driver_idx on public.chat_message_reports (reporter_driver_id, created_at desc)
  where reporter_driver_id is not null;
create index chat_message_reports_user_idx on public.chat_message_reports (reporter_user_id, created_at desc)
  where reporter_user_id is not null;

-- -----------------------------------------------------------------------------
-- Auteurs masqués (par chauffeur)
-- -----------------------------------------------------------------------------
create table public.chat_blocks (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  driver_id uuid not null,
  blocked_driver_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (driver_id, blocked_driver_id),
  foreign key (organization_id, driver_id) references public.drivers (organization_id, id) on delete cascade,
  foreign key (organization_id, blocked_driver_id) references public.drivers (organization_id, id) on delete cascade,
  constraint chat_blocks_self_chk check (driver_id <> blocked_driver_id)
);
create index chat_blocks_blocked_idx on public.chat_blocks (blocked_driver_id);

create trigger chat_message_reports_forbid_org_change
  before update of organization_id on public.chat_message_reports
  for each row execute function private.forbid_org_change();
create trigger chat_blocks_forbid_org_change
  before update of organization_id on public.chat_blocks
  for each row execute function private.forbid_org_change();

-- RLS : lecture seule côté client, écritures via RPC.
--  * signalements : la centrale (membres) et l'auteur du signalement ;
--  * masquages : le chauffeur qui masque, lui seul (la centrale ne voit pas qui masque qui).
alter table public.chat_message_reports enable row level security;
alter table public.chat_blocks enable row level security;

create policy chat_message_reports_select on public.chat_message_reports for select to authenticated
  using (
    organization_id in (select private.member_org_ids())
    or (select private.is_super_admin())
    or reporter_driver_id = (select private.current_driver_id())
    or reporter_user_id = (select auth.uid())
  );

create policy chat_blocks_select on public.chat_blocks for select to authenticated
  using (driver_id = (select private.current_driver_id()));

revoke all on public.chat_message_reports, public.chat_blocks from public, anon, authenticated;
grant select on public.chat_message_reports, public.chat_blocks to authenticated;
grant all on public.chat_message_reports, public.chat_blocks to service_role;

-- Compte chauffeur supprimé (fiche anonymisée, deleted_at : private.delete_driver_account, 20260924004000) :
--  * ses masquages, dans un sens comme dans l'autre, n'ont plus d'objet ;
--  * les signalements qu'il a rédigés (motif libre) sont supprimés, qu'ils soient ouverts ou traités.
-- Ses messages sont supprimés avec le compte, et les signalements qui les visaient avec eux (cascade).
-- Pas de security definer : la suppression du compte (fonction definer) ou le service_role déclenche seul.
create or replace function private.chat_forget_deleted_driver()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.chat_blocks where driver_id = new.id or blocked_driver_id = new.id;
  delete from public.chat_message_reports where reporter_driver_id = new.id;
  return null;
end;
$$;

create trigger drivers_chat_forget_deleted
  after update of deleted_at on public.drivers
  for each row
  when (new.deleted_at is not null and old.deleted_at is null)
  execute function private.chat_forget_deleted_driver();

-- -----------------------------------------------------------------------------
-- send_chat_message (dernière définition : 20260924002300) : pas d'alerte « signalement »
-- aux chauffeurs qui ont masqué l'auteur
-- -----------------------------------------------------------------------------
create or replace function public.send_chat_message(
  p_org uuid,
  p_channel text,
  p_driver_id uuid,
  p_body text,
  p_report_type text default null,
  p_lat double precision default null,
  p_lng double precision default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record;
  m public.chat_messages;
  v_org uuid;
  v_thread_driver uuid;
  v_thread_driver_status public.driver_status;
  v_thread text;
  v_body text := nullif(btrim(coalesce(p_body, ''), E' \t\r\n'), '');
  v_name text;
  v_lat double precision := p_lat;
  v_lng double precision := p_lng;
  v_expires timestamptz;
  v_last_minute integer;
  v_recent_reports integer;
  v_point extensions.geography;
  v_title text;
  v_notified integer := 0;
  v_recipients uuid[] := '{}';
  v_distances integer[] := '{}';
  i integer;
begin
  select * into c from private.chat_caller(p_org, true);
  v_org := c.org_id;
  perform private.set_actor(c.kind::public.actor_type, coalesce(c.driver_id, c.user_id));

  if p_channel is null or p_channel not in ('driver', 'fleet') then
    raise exception 'INVALID_CHANNEL: fil de discussion inconnu' using errcode = '22023';
  end if;
  if p_report_type is not null then
    if p_report_type not in ('police', 'control', 'accident', 'traffic', 'danger', 'other') then
      raise exception 'INVALID_REPORT_TYPE: type de signalement inconnu' using errcode = '22023';
    end if;
    if p_channel <> 'fleet' then
      raise exception 'INVALID_REPORT: un signalement se publie sur le fil flotte' using errcode = '22023';
    end if;
  end if;

  -- Fil de discussion
  if p_channel = 'fleet' then
    if p_driver_id is not null then
      raise exception 'INVALID_THREAD: le fil flotte ne vise pas un chauffeur' using errcode = '22023';
    end if;
    v_thread := 'fleet';
  elsif c.kind = 'driver' then
    if p_driver_id is not null and p_driver_id <> c.driver_id then
      raise exception 'FORBIDDEN: fil direct d''un autre chauffeur' using errcode = '42501';
    end if;
    v_thread_driver := c.driver_id;
    v_thread := 'driver:' || v_thread_driver::text;
  else
    if p_driver_id is null then
      raise exception 'INVALID_THREAD: chauffeur manquant pour un fil direct' using errcode = '22023';
    end if;
    select d.id, d.status into v_thread_driver, v_thread_driver_status
      from public.drivers d
     where d.id = p_driver_id and d.organization_id = v_org;
    if not found then
      raise exception 'FORBIDDEN_TENANT: chauffeur hors de votre organisation' using errcode = '42501';
    end if;
    v_thread := 'driver:' || v_thread_driver::text;
  end if;

  -- Corps du message (défaut pour un signalement sans commentaire)
  if v_body is null and p_report_type is not null then
    v_body := case p_report_type
      when 'police' then 'Contrôle de police signalé'
      when 'control' then 'Contrôle VTC signalé'
      when 'accident' then 'Accident signalé'
      when 'traffic' then 'Bouchon signalé'
      when 'danger' then 'Danger sur la route'
      else 'Signalement de la flotte'
    end;
  end if;
  if v_body is null then
    raise exception 'EMPTY_MESSAGE: message vide' using errcode = '22023';
  end if;
  if char_length(v_body) > 1000 then
    raise exception 'MESSAGE_TOO_LONG: 1000 caractères maximum' using errcode = '22023';
  end if;

  -- Position : les deux coordonnées ou aucune
  if (v_lat is null) <> (v_lng is null) or v_lat not between -90 and 90 or v_lng not between -180 and 180 then
    raise exception 'INVALID_COORDINATES: position invalide' using errcode = '22023';
  end if;
  if p_report_type is not null then
    if v_lat is null and c.kind = 'driver' then
      -- Dernière position connue du chauffeur (récente uniquement)
      select l.lat, l.lng into v_lat, v_lng
        from public.driver_locations l
       where l.driver_id = c.driver_id and l.updated_at > now() - interval '15 minutes';
    end if;
    if v_lat is null then
      raise exception 'LOCATION_REQUIRED: position GPS indisponible pour ce signalement' using errcode = '22023';
    end if;
    v_expires := now() + case when p_report_type in ('accident', 'danger') then interval '60 minutes'
                              else interval '45 minutes' end;
  end if;

  -- Limites de débit par auteur (sérialisées : verrou consultatif par auteur)
  perform pg_advisory_xact_lock(hashtextextended('rydar.chat:' || c.reader_key, 0));
  if c.kind = 'driver' then
    select count(*) filter (where x.created_at > now() - interval '1 minute'),
           count(*) filter (where x.report_type is not null)
      into v_last_minute, v_recent_reports
      from public.chat_messages x
     where x.author_driver_id = c.driver_id and x.created_at > now() - interval '10 minutes';
  else
    select count(*) filter (where x.created_at > now() - interval '1 minute'),
           count(*) filter (where x.report_type is not null)
      into v_last_minute, v_recent_reports
      from public.chat_messages x
     where x.author_user_id = c.user_id and x.created_at > now() - interval '10 minutes';
  end if;
  if v_last_minute >= 20 then
    raise exception 'RATE_LIMITED: trop de messages, patientez une minute' using errcode = 'PT429';
  end if;
  if p_report_type is not null and v_recent_reports >= 5 then
    raise exception 'RATE_LIMITED: trop de signalements, patientez quelques minutes' using errcode = 'PT429';
  end if;

  -- Nom affiché
  if c.kind = 'driver' then
    select btrim(d.first_name || ' ' || left(d.last_name, 1) || '.') into v_name
      from public.drivers d where d.id = c.driver_id;
  else
    select coalesce(nullif(btrim(u.full_name), ''), nullif(split_part(u.email, '@', 1), ''))
      into v_name
      from public.users u where u.id = c.user_id;
  end if;
  v_name := left(coalesce(nullif(v_name, ''), 'Centrale'), 120);

  if p_report_type is not null then
    -- Destinataires : chauffeurs en ligne de l'organisation, position fraîche, à ≤ 25 km
    v_point := extensions.st_setsrid(extensions.st_makepoint(v_lng, v_lat), 4326)::extensions.geography;
    select coalesce(array_agg(near.id order by near.id), '{}'), coalesce(array_agg(near.distance_m order by near.id), '{}')
      into v_recipients, v_distances
      from (
        select d.id, round(extensions.st_distance(l.location, v_point))::integer as distance_m
        from public.drivers d
        join public.driver_locations l on l.driver_id = d.id and l.organization_id = d.organization_id
        where d.organization_id = v_org
          and d.status = 'active'
          and d.presence <> 'offline'
          and d.id is distinct from c.driver_id
          -- Chauffeurs qui ont masqué les messages de l'auteur : pas d'alerte (20260924004100)
          and not exists (
            select 1 from public.chat_blocks b where b.driver_id = d.id and b.blocked_driver_id = c.driver_id)
          and l.updated_at > now() - interval '15 minutes'
          and extensions.st_dwithin(l.location, v_point, 25000)
        order by 2
        limit 500
      ) near;
    -- Clés étrangères (messages, notifications) → verrous KEY SHARE sur drivers : pris d'avance
    -- dans l'ordre des id, comme le dispatch (FOR UPDATE par id croissant) → aucun interblocage.
    perform 1 from public.drivers x
     where x.id = any (v_recipients || c.driver_id)
     order by x.id
       for key share;
  end if;

  insert into public.chat_messages (organization_id, channel, driver_id, author_type, author_user_id, author_driver_id,
    author_name, body, report_type, lat, lng, expires_at)
  values (v_org, p_channel, v_thread_driver, c.kind, c.user_id, c.driver_id,
    v_name, v_body, p_report_type, v_lat, v_lng, v_expires)
  returning * into m;

  -- Écrire dans un fil vaut lecture de ce fil
  insert into public.chat_reads as cr (organization_id, reader_key, thread_key, last_read_at)
  values (v_org, c.reader_key, v_thread, m.created_at)
  on conflict (organization_id, reader_key, thread_key) do update
    set last_read_at = greatest(cr.last_read_at, excluded.last_read_at);

  if p_channel = 'driver' and c.kind = 'user' then
    -- Message direct de la centrale → push au chauffeur
    if v_thread_driver_status = 'active' then
      perform private.queue_notification(v_org, v_thread_driver, null, null, 'chat_message',
        'Message de la centrale', left(v_body, 240),
        jsonb_build_object('message_id', m.id, 'channel', 'driver', 'thread', v_thread, 'author_name', v_name),
        'high');
      v_notified := 1;
    end if;
  elsif p_report_type is not null then
    -- Signalement → push aux chauffeurs proches (priorité normale : les offres passent avant)
    v_title := case p_report_type
      when 'police' then 'Police signalée'
      when 'control' then 'Contrôle signalé'
      when 'accident' then 'Accident signalé'
      when 'traffic' then 'Bouchon signalé'
      when 'danger' then 'Danger signalé'
      else 'Signalement flotte'
    end;
    for i in 1 .. coalesce(cardinality(v_recipients), 0) loop
      perform private.queue_notification(v_org, v_recipients[i], null, null, 'fleet_report', v_title,
        format('%s — à %s de vous (%s)', left(v_body, 180), private.fmt_km(v_distances[i]), v_name),
        jsonb_build_object('message_id', m.id, 'channel', 'fleet', 'thread', 'fleet', 'report_type', p_report_type,
          'lat', v_lat, 'lng', v_lng, 'distance_m', v_distances[i], 'expires_at', v_expires, 'author_name', v_name),
        'normal');
      v_notified := v_notified + 1;
    end loop;

    perform private.log_event(v_org, null, 'fleet.report', format('%s par %s : %s', v_title, v_name, left(v_body, 200)),
      'system', 'warning',
      jsonb_build_object('message_id', m.id, 'report_type', p_report_type, 'lat', v_lat, 'lng', v_lng,
        'expires_at', v_expires, 'notified', v_notified, 'author_driver_id', c.driver_id, 'author_user_id', c.user_id),
      c.kind::public.actor_type, coalesce(c.driver_id, c.user_id));
  end if;

  return private.chat_message_json(m) || jsonb_build_object('notified', v_notified);
end;
$$;

-- -----------------------------------------------------------------------------
-- chat_overview (dernière définition : 20260924002300) : messages retirés exclus,
-- nombre de messages signalés en attente (open_reports)
-- -----------------------------------------------------------------------------
create or replace function public.chat_overview(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_reader text;
  v_fleet jsonb;
  v_drivers jsonb;
  v_unread_total integer;
  v_open_reports integer;
begin
  perform private.assert_org_reader(p_org);
  if v_uid is null then
    raise exception 'FORBIDDEN: authentification requise' using errcode = '42501';
  end if;
  v_reader := 'user:' || v_uid::text;

  select jsonb_build_object(
      'thread', 'fleet',
      'last_read_at', r.last_read_at,
      'unread', (
        select count(*) from public.chat_messages x
        where x.organization_id = p_org and x.channel = 'fleet' and x.deleted_at is null
          and x.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
          and x.author_user_id is distinct from v_uid),
      'last_message', (
        select private.chat_message_json(x) from public.chat_messages x
        where x.organization_id = p_org and x.channel = 'fleet' and x.deleted_at is null
        order by x.created_at desc, x.id desc limit 1),
      'active_reports', (
        select count(*) from public.chat_messages x
        where x.organization_id = p_org and x.report_type is not null and x.expires_at > now() and x.deleted_at is null))
    into v_fleet
    from (select 1) one
    left join public.chat_reads r
      on r.organization_id = p_org and r.reader_key = v_reader and r.thread_key = 'fleet';

  select coalesce(jsonb_agg(t.obj order by t.last_at desc nulls last, t.online desc, t.number), '[]'::jsonb)
    into v_drivers
    from (
      select d.number,
             d.presence <> 'offline' as online,
             (lm.msg).created_at as last_at,
             jsonb_build_object(
               'thread', 'driver:' || d.id::text,
               'driver', jsonb_build_object('id', d.id, 'number', d.number, 'first_name', d.first_name,
                 'last_name', d.last_name, 'presence', d.presence, 'status', d.status, 'photo_url', d.photo_url),
               'last_message', case when (lm.msg).id is not null then private.chat_message_json(lm.msg) end,
               'last_read_at', r.last_read_at,
               'unread', (
                 select count(*) from public.chat_messages x
                 where x.organization_id = p_org and x.channel = 'driver' and x.driver_id = d.id and x.deleted_at is null
                   and x.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
                   and x.author_user_id is distinct from v_uid),
               'driver_last_read_at', dr.last_read_at
             ) as obj
      from public.drivers d
      left join lateral (
        select x as msg from public.chat_messages x
        where x.organization_id = p_org and x.channel = 'driver' and x.driver_id = d.id and x.deleted_at is null
        order by x.created_at desc, x.id desc limit 1
      ) lm on true
      left join public.chat_reads r
        on r.organization_id = p_org and r.reader_key = v_reader and r.thread_key = 'driver:' || d.id::text
      left join public.chat_reads dr
        on dr.organization_id = p_org and dr.reader_key = 'driver:' || d.id::text and dr.thread_key = 'driver:' || d.id::text
      where d.organization_id = p_org
        and (d.status = 'active' or (lm.msg).id is not null)
    ) t;

  select coalesce((v_fleet ->> 'unread')::integer, 0) + coalesce(sum((e ->> 'unread')::integer), 0)
    into v_unread_total
    from jsonb_array_elements(v_drivers) e;

  -- Messages du fil flotte signalés et pas encore traités (supprimer / ignorer : chat_moderation_queue)
  select count(distinct r.message_id) into v_open_reports
    from public.chat_message_reports r
    join public.chat_messages x on x.id = r.message_id
   where r.organization_id = p_org and r.status = 'open' and x.deleted_at is null;

  return jsonb_build_object('organization_id', p_org, 'fleet', v_fleet, 'drivers', v_drivers,
    'unread_total', v_unread_total, 'open_reports', v_open_reports);
end;
$$;

-- -----------------------------------------------------------------------------
-- driver_chat_overview (dernière définition : 20260924002300) : messages retirés, auteurs
-- masqués et messages signalés par le chauffeur exclus ; liste des chauffeurs masqués (blocked) ;
-- dernière version des CGU acceptée (rules_version)
-- -----------------------------------------------------------------------------
create or replace function public.driver_chat_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_reader text;
  v_thread text;
  v_loc extensions.geography;
  v_dispatch_read timestamptz;
  v_fleet_read timestamptz;
  v_dispatch jsonb;
  v_fleet jsonb;
  v_reports jsonb;
  -- Auteurs masqués par ce chauffeur et messages qu'il a signalés : exclus de SON fil flotte
  v_blocked uuid[];
  v_reported uuid[];
  v_blocked_list jsonb;
  -- Dernière version des CGU acceptée par ce compte (null : jamais) ; versions = dates ISO (AAAA-MM-JJ),
  -- ordonnées comme du texte
  v_rules_version text;
begin
  select * into d from public.drivers where id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  v_reader := 'driver:' || d.id::text;
  v_thread := 'driver:' || d.id::text;

  select l.location into v_loc from public.driver_locations l where l.driver_id = d.id;
  select r.last_read_at into v_dispatch_read from public.chat_reads r
   where r.organization_id = d.organization_id and r.reader_key = v_reader and r.thread_key = v_thread;
  select r.last_read_at into v_fleet_read from public.chat_reads r
   where r.organization_id = d.organization_id and r.reader_key = v_reader and r.thread_key = 'fleet';
  v_blocked := array(select b.blocked_driver_id from public.chat_blocks b where b.driver_id = d.id);
  v_reported := array(select r.message_id from public.chat_message_reports r where r.reporter_driver_id = d.id);

  select jsonb_build_object(
      'thread', v_thread,
      'last_read_at', v_dispatch_read,
      'unread', (
        select count(*) from public.chat_messages x
        where x.organization_id = d.organization_id and x.channel = 'driver' and x.driver_id = d.id and x.deleted_at is null
          and x.created_at > coalesce(v_dispatch_read, '-infinity'::timestamptz)
          and x.author_driver_id is distinct from d.id),
      'seen_by_dispatch_at', (
        select max(r.last_read_at) from public.chat_reads r
        where r.organization_id = d.organization_id and r.thread_key = v_thread and r.reader_key like 'user:%'),
      'last_message', (
        select private.chat_message_json(x) from public.chat_messages x
        where x.organization_id = d.organization_id and x.channel = 'driver' and x.driver_id = d.id and x.deleted_at is null
        order by x.created_at desc, x.id desc limit 1),
      'messages', coalesce((
        select jsonb_agg(private.chat_message_json(y.msg) order by (y.msg).created_at, (y.msg).id)
        from (
          select x as msg from public.chat_messages x
          where x.organization_id = d.organization_id and x.channel = 'driver' and x.driver_id = d.id and x.deleted_at is null
          order by x.created_at desc, x.id desc limit 30
        ) y), '[]'::jsonb))
    into v_dispatch;

  select jsonb_build_object(
      'thread', 'fleet',
      'last_read_at', v_fleet_read,
      'unread', (
        select count(*) from public.chat_messages x
        where x.organization_id = d.organization_id and x.channel = 'fleet' and x.deleted_at is null
          and (x.author_driver_id is null or x.author_driver_id <> all (v_blocked)) and x.id <> all (v_reported)
          and x.created_at > coalesce(v_fleet_read, '-infinity'::timestamptz)
          and x.author_driver_id is distinct from d.id),
      'last_message', (
        select private.chat_message_json(x) from public.chat_messages x
        where x.organization_id = d.organization_id and x.channel = 'fleet' and x.deleted_at is null
          and (x.author_driver_id is null or x.author_driver_id <> all (v_blocked)) and x.id <> all (v_reported)
        order by x.created_at desc, x.id desc limit 1),
      'messages', coalesce((
        select jsonb_agg(private.chat_message_json(y.msg) order by (y.msg).created_at, (y.msg).id)
        from (
          select x as msg from public.chat_messages x
          where x.organization_id = d.organization_id and x.channel = 'fleet' and x.deleted_at is null
            and (x.author_driver_id is null or x.author_driver_id <> all (v_blocked)) and x.id <> all (v_reported)
          order by x.created_at desc, x.id desc limit 30
        ) y), '[]'::jsonb))
    into v_fleet;

  select coalesce(jsonb_agg(
           private.chat_message_json(s.msg) || jsonb_build_object('distance_m', s.distance_m, 'my_vote', s.my_vote)
           order by s.distance_m nulls last, (s.msg).created_at desc), '[]'::jsonb)
    into v_reports
    from (
      select x as msg,
             case when v_loc is not null
               then round(extensions.st_distance(v_loc,
                 extensions.st_setsrid(extensions.st_makepoint(x.lng, x.lat), 4326)::extensions.geography))::integer
             end as distance_m,
             (select v.still_there from public.chat_report_votes v
               where v.message_id = x.id and v.voter_key = v_reader) as my_vote
      from public.chat_messages x
      where x.organization_id = d.organization_id
        and x.report_type is not null
        and x.expires_at > now()
        and x.deleted_at is null
        and (x.author_driver_id is null or x.author_driver_id <> all (v_blocked))
        and x.id <> all (v_reported)
      order by x.created_at desc
      limit 100
    ) s;

  -- Chauffeurs masqués (« Réafficher » dans l'app) ; nom affiché comme dans les messages
  select coalesce(jsonb_agg(jsonb_build_object(
           'driver_id', b.blocked_driver_id,
           'name', btrim(x.first_name || ' ' || left(x.last_name, 1) || '.'),
           'blocked_at', b.created_at) order by b.created_at desc), '[]'::jsonb)
    into v_blocked_list
    from public.chat_blocks b
    join public.drivers x on x.id = b.blocked_driver_id
   where b.driver_id = d.id;

  -- Règles du fil « Chauffeurs » = CGU (§ 8) : acceptées à l'inscription par lien, ou dans l'application avant la
  -- première publication (accept_legal_documents, source « app ») ; quelle que soit la centrale enregistrée
  select max(a.version) into v_rules_version
    from public.legal_acceptances a
   where a.user_id = d.user_id and a.document = 'cgu';

  return jsonb_build_object(
    'driver_id', d.id,
    'organization_id', d.organization_id,
    'dispatch', v_dispatch,
    'fleet', v_fleet,
    'reports', v_reports,
    'blocked', v_blocked_list,
    'rules_version', v_rules_version,
    'unread_total', coalesce((v_dispatch ->> 'unread')::integer, 0) + coalesce((v_fleet ->> 'unread')::integer, 0));
end;
$$;

-- -----------------------------------------------------------------------------
-- vote_fleet_report (dernière définition : 20260924002300) : un signalement retiré par la
-- centrale est introuvable ; un chauffeur qui est aussi membre de la centrale vote en chauffeur
-- (seule l'application vote : son vote compte comme celui d'un chauffeur et s'affiche dans son fil)
-- -----------------------------------------------------------------------------
create or replace function public.vote_fleet_report(p_message_id uuid, p_still_there boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record;
  m public.chat_messages;
  v_org uuid;
  v_prev boolean;
  v_prev_at timestamptz;
  v_expire_now boolean;
begin
  if p_message_id is null or p_still_there is null then
    raise exception 'INVALID_VOTE: vote incomplet' using errcode = '22023';
  end if;
  select x.organization_id into v_org from public.chat_messages x where x.id = p_message_id and x.deleted_at is null;
  if not found then
    raise exception 'REPORT_NOT_FOUND: signalement introuvable' using errcode = 'P0002';
  end if;
  -- Contrôle d'accès AVANT tout verrou (chauffeur de l'org, identité chauffeur même s'il en est aussi membre ;
  -- sinon centrale)
  select * into c from private.chat_caller(
    case when private.current_driver_org_id() = v_org then null else v_org end, true);
  if c.org_id is distinct from v_org then
    raise exception 'FORBIDDEN_TENANT: accès refusé à ce signalement' using errcode = '42501';
  end if;
  perform private.set_actor(c.kind::public.actor_type, coalesce(c.driver_id, c.user_id));

  select * into m from public.chat_messages where id = p_message_id for update;
  -- (retiré par la centrale entre-temps : introuvable)
  if not found or m.deleted_at is not null then
    raise exception 'REPORT_NOT_FOUND: signalement introuvable' using errcode = 'P0002';
  end if;
  if m.report_type is null then
    raise exception 'NOT_A_REPORT: ce message n''est pas un signalement' using errcode = '22023';
  end if;
  if m.expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'REPORT_EXPIRED', 'message', 'Ce signalement a expiré.',
      'report', private.chat_message_json(m));
  end if;

  -- L'auteur ne confirme pas son propre signalement (il peut le retirer : « plus là »)
  if p_still_there and c.kind = 'driver' and m.author_driver_id = c.driver_id then
    return jsonb_build_object('ok', false, 'code', 'OWN_REPORT',
      'message', 'Vous ne pouvez pas confirmer votre propre signalement.', 'report', private.chat_message_json(m));
  end if;

  -- La ligne du signalement est verrouillée : les votes sont sérialisés.
  select v.still_there, v.updated_at into v_prev, v_prev_at from public.chat_report_votes v
   where v.message_id = m.id and v.voter_key = c.reader_key;
  if found and v_prev = p_still_there then
    return jsonb_build_object('ok', true, 'code', 'ALREADY_VOTED', 'report', private.chat_message_json(m),
      'my_vote', p_still_there, 'expired', false);
  end if;

  -- Limites de débit (chaque vote est diffusé à toute l'organisation) : une minute avant de changer
  -- d'avis sur un même signalement, 20 signalements votés par tranche de 10 min
  if v_prev_at is not null and v_prev_at > now() - interval '1 minute' then
    raise exception 'RATE_LIMITED: vous venez de voter, patientez une minute' using errcode = 'PT429';
  end if;
  if (select count(*) from public.chat_report_votes v
       where v.organization_id = m.organization_id and v.voter_key = c.reader_key
         and v.updated_at > now() - interval '10 minutes') >= 20 then
    raise exception 'RATE_LIMITED: trop de votes, patientez quelques minutes' using errcode = 'PT429';
  end if;

  insert into public.chat_report_votes as v (organization_id, message_id, voter_key, still_there)
  values (m.organization_id, m.id, c.reader_key, p_still_there)
  on conflict (message_id, voter_key) do update
    set still_there = excluded.still_there, updated_at = now();

  if p_still_there then
    -- Prolongation au PREMIER « toujours là » d'un votant seulement (pas en changeant d'avis),
    -- et durée de vie plafonnée à 3 h après la publication
    update public.chat_messages
       set confirmations = confirmations + 1,
           dismissals = case when v_prev is false then greatest(dismissals - 1, 0) else dismissals end,
           expires_at = case when v_prev is null
             then greatest(expires_at, least(now() + interval '30 minutes', created_at + interval '3 hours'))
             else expires_at end
     where id = m.id
    returning * into m;
  else
    v_expire_now := c.kind = 'user'
      or (c.kind = 'driver' and m.author_driver_id = c.driver_id)
      or m.dismissals + 1 >= 2;
    update public.chat_messages
       set dismissals = dismissals + 1,
           confirmations = case when v_prev is true then greatest(confirmations - 1, 0) else confirmations end,
           expires_at = case when v_expire_now then least(expires_at, now()) else expires_at end
     where id = m.id
    returning * into m;
    if v_expire_now then
      perform private.log_event(m.organization_id, null, 'fleet.report_cleared',
        format('Signalement retiré : %s', left(m.body, 200)), 'system', 'info',
        jsonb_build_object('message_id', m.id, 'report_type', m.report_type, 'dismissals', m.dismissals),
        c.kind::public.actor_type, coalesce(c.driver_id, c.user_id));
    end if;
  end if;

  return jsonb_build_object('ok', true, 'code', 'VOTED', 'report', private.chat_message_json(m),
    'my_vote', p_still_there, 'expired', not (m.expires_at > now()));
end;
$$;

-- -----------------------------------------------------------------------------
-- RPC : signaler un message du fil « Chauffeurs »
--   Chauffeur de la centrale du message (ou membre de la centrale) ; pas ses propres messages ni les
--   messages système ; un signalement par message et par auteur (nouvel appel : ALREADY_REPORTED) ;
--   10 signalements par tranche de 10 min et 50 par 24 h au plus. La centrale le voit dans sa messagerie
--   (événement temps réel « chat.moderation », file chat_moderation_queue).
--   Chauffeur qui est aussi membre de la centrale : il signale EN CHAUFFEUR (seule l'application signale) ;
--   le message disparaît de son fil. Ses propres messages ne sont signalables sous aucune de ses identités.
-- -----------------------------------------------------------------------------
create or replace function public.report_chat_message(p_message uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record;
  m public.chat_messages;
  r public.chat_message_reports;
  v_reason text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g')), '');
  v_recent integer;
  v_day integer;
begin
  if p_message is null then
    raise exception 'INVALID_MESSAGE: message manquant' using errcode = '22023';
  end if;
  if char_length(coalesce(v_reason, '')) > 200 then
    raise exception 'REASON_TOO_LONG: motif de 200 caractères maximum' using errcode = '22023';
  end if;
  select * into m from public.chat_messages x where x.id = p_message and x.deleted_at is null;
  if not found then
    raise exception 'MESSAGE_NOT_FOUND: message introuvable ou déjà retiré' using errcode = 'P0002';
  end if;
  -- Contrôle d'accès AVANT tout verrou : chauffeur de cette centrale (identité chauffeur, même s'il en est aussi
  -- membre), ou membre (p_write : pas le super admin)
  select * into c from private.chat_caller(
    case when private.current_driver_org_id() = m.organization_id then null else m.organization_id end, true);
  if c.org_id is distinct from m.organization_id then
    raise exception 'FORBIDDEN_TENANT: accès refusé à ce message' using errcode = '42501';
  end if;
  if m.channel <> 'fleet' or m.author_type = 'system' then
    raise exception 'NOT_REPORTABLE: seuls les messages du fil « Chauffeurs » peuvent être signalés' using errcode = '22023';
  end if;
  -- Ses messages de chauffeur comme ceux écrits depuis le tableau de bord (même personne, deux identités)
  if m.author_driver_id = private.current_driver_id() or m.author_user_id = auth.uid() then
    raise exception 'OWN_MESSAGE: vous ne pouvez pas signaler votre propre message' using errcode = '22023';
  end if;
  perform private.set_actor(c.kind::public.actor_type, coalesce(c.driver_id, c.user_id));

  -- Sérialisé par auteur : pas de doublon concurrent, limites exactes
  perform pg_advisory_xact_lock(hashtextextended('rydar.chat_report:' || c.reader_key, 0));
  select * into r from public.chat_message_reports x
   where x.message_id = m.id
     and (x.reporter_driver_id = c.driver_id or x.reporter_user_id = c.user_id);
  if found then
    return jsonb_build_object('ok', true, 'code', 'ALREADY_REPORTED', 'report_id', r.id, 'message_id', m.id,
      'status', r.status);
  end if;

  select count(*) filter (where x.created_at > now() - interval '10 minutes'), count(*)
    into v_recent, v_day
    from public.chat_message_reports x
   where (x.reporter_driver_id = c.driver_id or x.reporter_user_id = c.user_id)
     and x.created_at > now() - interval '24 hours';
  if v_recent >= 10 then
    raise exception 'RATE_LIMITED: trop de signalements, patientez quelques minutes' using errcode = 'PT429';
  end if;
  if v_day >= 50 then
    raise exception 'RATE_LIMITED: trop de signalements aujourd''hui, contactez votre centrale' using errcode = 'PT429';
  end if;

  insert into public.chat_message_reports (organization_id, message_id, reporter_type, reporter_driver_id,
    reporter_user_id, reason)
  values (m.organization_id, m.id, c.kind, c.driver_id, c.user_id, v_reason)
  returning * into r;

  -- Messagerie de la centrale à jour en temps réel (identifiants seulement : le canal org:<org> est lu par tous
  -- ses membres)
  perform realtime.send(
    jsonb_build_object('action', 'reported', 'organization_id', m.organization_id, 'message_id', m.id, 'report_id', r.id),
    'chat.moderation', 'org:' || m.organization_id::text, true);

  return jsonb_build_object('ok', true, 'code', 'REPORTED', 'report_id', r.id, 'message_id', m.id, 'status', r.status);
end;
$$;

-- -----------------------------------------------------------------------------
-- RPC : masquer / réafficher les messages d'un chauffeur (chauffeur connecté seulement)
-- -----------------------------------------------------------------------------
create or replace function public.block_chat_author(p_driver uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.drivers;
  t public.drivers;
  v_count integer;
begin
  select * into me from public.drivers where id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  if p_driver is null then
    raise exception 'INVALID_DRIVER: chauffeur manquant' using errcode = '22023';
  end if;
  if p_driver = me.id then
    raise exception 'CANNOT_BLOCK_SELF: vous ne pouvez pas masquer vos propres messages' using errcode = '22023';
  end if;
  select * into t from public.drivers where id = p_driver and organization_id = me.organization_id;
  if not found then
    raise exception 'FORBIDDEN_TENANT: chauffeur hors de votre centrale' using errcode = '42501';
  end if;
  perform private.set_actor('driver', me.id);

  insert into public.chat_blocks (organization_id, driver_id, blocked_driver_id)
  values (me.organization_id, me.id, t.id)
  on conflict (driver_id, blocked_driver_id) do nothing;
  get diagnostics v_count = row_count;

  return jsonb_build_object('ok', true, 'code', case when v_count > 0 then 'BLOCKED' else 'ALREADY_BLOCKED' end,
    'driver_id', t.id, 'name', btrim(t.first_name || ' ' || left(t.last_name, 1) || '.'));
end;
$$;

create or replace function public.unblock_chat_author(p_driver uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_driver_id();
  v_count integer;
begin
  if v_me is null then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  if p_driver is null then
    raise exception 'INVALID_DRIVER: chauffeur manquant' using errcode = '22023';
  end if;
  perform private.set_actor('driver', v_me);
  delete from public.chat_blocks where driver_id = v_me and blocked_driver_id = p_driver;
  get diagnostics v_count = row_count;
  return jsonb_build_object('ok', true, 'code', case when v_count > 0 then 'UNBLOCKED' else 'NOT_BLOCKED' end,
    'driver_id', p_driver);
end;
$$;

-- -----------------------------------------------------------------------------
-- RPC : la centrale retire un message du fil « Chauffeurs » (owner / admin / dispatcher)
--   Message masqué pour tous (deleted_at, removed_by), signalements → removed, alertes encore en file
--   annulées, texte retiré du journal (fleet.report), audit, temps réel. Nouvel appel : ALREADY_REMOVED ;
--   message supprimé entre-temps (compte de l'auteur, purge) : MESSAGE_NOT_FOUND, sans audit ni diffusion.
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- RPC : la centrale classe un signalement (« Ignorer » : le message est jugé acceptable).
--   Tous les signalements ouverts de ce message sont classés ensemble. Déjà traité : ALREADY_RESOLVED, avec
--   status « removed » (message retiré entre-temps par un autre membre), « dismissed » (déjà classé) ou null
--   (signalement effacé avec le compte de son auteur). Message supprimé entre-temps : MESSAGE_NOT_FOUND.
-- -----------------------------------------------------------------------------
create or replace function public.dismiss_chat_report(p_report uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.chat_message_reports;
  v_uid uuid := auth.uid();
  v_count integer;
  v_removed boolean;
  v_status text;
begin
  if p_report is null then
    raise exception 'INVALID_REPORT: signalement manquant' using errcode = '22023';
  end if;
  select * into r from public.chat_message_reports where id = p_report;
  if not found then
    raise exception 'REPORT_NOT_FOUND: signalement introuvable' using errcode = 'P0002';
  end if;
  perform private.assert_org_member(r.organization_id, array['owner', 'admin', 'dispatcher']::public.org_role[]);
  if v_uid is null then
    raise exception 'FORBIDDEN: authentification requise' using errcode = '42501';
  end if;
  perform private.set_actor('user', v_uid);

  -- Même verrou que remove_chat_message : « Supprimer » et « Ignorer » simultanés ne se croisent pas
  select x.deleted_at is not null into v_removed from public.chat_messages x where x.id = r.message_id for update;
  -- Supprimé entre la première lecture et le verrou (compte de l'auteur supprimé, purge) : signalements avec lui
  if not found then
    raise exception 'MESSAGE_NOT_FOUND: message introuvable' using errcode = 'P0002';
  end if;
  update public.chat_message_reports
     set status = 'dismissed', resolved_at = now(), resolved_by = v_uid
   where message_id = r.message_id and status = 'open';
  get diagnostics v_count = row_count;
  if v_count = 0 then
    -- Message retiré : « removed », même pour un signalement classé auparavant (le tableau de bord le retire)
    select x.status into v_status from public.chat_message_reports x where x.id = p_report;
    return jsonb_build_object('ok', true, 'code', 'ALREADY_RESOLVED', 'message_id', r.message_id,
      'status', case when v_removed then 'removed' else v_status end);
  end if;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (r.organization_id, 'user', v_uid, 'chat.report_dismissed', 'chat_messages', r.message_id::text, 'info',
    jsonb_build_object('reports', v_count));

  perform realtime.send(
    jsonb_build_object('action', 'dismissed', 'organization_id', r.organization_id, 'message_id', r.message_id,
      'report_id', r.id),
    'chat.moderation', 'org:' || r.organization_id::text, true);

  return jsonb_build_object('ok', true, 'code', 'DISMISSED', 'message_id', r.message_id, 'dismissed', v_count);
end;
$$;

-- -----------------------------------------------------------------------------
-- RPC : signalements ouverts (dashboard) — un élément par message signalé, du plus récent au plus ancien.
--   Membres de la centrale (et super admin, lecture seule).
-- -----------------------------------------------------------------------------
create or replace function public.chat_moderation_queue(p_org uuid, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_open integer;
  v_items jsonb;
begin
  perform private.assert_org_reader(p_org);

  select count(distinct r.message_id) into v_open
    from public.chat_message_reports r
    join public.chat_messages x on x.id = r.message_id
   where r.organization_id = p_org and r.status = 'open' and x.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
           'message', private.chat_message_json(x),
           'report_count', g.report_count,
           'first_reported_at', g.first_at,
           'last_reported_at', g.last_at,
           'reports', g.reports) order by g.last_at desc, x.id), '[]'::jsonb)
    into v_items
    from (
      select r.message_id,
             count(*)::integer as report_count,
             min(r.created_at) as first_at,
             max(r.created_at) as last_at,
             jsonb_agg(jsonb_build_object(
               'id', r.id,
               'reason', r.reason,
               'created_at', r.created_at,
               'reporter_type', r.reporter_type,
               'reporter_name', case
                 when r.reporter_type = 'driver' then btrim(d.first_name || ' ' || left(d.last_name, 1) || '.')
                 else coalesce(nullif(btrim(u.full_name), ''), nullif(split_part(u.email, '@', 1), ''), 'Centrale')
               end) order by r.created_at) as reports
        from public.chat_message_reports r
        join public.chat_messages y on y.id = r.message_id and y.deleted_at is null
        left join public.drivers d on d.id = r.reporter_driver_id
        left join public.users u on u.id = r.reporter_user_id
       where r.organization_id = p_org and r.status = 'open'
       group by r.message_id
       order by max(r.created_at) desc
       limit greatest(1, least(coalesce(p_limit, 50), 200))
    ) g
    join public.chat_messages x on x.id = g.message_id;

  return jsonb_build_object('organization_id', p_org, 'open', v_open, 'items', v_items);
end;
$$;

-- -----------------------------------------------------------------------------
-- Droits d'exécution (cf. 20260924000900_function_grants.sql)
-- -----------------------------------------------------------------------------
-- Fonction de déclencheur : jamais appelée directement (deny-by-default, comme 20260924004000)
revoke execute on function private.chat_forget_deleted_driver() from public, anon, authenticated, service_role;

revoke execute on function
  public.send_chat_message(uuid, text, uuid, text, text, double precision, double precision),
  public.chat_overview(uuid),
  public.driver_chat_overview(),
  public.vote_fleet_report(uuid, boolean),
  public.report_chat_message(uuid, text),
  public.block_chat_author(uuid),
  public.unblock_chat_author(uuid),
  public.remove_chat_message(uuid),
  public.dismiss_chat_report(uuid),
  public.chat_moderation_queue(uuid, integer)
from public, anon;
grant execute on function
  public.send_chat_message(uuid, text, uuid, text, text, double precision, double precision),
  public.chat_overview(uuid),
  public.driver_chat_overview(),
  public.vote_fleet_report(uuid, boolean),
  public.report_chat_message(uuid, text),
  public.block_chat_author(uuid),
  public.unblock_chat_author(uuid),
  public.remove_chat_message(uuid),
  public.dismiss_chat_report(uuid),
  public.chat_moderation_queue(uuid, integer)
to authenticated, service_role;
