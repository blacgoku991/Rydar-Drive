-- =============================================================================
-- Rydar Drive — Conformité : purges de conservation qui ne demandent aucune décision du propriétaire
-- (scratchpad conformite-drive/sql-a-faire.md, points 1 à 3 ; les durées à décider — justificatifs refusés ou
-- remplacés, coordonnées des clients, candidatures, durées sans fin — ne sont PAS ici).
--
--  1. Sessions d'authentification (auth.sessions : adresse IP, navigateur) inactives depuis plus de 400 jours, durée
--     maximale du cookie de session : supprimées par le ménage horaire, avec leurs jetons de rafraîchissement
--     (politique de confidentialité § 9 : « … et 400 jours au plus sans utilisation »).
--  2. Dernière adresse IP d'utilisation d'une clé d'API (api_keys.last_used_ip) : effacée 90 jours après la dernière
--     utilisation, comme les journaux d'appels (§ 9).
--  3. Justificatifs « Visite médicale » (donnée de santé, art. 9 RGPD) : plus aucun ajout ni changement de type vers
--     « medical », par aucune voie (déclencheur ; le dépôt par l'application est refusé depuis 004300 et le tableau de
--     bord ne le propose plus), plus aucun rappel d'échéance. Les justificatifs déjà enregistrés en production se
--     purgent fichiers compris (Storage puis lignes), après contrôle : select count(*) from public.driver_documents
--     where type = 'medical' (voir le compte rendu du lot 7).
--
-- Comportement inchangé sinon : réponse de private.housekeeping complétée de deux compteurs (api_key_ips_purged,
-- auth_sessions_purged) ; aucune autre ligne touchée. Supabase hébergé : DML seulement sur auth.sessions (comme
-- auth.audit_log_entries), rien sur storage.*.
-- =============================================================================

