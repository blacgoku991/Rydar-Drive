-- =============================================================================
-- Courses planifiées acceptées mais jamais démarrées : clôture automatique
-- =============================================================================
-- Retour d'essai : une course planifiée acceptée puis jamais démarrée (jamais « En route ») restait « Acceptée » sans
-- fin : dans « Mes courses » (« Hier 06:30 ») et en « Prochaine course » de l'app les jours suivants, toujours
-- démarrable, et « à venir » pour la centrale.
--
-- Désormais, 6 h après l'heure de prise en charge, une course planifiée toujours « Acceptée » est annulée par le
-- système, motif « Non effectuée » (private.cancel_ride_internal : offres closes, rappels annulés, chauffeur libéré et
-- prévenu, événement dans le journal de la course). Avant ce délai, le chauffeur en retard peut encore la démarrer et
-- la centrale la réattribuer ou l'annuler ; l'alerte de retard (private.watch_rides) la signale dès l'heure passée.
-- Une course démarrée (en route, sur place, client à bord) n'est jamais clôturée ainsi : sa fin reste au chauffeur.
-- Heure de prise en charge décalée par le suivi d'un vol (private.apply_flight_status) : le délai part de la
-- nouvelle heure.
--
-- Rattrapage (courses dépassées depuis plus de 24 h : antérieures à cette migration, worker arrêté) : clôturées sans
-- notification au chauffeur, information périmée.
--
-- Appelée par private.housekeeping (worker, toutes les 5 min), par lots de 200 au plus.
-- L'app reprend le délai (UNSTARTED_RIDE_EXPIRY_HOURS, @rydar/shared) pour prévenir le chauffeur.
-- =============================================================================

create or replace function private.expire_unstarted_rides(p_limit integer default 200)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  x record;
  v_res jsonb;
  v_count integer := 0;
begin
  for x in
    select r.id, r.pickup_at
      from public.rides r
     where r.status = 'ACCEPTED'
       and r.driver_id is not null  -- index rides_assigned_active_idx (002200)
       and r.type = 'scheduled'
       and r.pickup_at < now() - interval '6 hours'
     order by r.pickup_at, r.id
     limit greatest(coalesce(p_limit, 200), 1)
     for update skip locked
  loop
    v_res := private.cancel_ride_internal(x.id,
      'Non effectuée : pas démarrée 6 h après l''heure de prise en charge (clôture automatique)', 'system', null);
    continue when not coalesce((v_res ->> 'ok')::boolean, false);
    v_count := v_count + 1;
    -- Chauffeur prévenu d'une course manquée du jour ; rien pour un rattrapage de plus de 24 h
    update public.notifications
       set status = case when x.pickup_at < now() - interval '24 hours' then 'cancelled' else status end,
           title = 'COURSE NON EFFECTUÉE'
     where ride_id = x.id and type = 'ride_cancelled' and status = 'queued';
  end loop;
  return v_count;
end;
$$;

revoke all on function private.expire_unstarted_rides(integer) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------- ménage
-- Dernière définition : 20260924004800_audit_rgpd.sql. Seul ajout : clôture des courses planifiées jamais démarrées
-- (private.expire_unstarted_rides, compteur « rides_expired », erreur isolée comme les purges).
create or replace function private.housekeeping()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_history integer;
  v_logs integer;
  v_docs integer;
  v_notifs integer;
  v_chat integer;
  v_fleet integer;
  v_network integer;
  v_alert_positions integer;
  v_debtors integer;
  v_auth integer;
  v_expired integer;
  v_rides integer := 0;
  v_count integer;
  v_org uuid;
  v_rides_before timestamptz := date_trunc('year', now() - interval '10 years');
  v_bans jsonb;
  v_errors jsonb := '{}'::jsonb;
