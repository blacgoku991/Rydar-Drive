-- =============================================================================
-- Rydar Drive — « Pourquoi aucun chauffeur n'a été sollicité ? »
-- Retour du terrain : course Business, chauffeur en ligne à 300 m (véhicule Berline, inscrit par lien),
-- chronologie « Aucun chauffeur disponible dans un rayon de 16 km » sans autre explication.
-- Quand une recherche GPS se termine sans chauffeur (événement dispatch.retry), la chronologie de la
-- course liste désormais les chauffeurs EN LIGNE non sollicités, les plus proches d'abord, avec la raison :
-- déjà occupé, offre refusée / ignorée, sans véhicule, catégorie incompatible, places insuffisantes,
-- position GPS trop ancienne ou imprécise, règles de la centrale, hors du rayon.
-- Ajout pur : run_geo_wave n'est pas modifiée (déclencheur sur ride_events).
-- =============================================================================

create or replace function private.category_label(p_category public.vehicle_category)
returns text
language sql
immutable
set search_path = ''
as $$
  -- Mêmes libellés que VEHICLE_CATEGORY_META (@rydar/shared)
  select case p_category
    when 'standard' then 'Berline'
    when 'business' then 'Business'
    when 'first' then 'Prestige'
    when 'van' then 'Van'
    when 'green' then 'Électrique'
  end;
$$;

