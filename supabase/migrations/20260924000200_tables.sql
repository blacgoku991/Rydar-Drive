-- =============================================================================
-- Rydar Drive — Tables
-- Intégrité multi-tenant : clés étrangères COMPOSITES (organization_id, id)
-- => impossible, au niveau base, de lier une course du tenant A à un
-- chauffeur / véhicule / offre du tenant B.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Offres SaaS
-- -----------------------------------------------------------------------------
create table public.plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9_]+$'),
  name text not null,
  description text,
  price_monthly_cents integer not null default 0 check (price_monthly_cents >= 0),
  price_yearly_cents integer not null default 0 check (price_yearly_cents >= 0),
  currency text not null default 'EUR',
  stripe_product_id text,
  stripe_price_monthly_id text,
  stripe_price_yearly_id text,
  -- { max_drivers, max_rides_per_month, max_admins, api_access, booking_site,
  --   custom_domain, advanced_stats, history_days }  (null = illimité)
  limits jsonb not null default '{}'::jsonb,
  features text[] not null default '{}',
  highlighted boolean not null default false,
  is_public boolean not null default true,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Rattacheurs / centrales (tenants)
-- -----------------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$'),
  status public.org_status not null default 'active',
  plan_id uuid references public.plans (id),
  limits_override jsonb not null default '{}'::jsonb,
  legal_name text,
  siret text,
  vat_number text,
  email text,
  phone text,
  address text,
  city text,
  postal_code text,
  country text not null default 'FR',
  timezone text not null default 'Europe/Paris',
  currency text not null default 'EUR',
  logo_url text,
  brand_color text check (brand_color is null or brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  ride_counter bigint not null default 1000,
  driver_counter integer not null default 0,
  stripe_customer_id text unique,
  suspended_at timestamptz,
  suspended_reason text,
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index organizations_status_idx on public.organizations (status);

create table public.organization_settings (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  auto_dispatch boolean not null default true,
  dispatch_radii_m integer[] not null default '{3000,5000,8000,12000}'
    check (cardinality(dispatch_radii_m) between 1 and 8 and 0 < all (dispatch_radii_m) and 100000 >= all (dispatch_radii_m)),
  offer_timeout_seconds integer not null default 30 check (offer_timeout_seconds between 10 and 600),
  max_search_seconds integer not null default 300 check (max_search_seconds between 30 and 7200),
  max_offers_per_wave integer not null default 25 check (max_offers_per_wave between 1 and 500),
  instant_threshold_minutes integer not null default 45 check (instant_threshold_minutes between 0 and 720),
  scheduled_dispatch_lead_minutes integer not null default 60 check (scheduled_dispatch_lead_minutes between 5 and 1440),
  reminder_offsets_minutes integer[] not null default '{1440,180,60,30}'
    check (cardinality(reminder_offsets_minutes) <= 8 and 0 < all (reminder_offsets_minutes)),
  allow_category_upgrade boolean not null default true,
  location_max_age_seconds integer not null default 180 check (location_max_age_seconds between 30 and 3600),
  default_payment_method public.payment_method not null default 'card',
  updated_at timestamptz not null default now()
);

-- Mini-site de réservation (option)
create table public.booking_sites (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  enabled boolean not null default false,
  subdomain text unique check (subdomain is null or subdomain ~ '^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$'),
  custom_domain text unique check (custom_domain is null or custom_domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  custom_domain_verified_at timestamptz,
  title text,
  tagline text,
  description text,
  logo_url text,
  hero_image_url text,
  gallery jsonb not null default '[]'::jsonb,
  primary_color text not null default '#C8F03C' check (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  phone text,
  email text,
  whatsapp text,
  service_area text,
  vehicle_categories public.vehicle_category[] not null default '{standard,business,van}',
  show_price_estimate boolean not null default true,
  legal_mentions text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Utilisateurs (profil lié à auth.users) et appartenance aux organisations
-- -----------------------------------------------------------------------------
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  phone text,
  avatar_url text,
  is_super_admin boolean not null default false,
  last_active_org_id uuid references public.organizations (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index users_email_idx on public.users (lower(email));

create table public.organization_users (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  role public.org_role not null default 'dispatcher',
  status public.member_status not null default 'active',
  invited_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index organization_users_user_idx on public.organization_users (user_id);

-- -----------------------------------------------------------------------------
-- Flotte : véhicules, chauffeurs, documents, appareils
-- -----------------------------------------------------------------------------
create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  brand text,
  model text not null,
  color text,
  plate text not null,
  category public.vehicle_category not null default 'standard',
  seats smallint not null default 4 check (seats between 1 and 20),
  luggage_capacity smallint not null default 3 check (luggage_capacity between 0 and 30),
  year smallint check (year is null or year between 1990 and 2100),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, plate)
);

create table public.drivers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  number integer not null,
  user_id uuid unique references public.users (id) on delete set null,
  first_name text not null check (char_length(first_name) between 1 and 80),
  last_name text not null check (char_length(last_name) between 1 and 80),
  phone text not null,
  email text,
  photo_url text,
  status public.driver_status not null default 'active',
  presence public.driver_presence not null default 'offline',
  vehicle_id uuid,
  current_ride_id uuid,
  vtc_card_number text,
  notes text,
  online_since timestamptz,
  last_seen_at timestamptz,
  suspended_reason text,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, number),
  foreign key (organization_id, vehicle_id) references public.vehicles (organization_id, id) on delete set null (vehicle_id)
);
create unique index drivers_org_email_uidx on public.drivers (organization_id, lower(email)) where email is not null;
create index drivers_org_presence_idx on public.drivers (organization_id, status, presence);

create table public.driver_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  driver_id uuid not null,
  type public.document_type not null,
  label text,
  file_path text,
  number text,
  issued_at date,
  expires_at date,
  status public.document_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, driver_id) references public.drivers (organization_id, id) on delete cascade
);
create index driver_documents_driver_idx on public.driver_documents (driver_id);

