-- =============================================================================
-- Worker : réservation des notifications (en ignorant les offres déjà fermées)
-- et finalisation avec politique de ré-essai.
-- =============================================================================

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
    order by n.priority = 'high' desc, n.scheduled_for
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update public.notifications n
       set status = 'sending', attempts = n.attempts + 1
      from due
     where n.id = due.id
    returning n.*
  )
  select c.id, c.organization_id, c.driver_id, c.ride_id, c.type, c.title, c.body, c.data, c.priority, c.attempts,
         coalesce((
           select jsonb_agg(jsonb_build_object('token', t.token, 'provider', t.provider, 'platform', t.platform))
           from public.push_tokens t
           where t.driver_id = c.driver_id and t.is_active
         ), '[]'::jsonb) as tokens
  from claimed c;
$$;

-- Finalise un envoi : succès, ré-essai (backoff exponentiel) ou échec définitif.
create or replace function private.complete_notification(
  p_id uuid,
  p_ok boolean,
  p_error text default null,
  p_provider text default null,
  p_message_id text default null,
  p_retryable boolean default true
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  n public.notifications;
  v_max smallint;
begin
  select * into n from public.notifications where id = p_id for update;
  if not found then
    return;
  end if;
  if p_ok then
    update public.notifications
       set status = 'sent', sent_at = now(), provider = p_provider, provider_message_id = p_message_id, last_error = null
     where id = p_id;
    return;
  end if;
  -- Les offres sont urgentes : 2 tentatives maximum ; le reste : 5.
  v_max := case when n.type in ('ride_offer') then 2 else 5 end;
  if p_retryable and n.attempts < v_max then
    update public.notifications
       set status = 'queued', last_error = left(p_error, 500), provider = p_provider,
           scheduled_for = now() + make_interval(secs => least(300, 5 * power(2, n.attempts)::int))
     where id = p_id;
  else
    update public.notifications
       set status = 'failed', last_error = left(p_error, 500), provider = p_provider
     where id = p_id;
  end if;
end;
$$;

create or replace function private.deactivate_push_tokens(p_tokens text[], p_reason text)
returns integer
language sql
security definer
set search_path = ''
as $$
  with u as (
    update public.push_tokens set is_active = false, last_error = left(p_reason, 200)
    where token = any (p_tokens) and is_active
    returning 1
  )
  select count(*)::integer from u;
$$;

revoke execute on function private.claim_notifications(integer), private.complete_notification(uuid, boolean, text, text, text, boolean),
  private.deactivate_push_tokens(text[], text) from public, anon, authenticated;
grant execute on function private.claim_notifications(integer), private.complete_notification(uuid, boolean, text, text, text, boolean),
  private.deactivate_push_tokens(text[], text) to service_role;
