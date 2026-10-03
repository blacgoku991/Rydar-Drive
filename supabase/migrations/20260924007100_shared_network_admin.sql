-- =============================================================================
-- Rydar Drive — Réseau partagé, lot 6 : administration et cycle de vie. Interrupteur plateforme COUPÉ.
--
-- Spécification « Réseau partagé » §6 (réglages de l'organisation et du chauffeur, super admin, lisibilité « pourquoi
-- rien n'arrive »), §10.10 (suppression de compte et traces) et §12.4 (super admin). Décisions du propriétaire : Q1
-- (part de A seulement, B ne prend rien), Q2 (contrepartie toujours le chauffeur), Q5 (position masquée à B pendant la
-- course partenaire).
--
--  1. Super admin (service role, auteur revérifié en SQL, audit_logs en SQL) : public.svc_set_shared_network_enabled
--     (interrupteur de toute la plateforme ; coupure = offres réseau en attente fermées), public.svc_network_approve
--     (validation : instantané raison sociale / SIRET / n° VTC normalisés et contrôlés, dérogation « frais à 0 » ;
--     refus motivé ; e-mail au propriétaire par email_outbox), public.svc_network_suspend (suspension pour manquement
--     à la convention ou aux CGV : offres fermées dans les deux sens, courses non commencées de ses chauffeurs rendues
--     à leur organisation ; rétablissement) ; public.admin_network_overview (lecture, super admin).
--  2. Organisation (owner / admin ; jeton émis après l'activation, private.assert_org_member) : public.set_network_settings
--     (partager / recevoir, convention acceptée avec sa preuve legal_acceptances « network », assurance, plafond par
--     chauffeur ; paramètres NULL = inchangés ; une activation ou une acceptation de la convention vaut demande de
--     validation), public.set_network_exclusion (organisation déjà rencontrée seulement, réponse identique dans tous les
--     cas) ; lisibilité : public.org_network_readiness (tout membre) et public.network_driver_readiness (owner / admin
--     de l'organisation du chauffeur, ou le chauffeur lui-même), enveloppes de private.org_network_readiness (007000)
--     et private.network_driver_readiness (006900), jamais recréées. Réseau fermé : NETWORK_DISABLED (hors
--     NETWORK_CLOSED_RPCS de @rydar/shared).
--  3. Suppression d'un compte chauffeur (§10.10, S2, S4, S5) : private.scrub_network_traces (traces chez les
--     organisations partenaires effacées AVANT l'anonymisation : libellés « Chauffeur supprimé · {B} » dans les
--     exécutions, règlements, journaux, alertes et exclusions ; note de paiement ; motifs de contestation du chauffeur ;
--     contrôles réduits aux échéances ; notifications ; RIB), appelée par private.delete_driver_account ;
--     private.debtor_match consulte aussi private.network_debtor_identities (une candidature chez la créancière n'est
--     jamais validée automatiquement ; ni fiche ni n° de l'organisation du chauffeur dans son journal :
--     public.svc_driver_apply). G7 (006700) refuse toujours la suppression d'une fiche avec des obligations réseau ; les
--     empreintes sont purgées par private.housekeeping (006900, inchangé ici) une fois la dette close.
--
-- Interrupteur coupé et aucune adhésion : comportement strictement identique (fonctions nouvelles ; les fonctions
-- redéfinies n'ajoutent que des branches qui exigent une ligne réseau, une empreinte réseau ou un RIB).
-- Supabase hébergé : rien sur auth.*, storage.*, realtime.messages.
-- =============================================================================

-- =============================================================================
-- 1. File des e-mails : décision de Rydar sur une demande de participation au réseau partagé
-- =============================================================================
-- Dernière définition de la contrainte : 20260924006600_platform_fee_schedule.sql (mêmes types + « network_review »)
alter table public.email_outbox drop constraint if exists email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check
  check (kind in ('contact_notify', 'contact_ack', 'contact_reply', 'test', 'platform_fee_change', 'org_terms_update', 'network_review'));
comment on column public.email_outbox.organization_id is
  'Organisation prévenue (platform_fee_change, org_terms_update, network_review) ; null : e-mails du formulaire de contact et de test.';

-- =============================================================================
-- 2. Aides
-- =============================================================================

-- État de validation d'une adhésion (même règle que private.org_network_readiness, 007000) : approved, refused (motif
-- de Rydar), lost (validation perdue après un changement de nom ou de n°, instantané conservé : G11), pending (demande
-- envoyée), none.
create or replace function private.network_approval_status(m public.network_memberships)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when m.organization_id is null then 'none'
    when m.approved_at is not null then 'approved'
    when m.refused_reason is not null then 'refused'
    when m.approved_legal_name is not null then 'lost'
    when m.requested_at is not null then 'pending'
    else 'none'
  end;
$$;

-- Texte de l'e-mail au propriétaire après la décision de Rydar (contenu fixe : nom, référence, instantané validé ou
-- motif du refus). Pas de lien : svc_network_approve ne reçoit pas l'adresse du site.
create or replace function private.network_review_email(p_org uuid, p_approved boolean, p_reason text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  o public.organizations;
  m public.network_memberships;
  v_ref text := private.platform_reference(p_org);
  v_reply boolean := private.platform_reply_to() is not null;
  v_parts text[];
begin
  select * into o from public.organizations x where x.id = p_org;
  select * into m from public.network_memberships x where x.organization_id = p_org;
  if p_approved then
    v_parts := array[
      'Bonjour,',
      format('Rydar a vérifié l''inscription de votre organisation %s (référence %s) au registre des exploitants VTC : sa participation au réseau partagé est validée.',
        o.name, v_ref),
      format('Informations validées, montrées aux organisations partenaires : %s, SIRET %s, n° d''inscription au registre des exploitants VTC %s. Un changement du nom, de la raison sociale, du SIRET ou du n° d''inscription de votre organisation demandera une nouvelle vérification, et plus aucune course ne sera échangée d''ici là.',
        m.approved_legal_name, m.approved_siret, m.approved_vtc_registration),
      'Le partage de vos courses et la réception des courses du réseau se règlent dans l''onglet « Réseau partagé » du tableau de bord Rydar Drive : chaque sens devient actif dès que ses conditions sont remplies.'];
  else
    v_parts := array[
      'Bonjour,',
      format('Rydar n''a pas pu valider la participation de votre organisation %s (référence %s) au réseau partagé.', o.name, v_ref),
      'Motif : ' || coalesce(p_reason, '—'),
      'Corrigez si besoin la fiche de votre organisation (raison sociale, SIRET, n° d''inscription au registre des exploitants VTC), puis réactivez le partage ou la réception dans l''onglet « Réseau partagé » du tableau de bord Rydar Drive : une nouvelle vérification sera demandée.'];
  end if;
  v_parts := v_parts || array[
    'Message automatique de Rydar Drive. '
      || case when v_reply then 'Une question ? Répondez à cet e-mail.'
              else 'Une question ? Écrivez-nous depuis la page Contact du site Rydar Drive.' end,
    'L''équipe Rydar Drive'];
  return jsonb_build_object(
    'subject', private.fr_typo(case when p_approved then 'Rydar Drive : participation au réseau partagé validée'
                                    else 'Rydar Drive : participation au réseau partagé non validée' end),
    'body', private.fr_typo(array_to_string(v_parts, E'\n\n')));
end;
$$;

-- Ligne du tableau des organisations du super admin (contrat AdminNetworkOrgRow) : identité actuelle de
-- l'organisation (ce que Rydar vérifie), adhésion, frais Rydar et chiffres des 30 derniers jours, seuils signalés
-- (NETWORK_ADMIN_THRESHOLDS de @rydar/shared : acceptation < 20 % sur au moins 20 offres reçues, au moins 3 retraits
-- après acceptation, au moins 2 courses de ses chauffeurs contestées, un versement à un chauffeur partenaire en retard
-- de plus de 7 jours).
create or replace function private.admin_network_org_row(o public.organizations, m public.network_memberships)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_since timestamptz := now() - interval '30 days';
  v_given integer;
  v_received integer;
  v_offers record;
  v_releases integer;
  v_cancellations integer;
  v_contested integer;
  v_disputes integer;
  v_overdue integer;
  v_flags text[] := '{}';
begin
  select count(*)::integer into v_given
    from public.ride_network_executions e where e.organization_id = o.id and e.accepted_at >= v_since;
  select count(*)::integer into v_received
    from public.ride_network_executions e where e.executor_org_id = o.id and e.accepted_at >= v_since;
  select count(*)::integer as received,
         (count(*) filter (where x.status = 'accepted'))::integer as accepted,
         (count(*) filter (where x.status = 'declined'))::integer as declined,
         (count(*) filter (where x.status = 'expired'))::integer as expired
    into v_offers
    from public.ride_offers x
   where x.is_network and x.driver_org_id = o.id and x.sent_at >= v_since;
  select count(*)::integer into v_releases
    from public.ride_network_executions e
   where e.executor_org_id = o.id and e.end_reason in ('executor_released', 'executor_unavailable') and e.ended_at >= v_since;
  select count(*)::integer into v_cancellations
    from public.ride_network_executions e
   where e.organization_id = o.id and e.end_reason = 'cancelled_by_giver' and e.ended_at >= v_since;
  select count(*)::integer into v_contested
    from public.ride_network_executions e where e.executor_org_id = o.id and e.contested_at >= v_since;
  select count(*)::integer into v_disputes
    from public.ride_settlements x
   where x.organization_id = o.id and x.network_driver_org_id is not null and x.driver_disputed_at >= v_since;
  select count(*)::integer into v_overdue
    from public.ride_settlements x
   where x.organization_id = o.id and x.network_driver_org_id is not null and x.direction = 'centrale_owes'
     and x.status = 'due' and x.due_at < now() - interval '7 days';

  if (case when v_offers.received >= 20 then v_offers.accepted::numeric / v_offers.received < 0.2 else false end) then
    v_flags := v_flags || 'low_acceptance'::text;
  end if;
  if v_releases >= 3 then
    v_flags := v_flags || 'releases'::text;
  end if;
  if v_contested >= 2 then
    v_flags := v_flags || 'contests'::text;
  end if;
  if v_overdue > 0 then
    v_flags := v_flags || 'payout_overdue'::text;
  end if;

  return jsonb_build_object(
    'id', o.id,
    'name', o.name,
    'legal_name', o.legal_name,
    'siret', o.siret,
    'vtc_registration', o.vtc_registration,
    'dispatch_model', o.dispatch_model,
    'status', o.status,
    'share_out', coalesce(m.share_out, false),
    'share_in', coalesce(m.share_in, false),
    'approval', private.network_approval_status(m),
    'requested_at', m.requested_at,
    'approved_at', m.approved_at,
    'refused_reason', m.refused_reason,
    'terms_version', m.terms_version,
    'terms_ok', private.network_terms_ok(m.terms_version),
    'fee_waiver', coalesce(m.fee_waiver, false),
    'platform_fee_percent', o.platform_fee_percent,
    'platform_fee_fixed_cents', o.platform_fee_fixed_cents,
    'suspended_at', m.suspended_at,
    'suspended_reason', m.suspended_reason,
    'stats_30d', jsonb_build_object(
      'rides_given', v_given,
      'rides_received', v_received,
      'offers_received', v_offers.received,
      'offers_accepted', v_offers.accepted,
      'offers_declined', v_offers.declined,
      'offers_expired', v_offers.expired,
      'releases_after_accept', v_releases,
      'giver_cancellations_after_accept', v_cancellations,
      'contested_rides', v_contested,
      'driver_disputes', v_disputes,
      'overdue_payouts', v_overdue),
    'flags', to_jsonb(v_flags));
end;
$$;

-- =============================================================================
-- 3. Super admin (§6.3, §12.4) — service role, auteur revérifié (private.assert_platform_actor), audit_logs en SQL
-- =============================================================================

-- Interrupteur de toute la plateforme (modèle : public.svc_set_booking_sites_enabled, 006200 ; contrat
-- SvcSharedNetworkResult). Coupure : toutes les offres réseau en attente fermées (« network_unavailable »,
-- notifications d'offre supprimées par le déclencheur ride_offers_network_closed) ; les courses déjà acceptées vont
-- à leur terme
-- (private.network_watch les surveille toujours). Réglages des organisations conservés.
create or replace function public.svc_set_shared_network_enabled(p_actor uuid, p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before boolean;
  v_closed integer := 0;
begin
  perform private.assert_platform_actor(p_actor);
  if p_enabled is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'message', 'Valeur invalide.');
  end if;
  insert into public.platform_settings (id) values (true) on conflict (id) do nothing;
  select s.shared_network_enabled into v_before from public.platform_settings s where s.id for update;
  if v_before = p_enabled then
    return jsonb_build_object('ok', true, 'enabled', p_enabled, 'changed', false, 'closed_offers', 0);
  end if;
  update public.platform_settings
     set shared_network_enabled = p_enabled, updated_at = now(), updated_by = p_actor
   where id;
  if not p_enabled then
    v_closed := private.close_network_offers(null, null, null, 'network_unavailable');
  end if;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (null, 'super_admin', p_actor,
          case when p_enabled then 'platform.shared_network_enabled' else 'platform.shared_network_disabled' end,
          'platform_settings', 'shared_network', 'warning',
          jsonb_build_object('from', v_before, 'to', p_enabled, 'closed_offers', v_closed));
  return jsonb_build_object('ok', true, 'enabled', p_enabled, 'changed', true, 'closed_offers', v_closed);
end;
$$;

-- Validation d'une organisation (contrat SvcNetworkApproveResult) : vérification administrative de son inscription au
-- registre des exploitants VTC. Valider : instantané approved_legal_name / approved_siret / approved_vtc_registration
-- copié de l'organisation APRÈS normalisation (espaces superflus retirés ; SIRET : chiffres seuls, espaces, points,
-- tirets et barres retirés) et contrôle de chaque champ (raison sociale 2 à 160 caractères, SIRET 14 chiffres, n° VTC
-- 3 à 120 caractères) : un champ vide ou invalide → IDENTITY_INCOMPLETE + missing (jamais une erreur 23514) ;
-- dérogation « frais à 0 » (fee_waiver) ; motif d'un refus précédent effacé. Refuser : motif de 5 à 300 caractères
-- (REASON_REQUIRED), validation et instantané retirés, offres réseau fermées dans les deux sens (comme G11). Adhésion
-- créée au besoin (validation possible avant la demande). Audit « network.approved » / « network.refused » ; e-mail
-- aux propriétaires (private.queue_org_emails, type « network_review »). Indépendante de l'interrupteur.
create or replace function public.svc_network_approve(p_actor uuid, p_org uuid, p_approved boolean, p_fee_waiver boolean,
                                                      p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  m public.network_memberships;
  v_before text;
  v_legal text;
  v_siret text;
  v_vtc text;
  v_missing text[] := '{}';
  v_reason text := left(nullif(btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g')), ''), 300);
  v_closed integer := 0;
  v_mail jsonb;
  v_emails integer;
begin
  perform private.assert_platform_actor(p_actor);
  if p_approved is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Décision invalide.');
  end if;
  select * into o from public.organizations x where x.id = p_org;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Organisation introuvable.');
  end if;

  if p_approved then
    v_legal := nullif(btrim(regexp_replace(coalesce(o.legal_name, ''), '\s+', ' ', 'g')), '');
    v_siret := nullif(regexp_replace(coalesce(o.siret, ''), '[\s./-]', '', 'g'), '');
    v_vtc := nullif(btrim(regexp_replace(coalesce(o.vtc_registration, ''), '\s+', ' ', 'g')), '');
    if v_legal is null or char_length(v_legal) not between 2 and 160 then
      v_missing := v_missing || 'legal_name'::text;
    end if;
    if v_siret is null or v_siret !~ '^[0-9]{14}$' then
      v_missing := v_missing || 'siret'::text;
    end if;
    if v_vtc is null or char_length(v_vtc) not between 3 and 120 then
      v_missing := v_missing || 'vtc_registration'::text;
    end if;
    if cardinality(v_missing) > 0 then
      return jsonb_build_object('ok', false, 'code', 'IDENTITY_INCOMPLETE',
        'message', 'Fiche de l''organisation incomplète : raison sociale, SIRET ou n° d''inscription VTC à corriger.',
        'missing', to_jsonb(v_missing));
    end if;
  elsif v_reason is null or char_length(v_reason) < 5 then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'message', 'Motif du refus obligatoire (5 à 300 caractères).');
  end if;

  insert into public.network_memberships (organization_id, updated_by) values (p_org, p_actor)
  on conflict (organization_id) do nothing;
  select * into m from public.network_memberships x where x.organization_id = p_org for update;
  v_before := private.network_approval_status(m);

  if p_approved then
    update public.network_memberships x
       set approved_at = now(), approved_by = p_actor, approved_legal_name = v_legal, approved_siret = v_siret,
           approved_vtc_registration = v_vtc, fee_waiver = coalesce(p_fee_waiver, false), refused_reason = null,
           updated_at = now(), updated_by = p_actor
     where x.organization_id = p_org
    returning * into m;
  else
    update public.network_memberships x
       set approved_at = null, approved_by = null, approved_legal_name = null, approved_siret = null,
           approved_vtc_registration = null, fee_waiver = false, refused_reason = v_reason,
           updated_at = now(), updated_by = p_actor
     where x.organization_id = p_org
    returning * into m;
    v_closed := private.close_network_offers(p_org, null, null, 'sharing_stopped')
              + private.close_network_offers(null, p_org, null, 'sharing_stopped');
  end if;

  v_mail := private.network_review_email(p_org, p_approved, v_reason);
  v_emails := private.queue_org_emails(p_org, 'network_review', v_mail ->> 'subject', v_mail ->> 'body', null, p_actor);

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, 'super_admin', p_actor, case when p_approved then 'network.approved' else 'network.refused' end,
          'network_memberships', p_org::text, case when p_approved then 'info' else 'warning' end,
          jsonb_build_object('from', v_before, 'emails', v_emails)
            || case when p_approved
                    then jsonb_build_object('fee_waiver', m.fee_waiver, 'legal_name', v_legal, 'siret', v_siret,
                                            'vtc_registration', v_vtc)
                    else jsonb_build_object('reason', v_reason, 'closed_offers', v_closed) end);

  return jsonb_build_object('ok', true, 'code', case when p_approved then 'APPROVED' else 'REFUSED' end,
    'membership', to_jsonb(m));
end;
$$;

-- Suspension d'une organisation du réseau partagé (contrat SvcNetworkSuspendResult), présentée comme un manquement à
-- la convention ou aux CGV (U1) ; motif de 5 à 300 caractères (REASON_REQUIRED). Effets (§9.8) : offres réseau en
-- attente fermées dans les deux sens ; courses d'autres organisations tenues par ses chauffeurs et pas encore
-- commencées (acceptée, en route, arrivé) rendues à leur organisation (private.unassign_network_ride,
-- « executor_unavailable ») ; client à bord : le chauffeur termine (alerte chez A par private.network_watch) ; ses
-- propres courses confiées vont à leur terme. Rétablir : motif facultatif. Une seconde suspension met seulement le
-- motif à jour. Audit « network.suspended » / « network.restored ». Indépendante de l'interrupteur.
create or replace function public.svc_network_suspend(p_actor uuid, p_org uuid, p_suspended boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.network_memberships;
  x record;
  v_reason text := left(nullif(btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g')), ''), 300);
  v_closed integer := 0;
  v_released integer := 0;
  v_errors integer := 0;
  v_res jsonb;
begin
  perform private.assert_platform_actor(p_actor);
  if p_suspended is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Organisation introuvable.');
  end if;
  if p_suspended and (v_reason is null or char_length(v_reason) < 5) then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'message', 'Motif de la suspension obligatoire (5 à 300 caractères).');
  end if;
  insert into public.network_memberships (organization_id, updated_by) values (p_org, p_actor)
  on conflict (organization_id) do nothing;
  select * into m from public.network_memberships y where y.organization_id = p_org for update;

  if not p_suspended then
    if m.suspended_at is not null then
      update public.network_memberships y
         set suspended_at = null, suspended_reason = null, suspended_by = null, updated_at = now(), updated_by = p_actor
       where y.organization_id = p_org;
      insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity,
                                     metadata)
      values (p_org, 'super_admin', p_actor, 'network.restored', 'network_memberships', p_org::text, 'info',
              jsonb_build_object('reason', v_reason, 'suspended_at', m.suspended_at, 'suspended_reason', m.suspended_reason));
    end if;
    return jsonb_build_object('ok', true, 'code', 'RESTORED', 'closed_offers', 0, 'released_rides', 0);
  end if;

  update public.network_memberships y
     set suspended_at = coalesce(y.suspended_at, now()), suspended_reason = v_reason,
         suspended_by = case when y.suspended_at is null then p_actor else y.suspended_by end,
         updated_at = now(), updated_by = p_actor
   where y.organization_id = p_org;
  v_closed := private.close_network_offers(p_org, null, null, 'network_unavailable')
            + private.close_network_offers(null, p_org, null, 'network_unavailable');
  for x in
    select r.id, r.driver_id
      from public.rides r
     where r.driver_org_id = p_org
       and r.organization_id <> p_org
       and r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED')
     order by r.pickup_at, r.id
  loop
    -- Course en erreur : la suspension s'applique quand même, private.network_watch la rend au passage suivant
    begin
      v_res := private.unassign_network_ride(x.driver_id, x.id, 'executor_unavailable');
      if coalesce((v_res ->> 'ok')::boolean, false) then
        v_released := v_released + 1;
      end if;
    exception when others then
      v_errors := v_errors + 1;
    end;
  end loop;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (p_org, 'super_admin', p_actor, 'network.suspended', 'network_memberships', p_org::text, 'warning',
          jsonb_build_object('reason', v_reason, 'already_suspended', m.suspended_at is not null,
                             'closed_offers', v_closed, 'released_rides', v_released)
            || case when v_errors > 0 then jsonb_build_object('errors', v_errors) else '{}'::jsonb end);
  return jsonb_build_object('ok', true, 'code', 'SUSPENDED', 'closed_offers', v_closed, 'released_rides', v_released);
end;
$$;

-- Vue d'ensemble du super admin (/admin/reseau, contrat AdminNetworkOverview) : interrupteur, convention, demandes à
-- valider (demande envoyée ou validation perdue, sans refus, un sens toujours demandé : même prédicat que la pastille
-- du menu, app/admin/layout.tsx), organisations adhérentes (private.admin_network_org_row), chauffeurs exclus
-- automatiquement (retraits répétés), 50 dernières courses partagées, totaux. Super admin seulement (lecture).
create or replace function public.admin_network_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  p public.platform_settings;
  v_rows jsonb;
  v_review jsonb;
begin
  if not private.is_super_admin() then
    raise exception 'FORBIDDEN: réservé au super admin' using errcode = '42501';
  end if;
  select * into p from public.platform_settings x where x.id;

  select coalesce(jsonb_agg(private.admin_network_org_row(o, m) order by o.name, o.id), '[]'::jsonb) into v_rows
    from public.network_memberships m
    join public.organizations o on o.id = m.organization_id;
  select coalesce(jsonb_agg(r order by r ->> 'requested_at', r ->> 'name'), '[]'::jsonb) into v_review
    from jsonb_array_elements(v_rows) r
   where r ->> 'requested_at' is not null
     and r ->> 'approved_at' is null
     and r ->> 'refused_reason' is null
     and ((r ->> 'share_out')::boolean or (r ->> 'share_in')::boolean);

  return jsonb_build_object(
    'enabled', public.shared_network_enabled(),
    'terms', jsonb_build_object('version', p.network_terms_version, 'min_version', p.network_terms_min_version,
                                'grace_until', p.network_terms_grace_until),
    'to_review', v_review,
    'organizations', v_rows,
    'auto_excluded_drivers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'driver_label', coalesce(private.driver_label_for(n.driver_id, n.organization_id), 'Chauffeur'),
               'organization', jsonb_build_object('id', o.id, 'name', o.name),
               'excluded_until', n.excluded_until,
               'releases_30d', (select count(*) from public.ride_network_executions e
                                 where e.executor_driver_id = n.driver_id
                                   and e.end_reason in ('executor_released', 'executor_unavailable')
                                   and e.ended_at >= now() - interval '30 days'))
             order by n.excluded_until desc, n.driver_id)
        from public.driver_network_settings n
        join public.organizations o on o.id = n.organization_id
       where n.excluded_until > now()), '[]'::jsonb),
    'recent_rides', coalesce((
      select jsonb_agg(t.j order by t.accepted_at desc, t.id)
        from (
          select e.accepted_at, e.id, jsonb_build_object(
                   'execution_id', e.id,
                   'accepted_at', e.accepted_at,
                   'giver', jsonb_build_object('id', a.id, 'name', a.name),
                   'executor', jsonb_build_object('id', b.id, 'name', b.name),
                   -- Exécution finie : terminée ou rendue (la suite de la course chez A ne la concerne plus)
                   'status', case when e.ended_at is null then r.status::text
                                  when e.end_reason = 'completed' then 'COMPLETED' else 'CANCELLED' end,
                   'price_cents', (e.terms ->> 'price_cents')::integer,
                   'currency', r.currency) as j
            from public.ride_network_executions e
            join public.rides r on r.id = e.ride_id
            join public.organizations a on a.id = e.organization_id
            join public.organizations b on b.id = e.executor_org_id
           order by e.accepted_at desc, e.id
           limit 50) t), '[]'::jsonb),
    'totals', jsonb_build_object(
      'members', jsonb_array_length(v_rows),
      'sharing', (select count(*) from jsonb_array_elements(v_rows) r where (r ->> 'share_out')::boolean),
      'receiving', (select count(*) from jsonb_array_elements(v_rows) r where (r ->> 'share_in')::boolean),
      'to_review', jsonb_array_length(v_review),
      'suspended', (select count(*) from jsonb_array_elements(v_rows) r where r ->> 'suspended_at' is not null),
      'rides_30d', (select count(*) from public.ride_network_executions e where e.accepted_at >= now() - interval '30 days')));
