-- =============================================================================
-- Rydar Drive — Temps réel (Supabase Realtime « Broadcast from database »)
-- Canaux privés :  org:{organization_id}   (dashboard rattacheur)
--                  driver:{driver_id}       (application chauffeur)
-- L'autorisation d'écoute est contrôlée par la RLS sur realtime.messages.
-- Payloads compacts : jamais de téléphone client sur les canaux chauffeurs.
-- =============================================================================

create or replace function private.broadcast_driver_location()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object('driver_id', new.driver_id, 'lat', new.lat, 'lng', new.lng, 'heading', new.heading,
      'speed', new.speed_mps, 'accuracy', new.accuracy_m, 'updated_at', new.updated_at),
    'driver.location', 'org:' || new.organization_id::text, true);
  return null;
end;
$$;

create or replace function private.broadcast_driver()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object('id', new.id, 'number', new.number, 'first_name', new.first_name, 'last_name', new.last_name,
      'presence', new.presence, 'status', new.status, 'current_ride_id', new.current_ride_id, 'vehicle_id', new.vehicle_id),
    'driver.updated', 'org:' || new.organization_id::text, true);
  perform realtime.send(
    jsonb_build_object('id', new.id, 'presence', new.presence, 'status', new.status, 'current_ride_id', new.current_ride_id),
    'driver.updated', 'driver:' || new.id::text, true);
  return null;
end;
$$;

create or replace function private.broadcast_ride()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('rydar.bypass_ride_rules', true) = 'on' then
    return null;
  end if;
  perform realtime.send(
    jsonb_build_object(
      'op', lower(tg_op), 'id', new.id, 'number', new.number, 'status', new.status, 'type', new.type, 'source', new.source,
      'pickup_address', new.pickup_address, 'pickup_lat', new.pickup_lat, 'pickup_lng', new.pickup_lng,
      'dropoff_address', new.dropoff_address, 'dropoff_lat', new.dropoff_lat, 'dropoff_lng', new.dropoff_lng,
      'pickup_at', new.pickup_at, 'customer_name', new.customer_name, 'passengers', new.passengers,
      'vehicle_category', new.vehicle_category, 'price_cents', new.price_cents, 'driver_id', new.driver_id,
      'dispatch_wave', new.dispatch_wave, 'dispatch_radius_m', new.dispatch_radius_m, 'next_dispatch_at', new.next_dispatch_at,
      'created_at', new.created_at, 'updated_at', new.updated_at),
    'ride.updated', 'org:' || new.organization_id::text, true);

  if new.driver_id is not null then
    perform realtime.send(
      jsonb_build_object('id', new.id, 'status', new.status, 'driver_id', new.driver_id, 'updated_at', new.updated_at),
      'ride.updated', 'driver:' || new.driver_id::text, true);
  end if;
  if tg_op = 'UPDATE' and old.driver_id is not null and old.driver_id is distinct from new.driver_id then
    perform realtime.send(
      jsonb_build_object('id', new.id, 'status', 'UNASSIGNED'),
      'ride.unassigned', 'driver:' || old.driver_id::text, true);
  end if;
  return null;
end;
$$;

create or replace function private.broadcast_offer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('rydar.bypass_ride_rules', true) = 'on' then
    return null;
  end if;
  perform realtime.send(
    jsonb_build_object('op', lower(tg_op), 'id', new.id, 'ride_id', new.ride_id, 'driver_id', new.driver_id,
      'status', new.status, 'mode', new.mode, 'wave', new.wave, 'distance_m', new.distance_m, 'expires_at', new.expires_at),
    'offer.updated', 'org:' || new.organization_id::text, true);
  perform realtime.send(
    jsonb_build_object('op', lower(tg_op), 'id', new.id, 'ride_id', new.ride_id, 'status', new.status,
      'mode', new.mode, 'expires_at', new.expires_at),
    'offer.updated', 'driver:' || new.driver_id::text, true);
  return null;
end;
$$;

create or replace function private.broadcast_ride_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('rydar.bypass_ride_rules', true) = 'on' then
    return null;
  end if;
  perform realtime.send(
    jsonb_build_object('id', new.id, 'ride_id', new.ride_id, 'category', new.category, 'level', new.level,
      'type', new.type, 'message', new.message, 'data', new.data, 'actor_type', new.actor_type, 'created_at', new.created_at),
    'ride.event', 'org:' || new.organization_id::text, true);
  return null;
end;
$$;

create trigger driver_locations_broadcast
  after insert or update on public.driver_locations
  for each row execute function private.broadcast_driver_location();

create trigger drivers_broadcast
  after insert or update of presence, status, current_ride_id, vehicle_id, first_name, last_name on public.drivers
  for each row execute function private.broadcast_driver();

create trigger rides_c_broadcast
  after insert or update on public.rides
  for each row execute function private.broadcast_ride();

create trigger ride_offers_broadcast
  after insert or update of status on public.ride_offers
  for each row execute function private.broadcast_offer();

create trigger ride_events_broadcast
  after insert on public.ride_events
  for each row execute function private.broadcast_ride_event();

-- Autorisation d'écoute des canaux privés
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'alter table realtime.messages enable row level security';
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
      )
    $pol$;
  end if;
end;
$$;
