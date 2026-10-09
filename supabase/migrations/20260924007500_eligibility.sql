-- =============================================================================
-- Rydar Drive — Test d'éligibilité « Flotte Privée » (page eligibilite.<domaine>, /eligibilite)
--
--  1. Demandes de contact : nouveau sujet « eligibility ». Le test enregistre une demande comme le formulaire
--     /contact (svc_contact_submit, inchangée) : réponses et verdict dans le message, lus dans /admin/contacts ;
--     mêmes droits, même file d'e-mails, mêmes durées de conservation (aucune table dédiée).
--  2. Sous-domaines réservés : « eligibilite » et « eligibility » (page de la plateforme), refusés pour un mini-site.
--
-- Supabase hébergé : rien sur auth.*, storage.*, realtime.messages. Aucune signature changée : droits conservés.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Sujet « eligibility » (contrainte d'origine : 20260924005700_contact_requests.sql, nom par défaut)
-- -----------------------------------------------------------------------------
alter table public.contact_requests
  drop constraint contact_requests_topic_check,
  add constraint contact_requests_topic_check
    check (topic in ('pricing', 'question', 'partnership', 'other', 'eligibility'));
comment on column public.contact_requests.topic is
  'pricing | question | partnership | other (formulaire /contact) | eligibility (test d''éligibilité Flotte Privée).';

-- -----------------------------------------------------------------------------
-- 2. Sous-domaines réservés (liste identique à RESERVED_SUBDOMAINS de packages/shared/src/schemas.ts)
-- Dernière définition : 20260924004900_audit_public.sql (seul ajout : 'eligibilite', 'eligibility')
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
        'rejoindre', 'chauffeur', 'driver', 'centrale', 'legal', 'juridique', 'eligibilite', 'eligibility'
      ]);
$$;
revoke all on function private.is_reserved_subdomain(text) from public, anon;
grant execute on function private.is_reserved_subdomain(text) to authenticated, service_role;
