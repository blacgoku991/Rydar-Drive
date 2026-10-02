-- =============================================================================
-- Rydar Drive — Webhooks sortants : à chaque changement d'une course, Rydar Drive envoie (POST JSON signé) un
-- événement aux adresses enregistrées par la centrale (API v1 /api/v1/webhooks, scope « webhooks:manage », ou
-- dashboard › Intégrations, propriétaire et administrateurs).
--
--  * public.webhook_endpoints : adresses https:// de la centrale (10 au plus), événements suivis (vide = tous),
--    activée ou non, compteurs d'échecs. Lecture : propriétaire et administrateurs de la centrale, super admin (RLS).
--    Écriture : fonctions public.svc_webhook_* (web, service role ; auteur revérifié, journal d'audit).
--  * public.webhook_endpoint_secrets : secret de signature (HMAC-SHA256) de chaque adresse — service role et
--    propriétaire des tables seulement ; jamais renvoyé au navigateur ni écrit dans le journal d'audit. Montré une
--    seule fois : à la création (secret généré) et au renouvellement.
--  * public.webhook_deliveries : un envoi par (adresse, événement). AUCUN contenu stocké : le worker construit le
--    corps au moment de l'envoi à partir de l'état COURANT de la course (minimisation des données) ; seuls le type,
--    la transition (statut, statut précédent) et l'heure de l'événement sont gardés. L'identifiant de l'envoi est
--    celui de l'événement (« id », en-tête X-Rydar-Delivery), stable d'un essai à l'autre : le destinataire
--    dédoublonne dessus.
--  * Détection (déclencheurs sur public.rides) : création → ride.created (sauf import direct,
--    rydar.bypass_ride_rules) ; changement de statut → ride.accepted, ride.driver_en_route, ride.driver_arrived,
--    ride.passenger_onboard, ride.in_progress, ride.completed, ride.cancelled, ride.no_driver_found ; retour en
--    recherche ou en attente d'un chauffeur retiré → ride.driver_unassigned ; course « acceptée » passée à un autre
--    chauffeur → ride.accepted ; heure de prise en charge modifiée (course ni terminée, ni annulée, ni sans
--    chauffeur) → ride.rescheduled (en plus de l'événement de statut du même changement ; « Relancer » une course
--    passée remet son heure à maintenant). Le reste (vagues du dispatch, offres) ne produit rien.
--  * Envoi (apps/worker) : réveil immédiat par pg_notify('rydar_webhooks') ; private.claim_webhook_deliveries prend
--    un lot (verrou 2 min), private.complete_webhook_delivery rend compte ; nouvel essai après 1 min, 5 min, 15 min,
--    1 h, 3 h, 6 h, 12 h puis 24 h ; échec définitif au 9e échec. Adresse désactivée d'office après 50 échecs
--    consécutifs sans succès depuis 3 jours (ses envois en attente passent en échec).
--  * Conservation (private.purge_webhook_deliveries, ménage du worker) : envois terminés 30 jours, tout envoi 45 jours.
--  * Adresses : https:// seulement, sans identifiants, ni « localhost », ni adresse IP privée, locale ou réservée
--    (contrôle repris par le worker après résolution DNS, au moment de chaque envoi).
-- =============================================================================

-- ----------------------------------------------------------------- adresses des centrales
create table public.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- https:// exigé par svc_webhook_upsert ; http:// toléré ici pour les essais locaux (WEBHOOK_ALLOW_PRIVATE_URLS=1)
  url text not null check (
    char_length(url) between 10 and 500 and url ~* '^https?://' and url !~ '[\x01-\x20\x7f-\x9f\x2028\x2029]'),
  description text check (
    description is null or (char_length(description) between 1 and 120 and description !~ '[\x01-\x1f\x7f-\x9f\x2028\x2029]')),
  events text[] not null default '{}' check (
    array_position(events, null) is null
    and events <@ array['ride.created', 'ride.accepted', 'ride.driver_unassigned', 'ride.driver_en_route',
                        'ride.driver_arrived', 'ride.passenger_onboard', 'ride.in_progress', 'ride.completed',
                        'ride.cancelled', 'ride.no_driver_found', 'ride.rescheduled']::text[]),
  enabled boolean not null default true,
  disabled_reason text check (disabled_reason is null or char_length(disabled_reason) <= 200),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  created_by_type public.actor_type,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, url)
);
comment on table public.webhook_endpoints is
  'Webhooks sortants de la centrale (10 au plus) — lecture : propriétaire, administrateurs, super admin ; écriture : svc_webhook_*.';
comment on column public.webhook_endpoints.events is 'Événements suivis ; vide = tous les événements (ride.*).';
comment on column public.webhook_endpoints.disabled_reason is
  'Motif d''une désactivation automatique (échecs répétés) ; null pour une désactivation manuelle.';
comment on column public.webhook_endpoints.consecutive_failures is
  'Échecs d''envoi consécutifs (remis à zéro au premier succès ou à la réactivation).';
comment on column public.webhook_endpoints.last_error is 'Dernière erreur d''envoi (code HTTP ou motif réseau), 500 caractères au plus.';
comment on column public.webhook_endpoints.created_by is 'Auteur : utilisateur (dashboard) ou clé API (created_by_type = api).';

-- ----------------------------------------------------------------- secrets de signature
create table public.webhook_endpoint_secrets (
  endpoint_id uuid primary key references public.webhook_endpoints (id) on delete cascade,
  secret text not null check (char_length(secret) between 32 and 200),
  updated_at timestamptz not null default now()
);
comment on table public.webhook_endpoint_secrets is
  'Secret HMAC de chaque webhook — service role uniquement, jamais renvoyé au navigateur ni journalisé.';

