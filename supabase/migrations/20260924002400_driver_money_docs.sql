-- =============================================================================
-- Rydar Drive — Gains chauffeur + documents (dépôt, validation, échéances)
--
--   organization_settings.driver_commission_percent : commission de la centrale
--   public.driver_earnings(p_days)          chauffeur : jour / semaine / mois, série, dernières courses
--   public.driver_documents()               chauffeur : documents + statut calculé + manquants
--   public.driver_submit_document(...)      chauffeur : dépôt (→ « à valider » côté centrale)
--   public.review_driver_document(...)      centrale  : validation / refus (+ push chauffeur)
--   public.org_document_alerts(p_org)       centrale  : échus / bientôt échus / à valider
--   private.document_reminders()            worker (quotidien) : échéances, rappels J-30 / J-7 / J-0
--
-- Document « courant » : pour un type donné (hors « other »), un document valide
-- plus récent (échéance plus lointaine, puis date de dépôt) remplace les
-- précédents — ils ne sont plus affichés ni rappelés (renouvellement).
-- Temps réel : événement 'driver.document' sur org:{org} (et driver:{driver}).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Colonnes
-- -----------------------------------------------------------------------------
alter table public.organization_settings
  add column driver_commission_percent numeric(5, 2)
    check (driver_commission_percent is null or driver_commission_percent between 0 and 100);

grant update (driver_commission_percent) on public.organization_settings to authenticated;

alter table public.driver_documents
  add column source text not null default 'dashboard' check (source in ('dashboard', 'driver')),
  add column reminders_sent integer[] not null default '{}',
  add column reviewed_at timestamptz,
  add column reviewed_by uuid references public.users (id) on delete set null,
  add column review_note text check (review_note is null or char_length(review_note) <= 500);

create index driver_documents_org_status_idx on public.driver_documents (organization_id, status);
create index driver_documents_expiry_idx on public.driver_documents (expires_at)
  where status in ('valid', 'expired') and expires_at is not null;

-- -----------------------------------------------------------------------------
-- Utilitaires
-- -----------------------------------------------------------------------------
create or replace function private.document_label(p_type public.document_type, p_label text default null)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(nullif(btrim(p_label), ''), case p_type
    when 'driving_license' then 'Permis de conduire'
    when 'vtc_card' then 'Carte VTC'
    when 'insurance' then 'Attestation d''assurance'
    when 'vehicle_registration' then 'Carte grise'
    when 'identity' then 'Pièce d''identité'
    when 'medical' then 'Visite médicale'
    else 'Document'
  end);
$$;

-- Types exigés d'un chauffeur VTC (ordre d'affichage)
create or replace function private.required_document_types()
returns public.document_type[]
language sql
immutable
set search_path = ''
as $$
  select array['vtc_card', 'driving_license', 'identity', 'insurance', 'vehicle_registration']::public.document_type[];
$$;

-- Statut affiché : valid | expiring (≤ 30 j) | expired | pending | rejected
create or replace function private.document_state(p_status public.document_status, p_expires_at date, p_today date)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_status = 'rejected' then 'rejected'
    when p_status = 'pending' then 'pending'
    when p_status = 'expired' or p_expires_at < p_today then 'expired'
    when p_expires_at <= p_today + 30 then 'expiring'
    else 'valid'
  end;
$$;

-- Date du jour dans le fuseau de l'organisation
create or replace function private.org_today(p_org uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone coalesce((select o.timezone from public.organizations o where o.id = p_org), 'Europe/Paris'))::date;
$$;

-- Remplacé par un document valide plus récent du même type (renouvellement) ?
-- Ordre total : (échéance connue, sinon -infini ; date de dépôt ; id).
create or replace function private.document_superseded(p_doc public.driver_documents)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_doc.type <> 'other' and case
    when p_doc.status in ('valid', 'expired') then exists (
      select 1 from public.driver_documents y
      where y.driver_id = p_doc.driver_id
        and y.type = p_doc.type
        and y.id <> p_doc.id
        and y.status = 'valid'
        and (coalesce(y.expires_at, '-infinity'::date), y.created_at, y.id)
          > (coalesce(p_doc.expires_at, '-infinity'::date), p_doc.created_at, p_doc.id)
    )
    when p_doc.status = 'rejected' then exists (
      select 1 from public.driver_documents y
      where y.driver_id = p_doc.driver_id
        and y.type = p_doc.type
        and y.id <> p_doc.id
        and (y.created_at, y.id) > (p_doc.created_at, p_doc.id)
    )
    else false
  end;
