-- =============================================================================
-- Contre-audit « app » (app_worker#2) : commissions encore dues rappelées avant la suppression du compte, quel que
-- soit l'état du chauffeur ou de sa centrale. driver_settlements les refuse à un chauffeur suspendu, banni ou
-- désactivé, ou d'une centrale suspendue (private.current_driver_id exige une fiche et une centrale actives), et rien
-- n'était lisible sans session (« Supprimer mon compte » depuis l'écran de connexion, par e-mail + mot de passe) —
-- alors que la suppression reste ouverte à ces comptes et que leurs empreintes sont gardées tant qu'une somme reste
-- due (private.debtor_identities).
--  * public.driver_deletion_debt() : le chauffeur connecté (jeton de l'app, auth.uid()), SA fiche seulement ;
--  * public.svc_driver_deletion_debt(p_user_id) : service role — route /api/driver/delete-account en mode aperçu,
--    compte vérifié par la route (jeton ou e-mail + mot de passe), rien n'est supprimé.
-- =============================================================================

-- Montants dus par la fiche chauffeur (non supprimée) du compte de connexion : même périmètre que
-- private.driver_open_debt (règlements driver_owes à régler, contestés ou signalés payés, montant non nul), la part
-- signalée payée à part. null : aucune fiche chauffeur pour ce compte.
create or replace function private.driver_deletion_debt(p_user_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
      'owed_cents', coalesce(sum(s.amount_cents) filter (where s.status in ('due', 'disputed')), 0),
      'declared_cents', coalesce(sum(s.amount_cents) filter (where s.status = 'declared'), 0),
      'currency', o.currency,
      'organization', o.name)
    from public.drivers d
    join public.organizations o on o.id = d.organization_id
    left join public.ride_settlements s
      on s.driver_id = d.id
     and s.direction = 'driver_owes'
     and s.status in ('due', 'declared', 'disputed')
     and s.amount_cents > 0
   where p_user_id is not null
     and d.user_id = p_user_id
     and d.deleted_at is null
   group by d.id, o.currency, o.name;
$$;

-- Application : le compte connecté, sans exiger une fiche ni une centrale actives. Aucun paramètre : un chauffeur ne
-- lit que sa propre dette.
create or replace function public.driver_deletion_debt()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.driver_deletion_debt(auth.uid());
$$;

-- Route de suppression (aperçu), après vérification du compte par la route.
create or replace function public.svc_driver_deletion_debt(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.driver_deletion_debt(p_user_id);
$$;

revoke execute on function private.driver_deletion_debt(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.driver_deletion_debt() from public, anon;
grant execute on function public.driver_deletion_debt() to authenticated;
revoke execute on function public.svc_driver_deletion_debt(uuid) from public, anon, authenticated;
grant execute on function public.svc_driver_deletion_debt(uuid) to service_role;
