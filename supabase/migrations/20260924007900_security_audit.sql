-- =============================================================================
-- Rydar Drive — Audit de sécurité p5 : corrections en base (constats reproduits, tests tests/db/security-audit.test.ts)
--
--  1. Réseau partagé (critique, données de localisation) : l'organisation d'un chauffeur en course pour une autre
--     organisation retrouvait sa position par des distances calculées sur ses propres courses (offre planifiée à toute
--     la flotte, explication de fin de recherche, alertes de suivi). Règle unique : chauffeur pour qui
--     private.driver_on_foreign_ride est vrai → aucune position ni distance dérivée rendue à son organisation.
--  2. Limites de l'offre (chauffeurs, accès) comptées sous le verrou de l'organisation (requêtes simultanées).
--  3. Centrale : prix, commission et moyen de paiement d'une course qui a un règlement modifiables par le propriétaire
--     et les administrateurs seulement (un dispatcher ne fait plus tomber une commission à 0 ni ne renverse le sens).
--  4. Accusés de réception (contact, éligibilité, mini-site) : limites comptées par BOÎTE (private.mailbox_key :
--     « +étiquette » et points Gmail ignorés), plus par adresse exacte.
--  5. Jetons push liés à la session Auth qui les a enregistrés : session révoquée ou expirée → plus de notification
--     vers ce téléphone (mot de passe changé, « Se déconnecter » ailleurs).
--  6. Position du chauffeur : saut impossible (plus de 1 km au-delà de 250 km/h) ignoré (LOCATION_IMPLAUSIBLE).
--  7. Suppression de compte : « compte de connexion conservé » recalculé à chaque reprise (compte devenu gérant ou
--     super admin entre la demande et la suppression effective).
--
-- Fonctions redéfinies (corps repris de leur dernière définition, ajouts marqués « Audit 007900 », signatures et droits
-- inchangés) :
--   private.offer_to_fleet(uuid)                      — Dernière définition : 20260924006800_shared_network_dispatch.sql
--   private.explain_no_driver(uuid)                   — Dernière définition : 20260924003200_dispatch_strict_waves.sql
--   private.watch_rides()                             — Dernière définition : 20260924007000_shared_network_access.sql
--   private.enforce_plan_limits()                     — Dernière définition : 20260924000700_limits_audit.sql
--   private.rides_centrale_split()                    — Dernière définition : 20260924004400_audit_argent.sql
--   public.svc_contact_submit(jsonb, jsonb)           — Dernière définition : 20260924005700_contact_requests.sql
--   public.svc_booking_receipt(uuid)                  — Dernière définition : 20260924007400_legal_review.sql
--   public.driver_register_device(...)                — Dernière définition : 20260924006650_audit_fixes.sql
--   private.claim_notifications(integer)              — Dernière définition : 20260924006650_audit_fixes.sql
--   public.update_driver_location(...)                — Dernière définition : 20260924007400_legal_review.sql
--   private.claim_account_deletions(integer)          — Dernière définition : 20260924004000_account_deletion_fixes.sql
--   public.svc_account_deletion_retry(uuid, uuid)     — Dernière définition : 20260924004000_account_deletion_fixes.sql
--   private.complete_account_deletion(uuid, boolean, boolean, text)
--                                                     — Dernière définition : 20260924004800_audit_rgpd.sql
-- Nouvelle fonction : private.mailbox_key(text). Nouvelle colonne : public.push_tokens.session_id.
-- =============================================================================

-- =============================================================================
-- 1. Réseau partagé : position d'un chauffeur en course partenaire jamais rendue à sa propre organisation
-- =============================================================================

-- Dernière définition : 20260924006800_shared_network_dispatch.sql. Seul ajout : distance NULL pour un chauffeur en
-- course pour une autre organisation (ride_offers.distance_m est lu par tout membre et diffusé sur org:{id}).

