// Frais Rydar : hausses annoncées au moins 30 jours à l'avance, accord écrit, annulation, application par le ménage,
// e-mails d'annonce (contenu fixe), annonce des CGV, libellés neutres et relance WhatsApp d'une flotte, délai de
// paiement, frais à facturer, baisses sans décision, conservation des annonces (migration
// 20260924006600_platform_fee_schedule).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ERROR_MESSAGES } from "../../packages/shared/src/domain";
import { ORG_LEGAL_CHANGES } from "../../packages/shared/src/features";
import {
  as, createAuthUser, createMember, createOrg, createRideAsOwner, expectPgError, insertRideBypass, pool, sql, type Org,
} from "./helpers";

// -----------------------------------------------------------------------------
// Outils
// -----------------------------------------------------------------------------
/** Version des CGV et de l'accord de traitement passée par le web (ORG_LEGAL_VERSION) */
const VERSION = "2026-10-02";
const APP_URL = "https://app.rydar.example/";
const NBSP = "\u{a0}";
let LEGAL_ON = ""; // entrée en vigueur des CGV (ORG_LEGAL_EFFECTIVE_AT) : aujourd'hui + 45 jours, heure de Paris
let MIN_30 = ""; // premier minuit (Paris) après maintenant + 30 jours
let replyToBefore: string | null = null;

const svc = async (fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ role: "service_role" }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Record<string, any>;
};
const rpc = async (sub: string, fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ sub }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Record<string, any>;
};
const day = async (expr: string): Promise<string> =>
  (await sql(`select (${expr})::text as d`))[0].d as string;
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const ddmmyyyy = (iso: string) => iso.split("-").reverse().join("/");

async function superAdmin() {
  const id = await createAuthUser(`sa-${randomUUID().slice(0, 8)}@rydar.dev`, "Super Admin");
  await sql(`update public.users set is_super_admin = true where id = $1`, [id]);
  return id;
}

/** Organisation existante (modèle flotte par défaut), frais posés directement (état de départ). */
async function org(name: string, fees: { percent?: number; fixed?: number; model?: "fleet" | "centrale" } = {}) {
  const o = await createOrg(name);
  await sql(
    `update public.organizations set dispatch_model = $2, platform_fee_percent = $3, platform_fee_fixed_cents = $4,
            created_at = now() - interval '30 days' where id = $1`,
    [o.id, fees.model ?? "fleet", fees.percent ?? 0, fees.fixed ?? 0],
  );
  // Diffusions du réglage de départ oubliées : chaque test ne voit que les siennes
  await sql("delete from realtime.messages where topic = $1", [`org:${o.id}`]);
  return o;
}

/** CGV + accord de traitement acceptés au nom de l'organisation (comme acceptOrgTerms). */
async function acceptTerms(o: Org, version = VERSION) {
  await sql(
    `insert into public.legal_acceptances (user_id, organization_id, document, version, source)
     values ($1, $2, 'cgv', $3, 'web'), ($1, $2, 'dpa', $3, 'web')`,
    [o.ownerId, o.id, version],
  );
}

type FeeOpts = {
  percent?: number | null; fixed?: number | null; model?: "fleet" | "centrale" | null; mode?: string; on?: string | null;
  note?: string | null; version?: string | null; legalOn?: string | null; url?: string | null;
};
/** Réglage par le super admin (actions serveur createOrganization / updateDispatchModel). */
const setFees = (o: Org, actor: string, f: FeeOpts) =>
  svc("svc_platform_set_fees", [
    o.id, actor, f.percent === undefined ? 0 : f.percent, f.fixed === undefined ? 0 : f.fixed, f.model ?? null, f.mode ?? "notice",
    f.on ?? null, f.note ?? null,
    f.version === undefined ? VERSION : f.version, f.legalOn === undefined ? LEGAL_ON : f.legalOn,
    f.url === undefined ? APP_URL : f.url,
  ]);

const rates = async (o: Org) =>
  (await sql(
    `select dispatch_model as model, platform_fee_percent::float8 as percent, platform_fee_fixed_cents as fixed
       from public.organizations where id = $1`,
    [o.id],
  ))[0] as { model: string; percent: number; fixed: number };
const changes = (o: Org) =>
  sql(
    `select id, mode, status, from_percent::float8 as from_percent, from_fixed_cents, to_percent::float8 as to_percent,
            to_fixed_cents, effective_at, consent_note, emails_queued, close_reason, terms_accepted
       from public.platform_fee_changes where organization_id = $1 order by created_at, id`,
    [o.id],
  );
const emailsOf = (o: Org) =>
  sql(
    `select kind, to_email, reply_to, subject, body_text, platform_fee_change_id, created_by
       from public.email_outbox where organization_id = $1 order by id`,
    [o.id],
  );
const events = async (o: Org) =>
  (await sql(`select payload from realtime.messages where topic = $1 and event = 'platform.updated' order by id`, [`org:${o.id}`]))
    .map((m: any) => m.payload.action as string);
const audits = (o: Org, action: string) =>
  sql(`select actor_type, actor_user_id, severity, metadata from public.audit_logs where organization_id = $1 and action = $2 order by id`, [
    o.id, action,
  ]);
const housekeeping = async () => (await sql("select private.housekeeping() as r"))[0].r as Record<string, any>;

/** Texte fixe passé par private.fr_typo : espace insécable avant « : ; ! ? » et à l'intérieur des guillemets. */
const typo = (t: string) => t.replace(/ ([:;!?»])/g, `${NBSP}$1`).replace(/« /g, `«${NBSP}`);

/** Annonce des CGV reçue par l'organisation (comme svc_org_terms_notify), avec la date d'entrée en vigueur annoncée. */
async function notifyTerms(o: Org, effectiveOn = LEGAL_ON, version = VERSION) {
  await sql(
    `insert into public.org_terms_notices (organization_id, version, effective_on, emails_queued) values ($1, $2, $3, 1)`,
    [o.id, version, effectiveOn],
  );
}

/** E-mails (annonce…) d'un changement de frais partis : envoyés par le mailer à l'instant SQL `at`. */
const markSent = (changeId: string, at = "now() - interval '31 days'") =>
  sql(`update public.email_outbox set status = 'sent', sent_at = ${at} where platform_fee_change_id = $1`, [changeId]);

/** Hausse programmée arrivée à sa date d'effet (une minute passée), annonce partie 31 jours avant. */
async function dueNow(changeId: string, sent = true) {
  await sql(`update public.platform_fee_changes set effective_at = now() - interval '1 minute' where id = $1`, [changeId]);
  if (sent) await markSent(changeId);
}

/** Typographie française d'un texte fixe : espace insécable avant « : ; ! ? » et dans les guillemets. */
function expectFrenchTypography(text: string) {
  expect(text).not.toMatch(/ [:;!?»]/);
  expect(text).not.toMatch(/« /);
  expect(text).not.toMatch(/[^\s\u{a0}][:;!?](\s|$)/u);
}

beforeAll(async () => {
  LEGAL_ON = await day("(now() at time zone 'Europe/Paris')::date + 45");
  MIN_30 = await day(
    `((now() + interval '30 days') at time zone 'Europe/Paris')::date
     + case when ((now() + interval '30 days') at time zone 'Europe/Paris')::time > '00:00' then 1 else 0 end`,
  );
  replyToBefore = (await sql("select email from public.platform_legal where id"))[0]?.email ?? null;
  await sql("update public.platform_legal set email = 'contact@rydar.example' where id");
});

afterAll(async () => {
  await sql("update public.platform_legal set email = $1 where id", [replyToBefore]);
  await pool.end();
});

