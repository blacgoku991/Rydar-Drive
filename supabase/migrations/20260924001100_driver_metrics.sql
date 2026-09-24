-- Indicateurs par chauffeur (liste des chauffeurs) : taux d'acceptation,
-- courses terminées / annulées, CA — sur une fenêtre glissante.
create or replace function public.org_driver_metrics(p_org uuid, p_days integer default 30)
returns table (
  driver_id uuid,
  offers bigint,
  accepted bigint,
  declined bigint,
  expired bigint,
  acceptance_rate numeric,
  completed bigint,
  cancelled bigint,
  revenue_cents bigint,
  last_ride_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)));
begin
  perform private.assert_org_reader(p_org);
  return query
  select d.id,
         coalesce(o.offers, 0),
         coalesce(o.accepted, 0),
         coalesce(o.declined, 0),
         coalesce(o.expired, 0),
         case when coalesce(o.answered, 0) > 0 then round(o.accepted::numeric / o.answered, 4) end,
         coalesce(r.completed, 0),
         coalesce(r.cancelled, 0),
         coalesce(r.revenue, 0)::bigint,
         r.last_ride_at
  from public.drivers d
  left join (
    select x.driver_id, count(*) as offers,
           count(*) filter (where x.status = 'accepted') as accepted,
           count(*) filter (where x.status = 'declined') as declined,
           count(*) filter (where x.status = 'expired') as expired,
           count(*) filter (where x.status in ('accepted', 'declined', 'expired')) as answered
    from public.ride_offers x
    where x.organization_id = p_org and x.sent_at >= v_from
    group by x.driver_id
  ) o on o.driver_id = d.id
  left join (
    select y.driver_id,
           count(*) filter (where y.status = 'COMPLETED') as completed,
           count(*) filter (where y.status = 'CANCELLED') as cancelled,
           sum(y.price_cents) filter (where y.status = 'COMPLETED') as revenue,
           max(y.pickup_at) as last_ride_at
    from public.rides y
    where y.organization_id = p_org and y.pickup_at >= v_from and y.driver_id is not null
    group by y.driver_id
  ) r on r.driver_id = d.id
  where d.organization_id = p_org;
end;
$$;

revoke execute on function public.org_driver_metrics(uuid, integer) from public, anon;
grant execute on function public.org_driver_metrics(uuid, integer) to authenticated, service_role;
