-- =============================================================================
-- Rydar Drive — Formulaire de contact du site vitrine (/contact) et file d'envoi des e-mails.
--
--  * public.contact_requests : demandes envoyées depuis /contact (prospects, centrales, partenaires : aucun compte).
--    Lecture : super admin seulement (RLS, /admin/contacts). Enregistrement : public.svc_contact_submit (web, service
--    role). Traitement (statut, note, réponse) : actions serveur du super admin (service role + journal d'audit).
--  * public.email_outbox : file des e-mails de la plateforme (notification de l'admin, accusé de réception, réponses,
--    e-mail de test). Le web n'envoie rien lui-même : il écrit dans la file. Le service « mailer » (image du worker,
--    réseau de l'hôte) la lit avec private.claim_emails / private.complete_email et envoie en SMTP au serveur mail du
--    VPS (127.0.0.1:25). Réveil immédiat par pg_notify('rydar_emails') ; réessais espacés (1 min → 12 h) ; échec
--    définitif au 8e essai, visible dans /admin/contacts.
--  * Anti-abus : accusé de réception au contenu fixe (aucune donnée saisie), envoyé seulement à l'adresse du
--    demandeur et une fois par adresse et par 24 h ; au plus 300 demandes par heure sur toute la plateforme
--    (CONTACT_BUSY) ; limitation par adresse IP côté web (rateLimitAll).
--  * Conservation (private.purge_contact_data, ménage du worker toutes les 5 min) : demandes 3 ans, indésirables
--    30 jours, e-mails sans demande (tests) 1 an ; empreinte de l'adresse IP effacée au bout d'un an.
--
-- Contrôles de texte communs :
--  * champ d'une ligne : ni caractère de contrôle (C0, DEL, C1) ni séparateur de ligne Unicode (U+2028, U+2029) —
--    même règle que contactRequestSchema (@rydar/shared) ;
--  * adresse e-mail : une seule @, un point après, ni espace, ni caractère de contrôle, ni séparateur ou syntaxe
--    d'en-tête (, ; : < > ( ) " \) : une adresse ne peut pas en cacher une seconde (« a@b.fr, c@d.fr »,
--    « Nom <a@b.fr> », retour à la ligne suivi d'un en-tête).
-- =============================================================================

-- ----------------------------------------------------------------- demandes de contact
create table public.contact_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  topic text not null check (topic in ('pricing', 'question', 'partnership', 'other')),
  plan_code text check (plan_code is null or (char_length(plan_code) <= 40 and plan_code ~ '^[a-z0-9_-]+$')),
  name text not null check (char_length(name) between 2 and 120 and name !~ '[\x01-\x1f\x7f-\x9f\x2028\x2029]'),
  company text check (company is null or (char_length(company) <= 160 and company !~ '[\x01-\x1f\x7f-\x9f\x2028\x2029]')),
  email text not null check (
    char_length(email) <= 254 and email = lower(email)
    and email ~ '^[^@]+@[^@]+\.[^@]+$' and email !~ '[\x01-\x20\x7f-\xa0\x2028\x2029,;:<>()"\\]'),
  phone text check (phone is null or (char_length(phone) <= 40 and phone !~ '[\x01-\x1f\x7f-\x9f\x2028\x2029]')),
  fleet_size text check (fleet_size is null or fleet_size in ('1-5', '6-20', '21-50', '51+')),
  message text not null check (char_length(message) between 10 and 5000),
  status text not null default 'new' check (status in ('new', 'in_progress', 'done', 'spam')),
  admin_note text check (admin_note is null or char_length(admin_note) <= 5000),
  handled_by uuid references public.users (id) on delete set null,
  handled_at timestamptz,
  ip_hash text check (ip_hash is null or char_length(ip_hash) <= 128)
);
comment on table public.contact_requests is
  'Demandes du formulaire de contact du site vitrine (/contact) — lecture : super admin ; enregistrement : svc_contact_submit.';