begin
  -- Le ménage ne met jamais un chauffeur hors ligne : application fermée, c'est private.watch_driver_gps qui s'en
  -- charge (20260924003400).

  -- Courses planifiées acceptées jamais démarrées, 6 h après l'heure de prise en charge : clôturées (005900). Un
  -- échec est journalisé par le worker et n'empêche pas le reste du ménage ; retenté au passage suivant.
  begin
    v_expired := private.expire_unstarted_rides();
  exception when others then
    v_expired := null;
    v_errors := v_errors || jsonb_build_object('rides_expired', left(sqlerrm, 300));
  end;

  delete from public.driver_location_history where recorded_at < now() - interval '30 days';
  get diagnostics v_history = row_count;
  delete from public.api_logs where created_at < now() - interval '90 days';
  get diagnostics v_logs = row_count;
  -- Échéance au jour LOCAL de l'organisation (comme private.document_reminders), pas au jour UTC du serveur
  update public.driver_documents x
     set status = 'expired'
    from public.organizations o
   where o.id = x.organization_id
     and x.status = 'valid'
     and x.expires_at < (now() at time zone coalesce(o.timezone, 'Europe/Paris'))::date;
  get diagnostics v_docs = row_count;
  -- Notifications : 90 jours après leur envoi prévu, quel que soit leur statut ; réveils silencieux : un jour
  delete from public.notifications
   where greatest(created_at, scheduled_for) < now() - interval '90 days'
      or (type = 'location_ping' and created_at < now() - interval '1 day');
  get diagnostics v_notifs = row_count;
  delete from public.chat_messages where created_at < now() - interval '180 days';
  get diagnostics v_chat = row_count;
  -- Signalements de la flotte recopiés dans le journal de la centrale : même durée que les messages
  delete from public.ride_events
   where type in ('fleet.report', 'fleet.report_cleared') and created_at < now() - interval '180 days';
  get diagnostics v_fleet = row_count;
  -- Journal d'audit : adresse IP et navigateur effacés au bout d'un an (l'action reste tracée)
  update public.audit_logs set ip = null, user_agent = null
   where (ip is not null or user_agent is not null) and created_at < now() - interval '1 year';
  get diagnostics v_network = row_count;
  -- Position du chauffeur relevée par une alerte (immobile, GPS muet) : 30 jours. Alerte encore ouverte : sa
  -- position est celle du moment, retirée une fois l'alerte close.
  with batch as (
    select a.id from public.ride_alerts a
     where a.status <> 'open' and (a.data ? 'lat' or a.data ? 'lng') and a.created_at < now() - interval '30 days'
     order by a.created_at
     limit 500
  )
  update public.ride_alerts a
     set data = a.data - array['lat', 'lng']
    from batch b
   where a.id = b.id;
  get diagnostics v_alert_positions = row_count;
  update public.ride_events e
     set data = e.data - array['lat', 'lng']
   where e.type in ('alert.stalled', 'alert.no_gps') and (e.data ? 'lat' or e.data ? 'lng')
     and e.created_at < now() - interval '30 days';
  get diagnostics v_count = row_count;
  v_alert_positions := v_alert_positions + v_count;
  -- Empreintes d'un chauffeur supprimé qui devait des commissions : plus de dette ouverte, plus d'empreinte
  delete from private.debtor_identities x
   where not exists (
     select 1 from public.ride_settlements s
      where s.driver_id = x.driver_id and s.direction = 'driver_owes'
        and s.status in ('due', 'declared', 'disputed') and s.amount_cents > 0);
  get diagnostics v_debtors = row_count;
  -- Courses : 10 ans après la fin de l'année de la prise en charge, quel que soit leur statut. Par centrale (index
  -- organization_id, pickup_at).
  -- Purges longues ou hors de nos tables (courses, bannissements, journal Auth) : un échec est journalisé par le
  -- worker et n'empêche pas le reste du ménage ; elles sont retentées au passage suivant.
  begin
    for v_org in select o.id from public.organizations o loop
      delete from public.rides r
       where r.organization_id = v_org and r.pickup_at < v_rides_before;
      get diagnostics v_count = row_count;
      v_rides := v_rides + v_count;
    end loop;
  exception when others then
    v_rides := 0;
    v_errors := v_errors || jsonb_build_object('rides', left(sqlerrm, 300));
  end;
  begin
    v_bans := private.purge_expired_bans();
  exception when others then
    v_errors := v_errors || jsonb_build_object('bans', left(sqlerrm, 300));
  end;
  -- Journal d'audit de Supabase Auth : 1 an ; une fois par heure au plus (parcours complet de la table)
  if not exists (select 1 from private.housekeeping_runs h
                  where h.task = 'auth_audit' and h.last_run_at > now() - interval '1 hour') then
    insert into private.housekeeping_runs (task, last_run_at) values ('auth_audit', now())
    on conflict (task) do update set last_run_at = excluded.last_run_at;
    begin
      v_auth := 0;
      if to_regclass('auth.audit_log_entries') is not null then
        delete from auth.audit_log_entries a where a.created_at < now() - interval '1 year';
        get diagnostics v_auth = row_count;
      end if;
    exception when others then
      v_auth := null;
      v_errors := v_errors || jsonb_build_object('auth_audit', left(sqlerrm, 300));
    end;
  end if;

  return jsonb_build_object('rides_expired', v_expired, 'history_purged', v_history, 'api_logs_purged', v_logs,
    'documents_expired', v_docs, 'notifications_purged', v_notifs, 'chat_purged', v_chat,
    'fleet_events_purged', v_fleet, 'audit_network_purged', v_network, 'rides_purged', v_rides,
    'bans_purged', v_bans, 'alert_positions_purged', v_alert_positions, 'debtor_identities_purged', v_debtors,
    'auth_audit_purged', v_auth)
    || case when v_errors = '{}'::jsonb then '{}'::jsonb else jsonb_build_object('errors', v_errors) end;
end;
$$;

revoke execute on function private.housekeeping() from public, anon, authenticated;
grant execute on function private.housekeeping() to service_role;
