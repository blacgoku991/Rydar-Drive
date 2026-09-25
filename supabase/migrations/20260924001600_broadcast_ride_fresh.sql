-- =============================================================================
-- Diffusion temps réel des courses : toujours l'état le plus récent.
-- À l'insertion, le trigger de dispatch (rides_b_start_dispatch) met la course à
-- jour AVANT que le trigger de diffusion de l'INSERT ne s'exécute : le message
-- « insert » (statut CREATED) arrivait après « OFFERED » et le dashboard restait
-- figé sur « Créée ». On relit donc la ligne courante avant de diffuser.
-- =============================================================================

create or replace function private.broadcast_ride()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.rides;
begin
  if current_setting('rydar.bypass_ride_rules', true) = 'on' then
    return null;
  end if;
  select * into v from public.rides where id = new.id;
  if not found then
    v := new;
  end if;

  perform realtime.send(
    jsonb_build_object(
      'op', lower(tg_op), 'id', v.id, 'number', v.number, 'status', v.status, 'type', v.type, 'source', v.source,
      'pickup_address', v.pickup_address, 'pickup_lat', v.pickup_lat, 'pickup_lng', v.pickup_lng,
      'dropoff_address', v.dropoff_address, 'dropoff_lat', v.dropoff_lat, 'dropoff_lng', v.dropoff_lng,
      'pickup_at', v.pickup_at, 'customer_name', v.customer_name, 'passengers', v.passengers,
      'vehicle_category', v.vehicle_category, 'price_cents', v.price_cents, 'driver_id', v.driver_id,
      'dispatch_wave', v.dispatch_wave, 'dispatch_radius_m', v.dispatch_radius_m, 'next_dispatch_at', v.next_dispatch_at,
      'estimated_distance_m', v.estimated_distance_m, 'estimated_duration_s', v.estimated_duration_s,
      'route_polyline', case when tg_op = 'INSERT' or new.route_polyline is distinct from old.route_polyline then v.route_polyline end,
      'created_at', v.created_at, 'updated_at', v.updated_at),
    'ride.updated', 'org:' || v.organization_id::text, true);

  if v.driver_id is not null then
    perform realtime.send(
      jsonb_build_object('id', v.id, 'status', v.status, 'driver_id', v.driver_id, 'updated_at', v.updated_at),
      'ride.updated', 'driver:' || v.driver_id::text, true);
  end if;
  if tg_op = 'UPDATE' and old.driver_id is not null and old.driver_id is distinct from new.driver_id then
    perform realtime.send(
      jsonb_build_object('id', new.id, 'status', 'UNASSIGNED'),
      'ride.unassigned', 'driver:' || old.driver_id::text, true);
  end if;
  return null;
end;
$$;

revoke all on function private.broadcast_ride() from public;
