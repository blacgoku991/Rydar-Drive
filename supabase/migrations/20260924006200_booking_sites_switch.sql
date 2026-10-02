-- =============================================================================
-- Rydar Drive — Interrupteur plateforme des mini-sites de réservation.
--
-- Demande du propriétaire : mini-sites coupés pour toutes les flottes et centrales, jusqu'à réactivation par le super
-- admin (Offres & limites). Un seul réglage pour toute la plateforme, COUPÉ par cette migration.
--
--  * public.platform_settings (une ligne) : booking_sites_enabled. Lecture : super admin (RLS) et
--    public.booking_sites_enabled() ; écriture : public.svc_set_booking_sites_enabled (service role, auteur revérifié,
--    journal d'audit).
--  * Coupé :
--      - public.resolve_booking_host renvoie null : sous-domaines et domaines personnalisés ne servent plus le
--        mini-site (proxy.ts) et /api/tls/allowed refuse les nouveaux certificats de ces hôtes ;
--      - aucune course source « booking_site » (BOOKING_SITES_DISABLED) ; l'API v1, le dashboard et la saisie des
--        courses ne sont pas concernés ;
--      - réglages du mini-site figés pour les clients (dashboard, PostgREST : BOOKING_SITES_DISABLED) ; pour le service
--        role et la base, rien ne s'allume (activation, vérification d'un domaine) mais les réductions passent (offre
--        rétrogradée : private.sync_booking_site_rights).
--  * Les réglages de chaque centrale (activé, contenu, sous-domaine, domaine vérifié) ne sont JAMAIS modifiés par
--    l'interrupteur : la réactivation remet chaque mini-site tel qu'il était.
-- =============================================================================

-- ----------------------------------------------------------------- réglages de la plateforme
create table public.platform_settings (
  id boolean primary key default true check (id),
  booking_sites_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users (id) on delete set null
);
comment on table public.platform_settings is
  'Réglages de toute la plateforme (une ligne) : interrupteur des mini-sites — écriture : super admin (svc_set_booking_sites_enabled).';
comment on column public.platform_settings.booking_sites_enabled is
  'Mini-sites de réservation servis (/book, sous-domaines, domaines personnalisés). Coupé : réglages des centrales conservés.';

insert into public.platform_settings (id, booking_sites_enabled) values (true, false) on conflict (id) do nothing;

alter table public.platform_settings enable row level security;
create policy platform_settings_select on public.platform_settings for select to authenticated
  using ((select private.is_super_admin()));
revoke all on public.platform_settings from public, anon, authenticated;
grant select on public.platform_settings to authenticated;
grant all on public.platform_settings to service_role;

-- Coupure initiale journalisée (aucun auteur : migration)
insert into public.audit_logs (organization_id, actor_type, action, entity_type, entity_id, severity, metadata)
values (null, 'system', 'platform.booking_sites_disabled', 'platform_settings', 'booking_sites', 'warning',
        jsonb_build_object('from', true, 'to', false, 'source', 'migration 20260924006200'));

-- ----------------------------------------------------------------- lecture de l'interrupteur
-- Absent ou illisible = coupé (jamais un mini-site servi par défaut).
create or replace function public.booking_sites_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.booking_sites_enabled from public.platform_settings s where s.id), false);
$$;

-- authenticated : appelée aussi par les triggers ci-dessous (sans definer) lors d'une écriture du dashboard
revoke all on function public.booking_sites_enabled() from public, anon, authenticated;
grant execute on function public.booking_sites_enabled() to authenticated, service_role;

-- ----------------------------------------------------------------- écriture : super admin
create or replace function public.svc_set_booking_sites_enabled(p_actor uuid, p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before boolean;
begin
  perform private.assert_platform_actor(p_actor);
  if p_enabled is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'message', 'Valeur invalide.');
  end if;
  insert into public.platform_settings (id) values (true) on conflict (id) do nothing;
  select s.booking_sites_enabled into v_before from public.platform_settings s where s.id for update;
  if v_before = p_enabled then
    return jsonb_build_object('ok', true, 'enabled', p_enabled, 'changed', false);
  end if;
  update public.platform_settings
     set booking_sites_enabled = p_enabled, updated_at = now(), updated_by = p_actor
   where id;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (null, 'super_admin', p_actor,
          case when p_enabled then 'platform.booking_sites_enabled' else 'platform.booking_sites_disabled' end,
          'platform_settings', 'booking_sites', 'warning', jsonb_build_object('from', v_before, 'to', p_enabled));
  return jsonb_build_object('ok', true, 'enabled', p_enabled, 'changed', true);
