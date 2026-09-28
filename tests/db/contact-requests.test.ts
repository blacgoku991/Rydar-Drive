// Formulaire de contact du site vitrine et file d'envoi des e-mails (migrations 20260924005700_contact_requests et
// 20260924005800_mailer_status) : droits (super admin en lecture, écritures par le serveur), svc_contact_submit
// (accusé de réception dédoublonné, garde-fou horaire), contraintes, mailer (claim_emails / complete_email, état,
// libération d'un lot, relance), réveil pg_notify, durées de conservation.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  contactAckEmail, contactNotifyEmail, contactReplyEmail, contactRequestSchema, testEmail,
} from "../../packages/shared/src/contact";
import { humanizeError } from "../../packages/shared/src/domain";
import { as, createAuthUser, createDriver, createMember, createOrg, DB_URL, expectPgError, pool, sql } from "./helpers";

afterAll(async () => {
  await pool.end();
});

// La file est globale (claim_emails prend toutes les lignes dues) et le garde-fou compte toutes les demandes de la
// dernière heure : chaque test part de tables vides (aucun autre fichier de tests ne s'en sert).
beforeEach(async () => {
  await sql("truncate public.email_outbox, public.contact_requests, public.mailer_status");
});

// -----------------------------------------------------------------------------
// Outils
// -----------------------------------------------------------------------------
const ADMIN = "admin@rydar.example";
const APP_URL = "https://app.rydar.example/";

type Row = Record<string, any>;

function request(over: Row = {}): Row {
  return {
    id: randomUUID(),
    topic: "pricing",
    plan_code: "pro",
    name: "Jean Dupont",
    company: "Taxi Bleu",
    email: "Jean.Dupont@TaxiBleu.fr",
    phone: "+33612345678",
    fleet_size: "6-20",
    message: "Bonjour, je souhaite un devis pour une flotte de 12 chauffeurs.",
    ip_hash: "f".repeat(64),
    ...over,
  };
}

const notify = (over: Row = {}): Row => ({
  kind: "contact_notify",
  to_email: ADMIN,
  reply_to: "jean.dupont@taxibleu.fr",
  subject: "Nouvelle demande de contact — Demande de tarif (Jean Dupont, Taxi Bleu)",
  body_text: "Nouvelle demande de contact reçue sur le site Rydar Drive.",
  ...over,
});

const ack = (to = "jean.dupont@taxibleu.fr", over: Row = {}): Row => ({
  kind: "contact_ack",
  to_email: to,
  reply_to: null,
  subject: "Votre demande à Rydar Drive a bien été reçue",
  body_text: "Merci pour votre message.",
  ...over,
});

type SubmitResult = { ok: boolean; id: string; ack_queued: boolean; duplicate?: boolean };

/** Paramètre NULL en SQL (et non null JSON). */
const SQL_NULL = Symbol("NULL SQL");

/** Enregistrement par le web (service role). */
async function submit(req: unknown, emails: unknown = [notify(), ack()]): Promise<SubmitResult> {
  const json = (v: unknown) => (v === SQL_NULL ? null : JSON.stringify(v));
  const [row] = await as({ role: "service_role" }, (q) =>
    q("select public.svc_contact_submit($1::jsonb, $2::jsonb) as r", [json(req), json(emails)]),
  );
  return row.r as SubmitResult;
}

const count = async (table: "contact_requests" | "email_outbox") =>
  (await sql(`select count(*)::int as n from public.${table}`))[0].n as number;

const outbox = () => sql("select * from public.email_outbox order by id");

async function superAdmin() {
  const id = await createAuthUser(`sa-${randomUUID().slice(0, 8)}@rydar.dev`, "Super Admin");
  await sql("update public.users set is_super_admin = true where id = $1", [id]);
  return id;
}

