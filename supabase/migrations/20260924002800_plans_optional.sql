-- =============================================================================
-- Rydar Drive — Offre facultative
-- 1. Une centrale sans offre (plan_id null : tests, offres pas encore définies) n'a ni limite ni
--    restriction : API, mini-site, domaine personnalisé et statistiques avancées autorisés.
--    Les surcharges du super admin (limits_override) s'appliquent toujours.
-- 2. Retrait des offres par défaut de la migration 002700 (le propriétaire définira les siennes) :
--    les centrales qui en avaient une passent « sans offre ». Une offre modifiée depuis est conservée.
-- =============================================================================
create or replace function private.org_limits(p_org uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when o.plan_id is null
             then '{"api_access": true, "booking_site": true, "custom_domain": true, "advanced_stats": true}'::jsonb
           else coalesce(p.limits, '{}'::jsonb)
         end || coalesce(o.limits_override, '{}'::jsonb)
  from public.organizations o
  left join public.plans p on p.id = o.plan_id
  where o.id = p_org;
$$;

do $$
declare
  v_ids uuid[];
begin
  select coalesce(array_agg(id), '{}') into v_ids
  from public.plans
  where (code, name, price_monthly_cents) in (('starter', 'Starter', 4900), ('pro', 'Pro', 14900), ('business', 'Business', 39900));
  update public.organizations set plan_id = null where plan_id = any (v_ids);
  update public.subscriptions set plan_id = null where plan_id = any (v_ids);
  delete from public.plans where id = any (v_ids);
end;
$$;