end;
$$;

revoke all on function public.svc_set_booking_sites_enabled(uuid, boolean) from public, anon, authenticated;
grant execute on function public.svc_set_booking_sites_enabled(uuid, boolean) to service_role;

-- ----------------------------------------------------------------- résolution d'un hôte de mini-site
-- Dernière définition : 20260924005000_audit_domaine.sql (même signature, droits rappelés ci-dessous)
create or replace function public.resolve_booking_host(p_host text, p_root_domain text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_host text := lower(btrim(coalesce(p_host, '')));
  v_root text := lower(btrim(coalesce(p_root_domain, '')));
  v_slug text;
begin
  if v_host = '' or v_host = v_root then
    return null;
  end if;

  -- Mini-sites coupés par la plateforme : aucun hôte ne se résout (ni réécriture, ni nouveau certificat)
  if not public.booking_sites_enabled() then
    return null;
  end if;

  -- Hôte de la plateforme (<sous-domaine>.DOMAIN) : sous-domaine uniquement, jamais un domaine personnalisé
  if v_root <> '' and right(v_host, char_length(v_root) + 1) = '.' || v_root then
    select o.slug into v_slug
    from public.booking_sites b
    join public.organizations o on o.id = b.organization_id
    where b.enabled
      and o.status = 'active'
      and b.subdomain = left(v_host, char_length(v_host) - char_length(v_root) - 1);
    return v_slug;
  end if;

  -- Domaine personnalisé vérifié (unique : booking_sites_custom_domain_verified_key)
  select o.slug into v_slug
  from public.booking_sites b
  join public.organizations o on o.id = b.organization_id
  where b.enabled
    and o.status = 'active'
    and b.custom_domain_verified_at is not null
    and lower(b.custom_domain) = v_host
  order by b.custom_domain_verified_at, b.organization_id
  limit 1;
  return v_slug;
end;
$$;

revoke all on function public.resolve_booking_host(text, text) from public;
grant execute on function public.resolve_booking_host(text, text) to anon, authenticated, service_role;

-- ----------------------------------------------------------------- réglages du mini-site pendant la coupure
create or replace function private.guard_booking_sites_switch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.booking_sites_enabled() then
    return new;
  end if;
  -- Clients (dashboard, PostgREST) : aucune modification. Service role et base : réductions seulement (offre
  -- rétrogradée, private.sync_booking_site_rights) ; jamais d'activation ni de domaine vérifié
  if coalesce(auth.role(), '') in ('anon', 'authenticated')
     or (new.enabled and not old.enabled)
     or (new.custom_domain_verified_at is not null
         and new.custom_domain_verified_at is distinct from old.custom_domain_verified_at) then
    raise exception 'BOOKING_SITES_DISABLED: les mini-sites de réservation sont désactivés par la plateforme'
      using errcode = '55000', hint = 'Réactivation par le super admin (Offres & limites).';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_booking_sites_switch() from public, anon, authenticated;
grant execute on function private.guard_booking_sites_switch() to service_role;

drop trigger if exists booking_sites_platform_switch on public.booking_sites;
create trigger booking_sites_platform_switch before update on public.booking_sites
  for each row execute function private.guard_booking_sites_switch();

-- ----------------------------------------------------------------- courses du mini-site pendant la coupure
create or replace function private.reject_booking_site_ride()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Données de démonstration (seed, connexion directe sans JWT) : mêmes exceptions que les autres règles des courses
  if current_setting('rydar.bypass_ride_rules', true) = 'on' and auth.role() is null then
    return new;
  end if;
  if not public.booking_sites_enabled() then
    raise exception 'BOOKING_SITES_DISABLED: les mini-sites de réservation sont désactivés par la plateforme'
      using errcode = '55000', hint = 'Réactivation par le super admin (Offres & limites).';
  end if;
  return new;
end;
$$;

revoke all on function private.reject_booking_site_ride() from public, anon, authenticated;
grant execute on function private.reject_booking_site_ride() to service_role;

drop trigger if exists rides_booking_sites_switch on public.rides;
create trigger rides_booking_sites_switch before insert on public.rides
  for each row
  when (new.source = 'booking_site')
  execute function private.reject_booking_site_ride();
