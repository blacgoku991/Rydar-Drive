-- =============================================================================
-- Rydar Drive — Audit qualité / sécurité (octobre 2026) : corrections en base
--
-- Placée entre 20260924006600 et le chantier « réseau partagé » (20260924006700 → 007200) : celui-ci devra repartir
-- des définitions ci-dessous pour toute fonction qu'il redéfinit aussi.
--
-- FONCTIONS REDÉFINIES (repartir d'ici) :
--   public.remind_driver_settlements(uuid, text[])            (003700) relances d'un chauffeur sérialisées
--   public.accept_legal_documents(text[], text, uuid, text)    (004300) 50 versions au plus par compte
--   public.driver_register_device(…)                           (004300) 20 nouvelles installations / 24 h
--   private.housekeeping()                                     (006600) dernière position purgée après 30 jours
--   public.assign_ride(uuid, uuid)                             (006600) chauffeur bloqué refusé (DRIVER_BLOCKED)
--   public.accept_ride_offer(uuid)                             (005400) acceptation rejouée = succès
--   private.fraud_report_carriers(uuid)                        (005400) plaque seule ≠ même centrale d'office
--   public.svc_platform_ban(uuid, uuid, text, uuid[])          (004600) courses, client à bord, signalement périmé
--   public.svc_platform_unban(uuid, uuid, text)                (004600) signalements qui se recoupent
--   public.lift_driver_ban(uuid, text)                         (002600) signalement ouvert classé
--   private.org_terms_notified(uuid, text)                     (006600) annonce en échec ≠ prévenue
--   public.svc_org_terms_notify(uuid, text, date, text)        (006600) version liée à l'e-mail, renvoi si échec
--   private.apply_platform_fee_changes(integer)                (006600) annonce des CGV partie 30 jours avant
--   private.dispatch_tick(integer)                             (003300) organisations non actives ignorées, lots
--   public.svc_platform_terms(…, p_consent_note)               (006600) SIGNATURE CHANGÉE : accord écrit
--   public.admin_centrale_overview(timestamptz)                (003100) frais du mois = registre
--   private.claim_notifications(integer)                       (003300) offres GPS d'abord
--   private.run_geo_wave(uuid)                                 (003200) positions de la centrale seulement
-- NOUVELLES : private.platform_unassign_ride(uuid, text, uuid), public.svc_platform_set_org_status(uuid, uuid, text, text)
-- POLITIQUES / DROITS : drivers (DELETE retiré, UPDATE status / suspended_reason retiré), driver_documents (insertion
--   seule, règles de l'action serveur), rides_select (chauffeur : 24 h après la fin), audit_logs_select (lignes du
--   super admin masquées aux centrales), storage.objects (écriture directe des membres retirée, SVG refusé).
-- INDEX : driver_location_history (BRIN recorded_at), api_logs (created_at), webhook_deliveries_due_idx supprimé.
-- COLONNE : email_outbox.org_terms_version (annonce des CGV liée à sa version).
-- =============================================================================

-- ----------------------------------------------------------------- 1. fiches chauffeur et justificatifs (sql-rls-1, -3, -4)
-- Une fiche n'est jamais supprimée par l'API (DELETE /rest/v1/drivers contournait svc_admin_delete_driver /
-- delete_driver_account : ni purge des justificatifs, ni empreintes de dette, journal en clair, course orpheline).
drop policy if exists drivers_delete on public.drivers;
revoke delete on public.drivers from anon, authenticated;
-- Statut : seulement par set_driver_status / ban_driver / approve_driver_application (client à bord refusé, courses
-- remises en recherche, offres fermées) ; trust_level reste modifiable (owner / admin, garde-fou existant).
revoke update (status, suspended_reason) on public.drivers from authenticated;
-- Justificatifs : plus de modification ni de suppression directes (validation = review_driver_document) ; ajout
-- direct (« Ajouter un document » du tableau de bord) aux mêmes règles que l'action serveur.
drop policy if exists driver_documents_write on public.driver_documents;
drop policy if exists driver_documents_insert on public.driver_documents;
revoke update, delete on public.driver_documents from anon, authenticated;
create policy driver_documents_insert on public.driver_documents for insert to authenticated
  with check (
    organization_id in (select private.member_org_ids())
    and status = 'valid'
    and (type::text not in ('vtc_card', 'driving_license', 'insurance', 'identity') or expires_at is not null)
    and (expires_at is null or expires_at >= (select (now() at time zone coalesce(o.timezone, 'Europe/Paris'))::date
                                              from public.organizations o where o.id = organization_id))
    and (file_path is null or file_path like organization_id::text || '/' || driver_id::text || '/%')
  );

-- ----------------------------------------------------------------- 2. stockage (sql-rls-2, web-securite-3)
-- Le web n'écrit jamais dans le stockage (URL signées, purge par la clé service) ; l'app chauffeur dépose ses
-- justificatifs par sa propre politique (rydar_storage_driver_upload_documents). Les politiques génériques laissaient
-- tout membre (dispatcher compris) écraser ou supprimer un justificatif validé et publier des fichiers (SVG scripté).
do $$
begin
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists rydar_storage_write on storage.objects';
    execute 'drop policy if exists rydar_storage_update on storage.objects';
    execute 'drop policy if exists rydar_storage_delete on storage.objects';
  end if;
  if to_regclass('storage.buckets') is not null then
    update storage.buckets set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'] where id = 'org-assets';
  end if;
end;
$$;

-- ----------------------------------------------------------------- 3. lectures (sql-rls-8, super-admin-8)
-- Chauffeur : ses courses en cours, et les terminées / annulées pendant 24 h (écran de fin, annulation notifiée) ;
-- plus l'extraction en masse des coordonnées des clients de toutes ses courses passées.
drop policy if exists rides_select on public.rides;
create policy rides_select on public.rides for select to authenticated
  using (
    organization_id in (select private.member_org_ids())
    or (driver_id is not null and driver_id = (select private.current_driver_id())
        and (status not in ('COMPLETED', 'CANCELLED', 'NO_DRIVER_FOUND') or updated_at > now() - interval '24 hours'))
    or (select private.is_super_admin())
  );
-- Journal : les lignes écrites par le super admin (adresse IP, navigateur, comptes d'autres centrales) ne sont plus
-- lisibles par la centrale ; le super admin lit tout.
drop policy if exists audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (
    (organization_id in (select private.admin_org_ids()) and actor_type is distinct from 'super_admin')
    or (select private.is_super_admin())
  );

-- ----------------------------------------------------------------- 4. relance manuelle des commissions (sql-rls-5)
-- Dernière définition : 20260924003700_whatsapp_reminders. Seul ajout : relances d'un même chauffeur sérialisées (verrou consultatif pris AVANT la lecture de
-- last_reminded_at) : deux appels simultanés n'envoient plus deux relances (push et WhatsApp facturé).
create or replace function public.remind_driver_settlements(p_driver_id uuid, p_channels text[] default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_total integer;
  v_n integer;
  v_ids uuid[];
  v_last timestamptz;
  v_name text;
  v_channels text[];
  v_res jsonb;
  v_label text;
  v_note text;
begin
  select * into d from public.drivers where id = p_driver_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Chauffeur introuvable.');
  end if;
  perform private.assert_org_member(d.organization_id);
  perform pg_advisory_xact_lock(hashtextextended('rydar.settlement_remind:' || d.id::text, 0));
  if p_channels is not null
     and (cardinality(p_channels) not between 1 and 2 or not p_channels <@ array['app', 'whatsapp']::text[]) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CHANNELS', 'message', 'Canal de relance invalide.');
  end if;
  perform private.set_actor('user', auth.uid());

  select coalesce(sum(x.amount_cents), 0), count(*), coalesce(array_agg(x.id), '{}'), max(x.last_reminded_at)
    into v_total, v_n, v_ids, v_last
  from public.ride_settlements x
  where x.driver_id = d.id and x.direction = 'driver_owes' and x.status in ('due', 'disputed');
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'code', 'NOTHING_DUE', 'message', 'Aucune commission à régler pour ce chauffeur.');
  end if;
  if v_last > now() - interval '30 minutes' then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED', 'message', 'Rappel déjà envoyé il y a moins de 30 minutes.');
  end if;

  select o.name, coalesce(p_channels, s.reminder_channels, '{app}')
    into v_name, v_channels
  from public.organizations o
  left join public.organization_settings s on s.organization_id = o.id
  where o.id = d.organization_id;

  v_res := private.remind_driver(d.organization_id, d.id, v_channels, 'settlement_reminder', 'RAPPEL COMMISSION',
    format('%s à régler à %s (%s %s)', private.fmt_eur(v_total), v_name, v_n, private.pl(v_n, 'course', 'courses')),
    jsonb_build_object('type', 'settlement_reminder', 'amount_cents', v_total, 'count', v_n),
    array[d.first_name, private.fmt_eur(v_total), v_name, format('%s %s', v_n, private.pl(v_n, 'course', 'courses'))]);
  v_label := private.channels_label(v_res -> 'channels');
  v_note := case v_res ->> 'whatsapp_error'
    when 'NOT_CONFIGURED' then ' (WhatsApp non configuré)'
    when 'INVALID_PHONE' then ' (numéro du chauffeur invalide pour WhatsApp)'
    else '' end;

  update public.ride_settlements
     set last_reminded_at = now(), reminders_sent = reminders_sent + 1
   where id = any (v_ids);
  perform private.log_event(d.organization_id, null, 'settlement.reminded',
    format('Rappel envoyé %s à %s %s (#%s) : %s à régler%s', v_label, d.first_name, d.last_name, d.number, private.fmt_eur(v_total), v_note),
    'timeline', 'info',
    jsonb_build_object('driver_id', d.id, 'amount_cents', v_total, 'count', v_n, 'channels', v_res -> 'channels',
      'whatsapp_error', v_res -> 'whatsapp_error'),
    'user', auth.uid());
  return jsonb_build_object('ok', true, 'code', 'REMINDED', 'amount_cents', v_total, 'count', v_n,
    'channels', v_res -> 'channels', 'whatsapp_error', v_res -> 'whatsapp_error',
    'message', format('Rappel envoyé %s%s.', v_label, v_note));
end;
$$;

revoke execute on function public.remind_driver_settlements(uuid, text[]) from public, anon;
grant execute on function public.remind_driver_settlements(uuid, text[]) to authenticated, service_role;

-- ----------------------------------------------------------------- 5. insertions bornées (sql-rls-6)
-- Dernière définition : 20260924004300_audit_droits. Seul ajout : au plus 50 versions distinctes par compte
-- (lignes jamais effacées : preuve) ; une version déjà acceptée reste acceptable (idempotent).
create or replace function public.accept_legal_documents(p_documents text[], p_version text, p_org uuid default null, p_source text default 'web')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_version text := left(nullif(btrim(coalesce(p_version, '')), ''), 40);
  v_date date;
begin
  if v_uid is null then
    raise exception 'FORBIDDEN: connexion requise' using errcode = '42501';
  end if;
  if v_version is null or coalesce(cardinality(p_documents), 0) = 0
     or not p_documents <@ array['cgu', 'privacy', 'cgv', 'dpa']::text[] then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'message', 'Documents à accepter invalides.');
  end if;
  if v_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    begin
      v_date := v_version::date;
    exception when others then
      v_date := null;
    end;
  end if;
  if v_date is null or v_date > (now() at time zone 'Europe/Paris')::date + 1 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_VERSION', 'message', 'Version des documents invalide.');
  end if;
  if (p_documents && array['cgv', 'dpa']::text[]) then
    if p_org is null then
      return jsonb_build_object('ok', false, 'code', 'ORG_REQUIRED', 'message', 'Centrale manquante.');
    end if;
    perform private.assert_org_member(p_org, array['owner', 'admin']::public.org_role[]);
  elsif p_org is not null then
    perform private.assert_org_member(p_org);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('rydar.legal_accept:' || v_uid::text, 0));
  if not exists (select 1 from public.legal_acceptances a where a.user_id = v_uid and a.version = v_version)
     and (select count(distinct a.version) from public.legal_acceptances a where a.user_id = v_uid) >= 50 then
    return jsonb_build_object('ok', false, 'code', 'TOO_MANY_VERSIONS',
      'message', 'Trop de versions acceptées pour ce compte : contactez le support.');
  end if;
  -- Idempotent, même en cas d'appels simultanés (double clic, deux onglets) : l'index unique garde la première
  -- acceptation (même personne, centrale, document et version) et sa date
  insert into public.legal_acceptances (user_id, organization_id, document, version, source)
  select v_uid, p_org, d.document, v_version, case when p_source in ('web', 'app') then p_source else 'web' end
  from (select distinct x as document from unnest(p_documents) x) d
  on conflict do nothing;
  return jsonb_build_object('ok', true, 'code', 'ACCEPTED', 'message', 'Conditions acceptées.');