-- ----------------------------------------------------------------- envois
create table public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  endpoint_id uuid not null references public.webhook_endpoints (id) on delete cascade,
  ride_id uuid references public.rides (id) on delete set null,
  event_type text not null check (event_type in (
    'ride.created', 'ride.accepted', 'ride.driver_unassigned', 'ride.driver_en_route', 'ride.driver_arrived',
    'ride.passenger_onboard', 'ride.in_progress', 'ride.completed', 'ride.cancelled', 'ride.no_driver_found',
    'ride.rescheduled', 'ping')),
  event_status public.ride_status,
  previous_status public.ride_status,
  occurred_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'sending', 'delivered', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_status_code integer check (last_status_code is null or last_status_code between 0 and 999),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
comment on table public.webhook_deliveries is
  'Envois des webhooks (un par adresse et par événement), sans contenu : le corps est construit à l''envoi depuis l''état courant de la course.';
comment on column public.webhook_deliveries.id is 'Identifiant de l''événement (« id », X-Rydar-Delivery), identique à chaque essai.';
comment on column public.webhook_deliveries.event_status is 'Statut de la course après le changement (data.status) ; null pour « ping ».';
comment on column public.webhook_deliveries.previous_status is 'Statut avant le changement (data.previous_status) ; null à la création et pour « ping ».';
comment on column public.webhook_deliveries.attempts is 'Essais en échec (comptés par private.complete_webhook_delivery) ; échec définitif au 9e.';
comment on column public.webhook_deliveries.locked_until is 'Envoi en cours jusqu''à cette heure ; passé ce délai, la ligne est reprise (worker arrêté).';

-- Envois dus (en attente ou en cours), pris par private.claim_webhook_deliveries
create index webhook_deliveries_due_idx on public.webhook_deliveries (status, next_attempt_at)
  where status in ('pending', 'sending');
-- Derniers envois d'une adresse (dashboard › Intégrations) ; suppression en cascade
create index webhook_deliveries_endpoint_idx on public.webhook_deliveries (endpoint_id, created_at desc);
-- Envois de la centrale
create index webhook_deliveries_org_idx on public.webhook_deliveries (organization_id, created_at desc);
-- Course supprimée (on delete set null) et durées de conservation
create index webhook_deliveries_ride_idx on public.webhook_deliveries (ride_id) where ride_id is not null;
create index webhook_deliveries_created_idx on public.webhook_deliveries (created_at);

-- organization_id immuable (comme toutes les tables de la centrale)
create trigger webhook_endpoints_forbid_org_change
  before update of organization_id on public.webhook_endpoints
  for each row execute function private.forbid_org_change();
create trigger webhook_deliveries_forbid_org_change
  before update of organization_id on public.webhook_deliveries
  for each row execute function private.forbid_org_change();

-- ----------------------------------------------------------------- droits : lecture propriétaire / admin, écriture serveur
alter table public.webhook_endpoints enable row level security;
alter table public.webhook_endpoint_secrets enable row level security;
alter table public.webhook_deliveries enable row level security;

create policy webhook_endpoints_select on public.webhook_endpoints for select to authenticated
  using (organization_id in (select private.admin_org_ids()) or (select private.is_super_admin()));
create policy webhook_deliveries_select on public.webhook_deliveries for select to authenticated
  using (organization_id in (select private.admin_org_ids()) or (select private.is_super_admin()));
-- webhook_endpoint_secrets : aucune politique (service role et propriétaire seulement)

revoke all on public.webhook_endpoints, public.webhook_endpoint_secrets, public.webhook_deliveries from anon, authenticated;
grant select on public.webhook_endpoints, public.webhook_deliveries to authenticated;
grant select, insert, update, delete
  on public.webhook_endpoints, public.webhook_endpoint_secrets, public.webhook_deliveries to service_role;

-- ----------------------------------------------------------------- outils
-- Événements auxquels une adresse peut s'abonner (ordre de référence ; « ping » = envoi de test, jamais abonnable).
create or replace function private.webhook_event_types()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['ride.created', 'ride.accepted', 'ride.driver_unassigned', 'ride.driver_en_route', 'ride.driver_arrived',
               'ride.passenger_onboard', 'ride.in_progress', 'ride.completed', 'ride.cancelled', 'ride.no_driver_found',
               'ride.rescheduled']::text[];
$$;

-- Adresse IP interdite comme destination : non spécifiée, 0.0.0.0/8, locale (127/8, ::1), privée (10/8, 172.16/12,
-- 192.168/16, fc00::/7), lien local (169.254/16, fe80::/10), CGNAT (100.64/10), multidiffusion, réservée (240/4),
-- IPv4 embarquée dans IPv6 (::ffff:0:0/96, ::/96, NAT64 64:ff9b::/96). Même liste que le worker (après résolution DNS).
create or replace function private.webhook_ip_blocked(p_ip inet)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_ip is null or case family(p_ip)
    when 4 then p_ip <<= any (array['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
                                    '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4']::inet[])
    else p_ip <<= any (array['::/96', '::ffff:0:0/96', '64:ff9b::/96', 'fc00::/7', 'fe80::/10', 'fec0::/10',
                             'ff00::/8']::inet[])
  end;
$$;

-- Contrôle d'une adresse de webhook. Renvoie l'adresse normalisée (schéma et hôte en minuscules) ou le motif du refus
-- (français). Refusé : autre schéma que https://, espace ou caractère de contrôle, barre oblique inverse,
-- identifiants (« user:pass@ »), hôte sans point (nom interne : « intranet », service Docker), « localhost »,
-- adresse IP littérale privée, locale ou réservée (y compris les formes courtes ou numériques que Node.js lit comme
-- une adresse IPv4 : « 127.1 », « 0x7f.0.0.1 », « 2130706433 »), port hors de 1 à 65535.
create or replace function private.webhook_check_url(p_url text, out url text, out error text)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := btrim(coalesce(p_url, ''));
  v_authority text;
  v_tail text;
  v_host text;
  v_port text;
  v_ip inet;
  m text[];