create table public.driver_devices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  driver_id uuid not null,
  installation_id text not null,
  platform public.device_platform not null,
  device_name text,
  os_version text,
  app_version text,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (driver_id, installation_id),
  foreign key (organization_id, driver_id) references public.drivers (organization_id, id) on delete cascade
);

create table public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  driver_id uuid not null,
  device_id uuid references public.driver_devices (id) on delete cascade,
  token text not null unique,
  provider public.push_provider not null default 'expo',
  platform public.device_platform not null,
  is_active boolean not null default true,
  last_error text,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, driver_id) references public.drivers (organization_id, id) on delete cascade
);
create index push_tokens_driver_idx on public.push_tokens (driver_id) where is_active;

-- Dernière position connue (1 ligne / chauffeur, upsert)
create table public.driver_locations (
  driver_id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  location extensions.geography(Point, 4326)
    generated always as (extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography) stored,
  heading real,
  speed_mps real,
  accuracy_m real,
  battery_level real,
  recorded_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, driver_id) references public.drivers (organization_id, id) on delete cascade
);
create index driver_locations_geo_idx on public.driver_locations using gist (location);
create index driver_locations_org_idx on public.driver_locations (organization_id, updated_at desc);

create table public.driver_location_history (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  driver_id uuid not null,
  ride_id uuid,
  lat double precision not null,
  lng double precision not null,
  speed_mps real,
  heading real,
  accuracy_m real,
  recorded_at timestamptz not null default now(),
  foreign key (organization_id, driver_id) references public.drivers (organization_id, id) on delete cascade
);
create index driver_location_history_driver_idx on public.driver_location_history (driver_id, recorded_at desc);
create index driver_location_history_ride_idx on public.driver_location_history (ride_id, recorded_at) where ride_id is not null;