end;
$$;

-- Dernière définition : 20260924004300_audit_droits. Seul ajout : au plus 20 NOUVELLES installations par
-- 24 h et par chauffeur (une ligne par installation, jamais purgée) ; une installation connue reste acceptée.
create or replace function public.driver_register_device(
  p_installation_id text,
  p_platform public.device_platform,
  p_push_token text default null,
  p_provider public.push_provider default 'expo',
  p_device_name text default null,
  p_os_version text default null,
  p_app_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d record;
  v_device uuid;
  v_token uuid;
begin
  select x.id, x.organization_id into d from public.drivers x where x.id = private.current_driver_or_applicant_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  if p_installation_id is null or char_length(p_installation_id) not between 8 and 128 then
    raise exception 'INVALID_INSTALLATION_ID' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('rydar.driver_device:' || d.id::text, 0));
  if not exists (select 1 from public.driver_devices x where x.driver_id = d.id and x.installation_id = p_installation_id)
     and (select count(*) from public.driver_devices x where x.driver_id = d.id and x.created_at > now() - interval '1 day') >= 20 then
    return jsonb_build_object('ok', false, 'code', 'TOO_MANY_DEVICES',
      'message', 'Trop d''appareils enregistrés aujourd''hui pour ce compte : réessayez demain.');
  end if;

  insert into public.driver_devices (organization_id, driver_id, installation_id, platform, device_name, os_version, app_version, last_seen_at)
  values (d.organization_id, d.id, p_installation_id, p_platform, left(p_device_name, 120), left(p_os_version, 40), left(p_app_version, 40), now())
  on conflict (driver_id, installation_id) do update
    set platform = excluded.platform,
        device_name = excluded.device_name,
        os_version = excluded.os_version,
        app_version = excluded.app_version,
        last_seen_at = now(),
        revoked_at = null
  returning id into v_device;

  -- Au plus 10 appareils actifs par chauffeur (les plus récemment vus)
  update public.driver_devices x
     set revoked_at = now()
   where x.driver_id = d.id and x.revoked_at is null
     and x.id not in (select y.id from public.driver_devices y
                       where y.driver_id = d.id and y.revoked_at is null
                       order by (y.id = v_device) desc, y.last_seen_at desc, y.id
                       limit 10);

  if p_push_token is not null and char_length(p_push_token) between 10 and 512 then
    -- Téléphone partagé : le jeton suit l'appareil. Il ne quitte un autre compte que si ce compte l'a enregistré
    -- depuis la même installation (identifiant stable de l'appareil) ; jamais depuis un autre appareil.
    delete from public.push_tokens t
     where t.token = p_push_token and t.driver_id <> d.id
       and exists (select 1 from public.driver_devices dd
                    where dd.id = t.device_id and dd.installation_id = p_installation_id);
    if not exists (select 1 from public.push_tokens t where t.token = p_push_token and t.driver_id <> d.id) then
      update public.push_tokens set is_active = false
       where device_id = v_device and token <> p_push_token and is_active;
      insert into public.push_tokens (organization_id, driver_id, device_id, token, provider, platform, is_active)
      values (d.organization_id, d.id, v_device, p_push_token, p_provider, p_platform, true)
      on conflict (token) do update
        set device_id = excluded.device_id,
            provider = excluded.provider,
            platform = excluded.platform,
            is_active = true,
            last_error = null
      returning id into v_token;

      -- Au plus 5 jetons actifs par chauffeur (les plus récents) : une notification ne part pas vers des milliers
      update public.push_tokens x
         set is_active = false
       where x.driver_id = d.id and x.is_active
         and x.id not in (select y.id from public.push_tokens y
                           where y.driver_id = d.id and y.is_active
                           order by (y.id = v_token) desc, y.updated_at desc, y.id
                           limit 5);
    end if;
  end if;

  return jsonb_build_object('ok', true, 'device_id', v_device, 'push', v_token is not null);
end;
$$;

-- ----------------------------------------------------------------- 6. conservation et ménage (sql-rls-7, worker-perf-8)
-- Dernière définition : 20260924006600_platform_fee_schedule. Seul ajout : dernière position (driver_locations :
-- position, vitesse, batterie) d'un chauffeur qui n'envoie plus rien depuis 30 jours supprimée, comme l'historique
-- (« last_positions_purged ») ; jamais pendant une course.
create or replace function private.housekeeping()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_history integer;
  v_last_positions integer;
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
  delete from public.driver_locations l
   where l.updated_at < now() - interval '30 days'
     and not exists (select 1 from public.drivers d where d.id = l.driver_id and d.current_ride_id is not null);
  get diagnostics v_last_positions = row_count;
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
    'history_purged', v_history, 'last_positions_purged', v_last_positions, 'api_logs_purged', v_logs,
    'documents_expired', v_docs, 'notifications_purged', v_notifs, 'chat_purged', v_chat,
    'fleet_events_purged', v_fleet, 'audit_network_purged', v_network, 'rides_purged', v_rides,
    'bans_purged', v_bans, 'alert_positions_purged', v_alert_positions, 'debtor_identities_purged', v_debtors,
    'auth_audit_purged', v_auth)
    || case when v_errors = '{}'::jsonb then '{}'::jsonb else jsonb_build_object('errors', v_errors) end;
end;
$$;

