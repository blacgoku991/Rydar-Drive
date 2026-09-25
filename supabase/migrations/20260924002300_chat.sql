-- =============================================================================
-- Rydar Drive — Messagerie centrale ⇄ chauffeurs + signalements de la flotte
--
--  Fils de discussion (thread_key) :
--    * « driver:<driver_id> » : fil direct entre la centrale et UN chauffeur ;
--    * « fleet »              : fil de toute l'organisation (centrale + chauffeurs).
--  Signalements (police, contrôle, accident, bouchon, danger, autre) : messages
--  géolocalisés du fil flotte, à durée de vie limitée, confirmés / infirmés par
--  les votes des chauffeurs (vote_fleet_report).
--
--  Lecture : RLS (membres de l'org + super admin : tout ; chauffeur : flotte de
--  son org + son propre fil direct). Écritures : RPC uniquement.
--  Temps réel (realtime.send, canaux privés) :
--    'chat.message' → org:<org> + driver:<id> (fil direct) | fleet:<org> (flotte)
--    'chat.report'  → org:<org> + fleet:<org> (votes / expiration d'un signalement)
--    'chat.read'    → accusés de lecture (org:<org> / driver:<id>)
--  Push (outbox notifications) : 'chat_message' (centrale → chauffeur, high),
--    'fleet_report' (chauffeurs en ligne à ≤ 25 km, normal : les offres de course
--    restent prioritaires dans la file du worker).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  channel text not null check (channel in ('driver', 'fleet')),
  -- Fil direct : le chauffeur concerné ; null pour le fil flotte
  driver_id uuid,
  author_type text not null check (author_type in ('user', 'driver', 'system')),
  author_user_id uuid references public.users (id) on delete set null,
  author_driver_id uuid,
  author_name text not null check (char_length(author_name) between 1 and 120),
  body text not null check (char_length(body) between 1 and 1000),
  report_type text check (report_type in ('police', 'control', 'accident', 'traffic', 'danger', 'other')),
  lat double precision check (lat between -90 and 90),
  lng double precision check (lng between -180 and 180),
  expires_at timestamptz,
  confirmations integer not null default 0 check (confirmations >= 0),
  dismissals integer not null default 0 check (dismissals >= 0),
  created_at timestamptz not null default clock_timestamp(),
  unique (organization_id, id),
  foreign key (organization_id, driver_id) references public.drivers (organization_id, id) on delete cascade,
  foreign key (organization_id, author_driver_id) references public.drivers (organization_id, id)
    on delete set null (author_driver_id),
  -- fil direct ⇔ driver_id
  constraint chat_messages_thread_chk check ((channel = 'driver') = (driver_id is not null)),
  -- un chauffeur n'écrit que dans son propre fil direct
  constraint chat_messages_direct_author_chk check (
    channel <> 'driver' or author_driver_id is null or author_driver_id = driver_id
  ),
  constraint chat_messages_author_chk check (
    (author_type = 'user' and author_driver_id is null)
    or (author_type = 'driver' and author_user_id is null)
    or (author_type = 'system' and author_user_id is null and author_driver_id is null)
  ),
  constraint chat_messages_position_chk check ((lat is null) = (lng is null)),
  -- signalement ⇒ fil flotte + position + expiration ; message simple ⇒ pas d'expiration
  constraint chat_messages_report_chk check (
    (report_type is null and expires_at is null)
    or (report_type is not null and channel = 'fleet' and lat is not null and expires_at is not null)
  )
);
create index chat_messages_thread_idx on public.chat_messages (organization_id, channel, driver_id, created_at desc);
create index chat_messages_reports_idx on public.chat_messages (organization_id, expires_at desc) where report_type is not null;
create index chat_messages_author_user_idx on public.chat_messages (author_user_id, created_at desc) where author_user_id is not null;
create index chat_messages_author_driver_idx on public.chat_messages (author_driver_id, created_at desc) where author_driver_id is not null;
create index chat_messages_created_idx on public.chat_messages (created_at);

