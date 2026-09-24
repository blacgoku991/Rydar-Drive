-- =============================================================================
-- Révocation des sessions Supabase Auth quand un accès est retiré :
-- chauffeur désactivé / suspendu / supprimé, membre retiré ou désactivé,
-- organisation suspendue ou archivée. + action explicite « Déconnecter
-- tous les appareils » pour un chauffeur.
-- Les accès aux données sont de toute façon refusés immédiatement (RLS,
-- private.current_driver_id) ; ceci empêche en plus tout rafraîchissement
-- de jeton côté Auth.
-- =============================================================================

drop function if exists private.revoke_user_sessions(uuid);
create function private.revoke_user_sessions(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sessions integer := 0;
  v_tokens integer := 0;
begin
  if p_user_id is null then
    return 0;
  end if;
  begin
    if to_regclass('auth.refresh_tokens') is not null then
      execute 'delete from auth.refresh_tokens where user_id = $1::text' using p_user_id;
      get diagnostics v_tokens = row_count;
    end if;
    if to_regclass('auth.sessions') is not null then
      execute 'delete from auth.sessions where user_id = $1' using p_user_id;
      get diagnostics v_sessions = row_count;
    end if;
  exception when insufficient_privilege then
    -- Ne bloque jamais l'opération métier (suspension…) : l'accès aux données reste coupé.
    raise warning 'revoke_user_sessions: privilèges insuffisants sur le schéma auth';
  end;
  return v_sessions + v_tokens;
end;
$$;

create or replace function private.revoke_sessions_on_access_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'drivers' then
    if tg_op = 'DELETE' then
      perform private.revoke_user_sessions(old.user_id);
    else
      if new.user_id is not null and old.status = 'active' and new.status <> 'active' then
        perform private.revoke_user_sessions(new.user_id);
      end if;
      if old.user_id is not null and new.user_id is distinct from old.user_id then
        perform private.revoke_user_sessions(old.user_id);
      end if;
    end if;

  elsif tg_table_name = 'organization_users' then
    if tg_op = 'DELETE' or (old.status = 'active' and new.status <> 'active') then
      perform private.revoke_user_sessions(old.user_id);
    end if;

  elsif tg_table_name = 'organizations' then
    if old.status = 'active' and new.status <> 'active' then
      -- Chauffeurs de l'organisation
      perform private.revoke_user_sessions(d.user_id)
        from public.drivers d
       where d.organization_id = new.id and d.user_id is not null;
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

create trigger drivers_revoke_sessions
  after update of status, user_id or delete on public.drivers
  for each row execute function private.revoke_sessions_on_access_change();

create trigger organization_users_revoke_sessions
  after update of status or delete on public.organization_users
  for each row execute function private.revoke_sessions_on_access_change();

create trigger organizations_revoke_sessions
  after update of status on public.organizations
  for each row execute function private.revoke_sessions_on_access_change();

-- Action explicite (owner / admin) : déconnecte le chauffeur de tous ses appareils.
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
  v_count := private.revoke_user_sessions(d.user_id);
  update public.drivers set presence = 'offline', online_since = null
   where id = d.id and presence = 'available';
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (d.organization_id, 'user', auth.uid(), 'driver.sessions_revoked', 'drivers', d.id::text, 'warning',
          jsonb_build_object('revoked', v_count));
  return jsonb_build_object('ok', true, 'revoked', v_count);
end;
$$;

revoke execute on function private.revoke_user_sessions(uuid), private.revoke_sessions_on_access_change() from public, anon, authenticated;
revoke execute on function public.revoke_driver_sessions(uuid) from public, anon;
grant execute on function public.revoke_driver_sessions(uuid) to authenticated, service_role;
