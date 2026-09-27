-- =============================================================================
-- Rydar Drive — Suppression du compte chauffeur depuis l'application (App Store 5.1.1(v), Google Play).
--
-- Appelée par la route web /api/driver/delete-account (service role) avec l'utilisateur du jeton :
--  * refusée tant qu'une course est attribuée au chauffeur (terminer ou faire réattribuer par la centrale) ;
--  * données personnelles SUPPRIMÉES : appareils, jetons push, positions et historique GPS, justificatifs
--    (lignes ; les fichiers sont supprimés du stockage par la route), messages et accusés de lecture,
--    notifications ; fiche chauffeur ANONYMISÉE (nom, téléphone, e-mail, carte VTC, notes, candidature),
--    journal d'audit du chauffeur caviardé ;
--  * conservé sans identité (obligations comptables et légales) : courses, règlements, gains, frais ;
--    identités bannies (empreintes sha256, lutte contre la fraude) ;
--  * la route supprime ensuite le compte d'authentification (public.users suit, drivers.user_id → null).
-- =============================================================================

alter table public.drivers add column if not exists deleted_at timestamptz;

create or replace function public.svc_delete_driver_account(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_rides integer;
  v_files text[];
  v_key text;
begin
  select * into d from public.drivers where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_DRIVER', 'message', 'Aucun compte chauffeur associé.');
  end if;
  if d.deleted_at is not null then
    return jsonb_build_object('ok', true, 'code', 'DELETED', 'files', '[]'::jsonb, 'driver_id', d.id);
  end if;

  select count(*) into v_rides from public.rides r
  where r.driver_id = d.id
    and r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS');
  if v_rides > 0 or d.current_ride_id is not null then
    return jsonb_build_object('ok', false, 'code', 'RIDES_ASSIGNED', 'count', greatest(v_rides, 1),
      'message', case when v_rides > 1
        then format('Vous avez %s courses attribuées : terminez-les ou demandez à votre centrale de les réattribuer, puis supprimez votre compte.', v_rides)
        else 'Vous avez une course attribuée : terminez-la ou demandez à votre centrale de la réattribuer, puis supprimez votre compte.' end);
  end if;

  perform private.set_actor('driver', d.id);
  v_key := 'driver:' || d.id::text;

  -- Offres en attente closes (le chauffeur ne peut plus répondre)
  update public.ride_offers
     set status = 'closed', closed_reason = 'driver_deleted', responded_at = now()
   where driver_id = d.id and status = 'pending';

  -- Justificatifs : chemins rendus à la route (suppression des fichiers), lignes supprimées
  select coalesce(array_agg(x.file_path) filter (where x.file_path is not null), '{}') into v_files
  from public.driver_documents x where x.driver_id = d.id;
  delete from public.driver_documents where driver_id = d.id;

  delete from public.push_tokens where driver_id = d.id;
  delete from public.driver_devices where driver_id = d.id;
  delete from public.driver_locations where driver_id = d.id;
  delete from public.driver_location_history where driver_id = d.id;
  delete from public.notifications where driver_id = d.id;
  delete from public.chat_report_votes where voter_key = v_key;
  delete from public.chat_reads where reader_key = v_key or thread_key = v_key;
  delete from public.chat_messages where driver_id = d.id or author_driver_id = d.id;

  -- Fiche anonymisée : conservée pour les courses et règlements passés (sans identité)
  update public.drivers
     set first_name = 'Chauffeur',
         last_name = 'supprimé',
         phone = '',
         email = null,
         photo_url = null,
         vtc_card_number = null,
         notes = null,
         application_message = null,
         application_note = null,
         suspended_reason = 'Compte supprimé par le chauffeur',
         status = 'inactive',
         presence = 'offline',
         online_since = null,
         last_seen_at = null,
         current_ride_id = null,
         vehicle_id = null,
         deleted_at = now()
   where id = d.id;

  -- Journal d'audit du chauffeur : valeurs personnelles retirées (l'action reste tracée)
  update public.audit_logs
     set metadata = jsonb_build_object('redacted', true)
   where entity_type = 'drivers' and entity_id = d.id::text;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (d.organization_id, 'driver', null, 'driver.deleted', 'drivers', d.id::text, 'warning',
    jsonb_build_object('number', d.number, 'documents', cardinality(v_files)));

  perform private.log_event(d.organization_id, null, 'driver.deleted',
    format('Le chauffeur #%s a supprimé son compte', d.number),
    'system', 'warning', jsonb_build_object('driver_id', d.id), 'driver', d.id);

  return jsonb_build_object('ok', true, 'code', 'DELETED', 'files', to_jsonb(v_files), 'driver_id', d.id);
end;
$$;

revoke execute on function public.svc_delete_driver_account(uuid) from public, anon, authenticated;
grant execute on function public.svc_delete_driver_account(uuid) to service_role;