-- =============================================================================
-- 1 et 2. Ménage : sessions Auth et adresses IP des clés d'API
-- =============================================================================
-- Dernière définition : 20260924007000_shared_network_access.sql (corps 20260924006600 et ajouts réseau gardés À
-- L'IDENTIQUE). Conformité, seuls ajouts : dernière adresse IP d'une clé d'API (90 jours), sessions Auth inactives
-- depuis 400 jours (passage horaire, avec le journal d'audit d'Auth), deux compteurs dans la réponse.
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
  -- Conformité (RGPD)
  v_api_ips integer;
  v_sessions integer;
  v_expired integer;
  v_fee_changes integer;
  v_reductions integer;
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
  -- Réseau partagé (Q5, §11.6, S8) : points GPS d'une course partenaire (ride_org_id, invisibles pour l'organisation du
  -- chauffeur) 1 h après la fin de son exécution pour ce chauffeur (private.network_ended_traces) ; comptés avec
  -- l'historique purgé (réponse inchangée)
  delete from public.driver_location_history h
   using private.network_ended_traces() n
   where h.ride_id = n.ride_id and h.driver_id = n.driver_id and h.ride_org_id is not null;
  get diagnostics v_count = row_count;
  v_history := v_history + v_count;
  delete from public.api_logs where created_at < now() - interval '90 days';
  get diagnostics v_logs = row_count;
  -- Conformité (RGPD, art. 5.1.c et 5.1.e) : dernière adresse IP d'une clé d'API effacée 90 jours après sa dernière
  -- utilisation, comme les journaux d'appels (la clé et sa date d'utilisation restent ; colonne hors du journal d'audit)
  update public.api_keys
     set last_used_ip = null
   where last_used_ip is not null
     and coalesce(last_used_at, created_at) < now() - interval '90 days';
  get diagnostics v_api_ips = row_count;
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
  -- Réseau partagé : rappels et notifications de vol du chauffeur partenaire (adresse, n° de vol), même délai ; comptés
  -- avec les notifications purgées
  delete from public.notifications x
   using private.network_ended_traces() n
   where x.ride_id = n.ride_id and x.driver_id = n.driver_id and x.driver_org_id <> x.organization_id
     and x.type in ('ride_reminder', 'flight_update');
  get diagnostics v_count = row_count;
  v_notifs := v_notifs + v_count;
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
  -- Réseau partagé : empreintes d'un chauffeur partenaire supprimé, plus rien d'ouvert envers CETTE organisation
  -- créancière (comptées avec les précédentes : réponse inchangée)
  delete from private.network_debtor_identities n
   where not exists (
     select 1 from public.ride_settlements s
      where s.organization_id = n.creditor_org_id and s.network_driver_id = n.driver_id
        and s.network_driver_org_id is not null and s.direction = 'driver_owes'
        and s.status in ('due', 'declared', 'disputed') and s.amount_cents > 0);
  get diagnostics v_count = row_count;
  v_debtors := v_debtors + v_count;
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
    -- Conformité (RGPD, art. 5.1.e) : sessions Auth inactives depuis plus de 400 jours (durée maximale du cookie de
    -- session) supprimées avec leur adresse IP et leur navigateur ; leurs jetons de rafraîchissement suivent
    -- (auth.refresh_tokens.session_id, on delete cascade). refreshed_at est un « timestamp » sans fuseau (UTC) chez Auth.
    begin
      v_sessions := 0;
      if to_regclass('auth.sessions') is not null then
        delete from auth.sessions s
         where coalesce(s.refreshed_at::timestamptz, s.updated_at, s.created_at) < now() - interval '400 days';
        get diagnostics v_sessions = row_count;
      end if;
    exception when others then
      v_sessions := null;
      v_errors := v_errors || jsonb_build_object('auth_sessions', left(sqlerrm, 300));
    end;
  end if;

  -- Frais Rydar (20260924006600) : baisses en attente depuis 30 jours sans décision du super admin acceptées (CGV
  -- art. 5)
  begin
    v_reductions := private.accept_stale_platform_reductions();
  exception when others then
    v_reductions := null;
    v_errors := v_errors || jsonb_build_object('platform_reductions', left(sqlerrm, 300));
  end;
  -- Hausses annoncées arrivées à leur date d'effet, EN DERNIER : le verrou de l'organisation (UPDATE des taux) est gardé
  -- jusqu'à la fin de la transaction, et la création d'une course de l'organisation l'attend
  begin
    v_fee_changes := private.apply_platform_fee_changes();
  exception when others then
    v_fee_changes := null;
    v_errors := v_errors || jsonb_build_object('platform_fee_changes', left(sqlerrm, 300));
  end;

  return jsonb_build_object('rides_expired', v_expired, 'platform_fee_changes_applied', v_fee_changes,
    'platform_reductions_accepted', v_reductions,
    'history_purged', v_history, 'api_logs_purged', v_logs,
    'documents_expired', v_docs, 'notifications_purged', v_notifs, 'chat_purged', v_chat,
    'fleet_events_purged', v_fleet, 'audit_network_purged', v_network, 'rides_purged', v_rides,
    'bans_purged', v_bans, 'alert_positions_purged', v_alert_positions, 'debtor_identities_purged', v_debtors,
    'auth_audit_purged', v_auth,
    -- Conformité (RGPD) : NULL hors du passage horaire (comme auth_audit_purged)
    'api_key_ips_purged', v_api_ips, 'auth_sessions_purged', v_sessions)
    || case when v_errors = '{}'::jsonb then '{}'::jsonb else jsonb_build_object('errors', v_errors) end;
end;
$$;

-- =============================================================================
-- 3. Justificatifs « Visite médicale » : plus d'ajout, plus de rappel
-- =============================================================================
-- Toute voie d'écriture (RPC, action serveur, droits par colonne du tableau de bord, service role) : un justificatif ne
-- devient jamais « medical ». Les lignes existantes restent modifiables (statut « expiré » du ménage, revue) jusqu'à
-- leur purge.
create or replace function private.driver_documents_no_medical()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'TYPE_NOT_ALLOWED: les justificatifs médicaux ne sont pas acceptés (aucune donnée de santé n''est collectée)'
    using errcode = '22023';
end;
$$;
revoke all on function private.driver_documents_no_medical() from public, anon, authenticated;

create trigger driver_documents_no_medical
  before insert or update of type on public.driver_documents
  for each row
  when (new.type = 'medical')
  execute function private.driver_documents_no_medical();