$$;

create or replace function private.document_json(p_doc public.driver_documents, p_today date)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_doc.id,
    'driver_id', p_doc.driver_id,
    'type', p_doc.type,
    'label', private.document_label(p_doc.type, p_doc.label),
    'number', p_doc.number,
    'issued_at', p_doc.issued_at,
    'expires_at', p_doc.expires_at,
    'status', private.document_state(p_doc.status, p_doc.expires_at, p_today),
    'days_left', p_doc.expires_at - p_today,
    'file_path', p_doc.file_path,
    'source', p_doc.source,
    'review_note', p_doc.review_note,
    'reviewed_at', p_doc.reviewed_at,
    'created_at', p_doc.created_at,
    'updated_at', p_doc.updated_at
  );
$$;

-- -----------------------------------------------------------------------------
-- Trigger : nouvelle échéance → rappels réarmés (et « expiré » levé si renouvelé) ;
-- validation / refus direct depuis le dashboard → horodatage de la décision.
-- -----------------------------------------------------------------------------
create or replace function private.driver_documents_before_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.expires_at is distinct from old.expires_at then
    new.reminders_sent := '{}';
    if new.status = 'expired' and old.status = 'expired'
       and new.expires_at >= private.org_today(new.organization_id) then
      new.status := 'valid';
    end if;
  end if;
  if old.status = 'pending' and new.status in ('valid', 'rejected')
     and new.reviewed_at is not distinct from old.reviewed_at then
    new.reviewed_at := now();
    new.reviewed_by := auth.uid();
  end if;
  return new;
end;
$$;

create trigger driver_documents_before_update
  before update on public.driver_documents
  for each row execute function private.driver_documents_before_update();

