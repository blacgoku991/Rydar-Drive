-- =============================================================================
-- Rydar Drive — Sécurité : helpers RLS, synchronisation auth, politiques, GRANTs
-- Principe : deny-by-default. Chaque table a la RLS activée ; les écritures
-- sensibles passent par des fonctions contrôlées (0400) ou par le serveur
-- (service_role) qui applique ses propres contrôles + audit.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helpers (SECURITY DEFINER, search_path figé, non exposés via PostgREST)
-- -----------------------------------------------------------------------------
create or replace function private.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select u.is_super_admin from public.users u where u.id = auth.uid()), false);
$$;

-- Organisations ACTIVES dont l'utilisateur est membre actif (accès aux données)
create or replace function private.member_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select ou.organization_id
  from public.organization_users ou
  join public.organizations o on o.id = ou.organization_id
  where ou.user_id = auth.uid()
    and ou.status = 'active'
    and o.status = 'active';
$$;

-- Organisations où l'utilisateur a un rôle d'administration (owner/admin)
create or replace function private.admin_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select ou.organization_id
  from public.organization_users ou
  join public.organizations o on o.id = ou.organization_id
  where ou.user_id = auth.uid()
    and ou.status = 'active'
    and ou.role in ('owner', 'admin')
    and o.status = 'active';
$$;

-- Toutes les appartenances (y compris org suspendue) : permet d'afficher
-- l'écran « compte suspendu » sans exposer les données métier.
create or replace function private.membership_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select ou.organization_id
  from public.organization_users ou
  join public.organizations o on o.id = ou.organization_id
  where ou.user_id = auth.uid()
    and ou.status = 'active'
    and o.status <> 'archived';
$$;

create or replace function private.is_org_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.member_org_ids() m where m = p_org);
$$;

create or replace function private.has_org_role(p_org uuid, p_roles public.org_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_users ou
    join public.organizations o on o.id = ou.organization_id
    where ou.organization_id = p_org
      and ou.user_id = auth.uid()
      and ou.status = 'active'
      and ou.role = any (p_roles)
      and o.status = 'active'
  );
$$;

-- Chauffeur connecté (compte actif, organisation active) ; null sinon.
create or replace function private.current_driver_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.id
  from public.drivers d
  join public.organizations o on o.id = d.organization_id
  where d.user_id = auth.uid()
    and d.status = 'active'
    and o.status = 'active'
  limit 1;
$$;

create or replace function private.current_driver_org_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.organization_id
  from public.drivers d
  join public.organizations o on o.id = d.organization_id
  where d.user_id = auth.uid()
    and d.status = 'active'
    and o.status = 'active'
  limit 1;
$$;

-- Garde explicite utilisée par les RPC : lève 42501 (→ 403) si non membre.
create or replace function private.assert_org_member(p_org uuid, p_roles public.org_role[] default null)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_org is null then
    raise exception 'FORBIDDEN: organisation manquante' using errcode = '42501';
  end if;
  if p_roles is null then
    if not private.is_org_member(p_org) then
      raise exception 'FORBIDDEN_TENANT: accès refusé à cette organisation' using errcode = '42501';
    end if;
  elsif not private.has_org_role(p_org, p_roles) then
    raise exception 'FORBIDDEN_ROLE: rôle insuffisant' using errcode = '42501';
  end if;
end;
$$;

-- Révocation de sessions (suspension chauffeur / rattacheur) — Supabase Auth
create or replace function private.revoke_user_sessions(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if to_regclass('auth.sessions') is not null then
    execute 'delete from auth.sessions where user_id = $1' using p_user_id;
  end if;
  if to_regclass('auth.refresh_tokens') is not null then
    execute 'delete from auth.refresh_tokens where user_id = $1::text' using p_user_id;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Synchronisation auth.users → public.users
-- -----------------------------------------------------------------------------
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, email, full_name, phone)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'), ''),
    nullif(new.raw_user_meta_data ->> 'phone', '')
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