end;
$$;

-- =============================================================================
-- 4. Organisation et chauffeur (§6.1, §6.2, §6.4) — contrôle d'accès DANS la fonction ; réseau fermé : NETWORK_DISABLED
-- =============================================================================

-- Lisibilité de l'organisation (contrat OrgNetworkReadiness) : tout membre (dispatcher compris, lecture seule).
create or replace function public.org_network_readiness(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_org_member(p_org);
  perform private.assert_network_open();
  return private.org_network_readiness(p_org);
end;
$$;

-- Lisibilité d'un chauffeur (contrat NetworkDriverReadiness) : p_driver NULL (ou sa propre fiche) = le chauffeur
-- appelant ; sinon owner / admin de l'organisation du chauffeur. Les blocages propres à une donneuse n'y figurent
-- jamais (private.network_driver_readiness).
create or replace function public.network_driver_readiness(p_driver uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_self uuid := private.current_driver_id();
  d public.drivers;
begin
  if p_driver is null or p_driver = v_self then
    select * into d from public.drivers x where x.id = v_self;
    if not found then
      raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
    end if;
  else
    select * into d from public.drivers x where x.id = p_driver;
    if not found then
      raise exception 'DRIVER_NOT_FOUND: chauffeur introuvable' using errcode = 'P0002';
    end if;
    perform private.assert_org_member(d.organization_id, array['owner', 'admin']::public.org_role[]);
  end if;
  perform private.assert_network_open();
  return private.network_driver_readiness(d.id);
end;
$$;

-- Réglages de l'organisation (§6.1, contrat OrgNetworkSettingsResult) : owner / admin, réseau ouvert. Paramètres NULL =
-- inchangés (le web les transmet tous).
--  * p_terms_version : acceptation de la convention affichée, version EN VIGUEUR seulement (NETWORK_TERMS_OUTDATED),
--    preuve dans legal_acceptances (« network », au nom de l'organisation, source web, idempotente, signataire recopié) ;
--  * activer un sens exige une convention acceptée encore valable (en vigueur, ou précédente pendant sa grâce), posée
--    dans le même appel au besoin (NETWORK_TERMS_REQUIRED) ; les autres conditions (validation, n° VTC, moyen en ligne,
--    frais, assurance…) ne bloquent pas le réglage : le sens reste « en attente » avec ses raisons (readiness) ;
--  * demande de validation (requested_at) : un sens activé ou la convention acceptée, l'organisation sans validation
--    ni demande en cours, ou refusée (motif effacé : nouvelle vérification) ;
--  * assurance confirmée (date et auteur gardés tant qu'elle reste confirmée) ou retirée ; plafond par chauffeur 0 à
--    100 000 centimes ;
--  * coupure d'un sens (ou assurance retirée pour la réception) : offres réseau en attente fermées (« sharing_stopped ») ;
--    les courses déjà acceptées vont à leur terme.
-- Audit « network.settings » (changements) et « network.terms_accepted ».
create or replace function public.set_network_settings(
  p_org uuid,
  p_share_out boolean default null,
  p_share_in boolean default null,
  p_terms_version text default null,
  p_insurance_confirmed boolean default null,
  p_executor_credit_limit_cents integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.network_memberships;
  n public.network_memberships;
  v_current text;
  v_version text := nullif(btrim(coalesce(p_terms_version, '')), '');
  v_out boolean;
  v_in boolean;
  v_terms text;
  v_turn_on boolean;
  v_request boolean;
  v_insurance_at timestamptz;
  v_insurance_by uuid;
  v_closed integer := 0;
  v_changes jsonb := '{}'::jsonb;
begin
  perform private.assert_org_member(p_org, array['owner', 'admin']::public.org_role[]);
  perform private.assert_network_open();
  if p_executor_credit_limit_cents is not null and p_executor_credit_limit_cents not between 0 and 100000 then
    raise exception 'p_executor_credit_limit_cents : entre 0 et 100000 centimes' using errcode = '22023';
  end if;
  select x.network_terms_version into v_current from public.platform_settings x where x.id;
  if v_version is not null and v_version is distinct from v_current then
    raise exception 'NETWORK_TERMS_OUTDATED: convention du réseau partagé changée, lisez la version en vigueur'
      using errcode = '55000';
  end if;

  select * into m from public.network_memberships x where x.organization_id = p_org for update;
  if not found then
    -- Rien à enregistrer : aucune adhésion créée (l'onglet d'une organisation jamais entrée reste inchangé)
    if coalesce(p_share_out, false) = false and coalesce(p_share_in, false) = false and v_version is null
       and coalesce(p_insurance_confirmed, false) = false and p_executor_credit_limit_cents is null then
      return jsonb_build_object('ok', true, 'membership', null, 'readiness', private.org_network_readiness(p_org),
                                'closed_offers', 0);
    end if;
    insert into public.network_memberships (organization_id, updated_by) values (p_org, auth.uid())
    on conflict (organization_id) do nothing;
    select * into m from public.network_memberships x where x.organization_id = p_org for update;
  end if;

  v_out := coalesce(p_share_out, m.share_out);
  v_in := coalesce(p_share_in, m.share_in);
  v_terms := coalesce(v_version, m.terms_version);
  v_turn_on := (coalesce(p_share_out, false) and not m.share_out) or (coalesce(p_share_in, false) and not m.share_in);
  if v_turn_on and not private.network_terms_ok(v_terms) then
    raise exception 'NETWORK_TERMS_REQUIRED: convention du réseau partagé à accepter' using errcode = '55000';
  end if;
  v_request := (coalesce(p_share_out, false) or coalesce(p_share_in, false) or v_version is not null)
               and (v_out or v_in)
               and m.approved_at is null
               and (m.requested_at is null or m.refused_reason is not null);
  v_insurance_at := case when p_insurance_confirmed is null then m.insurance_confirmed_at
                         when p_insurance_confirmed then coalesce(m.insurance_confirmed_at, now()) end;
  v_insurance_by := case when p_insurance_confirmed is null then m.insurance_confirmed_by
                         when p_insurance_confirmed and m.insurance_confirmed_at is not null then m.insurance_confirmed_by
                         when p_insurance_confirmed then auth.uid() end;

  if v_version is not null then
    insert into public.legal_acceptances (user_id, organization_id, document, version, source)
    values (auth.uid(), p_org, 'network', v_version, 'web')
    on conflict do nothing;
  end if;

  update public.network_memberships x
     set share_out = v_out,
         share_in = v_in,
         terms_version = v_terms,
         terms_accepted_at = case when v_version is not null and v_version is distinct from m.terms_version then now()
                                  else x.terms_accepted_at end,
         terms_accepted_by = case when v_version is not null and v_version is distinct from m.terms_version then auth.uid()
                                  else x.terms_accepted_by end,
         requested_at = case when v_request then now() else x.requested_at end,
         refused_reason = case when v_request then null else x.refused_reason end,
         insurance_confirmed_at = v_insurance_at,
         insurance_confirmed_by = v_insurance_by,
         executor_credit_limit_cents = coalesce(p_executor_credit_limit_cents, x.executor_credit_limit_cents),
         updated_at = now(),
         updated_by = auth.uid()
   where x.organization_id = p_org
  returning * into n;

  if m.share_out and not n.share_out then
    v_closed := v_closed + private.close_network_offers(p_org, null, null, 'sharing_stopped');
  end if;
  if (m.share_in and not n.share_in) or (n.share_in and m.insurance_confirmed_at is not null and n.insurance_confirmed_at is null) then
    v_closed := v_closed + private.close_network_offers(null, p_org, null, 'sharing_stopped');
  end if;

  if n.share_out is distinct from m.share_out then
    v_changes := v_changes || jsonb_build_object('share_out', n.share_out);
  end if;
  if n.share_in is distinct from m.share_in then
    v_changes := v_changes || jsonb_build_object('share_in', n.share_in);
  end if;
  if (n.insurance_confirmed_at is null) is distinct from (m.insurance_confirmed_at is null) then
    v_changes := v_changes || jsonb_build_object('insurance_confirmed', n.insurance_confirmed_at is not null);
  end if;
  if n.executor_credit_limit_cents is distinct from m.executor_credit_limit_cents then
    v_changes := v_changes || jsonb_build_object('executor_credit_limit_cents', n.executor_credit_limit_cents);
  end if;
  if v_request then
    v_changes := v_changes || jsonb_build_object('requested', true, 'previous_refusal', m.refused_reason);
  end if;
  if v_changes <> '{}'::jsonb then
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity,
                                   metadata)
    values (p_org, 'user', auth.uid(), 'network.settings', 'network_memberships', p_org::text, 'info',
            v_changes || jsonb_build_object('closed_offers', v_closed));
  end if;
  if v_version is not null and v_version is distinct from m.terms_version then
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity,
                                   metadata)
    values (p_org, 'user', auth.uid(), 'network.terms_accepted', 'network_memberships', p_org::text, 'info',
            jsonb_build_object('version', v_version, 'previous', m.terms_version));
  end if;

  return jsonb_build_object('ok', true, 'membership', to_jsonb(n), 'readiness', private.org_network_readiness(p_org),
                            'closed_offers', v_closed);
end;
$$;

-- « Ne plus travailler avec {B} » / exclusion levée (§6.1) : owner / admin, réseau ouvert. Seulement une organisation
-- déjà rencontrée (une course confiée ou reçue, comme public.network_partner_names) ; symétrique (une exclusion posée
-- par l'une bloque les deux sens, private.network_pair_ok) ; invisible pour l'exclue (RLS) ; levée par celle qui l'a
-- posée. Réponse identique dans tous les cas, partenaire jamais rencontré ou déjà exclu compris : { ok: true }.
-- Exclusion posée : offres réseau en attente entre les deux organisations fermées (« network_unavailable »), courses
-- déjà acceptées au bout. Audit « network.exclusion ».
create or replace function public.set_network_exclusion(p_org uuid, p_partner uuid, p_excluded boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_closed integer := 0;
  v_changed boolean := false;
begin
  perform private.assert_org_member(p_org, array['owner', 'admin']::public.org_role[]);
  perform private.assert_network_open();
  if p_excluded is null then
    raise exception 'p_excluded obligatoire' using errcode = '22023';
  end if;
  if p_partner is null or p_partner = p_org or not exists (
    select 1 from public.ride_network_executions e
     where (e.organization_id = p_org and e.executor_org_id = p_partner)
        or (e.organization_id = p_partner and e.executor_org_id = p_org)) then
    return jsonb_build_object('ok', true);
  end if;

  if p_excluded then
    insert into public.network_exclusions (organization_id, excluded_org_id, created_by)
    values (p_org, p_partner, auth.uid())
    on conflict (organization_id, excluded_org_id) do nothing;
    v_changed := found;
    if v_changed then
      v_closed := private.close_network_offers(p_org, p_partner, null, 'network_unavailable')
                + private.close_network_offers(p_partner, p_org, null, 'network_unavailable');
    end if;
  else
    delete from public.network_exclusions x where x.organization_id = p_org and x.excluded_org_id = p_partner;
    v_changed := found;
  end if;
  if v_changed then
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity,
                                   metadata)
    values (p_org, 'user', auth.uid(), 'network.exclusion', 'network_exclusions', p_partner::text, 'info',
            jsonb_build_object('partner', p_partner, 'excluded', p_excluded, 'closed_offers', v_closed));
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- =============================================================================
-- 5. Suppression d'un compte chauffeur : traces chez les organisations partenaires (§10.10, S2, S4, S5)
-- =============================================================================

-- Effacement des traces d'un chauffeur chez les organisations qui lui ont confié des courses (A), AVANT l'anonymisation
-- de sa fiche (private.delete_driver_account : son nom est encore connu). Courses concernées : ses exécutions, ses
-- offres réseau, ses règlements réseau, ses alertes chez A. Libellés courts (« Prénom I. », celui de chaque exécution et
-- celui de sa fiche) remplacés par « Chauffeur supprimé » — « Chauffeur supprimé · {B} » dans les libellés recopiés :
--  * exécutions : libellé (réglage local rydar.network_scrub, G2), contrôles réduits aux échéances (n° de carte VTC
--    retiré), motif de contestation du chauffeur retiré, motif de contestation de A sans son libellé ;
--  * règlements réseau (conservés 10 ans) : libellé, note de paiement (NULL), motif « Je conteste » retiré, note de A sans
--    son libellé ;
--  * journal (ride_events) et alertes (ride_alerts) de ces courses chez A : message et données, libellé exact seulement ;
--  * exclusions posées par A (private.network_driver_exclusions) : libellé (empreintes conservées) ;
--  * ses notifications chez A supprimées ; ses coordonnées bancaires (driver_payout_details) supprimées.
-- Empreinte du RIB des exécutions (sha256, posée une fois) et instantanés figés (exploitant, véhicule, termes)
-- conservés : preuve de la course. Renvoie les compteurs (« organizations » = 0 : aucune trace réseau).
create or replace function private.scrub_network_traces(p_driver uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  d public.drivers;
  v_alias constant text := 'Chauffeur supprimé';
  v_dispute constant text := 'Motif retiré : compte supprimé';
  v_rides uuid[];
  v_orgs uuid[];
  v_labels text[];
  v_pattern text;
  v_executions integer := 0;
  v_settlements integer := 0;
  v_events integer := 0;
  v_alerts integer := 0;
  v_exclusions integer := 0;
  v_notifications integer := 0;
  v_payout integer := 0;
begin
  select * into d from public.drivers x where x.id = p_driver;
  if not found then
    return jsonb_build_object('organizations', 0);
  end if;

  select coalesce(array_agg(distinct t.ride_id), '{}'), coalesce(array_agg(distinct t.org_id), '{}')
    into v_rides, v_orgs
    from (
      select e.ride_id, e.organization_id as org_id
        from public.ride_network_executions e where e.executor_driver_id = p_driver
      union
      select o.ride_id, o.organization_id from public.ride_offers o where o.driver_id = p_driver and o.is_network
      union
      select x.ride_id, x.organization_id from public.ride_settlements x
       where x.network_driver_id = p_driver and x.network_driver_org_id is not null
      union
      select a.ride_id, a.organization_id from public.ride_alerts a
       where a.driver_id = p_driver and a.organization_id <> d.organization_id
    ) t;

  delete from public.driver_payout_details x where x.driver_id = p_driver;
  get diagnostics v_payout = row_count;
  if cardinality(v_orgs) = 0 then
    return jsonb_build_object('organizations', 0, 'payout_details', v_payout);
  end if;

  select coalesce(array_agg(distinct l.v), '{}') into v_labels
    from (
      select e.driver_label as v from public.ride_network_executions e where e.executor_driver_id = p_driver
      union
      select format('%s %s.', d.first_name, left(d.last_name, 1))
      union
      select btrim(btrim(d.first_name) || coalesce(' ' || nullif(left(btrim(d.last_name), 1), '') || '.', ''))
    ) l
   where char_length(btrim(coalesce(l.v, ''))) >= 2 and l.v <> v_alias;
  if cardinality(v_labels) > 0 then
    select '(?<![A-Za-z0-9_À-ÖØ-öø-ÿĀ-ž-])(?:'
           || string_agg(private.regex_escape(x), '|' order by char_length(x) desc, x)
           || ')(?![A-Za-z0-9_À-ÖØ-öø-ÿĀ-ž-])'
      into v_pattern
      from unnest(v_labels) x;
  end if;

  -- Exécutions : libellé et contrôles modifiables seulement sous rydar.network_scrub (G2)
  perform set_config('rydar.network_scrub', 'on', true);
  update public.ride_network_executions e
     set driver_label = v_alias,
         checks = e.checks - 'vtc_card_number',
         driver_dispute_reason = case when e.driver_dispute_reason is null then null else v_dispute end,
         contested_reason = case when e.contested_reason is null or v_pattern is null then e.contested_reason
                                 else left(regexp_replace(e.contested_reason, v_pattern, v_alias, 'g'), 300) end
   where e.executor_driver_id = p_driver;
  get diagnostics v_executions = row_count;
  perform set_config('rydar.network_scrub', '', true);

  update public.ride_settlements x
     set driver_label = case when v_pattern is null then x.driver_label
                             else regexp_replace(x.driver_label, v_pattern, v_alias, 'g') end,
         declared_note = null,
         note = case when x.note is null or v_pattern is null then x.note
                     else left(regexp_replace(x.note, v_pattern, v_alias, 'g'), 500) end,
         driver_dispute_reason = case when x.driver_dispute_reason is null then null else v_dispute end
   where x.network_driver_id = p_driver and x.network_driver_org_id is not null;
  get diagnostics v_settlements = row_count;

  if v_pattern is not null then
    update public.ride_events e
       set message = regexp_replace(e.message, v_pattern, v_alias, 'g'),
           data = private.jsonb_scrub(e.data, v_pattern, v_alias)
     where e.organization_id = any (v_orgs)
       and e.ride_id = any (v_rides)
       and (e.message ~ v_pattern or e.data::text ~ v_pattern);
    get diagnostics v_events = row_count;

    update public.ride_alerts a
       set message = left(regexp_replace(a.message, v_pattern, v_alias, 'g'), 300),
           data = private.jsonb_scrub(a.data, v_pattern, v_alias)
     where a.organization_id = any (v_orgs)
       and (a.ride_id = any (v_rides) or a.driver_id = p_driver)
       and (a.message ~ v_pattern or a.data::text ~ v_pattern);
    get diagnostics v_alerts = row_count;

    update private.network_driver_exclusions x
       set label = left(regexp_replace(x.label, v_pattern, v_alias, 'g'), 200)
     where x.giver_org_id = any (v_orgs)
       and x.execution_id in (select e.id from public.ride_network_executions e where e.executor_driver_id = p_driver)
       and x.label ~ v_pattern;
    get diagnostics v_exclusions = row_count;
  end if;

  delete from public.notifications n where n.driver_id = p_driver and n.organization_id <> d.organization_id;
  get diagnostics v_notifications = row_count;

  return jsonb_build_object('organizations', cardinality(v_orgs), 'executions', v_executions,
    'settlements', v_settlements, 'events', v_events, 'alerts', v_alerts, 'exclusions', v_exclusions,
    'notifications', v_notifications, 'payout_details', v_payout);
end;
$$;

-- Dernière définition : 20260924004800_audit_rgpd.sql. Réseau partagé (§10.10, S2) — seul ajout : les empreintes d'un
-- chauffeur PARTENAIRE parti en devant encore une part de courses partagées à p_org (private.network_debtor_identities,
-- creditor_org_id = p_org) comptent aussi, avec leur dette réseau ouverte envers p_org. Ces lignes n'ont ni fiche ni n°
-- (driver_id et driver_number NULL : fiche et n° de son organisation jamais montrés à p_org) ; fiches de p_org d'abord,
-- dans le même ordre qu'avant. Sans empreinte réseau : résultat identique.
create or replace function private.debtor_match(p_org uuid, p_phone text, p_email text, p_vtc_card text)
returns table (driver_id uuid, driver_number integer, owed_cents bigint, owed_count integer)
language sql
stable
set search_path = ''
as $$
  select y.driver_id, y.driver_number, y.owed_cents, y.owed_count
  from (
    select x.driver_id, x.driver_number, o.owed_cents, o.owed_count
    from (
      select distinct i.driver_id, i.driver_number
      from private.debtor_identities i
      where i.organization_id = p_org
        and ((i.kind = 'phone' and i.value_hash = private.identity_hash('phone', p_phone))
          or (i.kind = 'email' and i.value_hash = private.identity_hash('email', p_email))
          or (i.kind = 'vtc_card' and i.value_hash = private.identity_hash('vtc_card', p_vtc_card)))
    ) x
    cross join lateral private.driver_open_debt(x.driver_id) o
    where o.owed_count > 0
    union all
    -- Réseau partagé : chauffeur partenaire supprimé qui doit encore une part de courses partagées à p_org
    select null::uuid, null::integer, n.owed_cents, n.owed_count
    from (
      select distinct i.driver_id
      from private.network_debtor_identities i
      where i.creditor_org_id = p_org
        and ((i.kind = 'phone' and i.value_hash = private.identity_hash('phone', p_phone))
          or (i.kind = 'email' and i.value_hash = private.identity_hash('email', p_email))
          or (i.kind = 'vtc_card' and i.value_hash = private.identity_hash('vtc_card', p_vtc_card)))
    ) z
    cross join lateral (
      select coalesce(sum(s.amount_cents), 0)::bigint as owed_cents, count(*)::integer as owed_count
      from public.ride_settlements s
      where s.network_driver_id = z.driver_id
        and s.network_driver_org_id is not null
        and s.organization_id = p_org
        and s.direction = 'driver_owes'
        and s.status in ('due', 'declared', 'disputed')
        and s.amount_cents > 0
    ) n
    where n.owed_count > 0
  ) y
  order by y.driver_number nulls last;
$$;

-- Dernière définition : 20260924006300_fleet_join_link.sql. Réseau partagé (§10.10) — seuls ajouts : un chauffeur
-- partenaire supprimé qui doit encore une part de courses partagées à cette organisation (private.debtor_match, lignes
-- sans fiche ni n°) empêche aussi la validation automatique ; son journal le dit sans fiche, n° ni nom (« un chauffeur
-- partenaire »), montant réseau à part (« network_owed_cents »). Sans dette réseau : messages et données identiques.
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
  -- Réseau partagé : part de courses partagées due par un chauffeur partenaire supprimé (private.debtor_match)
  v_debt_network bigint;
  v_unit text;
  v_this text;
begin
  select * into o from public.organizations where id = p_org;
  if not found or o.status <> 'active' or not o.join_enabled then
    return jsonb_build_object('ok', false, 'code', 'JOIN_DISABLED', 'message', 'Ce lien d''inscription n''est plus actif.');
  end if;
  v_unit := case when o.dispatch_model = 'centrale' then 'la centrale' else 'la flotte' end;
  v_this := case when o.dispatch_model = 'centrale' then 'cette centrale' else 'cette flotte' end;
  if p_user_id is null or exists (select 1 from public.drivers x where x.user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_REGISTERED', 'message', 'Ce compte est déjà rattaché à une centrale ou à une flotte.');
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
    return jsonb_build_object('ok', false, 'code', 'PHONE_TAKEN', 'message', format('Ce numéro est déjà inscrit dans %s.', v_this));
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
      'inactive', 'offline', v_vehicle, 'new',
      'join_link', 'pending', left(nullif(btrim(coalesce(p_message, '')), ''), 1000), now())
    returning * into d;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      return jsonb_build_object('ok', false,
        'code', case when v_constraint like 'vehicles%' then 'PLATE_TAKEN'
                     when v_constraint like '%email%' then 'EMAIL_TAKEN'
                     else 'ALREADY_REGISTERED' end,
        'message', case when v_constraint like 'vehicles%' then format('Cette plaque est déjà enregistrée dans %s.', v_this)
                        when v_constraint like '%email%' then format('Cette adresse e-mail est déjà inscrite dans %s.', v_this)
                        else 'Ce compte est déjà inscrit.' end);
    when insufficient_privilege then
      -- identité bannie (trigger) : message volontairement neutre
      return jsonb_build_object('ok', false, 'code', 'IDENTITY_BANNED', 'message',
        format('Inscription impossible. Contactez %s.', case when o.dispatch_model = 'centrale' then 'la centrale' else o.name end));
    when check_violation or invalid_text_representation or numeric_value_out_of_range or string_data_right_truncation then
      return jsonb_build_object('ok', false, 'code', 'INVALID_FORM', 'message', 'Vérifiez le formulaire.');
  end;

  -- Ancien chauffeur de cette organisation parti avec des commissions dues (empreintes, private.debtor_identities) :
  -- possible aussi pour une flotte qui a été centrale
  -- Réseau partagé : aussi un chauffeur PARTENAIRE parti en devant une part de courses partagées à cette organisation
  -- (ligne sans fiche ni n° : jamais ceux de son organisation)
  select coalesce(sum(m.owed_cents), 0)::bigint, coalesce(sum(m.owed_count), 0)::integer,
         coalesce(array_agg(m.driver_number order by m.driver_number) filter (where m.driver_id is not null), '{}'),
         coalesce(array_agg(m.driver_id) filter (where m.driver_id is not null), '{}'),
         coalesce(sum(m.owed_cents) filter (where m.driver_id is null), 0)::bigint
    into v_debt_cents, v_debt_count, v_debt_numbers, v_debt_drivers, v_debt_network
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
      case
        -- Réseau partagé : seulement un chauffeur partenaire supprimé
        when cardinality(v_debt_numbers) = 0 then
          format('Candidature de %s %s (#%s) : même téléphone, e-mail ou carte VTC qu''un chauffeur partenaire qui a supprimé son compte en devant encore %s sur des courses partagées — à valider manuellement',
            d.first_name, d.last_name, d.number, private.fmt_eur(least(v_debt_cents, 2147483647)::integer))
        when v_debt_network > 0 then
          format('Candidature de %s %s (#%s) : même téléphone, e-mail ou carte VTC que %s, qui a supprimé son compte en devant encore %s de commissions, et qu''un chauffeur partenaire parti en devant %s sur des courses partagées — à valider manuellement',
            d.first_name, d.last_name, d.number,
            (select string_agg(format('« Chauffeur supprimé (#%s) »', n), ', ') from unnest(v_debt_numbers) n),
            private.fmt_eur(least(v_debt_cents - v_debt_network, 2147483647)::integer),
            private.fmt_eur(least(v_debt_network, 2147483647)::integer))
        else
      format('Candidature de %s %s (#%s) : même téléphone, e-mail ou carte VTC que %s, qui a supprimé son compte en devant encore %s de commissions — à valider manuellement',
        d.first_name, d.last_name, d.number,
        (select string_agg(format('« Chauffeur supprimé (#%s) »', n), ', ') from unnest(v_debt_numbers) n),
        private.fmt_eur(least(v_debt_cents, 2147483647)::integer))
      end,
      'system', 'warning',
      jsonb_build_object('driver_id', d.id, 'debtor_driver_ids', to_jsonb(v_debt_drivers),
        'debtor_numbers', to_jsonb(v_debt_numbers), 'owed_cents', v_debt_cents, 'owed_settlements', v_debt_count)
        || case when v_debt_network > 0 then jsonb_build_object('network_owed_cents', v_debt_network) else '{}'::jsonb end,
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
                     'owed_cents', v_debt_cents, 'owed_settlements', v_debt_count)
                     || case when v_debt_network > 0 then jsonb_build_object('network_owed_cents', v_debt_network)
                             else '{}'::jsonb end)
              else '{}'::jsonb end);

  return jsonb_build_object('ok', true, 'code', case when v_approved then 'APPROVED' else 'PENDING' end,
    'driver_id', d.id, 'number', d.number, 'organization', jsonb_build_object('name', o.name));
end;
$$;

-- Dernière définition : 20260924006900_shared_network_money.sql. Réseau partagé (lot administration, §10.10) — seul
-- ajout : private.scrub_network_traces avant l'effacement des traces propres et l'anonymisation (clé d'audit
-- « network_traces » seulement s'il y en a). Le corps 006900 est gardé à l'identique.
create or replace function private.delete_driver_account(p_driver_id uuid, p_source text, p_actor uuid default null)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  d public.drivers;
  q private.account_deletions;
  r public.rides;
  v_rides integer;
  v_release integer;
  -- Réseau partagé
  v_partner_rides integer;
  v_released integer := 0;
  v_org_active boolean;
  v_owed_cents bigint := 0;
  v_owed_count integer := 0;
  v_debtor_ids integer := 0;
  v_network_debtor_ids integer := 0;
  v_network_traces jsonb;
  v_alias text;
  v_key text;
  v_keep boolean;
  v_files integer;
  v_vehicle uuid;
  v_vehicle_action text;
  v_admin boolean := p_source = 'admin';
begin
  if p_source is null or p_source not in ('app', 'admin') then
    raise exception 'INVALID_SOURCE' using errcode = '22023';
  end if;
  select * into d from public.drivers where id = p_driver_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_DRIVER', 'message', 'Aucun compte chauffeur associé.');
  end if;

  -- Déjà supprimé (appel rejoué) : état de la file
  if d.deleted_at is not null then
    select * into q from private.account_deletions where driver_id = d.id;
    if q.id is not null then
      return jsonb_build_object('ok', true, 'code', 'DELETED', 'already_deleted', true) || private.account_deletion_json(q);
    end if;
    return jsonb_build_object('ok', true, 'code', 'DELETED', 'already_deleted', true,
      'driver_id', d.id, 'organization_id', d.organization_id, 'number', d.number,
      'storage_prefix', format('%s/%s/', d.organization_id, d.id), 'keep_auth', false,
      'deletion_id', null, 'done', true, 'pending', false);
  end if;

  -- Courses attribuées. Centrale suspendue ou archivée : les courses acceptées non commencées seront libérées ;
  -- les autres (commencées, ou toute course d'une centrale active) bloquent la suppression.
  select coalesce(o.status = 'active', false) into v_org_active from public.organizations o where o.id = d.organization_id;
  v_org_active := coalesce(v_org_active, false);
  -- Réseau partagé : une course d'une autre organisation (confiée à ce chauffeur) n'est jamais libérée ici (elle l'est
  -- par l'organisation qui l'a confiée, ou par le chien de garde du réseau) : elle refuse toujours la suppression
  select count(*),
         count(*) filter (where r0.status = 'ACCEPTED' and not v_org_active and r0.organization_id = d.organization_id),
         count(*) filter (where r0.organization_id <> d.organization_id)
    into v_rides, v_release, v_partner_rides
    from public.rides r0
   where r0.driver_id = d.id
     and r0.status in ('ACCEPTED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS');
  v_rides := v_rides - v_release;
  if v_rides > 0
     or (d.current_ride_id is not null and not exists (
           select 1 from public.rides x
            where x.id = d.current_ride_id and x.driver_id = d.id and x.status = 'ACCEPTED' and not v_org_active
              and x.organization_id = d.organization_id)) then
    return jsonb_build_object('ok', false, 'code', 'RIDES_ASSIGNED', 'count', greatest(v_rides, 1),
      'message', case
        -- Réseau partagé : c'est l'organisation qui a confié la course qui la retire
        when v_partner_rides > 0 and v_admin
        then 'Course d''une organisation partenaire attribuée à ce chauffeur : elle doit d''abord être terminée, ou retirée par l''organisation qui l''a confiée.'
        when v_partner_rides > 0
        then 'Vous avez une course confiée par une autre organisation : terminez-la ou demandez à l''organisation qui vous a confié la course de la retirer, puis supprimez votre compte.'
        when v_admin and v_rides > 1
        then format('%s courses attribuées à ce chauffeur : la centrale doit d''abord les terminer ou les réattribuer.', v_rides)
        when v_admin then 'Une course attribuée à ce chauffeur : la centrale doit d''abord la terminer ou la réattribuer.'
        when v_rides > 1
        then format('Vous avez %s courses attribuées : terminez-les ou demandez à votre centrale de les réattribuer, puis supprimez votre compte.', v_rides)
        else 'Vous avez une course attribuée : terminez-la ou demandez à votre centrale de la réattribuer, puis supprimez votre compte.' end);
  end if;

  if v_admin then
    perform private.set_actor('super_admin', p_actor);
  else
    perform private.set_actor('driver', d.id);
  end if;
  v_key := 'driver:' || d.id::text;
  v_alias := format('Chauffeur supprimé (#%s)', d.number);
  -- Compte conservé s'il sert aussi à gérer une centrale ou la plateforme
  v_keep := private.keeps_login_account(d.user_id);

  -- Centrale suspendue ou archivée : courses acceptées libérées (plus de dispatch pour elle : « à attribuer »)
  if v_release > 0 then
    for r in
      select * from public.rides x
       where x.driver_id = d.id and x.status = 'ACCEPTED'
         -- Réseau partagé : courses de son organisation seulement
         and x.organization_id = d.organization_id
       order by x.pickup_at, x.id
       for update
    loop
      update public.ride_assignments
         set is_active = false, released_at = now(), release_reason = 'driver_deleted'
       where ride_id = r.id and is_active;
      perform private.close_pending_offers(r.id, 'closed', 'driver_deleted');
      update public.rides
         set status = 'CREATED',
             driver_id = null,
             vehicle_id = null,
             dispatch_wave = 0,
             dispatch_radius_m = null,
             dispatch_started_at = null,
             next_dispatch_at = null,
             accepted_at = null,
             driver_en_route_at = null,
             driver_arrived_at = null,
             no_driver_at = null
       where id = r.id;
      perform private.close_ride_alerts(r.id, 'auto_resolved', null);
      perform private.log_event(r.organization_id, r.id, 'ride.driver_deleted',
        format('Course retirée au chauffeur #%s, qui a supprimé son compte (centrale inactive) — à attribuer manuellement', d.number),
        'timeline', 'warning', jsonb_build_object('previous_driver_id', d.id, 'previous_status', r.status),
        case when v_admin then 'super_admin' else 'driver' end::public.actor_type,
        case when v_admin then p_actor else d.id end);
      v_released := v_released + 1;
    end loop;
  end if;

  -- Commissions encore dues à la centrale : empreintes gardées tant que la dette est ouverte (avant l'effacement
  -- des identifiants), jamais la valeur en clair
  select o.owed_cents, o.owed_count into v_owed_cents, v_owed_count from private.driver_open_debt(d.id) o;
  if coalesce(v_owed_count, 0) > 0 then
    insert into private.debtor_identities (organization_id, driver_id, driver_number, kind, value_hash)
    select d.organization_id, d.id, d.number, i.kind, i.value_hash
      from private.driver_identities(d.id, false) i
     where i.kind in ('phone', 'email', 'vtc_card')
    on conflict (driver_id, kind, value_hash) do nothing;
    get diagnostics v_debtor_ids = row_count;
  end if;

  -- Réseau partagé (§10.10, S2) : sommes encore dues à des organisations partenaires (reversements réseau ouverts) →
  -- empreintes (téléphone, e-mail, carte VTC ; jamais la valeur) gardées pour CHAQUE créancière dans
  -- private.network_debtor_identities, avant l'effacement des identifiants : le chauffeur ne revient pas chez elle par
  -- une autre organisation (private.network_identity_block, « debtor ») ; purgées par private.housekeeping une fois tout
  -- réglé. Empreintes de l'index d'identités (toutes les formes du téléphone) et des pièces.
  insert into private.network_debtor_identities (creditor_org_id, driver_id, kind, value_hash)
  select c.organization_id, d.id, i.kind, i.value_hash
    from (select distinct x.organization_id
            from public.ride_settlements x
           where x.network_driver_id = d.id
             and x.network_driver_org_id is not null
             and x.direction = 'driver_owes'
             and x.status in ('due', 'declared', 'disputed')
             and x.amount_cents > 0) c
   cross join (select k.kind, k.value_hash from private.driver_identity_keys k
                where k.driver_id = d.id and k.kind in ('phone', 'email', 'vtc_card')
               union
               select y.kind, y.value_hash from private.driver_identities(d.id, false) y
                where y.kind in ('phone', 'email', 'vtc_card')) i
  on conflict (creditor_org_id, driver_id, kind, value_hash) do nothing;
  get diagnostics v_network_debtor_ids = row_count;

  -- Réseau partagé (lot administration, §10.10, S4) : ses traces chez les organisations qui lui ont confié des courses
  -- effacées, son nom encore connu (libellés « Chauffeur supprimé · {B} », note de paiement, motifs de contestation,
  -- contrôles réduits aux échéances, notifications, RIB) ; aucune trace réseau : rien ne change
  v_network_traces := private.scrub_network_traces(d.id);

  -- Offres en attente closes (le chauffeur ne peut plus répondre)
  update public.ride_offers
     set status = 'closed', closed_reason = 'driver_deleted', responded_at = now()
   where driver_id = d.id and status = 'pending';

  -- Nom et identification retirés de tout ce qui les a recopiés (avant l'anonymisation : noms encore connus)
  perform private.scrub_driver_traces(d.id, d.organization_id, d.created_at, d.first_name, d.last_name, d.number, v_alias);

  -- Données personnelles supprimées (les fichiers des justificatifs : dossier purgé via la file)
  select count(*) into v_files from public.driver_documents x where x.driver_id = d.id;
  delete from public.driver_documents where driver_id = d.id;
  delete from public.push_tokens where driver_id = d.id;
  delete from public.driver_devices where driver_id = d.id;
  delete from public.driver_locations where driver_id = d.id;
  delete from public.driver_location_history where driver_id = d.id;
  delete from public.notifications where driver_id = d.id;
  delete from public.chat_report_votes where voter_key = v_key;
  delete from public.chat_reads where reader_key = v_key or thread_key = v_key;
  delete from public.chat_messages where driver_id = d.id or author_driver_id = d.id;

  -- Véhicule personnel (inscription par lien), utilisé par aucun autre chauffeur
  if d.vehicle_id is not null and d.joined_via = 'join_link'
     and not exists (select 1 from public.drivers x where x.vehicle_id = d.vehicle_id and x.id <> d.id) then
    v_vehicle := d.vehicle_id;
  end if;

  -- Fiche anonymisée, détachée du compte de connexion ; conservée pour les courses et règlements passés.
  -- Membre de centrale : ses sessions de gestion ne sont pas coupées (drivers_revoke_sessions).
  if v_keep then
    perform set_config('rydar.keep_sessions', d.user_id::text, true);
  end if;
  update public.drivers
     set first_name = 'Chauffeur',
         last_name = 'supprimé',
         phone = '',
         email = null,
         photo_url = null,
         vtc_card_number = null,
         notes = null,
         application_status = null,
         application_message = null,
         application_note = null,
         suspended_reason = case when v_admin then 'Compte supprimé à la demande du chauffeur' else 'Compte supprimé par le chauffeur' end,
         -- (motif de bannissement conservé contre la fraude, son nom déjà retiré par scrub_driver_traces)
         status = 'inactive',
         presence = 'offline',
         online_since = null,
         last_seen_at = null,
         current_ride_id = null,
         vehicle_id = null,
         user_id = null,
         deleted_at = now()
   where id = d.id;
  perform set_config('rydar.keep_sessions', '', true);

  if v_vehicle is not null then
    if exists (select 1 from public.rides r1 where r1.vehicle_id = v_vehicle)
       or exists (select 1 from public.ride_assignments a where a.vehicle_id = v_vehicle) then
      update public.vehicles
         set plate = 'SUPPR-' || upper(left(replace(v_vehicle::text, '-', ''), 10)),
             brand = null,
             model = 'Véhicule supprimé',
             color = null,
             year = null,
             is_active = false
       where id = v_vehicle;
      v_vehicle_action := 'anonymized';
    else
      delete from public.vehicles where id = v_vehicle;
      v_vehicle_action := 'deleted';
    end if;
  end if;

  -- Compte de connexion (supprimé par la file) : nom et téléphone effacés dès maintenant
  if d.user_id is not null and not v_keep then
    update public.users set full_name = null, phone = null, avatar_url = null where id = d.user_id;
    begin
      update auth.users
         set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) - array['full_name', 'name', 'phone', 'avatar_url']
       where id = d.user_id;
    exception when insufficient_privilege or undefined_table or undefined_column then
      raise warning 'delete_driver_account: métadonnées Auth non effacées (privilèges)';
    end;
  end if;

  insert into private.account_deletions (driver_id, organization_id, driver_number, user_id, keep_auth, storage_prefix,
    source, requested_by, auth_done_at, next_attempt_at)
  values (d.id, d.organization_id, d.number, d.user_id, v_keep, format('%s/%s/', d.organization_id, d.id),
    p_source, case when v_admin then p_actor end,
    case when d.user_id is null or v_keep then now() end,
    -- traitée aussitôt par l'appelant ; le worker ne la reprend qu'en cas d'échec
    now() + interval '2 minutes')
  returning * into q;

  -- Journal d'audit du chauffeur et de son véhicule d'inscription : valeurs personnelles, adresse IP et navigateur
  -- retirés (l'action reste tracée)
  perform private.redact_driver_audit(d.id, d.user_id, v_keep, v_vehicle);

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (d.organization_id, case when v_admin then 'super_admin' else 'driver' end::public.actor_type,
    case when v_admin then p_actor end, 'driver.deleted', 'drivers', d.id::text, 'warning',
    jsonb_build_object('number', d.number, 'source', p_source, 'documents', v_files, 'keep_auth', v_keep,
      'vehicle', v_vehicle_action, 'deletion_id', q.id, 'rides_released', v_released,
      'owed_cents', v_owed_cents, 'owed_settlements', v_owed_count, 'debtor_identities', v_debtor_ids)
      -- Réseau partagé : empreintes gardées pour des organisations partenaires (clé absente sinon)
      || case when v_network_debtor_ids > 0 then jsonb_build_object('network_debtor_identities', v_network_debtor_ids)
              else '{}'::jsonb end
      -- Réseau partagé : traces effacées chez des organisations partenaires (clé absente sinon)
      || case when coalesce((v_network_traces ->> 'organizations')::integer, 0) > 0
              then jsonb_build_object('network_traces', v_network_traces) else '{}'::jsonb end);

  perform private.log_event(d.organization_id, null, 'driver.deleted',
    case when v_admin then format('Compte du chauffeur #%s supprimé à sa demande (traité par Rydar Drive)', d.number)
         else format('Le chauffeur #%s a supprimé son compte', d.number) end
    || case when coalesce(v_owed_count, 0) > 0
            then format(' — reste dû : %s de commissions (%s règlement%s au nom de « %s »)',
                   private.fmt_eur(least(v_owed_cents, 2147483647)::integer), v_owed_count,
                   case when v_owed_count > 1 then 's' else '' end, v_alias)
            else '' end,
    'system', 'warning',
    jsonb_build_object('driver_id', d.id, 'source', p_source, 'rides_released', v_released,
      'owed_cents', v_owed_cents, 'owed_settlements', v_owed_count),
    case when v_admin then 'super_admin' else 'driver' end::public.actor_type,
    case when v_admin then p_actor else d.id end);

  return jsonb_build_object('ok', true, 'code', 'DELETED', 'already_deleted', false, 'documents', v_files,
      'vehicle', v_vehicle_action, 'rides_released', v_released)
    || private.account_deletion_json(q);
end;
$$;

-- =============================================================================
-- 6. Index : offres réseau reçues par les chauffeurs d'une organisation (vue d'ensemble du super admin, 30 jours ;
--    index partiel : offres réseau seulement)
-- =============================================================================
create index if not exists ride_offers_network_exec_idx on public.ride_offers (driver_org_id, sent_at desc) where is_network;

-- =============================================================================
-- 7. Droits
-- =============================================================================
-- Aides : fonctions serveur seulement (RPC definer, worker, service role)
revoke all on function
  private.network_approval_status(public.network_memberships),
  private.network_review_email(uuid, boolean, text),
  private.admin_network_org_row(public.organizations, public.network_memberships),
  private.scrub_network_traces(uuid)
from public, anon, authenticated;
grant execute on function
  private.network_approval_status(public.network_memberships),
  private.network_review_email(uuid, boolean, text),
  private.admin_network_org_row(public.organizations, public.network_memberships)
to service_role;
-- Effacement des traces : seulement par private.delete_driver_account (même règle que private.scrub_driver_traces)
revoke all on function private.scrub_network_traces(uuid) from service_role;

-- Super admin : service role seul (actions serveur requireSuperAdmin() ; auteur revérifié dans la fonction)
revoke all on function
  public.svc_set_shared_network_enabled(uuid, boolean),
  public.svc_network_approve(uuid, uuid, boolean, boolean, text),
  public.svc_network_suspend(uuid, uuid, boolean, text)
from public, anon, authenticated;
grant execute on function
  public.svc_set_shared_network_enabled(uuid, boolean),
  public.svc_network_approve(uuid, uuid, boolean, boolean, text),
  public.svc_network_suspend(uuid, uuid, boolean, text)
to service_role;

-- RPC : contrôle d'accès dans la fonction (super admin, membre, owner / admin, chauffeur)
revoke all on function
  public.admin_network_overview(),
  public.org_network_readiness(uuid),
  public.network_driver_readiness(uuid),
  public.set_network_settings(uuid, boolean, boolean, text, boolean, integer),
  public.set_network_exclusion(uuid, uuid, boolean)
from public, anon;
grant execute on function
  public.admin_network_overview(),
  public.org_network_readiness(uuid),
  public.network_driver_readiness(uuid),
  public.set_network_settings(uuid, boolean, boolean, text, boolean, integer),
  public.set_network_exclusion(uuid, uuid, boolean)
to authenticated, service_role;