begin
  if v = '' then
    error := 'Adresse du webhook manquante.';
    return;
  end if;
  if char_length(v) > 500 then
    error := 'Adresse du webhook trop longue (500 caractères au plus).';
    return;
  end if;
  if v ~ '[\x01-\x20\x7f-\x9f\x2028\x2029\\]' then
    error := 'Adresse du webhook invalide : ni espace, ni caractère de contrôle, ni barre oblique inverse.';
    return;
  end if;
  if v !~* '^https://' then
    error := 'L''adresse du webhook doit commencer par https://';
    return;
  end if;

  v_authority := substring(substr(v, 9) from '^[^/?#]*');
  v_tail := substr(v, 9 + char_length(v_authority));
  if v_authority = '' then
    error := 'Adresse du webhook invalide : nom de domaine manquant.';
    return;
  end if;
  if position('@' in v_authority) > 0 then
    error := 'Adresse du webhook invalide : identifiants (utilisateur, mot de passe) interdits dans l''adresse.';
    return;
  end if;
  v_authority := lower(v_authority);

  if left(v_authority, 1) = '[' then
    -- IPv6 littérale : [2001:db8::1]:8443
    m := regexp_match(v_authority, '^\[([0-9a-f:.]+)\](:([0-9]{1,5}))?$');
    if m is null then
      error := 'Adresse IPv6 du webhook invalide.';
      return;
    end if;
    v_port := m[3];
    begin
      v_ip := m[1]::inet;
    exception when others then
      error := 'Adresse IPv6 du webhook invalide.';
      return;
    end;
    if family(v_ip) <> 6 or masklen(v_ip) <> 128 then
      error := 'Adresse IPv6 du webhook invalide.';
      return;
    end if;
  else
    m := regexp_match(v_authority, '^([^:]+)(:([0-9]{1,5}))?$');
    if m is null then
      error := 'Adresse du webhook invalide : nom de domaine ou port incorrect.';
      return;
    end if;
    v_port := m[3];
    -- Point final autorisé (« exemple.fr. »), libellés non vides
    v_host := rtrim(m[1], '.');
    if v_host = '' or char_length(v_host) > 253 or v_host !~ '^[a-z0-9_\u0080-￿.-]+$'
       or v_host ~ '\.\.' or left(v_host, 1) = '.' then
      error := 'Adresse du webhook invalide : nom de domaine incorrect.';
      return;
    end if;
    if v_host = 'localhost' or v_host like '%.localhost' then
      error := 'Adresse locale refusée : le webhook doit être joignable sur Internet.';
      return;
    end if;
    -- Dernier libellé numérique : l'hôte est une adresse IPv4 (règle WHATWG suivie par Node.js) ; seule la forme
    -- usuelle a.b.c.d est acceptée, puis contrôlée comme toute adresse IP
    if substring(v_host from '[^.]*$') ~ '^(0x[0-9a-f]*|[0-9]+)$' then
      if v_host !~ '^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$' then
        error := 'Adresse IP du webhook invalide : quatre nombres de 0 à 255 séparés par des points.';
        return;
      end if;
      v_ip := v_host::inet;
    elsif position('.' in v_host) = 0 then
      error := 'Adresse du webhook invalide : nom de domaine complet attendu (exemple : https://exemple.fr/webhook).';
      return;
    end if;
  end if;

  if v_port is not null and (v_port::integer < 1 or v_port::integer > 65535) then
    error := 'Adresse du webhook invalide : port hors de 1 à 65535.';
    return;
  end if;
  if v_ip is not null and private.webhook_ip_blocked(v_ip) then
    error := 'Adresse IP privée, locale ou réservée refusée : le webhook doit être joignable sur Internet.';
    return;
  end if;
  url := 'https://' || v_authority || v_tail;
end;
$$;

-- Auteur d'une action (fonctions svc_*, service role) revérifié : clé API de la centrale (« api », identifiant de
-- la clé, facultatif) ou propriétaire / administrateur actif de la centrale (« user »), ou super admin. Renvoie le
-- type d'auteur à journaliser ; refus → FORBIDDEN (42501). Centrale inconnue → FORBIDDEN_TENANT.
create or replace function private.webhook_actor(p_org uuid, p_actor_type public.actor_type, p_actor_id uuid)
returns public.actor_type
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'FORBIDDEN_TENANT: organisation inconnue' using errcode = '42501';
  end if;
  if p_actor_type = 'api' then
    if p_actor_id is not null
       and not exists (select 1 from public.api_keys k where k.id = p_actor_id and k.organization_id = p_org) then
      raise exception 'FORBIDDEN: clé API d''une autre organisation' using errcode = '42501';
    end if;
    return 'api';
  end if;
  if p_actor_type = 'user' and p_actor_id is not null then
    if exists (select 1 from public.organization_users ou
                where ou.organization_id = p_org and ou.user_id = p_actor_id
                  and ou.status = 'active' and ou.role in ('owner', 'admin')) then
      return 'user';
    end if;
    if exists (select 1 from public.users u where u.id = p_actor_id and u.is_super_admin) then
      return 'super_admin';
    end if;
  end if;
  raise exception 'FORBIDDEN: webhooks gérés par le propriétaire ou un administrateur de la centrale' using errcode = '42501';
end;
$$;

