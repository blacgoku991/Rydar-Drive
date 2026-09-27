-- =============================================================================
-- Rappels d'échéance d'une visite médicale : ce type ne se dépose plus dans l'application (driver_submit_document le
-- refuse depuis 20260924004300). Le rappel au chauffeur ne dit donc plus « Déposez le nouveau document depuis
-- l'application » mais « Transmettez le nouveau document à votre centrale ». Rien d'autre ne change.
-- =============================================================================

-- Dernière définition : 20260924005100_audit_robustesse.sql
create or replace function private.document_reminders()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_expired integer := 0;
  v_sent integer := 0;
  v_silent integer := 0;
  v_threshold integer;
  v_marks integer[];
  v_label text;
  v_type text;
  v_title text;
  v_body text;
  v_at timestamptz;
  v_json jsonb;
  v_action text;
  v_renewal boolean;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('rydar.document_reminders', 0)) then
    return jsonb_build_object('skipped', 'already_running');
  end if;
  perform private.set_actor('system', null);

  -- 1) Échéance dépassée (jour J+1 dans le fuseau de l'organisation) → « expired ».
  --    SKIP LOCKED : jamais d'attente (ni d'interblocage avec housekeeping) ; une ligne
  --    sautée est rattrapée au passage suivant, et les rappels ci-dessous la traitent déjà.
  update public.driver_documents x
     set status = 'expired'
   where x.status = 'valid'
     and x.id in (
       select y.id
       from public.driver_documents y
       join public.organizations o on o.id = y.organization_id
       where y.status = 'valid'
         and y.expires_at < (now() at time zone o.timezone)::date
       for update of y skip locked
     );
  get diagnostics v_expired = row_count;

  -- 2) Rappels : le seuil le plus urgent atteint et non encore envoyé
  for r in
    select x as doc,
           x.expires_at - (now() at time zone o.timezone)::date as days_left,
           (now() at time zone o.timezone) as local_now,
           o.timezone as tz,
           dr.first_name, dr.last_name, dr.number as driver_number
    from public.driver_documents x
    join public.organizations o on o.id = x.organization_id
    join public.drivers dr on dr.id = x.driver_id
    where x.status in ('valid', 'expired')
      and x.expires_at is not null
      and o.status = 'active'
      and dr.status = 'active'
      and (
           (x.expires_at - (now() at time zone o.timezone)::date <= 30 and not (30 = any (x.reminders_sent)))
        or (x.expires_at - (now() at time zone o.timezone)::date <= 7 and not (7 = any (x.reminders_sent)))
        or (x.expires_at - (now() at time zone o.timezone)::date <= 0 and not (0 = any (x.reminders_sent)))
      )
    order by x.expires_at, x.id
    for update of x skip locked
  loop
    v_threshold := case when r.days_left <= 0 then 0 when r.days_left <= 7 then 7 else 30 end;
    v_marks := array(select t from unnest(array[30, 7, 0]) as t where t >= v_threshold);

    -- Échu depuis longtemps (import, reprise) ou seuil urgent déjà traité : marqué sans notifier
    if r.days_left < -7 or v_threshold = any ((r.doc).reminders_sent) then
      update public.driver_documents
         set reminders_sent = array(select distinct t from unnest(reminders_sent || v_marks) as t order by t desc)
       where id = (r.doc).id;
      v_silent := v_silent + 1;
      continue;
    end if;

    -- Renouvelé (un document valide plus récent du même type existe) : rien à rappeler
    continue when private.document_superseded(r.doc);

    -- Renouvellement déjà déposé par le chauffeur, en attente de validation par la centrale
    v_renewal := (r.doc).type <> 'other' and exists (
      select 1 from public.driver_documents y
      where y.driver_id = (r.doc).driver_id
        and y.type = (r.doc).type
        and y.status = 'pending'
        and y.id <> (r.doc).id
    );

    v_label := private.document_label((r.doc).type, (r.doc).label);
    if r.days_left < 0 then
      v_type := 'document_expired';
      v_action := 'expired';
      v_title := format('Document expiré : %s', v_label);
      v_body := case when v_renewal
        then format('Échéance dépassée depuis le %s. Votre nouveau document est en cours de validation par la centrale.',
          to_char((r.doc).expires_at, 'DD/MM/YYYY'))
        when (r.doc).type = 'medical'
        then format('Échéance dépassée depuis le %s. Transmettez le nouveau document à votre centrale au plus vite.',
          to_char((r.doc).expires_at, 'DD/MM/YYYY'))
        else format('Échéance dépassée depuis le %s. Déposez le nouveau document au plus vite.',
          to_char((r.doc).expires_at, 'DD/MM/YYYY'))
      end;
    else
      v_type := 'document_expiring';
      v_action := 'expiring';
      v_title := case
        when r.days_left = 0 then format('%s expire aujourd''hui', v_label)
        when r.days_left = 1 then format('%s expire demain', v_label)
        else format('%s expire dans %s jours', v_label, r.days_left)
      end;
      v_body := case when v_renewal
        then format('Échéance le %s. Votre nouveau document est en cours de validation par la centrale.',
          to_char((r.doc).expires_at, 'DD/MM/YYYY'))
        when (r.doc).type = 'medical'
        then format('Échéance le %s. Transmettez le nouveau document à votre centrale.',
          to_char((r.doc).expires_at, 'DD/MM/YYYY'))
        else format('Échéance le %s. Déposez le nouveau document depuis l''application.',
          to_char((r.doc).expires_at, 'DD/MM/YYYY'))
      end;
    end if;

    -- Pas de push nocturne : avant 9 h (heure locale) → envoi programmé à 9 h
    v_at := case when r.local_now::time < time '09:00'
                 then (r.local_now::date + time '09:00') at time zone r.tz
                 else now() end;

    perform private.queue_notification((r.doc).organization_id, (r.doc).driver_id, null, null, v_type, v_title, v_body,
      jsonb_build_object('type', v_type, 'document_id', (r.doc).id, 'document_type', (r.doc).type,
        'expires_at', (r.doc).expires_at, 'days_left', r.days_left, 'threshold', v_threshold,
        'renewal_pending', v_renewal),
      case when v_threshold = 30 or v_renewal then 'normal' else 'high' end, v_at);

    update public.driver_documents
       set reminders_sent = array(select distinct t from unnest(reminders_sent || v_marks) as t order by t desc)
     where id = (r.doc).id;
    v_sent := v_sent + 1;

    -- Centrale : journal à J-7 et à l'échéance, temps réel à chaque rappel
    if v_threshold <= 7 then
      perform private.log_event((r.doc).organization_id, null, 'document.' || v_action,
        case
          when r.days_left < 0 then format('%s de %s %s (#%s) : échéance dépassée depuis le %s', v_label, r.first_name,
            r.last_name, r.driver_number, to_char((r.doc).expires_at, 'DD/MM/YYYY'))
          when r.days_left = 0 then format('%s de %s %s (#%s) : expire aujourd''hui', v_label, r.first_name, r.last_name,
            r.driver_number)
          else format('%s de %s %s (#%s) : expire dans %s %s', v_label, r.first_name, r.last_name, r.driver_number,
            r.days_left, private.pl(r.days_left, 'jour', 'jours'))
        end || case when v_renewal then ' — nouveau document à valider' else '' end,
        'timeline', 'warning',
        jsonb_build_object('driver_id', (r.doc).driver_id, 'document_id', (r.doc).id, 'document_type', (r.doc).type,
          'expires_at', (r.doc).expires_at, 'days_left', r.days_left, 'renewal_pending', v_renewal),
        'system', null);
    end if;

    v_json := private.document_json(r.doc, (r.local_now)::date);
    perform realtime.send(
      jsonb_build_object('action', v_action, 'threshold', v_threshold, 'document', v_json,
        'driver', jsonb_build_object('id', (r.doc).driver_id, 'number', r.driver_number,
          'first_name', r.first_name, 'last_name', r.last_name)),
      'driver.document', 'org:' || (r.doc).organization_id::text, true);
    perform realtime.send(
      jsonb_build_object('action', v_action, 'threshold', v_threshold, 'document', v_json),
      'driver.document', 'driver:' || (r.doc).driver_id::text, true);
  end loop;

  return jsonb_build_object('expired', v_expired, 'reminders', v_sent, 'silent', v_silent);
end;
$$;

revoke execute on function private.document_reminders() from public, anon, authenticated;
grant execute on function private.document_reminders() to service_role;