/** E-mail ajouté directement dans la file (connexion propriétaire) ; renvoie son id (bigint → texte). */
async function queue(over: Row = {}): Promise<string> {
  const row: Row = { kind: "test", to_email: ADMIN, subject: "E-mail de test — Rydar Drive", body_text: "Test", ...over };
  const cols = Object.keys(row);
  const [r] = await sql(
    `insert into public.email_outbox (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(row),
  );
  return String(r.id);
}

const claim = async (limit = 10) => (await sql("select * from private.claim_emails($1)", [limit])).map((r) => ({ ...r, id: String(r.id) }));
const complete = (id: string, ok: boolean, error: string | null = null, permanent = false) =>
  sql("select private.complete_email($1, $2, $3, $4)", [id, ok, error, permanent]);
const emailRow = async (id: string) => (await sql("select * from public.email_outbox where id = $1", [id]))[0] as Row;

/** Transaction du rôle propriétaire (now() identique pour toutes les requêtes). */
async function inTransaction<T>(fn: (q: (text: string, params?: unknown[]) => Promise<Row[]>) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await fn(async (text, params = []) => (await client.query(text, params)).rows);
    await client.query("commit");
    return out;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// -----------------------------------------------------------------------------
// Droits d'accès
// -----------------------------------------------------------------------------
describe("Demandes de contact et file d'e-mails : droits d'accès", () => {
  const WRITES = [
    "insert into public.contact_requests (topic, name, email, message) values ('other', 'Pirate', 'pirate@test.dev', 'Message du pirate, assez long')",
    "update public.contact_requests set status = 'done'",
    "delete from public.contact_requests",
    `insert into public.email_outbox (kind, to_email, subject, body_text) values ('test', 'victime@exemple.fr', 'Spam', 'Spam')`,
    "update public.email_outbox set status = 'pending', to_email = 'victime@exemple.fr'",
    "delete from public.email_outbox",
  ];

  it("anonyme : ni lecture ni écriture ; svc_contact_submit refusé", async () => {
    await submit(request());
    for (const stmt of ["select * from public.contact_requests", "select * from public.email_outbox", ...WRITES]) {
      const e = await expectPgError(as({ role: "anon" }, (q) => q(stmt)));
      expect(e.code, stmt).toBe("42501");
    }
    const e = await expectPgError(
      as({ role: "anon" }, (q) => q("select public.svc_contact_submit($1::jsonb, $2::jsonb)", [JSON.stringify(request()), "[]"])),
    );
    expect(e.code).toBe("42501");
    expect(await count("contact_requests")).toBe(1);
    expect(await count("email_outbox")).toBe(2);
  });

  it("membre de centrale, chauffeur, simple compte : rien à lire, aucune écriture, svc_contact_submit refusé", async () => {
    await submit(request());
    const org = await createOrg("Contact droits");
    const dispatcher = await createMember(org, "dispatcher");
    const driver = await createDriver(org);
    const stranger = await createAuthUser(`curieux-${randomUUID().slice(0, 8)}@test.dev`, "Curieux");
    for (const sub of [org.ownerId, dispatcher, driver.userId, stranger]) {
      expect(await as({ sub }, (q) => q("select * from public.contact_requests"))).toEqual([]);
      expect(await as({ sub }, (q) => q("select * from public.email_outbox"))).toEqual([]);
      for (const stmt of WRITES) {
        const e = await expectPgError(as({ sub }, (q) => q(stmt)));
        expect(e.code, stmt).toBe("42501");
      }
      const e = await expectPgError(
        as({ sub }, (q) => q("select public.svc_contact_submit($1::jsonb, $2::jsonb)", [JSON.stringify(request()), "[]"])),
      );
      expect(e.code).toBe("42501");
    }
    expect(await count("contact_requests")).toBe(1);
    expect(await count("email_outbox")).toBe(2);
  });

  it("super admin : lit les demandes et la file ; aucune écriture directe, pas d'appel à svc_contact_submit", async () => {
    const { id } = await submit(request());
    const sa = await superAdmin();
    expect(await as({ sub: sa }, (q) => q("select id, email, status from public.contact_requests"))).toEqual([
      { id, email: "jean.dupont@taxibleu.fr", status: "new" },
    ]);
    const mails = await as({ sub: sa }, (q) => q("select kind, contact_request_id from public.email_outbox order by id"));
    expect(mails).toEqual([
      { kind: "contact_notify", contact_request_id: id },
      { kind: "contact_ack", contact_request_id: id },
    ]);
    for (const stmt of WRITES) {
      const e = await expectPgError(as({ sub: sa }, (q) => q(stmt)));
      expect(e.code, stmt).toBe("42501");
    }
    const e = await expectPgError(
      as({ sub: sa }, (q) => q("select public.svc_contact_submit($1::jsonb, $2::jsonb)", [JSON.stringify(request()), "[]"])),
    );
    expect(e.code).toBe("42501");
    // Jeton émis avant la promotion (20260924005400) : pas de lecture
    await sql("update public.users set super_admin_since = now() + interval '1 minute' where id = $1", [sa]);
    expect(await as({ sub: sa }, (q) => q("select id from public.contact_requests"))).toEqual([]);
  });

  it("service role (actions serveur du super admin) : traitement, réponse, e-mail de test, suppression avec les e-mails liés", async () => {
    const { id } = await submit(request());
    const sa = await superAdmin();
    const [before] = await sql("select created_at, updated_at from public.contact_requests where id = $1", [id]);
    const service = (text: string, params: unknown[] = []) => as({ role: "service_role" }, (q) => q(text, params));

    const [treated] = await service(
      `update public.contact_requests set status = 'in_progress', admin_note = 'Rappeler lundi', handled_by = $2, handled_at = now()
       where id = $1 returning status, admin_note, handled_by, updated_at`,
      [id, sa],
    );
    expect(treated).toMatchObject({ status: "in_progress", admin_note: "Rappeler lundi", handled_by: sa });
    expect((treated.updated_at as Date).getTime()).toBeGreaterThan((before.updated_at as Date).getTime());

    const reply = contactReplyEmail("Bonjour Jean,\r\nVoici notre proposition.", { appUrl: APP_URL });
    const [queued] = await service(
      `insert into public.email_outbox (kind, contact_request_id, to_email, subject, body_text, created_by)
       values ('contact_reply', $1, 'jean.dupont@taxibleu.fr', $2, $3, $4) returning id, status, attempts, next_attempt_at, created_by`,
      [id, reply.subject, reply.text, sa],
    );
    expect(queued).toMatchObject({ status: "pending", attempts: 0, created_by: sa });
    const test = testEmail({ appUrl: APP_URL });
    await service("insert into public.email_outbox (kind, to_email, subject, body_text, created_by) values ('test', $1, $2, $3, $4)", [
      ADMIN, test.subject, test.text, sa,
    ]);
    expect((await outbox()).map((m) => m.kind)).toEqual(["contact_notify", "contact_ack", "contact_reply", "test"]);

    // Remise en file d'un échec (bouton « Renvoyer ») : autorisée au serveur
    await sql("update public.email_outbox set status = 'failed', last_error = 'Boîte pleine' where kind = 'test'");
    expect(await service("update public.email_outbox set status = 'pending', next_attempt_at = now() where kind = 'test' and status = 'failed' returning id")).toHaveLength(1);

    // Compte du super admin supprimé : la demande et la réponse restent, sans auteur
    await sql("delete from auth.users where id = $1", [sa]);
    expect((await sql("select handled_by from public.contact_requests where id = $1", [id]))[0].handled_by).toBeNull();
    expect((await sql("select created_by from public.email_outbox where kind = 'contact_reply'"))[0].created_by).toBeNull();

    // Suppression d'une demande (droit à l'effacement) : ses e-mails avec elle ; l'e-mail de test reste
    await service("delete from public.contact_requests where id = $1", [id]);
    expect((await outbox()).map((m) => m.kind)).toEqual(["test"]);
  });

  it("mailer et ménage : fonctions réservées au rôle propriétaire (ni client, ni super admin, ni service role)", async () => {
    const org = await createOrg("Contact fonctions");
    const sa = await superAdmin();
    const id = await queue();
    for (const who of [{ role: "anon" as const }, { sub: org.ownerId }, { sub: sa }, { role: "service_role" as const }]) {
      for (const call of [
        "select * from private.claim_emails(10)",
        `select private.complete_email(${id}, false, 'x', true)`,
        "select private.purge_contact_data()",
        "select private.email_outbox_wake()",
        `select private.report_mailer_status('{"smtp_host":"127.0.0.1","smtp_port":25,"smtp_tls":"loopback-plain"}')`,
        `select private.release_emails(array[${id}]::bigint[])`,
        "select private.requeue_waiting_emails()",
      ]) {
        const e = await expectPgError(as(who, (q) => q(call)));
        expect(e.code, `${JSON.stringify(who)} ${call}`).toBe("42501");
      }
    }
    expect(await emailRow(id)).toMatchObject({ status: "pending", attempts: 0 });
  });
});

// -----------------------------------------------------------------------------
// Enregistrement d'une demande
// -----------------------------------------------------------------------------
describe("svc_contact_submit", () => {
  it("enregistre la demande (adresse en minuscules, champs vides → null) et ses e-mails, en file pour le mailer", async () => {
    const req = request({ company: "  ", phone: "", plan_code: " PRO " });
    const res = await submit(req);
    expect(res).toEqual({ ok: true, id: req.id, ack_queued: true });

    const [row] = await sql("select * from public.contact_requests");
    expect(row).toMatchObject({
      id: req.id, topic: "pricing", plan_code: "pro", name: "Jean Dupont", company: null, email: "jean.dupont@taxibleu.fr",
      phone: null, fleet_size: "6-20", message: req.message, status: "new", admin_note: null, handled_by: null,
      handled_at: null, ip_hash: "f".repeat(64),
    });
    expect(row.updated_at).toEqual(row.created_at);

    const mails = await outbox();
    expect(mails.map((m) => ({ kind: m.kind, to: m.to_email, reply: m.reply_to, request: m.contact_request_id }))).toEqual([
      { kind: "contact_notify", to: ADMIN, reply: "jean.dupont@taxibleu.fr", request: req.id },
      { kind: "contact_ack", to: "jean.dupont@taxibleu.fr", reply: null, request: req.id },
    ]);
    for (const m of mails) {
      expect(m).toMatchObject({ status: "pending", attempts: 0, locked_until: null, sent_at: null, last_error: null, created_by: null });
      expect((m.next_attempt_at as Date).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    }
  });

  it("sans e-mail (adresse de notification non configurée) : la demande est enregistrée seule", async () => {
    for (const emails of [[], null, SQL_NULL]) {
      const req = request({ email: `sans-mail-${randomUUID().slice(0, 6)}@test.dev` });
      expect(await submit(req, emails)).toEqual({ ok: true, id: req.id, ack_queued: false });
    }
    expect(await count("contact_requests")).toBe(3);
    expect(await count("email_outbox")).toBe(0);
  });

  it("chaîne complète : formulaire validé par contactRequestSchema et e-mails des modèles acceptés tels quels", async () => {
    const form = contactRequestSchema.parse({
      topic: "partnership",
      planCode: "Business",
      name: "  Élodie Ÿ-Martin 🚕  ",
      company: "Rydar & Fils — Transports",
      email: "  Elodie.Martin+Contact@Sub.Exemple-Transport.FR ",
      phone: "06 12 34 56 78",
      fleetSize: "51+",
      message: "Bonjour,\r\n\r\nNous cherchons un outil de dispatch : 60 chauffeurs, 3 villes.\r\nMerci !",
      website: "",
    });
    const id = randomUUID();
    const notification = contactNotifyEmail({ ...form, id }, { appUrl: APP_URL, planName: "Business" });
    const acknowledgement = contactAckEmail({ appUrl: APP_URL });
    const res = await submit(
      {
        id, topic: form.topic, plan_code: form.planCode, name: form.name, company: form.company, email: form.email,
        phone: form.phone, fleet_size: form.fleetSize, message: form.message, ip_hash: "a1".repeat(32),
      },
      [
        { kind: "contact_notify", to_email: ADMIN, reply_to: form.email, subject: notification.subject, body_text: notification.text },
        { kind: "contact_ack", to_email: form.email, reply_to: null, subject: acknowledgement.subject, body_text: acknowledgement.text },
      ],
    );
    expect(res).toEqual({ ok: true, id, ack_queued: true });
    const [row] = await sql("select name, company, email, phone, message, plan_code from public.contact_requests");
    expect(row).toEqual({
      name: "Élodie Ÿ-Martin 🚕", company: "Rydar & Fils — Transports", email: "elodie.martin+contact@sub.exemple-transport.fr",
      phone: "+33612345678", message: "Bonjour,\n\nNous cherchons un outil de dispatch : 60 chauffeurs, 3 villes.\nMerci !",
      plan_code: "business",
    });
    const mails = await outbox();
    expect(mails[0].subject).toBe(notification.subject);
    expect(mails[0].body_text).toContain(`https://app.rydar.example/admin/contacts/${id}`);
    expect(mails[1].body_text).toBe(acknowledgement.text);
  });

  it("valeurs extrêmes acceptées par le formulaire : acceptées par la base (tailles comptées en caractères)", async () => {
    const form = contactRequestSchema.parse({
      topic: "other",
      name: "é".repeat(120),
      company: "S".repeat(160),
      email: `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`,
      message: `${"🚕".repeat(4)}${"m".repeat(4992)}`,
    });
    expect(form.email).toHaveLength(254);
    const id = randomUUID();
    const n = contactNotifyEmail({ ...form, id }, { appUrl: APP_URL });
    expect(Array.from(n.subject).length).toBeLessThanOrEqual(200);
    const res = await submit(
      { id, topic: form.topic, name: form.name, company: form.company, email: form.email, message: form.message },
      [{ kind: "contact_notify", to_email: ADMIN, reply_to: form.email, subject: n.subject, body_text: n.text }],
    );
    expect(res).toMatchObject({ ok: true, ack_queued: false });
    // Deux caractères comptés comme PostgreSQL (un émoji = 1) : acceptés
    const short = contactRequestSchema.parse({ topic: "question", name: "Lü", email: "lu@test.dev", message: "🚕".repeat(10) });
    expect(await submit({ id: randomUUID(), topic: short.topic, name: short.name, email: short.email, message: short.message }, [])).toMatchObject({ ok: true });
  });

  it("accusé de réception : un seul par adresse et par 24 h (casse ignorée) ; la notification part toujours", async () => {
    const first = await submit(request());
    expect(first.ack_queued).toBe(true);
    // Même adresse, autre casse, nouvelle demande : notification oui, accusé non
    const second = await submit(request({ email: "JEAN.DUPONT@taxibleu.FR" }), [notify(), ack("Jean.Dupont@TaxiBleu.FR")]);
    expect(second).toMatchObject({ ok: true, ack_queued: false });
    let mails = await outbox();
    expect(mails.filter((m) => m.kind === "contact_notify")).toHaveLength(2);
    expect(mails.filter((m) => m.kind === "contact_ack").map((m) => m.contact_request_id)).toEqual([first.id]);
    expect(await count("contact_requests")).toBe(2);

    // Même envoyé ou en échec, l'accusé récent compte ; une autre adresse reçoit le sien
    await sql("update public.email_outbox set status = 'failed' where kind = 'contact_ack'");
    expect((await submit(request())).ack_queued).toBe(false);
    const other = await submit(request({ email: "autre@exemple.fr" }), [notify(), ack("autre@exemple.fr")]);
    expect(other.ack_queued).toBe(true);

    // Plus de 24 h après le dernier accusé : un nouveau part
    await sql("update public.email_outbox set created_at = now() - interval '24 hours 1 minute' where kind = 'contact_ack' and lower(to_email) = 'jean.dupont@taxibleu.fr'");
    const later = await submit(request());
    expect(later.ack_queued).toBe(true);
    mails = await outbox();
    expect(mails.filter((m) => m.kind === "contact_ack").map((m) => m.contact_request_id)).toEqual([first.id, other.id, later.id]);

    // Deux accusés dans le même envoi : un seul
    const twice = await submit(request({ email: "double@exemple.fr" }), [ack("double@exemple.fr"), ack("DOUBLE@exemple.fr")]);
    expect(twice.ack_queued).toBe(true);
    expect((await outbox()).filter((m) => m.contact_request_id === twice.id)).toHaveLength(1);
  });

  it("accusé de réception : seulement vers l'adresse du demandeur (le formulaire ne sert pas à écrire à un tiers)", async () => {
    const e = await expectPgError(submit(request(), [notify(), ack("victime@exemple.fr")]));
    expect(e.code).toBe("22023");
    expect(e.message).toMatch(/^CONTACT_INVALID/);
    expect(humanizeError(e.message)).toBe("Demande de contact invalide : vérifiez les champs du formulaire.");
    expect(await count("contact_requests")).toBe(0);
    expect(await count("email_outbox")).toBe(0);
  });

  it("même identifiant (nouvel essai du même envoi) : rien de plus", async () => {
    const req = request();
    expect(await submit(req)).toEqual({ ok: true, id: req.id, ack_queued: true });
    expect(await submit({ ...req, message: "Autre message pour la même demande." })).toEqual({
      ok: true, id: req.id, ack_queued: false, duplicate: true,
    });
    expect(await count("contact_requests")).toBe(1);
    expect(await count("email_outbox")).toBe(2);
    expect((await sql("select message from public.contact_requests"))[0].message).toBe(req.message);
  });

  it("valeurs refusées → CONTACT_INVALID (22023) ; tout ou rien : rien n'est enregistré", async () => {
    const cases: [string, unknown, unknown][] = [
      ["demande absente", SQL_NULL, []],
      ["demande null", null, []],
      ["demande non objet", "texte", []],
      ["demande tableau", [1, 2], []],
      ["e-mails non tableau", request(), { kind: "contact_notify" }],
      ["trop d'e-mails", request(), Array.from({ length: 11 }, () => notify())],
      ["identifiant absent", request({ id: undefined }), []],
      ["identifiant invalide", request({ id: "pas-un-uuid" }), []],
      ["sujet inconnu", request({ topic: "sales" }), []],
      ["sujet absent", request({ topic: null }), []],
      ["nom trop court", request({ name: "J" }), []],
      ["nom sur deux lignes", request({ name: "Jean\r\nBcc: victime@exemple.fr" }), []],
      ["nom avec séparateur de ligne", request({ name: "Jean\u{2028}Dupont" }), []],
      ["société sur deux lignes", request({ company: "Taxi\nBleu" }), []],
      ["e-mail invalide", request({ email: "pas-un-email" }), []],
      ["e-mail absent", request({ email: null }), []],
      ["e-mail suivi d'un en-tête", request({ email: "jean@test.dev\nBcc: victime@exemple.fr" }), []],
      ["deux adresses", request({ email: "jean@test.dev,victime@exemple.fr" }), []],
      ["message trop court", request({ message: "Court" }), []],
      ["message trop long", request({ message: "x".repeat(5001) }), []],
      ["taille de flotte inconnue", request({ fleet_size: "100" }), []],
      ["code d'offre invalide", request({ plan_code: "offre spéciale" }), []],
      ["empreinte IP trop longue", request({ ip_hash: "x".repeat(129) }), []],
      ["e-mail d'un autre type", request(), [notify({ kind: "test" })]],
      ["réponse du super admin", request(), [notify({ kind: "contact_reply" })]],
      ["type absent", request(), [notify({ kind: undefined })]],
      ["élément non objet", request(), ["contact_notify"]],
      ["destinataire suivi d'un en-tête", request(), [notify({ to_email: `${ADMIN}\r\nBcc: victime@exemple.fr` })]],
      ["destinataire absent", request(), [notify({ to_email: null })]],
      ["destinataire avec nom", request(), [notify({ to_email: `Rydar <${ADMIN}>` })]],
      ["réponse à : espace", request(), [notify({ reply_to: "jean dupont@test.dev" })]],
      ["sujet avec CR/LF", request(), [notify({ subject: "Nouvelle demande\r\nBcc: victime@exemple.fr" })]],
      ["sujet avec retour à la ligne", request(), [notify({ subject: "Nouvelle\ndemande" })]],
      ["sujet vide", request(), [notify({ subject: "" })]],
      ["sujet trop long", request(), [notify({ subject: "s".repeat(201) })]],
      ["corps vide", request(), [notify({ body_text: "" })]],
      ["corps trop long", request(), [notify({ body_text: "b".repeat(20001) })]],
      // Tout ou rien : un e-mail refusé après un e-mail valide annule tout
      ["second e-mail refusé", request(), [notify(), ack("jean.dupont@taxibleu.fr", { subject: "Accusé\r\nBcc: x@y.fr" })]],
    ];
    for (const [label, req, emails] of cases) {
      const e = await expectPgError(submit(req, emails));
      expect(e.code, label).toBe("22023");
      expect(e.message, label).toMatch(/^CONTACT_INVALID: /);
    }
    expect(await count("contact_requests")).toBe(0);
    expect(await count("email_outbox")).toBe(0);
    // Le motif technique est dans le message (journaux du web), la contrainte en cause nommée
    const e = await expectPgError(submit(request({ name: "J" }), []));
    expect(e.message).toBe("CONTACT_INVALID: valeur refusée (contact_requests_name_check)");
  });

  it("garde-fou : au plus 300 demandes par heure sur la plateforme → CONTACT_BUSY (PT429)", async () => {
    await sql(
      `insert into public.contact_requests (topic, name, email, message, created_at)
       select 'question', 'Robot ' || g, 'robot' || g || '@spam.test', 'Message automatique numéro ' || g, now() - interval '30 minutes'
       from generate_series(1, 299) g`,
    );
    // Demandes de plus d'une heure : hors du compte
    await sql(
      `insert into public.contact_requests (topic, name, email, message, created_at)
       select 'question', 'Ancien ' || g, 'ancien' || g || '@test.dev', 'Message plus ancien numéro ' || g, now() - interval '61 minutes'
       from generate_series(1, 20) g`,
    );
    expect(await submit(request())).toMatchObject({ ok: true, ack_queued: true }); // 300e de l'heure
    const e = await expectPgError(submit(request({ email: "autre@exemple.fr" }), [notify(), ack("autre@exemple.fr")]));
    expect(e.code).toBe("PT429");
    expect(e.message).toMatch(/^CONTACT_BUSY: /);
    expect(humanizeError(e.message)).toBe("Trop de demandes de contact en ce moment : réessayez un peu plus tard.");
    expect(await count("contact_requests")).toBe(320);
    expect(await count("email_outbox")).toBe(2);
    // Une heure plus tard, le formulaire fonctionne de nouveau
    await sql("update public.contact_requests set created_at = created_at - interval '1 hour'");
    expect(await submit(request({ email: "autre@exemple.fr" }), [notify(), ack("autre@exemple.fr")])).toMatchObject({ ok: true });
  });

  it("envois simultanés (double clic, robot) : l'accusé de réception n'est mis en file qu'une fois", async () => {
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    const call = (c: pg.PoolClient, req: Row) =>
      c.query("select public.svc_contact_submit($1::jsonb, $2::jsonb) as r", [JSON.stringify(req), JSON.stringify([notify(), ack()])]).then((r) => r.rows[0].r as SubmitResult);
    let results: SubmitResult[] = [];
    try {
      for (const c of [c1, c2]) {
        await c.query("begin");
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
        await c.query("set local role service_role");
      }
      const first = await call(c1, request());
      const pid = (await c2.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      const second = call(c2, request());
      // La seconde attend la première (verrou consultatif), puis voit son accusé
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const [a] = await sql("select wait_event_type from pg_stat_activity where pid = $1", [pid]);
        waiting = a?.wait_event_type === "Lock";
        if (!waiting) await new Promise((r) => setTimeout(r, 50));
      }
      expect(waiting).toBe(true);
      await c1.query("commit");
      results = [first, await second];
      await c2.query("commit");
    } finally {
      for (const c of [c1, c2]) {
        await c.query("rollback").catch(() => undefined);
        c.release();
      }
    }
    expect(results.map((r) => r.ack_queued)).toEqual([true, false]);
    expect(await count("contact_requests")).toBe(2);
    expect((await outbox()).map((m) => m.kind)).toEqual(["contact_notify", "contact_ack", "contact_notify"]);
  });
});

