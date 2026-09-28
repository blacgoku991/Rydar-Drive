-- =============================================================================
-- Offres du chauffeur : l'indicateur « bloqué » applique la même règle que l'acceptation (20260924005400) — une course
-- sans prix n'est pas acceptable par un nouveau chauffeur quand la centrale a réglé un plafond de prix. Avant, l'offre
-- s'affichait « acceptable » puis l'acceptation était refusée.
-- =============================================================================

-- Dernière définition : 20260924002600_centrale_mode.sql (seul changement : driver_blocker(…, true))
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
  ) || jsonb_build_object(
    'flight_mode', r.flight_mode,
    'flight_status', r.flight_status,
    'flight_scheduled_arrival', r.flight_scheduled_arrival,
    'flight_estimated_arrival', r.flight_estimated_arrival,
    'flight_actual_arrival', r.flight_actual_arrival,
    'flight_delay_minutes', r.flight_delay_minutes,
    'flight_terminal', r.flight_terminal,
    'flight_origin', r.flight_origin,
    'pickup_at_original', r.pickup_at_original
  ) || jsonb_build_object(
    'dispatch_model', g.dispatch_model,
    'commission_cents', r.commission_cents,
    'platform_fee_cents', r.platform_fee_cents,
    'driver_payout_cents', r.driver_payout_cents,
    'driver_collects', r.payment_method in ('cash', 'card'),
    'blocked', case when g.dispatch_model = 'centrale' then private.driver_blocker(o.driver_id, r.price_cents, true) end
  ) order by r.type, o.sent_at desc), '[]'::jsonb)
  from public.ride_offers o
  join public.rides r on r.id = o.ride_id
  join public.organizations g on g.id = r.organization_id
  where o.driver_id = private.current_driver_id()
    and o.status = 'pending'
    and r.driver_id is null
    and r.status in ('SEARCHING_DRIVER', 'OFFERED');
$$;

revoke execute on function public.driver_offers() from public, anon;
grant execute on function public.driver_offers() to authenticated, service_role;