-- -----------------------------------------------------------------------------
-- Tarification (estimation mini-site / suggestion dashboard)
-- -----------------------------------------------------------------------------
create table public.pricing_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  vehicle_category public.vehicle_category not null,
  base_fare_cents integer not null default 0 check (base_fare_cents >= 0),
  per_km_cents integer not null default 0 check (per_km_cents >= 0),
  per_minute_cents integer not null default 0 check (per_minute_cents >= 0),
  minimum_fare_cents integer not null default 0 check (minimum_fare_cents >= 0),
  night_surcharge_percent numeric(5, 2) not null default 0 check (night_surcharge_percent between 0 and 200),
  night_start time not null default '21:00',
  night_end time not null default '06:00',
  fixed_fares jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index pricing_rules_active_category_uidx on public.pricing_rules (organization_id, vehicle_category) where is_active;

-- -----------------------------------------------------------------------------
-- API publique
-- -----------------------------------------------------------------------------
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(name) between 2 and 80),
  prefix text not null unique,
  last4 text not null,
  environment text not null default 'live' check (environment in ('live', 'test')),
  scopes text[] not null default '{rides:create,rides:read}',
  rate_limit_per_minute integer not null default 60 check (rate_limit_per_minute between 1 and 10000),
  allowed_origins text[] not null default '{}',
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  last_used_ip inet,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references public.users (id) on delete set null,
  rotated_from_id uuid references public.api_keys (id) on delete set null,
  unique (organization_id, id)
);
create index api_keys_org_idx on public.api_keys (organization_id);

-- Secret (hash) séparé : table sans aucune politique RLS => service_role uniquement.
create table public.api_key_secrets (
  api_key_id uuid primary key references public.api_keys (id) on delete cascade,
  key_hash text not null unique
);