-- Dernière définition : 20260924005200_medical_reminders.sql. Seul changement : aucune « Visite médicale » dans les
-- rappels (le reste, y compris le passage à « expiré », est inchangé ; droits inchangés).
create or replace function private.document_reminders()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_expired integer := 0;
  v_sent integer := 0;
  v_silent integer := 0;
  v_threshold integer;
  v_marks integer[];
  v_label text;
  v_type text;
  v_title text;
  v_body text;
  v_at timestamptz;
  v_json jsonb;
  v_action text;
  v_renewal boolean;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('rydar.document_reminders', 0)) then
    return jsonb_build_object('skipped', 'already_running');
  end if;
  perform private.set_actor('system', null);

  -- 1) Échéance dépassée (jour J+1 dans le fuseau de l'organisation) → « expired ».
  --    SKIP LOCKED : jamais d'attente (ni d'interblocage avec housekeeping) ; une ligne
  --    sautée est rattrapée au passage suivant, et les rappels ci-dessous la traitent déjà.
  update public.driver_documents x
     set status = 'expired'
   where x.status = 'valid'
     and x.id in (
       select y.id
       from public.driver_documents y
       join public.organizations o on o.id = y.organization_id
       where y.status = 'valid'
         and y.expires_at < (now() at time zone o.timezone)::date
       for update of y skip locked
     );
  get diagnostics v_expired = row_count;

  -- 2) Rappels : le seuil le plus urgent atteint et non encore envoyé
  for r in
    select x as doc,
           x.expires_at - (now() at time zone o.timezone)::date as days_left,
           (now() at time zone o.timezone) as local_now,
           o.timezone as tz,
           dr.first_name, dr.last_name, dr.number as driver_number
    from public.driver_documents x
    join public.organizations o on o.id = x.organization_id
    join public.drivers dr on dr.id = x.driver_id
    where x.status in ('valid', 'expired')
      and x.expires_at is not null
      -- Conformité (RGPD, art. 9) : plus aucun rappel pour une « Visite médicale » (donnée de santé, plus collectée)
      and x.type <> 'medical'
      and o.status = 'active'
      and dr.status = 'active'
      and (
           (x.expires_at - (now() at time zone o.timezone)::date <= 30 and not (30 = any (x.reminders_sent)))
        or (x.expires_at - (now() at time zone o.timezone)::date <= 7 and not (7 = any (x.reminders_sent)))
        or (x.expires_at - (now() at time zone o.timezone)::date <= 0 and not (0 = any (x.reminders_sent)))
      )
    order by x.expires_at, x.id
    for update of x skip locked
  loop
    v_threshold := case when r.days_left <= 0 then 0 when r.days_left <= 7 then 7 else 30 end;
    v_marks := array(select t from unnest(array[30, 7, 0]) as t where t >= v_threshold);

    -- Échu depuis longtemps (import, reprise) ou seuil urgent déjà traité : marqué sans notifier
    if r.days_left < -7 or v_threshold = any ((r.doc).reminders_sent) then
      update public.driver_documents
         set reminders_sent = array(select distinct t from unnest(reminders_sent || v_marks) as t order by t desc)
       where id = (r.doc).id;
      v_silent := v_silent + 1;
      continue;
    end if;

    -- Renouvelé (un document valide plus récent du même type existe) : rien à rappeler
    continue when private.document_superseded(r.doc);

    -- Renouvellement déjà déposé par le chauffeur, en attente de validation par la centrale
    v_renewal := (r.doc).type <> 'other' and exists (
      select 1 from public.driver_documents y
      where y.driver_id = (r.doc).driver_id
        and y.type = (r.doc).type
        and y.status = 'pending'
        and y.id <> (r.doc).id
    );

    v_label := private.document_label((r.doc).type, (r.doc).label);
    if r.days_left < 0 then
      v_type := 'document_expired';
      v_action := 'expired';
      v_title := format('Document expiré : %s', v_label);
      v_body := case when v_renewal
        then format('Échéance dépassée depuis le %s. Votre nouveau document est en cours de validation par la centrale.',
          to_char((r.doc).expires_at, 'DD/MM/YYYY'))
        when (r.doc).type = 'medical'
        then format('Échéance dépassée depuis le %s. Transmettez le nouveau document à votre centrale au plus vite.',
          to_char((r.doc).expires_at, 'DD/MM/YYYY'))
        else format('Échéance dépassée depuis le %s. Déposez le nouveau document au plus vite.',
          to_char((r.doc).expires_at, 'DD/MM/YYYY'))
      end;
    else
      v_type := 'document_expiring';
      v_action := 'expiring';
      v_title := case
        when r.days_left = 0 then format('%s expire aujourd''hui', v_label)
        when r.days_left = 1 then format('%s expire demain', v_label)
        else format('%s expire dans %s jours', v_label, r.days_left)
      end;
      v_body := case when v_renewal
        then format('Échéance le %s. Votre nouveau document est en cours de validation par la centrale.',
          to_char((r.doc).expires_at, 'DD/MM/YYYY'))
        when (r.doc).type = 'medical'
        then format('Échéance le %s. Transmettez le nouveau document à votre centrale.',
          to_char((r.doc).expires_at, 'DD/MM/YYYY'))
        else format('Échéance le %s. Déposez le nouveau document depuis l''application.',
          to_char((r.doc).expires_at, 'DD/MM/YYYY'))
      end;
    end if;

    -- Pas de push nocturne : avant 9 h (heure locale) → envoi programmé à 9 h
    v_at := case when r.local_now::time < time '09:00'
                 then (r.local_now::date + time '09:00') at time zone r.tz
                 else now() end;

    perform private.queue_notification((r.doc).organization_id, (r.doc).driver_id, null, null, v_type, v_title, v_body,
      jsonb_build_object('type', v_type, 'document_id', (r.doc).id, 'document_type', (r.doc).type,
        'expires_at', (r.doc).expires_at, 'days_left', r.days_left, 'threshold', v_threshold,
        'renewal_pending', v_renewal),
      case when v_threshold = 30 or v_renewal then 'normal' else 'high' end, v_at);

    update public.driver_documents
       set reminders_sent = array(select distinct t from unnest(reminders_sent || v_marks) as t order by t desc)
     where id = (r.doc).id;
    v_sent := v_sent + 1;

    -- Centrale : journal à J-7 et à l'échéance, temps réel à chaque rappel
    if v_threshold <= 7 then
      perform private.log_event((r.doc).organization_id, null, 'document.' || v_action,
        case
          when r.days_left < 0 then format('%s de %s %s (#%s) : échéance dépassée depuis le %s', v_label, r.first_name,
            r.last_name, r.driver_number, to_char((r.doc).expires_at, 'DD/MM/YYYY'))
          when r.days_left = 0 then format('%s de %s %s (#%s) : expire aujourd''hui', v_label, r.first_name, r.last_name,
            r.driver_number)
          else format('%s de %s %s (#%s) : expire dans %s %s', v_label, r.first_name, r.last_name, r.driver_number,
            r.days_left, private.pl(r.days_left, 'jour', 'jours'))
        end || case when v_renewal then ' — nouveau document à valider' else '' end,
        'timeline', 'warning',
        jsonb_build_object('driver_id', (r.doc).driver_id, 'document_id', (r.doc).id, 'document_type', (r.doc).type,
          'expires_at', (r.doc).expires_at, 'days_left', r.days_left, 'renewal_pending', v_renewal),
        'system', null);
    end if;

    v_json := private.document_json(r.doc, (r.local_now)::date);
    perform realtime.send(
      jsonb_build_object('action', v_action, 'threshold', v_threshold, 'document', v_json,
        'driver', jsonb_build_object('id', (r.doc).driver_id, 'number', r.driver_number,
          'first_name', r.first_name, 'last_name', r.last_name)),
      'driver.document', 'org:' || (r.doc).organization_id::text, true);
    perform realtime.send(
      jsonb_build_object('action', v_action, 'threshold', v_threshold, 'document', v_json),
      'driver.document', 'driver:' || (r.doc).driver_id::text, true);
  end loop;

  return jsonb_build_object('expired', v_expired, 'reminders', v_sent, 'silent', v_silent);
end;
$$;