-- Accusés de lecture : une ligne par lecteur et par fil
create table public.chat_reads (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  reader_key text not null
    check (reader_key ~ '^(user|driver):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  thread_key text not null
    check (thread_key = 'fleet' or thread_key ~ '^driver:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  last_read_at timestamptz not null default now(),
  primary key (organization_id, reader_key, thread_key)
);
create index chat_reads_thread_idx on public.chat_reads (organization_id, thread_key);

-- Votes sur les signalements : un vote par personne (modifiable) et par signalement
create table public.chat_report_votes (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  message_id uuid not null,
  voter_key text not null
    check (voter_key ~ '^(user|driver):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  still_there boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (message_id, voter_key),
  foreign key (organization_id, message_id) references public.chat_messages (organization_id, id) on delete cascade
);

create trigger chat_messages_forbid_org_change
  before update of organization_id on public.chat_messages
  for each row execute function private.forbid_org_change();
create trigger chat_reads_forbid_org_change
  before update of organization_id on public.chat_reads
  for each row execute function private.forbid_org_change();
create trigger chat_report_votes_forbid_org_change
  before update of organization_id on public.chat_report_votes
  for each row execute function private.forbid_org_change();

-- Limite de débit des votes (vote_fleet_report)
create index chat_report_votes_voter_idx on public.chat_report_votes (voter_key, updated_at desc);

-- Horodatage à la VALIDATION : created_at reprend l'heure du commit (déclencheur différé). Sans cela, un
-- message inséré avant mais validé après une lecture (autre auteur, transaction plus longue) porterait une
-- heure antérieure au repère « lu jusqu'à » et ne serait jamais compté comme non lu.
create or replace function private.chat_stamp_at_commit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_at timestamptz := clock_timestamp();
begin
  update public.chat_messages set created_at = v_at where id = new.id and created_at < v_at;
  -- « écrire vaut lecture » (send_chat_message) : le repère de l'auteur suit son message
  update public.chat_reads
     set last_read_at = v_at
   where organization_id = new.organization_id
     and thread_key = case when new.channel = 'fleet' then 'fleet' else 'driver:' || new.driver_id::text end
     and reader_key = case new.author_type
                        when 'driver' then 'driver:' || new.author_driver_id::text
                        when 'user' then 'user:' || new.author_user_id::text
                      end
     and last_read_at >= new.created_at
     and last_read_at < v_at;
  return null;
end;
$$;

revoke execute on function private.chat_stamp_at_commit() from public, anon, authenticated;

create constraint trigger chat_messages_stamp_commit
  after insert on public.chat_messages
  deferrable initially deferred
  for each row execute function private.chat_stamp_at_commit();

-- -----------------------------------------------------------------------------
-- RLS : lecture seule côté client, écritures via RPC
-- -----------------------------------------------------------------------------
alter table public.chat_messages enable row level security;
alter table public.chat_reads enable row level security;
alter table public.chat_report_votes enable row level security;

create policy chat_messages_select on public.chat_messages for select to authenticated
  using (
    organization_id in (select private.member_org_ids())
    or (select private.is_super_admin())
    or (
      organization_id = (select private.current_driver_org_id())
      and (channel = 'fleet' or driver_id = (select private.current_driver_id()))
    )
  );

create policy chat_reads_select on public.chat_reads for select to authenticated
  using (
    reader_key = 'user:' || coalesce((select auth.uid())::text, '-')
    or reader_key = 'driver:' || coalesce((select private.current_driver_id())::text, '-')
  );

create policy chat_report_votes_select on public.chat_report_votes for select to authenticated
  using (
    voter_key = 'user:' || coalesce((select auth.uid())::text, '-')
    or voter_key = 'driver:' || coalesce((select private.current_driver_id())::text, '-')
  );

-- Les privilèges par défaut (Supabase) accordent tout à anon / authenticated : on restreint.
revoke all on public.chat_messages, public.chat_reads, public.chat_report_votes from public, anon, authenticated;
grant select on public.chat_messages, public.chat_reads, public.chat_report_votes to authenticated;
grant all on public.chat_messages, public.chat_reads, public.chat_report_votes to service_role;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
-- Représentation JSON d'un message (RPC + temps réel) : colonnes + clé de fil.
create or replace function private.chat_message_json(m public.chat_messages)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select to_jsonb(m) || jsonb_build_object(
    'thread', case when m.channel = 'fleet' then 'fleet' else 'driver:' || m.driver_id::text end,
    'active', m.report_type is not null and m.expires_at > now()
  );
$$;

-- Qui appelle ? Chauffeur connecté (application) ou membre de la centrale.
--  * chauffeur : p_org null ou égal à son organisation (et pas membre de celle-ci) ;
--  * centrale  : p_write → rôle owner/admin/dispatcher ; sinon membre ou super admin.
-- Lève 42501 dans tous les autres cas (autre tenant, anonyme, compte inactif).
create or replace function private.chat_caller(
  p_org uuid,
  p_write boolean,
  out kind text,
  out org_id uuid,
  out driver_id uuid,
  out user_id uuid,
  out reader_key text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_driver uuid := private.current_driver_id();
  v_driver_org uuid;
begin
  if v_driver is not null then
    select d.organization_id into v_driver_org from public.drivers d where d.id = v_driver;
    if p_org is null or (p_org = v_driver_org and not private.is_org_member(p_org)) then
      kind := 'driver';
      org_id := v_driver_org;
      driver_id := v_driver;
      user_id := null;
      reader_key := 'driver:' || v_driver::text;
      return;
    end if;
  end if;

  if p_org is null then
    raise exception 'FORBIDDEN: organisation manquante' using errcode = '42501';
  end if;
  if p_write then
    perform private.assert_org_member(p_org, array['owner', 'admin', 'dispatcher']::public.org_role[]);
  else
    perform private.assert_org_reader(p_org);
  end if;
  if auth.uid() is null then
    raise exception 'FORBIDDEN: authentification requise' using errcode = '42501';
  end if;
  kind := 'user';
  org_id := p_org;
  driver_id := null;
  user_id := auth.uid();
  reader_key := 'user:' || auth.uid()::text;
end;
$$;

-- Diffusion temps réel des messages et des mises à jour de signalements.
create or replace function private.broadcast_chat_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
begin
  if current_setting('rydar.bypass_ride_rules', true) = 'on' then
    return null;
  end if;
  if tg_op = 'INSERT' then
    v_payload := private.chat_message_json(new);
    perform realtime.send(v_payload, 'chat.message', 'org:' || new.organization_id::text, true);
    if new.channel = 'fleet' then
      perform realtime.send(v_payload, 'chat.message', 'fleet:' || new.organization_id::text, true);
    else
      perform realtime.send(v_payload, 'chat.message', 'driver:' || new.driver_id::text, true);
    end if;
  elsif new.report_type is not null
    and (new.expires_at, new.confirmations, new.dismissals) is distinct from (old.expires_at, old.confirmations, old.dismissals) then
    v_payload := jsonb_build_object(
      'id', new.id, 'organization_id', new.organization_id, 'report_type', new.report_type,
      'expires_at', new.expires_at, 'confirmations', new.confirmations, 'dismissals', new.dismissals,
      'active', new.expires_at > now());
    perform realtime.send(v_payload, 'chat.report', 'org:' || new.organization_id::text, true);
    perform realtime.send(v_payload, 'chat.report', 'fleet:' || new.organization_id::text, true);
  end if;
  return null;
end;
$$;

create trigger chat_messages_broadcast
  after insert or update of expires_at, confirmations, dismissals on public.chat_messages
  for each row execute function private.broadcast_chat_message();

-- -----------------------------------------------------------------------------
-- RPC : envoyer un message / un signalement
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
-- RPC : marquer un fil comme lu
-- -----------------------------------------------------------------------------
create or replace function public.mark_chat_read(p_org uuid, p_thread text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record;
  v_thread text := lower(btrim(coalesce(p_thread, '')));
  v_driver uuid;
  v_at timestamptz;
  v_prev timestamptz;
  v_new timestamptz;
  v_payload jsonb;
begin
  select * into c from private.chat_caller(p_org, false);

  if v_thread = 'fleet' then
    v_driver := null;
  elsif v_thread ~ '^driver:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_driver := substr(v_thread, 8)::uuid;
    if c.kind = 'driver' then
      if v_driver <> c.driver_id then
        raise exception 'FORBIDDEN: fil direct d''un autre chauffeur' using errcode = '42501';
      end if;
    elsif not exists (select 1 from public.drivers d where d.id = v_driver and d.organization_id = c.org_id) then
      raise exception 'FORBIDDEN_TENANT: chauffeur hors de votre organisation' using errcode = '42501';
    end if;
  else
    raise exception 'INVALID_THREAD: fil de discussion inconnu' using errcode = '22023';
  end if;

  -- Lu jusqu'au dernier message visible du fil (ou maintenant si le fil est vide)
  if v_driver is null then
    select max(x.created_at) into v_at from public.chat_messages x
     where x.organization_id = c.org_id and x.channel = 'fleet';
  else
    select max(x.created_at) into v_at from public.chat_messages x
     where x.organization_id = c.org_id and x.channel = 'driver' and x.driver_id = v_driver;
  end if;
  v_at := coalesce(v_at, now());

  select r.last_read_at into v_prev from public.chat_reads r
   where r.organization_id = c.org_id and r.reader_key = c.reader_key and r.thread_key = v_thread;

  insert into public.chat_reads as cr (organization_id, reader_key, thread_key, last_read_at)
  values (c.org_id, c.reader_key, v_thread, v_at)
  on conflict (organization_id, reader_key, thread_key) do update
    set last_read_at = greatest(cr.last_read_at, excluded.last_read_at)
  returning cr.last_read_at into v_new;

  if v_prev is null or v_new > v_prev then
    v_payload := jsonb_build_object('organization_id', c.org_id, 'thread', v_thread, 'reader_key', c.reader_key,
      'reader_type', c.kind, 'last_read_at', v_new);
    if c.kind = 'user' then
      perform realtime.send(v_payload, 'chat.read', 'org:' || c.org_id::text, true);
      if v_driver is not null then
        perform realtime.send(v_payload, 'chat.read', 'driver:' || v_driver::text, true);
      end if;
    else
      perform realtime.send(v_payload, 'chat.read', 'driver:' || c.driver_id::text, true);
      if v_driver is not null then
        perform realtime.send(v_payload, 'chat.read', 'org:' || c.org_id::text, true);
      end if;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'thread', v_thread, 'last_read_at', v_new);
end;
$$;

-- -----------------------------------------------------------------------------
-- RPC : vue d'ensemble de la messagerie (dashboard rattacheur)
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
        where x.organization_id = p_org and x.channel = 'fleet'
          and x.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
          and x.author_user_id is distinct from v_uid),
      'last_message', (
        select private.chat_message_json(x) from public.chat_messages x
        where x.organization_id = p_org and x.channel = 'fleet'
        order by x.created_at desc, x.id desc limit 1),
      'active_reports', (
        select count(*) from public.chat_messages x
        where x.organization_id = p_org and x.report_type is not null and x.expires_at > now()))
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
                 where x.organization_id = p_org and x.channel = 'driver' and x.driver_id = d.id
                   and x.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
                   and x.author_user_id is distinct from v_uid),
               'driver_last_read_at', dr.last_read_at
             ) as obj
      from public.drivers d
      left join lateral (
        select x as msg from public.chat_messages x
        where x.organization_id = p_org and x.channel = 'driver' and x.driver_id = d.id
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

  return jsonb_build_object('organization_id', p_org, 'fleet', v_fleet, 'drivers', v_drivers,
    'unread_total', v_unread_total);
end;
$$;

-- -----------------------------------------------------------------------------
-- RPC : vue d'ensemble côté chauffeur (centrale, flotte, signalements actifs)
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

  select jsonb_build_object(
      'thread', v_thread,
      'last_read_at', v_dispatch_read,
      'unread', (
        select count(*) from public.chat_messages x
        where x.organization_id = d.organization_id and x.channel = 'driver' and x.driver_id = d.id
          and x.created_at > coalesce(v_dispatch_read, '-infinity'::timestamptz)
          and x.author_driver_id is distinct from d.id),
      'seen_by_dispatch_at', (
        select max(r.last_read_at) from public.chat_reads r
        where r.organization_id = d.organization_id and r.thread_key = v_thread and r.reader_key like 'user:%'),
      'last_message', (
        select private.chat_message_json(x) from public.chat_messages x
        where x.organization_id = d.organization_id and x.channel = 'driver' and x.driver_id = d.id
        order by x.created_at desc, x.id desc limit 1),
      'messages', coalesce((
        select jsonb_agg(private.chat_message_json(y.msg) order by (y.msg).created_at, (y.msg).id)
        from (
          select x as msg from public.chat_messages x
          where x.organization_id = d.organization_id and x.channel = 'driver' and x.driver_id = d.id
          order by x.created_at desc, x.id desc limit 30
        ) y), '[]'::jsonb))
    into v_dispatch;

  select jsonb_build_object(
      'thread', 'fleet',
      'last_read_at', v_fleet_read,
      'unread', (
        select count(*) from public.chat_messages x
        where x.organization_id = d.organization_id and x.channel = 'fleet'
          and x.created_at > coalesce(v_fleet_read, '-infinity'::timestamptz)
          and x.author_driver_id is distinct from d.id),
      'last_message', (
        select private.chat_message_json(x) from public.chat_messages x
        where x.organization_id = d.organization_id and x.channel = 'fleet'
        order by x.created_at desc, x.id desc limit 1),
      'messages', coalesce((
        select jsonb_agg(private.chat_message_json(y.msg) order by (y.msg).created_at, (y.msg).id)
        from (
          select x as msg from public.chat_messages x
          where x.organization_id = d.organization_id and x.channel = 'fleet'
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
      order by x.created_at desc
      limit 100
    ) s;

  return jsonb_build_object(
    'driver_id', d.id,
    'organization_id', d.organization_id,
    'dispatch', v_dispatch,
    'fleet', v_fleet,
    'reports', v_reports,
    'unread_total', coalesce((v_dispatch ->> 'unread')::integer, 0) + coalesce((v_fleet ->> 'unread')::integer, 0));
end;
$$;

-- -----------------------------------------------------------------------------
-- RPC : « toujours là ? » sur un signalement
--   toujours là → confirmations + 1, expiration repoussée à ≥ now + 30 min ;
--   plus là     → dismissals + 1 ; expiré si l'auteur, la centrale ou ≥ 2 votes.
--   Un vote par personne et par signalement (modifiable).
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
  select x.organization_id into v_org from public.chat_messages x where x.id = p_message_id;
  if not found then
    raise exception 'REPORT_NOT_FOUND: signalement introuvable' using errcode = 'P0002';
  end if;
  -- Contrôle d'accès AVANT tout verrou (chauffeur de l'org ou centrale)
  select * into c from private.chat_caller(v_org, true);
  if c.org_id is distinct from v_org then
    raise exception 'FORBIDDEN_TENANT: accès refusé à ce signalement' using errcode = '42501';
  end if;
  perform private.set_actor(c.kind::public.actor_type, coalesce(c.driver_id, c.user_id));

  select * into m from public.chat_messages where id = p_message_id for update;
  if not found then
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
-- Temps réel : nouveau topic fleet:<org> (membres de l'org + chauffeurs de l'org)
-- Reprend à l'identique les conditions de 20260924000600_realtime.sql.
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists rydar_realtime_receive on realtime.messages';
    execute $pol$
      create policy rydar_realtime_receive on realtime.messages
      for select to authenticated
      using (
        (
          (select realtime.topic()) like 'org:%'
          and (
            split_part((select realtime.topic()), ':', 2) in (select m::text from private.member_org_ids() as m)
            or (select private.is_super_admin())
          )
        )
        or (select realtime.topic()) = 'driver:' || coalesce((select private.current_driver_id())::text, '-')
        or (
          (select realtime.topic()) like 'fleet:%'
          and (
            split_part((select realtime.topic()), ':', 2) in (select m::text from private.member_org_ids() as m)
            or (select realtime.topic()) = 'fleet:' || coalesce((select private.current_driver_org_id())::text, '-')
            or (select private.is_super_admin())
          )
        )
      )
    $pol$;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Ménage : dernière définition (20260924000400) + purge des messages > 180 jours
-- -----------------------------------------------------------------------------
create or replace function private.housekeeping()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ghosts integer;
  v_history integer;
  v_logs integer;
  v_docs integer;
  v_notifs integer;
  v_chat integer;
begin
  -- Chauffeurs « fantômes » : disponibles mais sans position depuis 15 min
  with g as (
    update public.drivers d
       set presence = 'offline', online_since = null
     where d.presence = 'available'
       and not exists (
         select 1 from public.driver_locations l
         where l.driver_id = d.id and l.updated_at > now() - interval '15 minutes'
       )
    returning d.id
  )
  select count(*) into v_ghosts from g;

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
  delete from public.notifications where created_at < now() - interval '90 days' and status in ('sent', 'cancelled');
  get diagnostics v_notifs = row_count;
  delete from public.chat_messages where created_at < now() - interval '180 days';
  get diagnostics v_chat = row_count;

  return jsonb_build_object('ghost_drivers', v_ghosts, 'history_purged', v_history, 'api_logs_purged', v_logs,
    'documents_expired', v_docs, 'notifications_purged', v_notifs, 'chat_purged', v_chat);
end;
$$;

-- -----------------------------------------------------------------------------
-- Droits d'exécution (cf. 20260924000900_function_grants.sql)
-- -----------------------------------------------------------------------------
revoke execute on function
  private.chat_message_json(public.chat_messages),
  private.chat_caller(uuid, boolean),
  private.broadcast_chat_message(),
  private.housekeeping()
from public, anon, authenticated;
grant execute on function
  private.chat_message_json(public.chat_messages),
  private.chat_caller(uuid, boolean),
  private.broadcast_chat_message(),
  private.housekeeping()
to service_role;

revoke execute on function
  public.send_chat_message(uuid, text, uuid, text, text, double precision, double precision),
  public.mark_chat_read(uuid, text),
  public.chat_overview(uuid),
  public.driver_chat_overview(),
  public.vote_fleet_report(uuid, boolean)
from public, anon;
grant execute on function
  public.send_chat_message(uuid, text, uuid, text, text, double precision, double precision),
  public.mark_chat_read(uuid, text),
  public.chat_overview(uuid),
  public.driver_chat_overview(),
  public.vote_fleet_report(uuid, boolean)
to authenticated, service_role;
