-- =============================================================================
-- Rydar Drive — Audit « public » (mini-sites de réservation)
-- 1. Sous-domaines réservés à la plateforme (admin, support, api, login… et tout nom commençant par
--    « rydar ») : refusés sur booking_sites.subdomain. Le schéma zod (slugSchema, @rydar/shared) les refuse
--    déjà, mais le GRANT UPDATE (subdomain) permet d'écrire directement via PostgREST. Trigger plutôt que
--    CHECK : d'éventuelles lignes existantes ne bloquent pas la migration (elles restent jusqu'au prochain
--    changement de sous-domaine). À la création automatique (handle_new_organization : sous-domaine =
--    identifiant de la centrale), un nom réservé est simplement omis (la centrale en choisira un).
-- 2. Droits de l'offre : une centrale qui perd le mini-site (ou le domaine personnalisé) — changement
--    d'offre (super admin, abonnement Stripe), de surcharge (limits_override) ou des limites de son
--    offre — voit son site désactivé (et son domaine personnalisé à revérifier). Page, devis, réservation
--    et resolve_booking_host testent déjà enabled / custom_domain_verified_at. Pas de réactivation
--    automatique après une remontée d'offre : la centrale réactive son site elle-même.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Sous-domaines réservés (liste identique à RESERVED_SUBDOMAINS de packages/shared/src/schemas.ts)
-- -----------------------------------------------------------------------------
create or replace function private.is_reserved_subdomain(p_subdomain text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lower(btrim(coalesce(p_subdomain, ''))) like 'rydar%'
      or lower(btrim(coalesce(p_subdomain, ''))) = any (array[
        'www', 'app', 'api', 'admin', 'administration', 'support', 'aide', 'help', 'status', 'statut', 'mail', 'email', 'smtp', 'imap',
        'pop', 'mx', 'mta-sts', 'autodiscover', 'autoconfig', 'docs', 'doc', 'blog', 'login', 'connexion', 'auth', 'compte', 'account',
        'securite', 'security', 'paiement', 'payment', 'facturation', 'billing', 'dashboard', 'static', 'cdn', 'assets', 'book',
        'rejoindre', 'chauffeur', 'driver', 'centrale', 'legal', 'juridique'
      ]);
$$;

create or replace function private.reject_reserved_subdomain()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.subdomain is not null
     and (tg_op = 'INSERT' or new.subdomain is distinct from old.subdomain)
     and private.is_reserved_subdomain(new.subdomain) then
    if tg_op = 'INSERT' then
      new.subdomain := null;
    else
      raise exception 'SUBDOMAIN_RESERVED: ce sous-domaine est réservé à la plateforme' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists booking_sites_reserved_subdomain on public.booking_sites;
create trigger booking_sites_reserved_subdomain before insert or update of subdomain on public.booking_sites
  for each row execute function private.reject_reserved_subdomain();

-- -----------------------------------------------------------------------------
-- 2. Mini-site et domaine personnalisé coupés quand l'offre ne les inclut plus
--    (centrale sans offre : tout reste autorisé, cf. private.org_limits, migration 002800)
-- -----------------------------------------------------------------------------
create or replace function private.sync_booking_site_rights()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Centrales concernées : celle modifiée (organizations) ou toutes celles de l'offre modifiée (plans)
  update public.booking_sites b
     set enabled = false
   where b.enabled
     and b.organization_id in (
       select o.id from public.organizations o
       where (tg_table_name = 'organizations' and o.id = new.id) or (tg_table_name = 'plans' and o.plan_id = new.id)
     )
     and not coalesce((private.org_limits(b.organization_id) ->> 'booking_site')::boolean, false);

  update public.booking_sites b
     set custom_domain_verified_at = null
   where b.custom_domain_verified_at is not null
     and b.organization_id in (
       select o.id from public.organizations o
       where (tg_table_name = 'organizations' and o.id = new.id) or (tg_table_name = 'plans' and o.plan_id = new.id)
     )
     and not coalesce((private.org_limits(b.organization_id) ->> 'custom_domain')::boolean, false);
  return null;
end;
$$;

drop trigger if exists organizations_booking_site_rights on public.organizations;
create trigger organizations_booking_site_rights after update of plan_id, limits_override on public.organizations
  for each row
  when (old.plan_id is distinct from new.plan_id or old.limits_override is distinct from new.limits_override)
  execute function private.sync_booking_site_rights();

drop trigger if exists plans_booking_site_rights on public.plans;
create trigger plans_booking_site_rights after update of limits on public.plans
  for each row
  when (old.limits is distinct from new.limits)
  execute function private.sync_booking_site_rights();

-- -----------------------------------------------------------------------------
-- Droits (deny-by-default, cf. 000900). is_reserved_subdomain est appelée par le trigger (sans definer)
-- avec les droits de l'auteur de la modification : un owner/admin via PostgREST → EXECUTE à authenticated
-- (fonction pure, sans lecture de données).
-- -----------------------------------------------------------------------------
revoke all on function private.is_reserved_subdomain(text) from public, anon;
revoke all on function private.reject_reserved_subdomain() from public, anon, authenticated;
revoke all on function private.sync_booking_site_rights() from public, anon, authenticated;
grant execute on function private.is_reserved_subdomain(text) to authenticated, service_role;
grant execute on function private.reject_reserved_subdomain() to service_role;
grant execute on function private.sync_booking_site_rights() to service_role;
