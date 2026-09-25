-- Fuseau horaire d'organisation : nom IANA valide obligatoire.
--
-- organizations.timezone est modifiable par l'owner / l'admin (GRANT par colonne, 000300). Une valeur
-- inconnue (« Mars/Olympus ») faisait échouer `at time zone` dans les tâches globales du worker
-- (private.document_reminders, private.housekeeping, statistiques…) : une seule organisation mal
-- réglée bloquait alors les rappels et échéances de documents de TOUTES les autres.

create or replace function private.validate_org_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.timezone is not null
     and not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone) then
    raise exception 'INVALID_TIMEZONE: fuseau horaire inconnu (%)', new.timezone using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke execute on function private.validate_org_timezone() from public, anon, authenticated;

-- Valeurs déjà enregistrées : assainies avant la pose du contrôle
update public.organizations o
   set timezone = 'Europe/Paris'
 where o.timezone is not null
   and not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = o.timezone);

drop trigger if exists organizations_validate_timezone on public.organizations;
create trigger organizations_validate_timezone
  before insert or update of timezone on public.organizations
  for each row execute function private.validate_org_timezone();
