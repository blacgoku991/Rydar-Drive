-- =============================================================================
-- Audit « comptes » :
--  1. Compte PARTAGÉ (fiche chauffeur + gestion d'une centrale ou super admin) : svc_login_account_shared ; la
--     centrale du chauffeur ne ferme plus ses sessions (déclencheur, « Déconnecter ») ni ne change son mot de passe.
--  2. Retrait d'un membre : sessions fermées seulement si le compte n'a plus aucun autre accès ; une invitation
--     annulée (aucun accès) ne ferme rien.
--  3. Compte EXISTANT invité à gérer une centrale : adhésion « invited » (aucun accès, nom et téléphone non
--     exposés) activée par la personne elle-même, avec une session ouverte par le lien reçu par e-mail
--     (accept_member_invitations) ; aucune autre voie ne sort une adhésion de l'état « invited ».
--  4. Statut d'un chauffeur (activer / désactiver / suspendre) par RPC : courses non commencées remises en
--     recherche, refus si client à bord (set_driver_status).
-- =============================================================================

-- ----------------------------------------------------------------- 1. compte partagé
-- Compte de connexion qui sert aussi à GÉRER : adhésion ACTIVE à une centrale non archivée (suspendue comprise :
-- l'équipe doit pouvoir régler ses frais), ou super admin. Une simple invitation en attente ne compte pas (sinon une
-- centrale tierce pourrait, en invitant un chauffeur, empêcher sa propre centrale de fermer ses sessions).
-- Service role seulement (actions serveur) ; aussi utilisé par les RPC et le déclencheur ci-dessous.
create or replace function public.svc_login_account_shared(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null and (
    exists (select 1
              from public.organization_users m
              join public.organizations o on o.id = m.organization_id
             where m.user_id = p_user and m.status = 'active' and o.status <> 'archived')
    or exists (select 1 from public.users u where u.id = p_user and u.is_super_admin));
$$;

revoke all on function public.svc_login_account_shared(uuid) from public, anon, authenticated;
grant execute on function public.svc_login_account_shared(uuid) to service_role;

-- ----------------------------------------------------------------- 2. sessions : comptes partagés et membres épargnés
-- Dernière définition : 20260924004000_account_deletion_fixes.sql. Changements :
--  - drivers (et chauffeurs d'une organisation suspendue) : aucune révocation pour un compte partagé (ses sessions de
--    gestion restent ; la base coupe de toute façon l'accès chauffeur : private.current_driver_id exige une fiche
--    active d'une centrale active) ;
--  - organization_users : seul le retrait d'un accès ACTIF ferme les sessions, et seulement si le compte n'a plus
--    d'autre accès (autre centrale active, fiche chauffeur active ou candidature en attente, super admin), comme la
--    branche organizations. Une invitation supprimée ne ferme rien.
create or replace function private.revoke_sessions_on_access_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keep text := nullif(current_setting('rydar.keep_sessions', true), '');
begin
  if tg_table_name = 'drivers' then
    if tg_op = 'DELETE' then
      if not public.svc_login_account_shared(old.user_id) then
        perform private.revoke_user_sessions(old.user_id);
      end if;
    else
      if new.user_id is not null and old.status = 'active' and new.status <> 'active'
         and new.user_id::text is distinct from v_keep
         and not public.svc_login_account_shared(new.user_id) then
        perform private.revoke_user_sessions(new.user_id);
      end if;
      if old.user_id is not null and new.user_id is distinct from old.user_id
         and old.user_id::text is distinct from v_keep
         and not public.svc_login_account_shared(old.user_id) then
        perform private.revoke_user_sessions(old.user_id);
      end if;
    end if;

  elsif tg_table_name = 'organization_users' then
    if old.status = 'active' and (tg_op = 'DELETE' or new.status <> 'active')
       and not exists (
         select 1 from public.organization_users m2
         join public.organizations o2 on o2.id = m2.organization_id
         where m2.user_id = old.user_id and m2.id <> old.id and m2.status = 'active' and o2.status = 'active')
       and not exists (select 1 from public.users u where u.id = old.user_id and u.is_super_admin)
       and not exists (
         select 1 from public.drivers d
         join public.organizations o3 on o3.id = d.organization_id
         where d.user_id = old.user_id and d.deleted_at is null and o3.status = 'active'
           and (d.status = 'active' or d.application_status = 'pending')) then
      perform private.revoke_user_sessions(old.user_id);
    end if;

  elsif tg_table_name = 'organizations' then
    if old.status = 'active' and new.status <> 'active' then
      -- Chauffeurs de l'organisation (sauf compte partagé : ses membres sont traités juste en dessous, et la gestion
      -- d'une autre centrale ou de la plateforme n'est pas coupée)
      perform private.revoke_user_sessions(d.user_id)
        from public.drivers d
       where d.organization_id = new.id and d.user_id is not null
         and not public.svc_login_account_shared(d.user_id);
      -- Membres qui n'ont pas d'autre organisation active (ni rôle Super Admin)
      perform private.revoke_user_sessions(m.user_id)
        from public.organization_users m
       where m.organization_id = new.id
         and not exists (
           select 1 from public.organization_users m2
           join public.organizations o2 on o2.id = m2.organization_id
           where m2.user_id = m.user_id and m2.organization_id <> new.id
             and m2.status = 'active' and o2.status = 'active')
         and not exists (select 1 from public.users u where u.id = m.user_id and u.is_super_admin);
    end if;
  end if;
  return null;
end;
$$;

revoke execute on function private.revoke_sessions_on_access_change() from public, anon, authenticated, service_role;

-- « Déconnecter tous les appareils » (owner / admin).
-- Dernière définition : 20260924001300_session_revocation.sql. Ajout : refus pour un compte partagé (la centrale du
-- chauffeur ne ferme pas les sessions de gestion d'une autre centrale ou de la plateforme).
create or replace function public.revoke_driver_sessions(p_driver_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_count integer;
begin
  select * into d from public.drivers where id = p_driver_id;
  if not found then
    raise exception 'DRIVER_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform private.assert_org_member(d.organization_id, array['owner', 'admin']::public.org_role[]);
  if public.svc_login_account_shared(d.user_id) then
    return jsonb_build_object('ok', false, 'code', 'SHARED_ACCOUNT',
      'message', 'Ce compte sert aussi à gérer une centrale : ses sessions ne peuvent pas être fermées depuis la fiche chauffeur.');
  end if;
  v_count := private.revoke_user_sessions(d.user_id);
  update public.drivers set presence = 'offline', online_since = null
   where id = d.id and presence = 'available';
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (d.organization_id, 'user', auth.uid(), 'driver.sessions_revoked', 'drivers', d.id::text, 'warning',
          jsonb_build_object('revoked', v_count));
  return jsonb_build_object('ok', true, 'revoked', v_count);
end;
$$;

revoke execute on function public.revoke_driver_sessions(uuid) from public, anon;
grant execute on function public.revoke_driver_sessions(uuid) to authenticated, service_role;

-- ----------------------------------------------------------------- 3. invitations de membres (compte existant)
-- Une adhésion « invited » ne donne aucun accès (private.member_org_ids filtre « active »). Elle ne sort de cet état
-- que par accept_member_invitations (GUC local posé pour la personne invitée) ; l'annuler = la supprimer.
create or replace function private.organization_users_invitation_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'invited' and new.status is distinct from old.status
     and coalesce(current_setting('rydar.member_invite_accept', true), '') is distinct from old.user_id::text then
    raise exception 'INVITATION_PENDING: seule la personne invitée peut activer cet accès (lien reçu par e-mail)'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists organization_users_invitation_guard on public.organization_users;
create trigger organization_users_invitation_guard
  before update of status on public.organization_users
  for each row execute function private.organization_users_invitation_guard();

revoke execute on function private.organization_users_invitation_guard() from public, anon, authenticated;

-- Activation par la personne invitée : session ouverte par un lien ou un code reçu par e-mail (amr « otp » : lien de
-- réinitialisation en flux implicite ou code ; « recovery » / « invite » / « magiclink » : flux PKCE). Une session
-- ouverte par mot de passe n'active jamais rien : un compte pré-créé avec l'adresse d'autrui (mot de passe connu de
-- l'attaquant) ne devient pas membre sans la boîte mail de la vraie personne.
create or replace function public.accept_member_invitations()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_amr jsonb := auth.jwt() -> 'amr';
  v_pending integer;
  v_orgs jsonb := '[]'::jsonb;
  m record;
begin
  if v_uid is null then
    raise exception 'FORBIDDEN: session requise' using errcode = '42501';
  end if;

  select count(*) into v_pending
    from public.organization_users ou
    join public.organizations o on o.id = ou.organization_id
   where ou.user_id = v_uid and ou.status = 'invited' and o.status <> 'archived';
  if v_pending = 0 then
    return jsonb_build_object('ok', true, 'code', 'NONE', 'activated', 0, 'organizations', v_orgs);
  end if;

  if not exists (
    select 1
      from jsonb_array_elements(case when jsonb_typeof(v_amr) = 'array' then v_amr else '[]'::jsonb end) a
     where (case when jsonb_typeof(a) = 'object' then a ->> 'method' else a #>> '{}' end)
           in ('otp', 'recovery', 'invite', 'magiclink')) then
    return jsonb_build_object('ok', false, 'code', 'EMAIL_PROOF_REQUIRED', 'pending', v_pending,
      'message', 'Ouvrez le lien reçu par e-mail pour activer votre accès.');
  end if;

  perform set_config('rydar.member_invite_accept', v_uid::text, true);
  for m in
    update public.organization_users ou
       set status = 'active'
      from public.organizations o
     where o.id = ou.organization_id and ou.user_id = v_uid and ou.status = 'invited' and o.status <> 'archived'
    returning ou.organization_id, ou.role, o.name
  loop
    v_orgs := v_orgs || jsonb_build_array(jsonb_build_object('id', m.organization_id, 'name', m.name, 'role', m.role));
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
    values (m.organization_id, 'user', v_uid, 'member.invitation_accepted', 'organization_users', v_uid::text, 'info',
            jsonb_build_object('role', m.role));
  end loop;
  perform set_config('rydar.member_invite_accept', '', true);

  return jsonb_build_object('ok', true, 'code', 'ACTIVATED', 'activated', jsonb_array_length(v_orgs), 'organizations', v_orgs);
end;
$$;

revoke all on function public.accept_member_invitations() from public, anon;
grant execute on function public.accept_member_invitations() to authenticated;

-- Profils lisibles par les membres d'une centrale : plus ceux d'une personne seulement INVITÉE (nom, téléphone) —
-- la centrale ne connaît que l'adresse qu'elle a saisie, jusqu'à l'acceptation.
-- Dernière définition : 20260924000300_security.sql.
drop policy if exists users_select on public.users;
create policy users_select on public.users for select to authenticated
  using (
    id = auth.uid()
    or id in (
      select ou.user_id from public.organization_users ou
      where ou.organization_id in (select private.member_org_ids())
        and ou.status <> 'invited'
    )
    or (select private.is_super_admin())
  );

-- ----------------------------------------------------------------- 4. statut d'un chauffeur (owner / admin)
-- Activer / désactiver / suspendre. Hors « active » : refus si client à bord (DRIVER_ON_RIDE), courses attribuées
-- non commencées remises en recherche (reassign_ride), offres en attente fermées, chauffeur hors ligne. Les
-- déclencheurs de la fiche s'appliquent (bannissement, identité bannie, limite de l'offre, fiche supprimée) ; les
-- sessions sont fermées par drivers_revoke_sessions (sauf compte partagé).
create or replace function public.set_driver_status(p_driver_id uuid, p_status public.driver_status, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
  v_ride record;
  v_res jsonb;
  v_reassigned integer := 0;
begin
  select * into d from public.drivers where id = p_driver_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_FOUND', 'message', 'Chauffeur introuvable.');
  end if;
  perform private.assert_org_member(d.organization_id, array['owner', 'admin']::public.org_role[]);
  perform private.set_actor('user', auth.uid());
  if p_status is null or p_status not in ('active', 'inactive', 'suspended') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_STATUS', 'message', 'Statut invalide.');
  end if;

  if p_status <> 'active' then
    if exists (select 1 from public.rides r where r.driver_id = d.id and r.status in ('PASSENGER_ONBOARD', 'IN_PROGRESS')) then
      return jsonb_build_object('ok', false, 'code', 'DRIVER_ON_RIDE',
        'message', format('Client à bord : attendez la fin de la course (ou annulez-la) avant de %s ce chauffeur.',
          case when p_status = 'suspended' then 'suspendre' else 'désactiver' end));
    end if;
    for v_ride in
      select r.id from public.rides r
      where r.driver_id = d.id and r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED')
      order by r.pickup_at
    loop
      v_res := public.reassign_ride(v_ride.id, case when p_status = 'suspended' then 'Chauffeur suspendu' else 'Chauffeur désactivé' end, d.id);
      if coalesce((v_res ->> 'ok')::boolean, false) then
        v_reassigned := v_reassigned + 1;
      end if;
    end loop;
    update public.ride_offers
       set status = 'closed', closed_reason = 'driver_inactive', responded_at = now()
     where driver_id = d.id and status = 'pending';
  end if;

  update public.drivers
     set status = p_status,
         suspended_reason = case when p_status = 'suspended' then v_reason end,
         presence = case when p_status = 'active' then presence else 'offline' end,
         online_since = case when p_status = 'active' then online_since end,
         current_ride_id = case when p_status = 'active' then current_ride_id end
   where id = d.id;

  return jsonb_build_object('ok', true, 'code', 'STATUS_CHANGED', 'status', p_status, 'user_id', d.user_id,
    'reassigned_rides', v_reassigned,
    'message', case
      when p_status = 'active' then 'Chauffeur activé.'
      when v_reassigned > 0 then format('%s : %s course(s) attribuée(s) remise(s) en recherche.',
        case when p_status = 'suspended' then 'Chauffeur suspendu' else 'Chauffeur désactivé' end, v_reassigned)
      when p_status = 'suspended' then 'Chauffeur suspendu.'
      else 'Chauffeur désactivé.'
    end);
end;
$$;

revoke all on function public.set_driver_status(uuid, public.driver_status, text) from public, anon;
grant execute on function public.set_driver_status(uuid, public.driver_status, text) to authenticated;