-- Journal d'audit d'une action sur les webhooks (jamais le secret). Clé API : identifiant dans metadata.api_key_id.
create or replace function private.webhook_audit(
  p_org uuid,
  p_actor public.actor_type,
  p_actor_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_severity text,
  p_metadata jsonb
)
returns void
language sql
set search_path = ''
as $$
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, p_actor, case when p_actor = 'api' then null else p_actor_id end, p_action, p_entity_type,
          p_entity_id::text, p_severity,
          coalesce(p_metadata, '{}'::jsonb)
          || case when p_actor = 'api' and p_actor_id is not null then jsonb_build_object('api_key_id', p_actor_id)
                  else '{}'::jsonb end);
$$;

-- Adresse telle que renvoyée par l'API et les fonctions svc_* (jamais le secret)
create or replace function private.webhook_endpoint_json(e public.webhook_endpoints)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', e.id,
    'url', e.url,
    'description', e.description,
    'events', to_jsonb(e.events),
    'enabled', e.enabled,
    'disabled_reason', e.disabled_reason,
    'created_at', e.created_at,
    'last_success_at', e.last_success_at,
    'last_failure_at', e.last_failure_at,
    'last_error', e.last_error
  );
$$;

-- État COURANT d'une course pour un envoi : mêmes colonnes que la ligne PostgREST de PUBLIC_RIDE_SELECT
-- (apps/web/lib/api/v1.ts, lue par publicRide) + updated_at ; chauffeur : prénom et véhicule seulement.
-- Null si la course n'existe plus.
create or replace function private.webhook_ride_json(p_ride uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'number', r.number,
    'type', r.type,
    'status', r.status,
    'pickup_address', r.pickup_address,
    'pickup_lat', r.pickup_lat,
    'pickup_lng', r.pickup_lng,
    'dropoff_address', r.dropoff_address,
    'dropoff_lat', r.dropoff_lat,
    'dropoff_lng', r.dropoff_lng,
    'pickup_at', r.pickup_at,
    'passengers', r.passengers,
    'luggage', r.luggage,
    'vehicle_category', r.vehicle_category,
    'price_cents', r.price_cents,
    'currency', r.currency,
    'payment_method', r.payment_method,
    'flight_number', r.flight_number,
    'external_reference', r.external_reference,
    'estimated_distance_m', r.estimated_distance_m,
    'estimated_duration_s', r.estimated_duration_s,
    'route_polyline', r.route_polyline,
    'created_at', r.created_at,
    'accepted_at', r.accepted_at,
    'driver_arrived_at', r.driver_arrived_at,
    'started_at', r.started_at,
    'completed_at', r.completed_at,
    'cancelled_at', r.cancelled_at,
    'updated_at', r.updated_at,
    'driver', case when d.id is null then null else jsonb_build_object(
      'first_name', d.first_name,
      'vehicle', case when v.id is null then null else jsonb_build_object(
        'brand', v.brand, 'model', v.model, 'color', v.color, 'plate', v.plate) end) end
  )
  from public.rides r
  left join public.drivers d on d.organization_id = r.organization_id and d.id = r.driver_id
  left join public.vehicles v on v.organization_id = d.organization_id and v.id = d.vehicle_id
  where r.id = p_ride;
$$;

-- ----------------------------------------------------------------- détection des événements (déclencheurs des courses)
-- Une ligne d'envoi par adresse active abonnée à l'événement, puis un seul réveil du worker. Security definer, comme
-- les autres déclencheurs des courses qui écrivent une table protégée (private.sync_platform_fee,
-- private.sync_ride_settlement) : une course créée ou modifiée par un membre (même dispatcher, qui ne lit pas les
-- adresses) ou par une RPC enregistre ses événements. Une erreur ici (adresse supprimée au même instant…) ne fait
-- jamais échouer le changement de la course : l'événement est perdu, signalé dans les journaux PostgreSQL.
-- Heure de l'événement : début de la transaction pour la création (les changements faits par le dispatch dans la
-- même transaction, déclenchés avant, restent après elle), heure réelle pour les changements.
create or replace function private.queue_ride_webhooks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_events text[] := '{}';
  v_event text;
  v_previous public.ride_status;
  v_at timestamptz;
  v_count integer;
