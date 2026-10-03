-- =============================================================================
-- Rydar Drive — Réseau partagé, lot 7 : corrections transverses (relecture adverse de 006700 à 007100, cycle complet,
-- balayage des fuites, temps réel). Interrupteur plateforme COUPÉ : comportement strictement identique tant qu'il
-- l'est (chaque branche ajoutée exige une course, une offre ou une ligne réseau).
--
--  1. Signalement routier pendant une course partenaire (Q5, §11.6, résidu du lot 5b) : un chauffeur qui tient une
--     course d'une autre organisation ne publie pas de signalement sur le fil flotte de la sienne (sa position y
--     serait lue) et aucun de ses messages n'y porte de coordonnées (NETWORK_RIDE_REPORT_BLOCKED). Déclencheur sur
--     chat_messages : public.send_chat_message (004100) reste inchangée.
--
-- Supabase hébergé : rien sur auth.*, storage.*, realtime.messages.
-- =============================================================================

-- =============================================================================
-- 1. Signalements routiers pendant une course partenaire
-- =============================================================================
-- Seule voie d'écriture : public.send_chat_message (definer) et le service role ; private.driver_on_foreign_ride (006700,
-- definer, interrupteur coupé : toujours faux) lit la course en cours du chauffeur.
create or replace function private.chat_messages_network_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.driver_on_foreign_ride(new.author_driver_id) then
    if new.report_type is not null then
      raise exception 'NETWORK_RIDE_REPORT_BLOCKED: pas de signalement pendant une course confiée par une autre organisation (votre position n''est pas partagée avec votre flotte pendant cette course)'
        using errcode = '55000';
    end if;
    new.lat := null;
    new.lng := null;
  end if;
  return new;
end;
$$;
revoke all on function private.chat_messages_network_guard() from public, anon, authenticated;

create trigger chat_messages_network_guard
  before insert on public.chat_messages
  for each row
  when (new.author_driver_id is not null)
  execute function private.chat_messages_network_guard();
