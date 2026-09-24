-- =============================================================================
-- Itinéraire réel des courses : tracé encodé (polyline, précision 5, [lat,lng]
-- au format Google/OSRM) calculé côté serveur à la création (fournisseur de
-- routage configuré, repli estimation). Exposé au dashboard (temps réel) et au
-- chauffeur (offres, course en cours).
-- =============================================================================

alter table public.rides
  add column route_polyline text check (route_polyline is null or length(route_polyline) <= 20000),
  add column route_provider text check (route_provider is null or length(route_provider) <= 30);

grant insert (route_polyline, route_provider) on public.rides to authenticated;
grant update (route_polyline, route_provider) on public.rides to authenticated;

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
      'estimated_distance_m', new.estimated_distance_m, 'estimated_duration_s', new.estimated_duration_s,
      'route_polyline', case when tg_op = 'INSERT' or new.route_polyline is distinct from old.route_polyline then new.route_polyline end,
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

create or replace function public.driver_offers()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'offer_id', o.id,
    'ride_id', r.id,
    'number', r.number,
    'mode', o.mode,
    'status', o.status,
    'ride_type', r.type,
    'pickup_address', r.pickup_address,
    'pickup_lat', r.pickup_lat,
    'pickup_lng', r.pickup_lng,
    'dropoff_address', r.dropoff_address,
    'dropoff_lat', r.dropoff_lat,
    'dropoff_lng', r.dropoff_lng,
    'pickup_at', r.pickup_at,
    'price_cents', r.price_cents,
    'currency', r.currency,
    'payment_method', r.payment_method,
    'passengers', r.passengers,
    'luggage', r.luggage,
    'vehicle_category', r.vehicle_category,
    'distance_m', o.distance_m,
    'estimated_distance_m', r.estimated_distance_m,
    'estimated_duration_s', r.estimated_duration_s,
    'route_polyline', r.route_polyline,
    'flight_number', r.flight_number,
    'comment', r.comment,
    'sent_at', o.sent_at,
    'expires_at', o.expires_at
  ) order by r.type, o.sent_at desc), '[]'::jsonb)
  from public.ride_offers o
  join public.rides r on r.id = o.ride_id
  where o.driver_id = private.current_driver_id()
    and o.status = 'pending'
    and r.driver_id is null
    and r.status in ('SEARCHING_DRIVER', 'OFFERED');
$$;