create or replace function private.handle_auth_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is distinct from old.email then
    update public.users set email = coalesce(new.email, '') where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists rydar_on_auth_user_created on auth.users;
create trigger rydar_on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

drop trigger if exists rydar_on_auth_user_updated on auth.users;
create trigger rydar_on_auth_user_updated
  after update of email on auth.users
  for each row execute function private.handle_auth_user_email_change();

-- Création automatique des réglages / mini-site à la création d'une organisation
create or replace function private.handle_new_organization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.organization_settings (organization_id) values (new.id) on conflict do nothing;
  insert into public.booking_sites (organization_id, subdomain, title, phone, email)
  values (new.id, new.slug, new.name, new.phone, new.email)
  on conflict do nothing;
  return new;
end;
$$;

create trigger organizations_after_insert
  after insert on public.organizations
  for each row execute function private.handle_new_organization();

-- Numérotation chauffeur par organisation (« Chauffeur #82 »)
create or replace function private.assign_driver_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.number is null or new.number = 0 then
    update public.organizations
       set driver_counter = driver_counter + 1
     where id = new.organization_id
     returning driver_counter into new.number;
  end if;
  return new;
end;
$$;

create trigger drivers_assign_number
  before insert on public.drivers
  for each row execute function private.assign_driver_number();

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
alter table public.plans enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_settings enable row level security;
alter table public.booking_sites enable row level security;
alter table public.users enable row level security;
alter table public.organization_users enable row level security;
alter table public.vehicles enable row level security;
alter table public.drivers enable row level security;
alter table public.driver_documents enable row level security;
alter table public.driver_devices enable row level security;
alter table public.push_tokens enable row level security;
alter table public.driver_locations enable row level security;
alter table public.driver_location_history enable row level security;
alter table public.pricing_rules enable row level security;
alter table public.api_keys enable row level security;
alter table public.api_key_secrets enable row level security;
alter table public.api_logs enable row level security;
alter table public.rides enable row level security;
alter table public.ride_offers enable row level security;
alter table public.ride_assignments enable row level security;
alter table public.ride_events enable row level security;
alter table public.ride_status_history enable row level security;
alter table public.notifications enable row level security;
alter table public.subscriptions enable row level security;
alter table public.invoices enable row level security;
alter table public.audit_logs enable row level security;

-- Plans : catalogue public (offres actives), tout pour le super admin en lecture
create policy plans_select_public on public.plans for select to anon
  using (is_active and is_public);
create policy plans_select on public.plans for select to authenticated
  using ((is_active and is_public) or (select private.is_super_admin()));

-- Organisations
create policy organizations_select on public.organizations for select to authenticated
  using (
    id in (select private.membership_org_ids())
    or id = (select private.current_driver_org_id())
    or (select private.is_super_admin())
  );
create policy organizations_update on public.organizations for update to authenticated
  using (id in (select private.admin_org_ids()))
  with check (id in (select private.admin_org_ids()));

-- Réglages & mini-site
create policy organization_settings_select on public.organization_settings for select to authenticated
  using (organization_id in (select private.member_org_ids()) or (select private.is_super_admin()));
create policy organization_settings_update on public.organization_settings for update to authenticated
  using (organization_id in (select private.admin_org_ids()))
  with check (organization_id in (select private.admin_org_ids()));

create policy booking_sites_select on public.booking_sites for select to authenticated
  using (organization_id in (select private.member_org_ids()) or (select private.is_super_admin()));
create policy booking_sites_update on public.booking_sites for update to authenticated
  using (organization_id in (select private.admin_org_ids()))
  with check (organization_id in (select private.admin_org_ids()));

-- Utilisateurs
create policy users_select on public.users for select to authenticated
  using (
    id = auth.uid()
    or id in (
      select ou.user_id from public.organization_users ou
      where ou.organization_id in (select private.member_org_ids())
    )
    or (select private.is_super_admin())
  );
create policy users_update_self on public.users for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Membres d'organisation (écritures : serveur uniquement)
create policy organization_users_select on public.organization_users for select to authenticated
  using (
    user_id = auth.uid()
    or organization_id in (select private.member_org_ids())
    or (select private.is_super_admin())
  );

-- Véhicules
create policy vehicles_select on public.vehicles for select to authenticated
  using (
    organization_id in (select private.member_org_ids())
    or id = (select d.vehicle_id from public.drivers d where d.id = (select private.current_driver_id()))
    or (select private.is_super_admin())
  );
create policy vehicles_insert on public.vehicles for insert to authenticated
  with check (organization_id in (select private.member_org_ids()));
create policy vehicles_update on public.vehicles for update to authenticated
  using (organization_id in (select private.member_org_ids()))
  with check (organization_id in (select private.member_org_ids()));
create policy vehicles_delete on public.vehicles for delete to authenticated
  using (organization_id in (select private.admin_org_ids()));

-- Chauffeurs (création via serveur : compte auth + invitation)
create policy drivers_select on public.drivers for select to authenticated
  using (
    organization_id in (select private.member_org_ids())
    or user_id = auth.uid()
    or (select private.is_super_admin())
  );
create policy drivers_update on public.drivers for update to authenticated
  using (organization_id in (select private.member_org_ids()))
  with check (organization_id in (select private.member_org_ids()));
create policy drivers_delete on public.drivers for delete to authenticated
  using (organization_id in (select private.admin_org_ids()));

-- Documents chauffeur
create policy driver_documents_select on public.driver_documents for select to authenticated
  using (
    organization_id in (select private.member_org_ids())
    or driver_id = (select private.current_driver_id())
  );
create policy driver_documents_write on public.driver_documents for all to authenticated
  using (organization_id in (select private.member_org_ids()))
  with check (organization_id in (select private.member_org_ids()));

-- Appareils / tokens push (écriture via RPC chauffeur)
create policy driver_devices_select on public.driver_devices for select to authenticated
  using (
    organization_id in (select private.member_org_ids())
    or driver_id = (select private.current_driver_id())
  );
create policy push_tokens_select on public.push_tokens for select to authenticated
  using (
    organization_id in (select private.member_org_ids())
    or driver_id = (select private.current_driver_id())
  );

-- Positions (écriture via RPC update_driver_location)
create policy driver_locations_select on public.driver_locations for select to authenticated
  using (
    organization_id in (select private.member_org_ids())
    or driver_id = (select private.current_driver_id())
    or (select private.is_super_admin())
  );
create policy driver_location_history_select on public.driver_location_history for select to authenticated
  using (
    organization_id in (select private.member_org_ids())
    or driver_id = (select private.current_driver_id())
  );

-- Tarifs
create policy pricing_rules_select on public.pricing_rules for select to authenticated
  using (organization_id in (select private.member_org_ids()));
create policy pricing_rules_write on public.pricing_rules for all to authenticated
  using (organization_id in (select private.admin_org_ids()))
  with check (organization_id in (select private.admin_org_ids()));

-- API (création / révocation via serveur, hash jamais lisible côté client)
create policy api_keys_select on public.api_keys for select to authenticated
  using (organization_id in (select private.admin_org_ids()) or (select private.is_super_admin()));
create policy api_logs_select on public.api_logs for select to authenticated
  using (organization_id in (select private.admin_org_ids()) or (select private.is_super_admin()));

-- Courses
create policy rides_select on public.rides for select to authenticated
  using (
    organization_id in (select private.member_org_ids())
    or (driver_id is not null and driver_id = (select private.current_driver_id()))
    or (select private.is_super_admin())
  );
create policy rides_insert on public.rides for insert to authenticated
  with check (organization_id in (select private.member_org_ids()));
create policy rides_update on public.rides for update to authenticated
  using (organization_id in (select private.member_org_ids()))
  with check (organization_id in (select private.member_org_ids()));

create policy ride_offers_select on public.ride_offers for select to authenticated
  using (
    organization_id in (select private.member_org_ids())
    or driver_id = (select private.current_driver_id())
    or (select private.is_super_admin())
  );
create policy ride_assignments_select on public.ride_assignments for select to authenticated
  using (
    organization_id in (select private.member_org_ids())
    or driver_id = (select private.current_driver_id())
    or (select private.is_super_admin())
  );
create policy ride_events_select on public.ride_events for select to authenticated
  using (organization_id in (select private.member_org_ids()) or (select private.is_super_admin()));
create policy ride_status_history_select on public.ride_status_history for select to authenticated
  using (organization_id in (select private.member_org_ids()) or (select private.is_super_admin()));

create policy notifications_select on public.notifications for select to authenticated
  using (
    organization_id in (select private.member_org_ids())
    or driver_id = (select private.current_driver_id())
    or (select private.is_super_admin())
  );

-- Facturation
create policy subscriptions_select on public.subscriptions for select to authenticated
  using (organization_id in (select private.admin_org_ids()) or (select private.is_super_admin()));
create policy invoices_select on public.invoices for select to authenticated
  using (organization_id in (select private.admin_org_ids()) or (select private.is_super_admin()));

-- Audit
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (organization_id in (select private.admin_org_ids()) or (select private.is_super_admin()));

-- -----------------------------------------------------------------------------
-- GRANTs : défense en profondeur (en plus de la RLS)
-- Supabase accorde ALL par défaut à anon/authenticated : on restreint.
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;
grant select on public.plans to anon;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Colonnes modifiables par le client (le reste passe par RPC / serveur)
grant update (name, legal_name, siret, vat_number, email, phone, address, city, postal_code, country, timezone, logo_url, brand_color)
  on public.organizations to authenticated;

grant update (auto_dispatch, dispatch_radii_m, offer_timeout_seconds, max_search_seconds, max_offers_per_wave,
  instant_threshold_minutes, scheduled_dispatch_lead_minutes, reminder_offsets_minutes, allow_category_upgrade,
  location_max_age_seconds, default_payment_method)
  on public.organization_settings to authenticated;

grant update (enabled, subdomain, custom_domain, title, tagline, description, logo_url, hero_image_url, gallery,
  primary_color, phone, email, whatsapp, service_area, vehicle_categories, show_price_estimate, legal_mentions)
  on public.booking_sites to authenticated;

grant update (full_name, phone, avatar_url, last_active_org_id) on public.users to authenticated;

grant insert (organization_id, brand, model, color, plate, category, seats, luggage_capacity, year, is_active),
  update (brand, model, color, plate, category, seats, luggage_capacity, year, is_active),
  delete on public.vehicles to authenticated;

grant update (first_name, last_name, phone, email, photo_url, status, vehicle_id, vtc_card_number, notes, suspended_reason),
  delete on public.drivers to authenticated;

grant insert (organization_id, driver_id, type, label, file_path, number, issued_at, expires_at, status),
  update (type, label, file_path, number, issued_at, expires_at, status),
  delete on public.driver_documents to authenticated;

grant insert (organization_id, name, vehicle_category, base_fare_cents, per_km_cents, per_minute_cents, minimum_fare_cents,
  night_surcharge_percent, night_start, night_end, fixed_fares, is_active),
  update (name, vehicle_category, base_fare_cents, per_km_cents, per_minute_cents, minimum_fare_cents,
  night_surcharge_percent, night_start, night_end, fixed_fares, is_active),
  delete on public.pricing_rules to authenticated;

grant insert (organization_id, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, pickup_at,
  customer_name, customer_phone, customer_email, passengers, luggage, vehicle_category, price_cents, currency,
  payment_method, comment, flight_number, external_reference, estimated_distance_m, estimated_duration_s, idempotency_key)
  on public.rides to authenticated;
grant update (pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng,
  customer_name, customer_phone, customer_email, passengers, luggage, price_cents, payment_method, comment,
  flight_number, external_reference, estimated_distance_m, estimated_duration_s)
  on public.rides to authenticated;

-- Secrets des clés API : aucun accès client
revoke all on public.api_key_secrets from authenticated, anon;
