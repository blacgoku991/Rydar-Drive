-- =============================================================================
-- Rydar Drive — Service d'envoi des e-mails (« mailer ») : état visible du super admin, file en pause tant que le
-- serveur mail est injoignable, e-mails en attente relancés dès qu'il répond.
--
--  * public.mailer_status : une seule ligne, écrite par le mailer (signe de vie chaque minute, serveur SMTP utilisé,
--    joignable ou non, dernière erreur). Lecture : super admin (RLS). /admin/contacts en déduit « service d'envoi
--    arrêté » (plus de signe de vie depuis 3 min : conteneur arrêté ou base injoignable) et « serveur mail
--    injoignable » (motif ; Postfix absent : deploy/CLAUDE-VPS.md, étape 5).
--  * private.release_emails : e-mails réservés mais jamais tentés (serveur mail tombé pendant le lot) rendus à la file,
--    sans compter de tentative.
--  * private.requeue_waiting_emails : e-mails en attente d'un nouvel essai remis à maintenant, quand le serveur mail
--    redevient joignable ou au démarrage du mailer : ils partent dans la minute au lieu d'attendre leur délai (jusqu'à
--    12 h). Le mailer ne prend plus rien tant que le serveur mail est injoignable (apps/worker/src/mailer.ts) : une
--    panne, même longue, ne fait plus passer les e-mails en échec.
-- =============================================================================

-- ----------------------------------------------------------------- état du mailer
create table public.mailer_status (
  id boolean primary key default true check (id),
  started_at timestamptz not null,
  seen_at timestamptz not null default now(),
  smtp_host text not null check (char_length(smtp_host) between 1 and 255),
  smtp_port integer not null check (smtp_port between 1 and 65535),
  smtp_tls text not null check (char_length(smtp_tls) between 1 and 40),
  smtp_auth boolean not null default false,
  mail_from text check (mail_from is null or char_length(mail_from) <= 254),
  smtp_ready boolean,
  smtp_checked_at timestamptz,
  smtp_error text check (smtp_error is null or char_length(smtp_error) <= 500),
  smtp_error_at timestamptz
);
comment on table public.mailer_status is
  'État du service d''envoi des e-mails (une ligne, écrite par le mailer chaque minute) — lecture : super admin.';
comment on column public.mailer_status.seen_at is 'Dernier signe de vie : au-delà de 3 min, service arrêté ou base injoignable.';
comment on column public.mailer_status.smtp_tls is 'loopback-plain (serveur du VPS), starttls, starttls-required ou implicit (email/smtp.ts).';
comment on column public.mailer_status.smtp_ready is
  'Serveur SMTP joignable (true), injoignable (false : les e-mails attendent en file), pas encore vérifié (null).';
comment on column public.mailer_status.smtp_error is 'Dernier échec (vérification ou envoi), adresses masquées.';

alter table public.mailer_status enable row level security;
create policy mailer_status_select on public.mailer_status for select to authenticated
  using ((select private.is_super_admin()));
revoke all on public.mailer_status from anon, authenticated, service_role;
grant select on public.mailer_status to authenticated;

-- Écrite par le mailer (connexion directe, rôle propriétaire) : au démarrage, à chaque changement d'état du serveur
-- SMTP, puis chaque minute. p_status : {started_at, smtp_host, smtp_port, smtp_tls, smtp_auth, mail_from, smtp_ready,
-- smtp_checked_at, smtp_error, smtp_error_at} (valeurs absentes → null ; textes tronqués aux bornes des colonnes).
create or replace function private.report_mailer_status(p_status jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  s jsonb := coalesce(p_status, '{}'::jsonb);
begin
  insert into public.mailer_status as m (
    id, started_at, seen_at, smtp_host, smtp_port, smtp_tls, smtp_auth, mail_from,
    smtp_ready, smtp_checked_at, smtp_error, smtp_error_at
  )
  values (
    true,
    coalesce((s->>'started_at')::timestamptz, now()),
    now(),
    left(coalesce(nullif(btrim(s->>'smtp_host'), ''), '?'), 255),
    coalesce((s->>'smtp_port')::integer, 25),
    left(coalesce(nullif(btrim(s->>'smtp_tls'), ''), '?'), 40),
    coalesce((s->>'smtp_auth')::boolean, false),
    left(nullif(btrim(s->>'mail_from'), ''), 254),
    (s->>'smtp_ready')::boolean,
    (s->>'smtp_checked_at')::timestamptz,
    left(nullif(btrim(s->>'smtp_error'), ''), 500),
    (s->>'smtp_error_at')::timestamptz
  )
  on conflict (id) do update set
    started_at = excluded.started_at,
    seen_at = excluded.seen_at,
    smtp_host = excluded.smtp_host,
    smtp_port = excluded.smtp_port,
    smtp_tls = excluded.smtp_tls,
    smtp_auth = excluded.smtp_auth,
    mail_from = excluded.mail_from,
    smtp_ready = excluded.smtp_ready,
    smtp_checked_at = excluded.smtp_checked_at,
    smtp_error = excluded.smtp_error,
    smtp_error_at = excluded.smtp_error_at;
end;
$$;

-- ----------------------------------------------------------------- file : libération, relance
-- E-mails réservés par private.claim_emails puis rendus sans avoir été tentés (serveur mail tombé pendant le lot) :
-- de nouveau en attente, dus aussitôt, tentative décomptée. Seulement un envoi encore « en cours ».
create or replace function private.release_emails(p_ids bigint[])
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.email_outbox o
     set status = 'pending', locked_until = null, attempts = greatest(o.attempts - 1, 0)
   where o.id = any(coalesce(p_ids, '{}'::bigint[])) and o.status = 'sending';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- E-mails en attente d'un nouvel essai (délai de 1 min à 12 h après un échec) : dus maintenant. Appelée par le mailer
-- quand le serveur mail redevient joignable, et à son démarrage ; les envois en cours, envoyés ou en échec ne
-- changent pas.
create or replace function private.requeue_waiting_emails()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.email_outbox
     set next_attempt_at = now()
   where status = 'pending' and next_attempt_at > now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ----------------------------------------------------------------- droits d'exécution (deny-by-default, cf. 20260924000900)
-- Mailer : connexion directe avec le rôle propriétaire ; jamais appelées par un client ni par le service role
revoke execute on function
  private.report_mailer_status(jsonb),
  private.release_emails(bigint[]),
  private.requeue_waiting_emails()
from public, anon, authenticated, service_role;
