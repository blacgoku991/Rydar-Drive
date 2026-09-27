-- =============================================================================
-- Rydar Drive — Registre des frais plateforme : jamais supprimé avec la centrale.
--
--  * platform_fee_entries et platform_payments → organizations : « on delete restrict » (au lieu de « cascade »,
--    20260924003000, publiée). Ce sont les pièces comptables de Rydar (conservation 10 ans), pas des données de la
--    centrale : supprimer une centrale qui a des frais ou des paiements est refusé (23503), comme une centrale qui a
--    accepté les CGV (legal_acceptances, 20260924003900). Fin de contrat : archiver la centrale (/admin, « Archiver »),
--    puis supprimer ses données opérationnelles (docs/DEPLOYMENT.md). private.platform_entry_guard refusait déjà la
--    suppression d'une écriture tant que la centrale existe : le registre n'a plus aucun chemin de suppression.
--    Le lien vers une course purgée au bout de 10 ans (private.housekeeping) reste « on delete set null (ride_id) ».
--  * Relances WhatsApp (20260924003700, publiée) : helpers private sans security definer (CLAUDE.md). Ils ne sont
--    appelés que par des RPC security definer ou par le worker (propriétaire des fonctions) ; droits d'exécution
--    inchangés (service role seulement, jamais les clients).
-- =============================================================================

-- ----------------------------------------------------------------- registre et paiements : restrict
-- Noms exacts (pas de « if exists ») : une contrainte « cascade » restée en place sous un autre nom ferait échouer
-- la migration au lieu de laisser le registre supprimable.
alter table public.platform_fee_entries
  drop constraint platform_fee_entries_organization_id_fkey,
  add constraint platform_fee_entries_organization_id_fkey
    foreign key (organization_id) references public.organizations (id) on delete restrict;

alter table public.platform_payments
  drop constraint platform_payments_organization_id_fkey,
  add constraint platform_payments_organization_id_fkey
    foreign key (organization_id) references public.organizations (id) on delete restrict;

comment on constraint platform_fee_entries_organization_id_fkey on public.platform_fee_entries is
  'Registre de Rydar conservé : centrale avec des frais non supprimable (l''archiver).';
comment on constraint platform_payments_organization_id_fkey on public.platform_payments is
  'Paiements reçus par Rydar conservés : centrale avec des paiements non supprimable (l''archiver).';

-- ----------------------------------------------------------------- WhatsApp : helpers private sans definer
alter function private.whatsapp_ready(text, uuid) security invoker;
alter function private.queue_whatsapp(uuid, uuid, uuid, text, text, text, text, text, text[], jsonb) security invoker;
alter function private.remind_driver(uuid, uuid, text[], text, text, text, jsonb, text[]) security invoker;
alter function private.platform_whatsapp_target(uuid) security invoker;
alter function private.claim_whatsapp(integer) security invoker;
alter function private.complete_whatsapp(uuid, boolean, text, text, boolean) security invoker;

-- ----------------------------------------------------------------- signalement de fraude classé : auteur vérifié
-- Dernière définition : 20260924002600. Seul un super admin peut classer un signalement (comme svc_platform_ban).
create or replace function public.svc_platform_dismiss_report(p_report_id uuid, p_actor uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.fraud_reports;
begin
  perform private.assert_platform_actor(p_actor);
  select * into f from public.fraud_reports where id = p_report_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Signalement introuvable.');
  end if;
  if f.status <> 'open' then
    return jsonb_build_object('ok', false, 'code', 'NOT_OPEN', 'message', 'Signalement déjà traité.');
  end if;
  update public.fraud_reports
     set status = 'dismissed', reviewed_by = p_actor, reviewed_at = now(),
         review_note = left(nullif(btrim(coalesce(p_note, '')), ''), 500)
   where id = f.id;
  return jsonb_build_object('ok', true, 'code', 'DISMISSED', 'message', 'Signalement classé : bannissement limité à la centrale.');
end;
$$;