create or replace function private.explain_no_driver(p_ride_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  s public.organization_settings;
  v_centrale boolean;
  v_max_age interval;
  v_max_radius integer;
  v_items jsonb;
  v_counts jsonb;
  v_total integer;
  v_shown text;
begin
  select * into r from public.rides where id = p_ride_id;
  if not found or r.driver_id is not null then
    return;
  end if;
  select * into s from public.organization_settings where organization_id = r.organization_id;
  select coalesce(o.dispatch_model = 'centrale', false) into v_centrale from public.organizations o where o.id = r.organization_id;
  v_max_age := make_interval(secs => coalesce(s.location_max_age_seconds, 180));
  select max(x) into v_max_radius from unnest(coalesce(s.dispatch_radii_m, '{4000,8000,12000,16000}')) x;

  with online as (
    select d.id, d.first_name, d.last_name, d.presence, d.vehicle_id, v.category, v.seats, l.updated_at, l.accuracy_m,
           case when l.driver_id is not null and r.pickup_location is not null
                then round(extensions.st_distance(l.location, r.pickup_location))::integer end as distance_m,
           (select case when o.status = 'declined' then 'declined'
                        when o.closed_reason = 'removed_by_dispatch' then 'removed'
                        when o.closed_reason = 'ignored' then 'ignored' end
              from public.ride_offers o
             where o.ride_id = r.id and o.driver_id = d.id
               and (o.status = 'declined' or o.closed_reason in ('removed_by_dispatch', 'ignored'))
             order by o.sent_at desc limit 1) as offer_state,
           case when v_centrale then private.centrale_blocker(d.id, d.trust_level, r.price_cents, s.block_unpaid,
                  s.settlement_credit_limit_cents, s.new_driver_max_price_cents) end as blocker
    from public.drivers d
    left join public.driver_locations l on l.driver_id = d.id
    left join public.vehicles v on v.id = d.vehicle_id
    where d.organization_id = r.organization_id
      and d.status = 'active'
      and d.presence <> 'offline'
  ),
  classified as (
    select o.*,
      case
        when o.presence <> 'available' then 'busy'
        when o.offer_state is not null then o.offer_state
        when o.vehicle_id is null then 'no_vehicle'
        when not private.category_compatible(r.vehicle_category, o.category, s.allow_category_upgrade) then 'category'
        when coalesce(o.seats, 0) < r.passengers then 'seats'
        when o.updated_at is null or o.updated_at <= now() - v_max_age then 'stale'
        when coalesce(o.accuracy_m, 0) > 1500 then 'accuracy'
        when o.blocker is not null then 'blocked'
        when o.distance_m > v_max_radius then 'far'
      end as reason
    from online o
  ),
  explained as (
    select c.*,
      format('%s %s.', c.first_name, left(coalesce(c.last_name, ''), 1)) as name,
      case c.reason
        when 'busy' then case c.presence when 'offered' then 'offre en cours pour une autre course' else 'déjà en course' end
        when 'declined' then 'a refusé cette course'
        when 'removed' then 'retiré de cette course par la centrale'
        when 'ignored' then 'n''a pas répondu à l''offre'
        when 'no_vehicle' then 'aucun véhicule associé'
        when 'category' then format('véhicule %s, course %s', coalesce(private.category_label(c.category), '—'),
                                    private.category_label(r.vehicle_category))
        when 'seats' then format('%s places, %s passagers', coalesce(c.seats, 0), r.passengers)
        when 'stale' then case when c.updated_at is null then 'aucune position GPS reçue'
                               when c.updated_at > now() - interval '90 minutes'
                                 then format('position GPS vieille de %s min', greatest(1, round(extract(epoch from now() - c.updated_at) / 60)))
                               else format('position GPS vieille de %s h', round(extract(epoch from now() - c.updated_at) / 3600)) end
        when 'accuracy' then format('position GPS imprécise (± %s m)', round(c.accuracy_m))
        when 'blocked' then case c.blocker when 'unpaid' then 'commission en retard'
                                           when 'credit_limit' then 'plafond de commissions atteint'
                                           else 'course réservée aux chauffeurs confirmés' end
        when 'far' then format('à %s, au-delà du rayon de %s', private.fmt_km((round(c.distance_m / 100.0) * 100)::integer), private.fmt_km(v_max_radius))
      end as label
    from classified c
    where c.reason is not null
  )
  select
    coalesce(jsonb_agg(jsonb_build_object('driver_id', e.id, 'name', e.name, 'reason', e.reason, 'label', e.label,
                                          'distance_m', e.distance_m)
                       order by e.distance_m nulls last, e.name), '[]'::jsonb),
    count(*)::integer
  into v_items, v_total
  from explained e;

  if v_total = 0 then
    return;
  end if;

  select jsonb_object_agg(k, n) into v_counts
  from (select x->>'reason' as k, count(*) as n from jsonb_array_elements(v_items) x group by 1) t;

  -- Les 3 plus proches : « Mohamed M. (320 m) : véhicule Berline, course Business » (distances arrondies à 10 m)
  select string_agg(
           format('%s%s : %s', x->>'name',
                  case when x->>'distance_m' is not null then format(' (%s)', private.fmt_km((round((x->>'distance_m')::numeric / 10) * 10)::integer)) else '' end,
                  x->>'label'),
           ' · ' order by ord)
    into v_shown
  from jsonb_array_elements(v_items) with ordinality as t(x, ord)
  where ord <= 3;

  perform private.log_event(r.organization_id, r.id, 'dispatch.excluded',
    format('%s %s en ligne non %s — %s%s', v_total, private.pl(v_total, 'chauffeur', 'chauffeurs'),
           private.pl(v_total, 'sollicité', 'sollicités'), v_shown,
           case when v_total > 3 then format(' · et %s autre%s', v_total - 3, case when v_total - 3 > 1 then 's' else '' end) else '' end),
    'timeline', 'warning', jsonb_build_object('excluded', v_items, 'counts', v_counts), 'system', null);
end;
$$;

create or replace function private.ride_events_explain_retry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.explain_no_driver(new.ride_id);
  return null;
end;
$$;

drop trigger if exists ride_events_explain_retry on public.ride_events;
create trigger ride_events_explain_retry
  after insert on public.ride_events
  for each row
  when (new.type = 'dispatch.retry' and new.ride_id is not null)
  execute function private.ride_events_explain_retry();

-- Droits d'exécution (deny-by-default, cf. 20260924000900)
revoke execute on function
  private.category_label(public.vehicle_category),
  private.explain_no_driver(uuid),
  private.ride_events_explain_retry()
from public, anon, authenticated;
grant execute on function
  private.category_label(public.vehicle_category),
  private.explain_no_driver(uuid),
  private.ride_events_explain_retry()
to service_role;
