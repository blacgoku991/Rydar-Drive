-- =============================================================================
-- Rydar Drive — Fondations : extensions, schémas, types énumérés, utilitaires
-- =============================================================================
-- Conventions :
--   * public   : tables métier + RPC exposées (PostgREST)
--   * private  : helpers internes (RLS, dispatch) — jamais exposé à l'API
--   * extensions : postgis / pgcrypto (convention Supabase)
-- Toute table métier porte organization_id (tenant). Voir 0300 pour la RLS.

create schema if not exists extensions;
create schema if not exists private;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists postgis with schema extensions;

revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Types énumérés
-- -----------------------------------------------------------------------------
create type public.org_status as enum ('active', 'suspended', 'archived');
create type public.org_role as enum ('owner', 'admin', 'dispatcher');
create type public.member_status as enum ('active', 'invited', 'disabled');
create type public.driver_status as enum ('invited', 'active', 'inactive', 'suspended');
create type public.driver_presence as enum ('offline', 'available', 'offered', 'en_route', 'arrived', 'on_trip');
create type public.vehicle_category as enum ('standard', 'business', 'first', 'van', 'green');
create type public.ride_type as enum ('instant', 'scheduled');
create type public.ride_status as enum (
  'CREATED', 'SEARCHING_DRIVER', 'OFFERED', 'ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED',
  'PASSENGER_ONBOARD', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_DRIVER_FOUND'
);
create type public.ride_source as enum ('dashboard', 'api', 'booking_site');
create type public.payment_method as enum ('cash', 'card', 'online', 'invoice', 'account');
create type public.offer_status as enum ('pending', 'accepted', 'declined', 'expired', 'closed');
create type public.dispatch_mode as enum ('geo', 'fleet');
create type public.notification_channel as enum ('push', 'email', 'sms', 'in_app');
create type public.notification_status as enum ('queued', 'sending', 'sent', 'failed', 'cancelled');
create type public.push_provider as enum ('expo', 'fcm', 'apns');
create type public.device_platform as enum ('ios', 'android', 'web');
create type public.subscription_status as enum ('trialing', 'active', 'past_due', 'canceled', 'incomplete', 'unpaid', 'paused');
create type public.event_level as enum ('debug', 'info', 'success', 'warning', 'error');
create type public.event_category as enum ('timeline', 'dispatch', 'system');
create type public.actor_type as enum ('system', 'user', 'driver', 'api', 'booking_site', 'super_admin');
create type public.document_type as enum ('driving_license', 'vtc_card', 'insurance', 'vehicle_registration', 'identity', 'medical', 'other');
create type public.document_status as enum ('pending', 'valid', 'expired', 'rejected');

-- -----------------------------------------------------------------------------
-- Utilitaires génériques
-- -----------------------------------------------------------------------------
create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- organization_id est immuable : toute tentative de « déplacer » une donnée
-- vers un autre tenant est refusée (SQLSTATE 42501 → HTTP 403 via PostgREST).
create or replace function private.forbid_org_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'FORBIDDEN_TENANT_CHANGE: organization_id est immuable'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Acteur courant (renseigné par les fonctions via set_config local) pour
-- l'historique des statuts et les journaux.
create or replace function private.set_actor(p_type public.actor_type, p_id uuid)
returns void
language sql
set search_path = ''
as $$
  select set_config('rydar.actor_type', p_type::text, true),
         set_config('rydar.actor_id', coalesce(p_id::text, ''), true);
$$;

create or replace function private.actor_type()
returns public.actor_type
language sql
stable
set search_path = ''
as $$
  select coalesce(
    nullif(current_setting('rydar.actor_type', true), '')::public.actor_type,
    case when auth.uid() is not null then 'user'::public.actor_type else 'system'::public.actor_type end
  );
$$;

create or replace function private.actor_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('rydar.actor_id', true), '')::uuid, auth.uid());
$$;

-- Formatage FR utilisé dans les notifications / journaux
create or replace function private.fmt_eur(p_cents integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_cents is null then 'Prix à définir'
    when p_cents % 100 = 0 then (p_cents / 100)::text || ' €'
    else replace(to_char(p_cents / 100.0, 'FM999999990.00'), '.', ',') || ' €'
  end;
$$;

create or replace function private.fmt_km(p_meters integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_meters is null then '—'
    when p_meters < 1000 then p_meters::text || ' m'
    when p_meters % 1000 = 0 then (p_meters / 1000)::text || ' km'
    else replace(to_char(p_meters / 1000.0, 'FM9999990.0'), '.', ',') || ' km'
  end;
$$;

-- Adresse courte : « 12 Avenue des Champs-Élysées, 75008 Paris » → « 12 Avenue des Champs-Élysées »
create or replace function private.short_address(p_address text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(trim(split_part(coalesce(p_address, ''), ',', 1)), '');
$$;