// -----------------------------------------------------------------------------
// Contraintes des tables (écritures directes du serveur)
// -----------------------------------------------------------------------------
describe("Contraintes de contact_requests et email_outbox", () => {
  async function insert(table: "contact_requests" | "email_outbox", row: Row) {
    const cols = Object.keys(row);
    await sql(
      `insert into public.${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(row),
    );
  }

  it("demandes : sujet, offre, nom, société, e-mail (forme, minuscules), téléphone, flotte, message, statut, note, empreinte", async () => {
    const base = { topic: "question", name: "Jean Dupont", email: "jean@test.dev", message: "Message de test assez long" };
    const refused: Row[] = [
      { topic: "sales" },
      { plan_code: "PRO" },
      { plan_code: "offre pro" },
      { plan_code: "p".repeat(41) },
      { name: "J" },
      { name: "n".repeat(121) },
      { name: "Jean\r\nDupont" },
      { name: "Jean\tDupont" },
      { name: "Jean\u0085Dupont" },
      { company: "Taxi\nBleu" },
      { company: "c".repeat(161) },
      { email: "Jean@Test.dev" },
      { email: "jean@test" },
      { email: "jean@@test.dev" },
      { email: "jean dupont@test.dev" },
      { email: "jean@test.dev\nbcc: victime@exemple.fr" },
      { email: "jean@test.dev,victime@exemple.fr" },
      { email: "jean@test.dev;victime@exemple.fr" },
      { email: "jean <jean@test.dev>" },
      { email: `${"a".repeat(250)}@t.fr` },
      { phone: "06 12\n34 56 78" },
      { phone: "0".repeat(41) },
      { fleet_size: "100" },
      { message: "Trop cour" },
      { message: "m".repeat(5001) },
      { status: "archived" },
      { admin_note: "n".repeat(5001) },
      { ip_hash: "h".repeat(129) },
    ];
    for (const over of refused) {
      const e = await expectPgError(insert("contact_requests", { ...base, ...over }));
      expect(e.code, JSON.stringify(over)).toBe("23514");
    }
    // Limites acceptées
    for (const over of [
      { name: "Jo", message: "Dix lettre" },
      { name: "n".repeat(120), company: "c".repeat(160), message: "m".repeat(5000), plan_code: "pro_2026-a" },
      { email: "x@a-.fr" },
      { email: "prenom.nom+tag@sous.domaine.fr", phone: "+33 6 12 34 56 78", fleet_size: "51+" },
      { status: "spam", admin_note: "n".repeat(5000), ip_hash: "h".repeat(128) },
    ]) {
      await insert("contact_requests", { ...base, ...over });
    }
    expect(await count("contact_requests")).toBe(5);
  });

  it("file : type, adresses (en-tête caché, deux adresses, nom), sujet (CR/LF, 200 caractères), corps, statut, tentatives, erreur", async () => {
    const base = { kind: "test", to_email: ADMIN, subject: "E-mail de test", body_text: "Corps" };
    const refused: Row[] = [
      { kind: "newsletter" },
      { to_email: `${ADMIN}\r\nBcc: victime@exemple.fr` },
      { to_email: `${ADMIN}, victime@exemple.fr` },
      { to_email: `${ADMIN},victime@exemple.fr` },
      { to_email: `Rydar <${ADMIN}>` },
      { to_email: "admin" },
      { reply_to: "jean dupont@test.dev" },
      { reply_to: "jean@test.dev\n" },
      { subject: "Test\r\nBcc: victime@exemple.fr" },
      { subject: "Test\nsuite" },
      { subject: "Test\rsuite" },
      { subject: "" },
      { subject: "s".repeat(201) },
      { body_text: "" },
      { body_text: "b".repeat(20001) },
      { status: "queued" },
      { attempts: -1 },
      { last_error: "e".repeat(501) },
    ];
    for (const over of refused) {
      const e = await expectPgError(insert("email_outbox", { ...base, ...over }));
      expect(e.code, JSON.stringify(over)).toBe("23514");
    }
    const nulls = await expectPgError(insert("email_outbox", { ...base, subject: null }));
    expect(nulls.code).toBe("23502");
    for (const over of [
      { subject: "s".repeat(200), body_text: "Ligne 1\r\nLigne 2\n\tfin", reply_to: "jean@test.dev" },
      { body_text: "b".repeat(20000), last_error: "e".repeat(500), to_email: "ÉLODIE@exemple.fr" },
    ]) {
      await insert("email_outbox", { ...base, ...over });
    }
    expect(await count("email_outbox")).toBe(2);
    // L'identifiant est attribué par la base
    const forced = await expectPgError(insert("email_outbox", { ...base, id: 999999 }));
    expect(forced.code).toBe("428C9");
  });
});

// -----------------------------------------------------------------------------
// Mailer : prise et compte rendu
// -----------------------------------------------------------------------------
describe("Mailer : private.claim_emails / private.complete_email", () => {
  it("prend les e-mails dus par ordre d'arrivée, les verrouille 5 min et compte la tentative", async () => {
    const a = await queue();
    const later = await queue({ next_attempt_at: new Date(Date.now() + 3_600_000) });
    const sent = await queue({ status: "sent", sent_at: new Date() });
    const failed = await queue({ status: "failed", attempts: 8 });
    const b = await queue();
    const c = await queue();

    const first = await inTransaction(async (q) => {
      const rows = await q("select *, now() as tx_now from private.claim_emails(2)");
      return rows.map((r): Row => ({ ...r, id: String(r.id) }));
    });
    expect(first.map((r) => r.id)).toEqual([a, b]);
    for (const r of first) {
      expect(r).toMatchObject({ status: "sending", attempts: 1 });
      expect((r.locked_until as Date).getTime() - (r.tx_now as Date).getTime()).toBe(5 * 60_000);
    }
    expect((await claim()).map((r) => r.id)).toEqual([c]);
    // Rien d'autre : verrouillés, à venir, envoyés ou en échec
    expect(await claim()).toEqual([]);
    expect(await emailRow(later)).toMatchObject({ status: "pending", attempts: 0 });
    expect(await emailRow(sent)).toMatchObject({ status: "sent", attempts: 0 });
    expect(await emailRow(failed)).toMatchObject({ status: "failed", attempts: 8 });
    // Limite bornée : 0 → rien ; null → 10
    await queue();
    expect(await claim(0)).toEqual([]);
    expect(await sql("select id from private.claim_emails(null)")).toHaveLength(1);
  });

  it("reprend un envoi resté « en cours » après l'arrêt de l'expéditeur ; abandon au lieu d'une boucle à la 8e tentative", async () => {
    const id = await queue();
    expect((await claim()).map((r) => r.attempts)).toEqual([1]);
    // Expéditeur arrêté pendant l'envoi : verrou expiré → repris, nouvelle tentative
    await sql("update public.email_outbox set locked_until = now() - interval '1 second' where id = $1", [id]);
    const [again] = await claim();
    expect(again).toMatchObject({ id, status: "sending", attempts: 2 });
    // Verrou encore valable : pas repris
    expect(await claim()).toEqual([]);
    // 8e tentative interrompue à son tour (les précédentes ont pu échouer normalement) : échec définitif, erreur
    // précédente citée
    await sql(
      "update public.email_outbox set attempts = 8, last_error = 'Délai dépassé', locked_until = now() - interval '1 second' where id = $1",
      [id],
    );
    expect(await claim()).toEqual([]);
    const row = await emailRow(id);
    expect(row).toMatchObject({ status: "failed", attempts: 8, locked_until: null });
    expect(row.last_error).toBe("Envoi interrompu à la dernière tentative (expéditeur arrêté pendant l'envoi) — erreur précédente : Délai dépassé");
    // Sans erreur précédente : le motif seul
    const silent = await queue({ status: "sending", attempts: 8, locked_until: new Date(Date.now() - 1000) });
    expect(await claim()).toEqual([]);
    expect(await emailRow(silent)).toMatchObject({
      status: "failed", last_error: "Envoi interrompu à la dernière tentative (expéditeur arrêté pendant l'envoi)",
    });
  });

  it("deux expéditeurs en parallèle ne prennent jamais le même e-mail (skip locked, sans attente)", async () => {
    const ids = [await queue(), await queue(), await queue()];
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      await c1.query("begin");
      const mine = (await c1.query("select id from private.claim_emails(1)")).rows.map((r) => String(r.id));
      expect(mine).toEqual([ids[0]]);
      // Le premier n'a pas encore validé : le second saute la ligne verrouillée au lieu de l'attendre
      await c2.query("set statement_timeout = '5s'");
      const theirs = (await c2.query("select id from private.claim_emails(10)")).rows.map((r) => String(r.id));
      expect(theirs).toEqual([ids[1], ids[2]]);
      await c1.query("commit");
      await c2.query("reset statement_timeout");
    } finally {
      await c1.query("rollback").catch(() => undefined);
      c1.release();
      c2.release();
    }
    expect(await claim()).toEqual([]);
    expect((await outbox()).map((m) => [m.status, m.attempts])).toEqual([["sending", 1], ["sending", 1], ["sending", 1]]);
  });

  it("succès : envoyé, verrou levé, erreur effacée", async () => {
    const id = await queue();
    await claim();
    await sql("update public.email_outbox set last_error = 'Erreur précédente' where id = $1", [id]);
    await complete(id, true);
    const row = await emailRow(id);
    expect(row).toMatchObject({ status: "sent", attempts: 1, locked_until: null, last_error: null });
    expect(row.sent_at).toBeInstanceOf(Date);
    // Compte rendu en double : date d'envoi inchangée
    await complete(id, true);
    expect((await emailRow(id)).sent_at).toEqual(row.sent_at);
    expect(await claim()).toEqual([]);
  });

  it("échec temporaire : nouvel essai après 1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h ; échec définitif au 8e échec", async () => {
    const DELAYS_S = [60, 300, 900, 3600, 10_800, 21_600, 43_200];
    const id = await queue();
    for (let attempt = 1; attempt <= 8; attempt++) {
      await sql("update public.email_outbox set next_attempt_at = now() - interval '1 second' where id = $1", [id]);
      const [claimed] = await claim();
      expect(claimed).toMatchObject({ id, attempts: attempt });
      const row = await inTransaction(async (q) => {
        await q("select private.complete_email($1, false, $2)", [id, `451 4.3.0 Serveur occupé (essai ${attempt})\r\n`]);
        return (await q(
          "select status, locked_until, last_error, extract(epoch from next_attempt_at - now())::int as delay from public.email_outbox where id = $1",
          [id],
        ))[0];
      });
      if (attempt < 8) {
        expect(row, `essai ${attempt}`).toEqual({
          status: "pending", locked_until: null, last_error: `451 4.3.0 Serveur occupé (essai ${attempt})`, delay: DELAYS_S[attempt - 1],
        });
        // Pas repris avant l'échéance
        expect(await claim()).toEqual([]);
      } else {
        expect(row).toMatchObject({ status: "failed", locked_until: null, last_error: "451 4.3.0 Serveur occupé (essai 8)" });
      }
    }
    await sql("update public.email_outbox set next_attempt_at = now() - interval '1 second' where id = $1", [id]);
    expect(await claim()).toEqual([]);
  });

  it("échec définitif immédiat (p_permanent) ; erreur absente remplacée, erreur longue tronquée à 500 caractères", async () => {
    const refused = await queue();
    const unknown = await queue();
    const long = await queue();
    await claim();
    await complete(refused, false, "550 5.1.1 <inconnu@exemple.fr>: Recipient address rejected", true);
    await complete(unknown, false, null);
    await complete(long, false, "x".repeat(800), true);
    expect(await emailRow(refused)).toMatchObject({
      status: "failed", attempts: 1, last_error: "550 5.1.1 <inconnu@exemple.fr>: Recipient address rejected",
    });
    expect(await emailRow(unknown)).toMatchObject({ status: "pending", last_error: "Échec de l'envoi (motif inconnu)" });
    const row = await emailRow(long);
    expect(row.status).toBe("failed");
    expect(row.last_error).toHaveLength(500);
  });

  it("compte rendu tardif : un échec ne remet pas en file un e-mail traité ; un succès l'emporte toujours", async () => {
    const id = await queue();
    await claim();
    await complete(id, true);
    // Premier expéditeur (verrou expiré puis ligne reprise et envoyée par un autre) : échec tardif ignoré
    await complete(id, false, "Délai dépassé");
    expect(await emailRow(id)).toMatchObject({ status: "sent", last_error: null });

    // Échec définitif enregistré, puis succès tardif : l'e-mail est bien parti
    const other = await queue();
    await claim();
    await complete(other, false, "Délai dépassé", true);
    await complete(other, true);
    expect(await emailRow(other)).toMatchObject({ status: "sent", last_error: null });

    // Ligne jamais prise : un échec n'y change rien
    const pending = await queue();
    await complete(pending, false, "Erreur", true);
    expect(await emailRow(pending)).toMatchObject({ status: "pending", attempts: 0, last_error: null });
  });
});

// -----------------------------------------------------------------------------
// Mailer : état, libération d'un lot, relance (20260924005800)
// -----------------------------------------------------------------------------
describe("Mailer : état (mailer_status), libération d'un lot, relance", () => {
  const STATUS = {
    started_at: "2026-09-28T18:00:00.000Z",
    smtp_host: "127.0.0.1",
    smtp_port: 25,
    smtp_tls: "loopback-plain",
    smtp_auth: false,
    mail_from: "noreply@rydar.example",
    smtp_ready: false,
    smtp_checked_at: "2026-09-28T18:00:01.000Z",
    smtp_error: "Serveur mail injoignable : connect ECONNREFUSED 127.0.0.1:25",
    smtp_error_at: "2026-09-28T18:00:01.000Z",
  };
  const report = (status: unknown) => sql("select private.report_mailer_status($1::jsonb)", [status === null ? null : JSON.stringify(status)]);
  const statusRows = () => sql("select * from public.mailer_status");

  it("état : une seule ligne, remplacée à chaque compte rendu (signe de vie à l'heure de la base)", async () => {
    const [{ now }] = await sql("select now() as now");
    await report(STATUS);
    let rows = await statusRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: true,
      smtp_host: "127.0.0.1",
      smtp_port: 25,
      smtp_tls: "loopback-plain",
      smtp_auth: false,
      mail_from: "noreply@rydar.example",
      smtp_ready: false,
      smtp_error: STATUS.smtp_error,
    });
    expect((rows[0].started_at as Date).toISOString()).toBe(STATUS.started_at);
    expect((rows[0].smtp_error_at as Date).toISOString()).toBe(STATUS.smtp_error_at);
    expect((rows[0].seen_at as Date).getTime()).toBeGreaterThanOrEqual((now as Date).getTime());

    // Serveur de nouveau joignable : erreur effacée par le compte rendu suivant (valeurs absentes → null)
    await report({ ...STATUS, smtp_ready: true, smtp_error: null, smtp_error_at: undefined });
    rows = await statusRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ smtp_ready: true, smtp_error: null, smtp_error_at: null });

    // Textes bornés (erreur 500, hôte 255, expéditeur 254) ; valeurs vides → défauts ; état inconnu → null
    await report({ smtp_host: "  ", smtp_tls: "", smtp_error: "x".repeat(800), mail_from: "  " });
    rows = await statusRows();
    expect(rows[0]).toMatchObject({ smtp_host: "?", smtp_port: 25, smtp_tls: "?", smtp_auth: false, mail_from: null, smtp_ready: null });
    expect(rows[0].smtp_error).toHaveLength(500);
    await report(null);
    expect(await statusRows()).toHaveLength(1);
  });

  it("état : lu par le super admin seulement ; personne n'y écrit (ni client, ni super admin, ni service role)", async () => {
    await report(STATUS);
    const sa = await superAdmin();
    expect(await as({ sub: sa }, (q) => q("select smtp_host, smtp_ready from public.mailer_status"))).toEqual([
      { smtp_host: "127.0.0.1", smtp_ready: false },
    ]);
    const org = await createOrg("Contact état mailer");
    const driver = await createDriver(org);
    for (const sub of [org.ownerId, driver.userId]) {
      expect(await as({ sub }, (q) => q("select * from public.mailer_status"))).toEqual([]);
    }
    for (const who of [{ role: "anon" as const }, { role: "service_role" as const }]) {
      const e = await expectPgError(as(who, (q) => q("select * from public.mailer_status")));
      expect(e.code, JSON.stringify(who)).toBe("42501");
    }
    const writes = [
      "update public.mailer_status set smtp_ready = true",
      "delete from public.mailer_status",
      "insert into public.mailer_status (id, started_at, smtp_host, smtp_port, smtp_tls) values (true, now(), 'x', 25, 'x')",
    ];
    for (const who of [{ role: "anon" as const }, { sub: org.ownerId }, { sub: sa }, { role: "service_role" as const }]) {
      for (const stmt of writes) {
        const e = await expectPgError(as(who, (q) => q(stmt)));
        expect(e.code, `${JSON.stringify(who)} ${stmt}`).toBe("42501");
      }
    }
    expect(await statusRows()).toHaveLength(1);
  });

  it("libération : un e-mail réservé mais jamais tenté redevient dû, sans tentative comptée ; rien d'autre ne change", async () => {
    const a = await queue();
    const b = await queue({ attempts: 3, last_error: "Serveur mail injoignable" });
    const sent = await queue({ status: "sent", sent_at: new Date(), attempts: 1 });
    const failed = await queue({ status: "failed", attempts: 8 });
    const waiting = await queue({ attempts: 2, next_attempt_at: new Date(Date.now() + 3_600_000) });
    expect((await claim()).map((r) => [r.id, r.attempts])).toEqual([[a, 1], [b, 4]]);

    const [{ n }] = await sql("select private.release_emails($1::bigint[]) as n", [[a, b, sent, failed, waiting]]);
    expect(n).toBe(2);
    expect(await emailRow(a)).toMatchObject({ status: "pending", attempts: 0, locked_until: null });
    // Erreur de l'essai précédent gardée (affichée dans /admin/contacts)
    expect(await emailRow(b)).toMatchObject({ status: "pending", attempts: 3, locked_until: null, last_error: "Serveur mail injoignable" });
    expect(await emailRow(sent)).toMatchObject({ status: "sent", attempts: 1 });
    expect(await emailRow(failed)).toMatchObject({ status: "failed", attempts: 8 });
    expect(await emailRow(waiting)).toMatchObject({ status: "pending", attempts: 2 });
    // Dus aussitôt : repris au prochain lot
    expect((await claim()).map((r) => r.id)).toEqual([a, b]);
    // Liste vide ou absente : rien
    expect(await sql("select private.release_emails('{}'::bigint[]) as n")).toEqual([{ n: 0 }]);
    expect(await sql("select private.release_emails(null) as n")).toEqual([{ n: 0 }]);
  });

  it("relance : les e-mails en attente d'un nouvel essai deviennent dus ; envois en cours, envoyés, en échec inchangés", async () => {
    const later = await queue({ attempts: 5, next_attempt_at: new Date(Date.now() + 3 * 3_600_000), last_error: "Serveur mail injoignable" });
    const due = await queue({ next_attempt_at: new Date(Date.now() - 60_000) });
    const sending = await queue();
    await claim(); // `later` n'est pas dû ; `due` et `sending` passent « en cours »
    await sql("select private.complete_email($1, false, 'Refus temporaire', false)", [due]); // `due` : prochain essai dans 1 min
    const sent = await queue({ status: "sent", sent_at: new Date(), next_attempt_at: new Date(Date.now() + 3_600_000) });
    const failed = await queue({ status: "failed", attempts: 8, next_attempt_at: new Date(Date.now() + 3_600_000) });
    const [dueBefore, sendingBefore, sentBefore, failedBefore] = await Promise.all([due, sending, sent, failed].map(emailRow));

    const [{ n, tx_now }] = await inTransaction((q) => q("select private.requeue_waiting_emails() as n, now() as tx_now"));
    expect(n).toBe(2);
    const row = await emailRow(later);
    expect(row).toMatchObject({ status: "pending", attempts: 5, last_error: "Serveur mail injoignable" });
    expect((row.next_attempt_at as Date).getTime()).toBe((tx_now as Date).getTime());
    expect((await emailRow(due)).next_attempt_at).toEqual(tx_now);
    expect(await emailRow(sending)).toEqual(sendingBefore);
    expect(await emailRow(sent)).toEqual(sentBefore);
    expect(await emailRow(failed)).toEqual(failedBefore);
    expect(dueBefore.status).toBe("pending");
    expect((await claim()).map((r) => r.id)).toEqual([later, due]);
    // Plus rien en attente : aucune écriture
    expect(await sql("select private.requeue_waiting_emails() as n")).toEqual([{ n: 0 }]);
  });
});

// -----------------------------------------------------------------------------
// Réveil du mailer
// -----------------------------------------------------------------------------
describe("Réveil du mailer : pg_notify('rydar_emails')", () => {
  it("un signal par ajout validé (demande, réponse du serveur) et par remise en file d'un échec ; rien sinon", async () => {
    const listener = new pg.Client({ connectionString: DB_URL });
    await listener.connect();
    const received: { channel: string; payload: string | undefined }[] = [];
    listener.on("notification", (n) => received.push({ channel: n.channel, payload: n.payload }));
    await listener.query("listen rydar_emails");
    const settle = async (expected: number) => {
      for (let i = 0; i < 40 && received.length < expected; i++) await new Promise((r) => setTimeout(r, 25));
      await new Promise((r) => setTimeout(r, 150)); // pas de signal en trop
      const out = [...received];
      received.length = 0;
      return out;
    };
    try {
      // Demande : deux e-mails dans la même transaction → un seul signal (fusionné par PostgreSQL)
      await submit(request());
      expect(await settle(1)).toEqual([{ channel: "rydar_emails", payload: "" }]);

      // Réponse ou e-mail de test (service role)
      await as({ role: "service_role" }, (q) =>
        q("insert into public.email_outbox (kind, to_email, subject, body_text) values ('test', $1, 'Test', 'Test')", [ADMIN]),
      );
      expect(await settle(1)).toHaveLength(1);

      // Transaction annulée : aucun signal
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("insert into public.email_outbox (kind, to_email, subject, body_text) values ('test', $1, 'Test', 'Test')", [ADMIN]);
        await client.query("rollback");
      } finally {
        client.release();
      }
      expect(await settle(0)).toEqual([]);

      // Prise et compte rendu du mailer : aucun signal (pas de réveil en boucle), même pour un nouvel essai
      const claimed = await claim();
      expect(claimed).toHaveLength(3);
      await complete(claimed[0]!.id, true);
      await complete(claimed[1]!.id, false, "451 Serveur occupé");
      await complete(claimed[2]!.id, false, "550 Adresse refusée", true);
      expect(await settle(0)).toEqual([]);

      // Remise en file d'un échec par le super admin (service role) : signal
      await as({ role: "service_role" }, (q) =>
        q("update public.email_outbox set status = 'pending', next_attempt_at = now() where id = $1", [claimed[2]!.id]),
      );
      expect(await settle(1)).toHaveLength(1);
    } finally {
      await listener.end();
    }
  });
});

// -----------------------------------------------------------------------------
// Durées de conservation
// -----------------------------------------------------------------------------
describe("Durées de conservation : private.purge_contact_data", () => {
  it("demandes 3 ans, indésirables 30 jours après leur dernier changement, e-mails de test 1 an, empreinte IP 1 an", async () => {
    const insertRequest = async (created: string, updated = created, status = "done") =>
      String((await sql(
        `insert into public.contact_requests (topic, name, email, message, status, created_at, updated_at, ip_hash)
         values ('question', 'Test Purge', 'purge@test.dev', 'Message de test assez long', $1,
                 now() - $2::interval, now() - $3::interval, $4) returning id`,
        [status, created, updated, "e".repeat(64)],
      ))[0].id);
    const insertEmail = async (created: string, status: string, requestId: string | null = null) =>
      String((await sql(
        `insert into public.email_outbox (kind, contact_request_id, to_email, subject, body_text, status, created_at)
         values ($1, $2, $3, 'Sujet', 'Corps', $4, now() - $5::interval) returning id`,
        [requestId ? "contact_notify" : "test", requestId, ADMIN, status, created],
      ))[0].id);

    const expired = await insertRequest("3 years 1 day");
    const expiredMail = await insertEmail("3 years 1 day", "sent", expired);
    const twoYears = await insertRequest("2 years");
    const twoYearsMail = await insertEmail("2 years", "sent", twoYears);
    const spamOld = await insertRequest("31 days", "31 days", "spam");
    const spamOldMail = await insertEmail("31 days", "sent", spamOld);
    const spamRecent = await insertRequest("10 days", "10 days", "spam");
    // Reçue il y a 60 jours, classée indésirable il y a 5 jours : gardée (le classement peut encore être annulé)
    const spamReclassified = await insertRequest("60 days", "5 days", "spam");
    const fresh = await insertRequest("1 day");
    const testSent = await insertEmail("13 months", "sent");
    const testFailed = await insertEmail("13 months", "failed");
    const testPending = await insertEmail("13 months", "pending");
    const testRecent = await insertEmail("11 months", "sent");
    const [before] = await sql("select updated_at from public.contact_requests where id = $1", [twoYears]);

    expect(await sql("select private.purge_contact_data() as r")).toEqual([{ r: { requests: 1, spam: 1, emails: 2, ip_hashes: 1 } }]);

    const requests = await sql("select id, ip_hash, updated_at from public.contact_requests order by created_at");
    expect(requests.map((r) => r.id)).toEqual([twoYears, spamReclassified, spamRecent, fresh]);
    // Empreinte IP effacée au bout d'un an, sans changer la date de mise à jour (délai des indésirables)
    const kept = requests.find((r) => r.id === twoYears)!;
    expect(kept.ip_hash).toBeNull();
    expect(kept.updated_at).toEqual(before.updated_at);
    expect(requests.filter((r) => r.id !== twoYears).every((r) => r.ip_hash === "e".repeat(64))).toBe(true);

    const mails = (await sql("select id from public.email_outbox order by id")).map((r) => String(r.id));
    expect(mails).toEqual([twoYearsMail, testPending, testRecent]);
    expect(mails).not.toContain(expiredMail);
    expect(mails).not.toContain(spamOldMail);
    expect(mails).not.toContain(testSent);
    expect(mails).not.toContain(testFailed);

    // Rien de plus à effacer
    expect(await sql("select private.purge_contact_data() as r")).toEqual([{ r: { requests: 0, spam: 0, emails: 0, ip_hashes: 0 } }]);
  });
});
