-- =============================================================================
-- Rydar Drive — Lien d'inscription des chauffeurs aussi pour les flottes
--
-- Jusqu'ici, l'inscription par lien (/rejoindre/{code} et rydardrive://rejoindre/{code} : compte + véhicule →
-- candidature → validation) était réservée aux centrales à commission, et le retour au mode flotte coupait le lien.
-- Désormais, quel que soit le modèle d'exploitation (flotte ou centrale) :
--   • set_join_link (owner / admin) : créer, activer / couper, régénérer, validation automatique ;
--   • svc_join_info : renvoie aussi le modèle (page et application : aucune mention de commission pour une flotte) ;
--   • svc_driver_apply : candidature dans une flotte comme dans une centrale ; flotte : niveau « confirmé » (comme
--     un chauffeur créé par la flotte : aucun plafond de prix si le compte passe un jour en centrale), centrale :
--     « nouveau » comme avant ;
--   • approve_driver_application : flotte → « confirmé » ; centrale inchangé (niveau choisi, sinon celui de la fiche) ;
--   • changement de modèle par le super admin : le lien garde son code, son état (actif / coupé) et la validation
--     automatique ; les candidatures en attente restent en attente (à traiter dans « Inscriptions » ou « Réseau »).
--     Seule la garde « règlements ouverts » (centrale → flotte) demeure.
-- Contrôles inchangés, pour les deux modèles : owner / admin seulement (adhésion active, jeton émis après son
-- activation : private.assert_org_member), identités bannies (centrale ou plateforme : refus neutre), empreintes d'un
-- chauffeur parti en devant des commissions (jamais de validation automatique), limite de chauffeurs de l'offre
-- (validation automatique impossible → candidature en attente ; validation manuelle → PLAN_LIMIT_DRIVERS), compte
-- déjà rattaché à une fiche chauffeur refusé (ALREADY_REGISTERED), centrale suspendue → lien inactif.
-- =============================================================================

-- ----------------------------------------------------------------- lien d'inscription (owner / admin)
-- Dernière définition : 20260924002600_centrale_mode.sql. Seul changement : plus réservé au mode centrale (le code
-- CENTRALE_ONLY n'est plus renvoyé) ; le modèle est renvoyé avec l'état du lien.
create or replace function public.set_join_link(
  p_org uuid,
  p_enabled boolean,
  p_regenerate boolean default false,
  p_auto_approve boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.organizations;
begin
  perform private.assert_org_member(p_org, array['owner', 'admin']::public.org_role[]);

  update public.organizations
     set join_code = case when join_code is null or coalesce(p_regenerate, false) then private.random_join_code() else join_code end,
         join_enabled = coalesce(p_enabled, join_enabled),
         join_auto_approve = coalesce(p_auto_approve, join_auto_approve)
   where id = p_org
  returning * into o;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'ORG_NOT_FOUND', 'message', 'Organisation introuvable.');
  end if;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, 'user', auth.uid(), 'organization.join_link', 'organizations', p_org::text, 'info',
    jsonb_build_object('enabled', o.join_enabled, 'regenerated', coalesce(p_regenerate, false), 'auto_approve', o.join_auto_approve,
      'dispatch_model', o.dispatch_model));

  return jsonb_build_object('ok', true, 'code', 'UPDATED', 'join_code', o.join_code, 'join_enabled', o.join_enabled,
    'join_auto_approve', o.join_auto_approve, 'dispatch_model', o.dispatch_model);
end;
$$;