// -----------------------------------------------------------------------------
describe("Hausse des frais par course : annoncée au moins 30 jours à l'avance", () => {
  it("CGV acceptées : programmée au premier minuit après 30 jours, taux actuels inchangés ; date plus proche refusée", async () => {
    const sa = await superAdmin();
    const o = await org("Préavis Flotte");
    await acceptTerms(o);
    const res = await setFees(o, sa, { fixed: 200 });
    expect(res).toMatchObject({
      ok: true, code: "SCHEDULED", fee_percent: 0, fee_fixed_cents: 0, terms_accepted: true, min_effective_on: MIN_30,
      min_reason: "notice_30_days", emails_queued: 1,
      scheduled_change: { percent: 0, fixed_cents: 200, from_percent: 0, from_fixed_cents: 0, effective_on: MIN_30 },
    });
    expect(res.message).toBe(typo(`Hausse programmée : 2 € par course terminée à partir du ${ddmmyyyy(MIN_30)}. Annonce envoyée par e-mail au propriétaire (1 e-mail).`));
    // Rien ne change avant la date d'effet
    expect(await rates(o)).toEqual({ model: "fleet", percent: 0, fixed: 0 });
    const [c] = await changes(o);
    expect(c).toMatchObject({ mode: "notice", status: "scheduled", to_fixed_cents: 200, emails_queued: 1, terms_accepted: true });
    // Au moins 30 jours, au plus 31 (minuit suivant), à minuit heure de Paris
    const ms = new Date(c.effective_at).getTime() - Date.now();
    expect(ms).toBeGreaterThanOrEqual(30 * 86_400_000);
    expect(ms).toBeLessThan(31 * 86_400_000);
    const [{ local }] = await sql(`select to_char($1::timestamptz at time zone 'Europe/Paris', 'YYYY-MM-DD HH24:MI') as local`, [c.effective_at]);
    expect(local).toBe(`${MIN_30} 00:00`);

    // Date choisie trop proche : refusée, rien n'est écrit
    const early = await setFees(o, sa, { fixed: 300, on: addDays(MIN_30, -1) });
    expect(early).toMatchObject({ ok: false, code: "NOTICE_TOO_SHORT", field: "effectiveOn", min_effective_on: MIN_30, min_reason: "notice_30_days" });
    expect(early.message).toContain(`au plus tôt le ${ddmmyyyy(MIN_30)} (30 jours après l'annonce)`);
    expect(await changes(o)).toHaveLength(1);
    expect(await emailsOf(o)).toHaveLength(1);
    // Date plus lointaine : acceptée
    const later = await setFees(o, sa, { fixed: 200, on: addDays(MIN_30, 10) });
    expect(later).toMatchObject({ ok: true, code: "SCHEDULED", scheduled_change: { effective_on: addDays(MIN_30, 10) } });
    // Un an au plus
    expect(await setFees(o, sa, { fixed: 200, on: addDays(MIN_30, 400) })).toMatchObject({ ok: false, code: "INVALID", field: "effectiveOn" });
  });

  it("hausse du % seul, ou % en baisse et fixe en hausse : programmées aussi (toute hausse d'un des deux taux)", async () => {
    const sa = await superAdmin();
    const pct = await org("Préavis Pourcent", { percent: 5 });
    await acceptTerms(pct);
    expect((await setFees(pct, sa, { percent: 7.5 })).code).toBe("SCHEDULED");
    expect(await rates(pct)).toMatchObject({ percent: 5 });
    const mixed = await org("Préavis Mixte", { percent: 10, fixed: 0 });
    await acceptTerms(mixed);
    expect((await setFees(mixed, sa, { percent: 5, fixed: 100 })).code).toBe("SCHEDULED");
    expect(await rates(mixed)).toMatchObject({ percent: 10, fixed: 0 });
  });

  it("CGV non acceptées (ou version antérieure seulement) : annoncées d'abord, puis pas avant leur entrée en vigueur", async () => {
    const sa = await superAdmin();
    const o = await org("Préavis CGV");
    await acceptTerms(o, "2026-09-27"); // version antérieure : ne compte pas
    // Ni acceptées ni annoncées par e-mail : aucune hausse annoncée (les CGV ne lui sont pas opposables)
    const unknown = await setFees(o, sa, { fixed: 200 });
    expect(unknown).toMatchObject({ ok: false, code: "TERMS_NOT_NOTIFIED", field: "mode", terms_accepted: false });
    expect(unknown.message).toBe(
      typo("CGV du 2 octobre 2026 ni acceptées par l'organisation ni annoncées par e-mail : prévenez-la d'abord (Informations légales, « Prévenir par e-mail »), ou appliquez la hausse sur son accord écrit."),
    );
    expect(await changes(o)).toEqual([]);
    expect(await emailsOf(o)).toEqual([]);
    await notifyTerms(o);
    const tooEarly = await setFees(o, sa, { fixed: 200, on: MIN_30 });
    expect(tooEarly).toMatchObject({ ok: false, code: "NOTICE_TOO_SHORT", min_effective_on: LEGAL_ON, min_reason: "terms_effective", terms_accepted: false });
    expect(tooEarly.message).toContain("entrée en vigueur des CGV, que l'organisation n'a pas encore acceptées");
    const res = await setFees(o, sa, { fixed: 200 });
    expect(res).toMatchObject({ ok: true, code: "SCHEDULED", terms_accepted: false, scheduled_change: { effective_on: LEGAL_ON } });

    // Annonce reçue avec une date plus tardive (date repoussée entre deux envois) : jamais avant la date reçue, même si
    // l'entrée en vigueur générale (ORG_LEGAL_EFFECTIVE_AT) est plus proche
    const late = await org("Préavis CGV Annonce Tardive");
    await acceptTerms(late, "2026-09-27");
    await notifyTerms(late, addDays(LEGAL_ON, 10));
    expect(await setFees(late, sa, { fixed: 200, on: LEGAL_ON })).toMatchObject({
      ok: false, code: "NOTICE_TOO_SHORT", min_effective_on: addDays(LEGAL_ON, 10), min_reason: "terms_effective",
    });
    expect(await setFees(late, sa, { fixed: 200 })).toMatchObject({ ok: true, code: "SCHEDULED", scheduled_change: { effective_on: addDays(LEGAL_ON, 10) } });
    // Accord écrit : possible sans annonce des CGV
    const consent = await org("Préavis CGV Accord Écrit");
    expect(await setFees(consent, sa, { fixed: 200, mode: "consent", note: "E-mail du gérant du 03/10/2026" })).toMatchObject({ ok: true, code: "APPLIED" });
    // Sans version des CGV : pas de hausse programmée (la base ne connaît aucune version)
    const other = await org("Préavis Sans Version");
    expect(await setFees(other, sa, { fixed: 200, version: null })).toMatchObject({ ok: false, code: "TERMS_VERSION_INVALID" });
    expect(await setFees(other, sa, { fixed: 200, version: "2099-01-01" })).toMatchObject({ ok: false, code: "TERMS_VERSION_INVALID" });
    expect(await changes(other)).toEqual([]);
  });

  it("accord écrit de l'organisation : appliquée tout de suite (note obligatoire, journalisée), confirmation par e-mail", async () => {
    const sa = await superAdmin();
    const o = await org("Accord Écrit", { model: "centrale", percent: 5 });
    const noNote = await setFees(o, sa, { percent: 5, fixed: 150, mode: "consent", note: " " });
    expect(noNote).toMatchObject({ ok: false, code: "CONSENT_REQUIRED", field: "consentNote" });
    expect(await rates(o)).toMatchObject({ percent: 5, fixed: 0 });

    const res = await setFees(o, sa, { percent: 5, fixed: 150, mode: "consent", note: "E-mail du gérant du 02/10/2026" });
    expect(res).toMatchObject({ ok: true, code: "APPLIED", fee_percent: 5, fee_fixed_cents: 150, scheduled_change: null, emails_queued: 1 });
    expect(res.message).toBe(typo("Accord écrit enregistré : 5 % du prix + 1,50 € par course terminée dès maintenant. Confirmation envoyée par e-mail au propriétaire."));
    expect(await rates(o)).toEqual({ model: "centrale", percent: 5, fixed: 150 });
    const [c] = await changes(o);
    expect(c).toMatchObject({ mode: "consent", status: "applied", consent_note: "E-mail du gérant du 02/10/2026", emails_queued: 1 });
    const [log] = await audits(o, "organization.platform_fee_changed");
    expect(log).toMatchObject({
      actor_type: "super_admin", actor_user_id: sa, severity: "warning",
      metadata: { mode: "consent", consent_note: "E-mail du gérant du 02/10/2026", after: { platform_fee_fixed_cents: 150 } },
    });
    const [mail] = await emailsOf(o);
    expect(mail.subject).toBe(`Rydar Drive${NBSP}: vos frais par course ont changé`);
    expect(mail.body_text).toContain(`Anciens frais${NBSP}: 5${" "}% du prix de chaque course terminée.`);
    expect(mail.body_text).toContain(`Nouveaux frais${NBSP}: 5 % du prix + 1,50 € par course terminée.`);
    // Centrale : règle honnête (taux en vigueur au calcul de la répartition, y compris après la course)
    expect(mail.body_text).toContain("répartitions du prix calculées à partir de maintenant");
    expect(mail.body_text).toContain("Si vous n'avez pas donné cet accord, signalez-le sans attendre à Rydar Drive.");
    expect(mail.body_text).toContain(`menu «${NBSP}Encaissements${NBSP}»`);
    expect(mail.body_text).not.toContain("E-mail du gérant"); // contenu fixe : jamais la note du super admin
    expect(await events(o)).toEqual(["rates"]);
  });

  it("baisse : tout de suite, sans e-mail ; une hausse annoncée est alors annulée (avis d'annulation)", async () => {
    const sa = await superAdmin();
    const o = await org("Baisse Immédiate", { fixed: 300 });
    await acceptTerms(o);
    const res = await setFees(o, sa, { fixed: 200 });
    expect(res).toMatchObject({ ok: true, code: "APPLIED", fee_fixed_cents: 200, emails_queued: 0, scheduled_change: null });
    expect(res.message).toBe(typo("Frais par course enregistrés dès maintenant : 2 € par course terminée."));
    expect(await rates(o)).toMatchObject({ fixed: 200 });
    expect(await changes(o)).toEqual([expect.objectContaining({ mode: "decrease", status: "applied", from_fixed_cents: 300, to_fixed_cents: 200 })]);
    expect(await emailsOf(o)).toEqual([]);
    expect(await events(o)).toEqual(["rates"]);

    // Hausse annoncée puis baisse : la baisse s'applique, l'annonce est remplacée et le propriétaire prévenu
    const announced = await setFees(o, sa, { fixed: 400 });
    expect(announced.code).toBe("SCHEDULED");
    const lower = await setFees(o, sa, { fixed: 100 });
    expect(lower).toMatchObject({ ok: true, code: "APPLIED", fee_fixed_cents: 100, scheduled_change: null, replaced_change_id: announced.scheduled_change.id });
    expect(lower.message).toBe(typo("Frais par course enregistrés dès maintenant : 1 € par course terminée. Le changement programmé est annulé."));
    const rows = await changes(o);
    expect(rows.find((r) => r.id === announced.scheduled_change.id)).toMatchObject({
      status: "replaced", close_reason: "Remplacé par des frais appliqués tout de suite",
    });
    const mails = await emailsOf(o);
    expect(mails.map((m) => m.subject)).toEqual([
      `Rydar Drive${NBSP}: vos frais par course changent le ${ddmmyyyy(MIN_30)}`,
      `Rydar Drive${NBSP}: changement de vos frais par course annulé`,
    ]);
    expect(mails[1].body_text).toContain(`annoncé pour le ${ddmmyyyy(MIN_30)}, est annulé.`);
    expect(mails[1].body_text).toContain(`Vos frais sont désormais${NBSP}: 1 € par course terminée.`);
    expect(await events(o)).toEqual(["rates", "rates_scheduled", "rates"]);
  });

  it("création d'une organisation : taux et modèle appliqués tout de suite, e-mail des frais au propriétaire ; organisation déjà en service : refusé", async () => {
    const sa = await superAdmin();
    const fresh = await createOrg("Création Immédiate");
    const res = await setFees(fresh, sa, { percent: 2, fixed: 50, model: "centrale", mode: "initial", version: null, legalOn: null });
    expect(res).toMatchObject({ ok: true, code: "APPLIED", dispatch_model: "centrale", fee_percent: 2, fee_fixed_cents: 50, emails_queued: 1 });
    expect(res.message).toBe(typo("Modèle d'exploitation enregistré. Frais par course : 2 % du prix + 0,50 € par course terminée. Communiqués par e-mail au propriétaire."));
    expect(await rates(fresh)).toEqual({ model: "centrale", percent: 2, fixed: 50 });
    const [initial] = await changes(fresh);
    expect(initial).toMatchObject({ mode: "initial", status: "applied", to_percent: 2, to_fixed_cents: 50, emails_queued: 1 });
    // Trace écrite des frais appliqués dès l'ouverture (contenu fixe) : taux, CGV à accepter avant la première course
    const [mail] = await emailsOf(fresh);
    expect(mail).toMatchObject({ kind: "platform_fee_change", platform_fee_change_id: initial.id, created_by: sa });
    expect(mail.subject).toBe(`Rydar Drive${NBSP}: vos frais par course`);
    expect(mail.body_text).toContain(typo("Ses frais plateforme (frais Rydar) : 2 % du prix + 0,50 € par course terminée, appliqués dès l'ouverture du compte."));
    expect(mail.body_text).toContain("aux taux en vigueur au calcul de la répartition du prix");
    expect(mail.body_text).toContain("dans le tableau de bord, avant la première course.\nhttps://app.rydar.example/dashboard");
    expect(mail.body_text).toContain("Toute hausse de ces frais vous sera annoncée au moins 30 jours à l'avance, sauf accord écrit de votre part.");
    expect(mail.body_text).toContain(`menu «${NBSP}Encaissements${NBSP}»`);
    expectFrenchTypography(mail.subject);
    expectFrenchTypography(mail.body_text);
    expect(await audits(fresh, "organization.dispatch_model_changed")).toEqual([
      expect.objectContaining({ severity: "warning", metadata: expect.objectContaining({ mode: "initial", emails: 1, after: expect.objectContaining({ dispatch_model: "centrale" }) }) }),
    ]);
    // Sans frais : ni changement, ni e-mail
    const free = await createOrg("Création Sans Frais");
    expect(await setFees(free, sa, { percent: 0, fixed: 0, model: "fleet", mode: "initial", version: null, legalOn: null })).toMatchObject({
      ok: true, code: "UNCHANGED", emails_queued: 0,
    });
    expect(await emailsOf(free)).toEqual([]);

    // Plus d'une heure après la création, ou une course déjà créée : réglage initial refusé
    const old = await org("Création Ancienne");
    expect(await setFees(old, sa, { fixed: 200, mode: "initial" })).toMatchObject({ ok: false, code: "ORG_NOT_NEW" });
    const busy = await createOrg("Création Avec Course");
    await createRideAsOwner(busy);
    expect(await setFees(busy, sa, { fixed: 200, mode: "initial" })).toMatchObject({ ok: false, code: "ORG_NOT_NEW" });
    expect(await rates(busy)).toMatchObject({ fixed: 0 });
  });

  it("annulation : statut, e-mail, temps réel ; un autre changement entre-temps ou déjà annulé → refus", async () => {
    const sa = await superAdmin();
    const o = await org("Annulation", { fixed: 100 });
    await acceptTerms(o);
    const res = await setFees(o, sa, { fixed: 250 });
    const id = res.scheduled_change.id as string;
    expect(await svc("svc_platform_cancel_fee_change", [o.id, sa, randomUUID(), null, APP_URL])).toMatchObject({
      ok: false, code: "FEE_CHANGE_NOT_PENDING",
    });
    expect(await svc("svc_platform_cancel_fee_change", [o.id, sa, null, null, APP_URL])).toMatchObject({ ok: false, code: "FEE_CHANGE_NOT_PENDING" });
    const cancel = await svc("svc_platform_cancel_fee_change", [o.id, sa, id, "Geste commercial", APP_URL]);
    expect(cancel).toMatchObject({ ok: true, code: "CANCELLED", emails_queued: 1 });
    expect(cancel.message).toBe(typo("Changement annulé. Frais inchangés : 1 € par course terminée. Le propriétaire est prévenu par e-mail."));
    expect((await changes(o))[0]).toMatchObject({ status: "cancelled", close_reason: "Geste commercial" });
    expect(await rates(o)).toMatchObject({ fixed: 100 });
    const mails = await emailsOf(o);
    expect(mails).toHaveLength(2);
    expect(mails[1]).toMatchObject({ kind: "platform_fee_change", platform_fee_change_id: id, created_by: sa });
    expect(mails[1].body_text).toContain(`Vos frais restent inchangés${NBSP}: 1 € par course terminée.`);
    expect(await events(o)).toEqual(["rates_scheduled", "rates_cancelled"]);
    expect(await audits(o, "organization.platform_fee_schedule_cancelled")).toEqual([
      expect.objectContaining({ actor_user_id: sa, metadata: expect.objectContaining({ change_id: id, reason: "cancelled", note: "Geste commercial" }) }),
    ]);
    expect(await svc("svc_platform_cancel_fee_change", [o.id, sa, id, null, APP_URL])).toMatchObject({ ok: false, code: "FEE_CHANGE_NOT_PENDING" });
    // Après l'annulation, la date d'effet passée ne change plus rien
    await sql(`update public.platform_fee_changes set effective_at = now() - interval '1 minute' where id = $1`, [id]);
    await housekeeping();
    expect(await rates(o)).toMatchObject({ fixed: 100 });
  });

  it("remplacement : un seul changement en attente ; même réglage → rien ; hausse moindre → la date annoncée reste possible", async () => {
    const sa = await superAdmin();
    const o = await org("Remplacement");
    await acceptTerms(o);
    const first = await setFees(o, sa, { fixed: 200 });
    // Même réglage renvoyé (double clic, nouvel essai) : rien, aucun nouvel e-mail
    const again = await setFees(o, sa, { fixed: 200 });
    expect(again).toMatchObject({ ok: true, code: "UNCHANGED", scheduled_change: { id: first.scheduled_change.id }, emails_queued: 0 });
    expect(again.message).toBe(typo(`Aucun changement. Le changement programmé reste prévu le ${ddmmyyyy(MIN_30)}.`));
    expect(await emailsOf(o)).toHaveLength(1);

    // Hausse plus forte : remplace l'annonce (nouvel e-mail qui le dit)
    const higher = await setFees(o, sa, { fixed: 300, on: addDays(MIN_30, 5) });
    expect(higher).toMatchObject({ ok: true, code: "SCHEDULED", replaced_change_id: first.scheduled_change.id, scheduled_change: { fixed_cents: 300 } });
    let rows = await changes(o);
    expect(rows.map((r) => [r.status, r.to_fixed_cents])).toEqual([["replaced", 200], ["scheduled", 300]]);
    expect(rows[0].close_reason).toBe("Remplacé par un nouveau changement programmé");
    const mails = await emailsOf(o);
    expect(mails).toHaveLength(2);
    expect(mails[1].body_text).toContain(`Ce message remplace l'annonce précédente (changement prévu le ${ddmmyyyy(MIN_30)}).`);
    expect(mails[1].body_text).toContain("Ce changement vous est annoncé au moins 30 jours à l'avance.");
    // Une seule ligne en attente, même en écriture directe (index unique)
    expect((await expectPgError(sql(
      `insert into public.platform_fee_changes (organization_id, mode, status, from_percent, from_fixed_cents, to_percent, to_fixed_cents, effective_at)
       values ($1, 'notice', 'scheduled', 0, 0, 0, 500, now() + interval '40 days')`, [o.id],
    ))).code).toBe("23505");

    // Annonce faite il y a 15 jours (date d'effet dans 15 jours) : une hausse moindre peut garder cette date
    const soon = addDays(await day("(now() at time zone 'Europe/Paris')::date"), 15);
    await sql(`update public.platform_fee_changes set effective_at = ($2::date)::timestamp at time zone 'Europe/Paris'
                where organization_id = $1 and status = 'scheduled'`, [o.id, soon]);
    expect(await setFees(o, sa, { fixed: 400, on: soon })).toMatchObject({ ok: false, code: "NOTICE_TOO_SHORT", min_effective_on: MIN_30 });
    const smaller = await setFees(o, sa, { fixed: 250 });
    expect(smaller).toMatchObject({ ok: true, code: "SCHEDULED", min_effective_on: soon, min_reason: "already_announced", scheduled_change: { fixed_cents: 250, effective_on: soon } });
    // Annonce à moins de 30 jours (hausse moindre à la date déjà annoncée) : l'e-mail ne prétend pas « 30 jours »
    const smallerMail = (await emailsOf(o)).at(-1)!;
    expect(smallerMail.subject).toBe(`Rydar Drive${NBSP}: vos frais par course changent le ${ddmmyyyy(soon)}`);
    expect(smallerMail.body_text).not.toContain("au moins 30 jours");
    expect(smallerMail.body_text).toContain(
      typo("Ce changement ne dépasse pas celui annoncé précédemment et ne s'applique pas plus tôt : il ne demande donc pas de nouveau préavis (article 5 des CGV). Si vous ne l'acceptez pas, vous pouvez résilier avant cette date, sans frais ni préavis ; la part de l'abonnement payée d'avance pour la période restant à courir vous est alors remboursée au prorata (article 7 des CGV)."),
    );
    // Préavis porté par l'annonce remplacée (celle de la hausse à 3 €) : c'est son e-mail que le ménage vérifiera
    const chained = (await sql(`select notice_change_id from public.platform_fee_changes where id = $1`, [smaller.scheduled_change.id]))[0];
    expect(chained.notice_change_id).toBe(higher.scheduled_change.id);
    expectFrenchTypography(smallerMail.body_text);
    expect(await setFees(o, sa, { fixed: 250, on: addDays(soon, -1) })).toMatchObject({ ok: false, code: "NOTICE_TOO_SHORT", min_effective_on: soon });

    // Réglage égal aux taux actuels : annule l'annonce (« un nouveau réglage la remplace »), sans changer les taux
    const keep = await setFees(o, sa, { fixed: 0 });
    expect(keep).toMatchObject({ ok: true, code: "CANCELLED", scheduled_change: null });
    expect(keep.message).toBe(typo("Changement programmé annulé. Frais inchangés : aucuns frais par course."));
    rows = await changes(o);
    expect(rows.filter((r) => r.status === "scheduled")).toEqual([]);
    expect(rows.at(-1)).toMatchObject({ status: "replaced", close_reason: "Annulé : frais actuels maintenus" });
    expect((await events(o)).at(-1)).toBe("rates_cancelled");
  });

  it("modèle changé (demande ou accord écrit noté) en gardant la hausse annoncée : modèle appliqué, annonce conservée", async () => {
    const sa = await superAdmin();
    const o = await org("Modèle Et Annonce");
    await acceptTerms(o);
    const first = await setFees(o, sa, { fixed: 200 });
    // CGV art. 3 : modèle changé seulement à la demande de l'organisation ou avec son accord écrit, noté
    const noNote = await setFees(o, sa, { fixed: 200, model: "centrale" });
    expect(noNote).toMatchObject({ ok: false, code: "CONSENT_REQUIRED", field: "consentNote" });
    expect(noNote.message).toContain(typo("Changement de modèle : précisez la demande ou l'accord écrit de l'organisation"));
    expect(await rates(o)).toMatchObject({ model: "fleet" });
    const res = await setFees(o, sa, { fixed: 200, model: "centrale", note: "Demande du gérant, e-mail du 03/10/2026" });
    expect(res).toMatchObject({ ok: true, code: "APPLIED", dispatch_model: "centrale", scheduled_change: { id: first.scheduled_change.id } });
    expect(res.message).toBe(typo(`Modèle d'exploitation enregistré. Le changement programmé reste prévu le ${ddmmyyyy(MIN_30)}.`));
    expect(await rates(o)).toEqual({ model: "centrale", percent: 0, fixed: 0 });
    expect(await events(o)).toEqual(["rates_scheduled", "model"]);
    expect(await audits(o, "organization.dispatch_model_changed")).toEqual([
      expect.objectContaining({ severity: "warning", metadata: expect.objectContaining({ model_note: "Demande du gérant, e-mail du 03/10/2026" }) }),
    ]);
    // Modèle seul (aucun taux transmis) : taux et annonce inchangés
    const back = await setFees(o, sa, { percent: null, fixed: null, model: "fleet", note: "Demande du gérant du 04/10/2026" });
    expect(back).toMatchObject({ ok: true, code: "APPLIED", dispatch_model: "fleet", fee_fixed_cents: 0, scheduled_change: { id: first.scheduled_change.id } });
    expect(await setFees(o, sa, { percent: null, fixed: null })).toMatchObject({ ok: true, code: "UNCHANGED", scheduled_change: { fixed_cents: 200 } });
    // Taux à moitié fournis : refusés
    expect(await setFees(o, sa, { percent: 1, fixed: null })).toMatchObject({ ok: false, code: "INVALID", field: "platformFeeFixedCents" });
    expect(await setFees(o, sa, { percent: null, fixed: 300 })).toMatchObject({ ok: false, code: "INVALID", field: "platformFeePercent" });
    expect((await changes(o)).map((c) => c.status)).toEqual(["scheduled"]);
  });
});

