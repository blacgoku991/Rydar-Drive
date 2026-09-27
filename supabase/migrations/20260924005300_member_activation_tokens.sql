-- =============================================================================
-- Invitations de membres (20260924004700) : un jeton émis AVANT l'activation ne donne pas l'accès.
--
-- Scénario fermé : un compte pré-créé avec l'adresse d'autrui (mot de passe connu d'un tiers) est invité dans une
-- centrale ; la vraie personne ouvre le lien reçu par e-mail, choisit son mot de passe et active l'accès
-- (accept_member_invitations). GoTrue ferme alors les autres sessions, mais un jeton d'accès déjà émis reste valable
-- jusqu'à son expiration (1 h au plus). Désormais l'adhésion garde sa date d'activation, et tous les contrôles
-- d'appartenance exigent un jeton émis après elle (claim « iat »). La personne invitée obtient un jeton neuf en
-- rafraîchissant sa session juste après l'activation (/auth/set-password).
-- Adhésions sans date d'activation (toutes celles créées directement actives) : aucun changement.
-- =============================================================================

alter table public.organization_users add column if not exists activated_at timestamptz;

-- Vrai si aucune activation n'est enregistrée, ou si le jeton courant a été émis après elle.
create or replace function private.jwt_issued_after(p_at timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_at is null
      or coalesce(nullif(auth.jwt() ->> 'iat', '')::numeric, 0) >= floor(extract(epoch from p_at));
$$;

revoke execute on function private.jwt_issued_after(timestamptz) from public, anon;
grant execute on function private.jwt_issued_after(timestamptz) to authenticated, service_role;

-- Dernière définition : 20260924000300_security.sql
create or replace function private.member_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select ou.organization_id
  from public.organization_users ou
  join public.organizations o on o.id = ou.organization_id
  where ou.user_id = auth.uid()
    and ou.status = 'active'
    and private.jwt_issued_after(ou.activated_at)
    and o.status = 'active';
$$;

-- Dernière définition : 20260924000300_security.sql
create or replace function private.admin_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select ou.organization_id
  from public.organization_users ou
  join public.organizations o on o.id = ou.organization_id
  where ou.user_id = auth.uid()
    and ou.status = 'active'
    and private.jwt_issued_after(ou.activated_at)
    and ou.role in ('owner', 'admin')
    and o.status = 'active';
$$;

-- Dernière définition : 20260924000300_security.sql
create or replace function private.membership_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select ou.organization_id
  from public.organization_users ou
  join public.organizations o on o.id = ou.organization_id
  where ou.user_id = auth.uid()
    and ou.status = 'active'
    and private.jwt_issued_after(ou.activated_at)
    and o.status <> 'archived';
$$;

-- Dernière définition : 20260924000300_security.sql
create or replace function private.has_org_role(p_org uuid, p_roles public.org_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_users ou
    join public.organizations o on o.id = ou.organization_id
    where ou.organization_id = p_org
      and ou.user_id = auth.uid()
      and ou.status = 'active'
      and private.jwt_issued_after(ou.activated_at)
      and ou.role = any (p_roles)
      and o.status = 'active'
  );
$$;

-- Dernière définition : 20260924003000_platform_fees.sql
create or replace function private.assert_platform_payer(p_org uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_org is null or not exists (
    select 1
    from public.organization_users ou
    join public.organizations o on o.id = ou.organization_id
    where ou.organization_id = p_org
      and ou.user_id = auth.uid()
      and ou.status = 'active'
      and private.jwt_issued_after(ou.activated_at)
      and ou.role in ('owner', 'admin')
      and o.status in ('active', 'suspended')
  ) then
    raise exception 'FORBIDDEN_ROLE: réservé au propriétaire ou à un administrateur de la centrale' using errcode = '42501';
  end if;
end;
$$;

-- Ses propres adhésions (lues par le tableau de bord pour choisir la centrale) : une adhésion activée n'apparaît
-- qu'avec un jeton émis après son activation. Dernière définition : 20260924000300_security.sql
drop policy if exists organization_users_select on public.organization_users;
create policy organization_users_select on public.organization_users for select to authenticated
  using (
    (user_id = auth.uid() and private.jwt_issued_after(activated_at))
    or organization_id in (select private.member_org_ids())
    or (select private.is_super_admin())
  );

-- Dernière définition : 20260924004700_audit_comptes.sql (seul changement : activated_at = now())
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
       set status = 'active', activated_at = now()
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