comment on column public.contact_requests.plan_code is 'Offre choisie sur /tarifs (/contact?sujet=tarif&offre=<code>), à titre indicatif.';
comment on column public.contact_requests.email is 'Adresse du demandeur, en minuscules.';
comment on column public.contact_requests.status is 'new (nouvelle) → in_progress (en cours) → done (traitée) | spam (indésirable, effacée 30 jours après).';
comment on column public.contact_requests.admin_note is 'Note interne du super admin (jamais envoyée au demandeur).';
comment on column public.contact_requests.ip_hash is
  'Empreinte (HMAC) de l''adresse IP calculée par le web, jamais l''adresse elle-même ; effacée au bout d''un an.';

-- Liste de /admin/contacts (filtre par statut, plus récentes d'abord)
create index contact_requests_status_idx on public.contact_requests (status, created_at desc);
-- Garde-fou horaire de svc_contact_submit et durées de conservation
create index contact_requests_created_idx on public.contact_requests (created_at);

-- Date de mise à jour : tout changement, sauf l'effacement de l'empreinte IP par le ménage (le délai de 30 jours
-- d'une demande indésirable court depuis son dernier vrai changement)
create trigger contact_requests_touch_updated_at
  before update on public.contact_requests
  for each row when (new.ip_hash is not distinct from old.ip_hash)
  execute function private.touch_updated_at();

-- ----------------------------------------------------------------- file d'envoi des e-mails
create table public.email_outbox (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('contact_notify', 'contact_ack', 'contact_reply', 'test')),
  -- Demande supprimée (3 ans, indésirable, suppression par le super admin) : ses e-mails avec elle
  contact_request_id uuid references public.contact_requests (id) on delete cascade,
  to_email text not null check (
    char_length(to_email) <= 254
    and to_email ~ '^[^@]+@[^@]+\.[^@]+$' and to_email !~ '[\x01-\x20\x7f-\xa0\x2028\x2029,;:<>()"\\]'),
  reply_to text check (reply_to is null or (
    char_length(reply_to) <= 254
    and reply_to ~ '^[^@]+@[^@]+\.[^@]+$' and reply_to !~ '[\x01-\x20\x7f-\xa0\x2028\x2029,;:<>()"\\]')),
  subject text not null check (char_length(subject) between 1 and 200 and subject !~ '[\x01-\x1f\x7f-\x9f\x2028\x2029]'),
  body_text text not null check (char_length(body_text) between 1 and 20000),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  sent_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  created_by uuid references public.users (id) on delete set null
);
comment on table public.email_outbox is
  'File des e-mails (contact, réponses, tests) envoyés par le service mailer en SMTP — lecture : super admin ; écriture : serveur.';
comment on column public.email_outbox.attempts is 'Tentatives d''envoi (comptées à la prise par private.claim_emails) ; échec définitif au 8e échec.';
comment on column public.email_outbox.locked_until is 'Envoi en cours jusqu''à cette heure ; passé ce délai, la ligne est reprise (expéditeur arrêté).';
comment on column public.email_outbox.created_by is 'Super admin à l''origine d''une réponse ou d''un e-mail de test (null : formulaire de contact).';

-- Lignes à envoyer (en attente ou envoi en cours), prises par ordre d'arrivée
create index email_outbox_queue_idx on public.email_outbox (id) where status in ('pending', 'sending');
-- E-mails d'une demande (fiche /admin/contacts/<id>, suppression en cascade)
create index email_outbox_request_idx on public.email_outbox (contact_request_id);
-- Accusés de réception récents d'une adresse (un seul par 24 h)
create index email_outbox_ack_idx on public.email_outbox (lower(to_email), created_at) where kind = 'contact_ack';

-- Réveil du mailer : e-mail ajouté, ou e-mail en échec remis en file par le super admin. Un seul signal par
-- transaction (PostgreSQL fusionne les notifications identiques), envoyé à la validation.
create or replace function private.email_outbox_wake()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_notify('rydar_emails', '');
  return null;
end;
$$;

create trigger email_outbox_wake
  after insert on public.email_outbox
  for each statement execute function private.email_outbox_wake();
create trigger email_outbox_wake_retry
  after update of status on public.email_outbox
  for each row when (old.status = 'failed' and new.status = 'pending')
  execute function private.email_outbox_wake();

-- ----------------------------------------------------------------- droits : lecture super admin, écriture serveur
alter table public.contact_requests enable row level security;
alter table public.email_outbox enable row level security;
create policy contact_requests_select on public.contact_requests for select to authenticated
  using ((select private.is_super_admin()));
create policy email_outbox_select on public.email_outbox for select to authenticated
  using ((select private.is_super_admin()));
revoke all on public.contact_requests, public.email_outbox from anon, authenticated, service_role;
grant select on public.contact_requests, public.email_outbox to authenticated;
-- Service role (actions serveur du super admin : statut, note, réponse, e-mail de test, remise en file ; audit())
grant select, insert, update, delete on public.contact_requests, public.email_outbox to service_role;

-- ----------------------------------------------------------------- enregistrement d'une demande (web, service role)
-- p_request : {id (uuid choisi par le web : lien de la notification), topic, plan_code, name, company, email, phone,
--   fleet_size, message, ip_hash} — déjà validé par contactRequestSchema (@rydar/shared).
-- p_emails : [{kind: 'contact_notify' | 'contact_ack', to_email, reply_to, subject, body_text}] (10 au plus), textes
--   produits par contactNotifyEmail / contactAckEmail.
-- Tout ou rien : une valeur refusée par les contraintes → CONTACT_INVALID (22023), rien n'est enregistré.
-- Accusé de réception : seulement vers l'adresse du demandeur, et ignoré si un accusé est déjà parti vers cette adresse
-- (casse ignorée) ces dernières 24 h. Garde-fou : au plus 300 demandes par heure (la 301e → CONTACT_BUSY, PT429).
-- Même identifiant déjà enregistré (nouvel essai du même envoi) : rien de plus, {ok: true, duplicate: true}.
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
        -- Un seul par adresse et par 24 h (un formulaire rempli en boucle avec l'adresse d'un tiers ne l'inonde pas)
        continue when exists (
          select 1 from public.email_outbox o
          where o.kind = 'contact_ack' and lower(o.to_email) = lower(v_to) and o.created_at > now() - interval '24 hours');
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

-- ----------------------------------------------------------------- mailer : prise, compte rendu
-- Prise d'un lot (connexion directe du mailer, rôle propriétaire) : e-mails en attente arrivés à échéance, et envois
-- restés « en cours » après l'arrêt de l'expéditeur (verrou expiré), par ordre d'arrivée. Chaque ligne prise est
-- verrouillée 5 min (for update skip locked : deux expéditeurs ne prennent jamais la même) et compte une tentative.
-- Envoi resté « en cours » à la 8e tentative (expéditeur arrêté pendant l'envoi, par exemple par un e-mail qui le fait
-- tomber à chaque fois) : échec définitif au lieu d'une boucle ; l'erreur d'une tentative précédente reste citée.
create or replace function private.claim_emails(p_limit integer default 10)
returns setof public.email_outbox
language plpgsql
set search_path = ''
as $$
begin
  update public.email_outbox o
     set status = 'failed', locked_until = null,
         last_error = left('Envoi interrompu à la dernière tentative (expéditeur arrêté pendant l''envoi)'
                           || coalesce(' — erreur précédente : ' || o.last_error, ''), 500)
   where o.id in (select x.id from public.email_outbox x
                  where x.status = 'sending' and (x.locked_until is null or x.locked_until < now()) and x.attempts >= 8
                  for update skip locked);

  return query
    with due as (
      select x.id
        from public.email_outbox x
       where (x.status = 'pending' and x.next_attempt_at <= now())
          or (x.status = 'sending' and (x.locked_until is null or x.locked_until < now()))
       order by x.id
       limit least(greatest(coalesce(p_limit, 10), 0), 100)
       for update skip locked
    ), claimed as (
      update public.email_outbox o
         set status = 'sending', locked_until = now() + interval '5 minutes', attempts = o.attempts + 1
        from due
       where o.id = due.id
      returning o.*
    )
    select * from claimed c order by c.id;
end;
$$;

-- Compte rendu d'un envoi. Succès : envoyé (même si un autre expéditeur a repris la ligne entre-temps : l'e-mail est
-- bien parti). Échec : seulement pour un envoi en cours (un compte rendu tardif ne remet pas en file un e-mail déjà
-- traité) ; nouvel essai après 1 min, 5 min, 15 min, 1 h, 3 h, 6 h puis 12 h ; échec définitif au 8e échec ou tout
-- de suite si p_permanent (adresse refusée par le serveur : 5xx).
create or replace function private.complete_email(p_id bigint, p_ok boolean, p_error text default null, p_permanent boolean default false)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_error text := left(coalesce(nullif(btrim(regexp_replace(coalesce(p_error, ''), '\s+', ' ', 'g')), ''),
                                'Échec de l''envoi (motif inconnu)'), 500);
begin
  if coalesce(p_ok, false) then
    update public.email_outbox
       set status = 'sent', sent_at = now(), locked_until = null, last_error = null
     where id = p_id and status <> 'sent';
    return;
  end if;
  update public.email_outbox o
     set last_error = v_error,
         locked_until = null,
         status = case when coalesce(p_permanent, false) or o.attempts >= 8 then 'failed' else 'pending' end,
         next_attempt_at = case
           when coalesce(p_permanent, false) or o.attempts >= 8 then o.next_attempt_at
           else now() + case
             when o.attempts <= 1 then interval '1 minute'
             when o.attempts = 2 then interval '5 minutes'
             when o.attempts = 3 then interval '15 minutes'
             when o.attempts = 4 then interval '1 hour'
             when o.attempts = 5 then interval '3 hours'
             when o.attempts = 6 then interval '6 hours'
             else interval '12 hours'
           end
         end
   where o.id = p_id and o.status = 'sending';
end;
$$;

-- ----------------------------------------------------------------- durées de conservation
-- Appelée par le ménage du worker (toutes les 5 min) ; quand rien n'a expiré, aucune écriture.
--  * demandes : 3 ans après leur envoi (e-mails liés supprimés avec elles) ;
--  * demandes indésirables : 30 jours après leur dernier changement (le classement peut être annulé d'ici là) ;
--  * e-mails sans demande (e-mails de test) envoyés ou en échec : 1 an ;
--  * empreinte de l'adresse IP : 1 an, comme l'adresse IP du journal d'audit.
create or replace function private.purge_contact_data()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_requests integer;
  v_spam integer;
  v_emails integer;
  v_ips integer;
begin
  delete from public.contact_requests where created_at < now() - interval '3 years';
  get diagnostics v_requests = row_count;
  delete from public.contact_requests where status = 'spam' and updated_at < now() - interval '30 days';
  get diagnostics v_spam = row_count;
  delete from public.email_outbox
   where contact_request_id is null and status in ('sent', 'failed') and created_at < now() - interval '1 year';
  get diagnostics v_emails = row_count;
  update public.contact_requests set ip_hash = null
   where ip_hash is not null and created_at < now() - interval '1 year';
  get diagnostics v_ips = row_count;
  return jsonb_build_object('requests', v_requests, 'spam', v_spam, 'emails', v_emails, 'ip_hashes', v_ips);
end;
$$;

-- ----------------------------------------------------------------- droits d'exécution (deny-by-default, cf. 20260924000900)
revoke execute on function public.svc_contact_submit(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.svc_contact_submit(jsonb, jsonb) to service_role;
-- Mailer et worker : connexion directe avec le rôle propriétaire ; jamais appelées par un client ni par le service role
revoke execute on function
  private.email_outbox_wake(),
  private.claim_emails(integer),
  private.complete_email(bigint, boolean, text, boolean),
  private.purge_contact_data()
from public, anon, authenticated, service_role;