-- -----------------------------------------------------------------------------
-- Gains du chauffeur connecté
-- -----------------------------------------------------------------------------
create or replace function public.driver_earnings(p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_tz text;
  v_currency text;
  v_rate numeric;
  v_days integer := greatest(1, least(coalesce(p_days, 7), 92));
  v_today date;
  v_day timestamptz;
  v_week timestamptz;
  v_month timestamptz;
  v_series_from date;
  v_from timestamptz;
  v_periods jsonb;
  v_series jsonb;
  v_recent jsonb;
  v_upcoming jsonb;
begin
  select * into d from public.drivers where id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;

  select coalesce(o.timezone, 'Europe/Paris'), coalesce(o.currency, 'EUR'), s.driver_commission_percent
    into v_tz, v_currency, v_rate
  from public.organizations o
  left join public.organization_settings s on s.organization_id = o.id
  where o.id = d.organization_id;

  v_today := (now() at time zone v_tz)::date;
  v_day := v_today::timestamp at time zone v_tz;
  v_week := date_trunc('week', v_today::timestamp) at time zone v_tz;   -- lundi
  v_month := date_trunc('month', v_today::timestamp) at time zone v_tz;
  v_series_from := v_today - (v_days - 1);
  v_from := least(v_week, v_month, v_series_from::timestamp at time zone v_tz);

  with done as (
    select coalesce(r.completed_at, r.pickup_at) as done_at,
           r.price_cents,
           r.payment_method,
           r.estimated_distance_m,
           r.estimated_duration_s,
           case when v_rate is not null and r.price_cents is not null
                then round(r.price_cents * (100 - v_rate) / 100)::integer end as net_cents
    from public.rides r
    where r.driver_id = d.id
      and r.status = 'COMPLETED'
      and coalesce(r.completed_at, r.pickup_at) >= v_from
  ),
  periods (key, since) as (
    values ('today', v_day), ('week', v_week), ('month', v_month)
  ),
  agg as (
    select p.key,
           p.since,
           count(x.done_at) as rides,
           coalesce(sum(x.price_cents), 0) as revenue_cents,
           coalesce(sum(x.net_cents), 0) as net_cents,
           coalesce(sum(x.price_cents) filter (where x.payment_method = 'cash'), 0) as cash_cents,
           coalesce(sum(x.estimated_distance_m), 0) as distance_m,
           coalesce(sum(x.estimated_duration_s), 0) as duration_s,
           count(x.done_at) filter (where x.price_cents is null) as unpriced
    from periods p
    left join done x on x.done_at >= p.since
    group by p.key, p.since
  ),
  daily as (
    select (x.done_at at time zone v_tz)::date as day,
           count(*) as rides,
           coalesce(sum(x.price_cents), 0) as revenue_cents,
           coalesce(sum(x.net_cents), 0) as net_cents,
           coalesce(sum(x.estimated_distance_m), 0) as distance_m
    from done x
    where x.done_at >= v_series_from::timestamp at time zone v_tz
    group by 1
  )
  select
    (select jsonb_object_agg(a.key, jsonb_build_object(
        'from', a.since,
        'rides', a.rides,
        'revenue_cents', a.revenue_cents,
        'net_cents', case when v_rate is null then null else a.net_cents end,
        'commission_cents', case when v_rate is null then null else a.revenue_cents - a.net_cents end,
        'cash_cents', a.cash_cents,
        'distance_m', a.distance_m,
        'duration_s', a.duration_s,
        'unpriced_rides', a.unpriced))
     from agg a),
    (select jsonb_agg(jsonb_build_object(
        'date', to_char(g.day, 'YYYY-MM-DD'),
        'rides', coalesce(y.rides, 0),
        'revenue_cents', coalesce(y.revenue_cents, 0),
        'net_cents', case when v_rate is null then null else coalesce(y.net_cents, 0) end,
        'distance_m', coalesce(y.distance_m, 0)) order by g.day)
     from generate_series(v_series_from::timestamp, v_today::timestamp, interval '1 day') as g (day)
     left join daily y on y.day = g.day::date)
  into v_periods, v_series;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id,
      'number', x.number,
      'pickup', coalesce(private.short_address(x.pickup_address), x.pickup_address),
      'dropoff', coalesce(private.short_address(x.dropoff_address), x.dropoff_address),
      'completed_at', x.done_at,
      'price_cents', x.price_cents,
      'net_cents', case when v_rate is not null and x.price_cents is not null
                        then round(x.price_cents * (100 - v_rate) / 100)::integer end,
      'currency', x.currency,
      'payment_method', x.payment_method,
      'vehicle_category', x.vehicle_category,
      'distance_m', x.estimated_distance_m,
      'duration_s', x.estimated_duration_s) order by x.done_at desc, x.number desc), '[]'::jsonb)
    into v_recent
  from (
    select r.id, r.number, r.pickup_address, r.dropoff_address, r.price_cents, r.currency, r.payment_method,
           r.vehicle_category, r.estimated_distance_m, r.estimated_duration_s,
           coalesce(r.completed_at, r.pickup_at) as done_at
    from public.rides r
    where r.driver_id = d.id and r.status = 'COMPLETED'
    order by coalesce(r.completed_at, r.pickup_at) desc, r.number desc
    limit 20
  ) x;

  select jsonb_build_object(
      'rides', count(*),
      'revenue_cents', coalesce(sum(r.price_cents), 0),
      'net_cents', case when v_rate is null then null
                        else coalesce(sum(round(r.price_cents * (100 - v_rate) / 100)::integer), 0) end)
    into v_upcoming
  from public.rides r
  where r.driver_id = d.id
    and r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS');

  return jsonb_build_object(
    'currency', v_currency,
    'timezone', v_tz,
    'commission_percent', v_rate,
    'days', v_days,
    'today', v_periods -> 'today',
    'week', v_periods -> 'week',
    'month', v_periods -> 'month',
    'upcoming', v_upcoming,
    'series', coalesce(v_series, '[]'::jsonb),
    'recent', v_recent
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Documents du chauffeur connecté
-- -----------------------------------------------------------------------------
create or replace function public.driver_documents()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_today date;
  v_docs jsonb;
begin
  select * into d from public.drivers where id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  v_today := private.org_today(d.organization_id);

  select coalesce(jsonb_agg(private.document_json(x, v_today)
           order by coalesce(array_position(private.required_document_types(), x.type), 99), x.type, x.created_at desc, x.id),
         '[]'::jsonb)
    into v_docs
  from public.driver_documents x
  where x.driver_id = d.id
    and not private.document_superseded(x);

  return jsonb_build_object(
    'today', v_today,
    'documents', v_docs,
    'summary', (
      select jsonb_build_object(
        'valid', count(*) filter (where e ->> 'status' = 'valid'),
        'expiring', count(*) filter (where e ->> 'status' = 'expiring'),
        'expired', count(*) filter (where e ->> 'status' = 'expired'),
        'pending', count(*) filter (where e ->> 'status' = 'pending'),
        'rejected', count(*) filter (where e ->> 'status' = 'rejected'))
      from jsonb_array_elements(v_docs) e
    ),
    -- Types exigés sans document utilisable (valide, bientôt échu ou en validation)
    'missing_types', (
      select coalesce(jsonb_agg(t order by u.ord), '[]'::jsonb)
      from unnest(private.required_document_types()) with ordinality as u (t, ord)
      where not exists (
        select 1 from jsonb_array_elements(v_docs) e
        where e ->> 'type' = u.t::text and e ->> 'status' in ('valid', 'expiring', 'pending')
      )
    )
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Dépôt d'un document par le chauffeur (fichier déjà envoyé dans le bucket
-- driver-documents, chemin {org}/{driver}/…) → « à valider » pour la centrale.
-- Un nouveau dépôt du même type (hors « other ») remplace celui en attente.
-- -----------------------------------------------------------------------------
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
  select * into d from public.drivers where id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  perform private.set_actor('driver', d.id);

  if p_type is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TYPE', 'message', 'Type de document manquant.');
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

-- -----------------------------------------------------------------------------
-- Validation / refus par la centrale (owner, admin, dispatcher)
-- -----------------------------------------------------------------------------
create or replace function public.review_driver_document(
  p_document_id uuid,
  p_approve boolean,
  p_note text default null,
  p_expires_at date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.driver_documents;
  d public.drivers;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_today date;
  v_label text;
  v_action text;
  v_json jsonb;
begin
  select * into v_doc from public.driver_documents where id = p_document_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'DOCUMENT_NOT_FOUND', 'message', 'Document introuvable.');
  end if;
  perform private.assert_org_member(v_doc.organization_id, array['owner', 'admin', 'dispatcher']::public.org_role[]);
  perform private.set_actor('user', auth.uid());

  if p_approve is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DECISION', 'message', 'Décision manquante.');
  end if;
  if v_doc.status <> 'pending' then
    return jsonb_build_object('ok', false, 'code', 'DOCUMENT_NOT_PENDING', 'message', 'Ce document a déjà été traité.');
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_NOTE', 'message', 'Commentaire trop long (500 caractères max).');
  end if;

  v_today := private.org_today(v_doc.organization_id);
  if p_expires_at is not null and p_expires_at > v_today + 365 * 30 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_EXPIRY', 'message', 'Date d''expiration invalide.');
  end if;
  if p_approve and coalesce(p_expires_at, v_doc.expires_at) < v_today then
    return jsonb_build_object('ok', false, 'code', 'DOCUMENT_EXPIRED',
      'message', 'Ce document est expiré : corrigez la date ou refusez-le.');
  end if;
  -- Pièce à échéance validée sans date : elle serait classée derrière l'ancienne (document_superseded)
  -- et l'ancienne continuerait d'être affichée et rappelée → date obligatoire pour valider
  if p_approve and coalesce(p_expires_at, v_doc.expires_at) is null
     and v_doc.type in ('vtc_card', 'driving_license', 'insurance', 'identity', 'medical') then
    return jsonb_build_object('ok', false, 'code', 'EXPIRY_REQUIRED',
      'message', 'Indiquez la date d''expiration pour valider ce document.');
  end if;

  update public.driver_documents
     set status = case when p_approve then 'valid' else 'rejected' end::public.document_status,
         expires_at = case when p_approve and p_expires_at is not null then p_expires_at else expires_at end,
         reviewed_at = now(),
         reviewed_by = auth.uid(),
         review_note = v_note
   where id = v_doc.id
  returning * into v_doc;

  select * into d from public.drivers where id = v_doc.driver_id;
  v_label := private.document_label(v_doc.type, v_doc.label);
  v_action := case when p_approve then 'validated' else 'rejected' end;
  v_json := private.document_json(v_doc, v_today);

  perform private.queue_notification(v_doc.organization_id, v_doc.driver_id, null, null, 'document_reviewed',
    case when p_approve then 'Document validé' else 'Document refusé' end,
    case when p_approve then format('%s : la centrale a validé votre document.', v_label)
         else format('%s : %s', v_label, coalesce(v_note, 'la centrale a refusé ce document. Contactez-la pour en savoir plus.'))
    end,
    jsonb_build_object('type', 'document_reviewed', 'document_id', v_doc.id, 'document_type', v_doc.type,
      'status', v_doc.status),
    'normal', null);

  perform private.log_event(v_doc.organization_id, null, 'document.' || v_action,
    format('%s : %s — %s %s (#%s)', case when p_approve then 'Document validé' else 'Document refusé' end,
      v_label, d.first_name, d.last_name, d.number),
    'timeline', case when p_approve then 'success' else 'warning' end::public.event_level,
    jsonb_build_object('driver_id', d.id, 'document_id', v_doc.id, 'document_type', v_doc.type, 'note', v_note),
    'user', auth.uid());

  perform realtime.send(
    jsonb_build_object('action', v_action, 'document', v_json,
      'driver', jsonb_build_object('id', d.id, 'number', d.number, 'first_name', d.first_name, 'last_name', d.last_name)),
    'driver.document', 'org:' || v_doc.organization_id::text, true);
  perform realtime.send(
    jsonb_build_object('action', v_action, 'document', v_json),
    'driver.document', 'driver:' || v_doc.driver_id::text, true);

  return jsonb_build_object(
    'ok', true,
    'code', case when p_approve then 'DOCUMENT_VALIDATED' else 'DOCUMENT_REJECTED' end,
    'document', v_json);
end;
$$;

-- -----------------------------------------------------------------------------
-- Documents à traiter pour la centrale : à valider, échus, bientôt échus (≤ 30 j)
-- -----------------------------------------------------------------------------
create or replace function public.org_document_alerts(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date;
  v_items jsonb;
begin
  perform private.assert_org_reader(p_org);
  v_today := private.org_today(p_org);

  select coalesce(jsonb_agg(
           private.document_json(x, v_today) || jsonb_build_object('driver', jsonb_build_object(
             'id', dr.id, 'number', dr.number, 'first_name', dr.first_name, 'last_name', dr.last_name,
             'photo_url', dr.photo_url, 'status', dr.status))
           order by x.expires_at nulls last, x.created_at, x.id), '[]'::jsonb)
    into v_items
  from public.driver_documents x
  join public.drivers dr on dr.id = x.driver_id
  where x.organization_id = p_org
    and dr.status <> 'inactive'
    and (
      x.status = 'pending'
      or (x.status in ('valid', 'expired') and (x.status = 'expired' or x.expires_at <= v_today + 30))
    )
    and not private.document_superseded(x);

  return jsonb_build_object(
    'today', v_today,
    'counts', jsonb_build_object(
      'pending', (select count(*) from jsonb_array_elements(v_items) e where e ->> 'status' = 'pending'),
      'expired', (select count(*) from jsonb_array_elements(v_items) e where e ->> 'status' = 'expired'),
      'expiring', (select count(*) from jsonb_array_elements(v_items) e where e ->> 'status' = 'expiring')),
    'pending', (select coalesce(jsonb_agg(e order by e ->> 'created_at'), '[]'::jsonb)
                from jsonb_array_elements(v_items) e where e ->> 'status' = 'pending'),
    'expired', (select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(v_items) e where e ->> 'status' = 'expired'),
    'expiring', (select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(v_items) e where e ->> 'status' = 'expiring')
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Tâche quotidienne (worker) : échéances + rappels J-30, J-7, J-0 (une fois par seuil)
-- -----------------------------------------------------------------------------
create or replace function private.document_reminders()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_expired integer := 0;
  v_sent integer := 0;
  v_silent integer := 0;
  v_threshold integer;
  v_marks integer[];
  v_label text;
  v_type text;
  v_title text;
  v_body text;
  v_at timestamptz;
  v_json jsonb;
  v_action text;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('rydar.document_reminders', 0)) then
    return jsonb_build_object('skipped', 'already_running');
  end if;
  perform private.set_actor('system', null);

  -- 1) Échéance dépassée (jour J+1 dans le fuseau de l'organisation) → « expired ».
  --    SKIP LOCKED : jamais d'attente (ni d'interblocage avec housekeeping) ; une ligne
  --    sautée est rattrapée au passage suivant, et les rappels ci-dessous la traitent déjà.
  update public.driver_documents x
     set status = 'expired'
   where x.status = 'valid'
     and x.id in (
       select y.id
       from public.driver_documents y
       join public.organizations o on o.id = y.organization_id
       where y.status = 'valid'
         and y.expires_at < (now() at time zone o.timezone)::date
       for update of y skip locked
     );
  get diagnostics v_expired = row_count;

  -- 2) Rappels : le seuil le plus urgent atteint et non encore envoyé
  for r in
    select x as doc,
           x.expires_at - (now() at time zone o.timezone)::date as days_left,
           (now() at time zone o.timezone) as local_now,
           o.timezone as tz,
           dr.first_name, dr.last_name, dr.number as driver_number
    from public.driver_documents x
    join public.organizations o on o.id = x.organization_id
    join public.drivers dr on dr.id = x.driver_id
    where x.status in ('valid', 'expired')
      and x.expires_at is not null
      and o.status = 'active'
      and dr.status = 'active'
      and (
           (x.expires_at - (now() at time zone o.timezone)::date <= 30 and not (30 = any (x.reminders_sent)))
        or (x.expires_at - (now() at time zone o.timezone)::date <= 7 and not (7 = any (x.reminders_sent)))
        or (x.expires_at - (now() at time zone o.timezone)::date <= 0 and not (0 = any (x.reminders_sent)))
      )
    order by x.expires_at, x.id
    for update of x skip locked
  loop
    v_threshold := case when r.days_left <= 0 then 0 when r.days_left <= 7 then 7 else 30 end;
    v_marks := array(select t from unnest(array[30, 7, 0]) as t where t >= v_threshold);

    -- Échu depuis longtemps (import, reprise) ou seuil urgent déjà traité : marqué sans notifier
    if r.days_left < -7 or v_threshold = any ((r.doc).reminders_sent) then
      update public.driver_documents
         set reminders_sent = array(select distinct t from unnest(reminders_sent || v_marks) as t order by t desc)
       where id = (r.doc).id;
      v_silent := v_silent + 1;
      continue;
    end if;

    -- Renouvelé (un document valide plus récent du même type existe) : rien à rappeler
    continue when private.document_superseded(r.doc);

    v_label := private.document_label((r.doc).type, (r.doc).label);
    if r.days_left < 0 then
      v_type := 'document_expired';
      v_action := 'expired';
      v_title := format('Document expiré : %s', v_label);
      v_body := format('Échéance dépassée depuis le %s. Déposez le nouveau document au plus vite.',
        to_char((r.doc).expires_at, 'DD/MM/YYYY'));
    else
      v_type := 'document_expiring';
      v_action := 'expiring';
      v_title := case
        when r.days_left = 0 then format('%s expire aujourd''hui', v_label)
        when r.days_left = 1 then format('%s expire demain', v_label)
        else format('%s expire dans %s jours', v_label, r.days_left)
      end;
      v_body := format('Échéance le %s. Déposez le nouveau document depuis l''application.',
        to_char((r.doc).expires_at, 'DD/MM/YYYY'));
    end if;

    -- Pas de push nocturne : avant 9 h (heure locale) → envoi programmé à 9 h
    v_at := case when r.local_now::time < time '09:00'
                 then (r.local_now::date + time '09:00') at time zone r.tz
                 else now() end;

    perform private.queue_notification((r.doc).organization_id, (r.doc).driver_id, null, null, v_type, v_title, v_body,
      jsonb_build_object('type', v_type, 'document_id', (r.doc).id, 'document_type', (r.doc).type,
        'expires_at', (r.doc).expires_at, 'days_left', r.days_left, 'threshold', v_threshold),
      case when v_threshold = 30 then 'normal' else 'high' end, v_at);

    update public.driver_documents
       set reminders_sent = array(select distinct t from unnest(reminders_sent || v_marks) as t order by t desc)
     where id = (r.doc).id;
    v_sent := v_sent + 1;

    -- Centrale : journal à J-7 et à l'échéance, temps réel à chaque rappel
    if v_threshold <= 7 then
      perform private.log_event((r.doc).organization_id, null, 'document.' || v_action,
        case
          when r.days_left < 0 then format('%s de %s %s (#%s) : échéance dépassée depuis le %s', v_label, r.first_name,
            r.last_name, r.driver_number, to_char((r.doc).expires_at, 'DD/MM/YYYY'))
          when r.days_left = 0 then format('%s de %s %s (#%s) : expire aujourd''hui', v_label, r.first_name, r.last_name,
            r.driver_number)
          else format('%s de %s %s (#%s) : expire dans %s %s', v_label, r.first_name, r.last_name, r.driver_number,
            r.days_left, private.pl(r.days_left, 'jour', 'jours'))
        end,
        'timeline', 'warning',
        jsonb_build_object('driver_id', (r.doc).driver_id, 'document_id', (r.doc).id, 'document_type', (r.doc).type,
          'expires_at', (r.doc).expires_at, 'days_left', r.days_left),
        'system', null);
    end if;

    v_json := private.document_json(r.doc, (r.local_now)::date);
    perform realtime.send(
      jsonb_build_object('action', v_action, 'threshold', v_threshold, 'document', v_json,
        'driver', jsonb_build_object('id', (r.doc).driver_id, 'number', r.driver_number,
          'first_name', r.first_name, 'last_name', r.last_name)),
      'driver.document', 'org:' || (r.doc).organization_id::text, true);
    perform realtime.send(
      jsonb_build_object('action', v_action, 'threshold', v_threshold, 'document', v_json),
      'driver.document', 'driver:' || (r.doc).driver_id::text, true);
  end loop;

  return jsonb_build_object('expired', v_expired, 'reminders', v_sent, 'silent', v_silent);
