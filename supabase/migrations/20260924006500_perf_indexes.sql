-- =============================================================================
-- Rydar Drive — performances (audit 10/2026) : index des lectures fréquentes d'une centrale + compteurs légers du
-- menu « Messages ».
--
-- Index créés SANS « concurrently » : deploy/migrate.sh applique chaque fichier en une seule transaction (psql -1), où
-- CREATE INDEX CONCURRENTLY échoue. Le verrou d'écriture sur la table dure le temps de la création (moins d'une seconde
-- aux volumes actuels).
-- =============================================================================

-- Courses non terminées d'une centrale. Sans cet index, org_kpis et org_ride_counts lisent TOUTE la table rides
-- (toutes centrales : le OR « pickup_at >= … or status not in (…) » empêche rides_org_pickup_idx) et le centre de
-- commande (lib/queries/live.ts : « pickup_at <= horizon and not status in (…) ») parcourt tout l'historique de la
-- centrale. Le prédicat reprend mot pour mot celui des fonctions (constantes : utilisable aussi en plan générique).
create index if not exists rides_org_open_pickup_idx on public.rides (organization_id, pickup_at)
  where status not in ('COMPLETED', 'CANCELLED', 'NO_DRIVER_FOUND');

-- Offres d'une centrale par date d'envoi (org_driver_metrics de la page Chauffeurs, org_stats) : plus de lecture
-- complète de ride_offers, la table qui grossit le plus vite (une offre par chauffeur pour une planifiée en flotte).
create index if not exists ride_offers_org_sent_idx on public.ride_offers (organization_id, sent_at);

-- Journal d'une centrale du plus récent au plus ancien (journal du dispatch, fiche super admin d'une organisation :
-- « organization_id = … order by id desc limit … ») : sans lui, la clé primaire est parcourue à rebours en filtrant les
-- événements de toutes les autres centrales.
create index if not exists ride_events_org_id_idx on public.ride_events (organization_id, id);

-- -----------------------------------------------------------------------------
-- chat_counts : compteurs du menu « Messages » (mise en page du tableau de bord à chaque rendu, relecture après
-- chat.read / chat.moderation). Mêmes valeurs que chat_overview.unread_total et chat_overview.open_reports (dernière
-- définition : 20260924004100_chat_moderation.sql) sans construire la liste des fils (environ 157 Ko de JSON et 12 à
-- 35 ms pour 200 chauffeurs). chat_overview reste la lecture de la page Messages.
-- Même contrôle d'accès que chat_overview (membre de la centrale, ou super admin), mêmes messages comptés :
--  - fil flotte et un fil par chauffeur de la centrale (un message « driver » appartient toujours à un chauffeur de la
--    centrale : clé étrangère (organization_id, driver_id), chauffeurs inactifs compris) ;
--  - messages retirés exclus, messages de l'utilisateur exclus, postérieurs à SA dernière lecture du fil.
-- Un comptage indexé par fil (chat_messages_thread_idx) : le coût suit le nombre de chauffeurs et de non-lus, pas
-- l'historique des messages.
-- -----------------------------------------------------------------------------
create or replace function public.chat_counts(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_reader text;
  v_unread integer;
  v_open_reports integer;
begin
  perform private.assert_org_reader(p_org);
  if v_uid is null then
    raise exception 'FORBIDDEN: authentification requise' using errcode = '42501';
  end if;
  v_reader := 'user:' || v_uid::text;

  select (
      select count(*) from public.chat_messages x
       where x.organization_id = p_org and x.channel = 'fleet' and x.deleted_at is null
         and x.author_user_id is distinct from v_uid
         and x.created_at > coalesce((
           select r.last_read_at from public.chat_reads r
            where r.organization_id = p_org and r.reader_key = v_reader and r.thread_key = 'fleet'), '-infinity'::timestamptz)
    ) + (
      select coalesce(sum(c.n), 0)
        from public.drivers d
        left join public.chat_reads r
          on r.organization_id = p_org and r.reader_key = v_reader and r.thread_key = 'driver:' || d.id::text
       cross join lateral (
         select count(*) as n from public.chat_messages x
          where x.organization_id = p_org and x.channel = 'driver' and x.driver_id = d.id and x.deleted_at is null
            and x.author_user_id is distinct from v_uid
            and x.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
       ) c
       where d.organization_id = p_org
    )
    into v_unread;

  -- Messages du fil flotte signalés et pas encore traités (même requête que chat_overview)
  select count(distinct r.message_id) into v_open_reports
    from public.chat_message_reports r
    join public.chat_messages x on x.id = r.message_id
   where r.organization_id = p_org and r.status = 'open' and x.deleted_at is null;

  return jsonb_build_object('unread_total', v_unread, 'open_reports', v_open_reports);
end;
$$;

revoke execute on function public.chat_counts(uuid) from public, anon;
grant execute on function public.chat_counts(uuid) to authenticated, service_role;