create table public.api_logs (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations (id) on delete cascade,
  api_key_id uuid references public.api_keys (id) on delete set null,
  request_id text,
  method text not null,
  path text not null,
  status_code integer not null,
  ip inet,
  user_agent text,
  latency_ms integer,
  error_code text,
  ride_id uuid,
  created_at timestamptz not null default now()
);
create index api_logs_org_idx on public.api_logs (organization_id, created_at desc);
create index api_logs_key_idx on public.api_logs (api_key_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Courses
-- -----------------------------------------------------------------------------
create table public.rides (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  number bigint not null,
  type public.ride_type not null,
  status public.ride_status not null default 'CREATED',
  source public.ride_source not null default 'dashboard',
  dispatch_mode public.dispatch_mode,

  pickup_address text not null check (char_length(pickup_address) between 3 and 300),
  pickup_lat double precision not null check (pickup_lat between -90 and 90),
  pickup_lng double precision not null check (pickup_lng between -180 and 180),
  pickup_location extensions.geography(Point, 4326)
    generated always as (extensions.st_setsrid(extensions.st_makepoint(pickup_lng, pickup_lat), 4326)::extensions.geography) stored,
  dropoff_address text not null check (char_length(dropoff_address) between 3 and 300),
  dropoff_lat double precision check (dropoff_lat between -90 and 90),
  dropoff_lng double precision check (dropoff_lng between -180 and 180),
  dropoff_location extensions.geography(Point, 4326)
    generated always as (extensions.st_setsrid(extensions.st_makepoint(dropoff_lng, dropoff_lat), 4326)::extensions.geography) stored,
  pickup_at timestamptz not null default now(),

  customer_name text not null check (char_length(customer_name) between 1 and 120),
  customer_phone text not null check (char_length(customer_phone) between 6 and 30),
  customer_email text,
  passengers smallint not null default 1 check (passengers between 1 and 20),
  luggage smallint not null default 0 check (luggage between 0 and 30),
  vehicle_category public.vehicle_category not null default 'standard',
  price_cents integer check (price_cents is null or price_cents between 0 and 10000000),
  currency text not null default 'EUR',
  payment_method public.payment_method not null default 'card',
  comment text check (comment is null or char_length(comment) <= 2000),
  flight_number text check (flight_number is null or char_length(flight_number) <= 12),
  external_reference text,
  estimated_distance_m integer,
  estimated_duration_s integer,

  driver_id uuid,
  vehicle_id uuid,

  dispatch_wave smallint not null default 0,
  dispatch_radius_m integer,
  dispatch_started_at timestamptz,
  next_dispatch_at timestamptz,

  offered_at timestamptz,
  accepted_at timestamptz,
  driver_en_route_at timestamptz,
  driver_arrived_at timestamptz,
  passenger_onboard_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  no_driver_at timestamptz,
  cancel_reason text,
  cancelled_by_type public.actor_type,

  created_by uuid references public.users (id) on delete set null,
  api_key_id uuid references public.api_keys (id) on delete set null,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (organization_id, id),
  unique (organization_id, number),
  unique (organization_id, idempotency_key),
  foreign key (organization_id, driver_id) references public.drivers (organization_id, id) on delete set null (driver_id),
  foreign key (organization_id, vehicle_id) references public.vehicles (organization_id, id) on delete set null (vehicle_id)
);
create index rides_org_status_idx on public.rides (organization_id, status);
create index rides_org_pickup_idx on public.rides (organization_id, pickup_at desc);
create index rides_org_created_idx on public.rides (organization_id, created_at desc);
create index rides_driver_idx on public.rides (driver_id, status) where driver_id is not null;
create index rides_dispatch_due_idx on public.rides (next_dispatch_at) where status in ('SEARCHING_DRIVER', 'OFFERED');
create index rides_pickup_geo_idx on public.rides using gist (pickup_location);

alter table public.drivers
  add constraint drivers_current_ride_fk foreign key (organization_id, current_ride_id)
  references public.rides (organization_id, id) on delete set null (current_ride_id);

create table public.ride_offers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  ride_id uuid not null,
  driver_id uuid not null,
  status public.offer_status not null default 'pending',
  mode public.dispatch_mode not null default 'geo',
  wave smallint not null default 1,
  radius_m integer,
  distance_m integer,
  sent_at timestamptz not null default now(),
  expires_at timestamptz,
  responded_at timestamptz,
  closed_reason text,
  unique (organization_id, id),
  foreign key (organization_id, ride_id) references public.rides (organization_id, id) on delete cascade,
  foreign key (organization_id, driver_id) references public.drivers (organization_id, id) on delete cascade
);
create unique index ride_offers_one_pending_uidx on public.ride_offers (ride_id, driver_id) where status = 'pending';
create index ride_offers_ride_idx on public.ride_offers (ride_id);
create index ride_offers_driver_idx on public.ride_offers (driver_id, status);
create index ride_offers_expiry_idx on public.ride_offers (expires_at) where status = 'pending';

create table public.ride_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  ride_id uuid not null,
  driver_id uuid not null,
  vehicle_id uuid,
  offer_id uuid references public.ride_offers (id) on delete set null,
  method text not null check (method in ('accepted', 'manual')),
  assigned_by uuid references public.users (id) on delete set null,
  is_active boolean not null default true,
  assigned_at timestamptz not null default now(),
  released_at timestamptz,
  release_reason text,
  foreign key (organization_id, ride_id) references public.rides (organization_id, id) on delete cascade,
  foreign key (organization_id, driver_id) references public.drivers (organization_id, id) on delete cascade
);
-- Garantie ultime : jamais deux affectations actives pour une même course.
create unique index ride_assignments_one_active_uidx on public.ride_assignments (ride_id) where is_active;
create index ride_assignments_driver_idx on public.ride_assignments (driver_id, assigned_at desc);

create table public.ride_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  ride_id uuid,
  category public.event_category not null default 'timeline',
  level public.event_level not null default 'info',
  type text not null,
  message text not null,
  actor_type public.actor_type not null default 'system',
  actor_id uuid,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (organization_id, ride_id) references public.rides (organization_id, id) on delete cascade
);
create index ride_events_org_idx on public.ride_events (organization_id, created_at desc);
create index ride_events_ride_idx on public.ride_events (ride_id, id);
create index ride_events_level_idx on public.ride_events (level, created_at desc) where level in ('warning', 'error');