-- ----------------------------------------------------------------- page publique (service role)
-- Dernière définition : 20260924002600_centrale_mode.sql. Changements : flottes comprises ; modèle renvoyé
-- (« dispatch_model ») pour adapter les textes de la page et de l'application.
create or replace function public.svc_join_info(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o public.organizations;
begin
  select * into o from public.organizations
  where join_code = lower(btrim(coalesce(p_code, '')))
    and join_enabled
    and status = 'active';
  if not found then
    return jsonb_build_object('ok', false, 'code', 'JOIN_LINK_INVALID', 'message', 'Lien d''inscription invalide ou désactivé.');
  end if;
  return jsonb_build_object('ok', true,
    'organization', jsonb_build_object('id', o.id, 'name', o.name, 'logo_url', o.logo_url, 'brand_color', o.brand_color,
      'city', o.city, 'phone', o.phone, 'email', o.email),
    'auto_approve', o.join_auto_approve,
    'dispatch_model', o.dispatch_model);
end;
$$;

-- ----------------------------------------------------------------- candidature par lien (service role)
-- Dernière définition : 20260924004800_audit_rgpd.sql. Changements : flottes comprises ; niveau de confiance de la
-- fiche selon le modèle (flotte : « trusted », comme un chauffeur créé par la flotte ; centrale : « new ») ; journal
-- « … rejoint la flotte » pour une flotte. Réponse au candidat inchangée (mêmes clés, rien sur une dette).
create or replace function public.svc_driver_apply(
  p_org uuid,
  p_user_id uuid,
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_email text,
  p_vtc_card text,
  p_vehicle jsonb,
  p_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  d public.drivers;
  v_vehicle uuid;
  v_constraint text;
  v_approved boolean := false;
  v_first text := btrim(coalesce(p_first_name, ''));
  v_last text := btrim(coalesce(p_last_name, ''));
  v_phone text := btrim(coalesce(p_phone, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_model text := btrim(coalesce(p_vehicle ->> 'model', ''));
  v_plate text := upper(btrim(coalesce(p_vehicle ->> 'plate', '')));
  v_debt_cents bigint;
  v_debt_count integer;
  v_debt_numbers integer[];
  v_debt_drivers uuid[];
  v_unit text;
begin
  select * into o from public.organizations where id = p_org;
  if not found or o.status <> 'active' or not o.join_enabled then
    return jsonb_build_object('ok', false, 'code', 'JOIN_DISABLED', 'message', 'Ce lien d''inscription n''est plus actif.');
  end if;
  v_unit := case when o.dispatch_model = 'centrale' then 'la centrale' else 'la flotte' end;
  if p_user_id is null or exists (select 1 from public.drivers x where x.user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_REGISTERED', 'message', 'Ce compte est déjà rattaché à une centrale.');
  end if;
  if char_length(v_first) not between 1 and 80 or char_length(v_last) not between 1 and 80
     or char_length(v_phone) not between 6 and 30
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     or char_length(v_model) not between 1 and 80
     or char_length(v_plate) not between 4 and 16 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_FORM', 'message', 'Vérifiez le formulaire.');
  end if;
  if exists (select 1 from public.drivers x where x.organization_id = p_org
             and private.identity_normalize('phone', x.phone) = private.identity_normalize('phone', v_phone)) then
    return jsonb_build_object('ok', false, 'code', 'PHONE_TAKEN', 'message', 'Ce numéro est déjà inscrit dans cette centrale.');
  end if;
  perform private.set_actor('system', null);

  begin
    insert into public.vehicles (organization_id, brand, model, color, plate, category, seats, luggage_capacity)
    values (p_org, left(nullif(btrim(coalesce(p_vehicle ->> 'brand', '')), ''), 60), v_model,
      left(nullif(btrim(coalesce(p_vehicle ->> 'color', '')), ''), 40), v_plate,
      coalesce(nullif(p_vehicle ->> 'category', '')::public.vehicle_category, 'standard'),
      coalesce(nullif(p_vehicle ->> 'seats', '')::smallint, 4),
      coalesce(nullif(p_vehicle ->> 'luggage_capacity', '')::smallint, 3))
    returning id into v_vehicle;

    insert into public.drivers (organization_id, user_id, first_name, last_name, phone, email, vtc_card_number, status,
      presence, vehicle_id, trust_level, joined_via, application_status, application_message, applied_at)
    values (p_org, p_user_id, v_first, v_last, v_phone, v_email, left(nullif(btrim(coalesce(p_vtc_card, '')), ''), 40),
      'inactive', 'offline', v_vehicle, case when o.dispatch_model = 'centrale' then 'new' else 'trusted' end,
      'join_link', 'pending', left(nullif(btrim(coalesce(p_message, '')), ''), 1000), now())
    returning * into d;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      return jsonb_build_object('ok', false,
        'code', case when v_constraint like 'vehicles%' then 'PLATE_TAKEN'
                     when v_constraint like '%email%' then 'EMAIL_TAKEN'
                     else 'ALREADY_REGISTERED' end,
        'message', case when v_constraint like 'vehicles%' then 'Cette plaque est déjà enregistrée dans cette centrale.'
                        when v_constraint like '%email%' then 'Cette adresse e-mail est déjà inscrite dans cette centrale.'
                        else 'Ce compte est déjà inscrit.' end);
    when insufficient_privilege then
      -- identité bannie (trigger) : message volontairement neutre
      return jsonb_build_object('ok', false, 'code', 'IDENTITY_BANNED', 'message', 'Inscription impossible. Contactez la centrale.');
    when check_violation or invalid_text_representation or numeric_value_out_of_range or string_data_right_truncation then
      return jsonb_build_object('ok', false, 'code', 'INVALID_FORM', 'message', 'Vérifiez le formulaire.');
  end;

  -- Ancien chauffeur de cette organisation parti avec des commissions dues (empreintes, private.debtor_identities) :
  -- possible aussi pour une flotte qui a été centrale
  select coalesce(sum(m.owed_cents), 0)::bigint, coalesce(sum(m.owed_count), 0)::integer,
         coalesce(array_agg(m.driver_number order by m.driver_number), '{}'), coalesce(array_agg(m.driver_id), '{}')
    into v_debt_cents, v_debt_count, v_debt_numbers, v_debt_drivers
    from private.debtor_match(p_org, v_phone, v_email, p_vtc_card) m;

  -- Validation automatique (réglage de l'organisation) ; limite de l'offre atteinte ou identité d'un débiteur →
  -- validation manuelle
  if o.join_auto_approve and v_debt_count = 0 then
    begin
      update public.drivers
         set status = 'active', application_status = 'approved', application_reviewed_at = now()
       where id = d.id;
      v_approved := true;
    exception when others then
      v_approved := false;
    end;
  end if;

  perform private.log_event(p_org, null, 'driver.applied',
    format('%s %s (#%s) %s via le lien d''inscription', d.first_name, d.last_name, d.number,
      case when v_approved then 'a rejoint ' || v_unit else 'demande à rejoindre ' || v_unit end),
    'timeline', 'info', jsonb_build_object('driver_id', d.id, 'auto_approved', v_approved), 'system', null);
  if v_debt_count > 0 then
    perform private.log_event(p_org, null, 'driver.applied_debtor',
      format('Candidature de %s %s (#%s) : même téléphone, e-mail ou carte VTC que %s, qui a supprimé son compte en devant encore %s de commissions — à valider manuellement',
        d.first_name, d.last_name, d.number,
        (select string_agg(format('« Chauffeur supprimé (#%s) »', n), ', ') from unnest(v_debt_numbers) n),
        private.fmt_eur(least(v_debt_cents, 2147483647)::integer)),
      'system', 'warning',
      jsonb_build_object('driver_id', d.id, 'debtor_driver_ids', to_jsonb(v_debt_drivers),
        'debtor_numbers', to_jsonb(v_debt_numbers), 'owed_cents', v_debt_cents, 'owed_settlements', v_debt_count),
      'system', null);
  end if;
  perform realtime.send(
    jsonb_build_object('action', case when v_approved then 'approved' else 'applied' end,
      'driver', jsonb_build_object('id', d.id, 'number', d.number, 'first_name', d.first_name, 'last_name', d.last_name,
        'phone', d.phone, 'applied_at', d.applied_at)),
    'driver.application', 'org:' || p_org::text, true);
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, 'system', null, 'driver.applied', 'drivers', d.id::text, case when v_debt_count > 0 then 'warning' else 'info' end,
    jsonb_build_object('auto_approved', v_approved, 'email', v_email, 'dispatch_model', o.dispatch_model)
      || case when v_debt_count > 0
              then jsonb_build_object('debtor', jsonb_build_object('numbers', to_jsonb(v_debt_numbers),
                     'owed_cents', v_debt_cents, 'owed_settlements', v_debt_count))
              else '{}'::jsonb end);

  return jsonb_build_object('ok', true, 'code', case when v_approved then 'APPROVED' else 'PENDING' end,
    'driver_id', d.id, 'number', d.number, 'organization', jsonb_build_object('name', o.name));
end;
$$;

-- ----------------------------------------------------------------- validation d'une candidature (owner / admin)
-- Dernière définition : 20260924004000_account_deletion_fixes.sql. Seul changement : flotte → niveau « confirmé »
-- (comme un chauffeur créé par la flotte), quel que soit p_trust_level (toujours contrôlé) ; centrale inchangé.
create or replace function public.approve_driver_application(p_driver_id uuid, p_trust_level text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v_name text;
  v_model text;
  v_trust text := nullif(btrim(coalesce(p_trust_level, '')), '');
begin
  select * into d from public.drivers where id = p_driver_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_FOUND', 'message', 'Candidature introuvable.');
  end if;
  perform private.assert_org_member(d.organization_id, array['owner', 'admin']::public.org_role[]);
  perform private.set_actor('user', auth.uid());
  if d.deleted_at is not null then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_DELETED', 'message', 'Ce chauffeur a supprimé son compte : la candidature n''existe plus.');
  end if;
  if d.banned_at is not null then
    return jsonb_build_object('ok', false, 'code', 'DRIVER_BANNED', 'message', 'Chauffeur banni : levez d''abord le bannissement.');
  end if;
  -- En attente, ou refusée puis reconsidérée
  if d.application_status is null or d.application_status not in ('pending', 'rejected') or d.status <> 'inactive' then
    return jsonb_build_object('ok', false, 'code', 'NOT_PENDING', 'message', 'Cette candidature a déjà été traitée.');
  end if;
  if v_trust is not null and v_trust not in ('new', 'trusted') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TRUST', 'message', 'Niveau de confiance invalide.');
  end if;
  select o.name, o.dispatch_model into v_name, v_model from public.organizations o where o.id = d.organization_id;
  if v_model is distinct from 'centrale' then
    v_trust := 'trusted';
  end if;

  -- Limite de l'offre / identité bannie depuis la candidature : erreurs levées par les triggers
  update public.drivers
     set status = 'active',
         application_status = 'approved',
         application_reviewed_at = now(),
         application_reviewed_by = auth.uid(),
         application_note = null,
         trust_level = coalesce(v_trust, trust_level)
   where id = d.id;

  perform private.queue_notification(d.organization_id, d.id, null, null, 'application_approved', 'CANDIDATURE ACCEPTÉE',
    format('Bienvenue chez %s : passez en ligne pour recevoir vos premières courses.', v_name),
    jsonb_build_object('type', 'application_approved'), 'high', null);
  perform private.log_event(d.organization_id, null, 'driver.approved',
    format('Candidature de %s %s (#%s) %s', d.first_name, d.last_name, d.number,
      case when d.application_status = 'rejected' then 'reconsidérée et acceptée' else 'acceptée' end),
    'timeline', 'success', jsonb_build_object('driver_id', d.id, 'trust_level', coalesce(v_trust, d.trust_level)),
    'user', auth.uid());
  perform realtime.send(
    jsonb_build_object('action', 'approved',
      'driver', jsonb_build_object('id', d.id, 'number', d.number, 'first_name', d.first_name, 'last_name', d.last_name)),
    'driver.application', 'org:' || d.organization_id::text, true);
  return jsonb_build_object('ok', true, 'code', 'APPROVED', 'message', 'Chauffeur validé : il peut recevoir des courses.');
end;
$$;

-- ----------------------------------------------------------------- changement de modèle (super admin)
-- Dernière définition : 20260924004400_audit_argent.sql. Seul changement : le retour au mode flotte ne coupe plus le
-- lien d'inscription (code, état et validation automatique conservés ; candidatures en attente inchangées). Garde
-- conservée : centrale → flotte refusé tant qu'un règlement est à régler, déclaré ou contesté.
create or replace function private.organizations_dispatch_model_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_open integer;
begin
  if tg_op = 'UPDATE' and old.dispatch_model = 'centrale' and new.dispatch_model = 'fleet' then
    select count(*) into v_open
    from public.ride_settlements x
    where x.organization_id = new.id and x.status in ('due', 'declared', 'disputed');
    if v_open > 0 then
      raise exception 'SETTLEMENTS_OPEN: % règlement(s) chauffeur encore ouvert(s) — soldez-les ou annulez-les avant le retour au mode flotte', v_open
        using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

-- Le trigger ne regarde plus que le modèle : join_enabled se modifie librement (set_join_link)
drop trigger if exists organizations_dispatch_model_guard on public.organizations;
create trigger organizations_dispatch_model_guard
  before update of dispatch_model on public.organizations
  for each row execute function private.organizations_dispatch_model_guard();

-- -----------------------------------------------------------------------------
-- Droits d'exécution (inchangés, rappelés : signatures identiques)
-- -----------------------------------------------------------------------------
revoke execute on function private.organizations_dispatch_model_guard() from public, anon, authenticated;
grant execute on function private.organizations_dispatch_model_guard() to service_role;

revoke execute on function
  public.set_join_link(uuid, boolean, boolean, boolean),
  public.approve_driver_application(uuid, text)
from public, anon;
grant execute on function
  public.set_join_link(uuid, boolean, boolean, boolean),
  public.approve_driver_application(uuid, text)
to authenticated, service_role;

revoke execute on function
  public.svc_join_info(text),
  public.svc_driver_apply(uuid, uuid, text, text, text, text, text, jsonb, text)
from public, anon, authenticated;
grant execute on function
  public.svc_join_info(text),
  public.svc_driver_apply(uuid, uuid, text, text, text, text, text, jsonb, text)
to service_role;
