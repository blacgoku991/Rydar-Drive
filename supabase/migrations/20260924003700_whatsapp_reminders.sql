-- =============================================================================
-- Rydar Drive — Relances WhatsApp automatiques (API officielle WhatsApp Business Cloud de Meta).
--
--  * Centrale → chauffeurs : les relances de commission (bouton « Relancer » et relances automatiques du
--    worker) partent par l'application, par WhatsApp, ou les deux (organization_settings.reminder_channels).
--    Le message part du numéro WhatsApp Business de la centrale (son compte dispatch), configuré dans
--    Réglages › Commission & encaissement : identifiant du numéro (Phone Number ID) + jeton d'accès Meta.
--    WhatsApp impossible (non configuré, numéro du chauffeur invalide, refus définitif de Meta) → la
--    relance passe par l'application : le chauffeur est toujours prévenu.
--  * Rydar → propriétaire de la centrale : la relance des frais plateforme (/admin/frais) peut aussi partir
--    par WhatsApp, du numéro WhatsApp Business de Rydar (configuré par le super admin), vers le téléphone
--    du propriétaire (profil) ou, à défaut, celui de la centrale.
--  * Messages « modèles » (templates) validés par Meta, catégorie « Utilité », en français :
--    rappel_commission (4 variables) et rappel_frais_plateforme (3 variables) — textes dans docs/WHATSAPP.md.
--  * Jetons d'accès : tables *_secrets lisibles par le service role SEULEMENT (web : enregistrement et test,
--    worker : envoi). Jamais renvoyés au navigateur ni écrits dans le journal d'audit.
--  * File d'envoi : public.notifications, canal 'whatsapp' (20260924003600) ; le worker les réserve par
--    private.claim_whatsapp et les termine par private.complete_whatsapp (mêmes reprises que les pushes).
-- =============================================================================

-- ----------------------------------------------------------------- canaux des relances chauffeur
alter table public.organization_settings
  add column if not exists reminder_channels text[] not null default '{app}';
alter table public.organization_settings
  add constraint organization_settings_reminder_channels_check
  check (cardinality(reminder_channels) between 1 and 2 and reminder_channels <@ array['app', 'whatsapp']::text[]);
grant update (reminder_channels) on public.organization_settings to authenticated;