begin
  -- Centrale sans webhook actif : rien à faire (cas courant, une lecture d'index)
  if not exists (select 1 from public.webhook_endpoints e where e.organization_id = new.organization_id and e.enabled) then
    return null;
  end if;

  if tg_op = 'INSERT' then
    -- Import / seed (connexion directe, rydar.bypass_ride_rules) : courses historiques, aucun événement
    if current_setting('rydar.bypass_ride_rules', true) = 'on' and auth.role() is null then
      return null;
    end if;
    v_events := array['ride.created'];
    v_at := now();
  else
    v_previous := old.status;
    v_at := clock_timestamp();
    if new.status is distinct from old.status then
      v_event := case
        when new.status = 'ACCEPTED' then 'ride.accepted'
        when new.status = 'DRIVER_EN_ROUTE' then 'ride.driver_en_route'
        when new.status = 'DRIVER_ARRIVED' then 'ride.driver_arrived'
        when new.status = 'PASSENGER_ONBOARD' then 'ride.passenger_onboard'
        when new.status = 'IN_PROGRESS' then 'ride.in_progress'
        when new.status = 'COMPLETED' then 'ride.completed'
        when new.status = 'CANCELLED' then 'ride.cancelled'
        when new.status = 'NO_DRIVER_FOUND' then 'ride.no_driver_found'
        -- Retour en recherche (« Relancer ») ou en attente d'attribution : chauffeur retiré
        when new.status in ('CREATED', 'SEARCHING_DRIVER', 'OFFERED') and old.driver_id is not null then 'ride.driver_unassigned'
      end;
    elsif new.status = 'ACCEPTED' and new.driver_id is not null and new.driver_id is distinct from old.driver_id then
      -- Course acceptée réattribuée à un autre chauffeur
      v_event := 'ride.accepted';
    end if;
    if v_event is not null then
      v_events := v_events || v_event;
    end if;
    if new.pickup_at is distinct from old.pickup_at and new.status not in ('COMPLETED', 'CANCELLED', 'NO_DRIVER_FOUND') then
      v_events := v_events || 'ride.rescheduled'::text;
    end if;
    if cardinality(v_events) = 0 then
      return null;
    end if;
  end if;

  begin
    -- Deux événements d'un même changement (statut puis heure) : 1 µs d'écart pour garder leur ordre
    insert into public.webhook_deliveries (organization_id, endpoint_id, ride_id, event_type, event_status, previous_status, occurred_at)
    select new.organization_id, e.id, new.id, ev.t, new.status, v_previous, v_at + (ev.n - 1) * interval '1 microsecond'
      from unnest(v_events) with ordinality as ev (t, n)
      join public.webhook_endpoints e
        on e.organization_id = new.organization_id and e.enabled
       and (cardinality(e.events) = 0 or ev.t = any (e.events));
    get diagnostics v_count = row_count;
    if v_count > 0 then
      perform pg_notify('rydar_webhooks', '');
    end if;
  exception when others then
    raise warning 'webhooks : événements % de la course % non enregistrés (%)', v_events, new.id, sqlerrm;
  end;
  return null;
end;
$$;

-- Après les déclencheurs existants (ordre alphabétique des déclencheurs AFTER)
create trigger rides_f_webhooks_insert
  after insert on public.rides
  for each row execute function private.queue_ride_webhooks();
create trigger rides_f_webhooks_update
  after update of status, driver_id, pickup_at on public.rides
  for each row
  when (old.status is distinct from new.status
        or old.driver_id is distinct from new.driver_id
        or old.pickup_at is distinct from new.pickup_at)
  execute function private.queue_ride_webhooks();

-- ----------------------------------------------------------------- worker : prise, compte rendu, conservation
-- Prise d'un lot (connexion directe du worker, rôle propriétaire) : envois en attente arrivés à échéance et envois
-- restés « en cours » après l'arrêt du worker (verrou expiré), des adresses actives seulement, les plus anciens
-- d'abord. Chaque ligne prise est verrouillée 2 min (for update skip locked : deux workers ne prennent jamais la
-- même). « ride » = état courant de la course (private.webhook_ride_json), null pour « ping » ou course supprimée.
create or replace function private.claim_webhook_deliveries(p_limit integer default 20)
returns table (
  id uuid,
  organization_id uuid,
  endpoint_id uuid,
  url text,
  secret text,
  event_type text,
  event_status text,
  previous_status text,
  occurred_at timestamptz,
  attempts integer,
  ride jsonb
)
language plpgsql
set search_path = ''
-- Heures de « ride » en UTC (« …+00:00 »), comme PostgREST (GET /api/v1/rides/{id}), quel que soit le fuseau du worker
set timezone = 'UTC'
as $$
#variable_conflict use_column
begin
  return query
    with due as (
      select d.id
        from public.webhook_deliveries d
        join public.webhook_endpoints e on e.id = d.endpoint_id
       where e.enabled
         and ((d.status = 'pending' and d.next_attempt_at <= now())
              or (d.status = 'sending' and (d.locked_until is null or d.locked_until < now())))
       order by d.occurred_at, d.id
       limit least(greatest(coalesce(p_limit, 20), 0), 100)
       for update of d skip locked
    ), claimed as (
      update public.webhook_deliveries w
         set status = 'sending', locked_until = now() + interval '2 minutes'
        from due
       where w.id = due.id
      returning w.id, w.organization_id, w.endpoint_id, w.ride_id, w.event_type, w.event_status, w.previous_status,
                w.occurred_at, w.attempts
    )
    select c.id, c.organization_id, c.endpoint_id, e.url, s.secret, c.event_type, c.event_status::text,
           c.previous_status::text, c.occurred_at, c.attempts, private.webhook_ride_json(c.ride_id)
      from claimed c
      join public.webhook_endpoints e on e.id = c.endpoint_id
      left join public.webhook_endpoint_secrets s on s.endpoint_id = c.endpoint_id
     order by c.occurred_at, c.id;
end;
$$;