create table public.ride_status_history (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  ride_id uuid not null,
  from_status public.ride_status,
  to_status public.ride_status not null,
  actor_type public.actor_type not null default 'system',
  actor_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (organization_id, ride_id) references public.rides (organization_id, id) on delete cascade
);
create index ride_status_history_ride_idx on public.ride_status_history (ride_id, id);

-- -----------------------------------------------------------------------------
-- Notifications (outbox transactionnelle, livrée par apps/worker)
-- -----------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  driver_id uuid,
  user_id uuid references public.users (id) on delete cascade,
  ride_id uuid,
  offer_id uuid references public.ride_offers (id) on delete set null,
  channel public.notification_channel not null default 'push',
  type text not null,
  title text not null,
  body text not null,
  data jsonb not null default '{}'::jsonb,
  priority text not null default 'high' check (priority in ('high', 'normal')),
  status public.notification_status not null default 'queued',
  scheduled_for timestamptz not null default now(),
  attempts smallint not null default 0,
  last_error text,
  provider text,
  provider_message_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (organization_id, driver_id) references public.drivers (organization_id, id) on delete cascade,
  foreign key (organization_id, ride_id) references public.rides (organization_id, id) on delete cascade
);
create index notifications_due_idx on public.notifications (scheduled_for) where status = 'queued';
create index notifications_org_idx on public.notifications (organization_id, created_at desc);
create index notifications_ride_idx on public.notifications (ride_id) where ride_id is not null;

-- -----------------------------------------------------------------------------
-- Facturation SaaS (Stripe)
-- -----------------------------------------------------------------------------
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  plan_id uuid references public.plans (id),
  status public.subscription_status not null default 'trialing',
  billing_interval text not null default 'month' check (billing_interval in ('month', 'year')),
  stripe_subscription_id text unique,
  stripe_customer_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index subscriptions_org_idx on public.subscriptions (organization_id, created_at desc);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  subscription_id uuid references public.subscriptions (id) on delete set null,
  stripe_invoice_id text unique,
  number text,
  status text not null default 'draft',
  amount_due_cents integer not null default 0,
  amount_paid_cents integer not null default 0,
  currency text not null default 'EUR',
  hosted_invoice_url text,
  pdf_url text,
  period_start timestamptz,
  period_end timestamptz,
  created_at timestamptz not null default now()
);
create index invoices_org_idx on public.invoices (organization_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Audit
-- -----------------------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations (id) on delete cascade,
  actor_type public.actor_type not null default 'user',
  actor_user_id uuid,
  actor_label text,
  action text not null,
  entity_type text,
  entity_id text,
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  ip inet,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_org_idx on public.audit_logs (organization_id, created_at desc);
create index audit_logs_severity_idx on public.audit_logs (severity, created_at desc) where severity <> 'info';

-- -----------------------------------------------------------------------------
-- Triggers génériques : updated_at + organization_id immuable
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'plans', 'organizations', 'organization_settings', 'booking_sites', 'users', 'organization_users',
    'vehicles', 'drivers', 'driver_documents', 'push_tokens', 'pricing_rules', 'rides', 'subscriptions'
  ] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.touch_updated_at()',
      t || '_touch_updated_at', t);
  end loop;

  foreach t in array array[
    'organization_settings', 'booking_sites', 'organization_users', 'vehicles', 'drivers', 'driver_documents',
    'driver_devices', 'push_tokens', 'driver_locations', 'driver_location_history', 'pricing_rules', 'api_keys',
    'api_logs', 'rides', 'ride_offers', 'ride_assignments', 'ride_events', 'ride_status_history', 'notifications',
    'subscriptions', 'invoices', 'audit_logs'
  ] loop
    execute format('create trigger %I before update of organization_id on public.%I for each row execute function private.forbid_org_change()',
      t || '_forbid_org_change', t);
  end loop;
end;
$$;