-- ----------------------------------------------------------------- numéros WhatsApp Business
create table public.org_whatsapp (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  phone_number_id text not null check (phone_number_id ~ '^[0-9]{5,30}$'),
  display_phone text check (display_phone is null or char_length(display_phone) <= 40),
  verified_name text check (verified_name is null or char_length(verified_name) <= 200),
  template text not null default 'rappel_commission' check (char_length(template) <= 512 and template ~ '^[a-z0-9_]+$'),
  language text not null default 'fr' check (language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  enabled boolean not null default true,
  sent_count integer not null default 0,
  last_sent_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users (id) on delete set null
);
comment on table public.org_whatsapp is
  'Numéro WhatsApp Business de la centrale (relances chauffeurs) — écriture : svc_whatsapp_save (web, service role).';

create table public.platform_whatsapp (
  id boolean primary key default true check (id),
  phone_number_id text not null check (phone_number_id ~ '^[0-9]{5,30}$'),
  display_phone text check (display_phone is null or char_length(display_phone) <= 40),
  verified_name text check (verified_name is null or char_length(verified_name) <= 200),
  template text not null default 'rappel_frais_plateforme' check (char_length(template) <= 512 and template ~ '^[a-z0-9_]+$'),
  language text not null default 'fr' check (language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  enabled boolean not null default true,
  sent_count integer not null default 0,
  last_sent_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users (id) on delete set null
);
comment on table public.platform_whatsapp is
  'Numéro WhatsApp Business de Rydar (relances des frais plateforme aux propriétaires de centrale) — écriture : super admin.';

create table public.org_whatsapp_secrets (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  access_token text not null check (char_length(access_token) between 20 and 2048),
  updated_at timestamptz not null default now()
);
create table public.platform_whatsapp_secrets (
  id boolean primary key default true check (id),
  access_token text not null check (char_length(access_token) between 20 and 2048),
  updated_at timestamptz not null default now()
);
comment on table public.org_whatsapp_secrets is 'Jeton d''accès Meta de la centrale — service role uniquement.';
comment on table public.platform_whatsapp_secrets is 'Jeton d''accès Meta de Rydar — service role uniquement.';

alter table public.org_whatsapp enable row level security;
alter table public.platform_whatsapp enable row level security;
alter table public.org_whatsapp_secrets enable row level security;
alter table public.platform_whatsapp_secrets enable row level security;

create policy org_whatsapp_select on public.org_whatsapp for select to authenticated
  using (organization_id in (select private.admin_org_ids()) or (select private.is_super_admin()));
create policy platform_whatsapp_select on public.platform_whatsapp for select to authenticated
  using ((select private.is_super_admin()));

revoke all on public.org_whatsapp, public.platform_whatsapp from anon, authenticated;
grant select on public.org_whatsapp, public.platform_whatsapp to authenticated;
revoke all on public.org_whatsapp_secrets, public.platform_whatsapp_secrets from anon, authenticated;
grant all on public.org_whatsapp, public.platform_whatsapp, public.org_whatsapp_secrets, public.platform_whatsapp_secrets to service_role;

-- ----------------------------------------------------------------- numéro au format WhatsApp (chiffres, indicatif)
-- Même règle que normalizePhone (@rydar/shared) : « 06 12 34 56 78 » → 33612345678 ; null si inexploitable.
create or replace function private.wa_phone(p_phone text, p_country text default 'FR')
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
  v_cc text := case upper(coalesce(p_country, 'FR'))
    when 'FR' then '33' when 'BE' then '32' when 'CH' then '41' when 'LU' then '352' when 'MC' then '377'
    when 'GB' then '44' when 'ES' then '34' when 'IT' then '39' when 'DE' then '49' when 'PT' then '351'
    when 'NL' then '31' when 'MA' then '212' when 'DZ' then '213' when 'TN' then '216'
    when 'US' then '1' when 'CA' then '1' else '33' end;
begin
  if left(v, 2) = '00' then
    v := '+' || substr(v, 3);
  end if;
  if left(v, 1) <> '+' then
    if left(v, 1) = '0' and length(v) = 10 then
      v := '+' || v_cc || substr(v, 2);
    elsif length(v) >= 9 then
      v := '+' || v;
    end if;
  end if;
  if v !~ '^\+[1-9][0-9]{7,14}$' then
    return null;
  end if;
  return substr(v, 2);
end;
$$;

-- « 33612345678 » → « +33 6 •• •• •• 78 » (affichage et journal, sans le numéro complet)
create or replace function private.wa_mask(p_to text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_to is null then null
    when p_to ~ '^33[0-9]{9}$' then '+33 ' || substr(p_to, 3, 1) || ' •• •• •• ' || right(p_to, 2)
    else '+' || left(p_to, 3) || ' •• ' || right(p_to, 2) end;
$$;

-- Expéditeur utilisable : 'org' (numéro de la centrale) ou 'platform' (numéro de Rydar)
create or replace function private.whatsapp_ready(p_sender text, p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_sender
    when 'org' then exists (
      select 1 from public.org_whatsapp w
      join public.org_whatsapp_secrets s on s.organization_id = w.organization_id
      where w.organization_id = p_org and w.enabled)
    when 'platform' then exists (
      select 1 from public.platform_whatsapp w
      join public.platform_whatsapp_secrets s on s.id = w.id
      where w.enabled)
    else false end;
$$;

-- ----------------------------------------------------------------- file d'envoi WhatsApp
-- p_params : variables du modèle, dans l'ordre ({{1}}, {{2}}…). p_fallback : push à envoyer si WhatsApp échoue
-- définitivement ({title, body, type, data}) — seulement quand l'application n'a pas déjà été prévenue.
create or replace function private.queue_whatsapp(
  p_org uuid,
  p_driver uuid,
  p_user uuid,
  p_sender text,
  p_to text,
  p_type text,
  p_title text,
  p_body text,
  p_params text[],
  p_fallback jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_sender not in ('org', 'platform') or p_to is null then
    raise exception 'WHATSAPP_INVALID: expéditeur ou destinataire manquant' using errcode = '22023';
  end if;
  insert into public.notifications (organization_id, driver_id, user_id, channel, type, title, body, data, priority)
  values (p_org, p_driver, p_user, 'whatsapp', p_type, p_title, p_body,
    jsonb_build_object(
      'sender', p_sender,
      'to', p_to,
      -- WhatsApp refuse retours à la ligne, tabulations et plus de 4 espaces dans une variable
      'params', (select coalesce(jsonb_agg(left(btrim(regexp_replace(coalesce(x, ''), '\s+', ' ', 'g')), 200) order by i), '[]'::jsonb)
                 from unnest(p_params) with ordinality as t(x, i)),
      'fallback', p_fallback),
    'normal')
  returning id into v_id;
  perform pg_notify('rydar_notifications', v_id::text);
  return v_id;
end;
$$;

-- Relance d'un chauffeur par les canaux demandés ; renvoie les canaux utilisés et, si WhatsApp était demandé
-- mais impossible, la raison (le push part alors à sa place).
create or replace function private.remind_driver(
  p_org uuid,
  p_driver uuid,
  p_channels text[],
  p_type text,
  p_title text,
  p_body text,
  p_data jsonb,
  p_params text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_to text;
  v_country text;
  v_wa_error text;
  v_app boolean;
  v_wa boolean := false;
  v_used text[] := '{}';
begin
  if 'whatsapp' = any (p_channels) then
    if not private.whatsapp_ready('org', p_org) then
      v_wa_error := 'NOT_CONFIGURED';
    else
      select o.country into v_country from public.organizations o where o.id = p_org;
      select private.wa_phone(d.phone, v_country) into v_to from public.drivers d where d.id = p_driver;
      if v_to is null then
        v_wa_error := 'INVALID_PHONE';
      else
        v_wa := true;
      end if;
    end if;
  end if;
  v_app := 'app' = any (p_channels) or not v_wa;

  if v_app then
    perform private.queue_notification(p_org, p_driver, null, null, p_type, p_title, p_body, p_data, 'high', null);
    v_used := v_used || 'app'::text;
  end if;
  if v_wa then
    perform private.queue_whatsapp(p_org, p_driver, null, 'org', v_to, p_type, p_title, p_body, p_params,
      case when v_app then null
           else jsonb_build_object('type', p_type, 'title', p_title, 'body', p_body, 'data', p_data) end);
    v_used := v_used || 'whatsapp'::text;
  end if;
  return jsonb_build_object('channels', to_jsonb(v_used), 'whatsapp_error', v_wa_error);
end;
$$;

-- « par l'application », « par WhatsApp », « par WhatsApp et l'application »
create or replace function private.channels_label(p_channels jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_channels ? 'whatsapp' and p_channels ? 'app' then 'par WhatsApp et l''application'
    when p_channels ? 'whatsapp' then 'par WhatsApp'
    else 'par l''application' end;
$$;

-- ----------------------------------------------------------------- relance manuelle d'un chauffeur (dashboard)
-- Dernière définition : 20260924002600. p_channels : null = réglage de la centrale.
drop function if exists public.remind_driver_settlements(uuid);
create function public.remind_driver_settlements(p_driver_id uuid, p_channels text[] default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_total integer;
  v_n integer;
  v_ids uuid[];
  v_last timestamptz;
  v_name text;
  v_channels text[];
  v_res jsonb;
  v_label text;
  v_note text;
begin
  select * into d from public.drivers where id = p_driver_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Chauffeur introuvable.');
  end if;
  perform private.assert_org_member(d.organization_id);
  if p_channels is not null
     and (cardinality(p_channels) not between 1 and 2 or not p_channels <@ array['app', 'whatsapp']::text[]) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CHANNELS', 'message', 'Canal de relance invalide.');
  end if;
  perform private.set_actor('user', auth.uid());

  select coalesce(sum(x.amount_cents), 0), count(*), coalesce(array_agg(x.id), '{}'), max(x.last_reminded_at)
    into v_total, v_n, v_ids, v_last
  from public.ride_settlements x
  where x.driver_id = d.id and x.direction = 'driver_owes' and x.status in ('due', 'disputed');
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'code', 'NOTHING_DUE', 'message', 'Aucune commission à régler pour ce chauffeur.');
  end if;
  if v_last > now() - interval '30 minutes' then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED', 'message', 'Rappel déjà envoyé il y a moins de 30 minutes.');
  end if;

  select o.name, coalesce(p_channels, s.reminder_channels, '{app}')
    into v_name, v_channels
  from public.organizations o
  left join public.organization_settings s on s.organization_id = o.id
  where o.id = d.organization_id;

  v_res := private.remind_driver(d.organization_id, d.id, v_channels, 'settlement_reminder', 'RAPPEL COMMISSION',
    format('%s à régler à %s (%s %s)', private.fmt_eur(v_total), v_name, v_n, private.pl(v_n, 'course', 'courses')),
    jsonb_build_object('type', 'settlement_reminder', 'amount_cents', v_total, 'count', v_n),
    array[d.first_name, private.fmt_eur(v_total), v_name, format('%s %s', v_n, private.pl(v_n, 'course', 'courses'))]);
  v_label := private.channels_label(v_res -> 'channels');
  v_note := case v_res ->> 'whatsapp_error'
    when 'NOT_CONFIGURED' then ' (WhatsApp non configuré)'
    when 'INVALID_PHONE' then ' (numéro du chauffeur invalide pour WhatsApp)'
    else '' end;

  update public.ride_settlements
     set last_reminded_at = now(), reminders_sent = reminders_sent + 1
   where id = any (v_ids);
  perform private.log_event(d.organization_id, null, 'settlement.reminded',
    format('Rappel envoyé %s à %s %s (#%s) : %s à régler%s', v_label, d.first_name, d.last_name, d.number, private.fmt_eur(v_total), v_note),
    'timeline', 'info',
    jsonb_build_object('driver_id', d.id, 'amount_cents', v_total, 'count', v_n, 'channels', v_res -> 'channels',
      'whatsapp_error', v_res -> 'whatsapp_error'),
    'user', auth.uid());
  return jsonb_build_object('ok', true, 'code', 'REMINDED', 'amount_cents', v_total, 'count', v_n,
    'channels', v_res -> 'channels', 'whatsapp_error', v_res -> 'whatsapp_error',
    'message', format('Rappel envoyé %s%s.', v_label, v_note));
end;
$$;

-- ----------------------------------------------------------------- relances automatiques (worker, toutes les 15 min)
-- Dernière définition : 20260924002600. Mêmes canaux que la relance manuelle (réglage de la centrale).
create or replace function private.settlement_reminders()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_count integer := 0;
  v_wa integer := 0;
  v_res jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('rydar.settlement_reminders', 0)) then
    return jsonb_build_object('ok', false, 'code', 'BUSY', 'reminders', 0);
  end if;
  for v in
    select x.driver_id, x.organization_id, o.name as org_name, d.first_name,
           coalesce(s.reminder_channels, '{app}') as channels,
           sum(x.amount_cents)::integer as total, count(*) as n, array_agg(x.id) as ids
    from public.ride_settlements x
    join public.organizations o on o.id = x.organization_id
    join public.drivers d on d.id = x.driver_id
    left join public.organization_settings s on s.organization_id = x.organization_id
    where x.direction = 'driver_owes'
      and x.status in ('due', 'disputed')
      and x.due_at <= now()
      and o.status = 'active'
      and o.dispatch_model = 'centrale'
      and d.status = 'active'
    group by x.driver_id, x.organization_id, o.name, d.first_name, s.reminder_channels
    having min(x.reminders_sent) < 3
       and coalesce(max(x.last_reminded_at), '-infinity'::timestamptz) < now() - interval '23 hours'
  loop
    v_res := private.remind_driver(v.organization_id, v.driver_id, v.channels, 'settlement_reminder', 'COMMISSION EN RETARD',
      format('%s à régler à %s — réglez-les pour continuer à recevoir des courses', private.fmt_eur(v.total), v.org_name),
      jsonb_build_object('type', 'settlement_reminder', 'amount_cents', v.total, 'count', v.n),
      array[v.first_name, private.fmt_eur(v.total), v.org_name, format('%s %s', v.n, private.pl(v.n, 'course', 'courses'))]);
    update public.ride_settlements
       set reminders_sent = reminders_sent + 1, last_reminded_at = now()
     where id = any (v.ids);
    v_count := v_count + 1;
    if v_res -> 'channels' ? 'whatsapp' then
      v_wa := v_wa + 1;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'reminders', v_count, 'whatsapp', v_wa);
end;
$$;

-- ----------------------------------------------------------------- Rydar → propriétaire de la centrale
-- Destinataire : téléphone du propriétaire (profil) sinon celui de la centrale.
create or replace function private.platform_whatsapp_target(p_org uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with o as (select x.id, x.name, x.phone, x.country from public.organizations x where x.id = p_org),
  owner as (
    select u.id, u.full_name, u.phone
    from public.organization_users ou
    join public.users u on u.id = ou.user_id
    where ou.organization_id = p_org and ou.role = 'owner' and ou.status = 'active'
    order by (private.wa_phone(u.phone, (select country from o)) is null), ou.created_at
    limit 1
  )
  select case
    when private.wa_phone((select phone from owner), (select country from o)) is not null then jsonb_build_object(
      'to', private.wa_phone((select phone from owner), (select country from o)),
      'source', 'owner', 'user_id', (select id from owner), 'name', (select full_name from owner))
    when private.wa_phone((select phone from o), (select country from o)) is not null then jsonb_build_object(
      'to', private.wa_phone((select phone from o), (select country from o)),
      'source', 'organization', 'user_id', (select id from owner), 'name', (select name from o))
    else jsonb_build_object('to', null, 'source', null, 'user_id', (select id from owner), 'name', null) end;
$$;

-- Super admin : WhatsApp possible pour cette centrale ? (case « Envoyer aussi par WhatsApp »)
create or replace function public.admin_platform_whatsapp(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_target jsonb;
begin
  if not private.is_super_admin() then
    raise exception 'FORBIDDEN: réservé au super admin' using errcode = '42501';
  end if;
  v_target := private.platform_whatsapp_target(p_org);
  return jsonb_build_object(
    'ready', private.whatsapp_ready('platform', null),
    'to_display', private.wa_mask(v_target ->> 'to'),
    'source', v_target -> 'source',
    'name', v_target -> 'name',
    'reason', case
      when not private.whatsapp_ready('platform', null) then 'NOT_CONFIGURED'
      when v_target ->> 'to' is null then 'NO_PHONE' end);
end;
$$;

-- Dernière définition : 20260924003000. p_whatsapp : aussi par WhatsApp au propriétaire (refusé d'emblée si
-- impossible : la limite d'une relance par heure ne doit pas être consommée pour rien).
drop function if exists public.svc_platform_remind(uuid, uuid, text);
create function public.svc_platform_remind(p_org uuid, p_actor uuid, p_note text default null, p_whatsapp boolean default false)
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
begin
  perform private.assert_platform_actor(p_actor);
  select * into o from public.organizations where id = p_org for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Organisation introuvable.');
  end if;
  if o.platform_reminded_at > now() - interval '1 hour' then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED', 'message', 'Relance déjà envoyée il y a moins d''une heure.');
  end if;
  v_account := private.platform_account(p_org);
  if (v_account ->> 'balance_cents')::bigint <= 0 then
    return jsonb_build_object('ok', false, 'code', 'NOTHING_DUE', 'message', 'Rien à régler pour cette centrale.');
  end if;
  if coalesce(p_whatsapp, false) then
    if not private.whatsapp_ready('platform', null) then
      return jsonb_build_object('ok', false, 'code', 'WHATSAPP_NOT_CONFIGURED',
        'message', 'WhatsApp de Rydar non configuré : renseignez le numéro dans Frais plateforme › WhatsApp.');
    end if;
    v_target := private.platform_whatsapp_target(p_org);
    if v_target ->> 'to' is null then
      return jsonb_build_object('ok', false, 'code', 'NO_PHONE',
        'message', 'Aucun numéro valide pour le propriétaire ni pour la centrale.');
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
      then format('Relance affichée à la centrale et envoyée par WhatsApp (%s).', private.wa_mask(v_target ->> 'to'))
      else 'Relance affichée à la centrale.' end);
end;
$$;

-- ----------------------------------------------------------------- configuration (web, service role)
-- p_org null = numéro de Rydar (super admin). Jeton null = jeton déjà enregistré conservé.
create or replace function public.svc_whatsapp_save(
  p_org uuid,
  p_actor uuid,
  p_phone_number_id text,
  p_token text,
  p_display_phone text,
  p_verified_name text,
  p_template text,
  p_language text,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text := nullif(btrim(coalesce(p_token, '')), '');
  v_has_token boolean;
begin
  if p_org is null then
    perform private.assert_platform_actor(p_actor);
    select exists (select 1 from public.platform_whatsapp_secrets) into v_has_token;
  else
    if p_actor is null or not (
      exists (select 1 from public.users u where u.id = p_actor and u.is_super_admin)
      or exists (select 1 from public.organization_users ou
                 where ou.organization_id = p_org and ou.user_id = p_actor and ou.status = 'active' and ou.role in ('owner', 'admin'))
    ) then
      raise exception 'FORBIDDEN: réservé aux administrateurs de la centrale' using errcode = '42501';
    end if;
    select exists (select 1 from public.org_whatsapp_secrets s where s.organization_id = p_org) into v_has_token;
  end if;
  if v_token is null and not v_has_token then
    return jsonb_build_object('ok', false, 'code', 'TOKEN_REQUIRED', 'message', 'Jeton d''accès : requis.');
  end if;
  if coalesce(p_phone_number_id, '') !~ '^[0-9]{5,30}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PHONE_NUMBER_ID', 'message', 'Identifiant du numéro : chiffres uniquement.');
  end if;

  if p_org is null then
    insert into public.platform_whatsapp (id, phone_number_id, display_phone, verified_name, template, language, enabled, updated_at, updated_by)
    values (true, p_phone_number_id, left(p_display_phone, 40), left(p_verified_name, 200),
      coalesce(nullif(p_template, ''), 'rappel_frais_plateforme'), coalesce(nullif(p_language, ''), 'fr'), coalesce(p_enabled, true), now(), p_actor)
    on conflict (id) do update set
      phone_number_id = excluded.phone_number_id, display_phone = excluded.display_phone, verified_name = excluded.verified_name,
      template = excluded.template, language = excluded.language, enabled = excluded.enabled,
      updated_at = now(), updated_by = excluded.updated_by;
    if v_token is not null then
      insert into public.platform_whatsapp_secrets (id, access_token, updated_at) values (true, v_token, now())
      on conflict (id) do update set access_token = excluded.access_token, updated_at = now();
    end if;
  else
    insert into public.org_whatsapp (organization_id, phone_number_id, display_phone, verified_name, template, language, enabled, updated_at, updated_by)
    values (p_org, p_phone_number_id, left(p_display_phone, 40), left(p_verified_name, 200),
      coalesce(nullif(p_template, ''), 'rappel_commission'), coalesce(nullif(p_language, ''), 'fr'), coalesce(p_enabled, true), now(), p_actor)
    on conflict (organization_id) do update set
      phone_number_id = excluded.phone_number_id, display_phone = excluded.display_phone, verified_name = excluded.verified_name,
      template = excluded.template, language = excluded.language, enabled = excluded.enabled,
      updated_at = now(), updated_by = excluded.updated_by;
    if v_token is not null then
      insert into public.org_whatsapp_secrets (organization_id, access_token, updated_at) values (p_org, v_token, now())
      on conflict (organization_id) do update set access_token = excluded.access_token, updated_at = now();
    end if;
  end if;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, (case when p_org is null then 'super_admin' else 'user' end)::public.actor_type, p_actor, 'whatsapp.configured',
    case when p_org is null then 'platform_whatsapp' else 'org_whatsapp' end, coalesce(p_org::text, 'platform'), 'info',
    jsonb_build_object('phone_number_id', p_phone_number_id, 'display_phone', p_display_phone, 'template', p_template,
      'language', p_language, 'enabled', p_enabled, 'token_changed', v_token is not null));
  return jsonb_build_object('ok', true, 'code', 'SAVED', 'message', 'WhatsApp enregistré.');
end;
$$;

create or replace function public.svc_whatsapp_remove(p_org uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_org is null then
    perform private.assert_platform_actor(p_actor);
    delete from public.platform_whatsapp_secrets;
    delete from public.platform_whatsapp;
  else
    if p_actor is null or not (
      exists (select 1 from public.users u where u.id = p_actor and u.is_super_admin)
      or exists (select 1 from public.organization_users ou
                 where ou.organization_id = p_org and ou.user_id = p_actor and ou.status = 'active' and ou.role in ('owner', 'admin'))
    ) then
      raise exception 'FORBIDDEN: réservé aux administrateurs de la centrale' using errcode = '42501';
    end if;
    delete from public.org_whatsapp_secrets where organization_id = p_org;
    delete from public.org_whatsapp where organization_id = p_org;
    -- Plus de WhatsApp : les relances repassent par l'application
    update public.organization_settings set reminder_channels = '{app}' where organization_id = p_org;
  end if;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, (case when p_org is null then 'super_admin' else 'user' end)::public.actor_type, p_actor, 'whatsapp.removed',
    case when p_org is null then 'platform_whatsapp' else 'org_whatsapp' end, coalesce(p_org::text, 'platform'), 'warning', '{}'::jsonb);
  return jsonb_build_object('ok', true, 'code', 'REMOVED', 'message', 'WhatsApp déconnecté.');
end;
$$;

-- Résultat d'un envoi (worker ou message test du web) : dernier envoi réussi / dernière erreur de l'expéditeur
create or replace function public.svc_whatsapp_record(p_org uuid, p_ok boolean, p_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_org is null then
    update public.platform_whatsapp
       set sent_count = sent_count + case when p_ok then 1 else 0 end,
           last_sent_at = case when p_ok then now() else last_sent_at end,
           last_error = case when p_ok then last_error else left(p_error, 500) end,
           last_error_at = case when p_ok then last_error_at else now() end;
  else
    update public.org_whatsapp
       set sent_count = sent_count + case when p_ok then 1 else 0 end,
           last_sent_at = case when p_ok then now() else last_sent_at end,
           last_error = case when p_ok then last_error else left(p_error, 500) end,
           last_error_at = case when p_ok then last_error_at else now() end
     where organization_id = p_org;
  end if;
end;
$$;

-- ----------------------------------------------------------------- worker
-- Réserve un lot de messages WhatsApp (SKIP LOCKED) avec les identifiants de l'expéditeur. Expéditeur
-- déconnecté ou désactivé depuis la mise en file : jeton null → le worker termine en échec (et repli push).
create or replace function private.claim_whatsapp(p_limit integer default 20)
returns table (
  id uuid,
  organization_id uuid,
  driver_id uuid,
  type text,
  data jsonb,
  attempts smallint,
  sender text,
  phone_number_id text,
  access_token text,
  template text,
  language text
)
language sql
security definer
set search_path = ''
as $$
  with due as (
    select n.id
    from public.notifications n
    where n.status = 'queued'
      and n.channel = 'whatsapp'
      and n.scheduled_for <= now()
    order by n.scheduled_for
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update public.notifications n
       set status = 'sending', attempts = n.attempts + 1, claimed_at = now()
      from due
     where n.id = due.id
    returning n.*
  )
  select c.id, c.organization_id, c.driver_id, c.type, c.data, c.attempts, c.data ->> 'sender',
         case when c.data ->> 'sender' = 'platform' then pw.phone_number_id else ow.phone_number_id end,
         case when c.data ->> 'sender' = 'platform' then ps.access_token else os.access_token end,
         case when c.data ->> 'sender' = 'platform' then pw.template else ow.template end,
         case when c.data ->> 'sender' = 'platform' then pw.language else ow.language end
  from claimed c
  left join public.org_whatsapp ow on ow.organization_id = c.organization_id and ow.enabled and c.data ->> 'sender' = 'org'
  left join public.org_whatsapp_secrets os on os.organization_id = ow.organization_id
  left join public.platform_whatsapp pw on pw.enabled and c.data ->> 'sender' = 'platform'
  left join public.platform_whatsapp_secrets ps on ps.id = pw.id;
$$;

-- Fin d'envoi : statut de la notification (reprises de complete_notification), état de l'expéditeur, et repli
-- par l'application quand WhatsApp a définitivement échoué et que le chauffeur n'a pas encore été prévenu.
create or replace function private.complete_whatsapp(
  p_id uuid,
  p_ok boolean,
  p_error text default null,
  p_message_id text default null,
  p_retryable boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  n public.notifications;
  v_fallback jsonb;
begin
  perform private.complete_notification(p_id, p_ok, p_error, 'whatsapp', p_message_id, p_retryable);
  select * into n from public.notifications where id = p_id;
  if not found or n.status = 'queued' then
    return jsonb_build_object('status', coalesce(n.status::text, 'missing'));
  end if;
  perform public.svc_whatsapp_record(case when n.data ->> 'sender' = 'platform' then null else n.organization_id end,
    n.status = 'sent', p_error);

  v_fallback := n.data -> 'fallback';
  if n.status = 'failed' and n.driver_id is not null and jsonb_typeof(v_fallback) = 'object' then
    perform private.queue_notification(n.organization_id, n.driver_id, null, null,
      coalesce(v_fallback ->> 'type', n.type), coalesce(v_fallback ->> 'title', n.title), coalesce(v_fallback ->> 'body', n.body),
      coalesce(v_fallback -> 'data', '{}'::jsonb), 'high', null);
    perform private.log_event(n.organization_id, null, 'whatsapp.failed',
      format('WhatsApp non remis (%s) : relance envoyée par l''application', left(coalesce(p_error, 'erreur'), 120)),
      'system', 'warning', jsonb_build_object('driver_id', n.driver_id, 'notification_id', n.id), 'system', null);
    return jsonb_build_object('status', 'failed', 'fallback', true);
  end if;
  return jsonb_build_object('status', n.status);
end;
$$;

-- ----------------------------------------------------------------- droits (deny-by-default, cf. 20260924000900)
revoke execute on function
  private.wa_phone(text, text),
  private.wa_mask(text),
  private.whatsapp_ready(text, uuid),
  private.queue_whatsapp(uuid, uuid, uuid, text, text, text, text, text, text[], jsonb),
  private.remind_driver(uuid, uuid, text[], text, text, text, jsonb, text[]),
  private.channels_label(jsonb),
  private.platform_whatsapp_target(uuid),
  private.claim_whatsapp(integer),
  private.complete_whatsapp(uuid, boolean, text, text, boolean),
  public.svc_platform_remind(uuid, uuid, text, boolean),
  public.svc_whatsapp_save(uuid, uuid, text, text, text, text, text, text, boolean),
  public.svc_whatsapp_remove(uuid, uuid),
  public.svc_whatsapp_record(uuid, boolean, text),
  public.admin_platform_whatsapp(uuid),
  public.remind_driver_settlements(uuid, text[])
from public, anon, authenticated;

grant execute on function
  private.wa_phone(text, text),
  private.wa_mask(text),
  private.whatsapp_ready(text, uuid),
  private.queue_whatsapp(uuid, uuid, uuid, text, text, text, text, text, text[], jsonb),
  private.remind_driver(uuid, uuid, text[], text, text, text, jsonb, text[]),
  private.channels_label(jsonb),
  private.platform_whatsapp_target(uuid),
  private.claim_whatsapp(integer),
  private.complete_whatsapp(uuid, boolean, text, text, boolean),
  public.svc_platform_remind(uuid, uuid, text, boolean),
  public.svc_whatsapp_save(uuid, uuid, text, text, text, text, text, text, boolean),
  public.svc_whatsapp_remove(uuid, uuid),
  public.svc_whatsapp_record(uuid, boolean, text)
to service_role;
grant execute on function public.admin_platform_whatsapp(uuid), public.remind_driver_settlements(uuid, text[]) to authenticated, service_role;