end;
$$;

-- -----------------------------------------------------------------------------
-- Stockage : un chauffeur dépose dans son dossier driver-documents/{org}/{driver}/
-- (insertion seule : pas d'écrasement d'un fichier déjà validé).
-- Installée par fonction pour rester rejouable / testable sans Supabase Storage.
-- -----------------------------------------------------------------------------
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
      and (storage.foldername(name))[1] = coalesce((select private.current_driver_org_id())::text, '-')
      and (storage.foldername(name))[2] = coalesce((select private.current_driver_id())::text, '-')
    )
  $p$;
  return true;
end;
$$;

select private.install_driver_document_storage_policy();

-- -----------------------------------------------------------------------------
-- Droits d'exécution (cf. 20260924000900)
-- -----------------------------------------------------------------------------
revoke execute on function
  private.document_label(public.document_type, text),
  private.required_document_types(),
  private.document_state(public.document_status, date, date),
  private.org_today(uuid),
  private.document_superseded(public.driver_documents),
  private.document_json(public.driver_documents, date),
  private.driver_documents_before_update(),
  private.document_reminders(),
  private.install_driver_document_storage_policy()
from public, anon, authenticated;
grant execute on function
  private.document_label(public.document_type, text),
  private.required_document_types(),
  private.document_state(public.document_status, date, date),
  private.org_today(uuid),
  private.document_superseded(public.driver_documents),
  private.document_json(public.driver_documents, date),
  private.driver_documents_before_update(),
  private.document_reminders(),
  private.install_driver_document_storage_policy()
to service_role;

revoke execute on function
  public.driver_earnings(integer),
  public.driver_documents(),
  public.driver_submit_document(public.document_type, text, date, text, date, text),
  public.review_driver_document(uuid, boolean, text, date),
  public.org_document_alerts(uuid)
from public, anon;
grant execute on function
  public.driver_earnings(integer),
  public.driver_documents(),
  public.driver_submit_document(public.document_type, text, date, text, date, text),
  public.review_driver_document(uuid, boolean, text, date),
  public.org_document_alerts(uuid)
to authenticated, service_role;
