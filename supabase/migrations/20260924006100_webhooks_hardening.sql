-- =============================================================================
-- Rydar Drive — Webhooks sortants : durcissement après la revue adverse (migration 20260924006000 déjà poussée,
-- jamais modifiée : tout changement est ici).
--
--  * Tests et renvois bornés (SEC-1, API-1) : un seul « ping » en attente ou en cours par adresse
--    (WEBHOOK_TEST_PENDING, HTTP 409) ; 10 tests et renvois au plus par minute et par centrale
--    (WEBHOOK_TEST_RATE_LIMITED, HTTP 429), comptés dans le journal d'audit (une ligne par appel accepté) ; un
--    « ping » en échec l'est aussitôt (aucun nouvel essai) : un autre test reste possible tout de suite ; les
--    « ping » déjà en attente d'un nouvel essai (créés avant cette migration) sont passés en échec.
--  * Centrale suspendue ou archivée (SEC-3) : aucun événement enregistré (perdu), aucun envoi pris (ceux déjà en file
--    restent en attente : repris à la réactivation, sinon supprimés au bout de 45 jours).
--  * Offre sans l'API (GATE-1) : les webhooks font partie de l'API (gérés par elle, permission « webhooks:manage »),
--    déjà refusée requête par requête après un changement d'offre (PLAN_FEATURE_API). Même règle ici, événement par
--    événement : tant que l'offre (ou la surcharge du super admin) n'inclut pas l'API, aucun événement n'est
--    enregistré (perdu, jamais rejoué quand l'API revient) ; les envois déjà en file partent normalement.
--  * Prise équitable (SEC-2) : un seul envoi en cours par adresse (un test « ping » d'abord, puis le plus ancien dû :
--    ordre gardé parmi les envois dus, un envoi en attente d'un nouvel essai ne bloque pas les suivants) et tour de
--    rôle entre centrales, envois déjà en cours compris (une centrale qui occupe déjà k places passe derrière celles
--    qui en occupent moins) : une adresse lente ou une centrale très active ne retarde plus les autres, même quand
--    le worker reprend un envoi à chaque place libérée. Prises sérialisées (verrou « rydar.webhook-claim »).
--  * Relance d'une course sans chauffeur (EVT-1, E2E-5) : nouvel événement ride.search_restarted (NO_DRIVER_FOUND →
--    recherche : « Relancer », vol retardé qui remet la course en service) ; ride.rescheduled aussi pour une course
--    sans chauffeur (l'heure suit le vol même quand la relance est refusée).
--  * Compte rendu (SQL-1) : verrous pris dans l'ordre adresse puis envoi (plus d'interblocage entre deux comptes
--    rendus simultanés au seuil de désactivation).
--  * Désactivation automatique (SQL-2, DOC-2) : 50 échecs consécutifs ET aucun envoi réussi depuis 3 jours, une
--    adresse qui n'a jamais réussi ayant le même délai de 3 jours compté depuis sa création ; motif aligné.
-- =============================================================================

-- ----------------------------------------------------------------- nouvel événement : ride.search_restarted
alter table public.webhook_endpoints drop constraint webhook_endpoints_events_check;
alter table public.webhook_endpoints add constraint webhook_endpoints_events_check check (
  array_position(events, null) is null
  and events <@ array['ride.created', 'ride.accepted', 'ride.driver_unassigned', 'ride.driver_en_route',
                      'ride.driver_arrived', 'ride.passenger_onboard', 'ride.in_progress', 'ride.completed',
                      'ride.cancelled', 'ride.no_driver_found', 'ride.search_restarted', 'ride.rescheduled']::text[]);

alter table public.webhook_deliveries drop constraint webhook_deliveries_event_type_check;
alter table public.webhook_deliveries add constraint webhook_deliveries_event_type_check check (event_type in (
  'ride.created', 'ride.accepted', 'ride.driver_unassigned', 'ride.driver_en_route', 'ride.driver_arrived',
  'ride.passenger_onboard', 'ride.in_progress', 'ride.completed', 'ride.cancelled', 'ride.no_driver_found',
  'ride.search_restarted', 'ride.rescheduled', 'ping'));

-- Dernière définition : 20260924006000. Seul changement : ride.search_restarted (après ride.no_driver_found).
create or replace function private.webhook_event_types()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['ride.created', 'ride.accepted', 'ride.driver_unassigned', 'ride.driver_en_route', 'ride.driver_arrived',
               'ride.passenger_onboard', 'ride.in_progress', 'ride.completed', 'ride.cancelled', 'ride.no_driver_found',
               'ride.search_restarted', 'ride.rescheduled']::text[];
$$;

-- ----------------------------------------------------------------- index
-- Adresses occupées (un envoi en cours) : private.claim_webhook_deliveries
create index if not exists webhook_deliveries_sending_idx on public.webhook_deliveries (endpoint_id)
  where status = 'sending';
-- Test (« ping ») encore en attente ou en cours d'une adresse : public.svc_webhook_ping, private.claim_webhook_deliveries
create index if not exists webhook_deliveries_open_ping_idx on public.webhook_deliveries (endpoint_id)
  where event_type = 'ping' and status in ('pending', 'sending');
-- Plus ancien envoi dû d'une adresse, sans tri de tout l'arriéré : private.claim_webhook_deliveries
create index if not exists webhook_deliveries_endpoint_open_idx on public.webhook_deliveries (endpoint_id, occurred_at, id)
  where status in ('pending', 'sending');

-- ----------------------------------------------------------------- tests (« ping ») en attente d'un nouvel essai
-- Créés avant cette migration (jusqu'à 24 h d'attente) : ils bloqueraient tout nouveau test de leur adresse
-- (WEBHOOK_TEST_PENDING). Désormais un test en échec l'est aussitôt : même règle pour eux.
update public.webhook_deliveries
   set status = 'failed', locked_until = null
 where event_type = 'ping' and status = 'pending' and attempts > 0;

-- ----------------------------------------------------------------- détection des événements
-- Dernière définition : 20260924006000. Changements :
--  * centrale suspendue ou archivée, ou offre sans l'API (private.org_limits, mêmes règles que l'API v1) : rien ;
--  * course sans chauffeur (NO_DRIVER_FOUND) remise en recherche (CREATED, SEARCHING_DRIVER ou OFFERED) :
--    ride.search_restarted (« Relancer », vol retardé) ;
--  * ride.rescheduled aussi pour une course sans chauffeur (seules les courses terminées ou annulées n'en ont pas).
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
  -- Centrale sans webhook actif, suspendue ou archivée : rien à faire (cas courant, une lecture d'index)
  if not exists (select 1
                   from public.webhook_endpoints e
                   join public.organizations o on o.id = e.organization_id
                  where e.organization_id = new.organization_id and e.enabled and o.status = 'active') then
    return null;
  end if;
  -- Offre sans l'API (offre, centrale sans offre = tout inclus, surcharge du super admin) : aucun événement
  -- enregistré (perdu, jamais rejoué quand l'API revient), comme le reste de l'API. Valeurs vraies de ::boolean
  -- (comme limits_audit, booléen ou chaîne « true »), comparées en texte : une valeur mal formée vaut « non » sans
  -- jamais faire échouer la course
  if not coalesce(lower(btrim(private.org_limits(new.organization_id) ->> 'api_access'))
                  in ('true', 't', 'yes', 'y', 'on', '1'), false) then
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
        -- Recherche terminée sans chauffeur puis relancée (« Relancer », vol retardé qui remet la course en service)
        when new.status in ('CREATED', 'SEARCHING_DRIVER', 'OFFERED') and old.status = 'NO_DRIVER_FOUND' then 'ride.search_restarted'
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
    -- Course sans chauffeur comprise : son heure suit le vol, même quand la relance est refusée
    if new.pickup_at is distinct from old.pickup_at and new.status not in ('COMPLETED', 'CANCELLED') then
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

-- ----------------------------------------------------------------- worker : prise équitable
-- Dernière définition : 20260924006000. Changements :
--  * un seul envoi en cours par adresse : une adresse dont un envoi est « en cours » (verrou valide) est sautée, et
--    une prise ne donne qu'un envoi par adresse : un test (« ping ») dû d'abord (« Tester » ne passe pas derrière
--    l'arriéré), sinon son plus ancien envoi dû (ordre gardé parmi les envois dus ; un envoi en attente d'un nouvel
--    essai ne bloque pas les suivants) ;
--  * tour de rôle entre centrales, envois en cours compris : rang = rang de l'adresse dans sa centrale (1re, 2e…)
--    + nombre d'envois de la centrale déjà en cours ; à rang égal, l'envoi dû depuis le plus longtemps d'abord. Une
--    centrale qui occupe déjà des places passe derrière les autres, même quand le worker ne reprend qu'un envoi à
--    chaque place libérée (claim(1)) ;
--  * centrales suspendues ou archivées sautées (leurs envois restent en attente) ;
--  * prises sérialisées (verrou « rydar.webhook-claim », pris pour la durée de la transaction : la fonction est
--    appelée seule, en autocommit) : deux prises simultanées ne peuvent pas mettre deux envois d'une même adresse
--    « en cours » (chaque requête voit la prise précédente, validée).
-- Les fonctions de fenêtre étant interdites au niveau d'un FOR UPDATE, le classement est fait dans des CTE
-- matérialisées, puis les lignes retenues sont verrouillées (for update skip locked) en revérifiant qu'elles sont
-- toujours dues : une ligne verrouillée ailleurs (renvoi en cours) est écartée.
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
declare
  v_limit integer := least(greatest(coalesce(p_limit, 20), 0), 100);
begin
  if v_limit = 0 then
    return;
  end if;
  -- Une prise à la fois (courte) : la requête suivante voit les envois « en cours » de la précédente
  perform pg_advisory_xact_lock(hashtextextended('rydar.webhook-claim', 0));
  return query
    with busy as materialized (
      -- Envois en cours (verrou valide) : leur adresse est occupée tant qu'ils n'ont pas répondu
      select s.endpoint_id, s.organization_id
        from public.webhook_deliveries s
       where s.status = 'sending' and s.locked_until >= now()
    ), busy_org as materialized (
      -- Places déjà occupées par centrale
      select b.organization_id, count(*) as n
        from busy b
       group by b.organization_id
    ), heads as materialized (
      -- Envoi dû en tête de chaque adresse libre et active d'une centrale active : un test (« ping ») d'abord, sinon
      -- le plus ancien (index webhook_deliveries_open_ping_idx puis webhook_deliveries_endpoint_open_idx)
      select h.id, h.organization_id, h.next_attempt_at, h.occurred_at
        from public.webhook_endpoints e
        join public.organizations o on o.id = e.organization_id
        cross join lateral (
          (select p.id, p.organization_id, p.next_attempt_at, p.occurred_at
             from public.webhook_deliveries p
            where p.endpoint_id = e.id
              and p.event_type = 'ping'
              and p.status in ('pending', 'sending')
              and ((p.status = 'pending' and p.next_attempt_at <= now())
                   or (p.status = 'sending' and (p.locked_until is null or p.locked_until < now())))
            order by p.occurred_at, p.id
            limit 1)
          union all
          (select d.id, d.organization_id, d.next_attempt_at, d.occurred_at
             from public.webhook_deliveries d
            where d.endpoint_id = e.id
              and d.status in ('pending', 'sending')
              and ((d.status = 'pending' and d.next_attempt_at <= now())
                   or (d.status = 'sending' and (d.locked_until is null or d.locked_until < now())))
            order by d.occurred_at, d.id
            limit 1)
          limit 1
        ) h
       where e.enabled
         and o.status = 'active'
         and not exists (select 1 from busy b where b.endpoint_id = e.id)
    ), ranked as materialized (
      -- Tour de rôle : rang de l'adresse dans sa centrale + places que la centrale occupe déjà
      select h.id, h.next_attempt_at, h.occurred_at,
             row_number() over (partition by h.organization_id order by h.next_attempt_at, h.occurred_at, h.id)
               + coalesce(bo.n, 0) as org_rank
        from heads h
        left join busy_org bo on bo.organization_id = h.organization_id
    ), due as (
      select d.id
        from public.webhook_deliveries d
        join ranked r on r.id = d.id
       where (d.status = 'pending' and d.next_attempt_at <= now())
          or (d.status = 'sending' and (d.locked_until is null or d.locked_until < now()))
       order by r.org_rank, r.next_attempt_at, r.occurred_at, r.id
       limit v_limit
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

-- ----------------------------------------------------------------- worker : compte rendu
-- Dernière définition : 20260924006000. Changements :
--  * verrous dans l'ordre adresse PUIS envoi (comme svc_webhook_delete et sa suppression en cascade) : avant, deux
--    comptes rendus simultanés d'une même adresse au seuil de désactivation s'interbloquaient (chacun tenait son
--    envoi et attendait l'adresse, l'autre tenait l'adresse et attendait cet envoi). FOR NO KEY UPDATE reste
--    compatible avec la clé étrangère posée par les nouveaux envois (KEY SHARE) ;
--  * test (« ping ») en échec : définitif aussitôt (aucun nouvel essai), un autre test reste possible ;
--  * désactivation automatique : 50 échecs consécutifs ET aucun envoi réussi depuis 3 jours ; une adresse qui n'a
--    jamais réussi a le même délai, compté depuis sa création ; motif aligné sur cette règle.
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
  v_endpoint uuid;
  v_code integer := case when p_status_code between 0 and 999 then p_status_code end;
  v_error text := left(coalesce(
    nullif(btrim(regexp_replace(coalesce(p_error, ''), '[\s\x01-\x1f\x7f-\x9f\x2028\x2029]+', ' ', 'g')), ''),
    case when p_status_code is not null then format('Réponse HTTP %s', p_status_code) end,
    'Échec de l''envoi (motif inconnu)'), 500);
  v_delays integer[] := array[60, 300, 900, 3600, 10800, 21600, 43200, 86400];
  v_attempts integer;
  v_final boolean;
begin
  -- Adresse d'abord (lue sans verrou : endpoint_id ne change jamais), puis l'envoi
  select w.endpoint_id into v_endpoint from public.webhook_deliveries w where w.id = p_id;
  if not found then
    return;
  end if;
  perform 1 from public.webhook_endpoints x where x.id = v_endpoint for no key update;
  select * into d from public.webhook_deliveries w where w.id = p_id for update;
  if not found then
    -- Adresse supprimée entre-temps (envois supprimés avec elle)
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
  v_final := v_attempts >= 9 or d.event_type = 'ping';
  update public.webhook_deliveries
     set attempts = v_attempts,
         last_status_code = v_code,
         last_error = v_error,
         locked_until = null,
         status = case when v_final then 'failed' else 'pending' end,
         next_attempt_at = case when v_final then next_attempt_at
                                else now() + make_interval(secs => v_delays[v_attempts]) end
   where id = d.id;

  update public.webhook_endpoints
     set consecutive_failures = consecutive_failures + 1, last_failure_at = now(), last_error = v_error
   where id = d.endpoint_id
  returning * into e;
  if found and e.enabled and e.consecutive_failures >= 50
     and coalesce(e.last_success_at, e.created_at) < now() - interval '3 days' then
    update public.webhook_endpoints
       set enabled = false,
           disabled_reason = 'Désactivé automatiquement : 50 échecs consécutifs et aucun envoi réussi depuis 3 jours',
           updated_at = now()
     where id = e.id;
    update public.webhook_deliveries
       set status = 'failed', locked_until = null,
           last_error = left('Webhook désactivé automatiquement (50 échecs consécutifs, aucun envoi réussi depuis 3 jours)'
                             || coalesce(' — ' || last_error, ''), 500)
     where endpoint_id = e.id and status in ('pending', 'sending');
  end if;
end;
$$;

-- ----------------------------------------------------------------- quota des tests et renvois
-- 10 tests (« ping ») et renvois au plus par minute et par centrale, déjà atteints ? Comptés dans le journal d'audit
-- (une ligne « webhook.ping » ou « webhook.redelivered » par appel accepté, index audit_logs_org_idx). À appeler sous
-- le verrou « rydar.webhook-tests:<centrale> » (plafond exact, même pour des appels simultanés).
create or replace function private.webhook_tests_exhausted(p_org uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select count(*) >= 10
    from (select 1
            from public.audit_logs a
           where a.organization_id = p_org
             and a.created_at > now() - interval '1 minute'
             and a.action in ('webhook.ping', 'webhook.redelivered')
           limit 10) x;
$$;

-- ----------------------------------------------------------------- gestion : test et renvoi
-- Dernière définition : 20260924006000. Changements : un seul test en attente ou en cours par adresse
-- (WEBHOOK_TEST_PENDING) et 10 tests et renvois au plus par minute et par centrale (WEBHOOK_TEST_RATE_LIMITED).
-- Ordre des refus : WEBHOOK_NOT_FOUND, WEBHOOK_DISABLED, WEBHOOK_TEST_PENDING, WEBHOOK_TEST_RATE_LIMITED ; un refus
-- n'écrit rien (ni envoi, ni journal).
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
  -- Tests et renvois de la centrale un à la fois : contrôles exacts, même pour des appels simultanés
  perform pg_advisory_xact_lock(hashtextextended('rydar.webhook-tests:' || p_org::text, 0));
  if exists (select 1 from public.webhook_deliveries d
              where d.endpoint_id = e.id and d.event_type = 'ping' and d.status in ('pending', 'sending')) then
    return jsonb_build_object('ok', false, 'code', 'WEBHOOK_TEST_PENDING',
      'message', 'Un test de ce webhook est déjà en cours d''envoi : attendez son résultat avant d''en relancer un.');
  end if;
  if private.webhook_tests_exhausted(p_org) then
    return jsonb_build_object('ok', false, 'code', 'WEBHOOK_TEST_RATE_LIMITED',
      'message', 'Trop de tests et de renvois de webhooks en une minute (10 au plus par centrale) : réessayez dans un instant.');
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

-- Dernière définition : 20260924006000. Changement : 10 tests et renvois au plus par minute et par centrale
-- (WEBHOOK_TEST_RATE_LIMITED, après WEBHOOK_DELIVERY_NOT_FOUND et WEBHOOK_DISABLED ; un refus n'écrit rien).
-- Verrou de la centrale pris AVANT celui de l'envoi (même ordre partout : pas d'interblocage entre deux renvois).
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
  perform pg_advisory_xact_lock(hashtextextended('rydar.webhook-tests:' || p_org::text, 0));
  select w.* into d from public.webhook_deliveries w where w.id = p_delivery_id and w.organization_id = p_org for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WEBHOOK_DELIVERY_NOT_FOUND', 'message', 'Envoi introuvable.');
  end if;
  select e.enabled into v_enabled from public.webhook_endpoints e where e.id = d.endpoint_id;
  if not coalesce(v_enabled, false) then
    return jsonb_build_object('ok', false, 'code', 'WEBHOOK_DISABLED',
      'message', 'Webhook désactivé : réactivez-le avant de renvoyer un événement.');
  end if;
  if private.webhook_tests_exhausted(p_org) then
    return jsonb_build_object('ok', false, 'code', 'WEBHOOK_TEST_RATE_LIMITED',
      'message', 'Trop de tests et de renvois de webhooks en une minute (10 au plus par centrale) : réessayez dans un instant.');
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

-- ----------------------------------------------------------------- droits d'exécution (deny-by-default)
-- Signatures inchangées (create or replace garde les droits de 20260924006000) : rappelés explicitement.
revoke execute on function
  public.svc_webhook_ping(uuid, uuid, public.actor_type, uuid),
  public.svc_webhook_redeliver(uuid, uuid, public.actor_type, uuid)
from public, anon, authenticated;
grant execute on function
  public.svc_webhook_ping(uuid, uuid, public.actor_type, uuid),
  public.svc_webhook_redeliver(uuid, uuid, public.actor_type, uuid)
to service_role;
-- Worker (connexion directe, rôle propriétaire), helpers et déclencheur : jamais appelés par un client ni par le
-- service role
revoke execute on function
  private.webhook_event_types(),
  private.queue_ride_webhooks(),
  private.claim_webhook_deliveries(integer),
  private.complete_webhook_delivery(uuid, boolean, integer, text),
  private.webhook_tests_exhausted(uuid)
from public, anon, authenticated, service_role;