-- Purges du ménage (toutes les 5 min) sans parcours complet : BRIN (insertions dans l'ordre du temps), btree
create index if not exists driver_location_history_recorded_brin on public.driver_location_history using brin (recorded_at);
create index if not exists api_logs_created_idx on public.api_logs (created_at);

-- ----------------------------------------------------------------- 7. attribution et acceptation (tableau-de-bord-10, app-chauffeur-9)
-- Dernière définition : 20260924006600_platform_fee_schedule. Seul ajout : en centrale, chauffeur bloqué
-- (commission en retard ou contestée, plafond d'encours) ou course au-dessus du plafond « nouveau chauffeur » :
-- refusé (DRIVER_BLOCKED), mêmes règles que l'acceptation d'une offre (private.driver_blocker(…, true)).
create or replace function public.assign_ride(p_ride_id uuid, p_driver_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  d public.drivers;
  v_previous uuid;
  v_closed uuid[];
  v_alerts integer;
  v_tz text;
  v_max bigint;
  v_count bigint;
  v_block text;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_FOUND', 'message', 'Course introuvable.');
  end if;
  perform private.assert_org_member(r.organization_id);
  perform private.set_actor('user', auth.uid());

  select * into d from public.drivers where id = p_driver_id and organization_id = r.organization_id;
  if not found then
    raise exception 'FORBIDDEN_TENANT: chauffeur hors de votre organisation' using errcode = '42501';
  end if;
  if d.status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_INACTIVE', 'message', 'Ce chauffeur n''est pas actif.');
  end if;
  if r.status not in ('CREATED', 'SEARCHING_DRIVER', 'OFFERED', 'NO_DRIVER_FOUND', 'ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED') then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_ASSIGNABLE', 'message', 'Cette course ne peut plus être réattribuée.');
  end if;
  if r.driver_id = d.id then
    return jsonb_build_object('ok', true, 'code', 'UNCHANGED');
  end if;
  v_block := private.driver_blocker(d.id, r.price_cents, true);
  if v_block is not null then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_BLOCKED', 'reason', v_block, 'message', private.fr_typo(case v_block
      when 'unpaid' then 'Chauffeur bloqué : commission en retard ou contestée (menu « Encaissements »).'
      when 'credit_limit' then 'Chauffeur bloqué : plafond de commissions à régler atteint (menu « Encaissements »).'
      when 'new_driver' then 'Course au-dessus du plafond des chauffeurs « Nouveau » : choisissez un chauffeur confirmé.'
      else 'Ce chauffeur ne peut pas recevoir cette course.' end));
  end if;

  select timezone into v_tz from public.organizations where id = r.organization_id;

  -- Course sans chauffeur : l'attribuer = la (re)mettre en service, mêmes règles que la création
  -- (private.rides_platform_block, private.enforce_plan_limits) comptée comme si elle était créée maintenant.
  if r.driver_id is null then
    if exists (select 1 from public.organizations o where o.id = r.organization_id and o.platform_block_after_days is not null)
       and private.platform_blocked(r.organization_id) then
      return jsonb_build_object('ok', false, 'code', 'PLATFORM_FEES_OVERDUE',
        'message', private.fr_typo('Frais plateforme en retard : réglez vos frais Rydar (menu « Frais Rydar » ou « Encaissements ») pour relancer ou attribuer une course.'));
    end if;
    v_max := nullif(coalesce(private.org_limits(r.organization_id), '{}'::jsonb) ->> 'max_rides_per_month', '')::bigint;
    if v_max is not null then
      select count(*) into v_count from public.rides x
      where x.organization_id = r.organization_id
        and x.id <> r.id
        and x.created_at >= date_trunc('month', now() at time zone coalesce(v_tz, 'Europe/Paris')) at time zone coalesce(v_tz, 'Europe/Paris');
      if v_count >= v_max then
        return jsonb_build_object('ok', false, 'code', 'PLAN_LIMIT_RIDES',
          'message', 'Limite mensuelle de courses atteinte pour votre offre.');
      end if;
    end if;
  end if;

  v_previous := r.driver_id;

  if v_previous is not null then
    update public.ride_assignments
       set is_active = false, released_at = now(), release_reason = 'reassigned'
     where ride_id = r.id and is_active;
    perform private.release_driver_ride(v_previous, r.id, true);
    update public.notifications set status = 'cancelled'
     where ride_id = r.id and driver_id = v_previous and status = 'queued';
    perform private.queue_notification(r.organization_id, v_previous, r.id, null, 'ride_unassigned', 'COURSE RETIRÉE',
      format('La centrale a réattribué la course #%s', r.number),
      jsonb_build_object('type', 'ride_unassigned', 'ride_id', r.id), 'high', null);
  end if;

  update public.rides
     set driver_id = d.id, vehicle_id = d.vehicle_id, status = 'ACCEPTED', accepted_at = now(), next_dispatch_at = null,
         driver_en_route_at = null, driver_arrived_at = null
   where id = r.id;

  insert into public.ride_assignments (organization_id, ride_id, driver_id, vehicle_id, method, assigned_by)
  values (r.organization_id, r.id, d.id, d.vehicle_id, 'manual', auth.uid());

  v_closed := private.close_pending_offers(r.id, 'closed', 'manual_assignment');

  if r.type = 'instant' and d.current_ride_id is null then
    update public.drivers set presence = 'en_route', current_ride_id = r.id where id = d.id;
  elsif r.type = 'scheduled' then
    perform private.schedule_reminders(r.id);
  end if;

  perform private.queue_notification(r.organization_id, d.id, r.id, null, 'ride_assigned', 'COURSE ATTRIBUÉE',
    format('#%s · %s · %s → %s', r.number, to_char(r.pickup_at at time zone coalesce(v_tz, 'Europe/Paris'), 'DD/MM HH24:MI'),
      coalesce(private.short_address(r.pickup_address), r.pickup_address),
      coalesce(private.short_address(r.dropoff_address), r.dropoff_address)),
    jsonb_build_object('type', 'ride_assigned', 'ride_id', r.id), 'high', null);

  v_alerts := private.close_ride_alerts(r.id, 'reassigned', auth.uid());

  perform private.log_event(r.organization_id, r.id, 'ride.assigned_manually',
    format('Course attribuée manuellement à %s %s (#%s)', d.first_name, d.last_name, d.number),
    'timeline', 'success',
    jsonb_build_object('driver_id', d.id, 'previous_driver_id', v_previous, 'previous_status', r.status,
      'closed_offers', cardinality(v_closed), 'closed_alerts', v_alerts),
    'user', auth.uid());

  return jsonb_build_object('ok', true, 'code', 'ASSIGNED', 'ride_id', r.id);
end;
$$;

-- Dernière définition : 20260924005400_contre_audit_sql. Seul ajout : acceptation rejouée par le même
-- chauffeur (réponse perdue, double appui notification + écran) : succès idempotent, pas « Course déjà attribuée. ».
create or replace function public.accept_ride_offer(p_offer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_driver public.drivers;
  o public.ride_offers;
  r public.rides;
  v_closed uuid[];
  v_latency bigint;
  v_block text;
  v_code text;
begin
  select d.* into v_driver from public.drivers d where d.id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  perform private.set_actor('driver', v_driver.id);

  select * into o from public.ride_offers where id = p_offer_id and driver_id = v_driver.id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'OFFER_NOT_FOUND', 'message', 'Offre introuvable.');
  end if;

  -- Point de sérialisation : verrou exclusif sur la ligne de la course.
  select * into r from public.rides where id = o.ride_id for update;
  -- Relecture sous verrou : l'offre a pu être retirée entre-temps (hors ligne, fin de recherche…)
  select * into o from public.ride_offers where id = p_offer_id for update;
  v_latency := (extract(epoch from (clock_timestamp() - o.sent_at)) * 1000)::bigint;

  if o.status = 'accepted' and r.driver_id = v_driver.id then
    return jsonb_build_object('ok', true, 'code', 'ACCEPTED', 'message', 'Course attribuée.', 'ride_id', r.id);
  end if;

  if r.driver_id is not null or r.status not in ('SEARCHING_DRIVER', 'OFFERED') then
    -- Motif réel : annulée ; recherche terminée (aucun chauffeur, course retirée en attente d'attribution) ;
    -- sinon attribuée à un autre chauffeur.
    v_code := case
      when r.status = 'CANCELLED' then 'RIDE_CANCELLED'
      when r.driver_id is null then 'SEARCH_ENDED'
      else 'RIDE_ALREADY_ASSIGNED'
    end;
    if o.status = 'pending' then
      update public.ride_offers
         set status = 'closed',
             closed_reason = case v_code
               when 'RIDE_CANCELLED' then 'ride_cancelled'
               when 'SEARCH_ENDED' then 'search_ended'
               else 'already_assigned'
             end,
             responded_at = now()
       where id = o.id;
      perform private.release_offered_drivers(array[v_driver.id]);
    end if;
    perform private.log_event(r.organization_id, r.id, 'offer.rejected_late',
      format('%s (#%s) a tenté d''accepter — %s', v_driver.first_name, v_driver.number,
        case v_code
          when 'RIDE_CANCELLED' then 'course annulée'
          when 'SEARCH_ENDED' then 'recherche terminée'
          else 'course déjà attribuée'
        end),
      'dispatch', 'warning',
      jsonb_build_object('driver_id', v_driver.id, 'offer_id', o.id, 'latency_ms', v_latency, 'code', v_code),
      'driver', v_driver.id);
    return jsonb_build_object('ok', false, 'code', v_code, 'message', case v_code
      when 'RIDE_CANCELLED' then 'Course annulée.'
      when 'SEARCH_ENDED' then 'Recherche terminée : la course n''est plus proposée.'
      else 'Course déjà attribuée.'
    end);
  end if;

  if o.status in ('declined', 'closed', 'accepted') then
    return jsonb_build_object('ok', false, 'code', 'OFFER_CLOSED', 'message', 'Cette offre n''est plus disponible.');
  end if;
  -- Offre retirée (chauffeur passé hors ligne, relance, fin de fenêtre) ou périmée
  if o.status = 'expired' or (o.status = 'pending' and o.expires_at < now() - interval '3 seconds') then
    return jsonb_build_object('ok', false, 'code', 'OFFER_EXPIRED', 'message', 'Cette offre a expiré.');
  end if;

  -- Mode centrale : commission en retard / contestée, plafond d'encours, plafond « nouveau chauffeur ».
  -- L'offre reste ouverte : le chauffeur peut régler (ou signaler son paiement) puis accepter.
  v_block := private.driver_blocker(v_driver.id, r.price_cents, true);
  if v_block is not null then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_BLOCKED', 'reason', v_block,
      'message', private.blocker_message(v_block));
  end if;

  -- Sérialise les acceptations d'un même chauffeur (deux offres en attente acceptées en même temps) :
  -- après l'attente du verrou, le test suivant relit les courses validées par l'autre acceptation.
  -- FOR NO KEY UPDATE (et non FOR UPDATE) : s'exclut lui-même, mais laisse passer le FOR KEY SHARE des insertions
  -- qui référencent le chauffeur (offres du dispatch_tick, notifications, position) — sinon interblocage avec le tick.
  perform 1 from public.drivers where id = v_driver.id for no key update;

  if exists (
    select 1 from public.rides x
    where x.driver_id = v_driver.id
      and x.id <> r.id
      and (
        x.status in ('DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS')
        or (x.status = 'ACCEPTED' and x.type = 'instant')
      )
  ) and r.type = 'instant' then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_BUSY', 'message', 'Vous avez déjà une course en cours.');
  end if;

  -- Compare-and-set : ne réussit que si la course est encore libre.
  update public.rides
     set driver_id = v_driver.id,
         vehicle_id = v_driver.vehicle_id,
         status = 'ACCEPTED',
         accepted_at = now(),
         next_dispatch_at = null
   where id = r.id
     and driver_id is null
     and status in ('SEARCHING_DRIVER', 'OFFERED');
  if not found then
    return jsonb_build_object('ok', false, 'code', 'RIDE_ALREADY_ASSIGNED', 'message', 'Course déjà attribuée.');
  end if;

  -- Filet de sécurité : index unique partiel ride_assignments_one_active_uidx
  insert into public.ride_assignments (organization_id, ride_id, driver_id, vehicle_id, offer_id, method)
  values (r.organization_id, r.id, v_driver.id, v_driver.vehicle_id, o.id, 'accepted');

  update public.ride_offers set status = 'accepted', responded_at = now() where id = o.id;

  perform private.log_event(r.organization_id, r.id, 'offer.accepted', format('%s accepte', v_driver.first_name),
    'timeline', 'success',
    jsonb_build_object('driver_id', v_driver.id, 'driver_number', v_driver.number, 'offer_id', o.id,
      'distance_m', o.distance_m, 'response_ms', v_latency),
    'driver', v_driver.id);
  perform private.log_event(r.organization_id, r.id, 'ride.locked', 'Course verrouillée',
    'timeline', 'info', jsonb_build_object('mechanism', 'row_lock+compare_and_set'), 'system', null);
  perform private.log_event(r.organization_id, r.id, 'dispatch.assigned',
    format('Assignment lock acquired — ride assigned to driver #%s', v_driver.number),
    'dispatch', 'debug', jsonb_build_object('driver_id', v_driver.id), 'system', null);

  v_closed := private.close_pending_offers(r.id, 'closed', 'assigned_to_other', o.id);
  if cardinality(v_closed) > 0 then
    perform private.log_event(r.organization_id, r.id, 'offers.closed',
      format('%s %s', cardinality(v_closed), private.pl(cardinality(v_closed), 'autre offre fermée', 'autres offres fermées')),
      'timeline', 'info', jsonb_build_object('count', cardinality(v_closed), 'driver_ids', to_jsonb(v_closed)), 'system', null);
  end if;

  update public.notifications
     set status = 'cancelled'
   where ride_id = r.id and type in ('ride_offer', 'ride_offer_scheduled') and status = 'queued';

  if r.type = 'instant' then
    update public.drivers set presence = 'en_route', current_ride_id = r.id where id = v_driver.id;
  else
    perform private.release_offered_drivers(array[v_driver.id]);
    perform private.schedule_reminders(r.id);
  end if;

  return jsonb_build_object('ok', true, 'code', 'ACCEPTED', 'message', 'Course attribuée.', 'ride_id', r.id);
end;
$$;

-- ----------------------------------------------------------------- 8. bannissement plateforme (super-admin-1, -3, -4, -7)
-- Dernière définition : 20260924005400_contre_audit_sql. Seul changement : une fiche de la centrale qui
-- signale qui ne partage que la PLAQUE (véhicule de flotte conduit par plusieurs chauffeurs) n'est plus « same_org » :
-- elle se confirme une à une comme celles des autres centrales (svc_platform_ban), au lieu d'être bannie d'office.
create or replace function private.fraud_report_carriers(p_report_id uuid)
returns table (driver_id uuid, organization_id uuid, same_org boolean, kind text, value_hash text)
language sql
stable
set search_path = ''
as $$
  select distinct d.id, d.organization_id, d.organization_id = f.organization_id and i.kind <> 'plate', i.kind, e ->> 'hash'
  from public.fraud_reports f
  join public.drivers d
    on d.deleted_at is null
   and d.id is distinct from f.driver_id
   and d.ban_scope is distinct from 'platform'
  cross join lateral private.driver_identities(d.id, true) i
  cross join lateral jsonb_array_elements(f.identities) e
  where f.id = p_report_id
    and e ->> 'kind' = i.kind
    and (e ->> 'hash' = i.value_hash
         or (i.kind = 'phone' and e ->> 'hash' = any (private.identity_hashes('phone', d.phone))));
$$;

-- Corps de public.reassign_ride (dernière définition : 20260924004500_audit_dispatch.sql) sans contrôle d'adhésion :
-- appelée par svc_platform_ban (service role, acteur super admin) pour remettre en recherche les courses attribuées
-- pas encore commencées d'une fiche bannie de la plateforme. Pas de definer (appelée par une RPC definer).
create or replace function private.platform_unassign_ride(p_ride_id uuid, p_reason text, p_actor uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r public.rides;
  d public.drivers;
  v_threshold integer;
  v_type public.ride_type;
  v_reason text := left(nullif(trim(coalesce(p_reason, '')), ''), 300);
  v_closed uuid[];
  v_alerts integer;
  v_count integer;
  v_status public.ride_status;
  v_auto boolean;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_FOUND', 'message', 'Course introuvable.');
  end if;
  perform private.set_actor('super_admin', p_actor);

  if r.driver_id is null or r.status not in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED') then
    return jsonb_build_object('ok', false, 'code', 'RIDE_NOT_REASSIGNABLE',
      'message', 'Seule une course attribuée et pas encore commencée peut être retirée au chauffeur.', 'status', r.status);
  end if;

  select * into d from public.drivers where id = r.driver_id;

  select s.instant_threshold_minutes, coalesce(s.auto_dispatch, true) into v_threshold, v_auto
  from public.organization_settings s where s.organization_id = r.organization_id;
  v_auto := coalesce(v_auto, true);
  v_type := case
    when greatest(r.pickup_at, now()) <= now() + make_interval(mins => coalesce(v_threshold, 45)) then 'instant'
    else 'scheduled'
  end::public.ride_type;

  -- 1. affectation libérée
  update public.ride_assignments
     set is_active = false, released_at = now(), release_reason = 'reassigned_by_dispatch'
   where ride_id = r.id and is_active;

  -- 2. offres : restes éventuels fermés + marqueur d'exclusion (ce chauffeur n'est plus
  --    sollicité pour cette course, ni par les vagues GPS ni par la flotte)
  v_closed := private.close_pending_offers(r.id, 'closed', 'reassigned_by_dispatch');
  -- offre « fermée » (pas « refusée » : le taux d'acceptation du chauffeur n'est pas touché), exclue en
  -- permanence par run_geo_wave et offer_to_fleet
  insert into public.ride_offers (organization_id, ride_id, driver_id, status, mode, wave, sent_at, expires_at, responded_at, closed_reason)
  values (r.organization_id, r.id, r.driver_id, 'closed', 'geo', 0, now(), now(), now(), 'removed_by_dispatch');

  -- 3. chauffeur retiré de sa course en cours : il enchaîne sur la suivante, sinon disponible
  perform private.release_driver_ride(r.driver_id, r.id, true);

  -- 4. notifications : rappels en file annulés, prévenir le chauffeur
  update public.notifications
     set status = 'cancelled'
   where ride_id = r.id and driver_id = r.driver_id and status = 'queued';
  perform private.queue_notification(r.organization_id, r.driver_id, r.id, null, 'ride_unassigned', 'COURSE RETIRÉE',
    format('La centrale a réattribué la course #%s', r.number),
    jsonb_build_object('type', 'ride_unassigned', 'ride_id', r.id, 'number', r.number, 'reason', v_reason), 'high', null);

  -- 5. course remise en recherche (type recalculé) ; sans dispatch automatique : en attente d'attribution
  update public.rides
     set status = case when v_auto then 'SEARCHING_DRIVER' else 'CREATED' end::public.ride_status,
         driver_id = null,
         vehicle_id = null,
         type = v_type,
         pickup_at = greatest(pickup_at, now()),
         dispatch_mode = case when v_type = 'instant' then 'geo' else 'fleet' end::public.dispatch_mode,
         dispatch_wave = 0,
         dispatch_radius_m = null,
         dispatch_started_at = case when v_auto then now() end,
         next_dispatch_at = null,
         accepted_at = null,
         driver_en_route_at = null,
         driver_arrived_at = null,
         no_driver_at = null
   where id = r.id;

  -- 6. alertes de la course : traitées par la relance
  v_alerts := private.close_ride_alerts(r.id, 'relaunched', p_actor);

  perform private.log_event(r.organization_id, r.id, 'ride.reassigned',
    format('Course retirée à %s %s (#%s) : chauffeur banni de la plateforme Rydar%s — %s',
      coalesce(d.first_name, 'chauffeur'), coalesce(d.last_name, ''), coalesce(d.number::text, '?'),
      coalesce(' : ' || v_reason, ''), case when v_auto then 'nouvelle recherche' else 'à attribuer manuellement' end),
    'timeline', 'warning',
    jsonb_build_object('previous_driver_id', r.driver_id, 'previous_status', r.status, 'reason', v_reason,
      'type', v_type, 'closed_alerts', v_alerts, 'closed_offers', cardinality(v_closed)),
    'super_admin', p_actor);

  -- 7. nouvelle recherche : 4 km d'abord (instantanée) ou toute la flotte (planifiée) ;
  --    dispatch automatique désactivé : la course attend une attribution manuelle
  if not v_auto then
    return jsonb_build_object('ok', true, 'code', 'UNASSIGNED', 'message', 'Course retirée au chauffeur — à attribuer manuellement.',
      'ride_id', r.id, 'previous_driver_id', r.driver_id, 'type', v_type, 'status', 'CREATED',
      'notified', 0, 'closed_alerts', v_alerts);
  end if;
  if v_type = 'instant' then
    v_count := private.run_geo_wave(r.id);
  else
    v_count := private.offer_to_fleet(r.id);
  end if;

  select status into v_status from public.rides where id = r.id;
  return jsonb_build_object('ok', true, 'code', 'RELAUNCHED', 'message', 'Course retirée au chauffeur — nouvelle recherche lancée.',
    'ride_id', r.id, 'previous_driver_id', r.driver_id, 'type', v_type, 'status', v_status,
    'notified', coalesce(v_count, 0), 'closed_alerts', v_alerts);
end;
$$;

-- Dernière définition : 20260924004600_audit_bannissement. Changements : (a) refus si la fiche signalée n'est
-- plus bannie par sa centrale (REPORTED_DRIVER_NOT_BANNED : bannissement levé entre-temps) ; (b) refus tant qu'une
-- fiche visée a un client à bord (DRIVER_ON_RIDE, rien n'est écrit) ; ses courses attribuées pas encore commencées
-- sont remises en recherche (private.platform_unassign_ride, « reassigned_rides ») et current_ride_id vidé ; (c) une
-- fiche de la centrale qui signale ne partageant que la plaque se confirme une à une (private.fraud_report_carriers) ;
-- les identités d'une fiche non confirmée restent hors du bannissement plateforme.
create or replace function public.svc_platform_ban(
  p_report_id uuid,
  p_actor uuid,
  p_note text default null,
  p_extend_driver_ids uuid[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.fraud_reports;
  x record;
  v_count integer;
  v_identities_skipped integer;
  v_drivers integer := 0;
  v_users uuid[] := '{}';
  v_kept uuid[] := '{}';
  v_note text := left(nullif(btrim(coalesce(p_note, '')), ''), 500);
  v_extend uuid[] := coalesce(p_extend_driver_ids, '{}');
  v_same uuid[];
  v_confirmed uuid[];
  v_skipped uuid[];
  v_blocked text[];
  v_ride record;
  v_reassigned integer := 0;
  v_onboard text;
begin
  perform private.assert_platform_actor(p_actor);
  select * into f from public.fraud_reports where id = p_report_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Signalement introuvable.');
  end if;
  if f.status = 'platform_banned' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_BANNED', 'message', 'Déjà banni de la plateforme.');
  end if;
  if exists (select 1 from public.drivers d where d.id = f.driver_id and d.deleted_at is null and d.banned_at is null) then
    return jsonb_build_object('ok', false, 'code', 'REPORTED_DRIVER_NOT_BANNED',
      'message', 'Sa centrale a levé le bannissement de ce chauffeur : classez le signalement.');
  end if;
  perform private.set_actor('super_admin', p_actor);

  -- Fiches qui partagent une identité : même centrale (automatique), autres centrales confirmées / écartées
  select coalesce(array_agg(distinct c.driver_id) filter (where c.same_org), '{}') into v_same
  from private.fraud_report_carriers(f.id) c;
  with c as (select * from private.fraud_report_carriers(f.id) k where not (k.driver_id = any (v_same)))
  select coalesce(array_agg(distinct c.driver_id) filter (where c.driver_id = any (v_extend)), '{}'),
         coalesce(array_agg(distinct c.driver_id) filter (where not (c.driver_id = any (v_extend))), '{}'),
         coalesce(array_agg(distinct c.kind || ':' || c.value_hash) filter (where not (c.driver_id = any (v_extend))), '{}')
    into v_confirmed, v_skipped, v_blocked
  from c;

  -- Client à bord d'une fiche visée : rien n'est fait (même règle que ban_driver)
  select string_agg(distinct format('%s %s (#%s)', d.first_name, d.last_name, d.number), ', ') into v_onboard
  from public.drivers d
  join public.rides r on r.driver_id = d.id and r.status in ('PASSENGER_ONBOARD', 'IN_PROGRESS')
  where d.deleted_at is null
    and d.ban_scope is distinct from 'platform'
    and (d.id = f.driver_id or d.id = any (v_same) or d.id = any (v_confirmed));
  if v_onboard is not null then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_ON_RIDE',
      'message', 'Client à bord (' || v_onboard || ') : attendez la fin de la course avant de bannir de la plateforme.');
  end if;

  insert into public.banned_identities (scope, organization_id, kind, value_hash, hint, driver_id, report_id, reason, created_by)
  select 'platform', null, e ->> 'kind', e ->> 'hash', e ->> 'hint', f.driver_id, f.id, f.reason, p_actor
  from jsonb_array_elements(f.identities) e
  where e ->> 'kind' in ('phone', 'email', 'vtc_card', 'driving_license', 'identity_doc', 'plate', 'device')
    and e ->> 'hash' ~ '^[0-9a-f]{64}$'
    and not (((e ->> 'kind') || ':' || (e ->> 'hash')) = any (v_blocked))
  on conflict do nothing;
  get diagnostics v_count = row_count;

  select count(*) into v_identities_skipped
  from jsonb_array_elements(f.identities) e
  where ((e ->> 'kind') || ':' || (e ->> 'hash')) = any (v_blocked);

  update public.fraud_reports
     set status = 'platform_banned', reviewed_by = p_actor, reviewed_at = now(), review_note = v_note
   where id = f.id;

  -- Chauffeur signalé, fiches de sa centrale et fiches confirmées d'autres centrales ; fiches supprimées exclues
  -- (anonymes, non modifiables)
  for x in
    select d.id, d.user_id, d.organization_id
    from public.drivers d
    where d.deleted_at is null
      and d.ban_scope is distinct from 'platform'
      and (d.id = f.driver_id or d.id = any (v_same) or d.id = any (v_confirmed))
  loop
    for v_ride in
      select r.id from public.rides r
      where r.driver_id = x.id and r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED')
      order by r.pickup_at
    loop
      if coalesce((private.platform_unassign_ride(v_ride.id, 'Chauffeur banni de la plateforme Rydar', p_actor) ->> 'ok')::boolean, false) then
        v_reassigned := v_reassigned + 1;
      end if;
    end loop;
    update public.drivers
       set status = case when status = 'inactive' then 'inactive' else 'suspended' end::public.driver_status,
           presence = 'offline',
           online_since = null,
           current_ride_id = null,
           banned_at = coalesce(banned_at, now()),
           banned_by = coalesce(banned_by, p_actor),
           ban_reason = coalesce(ban_reason, 'Banni de la plateforme Rydar'),
           ban_scope = 'platform',
           ban_report_id = f.id,
           suspended_reason = 'Banni de la plateforme Rydar',
           application_status = case when application_status = 'pending' then 'rejected' else application_status end
     where id = x.id;
    update public.ride_offers
       set status = 'closed', closed_reason = 'driver_banned', responded_at = now()
     where driver_id = x.id and status = 'pending';
    if x.user_id is not null then
      if private.keeps_login_account(x.user_id) then
        v_kept := v_kept || x.user_id;
      else
        v_users := v_users || x.user_id;
      end if;
    end if;
    v_drivers := v_drivers + 1;
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
    values (x.organization_id, 'super_admin', p_actor, 'driver.platform_banned', 'drivers', x.id::text, 'critical',
      jsonb_build_object('report_id', f.id, 'extended', x.id = any (v_confirmed),
        'login_kept', x.user_id is not null and x.user_id = any (v_kept)));
  end loop;

  return jsonb_build_object('ok', true, 'code', 'PLATFORM_BANNED', 'identities', v_count,
    'identities_skipped', v_identities_skipped, 'drivers', v_drivers, 'reassigned_rides', v_reassigned,
    'extended', coalesce(cardinality(v_confirmed), 0), 'skipped_drivers', coalesce(cardinality(v_skipped), 0),
    'user_ids', to_jsonb(v_users), 'kept_user_ids', to_jsonb(v_kept),
    'message', case when v_identities_skipped > 0
      then 'Banni de la plateforme, sauf les identités partagées avec des fiches d''autres centrales non confirmées.'
      else 'Banni de toute la plateforme.' end);
end;
$$;

-- Dernière définition : 20260924004600_audit_bannissement. Changements (signalements qui se recoupent) :
-- une identité aussi portée par un AUTRE signalement banni de la plateforme lui est transmise (report_id), pas levée ;
-- une fiche qui porte encore une identité bannie de la plateforme (ou signalée par un autre signalement banni) reste
-- bannie de la plateforme, rattachée à ce signalement (« kept_drivers »).
create or replace function public.svc_platform_unban(p_report_id uuid, p_actor uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.fraud_reports;
  x record;
  v_count integer;
  v_users uuid[] := '{}';
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
  v_moved integer;
  v_other uuid;
  v_kept integer := 0;
begin
  perform private.assert_platform_actor(p_actor);
  select * into f from public.fraud_reports where id = p_report_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Signalement introuvable.');
  end if;
  if f.status <> 'platform_banned' then
    return jsonb_build_object('ok', false, 'code', 'NOT_BANNED', 'message', 'Aucun bannissement plateforme actif.');
  end if;
  perform private.set_actor('super_admin', p_actor);

  update public.banned_identities b
     set report_id = (select f2.id from public.fraud_reports f2
                       where f2.status = 'platform_banned' and f2.id <> f.id
                         and exists (select 1 from jsonb_array_elements(f2.identities) e
                                     where e ->> 'kind' = b.kind and e ->> 'hash' = b.value_hash)
                       order by f2.reviewed_at, f2.id
                       limit 1)
   where b.scope = 'platform' and b.report_id = f.id and b.lifted_at is null
     and exists (select 1 from public.fraud_reports f2
                 cross join lateral jsonb_array_elements(f2.identities) e
                 where f2.status = 'platform_banned' and f2.id <> f.id
                   and e ->> 'kind' = b.kind and e ->> 'hash' = b.value_hash);
  get diagnostics v_moved = row_count;

  update public.banned_identities
     set lifted_at = now(), lifted_by = p_actor, lift_reason = v_reason
   where scope = 'platform' and report_id = f.id and lifted_at is null;
  get diagnostics v_count = row_count;

  update public.fraud_reports
     set status = 'lifted', reviewed_by = p_actor, reviewed_at = now(), review_note = coalesce(v_reason, review_note)
   where id = f.id;

  for x in select d.id, d.user_id from public.drivers d where d.ban_report_id = f.id and d.deleted_at is null loop
    select b.report_id into v_other
      from private.driver_identities(x.id, true) i
      join public.banned_identities b
        on b.scope = 'platform' and b.lifted_at is null and b.kind = i.kind and b.value_hash = i.value_hash
     where b.report_id is not null and b.report_id <> f.id
     limit 1;
    if v_other is null then
      select f2.id into v_other from public.fraud_reports f2
       where f2.status = 'platform_banned' and f2.id <> f.id and f2.driver_id = x.id
       limit 1;
    end if;
    if v_other is not null then
      update public.drivers set ban_report_id = v_other where id = x.id;
      v_kept := v_kept + 1;
      insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
      select d.organization_id, 'super_admin', p_actor, 'driver.platform_ban_kept', 'drivers', d.id::text, 'warning',
        jsonb_build_object('report_id', f.id, 'kept_by_report_id', v_other)
      from public.drivers d where d.id = x.id;
      continue;
    end if;
    if exists (
      select 1 from public.banned_identities b
      where b.scope = 'org' and b.driver_id = x.id and b.lifted_at is null
    ) then
      update public.drivers
         set ban_scope = 'org', ban_report_id = null, suspended_reason = 'Banni : ' || coalesce(ban_reason, '')
       where id = x.id;
    else
      update public.drivers
         set banned_at = null, banned_by = null, ban_reason = null, ban_scope = null, ban_report_id = null,
             suspended_reason = 'Bannissement plateforme levé'
       where id = x.id;
      if x.user_id is not null then
        v_users := v_users || x.user_id;
      end if;
    end if;
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
    select d.organization_id, 'super_admin', p_actor, 'driver.platform_unbanned', 'drivers', d.id::text, 'warning',
      jsonb_build_object('report_id', f.id, 'reason', v_reason)
    from public.drivers d where d.id = x.id;
  end loop;

  return jsonb_build_object('ok', true, 'code', 'LIFTED', 'identities', v_count, 'user_ids', to_jsonb(v_users),
    'kept_identities', v_moved, 'kept_drivers', v_kept,
    'message', 'Bannissement plateforme levé.');
end;
$$;

-- Dernière définition : 20260924002600_centrale_mode. Seul ajout : le signalement encore « à examiner » de
-- la fiche est classé (« dismissed ») : le super admin ne bannit plus de la plateforme un chauffeur réhabilité.
create or replace function public.lift_driver_ban(p_driver_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
  v_count integer;
  v_reports integer;
begin
  select * into d from public.drivers where id = p_driver_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_FOUND', 'message', 'Chauffeur introuvable.');
  end if;
  perform private.assert_org_member(d.organization_id, array['owner', 'admin']::public.org_role[]);
  if d.banned_at is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_BANNED', 'message', 'Ce chauffeur n''est pas banni.');
  end if;
  if d.ban_scope = 'platform' then
    return jsonb_build_object('ok', false, 'code', 'PLATFORM_BAN',
      'message', 'Bannissement décidé par la plateforme Rydar : contactez le support.');
  end if;

  update public.banned_identities
     set lifted_at = now(), lifted_by = auth.uid(), lift_reason = v_reason
   where scope = 'org' and organization_id = d.organization_id and driver_id = d.id and lifted_at is null;
  get diagnostics v_count = row_count;

  update public.drivers
     set banned_at = null, banned_by = null, ban_reason = null, ban_scope = null,
         suspended_reason = 'Bannissement levé' || coalesce(' : ' || v_reason, '')
   where id = d.id;

  update public.fraud_reports
     set status = 'dismissed', reviewed_at = now(),
         review_note = left('Classé : bannissement levé par la centrale' || coalesce(' — ' || v_reason, ''), 500)
   where driver_id = d.id and status = 'open';
  get diagnostics v_reports = row_count;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (d.organization_id, 'user', auth.uid(), 'driver.ban_lifted', 'drivers', d.id::text, 'warning',
    jsonb_build_object('reason', v_reason, 'identities', v_count, 'reports_dismissed', v_reports));
  return jsonb_build_object('ok', true, 'code', 'LIFTED', 'identities', v_count, 'user_id', d.user_id,
    'message', 'Bannissement levé : le chauffeur reste suspendu, réactivez-le si besoin.');
end;
$$;

-- ----------------------------------------------------------------- 9. annonce des CGV en échec (super-admin-2)
alter table public.email_outbox add column if not exists org_terms_version text
  check (org_terms_version is null or org_terms_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
comment on column public.email_outbox.org_terms_version is
  'org_terms_update : version des CGV annoncée (org_terms_notices) ; une annonce dont tous les e-mails sont en échec ne compte pas.';
-- Annonces déjà envoyées : e-mails écrits dans la même transaction que leur annonce (même created_at)
update public.email_outbox e
   set org_terms_version = t.version
  from public.org_terms_notices t
 where e.kind = 'org_terms_update' and e.organization_id = t.organization_id and e.org_terms_version is null
   and e.created_at between t.created_at - interval '1 minute' and t.created_at + interval '1 minute';

-- Dernière définition : 20260924006600_platform_fee_schedule. Seul changement : l'annonce compte seulement si un
-- e-mail de CETTE version (email_outbox.org_terms_version) n'est pas en échec définitif (en file, en cours ou parti).
create or replace function private.org_terms_notified(p_org uuid, p_version text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
begin
  return p_version is not null
     and exists (select 1 from public.org_terms_notices t where t.organization_id = p_org and t.version = p_version)
     and exists (select 1 from public.email_outbox e
                  where e.organization_id = p_org and e.kind = 'org_terms_update'
                    and e.org_terms_version = p_version and e.status <> 'failed');
end;
$$;

-- Dernière définition : 20260924006600_platform_fee_schedule. Changements : chaque e-mail porte sa version
-- (email_outbox.org_terms_version) ; une organisation dont TOUS les e-mails d'annonce sont en échec est de nouveau
-- prévenue (date d'entrée en vigueur annoncée mise à jour), sous la même règle des 30 jours.
create or replace function public.svc_org_terms_notify(p_actor uuid, p_version text, p_effective_on date, p_app_url text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version text := btrim(coalesce(p_version, ''));
  x record;
  v_mail jsonb;
  v_n integer;
  v_orgs integer := 0;
  v_emails integer := 0;
  v_already integer := 0;
  v_no_email integer := 0;
  v_pending integer := 0;
  v_min date := private.notice_min_on('Europe/Paris');
begin
  perform private.assert_platform_actor(p_actor);
  if not private.legal_version_ok(v_version) then
    return jsonb_build_object('ok', false, 'code', 'TERMS_VERSION_INVALID', 'message', 'Version des CGV invalide.');
  end if;
  if p_effective_on is null or p_effective_on < v_version::date then
    return jsonb_build_object('ok', false, 'code', 'TERMS_VERSION_INVALID',
      'message', 'Date d''entrée en vigueur des CGV invalide.');
  end if;
  if p_effective_on <= (now() at time zone 'Europe/Paris')::date then
    return jsonb_build_object('ok', false, 'code', 'TERMS_EFFECTIVE_PASSED',
      'message', private.fr_typo(format('Entrée en vigueur des CGV atteinte (%s) : l''annonce, qui dit « au plus tard le %s », n''est plus envoyée.',
        to_char(p_effective_on, 'DD/MM/YYYY'), private.fr_long_date(p_effective_on))));
  end if;
  -- CGV art. 16 : modification défavorable annoncée au moins 30 jours avant son entrée en vigueur
  if p_effective_on < v_min then
    return jsonb_build_object('ok', false, 'code', 'TERMS_NOTICE_TOO_SHORT', 'min_effective_on', v_min,
      'message', private.fr_typo(format('Préavis insuffisant : l''annonce dit « au plus tard le %s », moins de 30 jours après aujourd''hui (au plus tôt le %s). Repoussez d''abord la date d''entrée en vigueur (ORG_LEGAL_EFFECTIVE_AT, @rydar/shared), puis redéployez.',
        private.fr_long_date(p_effective_on), private.fr_long_date(v_min))));
  end if;
  -- Un envoi à la fois (double clic, deux onglets) ; la clé primaire (organisation, version) garde le premier
  perform pg_advisory_xact_lock(hashtextextended('rydar.org_terms_notify', 0));
  perform private.set_actor('super_admin', p_actor);

  for x in
    select o.id
      from public.organizations o
     where o.status in ('active', 'suspended')
       and not private.org_terms_accepted(o.id, v_version)
     order by o.created_at, o.id
  loop
    v_pending := v_pending + 1;
    if private.org_terms_notified(x.id, v_version) then
      v_already := v_already + 1;
      continue;
    end if;
    if private.org_owner_emails(x.id) is null then
      v_no_email := v_no_email + 1;
      continue;
    end if;
    v_mail := private.org_terms_email(x.id, v_version, p_effective_on, p_app_url);
    v_n := private.queue_org_emails(x.id, 'org_terms_update', v_mail ->> 'subject', v_mail ->> 'body', null, p_actor);
    update public.email_outbox e
       set org_terms_version = v_version
     where e.organization_id = x.id and e.kind = 'org_terms_update' and e.org_terms_version is null and e.created_at = now();
    insert into public.org_terms_notices (organization_id, version, effective_on, emails_queued, created_by)
    values (x.id, v_version, p_effective_on, v_n, p_actor)
    on conflict (organization_id, version) do update
      set effective_on = excluded.effective_on, emails_queued = excluded.emails_queued, created_by = excluded.created_by;
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
    values (x.id, 'super_admin', p_actor, 'organization.terms_notice_sent', 'organizations', x.id::text, 'info',
      jsonb_build_object('version', v_version, 'effective_on', p_effective_on, 'emails', v_n));
    v_orgs := v_orgs + 1;
    v_emails := v_emails + v_n;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'code', case when v_orgs > 0 then 'NOTIFIED' else 'NOTHING_TO_NOTIFY' end,
    'organizations', v_orgs,
    'emails', v_emails,
    'already_notified', v_already,
    'without_email', v_no_email,
    'not_accepted', v_pending,
    'message', private.fr_typo(concat_ws(' ',
      case when v_orgs > 0
        then format('%s organisation%s prévenue%s par e-mail (%s e-mail%s).', v_orgs, case when v_orgs > 1 then 's' else '' end,
          case when v_orgs > 1 then 's' else '' end, v_emails, case when v_emails > 1 then 's' else '' end)
        else 'Aucune organisation à prévenir.' end,
      case when v_already > 0
        then format('%s déjà prévenue%s pour cette version.', v_already, case when v_already > 1 then 's' else '' end) end,
      case when v_no_email > 0
        then format('%s sans adresse e-mail valide (propriétaire ni organisation).', v_no_email) end)));
end;
$$;

-- Dernière définition : 20260924006600_platform_fee_schedule. Seul ajout : hausse d'une organisation qui n'a
-- pas accepté les CGV de la version du réglage (terms_version) : annulée aussi si aucun e-mail d'annonce de ces CGV
-- n'est PARTI au moins 30 jours avant leur entrée en vigueur annoncée (org_terms_notices.effective_on, Paris).
create or replace function private.apply_platform_fee_changes(p_limit integer default 100)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  x record;
  o public.organizations;
  c public.platform_fee_changes;
  v_sent timestamptz;
  v_mail jsonb;
  v_emails integer;
  v_count integer := 0;
  v_terms_ok boolean;
begin
  for x in
    select f.id, f.organization_id
      from public.platform_fee_changes f
     where f.status = 'scheduled' and f.effective_at <= now()
     order by f.effective_at, f.id
     limit greatest(coalesce(p_limit, 100), 1)
  loop
    select * into o from public.organizations where id = x.organization_id for no key update skip locked;
    continue when not found;
    select * into c from public.platform_fee_changes where id = x.id for no key update;
    continue when not found or c.status <> 'scheduled' or c.effective_at > now();
    perform private.set_actor('system', null);

    select min(e.sent_at) into v_sent
      from public.email_outbox e
     where e.platform_fee_change_id = coalesce(c.notice_change_id, c.id) and e.kind = 'platform_fee_change'
       and e.status = 'sent';
    v_terms_ok := c.terms_version is null or coalesce(c.terms_accepted, false)
      or private.org_terms_accepted(o.id, c.terms_version)
      or exists (
        select 1 from public.email_outbox e
        join public.org_terms_notices t on t.organization_id = e.organization_id and t.version = e.org_terms_version
        where e.organization_id = o.id and e.kind = 'org_terms_update' and e.org_terms_version = c.terms_version
          and e.status = 'sent'
          and e.sent_at <= (t.effective_on::timestamp at time zone 'Europe/Paris') - interval '30 days');
    if v_sent is null or v_sent > c.effective_at - interval '30 days' or not v_terms_ok then
      update public.platform_fee_changes
         set status = 'cancelled', closed_at = now(), closed_by = null,
             close_reason = case when v_sent is null or v_sent > c.effective_at - interval '30 days'
               then 'Non appliqué : aucun e-mail d''annonce parti au moins 30 jours avant la date d''effet'
               else 'Non appliqué : CGV non acceptées et leur annonce n''est pas partie 30 jours avant leur entrée en vigueur' end
       where id = c.id;
      v_mail := private.platform_fee_change_email('cancel', o.id, o.dispatch_model, o.platform_fee_percent, o.platform_fee_fixed_cents,
        o.platform_fee_percent, o.platform_fee_fixed_cents, null, (c.effective_at at time zone coalesce(o.timezone, 'Europe/Paris'))::date, null);
      v_emails := private.queue_org_emails(o.id, 'platform_fee_change', v_mail ->> 'subject', v_mail ->> 'body', c.id, null);
      insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
      values (o.id, 'system', null, 'organization.platform_fee_schedule_cancelled', 'organizations', o.id::text, 'warning',
        jsonb_build_object('change_id', c.id,
          'reason', case when v_sent is null or v_sent > c.effective_at - interval '30 days' then 'notice_not_sent' else 'terms_notice_not_sent' end, 'notice_change_id', c.notice_change_id,
          'notice_sent_at', v_sent, 'effective_at', c.effective_at,
          'to', jsonb_build_object('platform_fee_percent', c.to_percent, 'platform_fee_fixed_cents', c.to_fixed_cents),
          'emails', v_emails));
      perform private.broadcast_platform(o.id, 'rates_cancelled');
      continue;
    end if;

    update public.organizations
       set platform_fee_percent = c.to_percent, platform_fee_fixed_cents = c.to_fixed_cents
     where id = o.id
       and (platform_fee_percent, platform_fee_fixed_cents) is distinct from (c.to_percent, c.to_fixed_cents);
    update public.platform_fee_changes set status = 'applied', applied_at = now() where id = c.id;
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
    values (o.id, 'system', null, 'organization.platform_fee_changed', 'organizations', o.id::text, 'info',
      jsonb_build_object(
        'before', jsonb_build_object('dispatch_model', o.dispatch_model, 'platform_fee_percent', o.platform_fee_percent,
          'platform_fee_fixed_cents', o.platform_fee_fixed_cents),
        'after', jsonb_build_object('dispatch_model', o.dispatch_model, 'platform_fee_percent', c.to_percent,
          'platform_fee_fixed_cents', c.to_fixed_cents),
        'mode', 'notice', 'change_id', c.id, 'announced_at', c.created_at, 'announced_by', c.created_by,
        'notice_sent_at', v_sent, 'effective_at', c.effective_at, 'emails', c.emails_queued));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ----------------------------------------------------------------- 10. statut d'une organisation (super-admin-5, worker-perf-6)
-- Dernière définition : 20260924003300_live_position. Changements : (a) courses d'une organisation
-- suspendue ou archivée ignorées (ni offre ni notification ; reprise à la réactivation) ; (b) « processed » = courses
-- traitées : le worker appelle par lots courts (verrous des courses tenus par lot, pas pendant tout le tick).
create or replace function private.dispatch_tick(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ride record;
  r public.rides;
  s public.organization_settings;
  v_plan integer[];
  v_n integer;
  v_expired uuid[];
  v_extended integer;
  v_waves integer := 0;
  v_escalated integer := 0;
  v_refreshed integer := 0;
  v_failed integer := 0;
  v_expired_count integer := 0;
  v_next integer;
  v_path text;
  v_processed integer := 0;
begin
  perform private.set_actor('system', null);

  for v_ride in
    select id from public.rides
    where status in ('SEARCHING_DRIVER', 'OFFERED')
      and next_dispatch_at <= now()
      and exists (select 1 from public.organizations o where o.id = rides.organization_id and o.status = 'active')
    order by next_dispatch_at
    limit p_limit
    for update skip locked
  loop
    v_processed := v_processed + 1;
    select * into r from public.rides where id = v_ride.id;
    select * into s from public.organization_settings where organization_id = r.organization_id;

    if r.dispatch_mode = 'fleet' then
      -- Fenêtre flotte encore ouverte : on propose aux chauffeurs devenus éligibles
      if now() < r.pickup_at - make_interval(mins => coalesce(s.scheduled_dispatch_lead_minutes, 60)) then
        perform private.offer_to_fleet(r.id);
        v_refreshed := v_refreshed + 1;
        continue;
      end if;
      v_expired := private.close_pending_offers(r.id, 'expired', 'fleet_window_elapsed');
      update public.rides
         set dispatch_mode = 'geo', dispatch_wave = 0, dispatch_started_at = now()
       where id = r.id;
      perform private.log_event(r.organization_id, r.id, 'dispatch.escalated',
        format('Course planifiée toujours sans chauffeur à T-%s min — bascule en recherche GPS', coalesce(s.scheduled_dispatch_lead_minutes, 60)),
        'timeline', 'warning', jsonb_build_object('closed_offers', cardinality(v_expired)), 'system', null);
      perform private.run_geo_wave(r.id);
      v_escalated := v_escalated + 1;
      continue;
    end if;

    v_plan := private.dispatch_plan(s.dispatch_radii_m, s.dispatch_retry_radii_m);
    v_n := private.dispatch_first_pass(s.dispatch_radii_m);

    -- Offres de chauffeurs devenus indisponibles (autre course, suspendus) : fermées, pas prolongées
    with gone as (
      update public.ride_offers o
         set status = 'expired', closed_reason = 'driver_unavailable', responded_at = coalesce(o.responded_at, now())
        from public.drivers d
       where o.ride_id = r.id and o.status = 'pending' and o.mode = 'geo'
         and d.id = o.driver_id
         and (d.status <> 'active' or d.presence not in ('available', 'offered'))
      returning o.driver_id
    )
    select coalesce(array_agg(driver_id), '{}') into v_expired from gone;
    perform private.release_offered_drivers(v_expired);

    -- Dernière vague écoulée (relance comprise) : personne n'a pris la course, le dispatch est prévenu
    if r.dispatch_wave >= cardinality(v_plan) then
      v_expired := private.close_pending_offers(r.id, 'expired', 'timeout');
      v_expired_count := v_expired_count + cardinality(v_expired);
      update public.rides
         set status = 'NO_DRIVER_FOUND', no_driver_at = now(), next_dispatch_at = null
       where id = r.id;
      select string_agg(private.fmt_km(x), ' → ' order by i) into v_path
        from unnest(v_plan[1:v_n]) with ordinality as t(x, i);
      if cardinality(v_plan) > v_n then
        v_path := v_path || ', relance ' || (select string_agg(private.fmt_km(x), ' → ' order by i)
                                               from unnest(v_plan[v_n + 1:]) with ordinality as t(x, i));
      end if;
      perform private.log_event(r.organization_id, r.id, 'dispatch.no_driver',
        format('Personne n''a accepté la course (%s) — attribuez-la ou relancez', v_path),
        'timeline', 'error', jsonb_build_object('waves', r.dispatch_wave, 'last_radius_m', r.dispatch_radius_m,
          'closed_offers', cardinality(v_expired)), 'system', null);
      v_failed := v_failed + 1;
      continue;
    end if;

    -- Offres restées sans réponse pendant deux délais : fermées (le chauffeur redevient disponible
    -- pour d'autres courses) ; la relance les re-propose
    with ignored as (
      update public.ride_offers o
         set status = 'expired', closed_reason = 'ignored', responded_at = coalesce(o.responded_at, now())
       where o.ride_id = r.id and o.status = 'pending' and o.mode = 'geo'
         and o.sent_at < now() - make_interval(secs => 2 * coalesce(s.offer_timeout_seconds, 30))
      returning o.driver_id
    )
    select coalesce(array_agg(driver_id), '{}') into v_expired from ignored;
    perform private.release_offered_drivers(v_expired);

    -- Les chauffeurs déjà sollicités gardent leur offre une vague de plus (prolongée, sans re-sonnerie)
    update public.ride_offers
       set expires_at = now() + make_interval(secs => coalesce(s.offer_timeout_seconds, 30))
     where ride_id = r.id and status = 'pending' and mode = 'geo';
    get diagnostics v_extended = row_count;
    if v_extended > 0 then
      perform private.log_event(r.organization_id, r.id, 'dispatch.extended',
        format('%s %s sans réponse — %s', v_extended, private.pl(v_extended, 'offre toujours ouverte', 'offres toujours ouvertes'),
          'prolongée' || case when v_extended > 1 then 's' else '' end || ' sans nouvelle sonnerie'),
        'dispatch', 'info', jsonb_build_object('pending', v_extended, 'wave', r.dispatch_wave), 'system', null);
    end if;

    if r.dispatch_wave >= 1 then
      v_next := v_plan[r.dispatch_wave + 1];
      if r.dispatch_wave = v_n then
        -- (le marqueur « retiré par la centrale » de reassign_ride n'est pas une sollicitation)
        if exists (select 1 from public.ride_offers o where o.ride_id = r.id and o.sent_at >= r.dispatch_started_at
                     and o.closed_reason is distinct from 'removed_by_dispatch') then
          perform private.log_event(r.organization_id, r.id, 'dispatch.next',
            format('Personne n''a accepté jusqu''à %s — relance à %s', private.fmt_km(r.dispatch_radius_m), private.fmt_km(v_next)),
            'timeline', 'warning', jsonb_build_object('wave', r.dispatch_wave + 1, 'radius_m', v_next, 'relance', true), 'system', null);
        else
          -- Personne n'a même été sollicité : l'explication (chauffeurs en ligne et raison) suit (déclencheur)
          perform private.log_event(r.organization_id, r.id, 'dispatch.retry',
            format('Aucun chauffeur disponible jusqu''à %s — relance à %s', private.fmt_km(r.dispatch_radius_m), private.fmt_km(v_next)),
            'timeline', 'warning', jsonb_build_object('radius_m', r.dispatch_radius_m, 'wave', r.dispatch_wave + 1, 'relance', true), 'system', null);
        end if;
      else
        perform private.log_event(r.organization_id, r.id, 'dispatch.next',
          format('Personne n''a accepté — rayon élargi à %s', private.fmt_km(v_next)),
          'timeline', 'info', jsonb_build_object('wave', r.dispatch_wave + 1, 'radius_m', v_next, 'relance', r.dispatch_wave > v_n), 'system', null);
      end if;
    end if;

    perform private.run_geo_wave(r.id);
    v_waves := v_waves + 1;
  end loop;

  return jsonb_build_object('processed', v_processed, 'waves', v_waves, 'escalated', v_escalated, 'fleet_refreshed', v_refreshed,
    'no_driver', v_failed, 'expired_offers', v_expired_count);
end;
$$;

-- Suspendre / archiver / réactiver une organisation (super admin, /admin/organizations) en une transaction : refus
-- tant qu'un chauffeur est en route ou a un client à bord (DRIVER_ON_RIDE : il serait déconnecté en pleine course,
-- la course resterait bloquée et ses frais jamais dus) ; offres en attente fermées, notifications d'offre en file
-- annulées, chauffeurs hors ligne ; le dispatch ignore les organisations non actives (private.dispatch_tick).
-- Courses acceptées à venir : conservées (« upcoming_rides » : la centrale ne peut plus les servir tant qu'elle est
-- suspendue). Journal en base. Réactivation : levée des anciens verrous Auth par le web (inchangé).
create or replace function public.svc_platform_set_org_status(p_org uuid, p_actor uuid, p_status text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
  v_busy integer := 0;
  v_offers uuid[] := '{}';
  v_drivers integer := 0;
  v_upcoming integer := 0;
begin
  perform private.assert_platform_actor(p_actor);
  if p_status is null or p_status not in ('active', 'suspended', 'archived') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_STATUS', 'message', 'Statut invalide.');
  end if;
  select * into o from public.organizations where id = p_org for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Organisation introuvable.');
  end if;
  if p_status <> 'active' then
    select count(*) into v_busy
      from public.rides r
     where r.organization_id = p_org and r.driver_id is not null
       and (r.status in ('DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS')
            or (r.status = 'ACCEPTED' and r.type = 'instant'));
    if v_busy > 0 then
      return jsonb_build_object('ok', false, 'code', 'DRIVER_ON_RIDE', 'count', v_busy,
        'message', private.fr_typo(format('%s %s : chauffeur en route ou client à bord. Attendez la fin (ou faites annuler) avant de %s cette organisation.',
          v_busy, private.pl(v_busy, 'course en cours', 'courses en cours'),
          case p_status when 'archived' then 'archiver' else 'suspendre' end)));
    end if;
  end if;
  perform private.set_actor('super_admin', p_actor);

  update public.organizations
     set status = p_status::public.org_status,
         suspended_at = case p_status when 'suspended' then now() when 'active' then null else suspended_at end,
         suspended_reason = case p_status when 'suspended' then v_reason when 'active' then null else suspended_reason end,
         archived_at = case p_status when 'archived' then now() when 'active' then null else archived_at end
   where id = p_org;

  if p_status <> 'active' then
    with closed as (
      update public.ride_offers x
         set status = 'closed', closed_reason = 'org_suspended', responded_at = now()
       where x.organization_id = p_org and x.status = 'pending'
      returning x.driver_id
    )
    select coalesce(array_agg(distinct closed.driver_id), '{}') into v_offers from closed;
    update public.notifications n
       set status = 'cancelled', last_error = 'org_suspended'
     where n.organization_id = p_org and n.status = 'queued' and n.type in ('ride_offer', 'ride_offer_scheduled');
    update public.drivers
       set presence = 'offline', online_since = null
     where organization_id = p_org and presence <> 'offline';
    get diagnostics v_drivers = row_count;
    select count(*) into v_upcoming
      from public.rides r
     where r.organization_id = p_org and r.status = 'ACCEPTED' and r.driver_id is not null;
  end if;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, 'super_admin', p_actor, 'organization.' || p_status, 'organizations', p_org::text,
    case when p_status = 'active' then 'info' else 'warning' end,
    jsonb_build_object('reason', v_reason, 'previous_status', o.status, 'closed_offers', cardinality(v_offers),
      'drivers_offline', v_drivers, 'upcoming_rides', v_upcoming));

  return jsonb_build_object('ok', true, 'code', 'UPDATED', 'status', p_status, 'closed_offers', cardinality(v_offers),
    'drivers_offline', v_drivers, 'upcoming_rides', v_upcoming,
    'message', case when v_upcoming > 0
      then private.fr_typo(format('Statut enregistré. %s %s à venir %s attribuée%s : la centrale ne peut pas la%s servir tant qu''elle n''est pas réactivée.',
        v_upcoming, private.pl(v_upcoming, 'course', 'courses'), private.pl(v_upcoming, 'reste', 'restent'),
        case when v_upcoming > 1 then 's' else '' end, case when v_upcoming > 1 then 's' else '' end))
      else 'Statut enregistré.' end);
end;
$$;

-- ----------------------------------------------------------------- 11. conditions de paiement (super-admin-6)
-- Dernière définition : 20260924006600_platform_fee_schedule. Signature changée (p_consent_note) → drop + droits
-- refaits. Changement en défaveur de l'organisation (délai raccourci, mensuel → hebdomadaire, blocage ajouté ou plus
-- tôt) : accord écrit de l'organisation noté obligatoire (CONSENT_REQUIRED, CGV art. 5), journalisé en « warning ».
drop function if exists public.svc_platform_terms(uuid, uuid, text, integer, integer);
create function public.svc_platform_terms(
  p_org uuid,
  p_actor uuid,
  p_cycle text,
  p_payment_days integer,
  p_block_after_days integer default null,
  p_consent_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  v_note text := left(nullif(btrim(coalesce(p_consent_note, '')), ''), 500);
  v_unfavorable boolean;
begin
  perform private.assert_platform_actor(p_actor);
  select * into o from public.organizations where id = p_org for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Organisation introuvable.');
  end if;
  if p_cycle is null or p_cycle not in ('weekly', 'monthly') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CYCLE', 'message', 'Cycle invalide (hebdomadaire ou mensuel).');
  end if;
  if p_payment_days is null or p_payment_days not between 0 and 45 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DAYS',
      'message', private.fr_typo('Délai de paiement : entre 0 et 45 jours (facture récapitulative, article L441-10 du Code de commerce).'));
  end if;
  if p_block_after_days is not null and p_block_after_days not between 1 and 90 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_BLOCK', 'message', private.fr_typo('Blocage : entre 1 et 90 jours de retard.'));
  end if;
  v_unfavorable := p_payment_days < o.platform_payment_days
    or (o.platform_billing_cycle = 'monthly' and p_cycle = 'weekly')
    or (p_block_after_days is not null
        and (o.platform_block_after_days is null or p_block_after_days < o.platform_block_after_days));
  if v_unfavorable and (v_note is null or char_length(v_note) < 3) then
    return jsonb_build_object('ok', false, 'code', 'CONSENT_REQUIRED', 'field', 'consentNote',
      'message', private.fr_typo('Changement en défaveur de l''organisation (délai raccourci, cycle hebdomadaire, blocage ajouté ou plus tôt) : notez son accord écrit (CGV, article 5).'));
  end if;
  perform private.set_actor('super_admin', p_actor);
  update public.organizations
     set platform_billing_cycle = p_cycle, platform_payment_days = p_payment_days, platform_block_after_days = p_block_after_days
   where id = p_org;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, 'super_admin', p_actor, 'platform_fee.terms_changed', 'organizations', p_org::text,
    case when v_unfavorable then 'warning' else 'info' end,
    jsonb_build_object(
      'before', jsonb_build_object('cycle', o.platform_billing_cycle, 'payment_days', o.platform_payment_days,
        'block_after_days', o.platform_block_after_days),
      'after', jsonb_build_object('cycle', p_cycle, 'payment_days', p_payment_days, 'block_after_days', p_block_after_days),
      'unfavorable', v_unfavorable, 'consent_note', case when v_unfavorable then v_note end));
  perform private.broadcast_platform(p_org, 'terms');
  return jsonb_build_object('ok', true, 'code', 'SAVED',
    'message', 'Conditions enregistrées (les frais déjà enregistrés gardent leur échéance).');
end;
$$;

-- ----------------------------------------------------------------- 12. vue d'ensemble des centrales (super-admin-10)
-- Dernière définition : 20260924003100_platform_fees_review. Seul changement : « Frais du mois »
-- (platform_fee_cents) = écritures COMPTÉES du registre (platform_fee_entries « posted », occurred_at dans le mois),
-- comme /admin/frais — plus la somme des frais recalculés sur les courses (écart après une baisse en attente ou refusée).
create or replace function public.admin_centrale_overview(p_from timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from timestamptz := coalesce(p_from, date_trunc('month', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris');
  v_to timestamptz;
  v_orgs jsonb;
begin
  if not private.is_super_admin() then
    raise exception 'FORBIDDEN: réservé au super admin' using errcode = '42501';
  end if;
  v_to := ((v_from at time zone 'Europe/Paris') + interval '1 month') at time zone 'Europe/Paris';

  select coalesce(jsonb_agg(t.j order by t.name), '[]'::jsonb) into v_orgs
  from (
    select o.name, jsonb_build_object(
        'id', o.id,
        'name', o.name,
        'slug', o.slug,
        'status', o.status,
        'platform_fee_percent', o.platform_fee_percent,
        'platform_fee_fixed_cents', o.platform_fee_fixed_cents,
        'join_enabled', o.join_enabled,
        'join_auto_approve', o.join_auto_approve,
        'drivers_active', (select count(*) from public.drivers d where d.organization_id = o.id and d.status = 'active'),
        'applications_pending', (select count(*) from public.drivers d
                                 where d.organization_id = o.id and d.application_status = 'pending'),
        'drivers_banned', (select count(*) from public.drivers d where d.organization_id = o.id and d.banned_at is not null),
        'rides', coalesce(m.rides, 0),
        'volume_cents', coalesce(m.volume, 0),
        'commission_cents', coalesce(m.commission, 0),
        'platform_fee_cents', (select coalesce(sum(e.amount_cents), 0) from public.platform_fee_entries e
                               where e.organization_id = o.id and e.status = 'posted'
                                 and e.occurred_at >= v_from and e.occurred_at < v_to),
        'outstanding_cents', (select coalesce(sum(x.amount_cents), 0) from public.ride_settlements x
                              where x.organization_id = o.id and x.direction = 'driver_owes'
                                and x.status in ('due', 'declared', 'disputed')),
        'overdue_cents', (select coalesce(sum(x.amount_cents), 0) from public.ride_settlements x
                          where x.organization_id = o.id and x.direction = 'driver_owes'
                            and (x.status = 'disputed' or (x.status = 'due' and x.due_at <= now()))),
        'platform_balance_cents', a.posted_cents - a.received_cents,
        'platform_due_cents', a.due_cents,
        'platform_declared_cents', a.declared_cents,
        'platform_overdue_since', a.overdue_since) as j
    from public.organizations o
    cross join lateral private.platform_position(o.id) a
    left join lateral (
      select count(*) as rides, sum(y.price_cents) as volume, sum(y.commission_cents) as commission,
             sum(y.platform_fee_cents) as fees
      from public.rides y
      where y.organization_id = o.id and y.status = 'COMPLETED' and y.completed_at >= v_from and y.completed_at < v_to
        and y.driver_payout_cents is not null
    ) m on true
    where o.dispatch_model = 'centrale' and o.status <> 'archived'
  ) t;

  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'organizations', v_orgs,
    'totals', jsonb_build_object(
      'centrales', jsonb_array_length(v_orgs),
      'rides', (select coalesce(sum((e ->> 'rides')::bigint), 0) from jsonb_array_elements(v_orgs) e),
      'volume_cents', (select coalesce(sum((e ->> 'volume_cents')::bigint), 0) from jsonb_array_elements(v_orgs) e),
      'platform_fee_cents', (select coalesce(sum((e ->> 'platform_fee_cents')::bigint), 0) from jsonb_array_elements(v_orgs) e),
      'platform_due_cents', (select coalesce(sum((e ->> 'platform_due_cents')::bigint), 0) from jsonb_array_elements(v_orgs) e),
      'platform_balance_cents', (select coalesce(sum(greatest(0, (e ->> 'platform_balance_cents')::bigint)), 0)
                                 from jsonb_array_elements(v_orgs) e)),
    'reports_open', (select count(*) from public.fraud_reports f where f.status = 'open'),
    'platform_bans', (select count(*) from public.banned_identities b where b.scope = 'platform' and b.lifted_at is null)
  );
end;
$$;

-- ----------------------------------------------------------------- 13. worker (worker-perf-2, -5, -7)
-- Dernière définition : 20260924003300_live_position. Seul changement : offres GPS (« ride_offer ») en
-- tête, avant les offres planifiées à toute la flotte (aussi « high ») : une rafale planifiée ne retarde plus une
-- course immédiate.
create or replace function private.claim_notifications(p_limit integer default 100)
returns table (
  id uuid,
  organization_id uuid,
  driver_id uuid,
  ride_id uuid,
  type text,
  title text,
  body text,
  data jsonb,
  priority text,
  attempts smallint,
  tokens jsonb
)
language sql
security definer
set search_path = ''
as $$
  -- worker arrêté en plein envoi : on remet en file après 2 min
  update public.notifications n
     set status = 'queued', last_error = 'worker_interrupted'
   where n.status = 'sending'
     and coalesce(n.claimed_at, n.created_at) < now() - interval '2 minutes';

  -- Réveil GPS silencieux périmé (plus d'une minute) : le suivant, s'il faut, est émis par watch_driver_gps
  update public.notifications n
     set status = 'cancelled', last_error = 'wake_expired'
   where n.status = 'queued'
     and n.type = 'location_ping'
     and n.created_at < now() - interval '1 minute';

  with stale as (
    update public.notifications n
       set status = 'cancelled', last_error = 'offer_closed'
      from public.ride_offers o
     where n.status = 'queued'
       and n.offer_id = o.id
       and n.type in ('ride_offer', 'ride_offer_scheduled')
       and o.status <> 'pending'
    returning n.id
  ),
  due as (
    select n.id
    from public.notifications n
    where n.status = 'queued'
      and n.channel = 'push'
      and n.scheduled_for <= now()
      and not exists (select 1 from stale s where s.id = n.id)
    order by n.type = 'ride_offer' desc, n.priority = 'high' desc, n.scheduled_for
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update public.notifications n
       set status = 'sending', attempts = n.attempts + 1, claimed_at = now()
      from due
     where n.id = due.id
    returning n.*
  )
  select c.id, c.organization_id, c.driver_id, c.ride_id, c.type, c.title, c.body, c.data, c.priority, c.attempts,
         coalesce((
           select jsonb_agg(jsonb_build_object('token', t.token, 'provider', t.provider, 'platform', t.platform))
           from public.push_tokens t
           where t.driver_id = c.driver_id and t.is_active
         ), '[]'::jsonb) as tokens
  from claimed c;
$$;

-- Dernière définition : 20260924003200_dispatch_strict_waves. Seul changement : positions lues dans la centrale
-- de la course (l.organization_id, index driver_locations_org_idx) au lieu de toutes les positions fraîches de la
-- plateforme (même résultat : clé étrangère composite organisation + chauffeur).
create or replace function private.run_geo_wave(p_ride_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  s public.organization_settings;
  v_plan integer[];
  v_n integer;
  v_wave integer;
  v_radius integer;
  v_relance boolean;
  v_online integer;
  v_eligible integer;
  v_blocked integer := 0;
  v_count integer := 0;
  v_pending integer := 0;
  v_drivers uuid[] := '{}';
  v_timeout interval;
  v_window interval;
  v_max_accuracy constant real := 1500;
  v_from text;
  v_to text;
  v_centrale boolean;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.status not in ('SEARCHING_DRIVER', 'OFFERED') or r.driver_id is not null then
    return 0;
  end if;

  select * into s from public.organization_settings where organization_id = r.organization_id;
  select coalesce(o.dispatch_model = 'centrale', false) into v_centrale from public.organizations o where o.id = r.organization_id;
  v_plan := private.dispatch_plan(s.dispatch_radii_m, s.dispatch_retry_radii_m);
  v_n := private.dispatch_first_pass(s.dispatch_radii_m);
  v_wave := r.dispatch_wave + 1;
  -- Séquence terminée : private.dispatch_tick conclut (NO_DRIVER_FOUND)
  if v_wave > cardinality(v_plan) then
    return 0;
  end if;
  v_radius := v_plan[v_wave];
  v_relance := v_wave > v_n;
  v_timeout := make_interval(secs => coalesce(s.offer_timeout_seconds, 30));
  v_window := private.dispatch_location_window(s.location_max_age_seconds);
  v_from := coalesce(private.short_address(r.pickup_address), r.pickup_address);
  v_to := coalesce(private.short_address(r.dropoff_address), r.dropoff_address);

  -- Journalisé une fois par recherche
  if v_wave = 1 then
    select count(*) into v_online
    from public.drivers d
    join public.driver_locations l on l.driver_id = d.id and l.organization_id = r.organization_id
    where d.organization_id = r.organization_id
      and d.status = 'active'
      and d.presence <> 'offline'
      and l.updated_at > now() - v_window;
    perform private.log_event(r.organization_id, r.id, 'dispatch.online',
      format('%s %s en ligne', v_online, private.pl(v_online, 'chauffeur', 'chauffeurs')),
      'timeline', 'info', jsonb_build_object('online', v_online), 'system', null);
  end if;

  perform private.log_event(r.organization_id, r.id, 'dispatch.search',
    case when v_relance
         then format('Relance — rayon %s (vague %s)', private.fmt_km(v_radius), v_wave)
         else format('Recherche GPS — rayon %s (vague %s)', private.fmt_km(v_radius), v_wave) end,
    'timeline', 'info', jsonb_build_object('wave', v_wave, 'radius_m', v_radius, 'relance', v_relance), 'system', null);

  select count(*) filter (where (case when v_centrale then private.centrale_blocker(d.id, d.trust_level, r.price_cents,
                            s.block_unpaid, s.settlement_credit_limit_cents, s.new_driver_max_price_cents) end) is null),
         count(*) filter (where (case when v_centrale then private.centrale_blocker(d.id, d.trust_level, r.price_cents,
                            s.block_unpaid, s.settlement_credit_limit_cents, s.new_driver_max_price_cents) end) is not null)
    into v_eligible, v_blocked
  from public.drivers d
  join public.driver_locations l on l.driver_id = d.id and l.organization_id = r.organization_id
  left join public.vehicles v on v.id = d.vehicle_id
  where d.organization_id = r.organization_id
    and d.status = 'active'
    and d.presence = 'available'
    and l.updated_at > now() - v_window
    and coalesce(l.accuracy_m, 0) <= v_max_accuracy
    and private.category_compatible(r.vehicle_category, v.category, s.allow_category_upgrade)
    and coalesce(v.seats, 0) >= r.passengers;

  perform private.log_event(r.organization_id, r.id, 'dispatch.eligible',
    format('%s %s', v_eligible, private.pl(v_eligible, 'chauffeur disponible et compatible', 'chauffeurs disponibles et compatibles'))
      || case when v_blocked > 0
              then format(' · %s %s par les règles de la centrale', v_blocked, private.pl(v_blocked, 'exclu', 'exclus'))
              else '' end,
    'dispatch', 'debug',
    jsonb_build_object('eligible', v_eligible, 'blocked', v_blocked, 'category', r.vehicle_category,
      'passengers', r.passengers, 'upgrade', s.allow_category_upgrade, 'location_window_s', extract(epoch from v_window)::integer),
    'system', null);

  with candidates as (
    select d.id as driver_id,
           round(extensions.st_distance(l.location, r.pickup_location))::integer as distance_m,
           -- déjà sollicité pendant cette recherche : la relance le lui re-propose
           exists (select 1 from public.ride_offers p
                    where p.ride_id = r.id and p.driver_id = d.id and p.sent_at >= r.dispatch_started_at) as again
    from public.drivers d
    join public.driver_locations l on l.driver_id = d.id and l.organization_id = r.organization_id
    left join public.vehicles v on v.id = d.vehicle_id
    where d.organization_id = r.organization_id
      and d.status = 'active'
      and d.presence = 'available'
      -- dernière position connue, tant que le chauffeur est en ligne (application fermée, téléphone verrouillé)
      and l.updated_at > now() - v_window
      and coalesce(l.accuracy_m, 0) <= v_max_accuracy
      and extensions.st_dwithin(l.location, r.pickup_location, v_radius)
      and private.category_compatible(r.vehicle_category, v.category, s.allow_category_upgrade)
      and coalesce(v.seats, 0) >= r.passengers
      -- mode centrale : commission en retard, plafond d'encours, prix au-dessus du plafond « nouveau »
      and (case when v_centrale then private.centrale_blocker(d.id, d.trust_level, r.price_cents,
             s.block_unpaid, s.settlement_credit_limit_cents, s.new_driver_max_price_cents) end) is null
      and not exists (
        select 1 from public.ride_offers o
        where o.ride_id = r.id
          and o.driver_id = d.id
          and (
            o.status in ('pending', 'declined')
            -- retiré par la centrale (reassign_ride) : plus jamais sollicité pour cette course
            or o.closed_reason = 'removed_by_dispatch'
            -- premier passage : une seule sonnerie par chauffeur (hors offre expirée pour une autre raison
            -- qu'une absence de réponse, ex. repassé en ligne) ; la relance re-sonne les offres sans réponse
            or (not v_relance and o.sent_at >= r.dispatch_started_at and (o.status <> 'expired' or o.closed_reason = 'ignored'))
          )
      )
    order by distance_m
    limit coalesce(s.max_offers_per_wave, 25)
  ),
  ins as (
    insert into public.ride_offers (organization_id, ride_id, driver_id, status, mode, wave, radius_m, distance_m, expires_at)
    select r.organization_id, r.id, c.driver_id, 'pending', 'geo', v_wave, v_radius, c.distance_m, now() + v_timeout
    from candidates c
    returning id, driver_id, distance_m
  ),
  notif as (
    insert into public.notifications (organization_id, driver_id, ride_id, offer_id, type, title, body, data, priority)
    select r.organization_id, i.driver_id, r.id, i.id, 'ride_offer',
           case when c.again then 'COURSE TOUJOURS DISPONIBLE' else 'NOUVELLE COURSE' end,
           case when v_centrale and r.driver_payout_cents is not null
                then format('%s → %s · %s du client · Vous gagnez %s (course %s)', v_from, v_to,
                       private.fmt_km(i.distance_m), private.fmt_eur(r.driver_payout_cents), private.fmt_eur(r.price_cents))
                else format('%s → %s · %s du client · %s', v_from, v_to, private.fmt_km(i.distance_m),
                       private.fmt_eur(r.price_cents))
           end,
           jsonb_build_object(
             'type', 'ride_offer', 'offer_id', i.id, 'ride_id', r.id, 'ride_type', r.type,
             'pickup', r.pickup_address, 'dropoff', r.dropoff_address, 'price_cents', r.price_cents,
             'distance_m', i.distance_m, 'passengers', r.passengers, 'expires_at', now() + v_timeout,
             'driver_payout_cents', r.driver_payout_cents, 'commission_cents', r.commission_cents,
             'platform_fee_cents', r.platform_fee_cents),
           'high'
    from ins i
    join candidates c on c.driver_id = i.driver_id
    returning 1
  )
  select count(*)::integer, coalesce(array_agg(i.driver_id), '{}') into v_count, v_drivers from ins i;

  select count(*) into v_pending from public.ride_offers o where o.ride_id = r.id and o.status = 'pending' and o.mode = 'geo';

  perform private.log_event(r.organization_id, r.id, 'dispatch.candidates',
    case when v_pending > v_count
         then format('%s %s à moins de %s, dont %s %s', v_pending,
                private.pl(v_pending, 'chauffeur sollicité', 'chauffeurs sollicités'), private.fmt_km(v_radius),
                v_count, private.pl(v_count, 'nouveau', 'nouveaux'))
         else format('%s %s à moins de %s', v_count, private.pl(v_count, 'chauffeur', 'chauffeurs'), private.fmt_km(v_radius))
    end,
    'timeline', case when v_count > 0 or v_pending > 0 then 'info' else 'warning' end::public.event_level,
    jsonb_build_object('candidates', v_count, 'pending', v_pending, 'radius_m', v_radius, 'wave', v_wave,
      'relance', v_relance, 'driver_ids', to_jsonb(v_drivers)),
    'system', null);

  if v_count > 0 then
    update public.drivers
       set presence = 'offered'
     where id in (
       select x.id from public.drivers x
       where x.id = any (v_drivers) and x.presence = 'available'
       order by x.id
       for update
     );

    perform private.log_event(r.organization_id, r.id, 'dispatch.notified',
      format('%s %s', v_count, private.pl(v_count, 'notification envoyée', 'notifications envoyées')),
      'timeline', 'success', jsonb_build_object('count', v_count, 'expires_in_s', coalesce(s.offer_timeout_seconds, 30)), 'system', null);
    perform pg_notify('rydar_notifications', r.id::text);
  end if;

  -- La vague dure son délai complet, même sans chauffeur (la suivante n'est pas lancée tout de suite)
  update public.rides
     set dispatch_wave = v_wave,
         dispatch_radius_m = v_radius,
         status = case when v_pending > 0 then 'OFFERED' else 'SEARCHING_DRIVER' end::public.ride_status,
         offered_at = case when v_pending > 0 then coalesce(offered_at, now()) else offered_at end,
         next_dispatch_at = now() + v_timeout
   where id = r.id;

  return v_count;
end;
$$;

-- Prise des webhooks : avec peu d'envois « pending » dans les statistiques, le planificateur relisait par cet index
-- tout l'arriéré dû de la plateforme pour CHAQUE adresse ; sans lui, chaque adresse passe par
-- webhook_deliveries_endpoint_open_idx (endpoint_id, occurred_at, id) — aucun autre usage (la suite joint par id).
drop index if exists public.webhook_deliveries_due_idx;

-- ----------------------------------------------------------------- droits des fonctions nouvelles ou de signature changée
revoke all on function private.platform_unassign_ride(uuid, text, uuid) from public, anon, authenticated;
grant execute on function private.platform_unassign_ride(uuid, text, uuid) to service_role;
revoke all on function public.svc_platform_set_org_status(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.svc_platform_set_org_status(uuid, uuid, text, text) to service_role;
revoke all on function public.svc_platform_terms(uuid, uuid, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.svc_platform_terms(uuid, uuid, text, integer, integer, text) to service_role;
