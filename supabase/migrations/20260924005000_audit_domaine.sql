-- =============================================================================
-- Rydar Drive — Audit « domaine » : mini-sites (sous-domaines, domaines personnalisés).
--
--  1. public.resolve_booking_host : résolution déterministe. Un hôte sous le domaine racine de Rydar
--     (<x>.DOMAIN) ne se résout QUE par le sous-domaine ; le domaine racine lui-même ne se résout jamais ;
--     un domaine personnalisé vérifié ne peut donc jamais capter le sous-domaine Rydar d'une autre centrale
--     (avant : OR des deux branches + « limit 1 » sans ordre, la plus ancienne centrale gagnait).
--  2. Unicité de booking_sites.custom_domain sur les seuls domaines VÉRIFIÉS (index unique partiel) : un domaine
--     saisi mais jamais vérifié ne bloque plus son vrai propriétaire ; le premier qui prouve l'enregistrement
--     TXT l'emporte (la vérification, atomique côté serveur, échoue en 23505 si une autre centrale l'a déjà).
--  3. Changements de sous-domaine limités (5 par période glissante de 7 jours et par centrale, clients
--     seulement) : chaque nouveau nom peut déclencher un certificat HTTPS « à la demande » (Caddy), et
--     Let's Encrypt limite les nouveaux certificats par domaine enregistré (50 / 7 jours pour toute la plateforme).
-- =============================================================================

-- ----------------------------------------------------------------- 1. résolution d'un hôte de mini-site
-- Dernière définition : 20260924000500_analytics.sql (même signature, droits rappelés ci-dessous)
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

-- ----------------------------------------------------------------- 2. unicité des domaines vérifiés seulement
alter table public.booking_sites drop constraint booking_sites_custom_domain_key;
create unique index booking_sites_custom_domain_verified_key
  on public.booking_sites (lower(custom_domain))
  where custom_domain_verified_at is not null;

-- ----------------------------------------------------------------- 3. fréquence des changements de sous-domaine
-- Dates des derniers changements (7 jours glissants) : écrite par le trigger seulement (aucun GRANT UPDATE client).
alter table public.booking_sites
  add column subdomain_changes timestamptz[] not null default '{}';

create or replace function private.limit_subdomain_changes()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_recent timestamptz[];
begin
  if new.subdomain is not distinct from old.subdomain or new.subdomain is null then
    return new;
  end if;
  select coalesce(array_agg(t order by t), '{}') into v_recent
  from unnest(old.subdomain_changes) as t
  where t > now() - interval '7 days';
  -- Clients (dashboard, PostgREST) seulement ; le super admin (service role) et la base ne sont pas limités
  if auth.role() = 'authenticated' and cardinality(v_recent) >= 5 then
    raise exception 'SUBDOMAIN_CHANGE_LIMIT: sous-domaine déjà modifié 5 fois en 7 jours'
      using hint = 'Réessayez plus tard ou contactez l''équipe Rydar.';
  end if;
  new.subdomain_changes := v_recent || now();
  return new;
end;
$$;

revoke all on function private.limit_subdomain_changes() from public, anon, authenticated;

create trigger booking_sites_subdomain_changes before update of subdomain on public.booking_sites
  for each row execute function private.limit_subdomain_changes();