-- Compte rendu d'un envoi.
--  * Succès (réponse 2xx) : envoyé (même si la ligne a été reprise entre-temps : l'événement est bien parti) ;
--    adresse : dernier succès, échecs consécutifs remis à zéro.
--  * Échec : seulement pour un envoi en cours (un compte rendu tardif ne remet pas en file un envoi déjà traité) ;
--    nouvel essai après 1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h puis 24 h ; échec définitif au 9e échec. Adresse :
--    un échec consécutif de plus ; à 50 échecs consécutifs sans succès depuis 3 jours (ou jamais), désactivée d'office
--    et ses envois en attente passent en échec.
create or replace function private.complete_webhook_delivery(
  p_id uuid,
  p_ok boolean,
  p_status_code integer default null,
  p_error text default null
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  d public.webhook_deliveries;
  e public.webhook_endpoints;
  v_code integer := case when p_status_code between 0 and 999 then p_status_code end;
  v_error text := left(coalesce(
    nullif(btrim(regexp_replace(coalesce(p_error, ''), '[\s\x01-\x1f\x7f-\x9f\x2028\x2029]+', ' ', 'g')), ''),
    case when p_status_code is not null then format('Réponse HTTP %s', p_status_code) end,
    'Échec de l''envoi (motif inconnu)'), 500);
  v_delays integer[] := array[60, 300, 900, 3600, 10800, 21600, 43200, 86400];
  v_attempts integer;
begin
  select * into d from public.webhook_deliveries w where w.id = p_id for update;
  if not found then
    return;
  end if;

  if coalesce(p_ok, false) then
    if d.status <> 'delivered' then
      update public.webhook_deliveries
         set status = 'delivered', delivered_at = now(), locked_until = null, last_status_code = v_code, last_error = null
       where id = d.id;
    end if;
    update public.webhook_endpoints
       set last_success_at = now(), consecutive_failures = 0, last_error = null
     where id = d.endpoint_id;
    return;
  end if;

  if d.status <> 'sending' then
    return;
  end if;
  v_attempts := d.attempts + 1;
  update public.webhook_deliveries
     set attempts = v_attempts,
         last_status_code = v_code,
         last_error = v_error,
         locked_until = null,
         status = case when v_attempts >= 9 then 'failed' else 'pending' end,
         next_attempt_at = case when v_attempts >= 9 then next_attempt_at
                                else now() + make_interval(secs => v_delays[v_attempts]) end
   where id = d.id;

  update public.webhook_endpoints
     set consecutive_failures = consecutive_failures + 1, last_failure_at = now(), last_error = v_error
   where id = d.endpoint_id
  returning * into e;
  if found and e.enabled and e.consecutive_failures >= 50
     and (e.last_success_at is null or e.last_success_at < now() - interval '3 days') then
    update public.webhook_endpoints
       set enabled = false, disabled_reason = 'Désactivé automatiquement : échecs répétés depuis 3 jours', updated_at = now()
     where id = e.id;
    update public.webhook_deliveries
       set status = 'failed', locked_until = null,
           last_error = left('Webhook désactivé automatiquement (échecs répétés)' || coalesce(' — ' || last_error, ''), 500)
     where endpoint_id = e.id and status in ('pending', 'sending');
  end if;
end;
$$;

-- Durées de conservation (ménage du worker) : envois terminés (envoyés ou en échec) 30 jours, tout envoi 45 jours.
-- Renvoie le nombre de lignes supprimées.
create or replace function private.purge_webhook_deliveries()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_done integer;
  v_old integer;
begin
  delete from public.webhook_deliveries
   where status in ('delivered', 'failed') and created_at < now() - interval '30 days';
  get diagnostics v_done = row_count;
  delete from public.webhook_deliveries where created_at < now() - interval '45 days';
  get diagnostics v_old = row_count;
  return v_done + v_old;
end;
$$;

-- ----------------------------------------------------------------- gestion (web : API v1 et dashboard, service role)
-- Réponses : {ok: true, …} ou {ok: false, code, message} (aucune exception pour une saisie refusée).
-- Codes : WEBHOOK_INVALID_URL, WEBHOOK_INVALID_EVENTS, WEBHOOK_INVALID_SECRET, VALIDATION_ERROR (description),
-- WEBHOOK_LIMIT, WEBHOOK_NOT_FOUND, WEBHOOK_DELIVERY_NOT_FOUND, WEBHOOK_DISABLED.

-- Ajout ou mise à jour (même adresse dans la centrale) d'un webhook.
--  * p_events null ou vide = tous les événements ; doublons ignorés, ordre de référence (private.webhook_event_types).
--  * p_secret null : secret généré « whsec_ » + 48 caractères hexadécimaux à la création, inchangé à la mise à jour ;
--    sinon 32 à 200 caractères parmi A-Z a-z 0-9 _ . - (secret dérivé par l'intégrateur).
--  * Adresse existante : description et événements remplacés, réactivée (motif et échecs consécutifs effacés),
--    secret remplacé seulement s'il est fourni → {ok, created: false, endpoint, secret: null}.
--  * Nouvelle adresse (10 au plus par centrale) → {ok, created: true, endpoint, secret: <secret généré, ou null s'il
--    a été fourni>} : le secret généré n'est montré qu'ici.
create or replace function public.svc_webhook_upsert(
  p_org uuid,
  p_url text,
  p_description text,
  p_events text[],
  p_secret text,
  p_actor_type public.actor_type,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.actor_type;
  v_url text;
  v_error text;
  v_all text[] := private.webhook_event_types();
  v_unknown text[];
  v_events text[];
  v_description text;
  v_generated text;
  v_reenabled boolean;
  e public.webhook_endpoints;
begin
  v_actor := private.webhook_actor(p_org, p_actor_type, p_actor_id);

  select c.url, c.error into v_url, v_error from private.webhook_check_url(p_url) c;
  if v_error is not null then
    return jsonb_build_object('ok', false, 'code', 'WEBHOOK_INVALID_URL', 'message', v_error);
  end if;

  if p_events is null or cardinality(p_events) = 0 then
    v_events := '{}';
  else
    select coalesce(array_agg(distinct coalesce(x, 'null')), '{}') into v_unknown
      from unnest(p_events) x
     where x is null or not (x = any (v_all));
    if cardinality(v_unknown) > 0 then
      return jsonb_build_object('ok', false, 'code', 'WEBHOOK_INVALID_EVENTS',
        'message', format('Événement inconnu : %s. Événements possibles : %s.',
          array_to_string(v_unknown, ', '), array_to_string(v_all, ', ')));
    end if;
    v_events := array(select t.a from unnest(v_all) with ordinality as t (a, n) where t.a = any (p_events) order by t.n);
  end if;

  v_description := nullif(btrim(regexp_replace(coalesce(p_description, ''), '[\s\x01-\x1f\x7f-\x9f\x2028\x2029]+', ' ', 'g')), '');
  if char_length(v_description) > 120 then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'Description du webhook trop longue (120 caractères au plus).');
  end if;

  if p_secret is not null and p_secret !~ '^[A-Za-z0-9_.-]{32,200}$' then
    return jsonb_build_object('ok', false, 'code', 'WEBHOOK_INVALID_SECRET',
      'message', 'Secret invalide : 32 à 200 caractères parmi les lettres sans accent, les chiffres, « _ », « . » et « - ».');
  end if;

  -- Un ajout à la fois par centrale : plafond exact, même pour des appels simultanés
  perform pg_advisory_xact_lock(hashtextextended('rydar.webhooks:' || p_org::text, 0));

  select * into e from public.webhook_endpoints w where w.organization_id = p_org and w.url = v_url for update;
  if found then
    v_reenabled := not e.enabled;
    update public.webhook_endpoints
       set description = v_description, events = v_events, enabled = true, disabled_reason = null,
           consecutive_failures = 0, updated_at = now()
     where id = e.id
    returning * into e;
    if p_secret is not null then
      insert into public.webhook_endpoint_secrets (endpoint_id, secret, updated_at)
      values (e.id, p_secret, now())
      on conflict (endpoint_id) do update set secret = excluded.secret, updated_at = excluded.updated_at;
    end if;
    perform private.webhook_audit(p_org, v_actor, p_actor_id, 'webhook.updated', 'webhook_endpoints', e.id, 'info',
      jsonb_build_object('url', e.url, 'events', to_jsonb(e.events), 'reenabled', v_reenabled,
        'secret_replaced', p_secret is not null));
    return jsonb_build_object('ok', true, 'created', false, 'endpoint', private.webhook_endpoint_json(e), 'secret', null);
  end if;

  if (select count(*) from public.webhook_endpoints w where w.organization_id = p_org) >= 10 then
    return jsonb_build_object('ok', false, 'code', 'WEBHOOK_LIMIT',
      'message', '10 webhooks au plus par centrale : supprimez-en un avant d''en ajouter un autre.');
  end if;

  if p_secret is null then
    v_generated := 'whsec_' || encode(extensions.gen_random_bytes(24), 'hex');
  end if;
  insert into public.webhook_endpoints (organization_id, url, description, events, created_by_type, created_by)
  values (p_org, v_url, v_description, v_events, v_actor, p_actor_id)
  returning * into e;
  insert into public.webhook_endpoint_secrets (endpoint_id, secret) values (e.id, coalesce(p_secret, v_generated));

  perform private.webhook_audit(p_org, v_actor, p_actor_id, 'webhook.created', 'webhook_endpoints', e.id, 'info',
    jsonb_build_object('url', e.url, 'events', to_jsonb(e.events), 'secret_generated', v_generated is not null));
  return jsonb_build_object('ok', true, 'created', true, 'endpoint', private.webhook_endpoint_json(e), 'secret', v_generated);
end;
$$;

-- Suppression d'un webhook (secret et envois avec lui) → {ok}
create or replace function public.svc_webhook_delete(
  p_org uuid,
  p_id uuid,
  p_actor_type public.actor_type,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.actor_type;
  e public.webhook_endpoints;
begin
  v_actor := private.webhook_actor(p_org, p_actor_type, p_actor_id);
  delete from public.webhook_endpoints w where w.id = p_id and w.organization_id = p_org returning * into e;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WEBHOOK_NOT_FOUND', 'message', 'Webhook introuvable.');
  end if;
  perform private.webhook_audit(p_org, v_actor, p_actor_id, 'webhook.deleted', 'webhook_endpoints', e.id, 'warning',
    jsonb_build_object('url', e.url));
  return jsonb_build_object('ok', true);
end;
$$;

-- Activation / désactivation manuelle → {ok, endpoint}. Réactivation : motif et échecs consécutifs effacés. Les
-- envois en attente d'une adresse désactivée restent en attente : ils partent à sa réactivation.
create or replace function public.svc_webhook_set_enabled(
  p_org uuid,
  p_id uuid,
  p_enabled boolean,
  p_actor_type public.actor_type,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.actor_type;
  e public.webhook_endpoints;
begin
  v_actor := private.webhook_actor(p_org, p_actor_type, p_actor_id);
  if p_enabled is null then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR', 'message', 'État du webhook manquant.');
  end if;
  update public.webhook_endpoints w
     set enabled = p_enabled,
         disabled_reason = null,
         consecutive_failures = case when p_enabled then 0 else w.consecutive_failures end,
         updated_at = now()
   where w.id = p_id and w.organization_id = p_org
  returning * into e;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WEBHOOK_NOT_FOUND', 'message', 'Webhook introuvable.');
  end if;
  perform private.webhook_audit(p_org, v_actor, p_actor_id,
    case when p_enabled then 'webhook.enabled' else 'webhook.disabled' end, 'webhook_endpoints', e.id,
    case when p_enabled then 'info' else 'warning' end, jsonb_build_object('url', e.url));
  if p_enabled then
    -- Envois en attente pendant la pause : partent tout de suite
    perform pg_notify('rydar_webhooks', '');
  end if;
  return jsonb_build_object('ok', true, 'endpoint', private.webhook_endpoint_json(e));
end;
$$;

-- Nouveau secret généré (l'ancien cesse aussitôt de signer) → {ok, secret} : montré une seule fois
create or replace function public.svc_webhook_rotate_secret(
  p_org uuid,
  p_id uuid,
  p_actor_type public.actor_type,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.actor_type;
  e public.webhook_endpoints;
  v_secret text := 'whsec_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  v_actor := private.webhook_actor(p_org, p_actor_type, p_actor_id);
  select * into e from public.webhook_endpoints w where w.id = p_id and w.organization_id = p_org for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WEBHOOK_NOT_FOUND', 'message', 'Webhook introuvable.');
  end if;
  insert into public.webhook_endpoint_secrets (endpoint_id, secret, updated_at)
  values (e.id, v_secret, now())
  on conflict (endpoint_id) do update set secret = excluded.secret, updated_at = excluded.updated_at;
  update public.webhook_endpoints set updated_at = now() where id = e.id;
  perform private.webhook_audit(p_org, v_actor, p_actor_id, 'webhook.secret_rotated', 'webhook_endpoints', e.id, 'warning',
    jsonb_build_object('url', e.url));
  return jsonb_build_object('ok', true, 'secret', v_secret);
end;
$$;

-- Envoi de test (« ping », sans course), dû tout de suite ; adresse active seulement → {ok, delivery_id}
create or replace function public.svc_webhook_ping(
  p_org uuid,
  p_id uuid,
  p_actor_type public.actor_type,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.actor_type;
  e public.webhook_endpoints;
  v_delivery uuid;
begin
  v_actor := private.webhook_actor(p_org, p_actor_type, p_actor_id);
  select * into e from public.webhook_endpoints w where w.id = p_id and w.organization_id = p_org;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WEBHOOK_NOT_FOUND', 'message', 'Webhook introuvable.');
  end if;
  if not e.enabled then
    return jsonb_build_object('ok', false, 'code', 'WEBHOOK_DISABLED',
      'message', 'Webhook désactivé : réactivez-le avant de l''essayer.');
  end if;
  insert into public.webhook_deliveries (organization_id, endpoint_id, event_type)
  values (p_org, e.id, 'ping')
  returning id into v_delivery;
  perform pg_notify('rydar_webhooks', '');
  perform private.webhook_audit(p_org, v_actor, p_actor_id, 'webhook.ping', 'webhook_endpoints', e.id, 'info',
    jsonb_build_object('url', e.url, 'delivery_id', v_delivery));
  return jsonb_build_object('ok', true, 'delivery_id', v_delivery);
end;
$$;

-- « Renvoyer » un envoi terminé (envoyé ou en échec) : de nouveau en attente, essais remis à zéro, dû tout de suite
-- (même identifiant d'événement). Envoi encore en attente : avancé à maintenant ; en cours : rien. → {ok}
create or replace function public.svc_webhook_redeliver(
  p_org uuid,
  p_delivery_id uuid,
  p_actor_type public.actor_type,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.actor_type;
  d public.webhook_deliveries;
  v_enabled boolean;
begin
  v_actor := private.webhook_actor(p_org, p_actor_type, p_actor_id);
  select w.* into d from public.webhook_deliveries w where w.id = p_delivery_id and w.organization_id = p_org for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WEBHOOK_DELIVERY_NOT_FOUND', 'message', 'Envoi introuvable.');
  end if;
  select e.enabled into v_enabled from public.webhook_endpoints e where e.id = d.endpoint_id;
  if not coalesce(v_enabled, false) then
    return jsonb_build_object('ok', false, 'code', 'WEBHOOK_DISABLED',
      'message', 'Webhook désactivé : réactivez-le avant de renvoyer un événement.');
  end if;
  if d.status in ('delivered', 'failed') then
    update public.webhook_deliveries
       set status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = null, delivered_at = null
     where id = d.id;
  elsif d.status = 'pending' then
    update public.webhook_deliveries set next_attempt_at = now() where id = d.id;
  end if;
  if d.status <> 'sending' then
    perform pg_notify('rydar_webhooks', '');
  end if;
  perform private.webhook_audit(p_org, v_actor, p_actor_id, 'webhook.redelivered', 'webhook_deliveries', d.id, 'info',
    jsonb_build_object('endpoint_id', d.endpoint_id, 'event_type', d.event_type, 'previous_delivery_status', d.status));
  return jsonb_build_object('ok', true);
end;
$$;

-- ----------------------------------------------------------------- droits d'exécution (deny-by-default, cf. 20260924000900)
-- Web (API v1, dashboard) : service role seulement ; auteur et centrale revérifiés dans chaque fonction
revoke execute on function
  public.svc_webhook_upsert(uuid, text, text, text[], text, public.actor_type, uuid),
  public.svc_webhook_delete(uuid, uuid, public.actor_type, uuid),
  public.svc_webhook_set_enabled(uuid, uuid, boolean, public.actor_type, uuid),
  public.svc_webhook_rotate_secret(uuid, uuid, public.actor_type, uuid),
  public.svc_webhook_ping(uuid, uuid, public.actor_type, uuid),
  public.svc_webhook_redeliver(uuid, uuid, public.actor_type, uuid)
from public, anon, authenticated;
grant execute on function
  public.svc_webhook_upsert(uuid, text, text, text[], text, public.actor_type, uuid),
  public.svc_webhook_delete(uuid, uuid, public.actor_type, uuid),
  public.svc_webhook_set_enabled(uuid, uuid, boolean, public.actor_type, uuid),
  public.svc_webhook_rotate_secret(uuid, uuid, public.actor_type, uuid),
  public.svc_webhook_ping(uuid, uuid, public.actor_type, uuid),
  public.svc_webhook_redeliver(uuid, uuid, public.actor_type, uuid)
to service_role;
-- Worker (connexion directe, rôle propriétaire), helpers des fonctions ci-dessus et déclencheur : jamais appelés par
-- un client ni par le service role
revoke execute on function
  private.webhook_event_types(),
  private.webhook_ip_blocked(inet),
  private.webhook_check_url(text),
  private.webhook_actor(uuid, public.actor_type, uuid),
  private.webhook_audit(uuid, public.actor_type, uuid, text, text, uuid, text, jsonb),
  private.webhook_endpoint_json(public.webhook_endpoints),
  private.webhook_ride_json(uuid),
  private.queue_ride_webhooks(),
  private.claim_webhook_deliveries(integer),
  private.complete_webhook_delivery(uuid, boolean, integer, text),
  private.purge_webhook_deliveries()
from public, anon, authenticated, service_role;