create or replace function private.offer_to_fleet(p_ride_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  s public.organization_settings;
  v_tz text;
  v_when text;
  v_expires timestamptz;
  v_count integer := 0;
  v_pending integer := 0;
  v_first boolean;
  v_from text;
  v_to text;
  v_centrale boolean;
  -- Réseau partagé
  v_network_at timestamptz;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.status not in ('SEARCHING_DRIVER', 'OFFERED') or r.driver_id is not null then
    return 0;
  end if;

  select * into s from public.organization_settings where organization_id = r.organization_id;
  select o.timezone, coalesce(o.dispatch_model = 'centrale', false) into v_tz, v_centrale
  from public.organizations o where o.id = r.organization_id;
  v_when := to_char(r.pickup_at at time zone coalesce(v_tz, 'Europe/Paris'), 'DD/MM HH24:MI');
  v_expires := greatest(
    r.pickup_at - make_interval(mins => coalesce(s.scheduled_dispatch_lead_minutes, 60)),
    now() + make_interval(secs => coalesce(s.offer_timeout_seconds, 30))
  );
  v_from := coalesce(private.short_address(r.pickup_address), r.pickup_address);
  v_to := coalesce(private.short_address(r.dropoff_address), r.dropoff_address);
  v_first := r.dispatch_wave = 0;

  with candidates as (
    select d.id as driver_id,
           -- Audit 007900 : chauffeur en course pour une autre organisation (réseau partagé) → aucune distance
           case when l.driver_id is null or private.driver_on_foreign_ride(d.id) then null
                else round(extensions.st_distance(l.location, r.pickup_location))::integer end as distance_m
    from public.drivers d
    left join public.driver_locations l on l.driver_id = d.id
    left join public.vehicles v on v.id = d.vehicle_id
    where d.organization_id = r.organization_id
      and d.status = 'active'
      and private.category_compatible(r.vehicle_category, v.category, s.allow_category_upgrade)
      and coalesce(v.seats, 0) >= r.passengers
      and (case when v_centrale then private.centrale_blocker(d.id, d.trust_level, r.price_cents,
             s.block_unpaid, s.settlement_credit_limit_cents, s.new_driver_max_price_cents) end) is null
      and not exists (
        select 1 from public.ride_offers o
        where o.ride_id = r.id and o.driver_id = d.id
          and (o.status in ('pending', 'declined') or o.closed_reason = 'removed_by_dispatch')
      )
  ),
  ins as (
    insert into public.ride_offers (organization_id, ride_id, driver_id, status, mode, wave, distance_m, expires_at)
    select r.organization_id, r.id, c.driver_id, 'pending', 'fleet', 1, c.distance_m, v_expires
    from candidates c
    returning id, driver_id
  ),
  notif as (
    insert into public.notifications (organization_id, driver_id, ride_id, offer_id, type, title, body, data, priority)
    select r.organization_id, i.driver_id, r.id, i.id, 'ride_offer_scheduled', 'NOUVELLE COURSE PLANIFIÉE',
           case when v_centrale and r.driver_payout_cents is not null
                then format('%s · %s → %s · Vous gagnez %s (course %s)', v_when, v_from, v_to,
                       private.fmt_eur(r.driver_payout_cents), private.fmt_eur(r.price_cents))
                else format('%s · %s → %s · %s', v_when, v_from, v_to, private.fmt_eur(r.price_cents))
           end,
           jsonb_build_object(
             'type', 'ride_offer_scheduled', 'offer_id', i.id, 'ride_id', r.id, 'ride_type', r.type,
             'pickup', r.pickup_address, 'dropoff', r.dropoff_address, 'pickup_at', r.pickup_at,
             'price_cents', r.price_cents, 'passengers', r.passengers, 'expires_at', v_expires,
             'driver_payout_cents', r.driver_payout_cents, 'commission_cents', r.commission_cents,
             'platform_fee_cents', r.platform_fee_cents),
           'high'
    from ins i
    returning 1
  )
  select count(*)::integer into v_count from ins;

  -- échéance recalculée (délai de bascule modifié dans les réglages)
  update public.ride_offers
     set expires_at = v_expires
   where ride_id = r.id and status = 'pending' and mode = 'fleet' and expires_at is distinct from v_expires;

  select count(*) into v_pending from public.ride_offers o where o.ride_id = r.id and o.status = 'pending' and o.mode = 'fleet';

  -- Réseau partagé : réveil à l'ouverture de la fenêtre réseau (organisation qui partage, fenêtre avant T-lead)
  if r.network_at is null and private.network_wants_share(r.organization_id) then
    v_network_at := private.network_window_at(r);
    if v_network_at <= now()
       or v_network_at >= r.pickup_at - make_interval(mins => coalesce(s.scheduled_dispatch_lead_minutes, 60)) then
      v_network_at := null;
    end if;
  end if;

  update public.rides
     set status = case when v_pending > 0 then 'OFFERED' else 'SEARCHING_DRIVER' end::public.ride_status,
         offered_at = case when v_pending > 0 then coalesce(offered_at, now()) else offered_at end,
         dispatch_wave = 1,
         -- nouveau passage dans 5 min (nouveaux chauffeurs), au plus tard à T-lead (bascule GPS)
         -- (Réseau partagé : ou à l'ouverture de la fenêtre réseau ; least() ignore NULL)
         next_dispatch_at = least(v_expires, now() + interval '5 minutes', v_network_at)
   where id = r.id;

  if v_count > 0 then
    perform private.log_event(r.organization_id, r.id, 'dispatch.fleet',
      case when v_first
           then format('Course proposée à la flotte — %s %s', v_count, private.pl(v_count, 'chauffeur notifié', 'chauffeurs notifiés'))
           else format('Course proposée à %s %s de la flotte', v_count, private.pl(v_count, 'nouveau chauffeur', 'nouveaux chauffeurs'))
      end,
      'timeline', 'success', jsonb_build_object('count', v_count, 'pending', v_pending, 'open_until', v_expires), 'system', null);
    perform pg_notify('rydar_notifications', r.id::text);
  elsif v_first then
    perform private.log_event(r.organization_id, r.id, 'dispatch.fleet_empty',
      'Aucun chauffeur compatible dans la flotte pour l''instant — nouvel essai toutes les 5 min, puis recherche GPS avant la prise en charge',
      'timeline', 'warning', jsonb_build_object('open_until', v_expires), 'system', null);
  end if;

  return v_count;
end;
$$;

-- Dernière définition : 20260924003200_dispatch_strict_waves.sql. Seul ajout : chauffeur en course pour une autre
-- organisation classé « déjà en course » (busy), sans distance (journal « dispatch.excluded » lu par tout membre).

create or replace function private.explain_no_driver(p_ride_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  s public.organization_settings;
  v_centrale boolean;
  v_window interval;
  v_max_radius integer;
  v_items jsonb;
  v_counts jsonb;
  v_total integer;
  v_shown text;
begin
  select * into r from public.rides where id = p_ride_id;
  if not found or r.driver_id is not null then
    return;
  end if;
  select * into s from public.organization_settings where organization_id = r.organization_id;
  select coalesce(o.dispatch_model = 'centrale', false) into v_centrale from public.organizations o where o.id = r.organization_id;
  v_window := private.dispatch_location_window(s.location_max_age_seconds);
  select max(x) into v_max_radius from unnest(private.dispatch_plan(s.dispatch_radii_m, s.dispatch_retry_radii_m)) x;

  with online as (
    select d.id, d.first_name, d.last_name, d.presence, d.vehicle_id, v.category, v.seats, l.updated_at, l.accuracy_m,
           -- Audit 007900 : chauffeur en course pour une autre organisation (réseau partagé) : « déjà en course »,
           -- sans distance (sa position n'est jamais rendue à son organisation pendant cette course)
           private.driver_on_foreign_ride(d.id) as on_foreign_ride,
           case when l.driver_id is not null and r.pickup_location is not null
                     and not private.driver_on_foreign_ride(d.id)
                then round(extensions.st_distance(l.location, r.pickup_location))::integer end as distance_m,
           (select case when o.status = 'declined' then 'declined'
                        when o.closed_reason = 'removed_by_dispatch' then 'removed'
                        else 'ignored' end
              from public.ride_offers o
             where o.ride_id = r.id and o.driver_id = d.id
               and (o.status = 'declined' or o.closed_reason = 'removed_by_dispatch'
                    or (o.closed_reason in ('ignored', 'timeout') and o.sent_at >= r.dispatch_started_at))
             order by o.sent_at desc limit 1) as offer_state,
           case when v_centrale then private.centrale_blocker(d.id, d.trust_level, r.price_cents, s.block_unpaid,
                  s.settlement_credit_limit_cents, s.new_driver_max_price_cents) end as blocker
    from public.drivers d
    left join public.driver_locations l on l.driver_id = d.id
    left join public.vehicles v on v.id = d.vehicle_id
    where d.organization_id = r.organization_id
      and d.status = 'active'
      and d.presence <> 'offline'
  ),
  classified as (
    select o.*,
      case
        when o.offer_state is not null then o.offer_state
        when o.on_foreign_ride or o.presence <> 'available' then 'busy'
        when o.vehicle_id is null then 'no_vehicle'
        when not private.category_compatible(r.vehicle_category, o.category, s.allow_category_upgrade) then 'category'
        when coalesce(o.seats, 0) < r.passengers then 'seats'
        when o.updated_at is null or o.updated_at <= now() - v_window then 'stale'
        when coalesce(o.accuracy_m, 0) > 1500 then 'accuracy'
        when o.blocker is not null then 'blocked'
        when o.distance_m > v_max_radius then 'far'
      end as reason
    from online o
  ),
  explained as (
    select c.*,
      format('%s %s.', c.first_name, left(coalesce(c.last_name, ''), 1)) as name,
      case c.reason
        when 'busy' then case when not c.on_foreign_ride and c.presence = 'offered' then 'offre en cours pour une autre course'
                              else 'déjà en course' end
        when 'declined' then 'a refusé cette course'
        when 'removed' then 'retiré de cette course par la centrale'
        when 'ignored' then 'n''a pas répondu à l''offre'
        when 'no_vehicle' then 'aucun véhicule associé'
        when 'category' then format('véhicule %s, course %s', coalesce(private.category_label(c.category), '—'),
                                    private.category_label(r.vehicle_category))
        when 'seats' then format('%s places, %s passagers', coalesce(c.seats, 0), r.passengers)
        when 'stale' then case when c.updated_at is null then 'aucune position GPS reçue'
                               when c.updated_at > now() - interval '90 minutes'
                                 then format('aucune position reçue depuis %s min (application fermée ?)', greatest(1, round(extract(epoch from now() - c.updated_at) / 60)))
                               else format('aucune position reçue depuis %s h', round(extract(epoch from now() - c.updated_at) / 3600)) end
        when 'accuracy' then format('position GPS imprécise (± %s m)', round(c.accuracy_m))
        when 'blocked' then case c.blocker when 'unpaid' then 'commission en retard'
                                           when 'credit_limit' then 'plafond de commissions atteint'
                                           else 'course réservée aux chauffeurs confirmés' end
        when 'far' then format('à %s, au-delà du rayon de %s', private.fmt_km((round(c.distance_m / 100.0) * 100)::integer), private.fmt_km(v_max_radius))
      end as label
    from classified c
    where c.reason is not null
  )
  select
    coalesce(jsonb_agg(jsonb_build_object('driver_id', e.id, 'name', e.name, 'reason', e.reason, 'label', e.label,
                                          'distance_m', e.distance_m)
                       order by e.distance_m nulls last, e.name), '[]'::jsonb),
    count(*)::integer
  into v_items, v_total
  from explained e;

  if v_total = 0 then
    return;
  end if;

  select jsonb_object_agg(k, n) into v_counts
  from (select x->>'reason' as k, count(*) as n from jsonb_array_elements(v_items) x group by 1) t;

  -- Les 3 plus proches : « Mohamed M. (320 m) : véhicule Berline, course Business » (distances arrondies à 10 m)
  select string_agg(
           format('%s%s : %s', x->>'name',
                  case when x->>'distance_m' is not null then format(' (%s)', private.fmt_km((round((x->>'distance_m')::numeric / 10) * 10)::integer)) else '' end,
                  x->>'label'),
           ' · ' order by ord)
    into v_shown
  from jsonb_array_elements(v_items) with ordinality as t(x, ord)
  where ord <= 3;

  perform private.log_event(r.organization_id, r.id, 'dispatch.excluded',
    format('%s %s en ligne %s pas pris la course — %s%s', v_total, private.pl(v_total, 'chauffeur', 'chauffeurs'),
           private.pl(v_total, 'n''a', 'n''ont'), v_shown,
           case when v_total > 3 then format(' · et %s autre%s', v_total - 3, case when v_total - 3 > 1 then 's' else '' end) else '' end),
    'timeline', 'warning', jsonb_build_object('excluded', v_items, 'counts', v_counts), 'system', null);
end;
$$;

-- Dernière définition : 20260924007000_shared_network_access.sql. Seul ajout (v_hidden) : course de l'organisation
-- du chauffeur pendant qu'il roule pour une autre organisation → retard, immobilité et GPS muet non évalués (aucune
-- distance, heure d'arrivée ni coordonnée calculée sur sa position).

create or replace function private.watch_rides()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  x record;
  a record;
  r public.rides;
  d public.drivers;
  s public.organization_settings;
  l public.driver_locations;
  v_tz text;
  v_watched boolean;
  v_has_loc boolean;
  v_fresh boolean;
  v_gps_max integer;
  v_age integer;
  v_dist integer;
  v_dist_label text;
  v_eta integer;
  v_d0 integer;
  v_ref timestamptz;
  v_delay integer;
  v_tolerance integer;
  v_stall_min integer;
  v_start timestamptz;
  v_last_away timestamptz;
  v_since timestamptz;
  v_still integer;
  v_cond boolean;
  v_severity text;
  v_message text;
  v_data jsonb;
  v_res text;
  v_checked integer := 0;
  v_opened integer := 0;
  v_updated integer := 0;
  v_resolved integer := 0;
  v_skipped integer := 0;
  -- Réseau partagé
  v_network jsonb;
  v_who text;
  -- Audit 007900
  v_hidden boolean;
begin
  -- Plusieurs workers : un seul passage à la fois (les autres sortent aussitôt)
  if not pg_try_advisory_xact_lock(1918985550, 2200) then
    return jsonb_build_object('ok', false, 'code', 'LOCKED', 'checked', 0, 'opened', 0, 'updated', 0, 'resolved', 0, 'skipped', 0);
  end if;
  perform private.set_actor('system', null);

  for x in
    select c.id
    from (
      select r0.id
      from public.rides r0
      where r0.driver_id is not null
        and (
          r0.status in ('DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS')
          or (r0.status = 'ACCEPTED' and (r0.type = 'instant' or r0.pickup_at < now() + interval '90 minutes'))
        )
      union
      select a0.ride_id from public.ride_alerts a0 where a0.status in ('open', 'acknowledged')
    ) c
    order by c.id
  loop
    -- Course en cours de modification (acceptation, réattribution…) : on repassera
    select * into r from public.rides where id = x.id for no key update skip locked;
    if not found then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    v_checked := v_checked + 1;

    v_watched := r.driver_id is not null and (
      r.status in ('DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'PASSENGER_ONBOARD', 'IN_PROGRESS')
      or (r.status = 'ACCEPTED' and (r.type = 'instant' or r.pickup_at < now() + interval '90 minutes'))
    );

    -- Course terminée / annulée / remise en recherche / autre chauffeur : alertes closes.
    -- Sourdine écoulée : l'alerte « gardée » est close (une nouvelle peut s'ouvrir ci-dessous).
    for a in
      update public.ride_alerts
         set status = 'resolved',
             resolution = coalesce(resolution, 'auto_resolved'),
             resolved_at = now()
       where ride_id = r.id
         and status in ('open', 'acknowledged')
         and (
           not v_watched
           or driver_id is distinct from r.driver_id
           or (status = 'acknowledged' and muted_until <= now())
         )
      returning id, kind, resolution
    loop
      v_resolved := v_resolved + 1;
      if a.resolution = 'auto_resolved' then
        perform private.log_event(r.organization_id, r.id, 'alert.resolved',
          format('Alerte close : %s', private.ride_alert_label(a.kind)), 'dispatch', 'info',
          jsonb_build_object('alert_id', a.id, 'kind', a.kind, 'resolution', a.resolution), 'system', null);
      end if;
    end loop;

    continue when not v_watched;

    select * into d from public.drivers where id = r.driver_id;
    continue when not found;
    -- Réseau partagé (§11.5, S3) : chauffeur d'une autre organisation cité par son libellé court (« Prénom I. · B »)
    v_who := case when d.organization_id <> r.organization_id
                  then coalesce(private.driver_label_for(d.id, r.organization_id), d.first_name) else d.first_name end;
    select * into s from public.organization_settings where organization_id = r.organization_id;
    select o.timezone into v_tz from public.organizations o where o.id = r.organization_id;
    select * into l from public.driver_locations where driver_id = r.driver_id;
    v_has_loc := found;
    -- Audit 007900 : chauffeur de l'organisation de la course, en ce moment en course pour une autre organisation
    -- (réseau partagé) : sa position n'est jamais rendue à son organisation, ni telle quelle ni par une distance, une
    -- heure d'arrivée ou une immobilité calculées. Retard, immobilité et GPS muet ne sont pas évalués pour cette course
    -- (alertes ouvertes laissées telles quelles) jusqu'à la fin de la course partenaire ; « non démarrée » reste
    -- (présence et âge de la dernière position seulement).
    v_hidden := d.organization_id = r.organization_id and private.driver_on_foreign_ride(d.id);

    v_gps_max := greatest(coalesce(s.location_max_age_seconds, 180), 180);
    v_tolerance := coalesce(s.late_alert_tolerance_minutes, 5);
    v_stall_min := coalesce(s.stalled_alert_minutes, 4);
    if v_has_loc then
      v_age := greatest(0, floor(extract(epoch from (now() - l.updated_at))))::integer;
      v_fresh := v_age <= v_gps_max;
      v_dist := round(extensions.st_distance(l.location, r.pickup_location))::integer;
      v_dist_label := private.fmt_km(round(v_dist::numeric, -2)::integer);
    else
      v_age := null;
      v_fresh := false;
      v_dist := null;
      v_dist_label := null;
    end if;

    -- ---------------------------------------------------------------- retard
    v_cond := false;
    v_severity := null;
    v_message := null;
    v_data := null;
    if v_hidden then
      v_cond := null;
    elsif r.status in ('ACCEPTED', 'DRIVER_EN_ROUTE') then
      if not v_fresh then
        v_cond := null; -- position inconnue : c'est l'alerte GPS qui parle
      else
        v_eta := round(v_dist * 1.35 / 8.3)::integer;
        -- Heure de référence :
        --  * planifiée : l'heure réservée (pickup_at) ;
        --  * instantanée (« dès que possible ») : l'heure promise à l'acceptation =
        --    greatest(pickup_at, acceptation + trajet estimé à ce moment-là), la distance
        --    venant de l'offre acceptée, sinon de la position à l'acceptation.
        v_d0 := null;
        if r.type = 'instant' and r.accepted_at is not null then
          select o.distance_m into v_d0
          from public.ride_assignments ra
          join public.ride_offers o on o.id = ra.offer_id
          where ra.ride_id = r.id and ra.is_active and ra.driver_id = r.driver_id
          limit 1;
          if v_d0 is null and l.updated_at <= r.accepted_at + interval '1 minute' then
            v_d0 := v_dist; -- aucune position reçue depuis l'attribution : c'est celle de l'attribution
          elsif v_d0 is null then
            select round(extensions.st_distance(
                     extensions.st_setsrid(extensions.st_makepoint(h.lng, h.lat), 4326)::extensions.geography,
                     r.pickup_location))::integer
              into v_d0
            from public.driver_location_history h
            where h.driver_id = r.driver_id
              and h.recorded_at between r.accepted_at - interval '10 minutes' and r.accepted_at + interval '1 minute'
            order by h.recorded_at desc
            limit 1;
          end if;
          v_ref := greatest(r.pickup_at, r.accepted_at + make_interval(secs => coalesce(round(v_d0 * 1.35 / 8.3), 0)));
        else
          v_ref := r.pickup_at;
        end if;
        v_delay := floor(extract(epoch from (now() + make_interval(secs => v_eta) - v_ref)))::integer;
        v_cond := v_delay > v_tolerance * 60;
        if v_cond then
          v_severity := case when v_delay > 15 * 60 then 'critical' else 'warning' end;
          v_message := format('%s sera en retard d''environ %s min', v_who, greatest(1, round(v_delay / 60.0))::integer);
          v_data := jsonb_build_object(
            'delay_minutes', greatest(1, round(v_delay / 60.0))::integer,
            'eta_minutes', ceil(v_eta / 60.0)::integer,
            'distance_m', v_dist,
            'expected_at', now() + make_interval(secs => v_eta),
            'reference_at', v_ref,
            'pickup_at', r.pickup_at,
            'tolerance_minutes', v_tolerance);
        end if;
      end if;
    end if;
    v_res := private.apply_ride_alert(r, d, 'late', v_cond, v_severity, v_message, v_data);
    v_opened := v_opened + case when v_res = 'opened' then 1 else 0 end;
    v_updated := v_updated + case when v_res = 'updated' then 1 else 0 end;
    v_resolved := v_resolved + case when v_res = 'resolved' then 1 else 0 end;

    -- ---------------------------------------------------------------- immobile
    v_cond := false;
    v_severity := null;
    v_message := null;
    v_data := null;
    if v_hidden then
      v_cond := null;
    elsif r.status = 'DRIVER_EN_ROUTE' or (r.status = 'ACCEPTED' and r.type = 'instant') then
      if not v_fresh then
        v_cond := null;
      elsif v_dist <= 800 then
        v_cond := false;
      elsif r.pickup_at > now() + make_interval(secs => round(v_dist * 1.35 / 8.3)::integer)
                             + make_interval(mins => v_stall_min + v_tolerance) then
        -- Rien ne presse (prise en charge repoussée par un retard de vol, planifiée en avance) :
        -- s'arrêter n'est pas une anomalie
        v_cond := false;
      else
        -- Censé rouler depuis : départ « en route » (ou acceptation d'une instantanée)
        v_start := coalesce(
          case when r.status = 'DRIVER_EN_ROUTE' then coalesce(r.driver_en_route_at, r.accepted_at) else r.accepted_at end,
          now());
        -- Dernier point à plus de 150 m de la position actuelle, puis premier point « sur place » après lui
        select max(h.recorded_at) into v_last_away
        from public.driver_location_history h
        where h.driver_id = d.id
          and h.recorded_at >= greatest(v_start - interval '2 minutes', now() - interval '2 hours')
          and coalesce(h.accuracy_m, 0) <= 500
          and extensions.st_distance(
                extensions.st_setsrid(extensions.st_makepoint(h.lng, h.lat), 4326)::extensions.geography,
                l.location) > 150;
        select min(h.recorded_at) into v_since
        from public.driver_location_history h
        where h.driver_id = d.id
          and h.recorded_at >= greatest(v_start - interval '2 minutes', now() - interval '2 hours')
          and h.recorded_at > coalesce(v_last_away, '-infinity'::timestamptz)
          and coalesce(h.accuracy_m, 0) <= 500;
        if v_since is null then
          v_cond := false; -- pas d'historique : aucune preuve d'immobilité
        else
          v_since := greatest(v_since, v_start);
          v_still := floor(extract(epoch from (now() - v_since)) / 60)::integer;
          v_cond := v_since <= now() - make_interval(mins => v_stall_min);
          if v_cond then
            v_severity := case when v_still >= 2 * v_stall_min then 'critical' else 'warning' end;
            v_message := format('%s est immobile depuis %s min, à %s du départ', v_who, v_still, v_dist_label);
            v_data := jsonb_build_object(
              'still_minutes', v_still,
              'since', v_since,
              'distance_m', v_dist,
              'lat', l.lat,
              'lng', l.lng,
              'threshold_minutes', v_stall_min);
          end if;
        end if;
      end if;
    end if;
    v_res := private.apply_ride_alert(r, d, 'stalled', v_cond, v_severity, v_message, v_data);
    v_opened := v_opened + case when v_res = 'opened' then 1 else 0 end;
    v_updated := v_updated + case when v_res = 'updated' then 1 else 0 end;
    v_resolved := v_resolved + case when v_res = 'resolved' then 1 else 0 end;

    -- ---------------------------------------------------------------- GPS muet
    v_cond := false;
    v_severity := null;
    v_message := null;
    v_data := null;
    if v_hidden then
      v_cond := null;
    elsif r.status <> 'ACCEPTED' or r.type = 'instant' then
      v_cond := not v_fresh;
      if v_cond then
        v_severity := case when not v_has_loc or v_age >= 600 then 'critical' else 'warning' end;
        v_message := case
          when not v_has_loc then format('Aucune position GPS reçue de %s', v_who)
          else format('Plus de position GPS de %s depuis %s min', v_who, greatest(1, v_age / 60))
        end;
        v_data := jsonb_build_object(
          'last_location_at', case when v_has_loc then l.updated_at end,
          'location_age_s', v_age,
          'max_age_s', v_gps_max,
          'lat', case when v_has_loc then l.lat end,
          'lng', case when v_has_loc then l.lng end);
      end if;
    end if;
    v_res := private.apply_ride_alert(r, d, 'no_gps', v_cond, v_severity, v_message, v_data);
    v_opened := v_opened + case when v_res = 'opened' then 1 else 0 end;
    v_updated := v_updated + case when v_res = 'updated' then 1 else 0 end;
    v_resolved := v_resolved + case when v_res = 'resolved' then 1 else 0 end;

    -- ---------------------------------------------------------------- planifiée non démarrée
    v_cond := false;
    v_severity := null;
    v_message := null;
    v_data := null;
    if r.status = 'ACCEPTED' and r.type = 'scheduled' and r.pickup_at <= now() + interval '30 minutes' then
      v_cond := d.presence = 'offline' or not v_fresh;
      if v_cond then
        v_severity := case when r.pickup_at <= now() + interval '15 minutes' then 'critical' else 'warning' end;
        v_message := format('%s n''a pas démarré — prise en charge à %s, chauffeur %s', v_who,
          to_char(r.pickup_at at time zone coalesce(v_tz, 'Europe/Paris'), 'HH24:MI'),
          case when d.presence = 'offline' then 'hors ligne' else 'sans position GPS' end);
        v_data := jsonb_build_object(
          'pickup_at', r.pickup_at,
          'minutes_to_pickup', ceil(extract(epoch from (r.pickup_at - now())) / 60)::integer,
          'presence', d.presence,
          'last_location_at', case when v_has_loc then l.updated_at end,
          'location_age_s', v_age);
      end if;
    end if;
    v_res := private.apply_ride_alert(r, d, 'not_started', v_cond, v_severity, v_message, v_data);
    v_opened := v_opened + case when v_res = 'opened' then 1 else 0 end;
    v_updated := v_updated + case when v_res = 'updated' then 1 else 0 end;
    v_resolved := v_resolved + case when v_res = 'resolved' then 1 else 0 end;
  end loop;

  -- Réseau partagé : chien de garde des courses confiées à des chauffeurs partenaires (private.network_watch), dans
  -- un bloc protégé (une erreur n'arrête pas la surveillance) ; compteurs renvoyés seulement s'il a agi
  begin
    v_network := private.network_watch();
  exception when others then
    v_network := jsonb_build_object('error', true);
  end;

  return jsonb_build_object('ok', true, 'checked', v_checked, 'opened', v_opened, 'updated', v_updated,
    'resolved', v_resolved, 'skipped', v_skipped)
    || case when v_network ? 'error'
              or coalesce((v_network ->> 'released')::integer, 0) + coalesce((v_network ->> 'alerts')::integer, 0)
                 + coalesce((v_network ->> 'notified')::integer, 0) + coalesce((v_network ->> 'closed_offers')::integer, 0)
                 + coalesce((v_network ->> 'errors')::integer, 0) > 0
            then jsonb_build_object('network', v_network) else '{}'::jsonb end;
end;
$$;

-- =============================================================================
-- 2. Limites de l'offre : compte sous le verrou de l'organisation
-- =============================================================================

-- Dernière définition : 20260924000700_limits_audit.sql. Seul ajout : verrou FOR NO KEY UPDATE de la ligne de
-- l'organisation avant de compter chauffeurs (max_drivers) et accès (max_admins), seulement quand la limite existe.
-- Même verrou et même ordre que drivers_assign_number et les gardes Flotte Privée (20260924007600) : pas
-- d'interblocage nouveau ; la seconde requête attend la première puis compte sa ligne.

create or replace function private.enforce_plan_limits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limits jsonb;
  v_max bigint;
  v_count bigint;
  v_tz text;
begin
  if current_setting('rydar.bypass_ride_rules', true) = 'on' and auth.role() is null then
    return new;
  end if;
  v_limits := coalesce(private.org_limits(new.organization_id), '{}'::jsonb);

  if tg_table_name = 'drivers' then
    if new.status in ('invited', 'active', 'suspended')
       and (tg_op = 'INSERT' or old.status = 'inactive') then
      v_max := nullif(v_limits ->> 'max_drivers', '')::bigint;
      if v_max is not null then
        -- Audit 007900 : compte fait sous le verrou de la ligne de l'organisation (celui de drivers_assign_number et
        -- des gardes Flotte Privée) : deux validations ou réactivations simultanées ne passent plus toutes les deux
        perform 1 from public.organizations o where o.id = new.organization_id for no key update;
        select count(*) into v_count from public.drivers
        where organization_id = new.organization_id and status in ('invited', 'active', 'suspended') and id <> new.id;
        if v_count >= v_max then
          raise exception 'PLAN_LIMIT_DRIVERS: limite de % chauffeurs atteinte pour votre offre', v_max using hint = 'upgrade';
        end if;
      end if;
    end if;

  elsif tg_table_name = 'rides' then
    v_max := nullif(v_limits ->> 'max_rides_per_month', '')::bigint;
    if v_max is not null then
      select timezone into v_tz from public.organizations where id = new.organization_id;
      select count(*) into v_count from public.rides
      where organization_id = new.organization_id
        and created_at >= date_trunc('month', now() at time zone coalesce(v_tz, 'Europe/Paris')) at time zone coalesce(v_tz, 'Europe/Paris');
      if v_count >= v_max then
        raise exception 'PLAN_LIMIT_RIDES: limite de % courses / mois atteinte pour votre offre', v_max using hint = 'upgrade';
      end if;
    end if;

  elsif tg_table_name = 'api_keys' then
    if not coalesce((v_limits ->> 'api_access')::boolean, false) then
      raise exception 'PLAN_FEATURE_API: l''API n''est pas incluse dans votre offre' using hint = 'upgrade';
    end if;

  elsif tg_table_name = 'organization_users' then
    if new.status in ('active', 'invited') and (tg_op = 'INSERT' or old.status = 'disabled') then
      v_max := nullif(v_limits ->> 'max_admins', '')::bigint;
      if v_max is not null then
        -- Audit 007900 : même verrou (deux accès ajoutés en même temps)
        perform 1 from public.organizations o where o.id = new.organization_id for no key update;
        select count(*) into v_count from public.organization_users
        where organization_id = new.organization_id and status in ('active', 'invited') and id <> new.id;
        if v_count >= v_max then
          raise exception 'PLAN_LIMIT_ADMINS: limite de % administrateurs atteinte pour votre offre', v_max using hint = 'upgrade';
        end if;
      end if;
    end if;

  elsif tg_table_name = 'booking_sites' then
    if new.enabled and not coalesce((v_limits ->> 'booking_site')::boolean, false) then
      raise exception 'PLAN_FEATURE_BOOKING_SITE: le site de réservation n''est pas inclus dans votre offre' using hint = 'upgrade';
    end if;
    if new.custom_domain is not null
       and (tg_op = 'INSERT' or new.custom_domain is distinct from old.custom_domain)
       and not coalesce((v_limits ->> 'custom_domain')::boolean, false) then
      raise exception 'PLAN_FEATURE_CUSTOM_DOMAIN: le domaine personnalisé n''est pas inclus dans votre offre' using hint = 'upgrade';
    end if;
    if tg_op = 'UPDATE' and new.custom_domain is distinct from old.custom_domain then
      new.custom_domain_verified_at := null;
    end if;
  end if;

  return new;
end;
$$;

-- =============================================================================
-- 3. Centrale : règlement d'une course modifiable par owner / admin seulement
-- =============================================================================

-- Dernière définition : 20260924004400_audit_argent.sql. Seul ajout : prix, commission ou moyen de paiement changés
-- alors qu'un règlement existe (à régler, ou annulé d'office) → private.assert_org_member(owner, admin) pour un appel
-- client (FORBIDDEN_ROLE) ; avant la fin de la course (aucun règlement), le dispatcher corrige comme avant.

create or replace function private.rides_centrale_split()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_model text;
  v_manual boolean;
  v_settlement text;
  v_auto_waived boolean;
  v_split record;
  v_bypass boolean := current_setting('rydar.bypass_ride_rules', true) = 'on' and auth.role() is null;
begin
  select o.dispatch_model into v_model from public.organizations o where o.id = new.organization_id;

  if v_model is distinct from 'centrale' then
    if tg_op = 'INSERT' then
      new.commission_cents := null;
      new.platform_fee_cents := null;
      new.driver_payout_cents := null;
      new.commission_manual := false;
    elsif new.commission_cents is distinct from old.commission_cents then
      new.commission_cents := old.commission_cents;   -- sans objet en mode flotte
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- Répartition figée dès que le règlement a été déclaré, encaissé, annulé ou contesté
    if new.price_cents is distinct from old.price_cents
       or new.commission_cents is distinct from old.commission_cents
       or new.payment_method is distinct from old.payment_method then
      select x.status, (x.status = 'waived' and x.settled_at is null and x.settled_by is null)
        into v_settlement, v_auto_waived
      from public.ride_settlements x
      where x.ride_id = new.id
      for update;
      if v_settlement is not null and v_settlement <> 'due' and not coalesce(v_auto_waived, false) then
        raise exception 'SETTLEMENT_LOCKED: règlement déjà déclaré, encaissé ou contesté — prix et commission verrouillés'
          using errcode = '55000';
      end if;
      -- Audit 007900 : règlement existant (à régler, ou annulé d'office) recalculé par ce changement : propriétaire et
      -- administrateurs de la centrale seulement, comme « Annuler » et « Rouvrir » (un dispatcher ne ramène plus une
      -- commission à 0 et ne renverse plus le sens du règlement). Service role, worker et import : inchangés.
      if v_settlement is not null and auth.role() = 'authenticated' then
        perform private.assert_org_member(new.organization_id, array['owner', 'admin']::public.org_role[]);
      end if;
    end if;
    v_manual := case when new.commission_cents is distinct from old.commission_cents
                     then new.commission_cents is not null
                     else old.commission_manual end;
  else
    v_manual := new.commission_cents is not null;
  end if;

  if new.price_cents is null then
    -- Tableau de bord : prix obligatoire (le chauffeur doit voir sa part). API / mini-site :
    -- toléré, la répartition est calculée dès que la centrale fixe le prix.
    if new.source = 'dashboard' and not v_bypass and (tg_op = 'INSERT' or old.price_cents is not null) then
      raise exception 'PRICE_REQUIRED: prix obligatoire en mode centrale (le chauffeur doit voir sa part)'
        using errcode = '22023';
    end if;
    if not v_manual then
      new.commission_cents := null;
    end if;
    new.platform_fee_cents := null;
    new.driver_payout_cents := null;
    new.commission_manual := v_manual;
    return new;
  end if;

  select * into v_split
  from private.compute_ride_split(new.organization_id, new.price_cents, case when v_manual then new.commission_cents end);
  if v_split.error is not null then
    raise exception 'COMMISSION_TOO_HIGH: la commission et les frais dépassent le prix de la course' using errcode = '22023';
  end if;
  new.commission_cents := v_split.commission_cents;
  new.platform_fee_cents := v_split.platform_fee_cents;
  new.driver_payout_cents := v_split.driver_payout_cents;
  new.commission_manual := v_manual;
  return new;
end;
$$;

-- =============================================================================
-- 4. Accusés de réception : une boîte, quelles que soient ses variantes d'adresse
-- =============================================================================

-- Clé de boîte d'une adresse e-mail : minuscules, espaces retirés, sous-adresse « +étiquette » retirée (Gmail, Outlook,
-- iCloud, Fastmail et la plupart des serveurs la livrent dans la même boîte), points de la partie locale retirés et
-- googlemail.com ramené à gmail.com pour Gmail. Sert seulement à COMPTER et à dédoublonner : l'e-mail part toujours
-- vers l'adresse saisie. Même règle côté web (mailboxKey, @rydar/shared) pour les limites Redis.
create or replace function private.mailbox_key(p_email text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_at integer;
  v_local text;
  v_domain text;
begin
  if strpos(v_email, '@') = 0 then
    return v_email;
  end if;
  -- Dernier « @ » : partie locale avant, domaine après
  v_at := length(v_email) - strpos(reverse(v_email), '@') + 1;
  v_local := left(v_email, v_at - 1);
  v_domain := substr(v_email, v_at + 1);
  if strpos(v_local, '+') > 1 then
    v_local := left(v_local, strpos(v_local, '+') - 1);
  end if;
  if v_domain in ('gmail.com', 'googlemail.com') then
    v_local := replace(v_local, '.', '');
    v_domain := 'gmail.com';
  end if;
  return v_local || '@' || v_domain;
end;
$$;

-- Accusés récents parcourus par date (la clé de boîte est calculée à la lecture) : remplacent les index par adresse
-- exacte de 20260924005700 et 20260924007400, devenus inutiles.
drop index if exists public.email_outbox_ack_idx;
create index if not exists email_outbox_ack_recent_idx on public.email_outbox (created_at) where kind = 'contact_ack';
drop index if exists public.email_outbox_booking_receipt_idx;
create index if not exists email_outbox_booking_receipt_recent_idx on public.email_outbox (created_at)
  where kind = 'booking_receipt';

-- Dernière définition : 20260924005700_contact_requests.sql. Seul changement : l'accusé « un par adresse et par 24 h »
-- compte par boîte (private.mailbox_key).

create or replace function public.svc_contact_submit(p_request jsonb, p_emails jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Aucun e-mail (null SQL ou JSON) : la demande est enregistrée seule
  v_emails jsonb := case when p_emails is null or jsonb_typeof(p_emails) = 'null' then '[]'::jsonb else p_emails end;
  v_id uuid;
  v_email text;
  v_item jsonb;
  v_kind text;
  v_to text;
  v_ack boolean := false;
  v_constraint text;
  v_column text;
begin
  -- Contrôles séparés : l'ordre d'évaluation d'une condition SQL n'est pas garanti
  if p_request is null or jsonb_typeof(p_request) <> 'object' then
    raise exception 'CONTACT_INVALID: demande de contact invalide' using errcode = '22023';
  end if;
  if jsonb_typeof(v_emails) <> 'array' then
    raise exception 'CONTACT_INVALID: liste d''e-mails invalide' using errcode = '22023';
  end if;
  if jsonb_array_length(v_emails) > 10 then
    raise exception 'CONTACT_INVALID: trop d''e-mails pour une demande' using errcode = '22023';
  end if;
  begin
    v_id := (p_request ->> 'id')::uuid;
  exception when invalid_text_representation then
    v_id := null;
  end;
  if v_id is null then
    raise exception 'CONTACT_INVALID: identifiant de la demande manquant ou invalide' using errcode = '22023';
  end if;
  v_email := lower(btrim(p_request ->> 'email'));

  -- Une demande à la fois : garde-fou horaire et accusés de réception exacts, même pour des envois simultanés
  perform pg_advisory_xact_lock(hashtextextended('rydar.contact_submit', 0));

  if exists (select 1 from public.contact_requests r where r.id = v_id) then
    return jsonb_build_object('ok', true, 'id', v_id, 'ack_queued', false, 'duplicate', true);
  end if;

  if (select count(*) from public.contact_requests r where r.created_at > now() - interval '1 hour') >= 300 then
    raise exception 'CONTACT_BUSY: trop de demandes de contact cette dernière heure, réessayez plus tard'
      using errcode = 'PT429';
  end if;

  begin
    insert into public.contact_requests (id, topic, plan_code, name, company, email, phone, fleet_size, message, ip_hash)
    values (v_id, p_request ->> 'topic', lower(nullif(btrim(p_request ->> 'plan_code'), '')), btrim(p_request ->> 'name'),
            nullif(btrim(p_request ->> 'company'), ''), v_email, nullif(btrim(p_request ->> 'phone'), ''),
            nullif(btrim(p_request ->> 'fleet_size'), ''), p_request ->> 'message', nullif(btrim(p_request ->> 'ip_hash'), ''));

    for v_item in select e from jsonb_array_elements(v_emails) e loop
      if jsonb_typeof(v_item) <> 'object' then
        raise exception 'CONTACT_INVALID: e-mail invalide' using errcode = '22023';
      end if;
      v_kind := v_item ->> 'kind';
      v_to := btrim(v_item ->> 'to_email');
      if v_kind is null or v_kind not in ('contact_notify', 'contact_ack') then
        raise exception 'CONTACT_INVALID: type d''e-mail non accepté pour une demande de contact' using errcode = '22023';
      end if;
      if v_kind = 'contact_ack' then
        -- Accusé de réception : au demandeur seulement (jamais vers une adresse tierce)
        if lower(v_to) is distinct from v_email then
          raise exception 'CONTACT_INVALID: accusé de réception destiné à une autre adresse que celle du demandeur'
            using errcode = '22023';
        end if;
        -- Un seul par BOÎTE et par 24 h (un formulaire rempli en boucle avec l'adresse d'un tiers ne l'inonde pas) ;
        -- Audit 007900 : variantes d'une même boîte confondues (private.mailbox_key : « +étiquette », points Gmail)
        continue when exists (
          select 1 from public.email_outbox o
          where o.kind = 'contact_ack' and o.created_at > now() - interval '24 hours'
            and private.mailbox_key(o.to_email) = private.mailbox_key(v_to));
        v_ack := true;
      end if;
      insert into public.email_outbox (kind, contact_request_id, to_email, reply_to, subject, body_text)
      values (v_kind, v_id, v_to, nullif(btrim(v_item ->> 'reply_to'), ''), v_item ->> 'subject', v_item ->> 'body_text');
    end loop;
  exception when check_violation or not_null_violation then
    get stacked diagnostics v_constraint = constraint_name, v_column = column_name;
    raise exception 'CONTACT_INVALID: valeur refusée (%)', coalesce(nullif(v_constraint, ''), nullif(v_column, ''), 'contrainte')
      using errcode = '22023';
  end;

  return jsonb_build_object('ok', true, 'id', v_id, 'ack_queued', v_ack);
end;
$$;

-- Dernière définition : 20260924007400_legal_review.sql. Seul changement : « 3 au plus par adresse et par 24 h »
-- compté par boîte (private.mailbox_key).

create or replace function public.svc_booking_receipt(p_ride uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rides;
  o public.organizations;
  s public.booking_sites;
  v_to text;
  v_reply text;
  v_mail jsonb;
begin
  select * into r from public.rides where id = p_ride;
  -- Réservation du mini-site, tout juste enregistrée
  if not found or r.source <> 'booking_site' or r.created_at < now() - interval '1 hour' then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  v_to := lower(btrim(coalesce(r.customer_email, '')));
  if not private.email_address_ok(v_to) then
    return jsonb_build_object('ok', false, 'code', 'NO_EMAIL');
  end if;
  if exists (select 1 from public.email_outbox e where e.kind = 'booking_receipt' and e.ride_id = r.id) then
    return jsonb_build_object('ok', true, 'code', 'ALREADY_QUEUED');
  end if;
  -- Audit 007900 : 3 au plus par BOÎTE (variantes d'une même boîte confondues : private.mailbox_key)
  if (select count(*) from public.email_outbox e
       where e.kind = 'booking_receipt' and e.created_at > now() - interval '24 hours'
         and private.mailbox_key(e.to_email) = private.mailbox_key(v_to)) >= 3 then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED');
  end if;
  select * into o from public.organizations x where x.id = r.organization_id;
  select * into s from public.booking_sites x where x.organization_id = r.organization_id;
  v_reply := lower(btrim(coalesce(s.email, '')));
  v_mail := private.booking_receipt_email(r, o, s);
  insert into public.email_outbox (kind, organization_id, ride_id, to_email, reply_to, subject, body_text)
  values ('booking_receipt', r.organization_id, r.id, v_to,
    case when private.email_address_ok(v_reply) then v_reply end, v_mail ->> 'subject', v_mail ->> 'body')
  on conflict (ride_id) where kind = 'booking_receipt' do nothing;
  return jsonb_build_object('ok', true, 'code', 'QUEUED');
end;
$$;

-- =============================================================================
-- 5. Jetons push : liés à la session Auth qui les a enregistrés
-- =============================================================================
alter table public.push_tokens add column if not exists session_id uuid;
comment on column public.push_tokens.session_id is
  'Session Supabase Auth (claim « session_id ») qui a enregistré le jeton : session révoquée ou expirée → jeton plus servi (private.claim_notifications). NULL : enregistré avant 20260924007900.';

-- Dernière définition : 20260924006650_audit_fixes.sql. Seul ajout : session de l'appel (claim « session_id » du
-- jeton d'accès) enregistrée avec le jeton push, y compris quand le même jeton est réenregistré.

create or replace function public.driver_register_device(
  p_installation_id text,
  p_platform public.device_platform,
  p_push_token text default null,
  p_provider public.push_provider default 'expo',
  p_device_name text default null,
  p_os_version text default null,
  p_app_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d record;
  v_device uuid;
  v_token uuid;
  -- Audit 007900 : session Auth de l'appel (claim « session_id » du jeton d'accès)
  v_session uuid;
begin
  select x.id, x.organization_id into d from public.drivers x where x.id = private.current_driver_or_applicant_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  if p_installation_id is null or char_length(p_installation_id) not between 8 and 128 then
    raise exception 'INVALID_INSTALLATION_ID' using errcode = '22023';
  end if;

  begin
    v_session := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then
    v_session := null;
  end;

  perform pg_advisory_xact_lock(hashtextextended('rydar.driver_device:' || d.id::text, 0));
  if not exists (select 1 from public.driver_devices x where x.driver_id = d.id and x.installation_id = p_installation_id)
     and (select count(*) from public.driver_devices x where x.driver_id = d.id and x.created_at > now() - interval '1 day') >= 20 then
    return jsonb_build_object('ok', false, 'code', 'TOO_MANY_DEVICES',
      'message', 'Trop d''appareils enregistrés aujourd''hui pour ce compte : réessayez demain.');
  end if;

  insert into public.driver_devices (organization_id, driver_id, installation_id, platform, device_name, os_version, app_version, last_seen_at)
  values (d.organization_id, d.id, p_installation_id, p_platform, left(p_device_name, 120), left(p_os_version, 40), left(p_app_version, 40), now())
  on conflict (driver_id, installation_id) do update
    set platform = excluded.platform,
        device_name = excluded.device_name,
        os_version = excluded.os_version,
        app_version = excluded.app_version,
        last_seen_at = now(),
        revoked_at = null
  returning id into v_device;

  -- Au plus 10 appareils actifs par chauffeur (les plus récemment vus)
  update public.driver_devices x
     set revoked_at = now()
   where x.driver_id = d.id and x.revoked_at is null
     and x.id not in (select y.id from public.driver_devices y
                       where y.driver_id = d.id and y.revoked_at is null
                       order by (y.id = v_device) desc, y.last_seen_at desc, y.id
                       limit 10);

  if p_push_token is not null and char_length(p_push_token) between 10 and 512 then
    -- Téléphone partagé : le jeton suit l'appareil. Il ne quitte un autre compte que si ce compte l'a enregistré
    -- depuis la même installation (identifiant stable de l'appareil) ; jamais depuis un autre appareil.
    delete from public.push_tokens t
     where t.token = p_push_token and t.driver_id <> d.id
       and exists (select 1 from public.driver_devices dd
                    where dd.id = t.device_id and dd.installation_id = p_installation_id);
    if not exists (select 1 from public.push_tokens t where t.token = p_push_token and t.driver_id <> d.id) then
      update public.push_tokens set is_active = false
       where device_id = v_device and token <> p_push_token and is_active;
      insert into public.push_tokens (organization_id, driver_id, device_id, token, provider, platform, is_active, session_id)
      values (d.organization_id, d.id, v_device, p_push_token, p_provider, p_platform, true, v_session)
      on conflict (token) do update
        set device_id = excluded.device_id,
            provider = excluded.provider,
            platform = excluded.platform,
            is_active = true,
            last_error = null,
            session_id = excluded.session_id
      returning id into v_token;

      -- Au plus 5 jetons actifs par chauffeur (les plus récents) : une notification ne part pas vers des milliers
      update public.push_tokens x
         set is_active = false
       where x.driver_id = d.id and x.is_active
         and x.id not in (select y.id from public.push_tokens y
                           where y.driver_id = d.id and y.is_active
                           order by (y.id = v_token) desc, y.updated_at desc, y.id
                           limit 5);
    end if;
  end if;

  return jsonb_build_object('ok', true, 'device_id', v_device, 'push', v_token is not null);
end;
$$;

-- Dernière définition : 20260924006650_audit_fixes.sql. Seul ajout : jetons servis seulement si la session qui les a
-- enregistrés existe encore (auth.sessions, not_after non dépassé) ; jeton antérieur (sans session) : règle de
-- transition ci-dessous.

create or replace function private.claim_notifications(p_limit integer default 100)
returns table (
  id uuid,
  organization_id uuid,
  driver_id uuid,
  ride_id uuid,
  type text,
  title text,
  body text,
  data jsonb,
  priority text,
  attempts smallint,
  tokens jsonb
)
language sql
security definer
set search_path = ''
as $$
  -- worker arrêté en plein envoi : on remet en file après 2 min
  update public.notifications n
     set status = 'queued', last_error = 'worker_interrupted'
   where n.status = 'sending'
     and coalesce(n.claimed_at, n.created_at) < now() - interval '2 minutes';

  -- Réveil GPS silencieux périmé (plus d'une minute) : le suivant, s'il faut, est émis par watch_driver_gps
  update public.notifications n
     set status = 'cancelled', last_error = 'wake_expired'
   where n.status = 'queued'
     and n.type = 'location_ping'
     and n.created_at < now() - interval '1 minute';

  with stale as (
    update public.notifications n
       set status = 'cancelled', last_error = 'offer_closed'
      from public.ride_offers o
     where n.status = 'queued'
       and n.offer_id = o.id
       and n.type in ('ride_offer', 'ride_offer_scheduled')
       and o.status <> 'pending'
    returning n.id
  ),
  due as (
    select n.id
    from public.notifications n
    where n.status = 'queued'
      and n.channel = 'push'
      and n.scheduled_for <= now()
      and not exists (select 1 from stale s where s.id = n.id)
    order by n.type = 'ride_offer' desc, n.priority = 'high' desc, n.scheduled_for
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update public.notifications n
       set status = 'sending', attempts = n.attempts + 1, claimed_at = now()
      from due
     where n.id = due.id
    returning n.*
  )
  select c.id, c.organization_id, c.driver_id, c.ride_id, c.type, c.title, c.body, c.data, c.priority, c.attempts,
         coalesce((
           select jsonb_agg(jsonb_build_object('token', t.token, 'provider', t.provider, 'platform', t.platform))
           from public.push_tokens t
           where t.driver_id = c.driver_id and t.is_active
             -- Audit 007900 : session du téléphone toujours ouverte. Révoquée (mot de passe changé, « Se déconnecter »
             -- sur un autre téléphone, session supprimée ou expirée) : plus rien vers ce téléphone.
             and (exists (select 1 from auth.sessions s
                           where s.id = t.session_id and (s.not_after is null or s.not_after > now()))
                  -- Jeton enregistré avant 20260924007900 (sans session) : servi tant qu'une session ouverte avant son
                  -- dernier enregistrement existe encore (toutes révoquées d'un coup par un changement de mot de passe
                  -- ou une déconnexion globale) ; l'application le réenregistre avec sa session à son prochain lancement
                  or (t.session_id is null and exists (
                        select 1 from public.drivers x join auth.sessions s on s.user_id = x.user_id
                         where x.id = t.driver_id and s.created_at <= t.updated_at + interval '1 minute'
                           and (s.not_after is null or s.not_after > now()))))
         ), '[]'::jsonb) as tokens
  from claimed c;
$$;

-- =============================================================================
-- 6. Position du chauffeur : saut impossible ignoré
-- =============================================================================

-- Dernière définition : 20260924007400_legal_review.sql (corps gardé). Seul ajout : contrôle de vraisemblance avant
-- l'enregistrement → {ok: false, code: LOCATION_IMPLAUSIBLE, presence, next_interval_s} (l'application lit presence
-- et next_interval_s comme d'habitude, aucune exception).

create or replace function public.update_driver_location(
  p_lat double precision,
  p_lng double precision,
  p_heading real default null,
  p_speed real default null,
  p_accuracy real default null,
  p_battery real default null,
  p_recorded_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d record;
  v_recorded timestamptz := least(coalesce(p_recorded_at, now()), now());
  v_has_recent_history boolean;
  -- Réseau partagé
  v_ride_org uuid;
  -- Audit 007900
  v_prev record;
  v_jump double precision;
  v_interval integer;
begin
  select x.id, x.organization_id, x.presence, x.current_ride_id, x.last_seen_at into d
  from public.drivers x where x.id = private.current_driver_id();
  if not found then
    raise exception 'FORBIDDEN: compte chauffeur inactif ou inconnu' using errcode = '42501';
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'INVALID_COORDINATES' using errcode = '22023';
  end if;
  -- Fréquence GPS adaptative suggérée à l'application (économie batterie)
  v_interval := case
    when d.current_ride_id is not null or d.presence = 'offered' then 5
    when d.presence = 'offline' then 120
    else 15
  end;

  -- Audit 007900 : saut impossible depuis la dernière position retenue (plus de 1 km au-delà de 250 km/h, précision
  -- annoncée des deux points déduite, bornée à 1,5 km chacune) → point ignoré, position précédente gardée ; l'app
  -- reste en ligne (signe de vie). Dernière position de plus de 10 min (téléphone éteint, avion) : toute position
  -- acceptée. La vitesse calculée n'est pas conservée (minimisation, 20260924007400).
  select x.location, x.accuracy_m, x.recorded_at, x.updated_at into v_prev
    from public.driver_locations x where x.driver_id = d.id;
  if found and v_recorded > v_prev.recorded_at and v_prev.updated_at > now() - interval '10 minutes' then
    v_jump := extensions.st_distance(v_prev.location,
                extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography)
              - greatest(0, least(coalesce(v_prev.accuracy_m, 0), 1500))
              - greatest(0, least(coalesce(p_accuracy, 0), 1500));
    if v_jump > 1000 and v_jump / greatest(extract(epoch from v_recorded - v_prev.recorded_at), 1) > 250 / 3.6 then
      if d.last_seen_at is null or d.last_seen_at < now() - interval '60 seconds' then
        update public.drivers set last_seen_at = now() where id = d.id;
      end if;
      return jsonb_build_object('ok', false, 'code', 'LOCATION_IMPLAUSIBLE',
        'message', 'Position ignorée : déplacement impossible depuis la précédente.',
        'presence', d.presence, 'next_interval_s', v_interval);
    end if;
  end if;

  insert into public.driver_locations as dl
    (driver_id, organization_id, lat, lng, heading, speed_mps, accuracy_m, battery_level, recorded_at, updated_at)
  values (d.id, d.organization_id, p_lat, p_lng, p_heading, p_speed, p_accuracy, p_battery, v_recorded, now())
  on conflict (driver_id) do update
    set lat = excluded.lat,
        lng = excluded.lng,
        heading = excluded.heading,
        speed_mps = excluded.speed_mps,
        accuracy_m = excluded.accuracy_m,
        battery_level = coalesce(excluded.battery_level, dl.battery_level),
        recorded_at = excluded.recorded_at,
        updated_at = now()
    where dl.recorded_at <= excluded.recorded_at;

  -- Historique : chaque point en course, sinon 1 point / minute
  select exists (
    select 1 from public.driver_location_history h
    where h.driver_id = d.id and h.recorded_at > now() - interval '1 minute'
  ) into v_has_recent_history;
  if d.current_ride_id is not null or not v_has_recent_history then
    -- Réseau partagé (§11.6, Q5, S8) : point d'une course d'une AUTRE organisation marqué (ride_org_id) — invisible
    -- pour l'organisation du chauffeur (policy driver_location_history_select), supprimé 1 h après la fin
    -- (private.housekeeping) ; course propre ou aucune course : NULL, comme avant
    if d.current_ride_id is not null then
      select r.organization_id into v_ride_org from public.rides r
       where r.id = d.current_ride_id and r.organization_id <> d.organization_id;
    end if;
    insert into public.driver_location_history (organization_id, driver_id, ride_id, lat, lng, speed_mps, heading, accuracy_m, recorded_at,
                                                ride_org_id)
    values (d.organization_id, d.id, d.current_ride_id, p_lat, p_lng, null, p_heading, p_accuracy, v_recorded, v_ride_org);
  end if;

  if d.last_seen_at is null or d.last_seen_at < now() - interval '60 seconds' then
    update public.drivers set last_seen_at = now() where id = d.id;
  end if;

  return jsonb_build_object('ok', true, 'presence', d.presence, 'next_interval_s', v_interval);
end;
$$;

-- =============================================================================
-- 7. Suppression de compte : compte de connexion conservé, recalculé à la reprise
-- =============================================================================

-- Dernière définition : 20260924004000_account_deletion_fixes.sql. Seul ajout : keep_auth recalculé
-- (private.keeps_login_account) ; devenu vrai → auth_done_at posé (le worker ne supprime pas le compte Auth).

create or replace function private.claim_account_deletions(p_limit integer default 10)
returns setof private.account_deletions
language plpgsql
set search_path = ''
as $$
begin
  return query
  update private.account_deletions x
     set next_attempt_at = now() + interval '15 minutes',
         -- Audit 007900 : compte devenu gérant (adhésion active) ou super admin depuis la demande → conservé
         keep_auth = x.keep_auth or private.keeps_login_account(x.user_id),
         auth_done_at = case when x.auth_done_at is null and private.keeps_login_account(x.user_id) then now()
                             else x.auth_done_at end
   where x.id in (
     select y.id from private.account_deletions y
      where y.done_at is null and y.attempts < 10 and y.next_attempt_at <= now()
      order by y.next_attempt_at
      limit greatest(1, least(coalesce(p_limit, 10), 100))
      for update skip locked)
  returning x.*;
end;
$$;

-- Dernière définition : 20260924004000_account_deletion_fixes.sql. Seul ajout : même recalcul à « Réessayer ».

create or replace function public.svc_account_deletion_retry(p_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  q private.account_deletions;
begin
  perform private.assert_platform_actor(p_actor);
  update private.account_deletions x
     set attempts = 0, next_attempt_at = now() + interval '2 minutes',
         -- Audit 007900 : compte devenu gérant (adhésion active) ou super admin depuis la demande → conservé
         keep_auth = x.keep_auth or private.keeps_login_account(x.user_id),
         auth_done_at = case when x.auth_done_at is null and private.keeps_login_account(x.user_id) then now()
                             else x.auth_done_at end
   where x.id = p_id and x.done_at is null
  returning * into q;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_PENDING', 'message', 'Cette suppression est déjà terminée ou introuvable.');
  end if;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
  values (q.organization_id, 'super_admin', p_actor, 'driver.deletion_retry', 'drivers', q.driver_id::text, 'info',
    jsonb_build_object('number', q.driver_number, 'deletion_id', q.id, 'last_error', q.last_error));
  return jsonb_build_object('ok', true) || private.account_deletion_json(q);
end;
$$;

-- Dernière définition : 20260924004800_audit_rgpd.sql. Seul ajout : keep_auth recalculé au compte rendu (compte
-- devenu gérant entre la reprise et la fin) : son journal Auth n'est jamais effacé.

create or replace function private.complete_account_deletion(p_id uuid, p_storage_done boolean, p_auth_done boolean, p_error text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  q private.account_deletions;
  v_error text := left(nullif(btrim(coalesce(p_error, '')), ''), 500);
  v_auth_error text;
begin
  update private.account_deletions x
     set storage_done_at = case when coalesce(p_storage_done, false) then coalesce(x.storage_done_at, now()) else x.storage_done_at end,
         auth_done_at = case when coalesce(p_auth_done, false) then coalesce(x.auth_done_at, now()) else x.auth_done_at end,
         attempts = x.attempts + 1,
         last_attempt_at = now(),
         last_error = v_error,
         -- Audit 007900 : compte devenu gérant ou super admin entre la reprise et ce compte rendu → conservé
         keep_auth = x.keep_auth or private.keeps_login_account(x.user_id)
   where x.id = p_id and x.done_at is null
  returning * into q;
  if not found then
    select * into q from private.account_deletions where id = p_id;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
    end if;
    return jsonb_build_object('ok', true) || private.account_deletion_json(q);
  end if;

  -- Compte de connexion supprimé par l'appelant : son historique de connexions part avec lui
  if coalesce(p_auth_done, false) and q.user_id is not null and not q.keep_auth then
    begin
      if to_regclass('auth.audit_log_entries') is not null then
        delete from auth.audit_log_entries a
         where a.payload ->> 'actor_id' = q.user_id::text
            or a.payload -> 'traits' ->> 'user_id' = q.user_id::text;
      end if;
    exception when others then
      v_auth_error := left(sqlerrm, 300);
      raise warning 'complete_account_deletion: journal Auth non effacé (%)', v_auth_error;
    end;
  end if;

  if q.storage_done_at is not null and q.auth_done_at is not null then
    update private.account_deletions set done_at = now(), last_error = null where id = q.id returning * into q;
  else
    update private.account_deletions
       set next_attempt_at = now() + least(interval '6 hours', interval '5 minutes' * power(2, least(q.attempts - 1, 10)))
     where id = q.id
    returning * into q;
    if q.attempts = 10 then
      insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, metadata)
      values (q.organization_id, 'system', null, 'driver.deletion_failed', 'drivers', q.driver_id::text, 'critical',
        jsonb_build_object('number', q.driver_number, 'attempts', q.attempts, 'error', q.last_error,
          'storage_done', q.storage_done_at is not null, 'auth_done', q.auth_done_at is not null, 'deletion_id', q.id));
    end if;
  end if;
  return jsonb_build_object('ok', true) || private.account_deletion_json(q)
    || case when v_auth_error is null then '{}'::jsonb else jsonb_build_object('auth_log_error', v_auth_error) end;
end;
$$;

-- =============================================================================
-- Droits d'exécution (deny-by-default) : fonctions redéfinies à l'identique de signature, droits conservés ; nouvelle
-- fonction interne, appelée seulement par les fonctions ci-dessus
-- =============================================================================
revoke execute on function private.mailbox_key(text) from public, anon, authenticated, service_role;
