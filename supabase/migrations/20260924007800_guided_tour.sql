-- Visite guidée de première connexion (docs/TUTORIEL.md) : progression par utilisateur et par parcours.
-- Préférence d'interface : aucune donnée métier, jamais lue par un autre compte (pas même le super admin), effacée avec
-- le compte (cascade). Écriture par public.save_user_tour seulement (security definer, utilisateur connecté).

create table public.user_tours (
  user_id uuid not null references public.users (id) on delete cascade,
  tour text not null
    check (tour in ('super_admin', 'fleet', 'centrale', 'dispatcher', 'private_fleet')),
  status text not null default 'active'
    check (status in ('active', 'paused', 'completed')),
  step smallint not null default 0
    check (step between 0 and 4),
  shown_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, tour)
);
comment on table public.user_tours is
  'Visite guidée du tableau de bord et du super admin (docs/TUTORIEL.md) : parcours, étape en cours, état. Écriture : save_user_tour.';
comment on column public.user_tours.step is 'Étape en cours : 0 (première) à 4 (cinquième)';
comment on column public.user_tours.shown_at is 'Première ouverture de la visite ; nul : jamais ouverte (compte antérieur à la visite)';
comment on column public.user_tours.completed_at is 'Première fin de la visite (gardée si elle est revue)';

alter table public.user_tours enable row level security;
create policy user_tours_select_own on public.user_tours for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on public.user_tours from anon, authenticated, service_role;
grant select on public.user_tours to authenticated;

-- Seule écriture : l'utilisateur connecté, sur SES lignes. Valeurs posées par le code du web (jamais saisies) et
-- contrôlées par les contraintes de la table (23514 / 23502 sinon) ; aucun code d'erreur nouveau (FORBIDDEN* exempté
-- de ERROR_MESSAGES).
create or replace function public.save_user_tour(p_tour text, p_status text, p_step integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.user_tours;
begin
  if v_uid is null then
    raise exception 'FORBIDDEN: authentification requise' using errcode = '42501';
  end if;
  insert into public.user_tours as t (user_id, tour, status, step, shown_at, completed_at, updated_at)
  values (v_uid, p_tour, p_status, p_step, now(), case when p_status = 'completed' then now() end, now())
  on conflict (user_id, tour) do update
     set status = excluded.status,
         step = excluded.step,
         shown_at = coalesce(t.shown_at, excluded.shown_at),
         completed_at = coalesce(t.completed_at, excluded.completed_at),
         updated_at = now()
  returning t.* into v_row;
  return jsonb_build_object('tour', v_row.tour, 'status', v_row.status, 'step', v_row.step,
    'shown_at', v_row.shown_at, 'completed_at', v_row.completed_at);
end;
$$;
revoke execute on function public.save_user_tour(text, text, integer) from public, anon;
grant execute on function public.save_user_tour(text, text, integer) to authenticated;

-- rattrapage : début
-- Comptes existant avant la visite : leur première connexion est passée → ni ouverture d'office ni accueil ; la visite
-- reste proposée dans le menu du compte (« Reprendre la visite », qui ouvre alors l'accueil). shown_at nul : jamais ouverte.
insert into public.user_tours (user_id, tour, status, step)
select u.id, t.tour, 'paused', 0
  from public.users u
 cross join (values ('super_admin'), ('fleet'), ('centrale'), ('dispatcher'), ('private_fleet')) as t (tour)
 where u.is_super_admin
    or exists (select 1 from public.organization_users ou where ou.user_id = u.id)
on conflict (user_id, tour) do nothing;
-- rattrapage : fin
