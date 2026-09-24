-- Compteurs de l'écran Courses (filtres) — une seule requête indexée.
create or replace function public.org_ride_counts(p_org uuid, p_since timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform private.assert_org_reader(p_org);
  select jsonb_build_object(
    'all', count(*),
    'instant', count(*) filter (where type = 'instant'),
    'scheduled', count(*) filter (where type = 'scheduled'),
    'searching', count(*) filter (where status in ('CREATED', 'SEARCHING_DRIVER')),
    'offered', count(*) filter (where status = 'OFFERED'),
    'assigned', count(*) filter (where status = 'ACCEPTED'),
    'ongoing', count(*) filter (where status in ('DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS')),
    'completed', count(*) filter (where status = 'COMPLETED'),
    'cancelled', count(*) filter (where status = 'CANCELLED'),
    'no_driver', count(*) filter (where status = 'NO_DRIVER_FOUND')
  ) into v
  from public.rides
  where organization_id = p_org
    and (pickup_at >= p_since or status not in ('COMPLETED', 'CANCELLED', 'NO_DRIVER_FOUND'));
  return v;
end;
$$;

revoke execute on function public.org_ride_counts(uuid, timestamptz) from public, anon;
grant execute on function public.org_ride_counts(uuid, timestamptz) to authenticated, service_role;
