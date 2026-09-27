-- =============================================================================
-- Rydar Drive — Application fermée = hors ligne (décision utilisateur, remplace les réveils de 003300).
-- « Si le chauffeur change d'app ou verrouille son téléphone, Rydar reste actif et le GPS en direct ; s'il
--   ferme complètement l'application, il passe hors ligne, c'est fini, pas de notification. »
--
--  * App ouverte (premier plan, arrière-plan, téléphone verrouillé) : l'app envoie sa position en continu
--    et, faute de point GPS, un signe de vie (public.driver_heartbeat) ; le chauffeur reste en ligne.
--  * App fermée (balayée, arrêtée par le système) : plus rien n'arrive → après 3 min sans position ni signe
--    de vie, passage HORS LIGNE silencieux (private.watch_driver_gps, worker toutes les 30 s), ses offres en
--    attente sont closes. Aucune notification. Un chauffeur en course n'est jamais touché.
--  * Transition : les anciennes versions de l'app (< 1.1.0, sans battement ni signe de vie) gardent l'ancien
--    délai de 15 min, sinon un iPhone immobile serait mis hors ligne à tort avant la mise à jour.
--  * Fraîcheur de position au moins 2 min (battement ≈ 1 min) : un réglage plus bas écarterait les chauffeurs
--    entre deux envois.
--  * Fin des réveils silencieux « location_ping » et de l'alerte « POSITION NON REÇUE » (003300) ; les
--    marqueurs gps_ping_at / gps_lost_notified_at sont supprimés.
-- =============================================================================

-- ----------------------------------------------------------------- fenêtre de position fraîche : 2 min au moins
-- Dernière définition : 20260924003300.
create or replace function private.dispatch_location_window(p_max_age_seconds integer)
returns interval
language sql
immutable
set search_path = ''
as $$
  select make_interval(secs => greatest(coalesce(p_max_age_seconds, 180), 120));
$$;

-- Version d'app au moins égale (« 1.1.0 » >= {1,1,0}) ; version absente ou illisible : faux
create or replace function private.app_version_at_least(p_version text, p_min integer[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce((
    select array_agg(coalesce(nullif(x, '')::integer, 0) order by i)
    from unnest(string_to_array(regexp_replace(coalesce(p_version, ''), '[^0-9.]', '', 'g'), '.')) with ordinality as t(x, i)
  ) >= p_min, false);
$$;

-- ----------------------------------------------------------------- signe de vie de l'app (sans position)
create or replace function public.driver_heartbeat()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d record;
begin
  select x.id, x.presence, x.last_seen_at into d from public.drivers x where x.id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  if d.last_seen_at is null or d.last_seen_at < now() - interval '30 seconds' then
    update public.drivers set last_seen_at = now() where id = d.id;
  end if;
  return jsonb_build_object('ok', true, 'presence', d.presence);
end;
$$;

-- ----------------------------------------------------------------- app fermée → hors ligne (silencieux)
-- Dernière définition : 20260924003300. Même effet que driver_set_online(false), sans notification.
create or replace function private.watch_driver_gps()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  x record;
  v_offline integer := 0;
begin
  perform private.set_actor('system', null);
  for x in
    select d.id, d.organization_id, d.first_name, d.number
    from public.drivers d
    left join public.driver_locations l on l.driver_id = d.id
    where d.presence in ('available', 'offered')
      and d.current_ride_id is null
      -- dernier signe de l'app : position, signe de vie, ou passage en ligne ; 3 min (app ≥ 1.1.0, battement)
      -- ou 15 min (anciennes versions, pas de battement : l'ancien délai du ménage)
      and coalesce(greatest(l.updated_at, d.last_seen_at, d.online_since), '-infinity') < now() - case
            when private.app_version_at_least((
                   select dv.app_version from public.driver_devices dv
                   where dv.driver_id = d.id and dv.revoked_at is null
                   order by dv.last_seen_at desc limit 1), '{1,1,0}')
            then interval '3 minutes' else interval '15 minutes' end
    order by d.id
    for update of d skip locked
  loop
    update public.ride_offers
       set status = 'expired', closed_reason = 'driver_offline', responded_at = now()
     where driver_id = x.id and status = 'pending' and mode = 'geo';
    update public.drivers set presence = 'offline', online_since = null where id = x.id;
    perform private.log_event(x.organization_id, null, 'driver.offline',
      format('%s (#%s) est hors ligne (application fermée)', x.first_name, x.number),
      'system', 'info', jsonb_build_object('driver_id', x.id, 'reason', 'app_closed'), 'system', null);
    v_offline := v_offline + 1;
  end loop;
  return jsonb_build_object('offline', v_offline);
end;
$$;

-- Réveils et alertes de 003300 abandonnés : réveils encore en file annulés, marqueurs supprimés
update public.notifications
   set status = 'cancelled', last_error = 'wake_abandoned'
 where type in ('location_ping', 'gps_lost') and status = 'queued';

alter table public.drivers drop column if exists gps_ping_at;
alter table public.drivers drop column if exists gps_lost_notified_at;

-- Droits d'exécution (deny-by-default, cf. 20260924000900)
revoke execute on function public.driver_heartbeat() from public, anon;
grant execute on function public.driver_heartbeat() to authenticated, service_role;
revoke execute on function private.app_version_at_least(text, integer[]) from public, anon, authenticated;
grant execute on function private.app_version_at_least(text, integer[]) to service_role;