// -----------------------------------------------------------------------------
describe("Application à la date d'effet par le ménage", () => {
  it("taux appliqués une seule fois (diffusion « rates » unique, journal système) ; course terminée avant / après", async () => {
    const sa = await superAdmin();
    const o = await org("Ménage Flotte");
    await acceptTerms(o);
    const res = await setFees(o, sa, { fixed: 200 });
    const id = res.scheduled_change.id as string;
    // Pas encore la date : rien
    await housekeeping();
    expect((await changes(o))[0].status).toBe("scheduled");

    // Course terminée avant l'application : anciens taux (aucun frais)
    const before = await insertRideBypass(o, { completed_at: new Date() });
    expect(await sql(`select 1 from public.platform_fee_entries where ride_id = $1`, [before])).toEqual([]);

    // Date d'effet atteinte, annonce partie 31 jours avant
    await dueNow(id);
    const r = await housekeeping();
    expect(r.errors?.platform_fee_changes).toBeUndefined();
    expect(r.platform_fee_changes_applied).toBeGreaterThanOrEqual(1);
    expect(await rates(o)).toMatchObject({ fixed: 200 });
    expect((await changes(o))[0]).toMatchObject({ status: "applied" });
    expect(await events(o)).toEqual(["rates_scheduled", "rates"]);
    const logs = await audits(o, "organization.platform_fee_changed");
    expect(logs).toEqual([
      expect.objectContaining({ actor_type: "system", actor_user_id: null, metadata: expect.objectContaining({ mode: "notice", change_id: id }) }),
    ]);
    // Idempotent : rien de plus au passage suivant
    await housekeeping();
    expect(await events(o)).toEqual(["rates_scheduled", "rates"]);
    expect(await audits(o, "organization.platform_fee_changed")).toHaveLength(1);
    // Course terminée après : nouveaux taux ; l'ancienne course n'est pas refacturée
    const after = await insertRideBypass(o, { completed_at: new Date() });
    expect((await sql(`select amount_cents from public.platform_fee_entries where ride_id = $1`, [after])).map((e) => e.amount_cents)).toEqual([200]);
    expect(await sql(`select 1 from public.platform_fee_entries where ride_id = $1`, [before])).toEqual([]);
    // Owner : plus d'annonce en attente
    const acc = await rpc(o.ownerId, "org_platform_account", [o.id]);
    expect(acc.account).toMatchObject({ fee_fixed_cents: 200, scheduled_change: null });
  });

  it("course qui se termine au même moment (organisation verrouillée) : changement repris au passage suivant, sans double frais", async () => {
    const sa = await superAdmin();
    const o = await org("Ménage Concurrence");
    await acceptTerms(o);
    const res = await setFees(o, sa, { fixed: 200 });
    await dueNow(res.scheduled_change.id);

    // Transaction en cours qui termine une course de l'organisation (numéro de course : ligne de l'organisation verrouillée)
    const client = await pool.connect();
    let rideId: string;
    try {
      await client.query("begin");
      await client.query("select set_config('rydar.bypass_ride_rules', 'on', true)");
      const { rows } = await client.query(
        `insert into public.rides (organization_id, type, status, source, pickup_address, pickup_lat, pickup_lng, dropoff_address,
           pickup_at, completed_at, customer_name, customer_phone, passengers, vehicle_category, price_cents)
         values ($1, 'instant', 'COMPLETED', 'dashboard', 'Opéra, Paris', 48.872, 2.3316, 'Gare de Lyon, Paris', now(), now(),
           'Client', '+33600000002', 1, 'business', 5000) returning id`,
        [o.id],
      );
      rideId = rows[0].id;
      // Le ménage passe pendant ce temps : organisation occupée → rien, sans attendre ni interblocage
      await housekeeping();
      expect((await changes(o))[0].status).toBe("scheduled");
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    // La course validée avant : anciens taux (aucun frais)
    expect(await sql(`select 1 from public.platform_fee_entries where ride_id = $1`, [rideId!])).toEqual([]);
    await housekeeping();
    expect((await changes(o))[0].status).toBe("applied");
    expect(await rates(o)).toMatchObject({ fixed: 200 });
    expect(await sql(`select 1 from public.platform_fee_entries where ride_id = $1`, [rideId!])).toEqual([]);
    expect(await events(o)).toEqual(["rates_scheduled", "rates"]);
  });

  it("annonce pas partie au moins 30 jours avant (mailer en panne, e-mail en échec, envoi tardif) : hausse jamais appliquée, annulée", async () => {
    const sa = await superAdmin();
    for (const [name, state] of [
      ["Ménage Annonce En Attente", "pending"],
      ["Ménage Annonce En Échec", "failed"],
      ["Ménage Annonce Tardive", "late"],
    ] as const) {
      const o = await org(name, { fixed: 100 });
      await acceptTerms(o);
      const res = await setFees(o, sa, { fixed: 300 });
      const id = res.scheduled_change.id as string;
      await dueNow(id, false);
      if (state === "failed") await sql(`update public.email_outbox set status = 'failed' where platform_fee_change_id = $1`, [id]);
      // Parti, mais 29 jours seulement avant la date d'effet
      if (state === "late") await markSent(id, "now() - interval '29 days'");
      const r = await housekeeping();
      expect(r.errors?.platform_fee_changes, name).toBeUndefined();
      expect(await rates(o), name).toMatchObject({ fixed: 100 });
      expect((await changes(o))[0], name).toMatchObject({
        status: "cancelled", close_reason: "Non appliqué : aucun e-mail d'annonce parti au moins 30 jours avant la date d'effet",
      });
      const mails = await emailsOf(o);
      expect(mails, name).toHaveLength(2);
      expect(mails[1].subject).toBe(`Rydar Drive${NBSP}: changement de vos frais par course annulé`);
      expect(mails[1].body_text).toContain(`Vos frais restent inchangés${NBSP}: 1 € par course terminée.`);
      expect(await events(o), name).toEqual(["rates_scheduled", "rates_cancelled"]);
      expect(await audits(o, "organization.platform_fee_schedule_cancelled"), name).toEqual([
        expect.objectContaining({ actor_type: "system", severity: "warning", metadata: expect.objectContaining({ change_id: id, reason: "notice_not_sent", emails: 1 }) }),
      ]);
      expect(await audits(o, "organization.platform_fee_changed"), name).toEqual([]);
    }
  });

  it("hausse moindre gardant la date d'une hausse annoncée : le préavis repose sur l'e-mail de la première annonce", async () => {
    const sa = await superAdmin();
    const o = await org("Ménage Annonce Remplacée");
    await acceptTerms(o);
    const first = await setFees(o, sa, { fixed: 300 });
    const firstId = first.scheduled_change.id as string;
    // Annoncée il y a 16 jours (e-mail parti), pour dans 15 jours
    const soon = addDays(await day("(now() at time zone 'Europe/Paris')::date"), 15);
    await sql(`update public.platform_fee_changes set effective_at = ($2::date)::timestamp at time zone 'Europe/Paris' where id = $1`, [firstId, soon]);
    await markSent(firstId, "now() - interval '16 days'");
    const smaller = await setFees(o, sa, { fixed: 250 });
    expect(smaller).toMatchObject({ ok: true, code: "SCHEDULED", min_reason: "already_announced", scheduled_change: { effective_on: soon } });
    const id = smaller.scheduled_change.id as string;
    // Date d'effet atteinte : l'e-mail de la première annonce est parti plus de 30 jours avant ; celui du remplacement
    // (pas encore parti) ne compte pas
    await sql(`update public.platform_fee_changes set effective_at = now() - interval '1 minute' where id = $1`, [id]);
    await markSent(firstId, "now() - interval '31 days'");
    await housekeeping();
    expect(await rates(o)).toMatchObject({ fixed: 250 });
    expect((await changes(o)).find((c) => c.id === id)).toMatchObject({ status: "applied" });
  });

  it("ménage : hausses appliquées en dernier (verrou de l'organisation pas gardé pendant les purges)", async () => {
    const [{ src }] = await sql(`select pg_get_functiondef('private.housekeeping()'::regprocedure) as src`);
    const apply = (src as string).indexOf("v_fee_changes := private.apply_platform_fee_changes()");
    for (const purge of ["delete from public.notifications", "update public.audit_logs set ip = null", "private.purge_expired_bans()", "auth.audit_log_entries"]) {
      expect((src as string).indexOf(purge), purge).toBeGreaterThan(0);
      expect((src as string).indexOf(purge), purge).toBeLessThan(apply);
    }
  });
});

// -----------------------------------------------------------------------------
describe("E-mails d'annonce : destinataires, contenu fixe, idempotence", () => {
  it("propriétaires actifs seulement (adresses valides, sans doublon), Reply-To de l'éditeur, texte fixe et typographie", async () => {
    const sa = await superAdmin();
    const o = await org("Destinataires");
    await acceptTerms(o);
    await sql(`update public.organizations set name = 'Visitez http://pirate.example', email = 'orga@destinataires.example' where id = $1`, [o.id]);
    await createMember(o, "admin");
    const owner2 = await createAuthUser(`second-${randomUUID().slice(0, 6)}@test.dev`, "Second Owner");
    await sql(`insert into public.organization_users (organization_id, user_id, role) values ($1, $2, 'owner')`, [o.id, owner2]);
    const invited = await createAuthUser(`invite-${randomUUID().slice(0, 6)}@test.dev`, "Invité");
    await sql(`insert into public.organization_users (organization_id, user_id, role, status) values ($1, $2, 'owner', 'invited')`, [o.id, invited]);
    const bad = await createAuthUser(`bad;${randomUUID().slice(0, 6)}@test.dev`, "Adresse Invalide");
    await sql(`insert into public.organization_users (organization_id, user_id, role) values ($1, $2, 'owner')`, [o.id, bad]);

    const res = await setFees(o, sa, { percent: 1.5, fixed: 50 });
    expect(res.emails_queued).toBe(2);
    const owners = (await sql(
      `select lower(u.email) as e from public.users u where u.id = any($1::uuid[]) order by 1`, [[o.ownerId, owner2]],
    )).map((r) => r.e);
    const mails = await emailsOf(o);
    expect(mails.map((m) => m.to_email).sort()).toEqual(owners);
    const slug = (await sql(`select slug from public.organizations where id = $1`, [o.id]))[0].slug as string;
    const ref = `RYD-${slug.replace(/[^a-z0-9]/g, "").slice(0, 12).toUpperCase()}`;
    for (const m of mails) {
      expect(m).toMatchObject({ kind: "platform_fee_change", reply_to: "contact@rydar.example", created_by: sa, platform_fee_change_id: res.scheduled_change.id });
      expect(m.subject).toBe(`Rydar Drive${NBSP}: vos frais par course changent le ${ddmmyyyy(MIN_30)}`);
      expect(m.body_text).toBe(
        [
          "Bonjour,",
          `Les frais plateforme (frais Rydar) de votre organisation, référence ${ref}, vont changer.`,
          `Frais actuels${NBSP}: aucuns frais par course.\nÀ partir du ${ddmmyyyy(MIN_30)}${NBSP}: 1,5 % du prix + 0,50 € par course terminée.`,
          "Les nouveaux frais s'appliquent aux courses terminées à partir de cette date. Une course terminée avant garde ses frais.",
          typo("Ce changement vous est annoncé au moins 30 jours à l'avance. Si vous ne l'acceptez pas, vous pouvez résilier avant cette date, sans frais ni préavis ; la part de l'abonnement payée d'avance pour la période restant à courir vous est alors remboursée au prorata (article 7 des CGV)."),
          `Calcul des frais${NBSP}: article 5 des conditions générales de vente (CGV) de Rydar Drive.\nhttps://app.rydar.example/cgv\n`
            + `Détail dans votre tableau de bord, menu «${NBSP}Frais Rydar${NBSP}».\nhttps://app.rydar.example/dashboard/rydar`,
          `Message automatique de Rydar Drive. Une question${NBSP}? Répondez à cet e-mail.`,
          "L'équipe Rydar Drive",
        ].join("\n\n"),
      );
      // Contenu fixe : jamais le nom saisi par l'organisation
      expect(m.body_text).not.toContain("pirate");
      expectFrenchTypography(m.subject);
      expectFrenchTypography(m.body_text);
    }

    // Aucun propriétaire actif avec une adresse valide : adresse de l'organisation ; sans lien ni Reply-To
    const solo = await org("Sans Propriétaire Actif");
    await acceptTerms(solo);
    await sql(`update public.organization_users set status = 'disabled' where organization_id = $1 and role = 'owner'`, [solo.id]);
    await sql(`update public.organizations set email = ' Contact@Solo.example ' where id = $1`, [solo.id]);
    await sql("update public.platform_legal set email = null where id");
    try {
      expect((await setFees(solo, sa, { fixed: 100, url: null })).emails_queued).toBe(1);
    } finally {
      await sql("update public.platform_legal set email = 'contact@rydar.example' where id");
    }
    const [m] = await emailsOf(solo);
    expect(m).toMatchObject({ to_email: "contact@solo.example", reply_to: null });
    expect(m.body_text).not.toContain("http");
    expect(m.body_text).toContain(`Une question${NBSP}? Écrivez-nous depuis la page Contact du site Rydar Drive.`);

    // Personne à prévenir (aucune adresse valide) : hausse annoncée refusée (CGV art. 5 : annoncée par e-mail) ; accord
    // écrit possible
    const nobody = await org("Personne À Prévenir");
    await acceptTerms(nobody);
    await sql(`update public.organization_users set status = 'disabled' where organization_id = $1`, [nobody.id]);
    const res2 = await setFees(nobody, sa, { fixed: 100 });
    expect(res2).toMatchObject({ ok: false, code: "NO_EMAIL", field: "mode" });
    expect(res2.message).toBe(
      typo("Aucune adresse e-mail valide pour le propriétaire ni pour l'organisation : corrigez l'adresse pour annoncer la hausse, ou appliquez-la sur son accord écrit."),
    );
    expect(await changes(nobody)).toEqual([]);
    expect(await setFees(nobody, sa, { fixed: 100, mode: "consent", note: "Courrier du gérant du 02/10/2026" })).toMatchObject({ ok: true, code: "APPLIED", emails_queued: 0 });
  });

  it("centrale : règle honnête (taux au calcul de la répartition, y compris après la course) et menu « Encaissements »", async () => {
    const sa = await superAdmin();
    const o = await org("Annonce Centrale", { model: "centrale" });
    await acceptTerms(o);
    await setFees(o, sa, { percent: 3 });
    const [m] = await emailsOf(o);
    expect(m.body_text).toContain(
      `Les nouveaux frais s'appliquent aux répartitions du prix calculées à partir de cette date${NBSP}: courses créées à partir de cette date, et courses dont le prix, la commission ou le mode de paiement est saisi ou modifié à partir de cette date (y compris une course déjà terminée, par une écriture de correction).`,
    );
    expect(m.body_text).toContain("https://app.rydar.example/dashboard/settlements");
  });
});

// -----------------------------------------------------------------------------
describe("Lecture : propriétaire et administrateur (annonce), super admin (fiche)", () => {
  it("owner / admin : « scheduled_change » et menu « Frais Rydar » d'une flotte à 0 € ; dispatcher : rien", async () => {
    const sa = await superAdmin();
    const o = await org("Lecture Annonce");
    await acceptTerms(o);
    const admin = await createMember(o, "admin");
    const dispatcher = await createMember(o, "dispatcher");
    expect(await rpc(o.ownerId, "org_platform_fees_enabled", [o.id])).toBe(false);
    const res = await setFees(o, sa, { fixed: 200 });
    for (const sub of [o.ownerId, admin]) {
      expect(await rpc(sub, "org_platform_fees_enabled", [o.id])).toBe(true);
      const acc = await rpc(sub, "org_platform_account", [o.id]);
      expect(acc).toMatchObject({ enabled: true, account: { fee_fixed_cents: 0, balance_cents: 0 } });
      expect(acc.account.scheduled_change).toEqual({
        id: res.scheduled_change.id, percent: 0, fixed_cents: 200, from_percent: 0, from_fixed_cents: 0,
        effective_at: expect.any(String), effective_on: MIN_30, announced_at: expect.any(String),
      });
      expect((await rpc(sub, "org_platform_status", [o.id])).account.scheduled_change.effective_on).toBe(MIN_30);
    }
    expect(await rpc(dispatcher, "org_platform_status", [o.id])).toEqual({ enabled: false });
    expect(await rpc(dispatcher, "org_platform_fees_enabled", [o.id])).toBe(false);
    expect((await expectPgError(rpc(dispatcher, "org_platform_account", [o.id]))).code).toBe("42501");
    // Lecture directe de la table : super admin seulement
    expect(await as({ sub: o.ownerId }, (q) => q(`select id from public.platform_fee_changes where organization_id = $1`, [o.id]))).toEqual([]);
    expect(await as({ sub: sa }, (q) => q(`select id from public.platform_fee_changes where organization_id = $1`, [o.id]))).toHaveLength(1);
    // Vue d'ensemble du super admin : la flotte y figure dès l'annonce
    const [overview] = await as({ sub: sa }, (q) => q(`select public.admin_platform_overview() as r`));
    expect(overview.r.organizations.find((x: any) => x.id === o.id)).toMatchObject({ scheduled_change: { fixed_cents: 200 } });
  });

  it("super admin : fiche (acceptation des CGV, date au plus tôt, aperçu d'un réglage, historique et e-mails)", async () => {
    const sa = await superAdmin();
    const o = await org("Fiche Super Admin", { fixed: 100 });
    const read = (percent: number | null = null, fixed: number | null = null) =>
      as({ sub: sa }, (q) => q(`select public.admin_platform_fee_schedule($1, $2, $3, $4, $5) as r`, [o.id, VERSION, LEGAL_ON, percent, fixed]))
        .then((rows) => rows[0].r as Record<string, any>);
    let f = await read(0, 300);
    expect(f).toMatchObject({
      dispatch_model: "fleet", current: { percent: 0, fixed_cents: 100, terms_text: "1 € par course terminée" }, scheduled: null,
      terms: { version: VERSION, accepted: false, accepted_at: null, effective_on: LEGAL_ON },
      min_effective_on: LEGAL_ON, min_reason: "terms_effective",
      preview: { kind: "increase", min_effective_on: LEGAL_ON, default_effective_on: LEGAL_ON, terms_text: "3 € par course terminée" },
      history: [],
    });
    expect((await read(0, 50)).preview).toMatchObject({ kind: "decrease", min_effective_on: null });
    expect((await read(0, 100)).preview).toMatchObject({ kind: "unchanged" });
    await acceptTerms(o);
    f = await read();
    expect(f).toMatchObject({ terms: { accepted: true, accepted_at: expect.any(String) }, min_effective_on: MIN_30, min_reason: "notice_30_days", preview: null });
    const res = await setFees(o, sa, { fixed: 300 });
    f = await read(0, 200);
    expect(f.scheduled).toMatchObject({
      id: res.scheduled_change.id, status: "scheduled", mode: "notice", fixed_cents: 300, effective_on: MIN_30, emails_queued: 1,
      created_by_name: "Super Admin", emails: [expect.objectContaining({ status: "pending", subject: expect.stringContaining("changent le") })],
    });
    expect(f.preview).toMatchObject({ kind: "increase", same_as_scheduled: false, default_effective_on: MIN_30 });
    expect(f.history).toHaveLength(1);
    // Réservée au super admin
    expect((await expectPgError(as({ sub: o.ownerId }, (q) => q(`select public.admin_platform_fee_schedule($1)`, [o.id])))).code).toBe("42501");
    expect((await expectPgError(as({ role: "anon" }, (q) => q(`select public.admin_platform_fee_schedule($1)`, [o.id])))).code).toBe("42501");
  });
});

// -----------------------------------------------------------------------------
describe("Droits : super admin seulement, rien pour anon / authenticated", () => {
  it("svc_* : auteur super admin revérifié ; clients refusés ; outils et ménage fermés, même au service role", async () => {
    const sa = await superAdmin();
    const o = await org("Droits Frais");
    // Auteur qui n'est pas super admin (service role) : refus, rien n'est écrit
    for (const actor of [o.ownerId, null]) {
      expect((await expectPgError(setFees(o, actor as string, { fixed: 200 }))).code).toBe("42501");
      expect((await expectPgError(svc("svc_platform_cancel_fee_change", [o.id, actor, randomUUID(), null, null]))).code).toBe("42501");
      expect((await expectPgError(svc("svc_org_terms_notify", [actor, VERSION, LEGAL_ON, null]))).code).toBe("42501");
    }
    expect(await changes(o)).toEqual([]);
    const calls = [
      `select public.svc_platform_set_fees('${o.id}', '${sa}', 0, 200)`,
      `select public.svc_platform_cancel_fee_change('${o.id}', '${sa}', '${randomUUID()}')`,
      `select public.svc_org_terms_notify('${sa}', '${VERSION}', '${LEGAL_ON}')`,
    ];
    for (const who of [{ role: "anon" as const }, { sub: o.ownerId }, { sub: sa }]) {
      for (const stmt of calls) {
        expect((await expectPgError(as(who, (q) => q(stmt)))).code, `${JSON.stringify(who)} ${stmt}`).toBe("42501");
      }
    }
    const internal = [
      "select private.apply_platform_fee_changes()",
      `select private.queue_org_emails('${o.id}', 'platform_fee_change', 'Objet', 'Texte', null, null)`,
      `select private.platform_fee_change_email('notice', '${o.id}', 'fleet', 0, 0, 0, 200, current_date, null, null)`,
      `select private.org_owner_emails('${o.id}')`,
    ];
    for (const who of [{ role: "service_role" as const }, { sub: o.ownerId }, { role: "anon" as const }]) {
      for (const stmt of internal) {
        expect((await expectPgError(as(who, (q) => q(stmt)))).code, `${JSON.stringify(who)} ${stmt}`).toBe("42501");
      }
    }
    // Tables : aucune écriture directe, même au service role ; aucune lecture anonyme
    for (const table of ["platform_fee_changes", "org_terms_notices"]) {
      expect((await expectPgError(as({ role: "anon" }, (q) => q(`select * from public.${table}`)))).code).toBe("42501");
      expect((await expectPgError(as({ role: "service_role" }, (q) => q(`delete from public.${table}`)))).code).toBe("42501");
      expect((await expectPgError(as({ sub: sa }, (q) => q(`delete from public.${table}`)))).code).toBe("42501");
    }
    // Les fonctions publiques nouvelles sont security definer avec search_path vide
    const defs = await sql(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef and 'search_path=""' = any (p.proconfig)
          and p.proname = any ($1::text[]) order by 1`,
      [["svc_platform_set_fees", "svc_platform_cancel_fee_change", "svc_org_terms_notify", "admin_platform_fee_schedule"]],
    );
    expect(defs.map((d) => d.proname)).toEqual(["admin_platform_fee_schedule", "svc_org_terms_notify", "svc_platform_cancel_fee_change", "svc_platform_set_fees"]);
  });

  it("garde : une hausse écrite directement par le web (service role) est refusée ; baisse directe et rôle propriétaire possibles", async () => {
    const o = await org("Garde Hausse Directe", { fixed: 200 });
    for (const stmt of [
      "update public.organizations set platform_fee_fixed_cents = 300 where id = $1",
      "update public.organizations set platform_fee_percent = 1 where id = $1",
      "update public.organizations set platform_fee_percent = 1, platform_fee_fixed_cents = 0 where id = $1",
    ]) {
      const e = await expectPgError(as({ role: "service_role" }, (q) => q(stmt, [o.id])));
      expect(e.code, stmt).toBe("42501");
      expect(e.message).toContain("PLATFORM_FEE_NOTICE_REQUIRED");
    }
    expect(await rates(o)).toMatchObject({ percent: 0, fixed: 200 });
    // Baisse directe, ou mêmes taux réécrits avec d'autres colonnes : possibles
    await as({ role: "service_role" }, (q) => q("update public.organizations set platform_fee_fixed_cents = 100 where id = $1", [o.id]));
    await as({ role: "service_role" }, (q) =>
      q("update public.organizations set platform_fee_fixed_cents = 100, name = 'Garde renommée' where id = $1", [o.id]));
    expect(await rates(o)).toMatchObject({ fixed: 100 });
    // Connexion directe avec le rôle propriétaire (migrations, seed, VPS) : non concernée
    await sql("update public.organizations set platform_fee_fixed_cents = 500 where id = $1", [o.id]);
    expect(await rates(o)).toMatchObject({ fixed: 500 });
    expect(ERROR_MESSAGES.PLATFORM_FEE_NOTICE_REQUIRED).toBeTruthy();
  });

  it("paramètres invalides : refusés sans rien écrire", async () => {
    const sa = await superAdmin();
    const o = await org("Paramètres Invalides");
    expect(await setFees(o, sa, { percent: 51 })).toMatchObject({ ok: false, code: "INVALID", field: "platformFeePercent" });
    expect(await setFees(o, sa, { fixed: 100_001 })).toMatchObject({ ok: false, code: "INVALID", field: "platformFeeFixedCents" });
    expect(await setFees(o, sa, { fixed: -1 })).toMatchObject({ ok: false, code: "INVALID", field: "platformFeeFixedCents" });
    expect(await setFees(o, sa, { model: "taxi" as any })).toMatchObject({ ok: false, code: "INVALID", field: "dispatchModel" });
    expect(await setFees(o, sa, { mode: "force" })).toMatchObject({ ok: false, code: "INVALID", field: "mode" });
    expect(await svc("svc_platform_set_fees", [randomUUID(), sa, 0, 0])).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await changes(o)).toEqual([]);
    // Taux avec plus de deux décimales : arrondi comme la colonne numeric(5, 2)
    await acceptTerms(o);
    expect(await setFees(o, sa, { percent: 1.234, mode: "consent", note: "Accord du 01/10" })).toMatchObject({ ok: true, fee_percent: 1.23 });
  });
});

// -----------------------------------------------------------------------------
describe("Annonce des CGV par e-mail (svc_org_terms_notify)", () => {
  it("organisations qui n'ont pas accepté la version : une fois par organisation et par version", async () => {
    const sa = await superAdmin();
    const pending = await org("CGV À Prévenir");
    const accepted = await org("CGV Acceptées");
    await acceptTerms(accepted);
    const older = await org("CGV Ancienne Version");
    await acceptTerms(older, "2026-09-27");
    const archived = await org("CGV Archivée");
    await sql(`update public.organizations set status = 'archived' where id = $1`, [archived.id]);
    const noMail = await org("CGV Sans Adresse");
    await sql(`update public.organization_users set status = 'disabled' where organization_id = $1`, [noMail.id]);
    await sql(`update public.organizations set email = null where id = $1`, [noMail.id]);
    // Clientes avant la publication de la version ; « recent » : créée après la date de la version mais avant sa mise en
    // ligne (avant la première annonce) — déjà cliente elle aussi : date limite et résiliation sans frais
    await sql(`update public.organizations set created_at = '2026-09-01T10:00:00Z' where id = any($1::uuid[])`, [[pending.id, older.id, noMail.id]]);
    const recent = await org("CGV Cliente Récente");
    await sql(`update public.organizations set created_at = '2026-10-02T10:00:00Z' where id = $1`, [recent.id]);
    // Créée après la date de la version mais avant sa mise en ligne : elle avait accepté la version d'alors
    const recentOld = await org("CGV Cliente Avant Mise En Ligne");
    await sql(`update public.organizations set created_at = '2026-10-02T10:00:00Z' where id = $1`, [recentOld.id]);
    await acceptTerms(recentOld, "2026-09-27");

    const res = await svc("svc_org_terms_notify", [sa, VERSION, LEGAL_ON, APP_URL]);
    expect(res).toMatchObject({ ok: true, code: "NOTIFIED" });
    expect(res.organizations).toBeGreaterThanOrEqual(2);
    expect(res.without_email).toBeGreaterThanOrEqual(1);
    expect((await emailsOf(pending)).map((m) => m.kind)).toEqual(["org_terms_update"]);
    expect(await emailsOf(older)).toHaveLength(1);
    expect(await emailsOf(accepted)).toEqual([]);
    expect(await emailsOf(archived)).toEqual([]);
    expect(await emailsOf(noMail)).toEqual([]);

    const [m] = await emailsOf(pending);
    const long = (iso: string) => {
      const [y, mo, d] = iso.split("-").map(Number);
      const months = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
      return `${d === 1 ? "1er" : d} ${months[mo! - 1]} ${y}`;
    };
    expect(m.subject).toBe(`Rydar Drive${NBSP}: nouvelles conditions générales de vente (version du 2 octobre 2026)`);
    expect(m.body_text).toContain("version du 2 octobre 2026");
    // Principaux changements : même liste que le préambule des CGV et le bandeau (ORG_LEGAL_CHANGES), défavorables compris
    expect(m.body_text).toContain(typo(`Principaux changements :\n${ORG_LEGAL_CHANGES.map((c) => `- ${c}`).join("\n")}`));
    expect(ORG_LEGAL_CHANGES.join(" ")).toContain("n'attend plus le renouvellement de l'abonnement");
    expect(ORG_LEGAL_CHANGES.join(" ")).toContain("le blocage vise aussi la relance ou l'attribution d'une course sans chauffeur");
    expect(ORG_LEGAL_CHANGES.join(" ")).toContain("Nouvelle obligation");
    const deadline = (on: string) =>
      typo(`dès son acceptation, et au plus tard le ${long(on)}. Si vous ne l'acceptez pas, vous pouvez résilier sans frais ni préavis avant cette date ; la part de l'abonnement payée d'avance pour la période restant à courir vous est alors remboursée au prorata (article 7 des CGV).`);
    expect(m.body_text).toContain(deadline(LEGAL_ON));
    const [r] = await emailsOf(recent);
    expect(r.body_text).toContain(deadline(LEGAL_ON));
    const [ro] = await emailsOf(recentOld);
    expect(ro.body_text).toContain(deadline(LEGAL_ON));
    expect(m.body_text).toContain(`Texte complet, avec un lien vers la version précédente${NBSP}: page «${NBSP}Conditions générales de vente${NBSP}» du site Rydar Drive.`);
    expect(m.body_text).toContain("https://app.rydar.example/dashboard");
    expect(m.body_text).toContain("https://app.rydar.example/cgv");
    expect(m.reply_to).toBe("contact@rydar.example");
    expectFrenchTypography(m.subject);
    expectFrenchTypography(m.body_text);
    expect(await sql(`select version, effective_on::text, emails_queued, created_by from public.org_terms_notices where organization_id = $1`, [pending.id]))
      .toEqual([{ version: VERSION, effective_on: LEGAL_ON, emails_queued: 1, created_by: sa }]);
    expect(await audits(pending, "organization.terms_notice_sent")).toEqual([
      expect.objectContaining({ actor_user_id: sa, metadata: { version: VERSION, effective_on: LEGAL_ON, emails: 1 } }),
    ]);

    // Deuxième clic : rien de nouveau ; adresse corrigée : cette organisation est prévenue (cliente d'avant : date
    // limite) ; organisation arrivée APRÈS la première annonce : la version s'applique dès son acceptation
    const again = await svc("svc_org_terms_notify", [sa, VERSION, LEGAL_ON, APP_URL]);
    expect(again).toMatchObject({ ok: true, code: "NOTHING_TO_NOTIFY", organizations: 0, emails: 0 });
    expect(again.already_notified).toBeGreaterThanOrEqual(2);
    expect(await emailsOf(pending)).toHaveLength(1);
    await sql(`update public.organizations set email = 'gerant@sansadresse.example' where id = $1`, [noMail.id]);
    const newcomer = await org("CGV Cliente Arrivée Après");
    await sql(`update public.organizations set created_at = now() + interval '1 second' where id = $1`, [newcomer.id]);
    const third = await svc("svc_org_terms_notify", [sa, VERSION, LEGAL_ON, APP_URL]);
    expect(third).toMatchObject({ ok: true, code: "NOTIFIED", organizations: 2, emails: 2 });
    const [fixed] = await emailsOf(noMail);
    expect(fixed.to_email).toBe("gerant@sansadresse.example");
    expect(fixed.body_text).toContain(deadline(LEGAL_ON));
    const [n] = await emailsOf(newcomer);
    expect(n.body_text).toContain("Pour votre organisation, cette version s'applique dès son acceptation.");
    expect(n.body_text).not.toContain("au plus tard");

    // Moins de 30 jours avant la date annoncée (CGV art. 16) : refus, rien n'est envoyé — le premier minuit (Paris) après
    // maintenant + 30 jours est accepté
    const pendingBefore = (await emailsOf(pending)).length;
    const short = await svc("svc_org_terms_notify", [sa, VERSION, addDays(MIN_30, -1), APP_URL]);
    expect(short).toMatchObject({ ok: false, code: "TERMS_NOTICE_TOO_SHORT", min_effective_on: MIN_30 });
    expect(short.message).toContain(typo("Préavis insuffisant : l'annonce dit"));
    expect(short.message).toContain("ORG_LEGAL_EFFECTIVE_AT");
    expect(ERROR_MESSAGES.TERMS_NOTICE_TOO_SHORT).toBeTruthy();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role service_role");
      const { rows } = await client.query("select public.svc_org_terms_notify($1, $2, $3, $4) as r", [sa, VERSION, MIN_30, APP_URL]);
      expect(rows[0].r).toMatchObject({ ok: true });
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
    expect(await emailsOf(pending)).toHaveLength(pendingBefore);

    // Entrée en vigueur passée, version ou date invalide : refus
    const today = await day("(now() at time zone 'Europe/Paris')::date");
    expect(await svc("svc_org_terms_notify", [sa, VERSION, today, APP_URL])).toMatchObject({ ok: false, code: "TERMS_EFFECTIVE_PASSED" });
    expect(await svc("svc_org_terms_notify", [sa, "2026-13-01", LEGAL_ON, APP_URL])).toMatchObject({ ok: false, code: "TERMS_VERSION_INVALID" });
    expect(await svc("svc_org_terms_notify", [sa, VERSION, "2026-01-01", APP_URL])).toMatchObject({ ok: false, code: "TERMS_VERSION_INVALID" });
  });
});

// -----------------------------------------------------------------------------
describe("Flottes : libellés neutres et relance WhatsApp", () => {
  const NEUTRAL = "réglez vos frais Rydar (menu « Frais Rydar » ou « Encaissements »)";

  it("frais en retard : messages sans « Encaissements » seul (création, relance, attribution, libellé du web)", async () => {
    const sa = await superAdmin();
    const o = await org("Neutre Flotte", { fixed: 200 });
    const open = await insertRideBypass(o, { status: "NO_DRIVER_FOUND", completed_at: null, pickup_at: new Date(Date.now() + 3_600_000) });
    await insertRideBypass(o, { completed_at: new Date(Date.now() - 75 * 86_400_000) });
    expect((await svc("svc_platform_terms", [o.id, sa, "monthly", 5, 1])).code).toBe("SAVED");
    const created = await expectPgError(createRideAsOwner(o));
    expect(created.message).toBe(typo(`PLATFORM_FEES_OVERDUE: frais plateforme en retard — ${NEUTRAL} pour créer de nouvelles courses`));
    const relaunch = await rpc(o.ownerId, "redispatch_ride", [open]);
    expect(relaunch).toEqual({ ok: false, code: "PLATFORM_FEES_OVERDUE", message: typo(`Frais plateforme en retard : ${NEUTRAL} pour relancer ou attribuer une course.`) });
    // Libellé du web : même texte, typographie française (espaces insécables)
    expect(ERROR_MESSAGES.PLATFORM_FEES_OVERDUE).toBe(typo(`Frais plateforme en retard : ${NEUTRAL} pour créer de nouvelles courses.`));
    // Plus aucun texte SQL ne renvoie une flotte vers « Encaissements » seul
    const [{ n }] = await sql(
      `select count(*)::int as n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
        where s.nspname in ('public', 'private') and p.prosrc like '%réglez Rydar Drive%'`,
    );
    expect(n).toBe(0);
  });

  it("relance WhatsApp de Rydar refusée pour une flotte (sans consommer la limite horaire) ; relance dans l'app possible", async () => {
    const sa = await superAdmin();
    const o = await org("WhatsApp Flotte", { fixed: 200 });
    await insertRideBypass(o, { completed_at: new Date() });
    const refused = await svc("svc_platform_remind", [o.id, sa, null, true]);
    expect(refused).toMatchObject({ ok: false, code: "WHATSAPP_FLEET_UNSUPPORTED" });
    expect(refused.message).toContain(typo("le modèle approuvé par Meta renvoie à l'onglet « Encaissements », absent d'une flotte"));
    expectFrenchTypography(refused.message);
    expect((await sql(`select platform_reminded_at from public.organizations where id = $1`, [o.id]))[0].platform_reminded_at).toBeNull();
    const [target] = await as({ sub: sa }, (q) => q(`select public.admin_platform_whatsapp($1) as r`, [o.id]));
    expect(target.r).toMatchObject({ ready: false, reason: "FLEET_UNSUPPORTED" });
    expect(await svc("svc_platform_remind", [o.id, sa, "Merci de régler", false])).toMatchObject({ ok: true, code: "REMINDED", whatsapp: false });
    expect(ERROR_MESSAGES.WHATSAPP_FLEET_UNSUPPORTED).toBeTruthy();
  });
});

// -----------------------------------------------------------------------------
describe("Facturation : délai de paiement, frais à facturer par cycle, baisses sans décision, annonces conservées", () => {
  it("délai de paiement : 45 jours au plus pour tout nouveau réglage (facture périodique) ; un délai déjà enregistré n'est pas réécrit", async () => {
    const sa = await superAdmin();
    const o = await org("Délai De Paiement");
    const tooLong = await svc("svc_platform_terms", [o.id, sa, "monthly", 46, null]);
    expect(tooLong).toMatchObject({ ok: false, code: "INVALID_DAYS" });
    expect(tooLong.message).toBe(typo("Délai de paiement : entre 0 et 45 jours (facture récapitulative, article L441-10 du Code de commerce)."));
    expect((await svc("svc_platform_terms", [o.id, sa, "monthly", 45, null])).code).toBe("SAVED");
    // Écriture directe d'un délai plus long : refusée (garde), même par le service role
    const e = await expectPgError(as({ role: "service_role" }, (q) => q("update public.organizations set platform_payment_days = 50 where id = $1", [o.id])));
    expect(e.code).toBe("23514");
    expect(e.message).toContain("PLATFORM_PAYMENT_DAYS_MAX");
    expect(ERROR_MESSAGES.PLATFORM_PAYMENT_DAYS_MAX).toBeTruthy();
    // Délai de 60 jours enregistré avant la garde : conservé (autres colonnes modifiables), seul un nouveau réglage le borne
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local session_replication_role = replica");
      await client.query("update public.organizations set platform_payment_days = 60 where id = $1", [o.id]);
      await client.query("commit");
    } finally {
      client.release();
    }
    await as({ role: "service_role" }, (q) => q("update public.organizations set name = 'Délai Conservé' where id = $1", [o.id]));
    expect((await sql(`select platform_payment_days from public.organizations where id = $1`, [o.id]))[0].platform_payment_days).toBe(60);
    expect((await svc("svc_platform_terms", [o.id, sa, "monthly", 60, null])).code).toBe("INVALID_DAYS");
    expect((await svc("svc_platform_terms", [o.id, sa, "monthly", 30, null])).code).toBe("SAVED");
  });

  it("frais à facturer : écritures prises en compte pendant le cycle (enregistrement ou baisse acceptée), jamais dans un cycle déjà clos", async () => {
    const sa = await superAdmin();
    const o = await org("Frais À Facturer", { percent: 10 });
    const [{ from, to, prev }] = await sql(
      `select date_trunc('month', now() at time zone 'Europe/Paris')::date::text as from,
              (date_trunc('month', now() at time zone 'Europe/Paris') + interval '1 month')::date::text as to,
              (date_trunc('month', now() at time zone 'Europe/Paris') - interval '1 month')::date::text as prev`,
    );
    const lines = (p: string, q: string, who: { sub: string } = { sub: sa }) =>
      as(who, (x) => x(`select public.admin_platform_invoice_lines($1, $2, $3) as r`, [o.id, p, q])).then((rows) => rows[0].r as Record<string, any>);

    // Course terminée maintenant : 5 € (10 % de 50 €)
    const now = await insertRideBypass(o, { completed_at: new Date() });
    // Course terminée il y a 40 jours sans prix (aucuns frais), prix saisi maintenant : première écriture créée maintenant
    // (date de la course 40 jours plus tôt, échéance du cycle en cours)
    const old = await insertRideBypass(o, { completed_at: new Date(Date.now() - 40 * 86_400_000), pickup_at: new Date(Date.now() - 40 * 86_400_000), price_cents: null });
    expect(await sql(`select 1 from public.platform_fee_entries where ride_id = $1`, [old])).toEqual([]);
    await as({ sub: o.ownerId }, (q) => q(`update public.rides set price_cents = 3000 where id = $1`, [old]));
    // Prix de la première course corrigé à la baisse : baisse en attente (pas encore à facturer)
    await as({ sub: o.ownerId }, (q) => q(`update public.rides set price_cents = 4000 where id = $1`, [now]));

    let cur = await lines(from, to);
    expect(cur).toMatchObject({ ok: true, from, to, total_cents: 800, organization: { reference: expect.stringMatching(/^RYD-/), payment_days: 5 } });
    expect(cur.entries.map((e: any) => [e.kind, e.amount_cents, e.status])).toEqual([["ride", 500, "posted"], ["ride", 300, "posted"]]);
    expect(cur.entries[1].ride.number).toBeGreaterThan(0);
    // Le cycle précédent (déjà clos) ne reçoit rien après coup
    expect((await lines(prev, from)).entries).toEqual([]);

    // Baisse acceptée maintenant : prise en compte à sa décision (avoir du cycle en cours)
    const [pending] = await sql(`select id from public.platform_fee_entries where ride_id = $1 and status = 'pending'`, [now]);
    expect((await svc("svc_platform_review_entry", [pending.id, sa, true, null])).code).toBe("APPROVED");
    cur = await lines(from, to);
    expect(cur.total_cents).toBe(700);
    expect(cur.entries.map((e: any) => e.amount_cents)).toEqual([500, 300, -100]);

    // Période invalide ; réservé au super admin
    expect(await lines(to, from)).toMatchObject({ ok: false, code: "INVALID" });
    expect(await lines(prev, addDays(prev, 40))).toMatchObject({ ok: false, code: "INVALID" });
    expect((await expectPgError(lines(from, to, { sub: o.ownerId }))).code).toBe("42501");
    expect((await expectPgError(as({ role: "anon" }, (q) => q(`select public.admin_platform_invoice_lines($1, $2, $3)`, [o.id, from, to]))))).toBeTruthy();
  });

  it("baisse en attente depuis 30 jours sans décision : acceptée par le ménage (CGV art. 5) ; plus récente : toujours en attente", async () => {
    const o = await org("Baisse Sans Décision", { model: "centrale", percent: 10 });
    const ride = await insertRideBypass(o, { completed_at: new Date(Date.now() - 40 * 86_400_000) });
    const insertPending = (age: string) =>
      sql(
        `insert into public.platform_fee_entries (organization_id, ride_id, kind, amount_cents, status, label, reason, occurred_at, due_at, created_at)
         values ($1, $2, 'correction', -100, 'pending', 'Correction course test', 'Prix modifié après la course', now() - $3::interval, now(), now() - $3::interval)
         returning id`,
        [o.id, ride, age],
      ).then((rows) => rows[0].id as string);
    const stale = await insertPending("31 days");
    const recent = await insertPending("29 days");
    await sql("delete from realtime.messages where topic = $1", [`org:${o.id}`]);
    const r = await housekeeping();
    expect(r.errors?.platform_reductions).toBeUndefined();
    expect(r.platform_reductions_accepted).toBeGreaterThanOrEqual(1);
    const rows = await sql(`select id, status, reviewed_by, review_note from public.platform_fee_entries where id = any($1::uuid[]) order by created_at`, [[stale, recent]]);
    expect(rows).toEqual([
      { id: stale, status: "posted", reviewed_by: null, review_note: "Acceptée automatiquement : aucune décision de Rydar dans les 30 jours (CGV, article 5)" },
      { id: recent, status: "pending", reviewed_by: null, review_note: null },
    ]);
    expect(await audits(o, "platform_fee.reduction_approved")).toEqual([
      expect.objectContaining({ actor_type: "system", actor_user_id: null, metadata: expect.objectContaining({ automatic: true, amount_cents: -100 }) }),
    ]);
    expect(await events(o)).toEqual(["reduction_approved"]);
  });

  it("annonces aux organisations (frais Rydar, CGV) gardées 10 ans comme preuve, pas 1 an comme les e-mails de test", async () => {
    const o = await org("Annonces Conservées");
    const insert = (kind: string, age: string) =>
      sql(
        `insert into public.email_outbox (kind, organization_id, to_email, subject, body_text, status, sent_at, created_at)
         values ($1, $2, 'gerant@annonces.example', 'Objet', 'Texte', 'sent', now() - $3::interval, now() - $3::interval) returning id`,
        [kind, kind === "test" ? null : o.id, age],
      ).then((rows) => rows[0].id as number);
    const fee2 = await insert("platform_fee_change", "2 years");
    const terms2 = await insert("org_terms_update", "2 years");
    const fee11 = await insert("platform_fee_change", "11 years");
    const test2 = await insert("test", "2 years");
    const [{ r }] = await sql("select private.purge_contact_data() as r");
    expect(r.emails).toBeGreaterThanOrEqual(2);
    const left = (await sql(`select id from public.email_outbox where id = any($1::bigint[]) order by id`, [[fee2, terms2, fee11, test2]])).map((x) => Number(x.id));
    expect(left).toEqual([fee2, terms2].map(Number));
  });
});
