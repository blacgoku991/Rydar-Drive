// Relecture juridique avant l'ouverture (20260924007400_legal_review) : interdiction plateforme réservée à la fraude et
// décision motivée envoyée au chauffeur, signalement à Rydar limité, qui a décidé d'un bannissement (application),
// identité de l'éditeur exigée pour les CGV, vitesse hors de l'historique, e-mail de validation du réseau, refus des
// relances WhatsApp du propriétaire, coordonnées des clients effacées à 3 ans, accusé de réception du mini-site.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  as, createAuthUser, createDriver, createOrg, insertRideBypass, pool, setBookingSitesEnabled, sql, type Org,
} from "./helpers";

type Row = Record<string, any>;
const NB = " ";

let savedLegal: Row | null = null;
beforeAll(async () => {
  [savedLegal] = await sql("select company_name, address, registration from public.platform_legal where id");
});
afterAll(async () => {
  if (savedLegal) {
    await sql("update public.platform_legal set company_name = $1, address = $2, registration = $3 where id", [
      savedLegal.company_name, savedLegal.address, savedLegal.registration,
    ]);
  }
  await setBookingSitesEnabled(false);
  await pool.end();
});

const rpc = async (sub: string, fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ sub }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Row;
};
const svc = async (fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ role: "service_role" }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Row;
};
async function superAdmin() {
  const id = await createAuthUser(`sa-${randomUUID().slice(0, 8)}@rydar.dev`, "Super Admin");
  await sql("update public.users set is_super_admin = true where id = $1", [id]);
  return id;
}
async function centrale(name: string) {
  const org = await createOrg(name);
  await sql("update public.organizations set dispatch_model = 'centrale' where id = $1", [org.id]);
  return org;
}
const uniquePhone = () => `06${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

/** Fiche chauffeur avec e-mail et téléphone propres (les bannissements portent sur l'identité). */
async function driverIn(org: Org, opts: { phone?: string; email?: string | null } = {}) {
  const email = opts.email === undefined ? `legal-${randomUUID().slice(0, 8)}@test.dev` : opts.email;
  const userId = await createAuthUser(email ?? `compte-${randomUUID().slice(0, 8)}@test.dev`, "Karim Test");
  const [d] = await sql(
    `insert into public.drivers (organization_id, user_id, first_name, last_name, phone, email, status, presence)
     values ($1, $2, 'Karim', 'Testeur', $3, $4, 'active', 'offline') returning id`,
    [org.id, userId, opts.phone ?? uniquePhone(), email],
  );
  return { id: d.id as string, userId, email };
}
const banEmails = async (to: string) =>
  sql("select subject, body_text, reply_to, organization_id from public.email_outbox where kind = 'platform_ban' and to_email = $1", [to]);

// -----------------------------------------------------------------------------
describe("Bannissement de toute la plateforme : fraude seulement, décision motivée au chauffeur", () => {
  it("signalement à Rydar refusé pour une dette, un comportement ou un autre motif (rien n'est écrit) ; accepté pour une fraude", async () => {
    const org = await centrale("Légal Signalement");
    const d = await driverIn(org);
    for (const category of ["unpaid", "behavior", "other"]) {
      const res = await rpc(org.ownerId, "ban_driver", [d.id, "Commissions jamais réglées", category, true, false]);
      expect(res, category).toMatchObject({ ok: false, code: "PLATFORM_REPORT_CATEGORY" });
      expect(res.message).toContain(`signalé à Rydar${NB}:`);
    }
    expect((await sql("select banned_at from public.drivers where id = $1", [d.id]))[0].banned_at).toBeNull();
    expect(await sql("select 1 from public.fraud_reports where driver_id = $1", [d.id])).toHaveLength(0);
    // Sans signalement : bannissement propre à la centrale, quelle que soit la catégorie
    expect(await rpc(org.ownerId, "ban_driver", [d.id, "Commissions jamais réglées", "unpaid", false, false])).toMatchObject({ ok: true, code: "BANNED" });

    const f = await driverIn(org);
    const ban = await rpc(org.ownerId, "ban_driver", [f.id, "Faux justificatif d'assurance", "documents", true, false]);
    expect(ban).toMatchObject({ ok: true, code: "BANNED" });
    expect(ban.report_id).toBeTruthy();
  });

  it("ancien signalement d'une autre catégorie : interdiction plateforme refusée (PLATFORM_BAN_CATEGORY), aucun e-mail", async () => {
    const sa = await superAdmin();
    const org = await centrale("Légal Ancien Signalement");
    const d = await driverIn(org);
    await rpc(org.ownerId, "ban_driver", [d.id, "Faux paiements", "fraud", true, false]);
    const [report] = await sql("update public.fraud_reports set category = 'unpaid' where driver_id = $1 returning id", [d.id]);
    const res = await svc("svc_platform_ban", [report.id, sa, "Confirmé"]);
    expect(res).toMatchObject({ ok: false, code: "PLATFORM_BAN_CATEGORY" });
    expect(res.message).toContain(`centrale${NB}: classez le signalement`);
    expect((await sql("select status from public.fraud_reports where id = $1", [report.id]))[0].status).toBe("open");
    expect(await banEmails(d.email!)).toHaveLength(0);
  });

  it("fraude : e-mail au chauffeur (motif, précisions, fondement, examen humain, recours, conservation), sans son nom ; fiche liée d'une autre centrale prévenue aussi", async () => {
    const sa = await superAdmin();
    await sql("update public.platform_legal set email = 'contact@rydar.example' where id");
    const A = await centrale("Légal Fraude A");
    const B = await centrale("Légal Fraude B");
    const phone = uniquePhone();
    const reported = await driverIn(A, { phone });
    const twin = await driverIn(B, { phone, email: null }); // e-mail du compte seulement
    const ban = await rpc(A.ownerId, "ban_driver", [reported.id, "Courses fictives déclarées", "fraud", true, false]);
    const res = await svc("svc_platform_ban", [ban.report_id, sa, "Trois courses terminées sans client, positions incohérentes.", [twin.id]]);
    expect(res).toMatchObject({ ok: true, code: "PLATFORM_BANNED", drivers: 2, extended: 1, emails: 2 });

    const [mail] = await banEmails(reported.email!);
    expect(mail.subject).toBe(`Rydar Drive${NB}: décision concernant votre compte chauffeur`);
    expect(mail.reply_to).toBe("contact@rydar.example");
    expect(mail.organization_id).toBeNull();
    const body = mail.body_text as string;
    expect(body).toContain("d'interdire votre compte chauffeur sur toute la plateforme Rydar Drive");
    expect(body).toContain(`Motif${NB}: fraude constatée, signalé par une centrale qui utilise Rydar Drive et examiné par l'éditeur.`);
    expect(body).toContain(`Précisions${NB}: Trois courses terminées sans client, positions incohérentes.`);
    expect(body).toContain("articles 10 (comportements interdits) et 11 (suspension, bannissement et recours)");
    expect(body).toContain("elle n'a pas été prise de façon automatisée");
    expect(body).toContain("conservées 3 ans au plus");
    expect(body).toContain("dans les 6 mois, en répondant à cet e-mail");
    expect(body).toContain("CNIL");
    expect(body).not.toContain("Karim");
    expect(body).not.toContain("partage un identifiant");

    const accountEmail = (await sql("select email from public.users where id = $1", [twin.userId]))[0].email as string;
    const [twinMail] = await banEmails(accountEmail);
    expect(twinMail.body_text).toContain("Votre fiche chez Légal Fraude B est concernée parce qu'elle partage un identifiant");

    const logs = await sql(
      "select metadata from public.audit_logs where action = 'driver.platform_banned' and entity_id = any ($1::text[])",
      [[reported.id, twin.id]],
    );
    expect(logs.map((l) => l.metadata.notified)).toEqual([true, true]);
  });

  it("faux document : motif adapté ; sans adresse valide, rien n'est envoyé ; contact sans e-mail de l'éditeur : page Contact", async () => {
    const sa = await superAdmin();
    await sql("update public.platform_legal set email = null where id");
    const org = await centrale("Légal Faux Document");
    const d = await driverIn(org);
    const ban = await rpc(org.ownerId, "ban_driver", [d.id, "Carte VTC falsifiée", "documents", true, false]);
    expect(await svc("svc_platform_ban", [ban.report_id, sa, null])).toMatchObject({ ok: true, emails: 1 });
    const [mail] = await banEmails(d.email!);
    expect(mail.reply_to).toBeNull();
    expect(mail.body_text).toContain(`Motif${NB}: document faux ou falsifié`);
    expect(mail.body_text).not.toContain("Précisions");
    expect(mail.body_text).toContain("en écrivant à l'éditeur depuis la page Contact du site Rydar Drive");

    const noMail = await driverIn(org, { email: "pas-une-adresse" });
    await sql("update public.users set email = 'pas une adresse' where id = $1", [noMail.userId]);
    const ban2 = await rpc(org.ownerId, "ban_driver", [noMail.id, "Pièce d'identité falsifiée", "documents", true, false]);
    expect(await svc("svc_platform_ban", [ban2.report_id, sa, null])).toMatchObject({ ok: true, emails: 0 });
  });

  it("application : « ban_scope » dit qui a décidé (centrale ou éditeur)", async () => {
    const sa = await superAdmin();
    const org = await centrale("Légal Portée");
    const byOrg = await driverIn(org);
    await rpc(org.ownerId, "ban_driver", [byOrg.id, "Retards répétés", "behavior", false, false]);
    expect(await rpc(byOrg.userId, "driver_account_state")).toMatchObject({ state: "banned", ban_scope: "org", reason: "Retards répétés" });

    const byRydar = await driverIn(org);
    const ban = await rpc(org.ownerId, "ban_driver", [byRydar.id, "Usurpation d'identité", "fraud", true, false]);
    await svc("svc_platform_ban", [ban.report_id, sa, null]);
    expect(await rpc(byRydar.userId, "driver_account_state")).toMatchObject({ state: "banned", ban_scope: "platform" });

    const active = await driverIn(org);
    const state = await rpc(active.userId, "driver_account_state");
    expect(state.state).toBe("active");
    expect(state.ban_scope).toBeNull();
  });
});

// -----------------------------------------------------------------------------
describe("CGV et accord de traitement : identité de l'éditeur exigée", () => {
  const accept = (sub: string, documents: string[], org: string | null) =>
    rpc(sub, "accept_legal_documents", [documents, "2026-09-27", org, "web"]);

  it("refusés tant que la raison sociale, le siège ou l'immatriculation manquent ; CGU et politique toujours acceptables", async () => {
    const org = await createOrg("Légal Éditeur");
    await sql("update public.platform_legal set company_name = null, address = null, registration = null where id");
    const refused = await accept(org.ownerId, ["cgv", "dpa"], org.id);
    expect(refused).toMatchObject({ ok: false, code: "LEGAL_EDITOR_MISSING" });
    expect(refused.message).toBe(`Conditions momentanément indisponibles${NB}: identité de l'éditeur à compléter.`);
    expect(await sql("select 1 from public.legal_acceptances where organization_id = $1", [org.id])).toHaveLength(0);
    expect(await accept(org.ownerId, ["cgu", "privacy"], null)).toMatchObject({ ok: true, code: "ACCEPTED" });

    await sql("update public.platform_legal set company_name = 'Rydar SAS', address = '   ', registration = 'RCS Paris 000 000 000' where id");
    expect(await accept(org.ownerId, ["cgv", "dpa"], org.id)).toMatchObject({ ok: false, code: "LEGAL_EDITOR_MISSING" });
    await sql("update public.platform_legal set address = '1 rue de l''Exemple, 75001 Paris' where id");
    expect(await accept(org.ownerId, ["cgv", "dpa"], org.id)).toMatchObject({ ok: true, code: "ACCEPTED" });
  });
});

// -----------------------------------------------------------------------------
describe("Positions : vitesse jamais gardée dans l'historique", () => {
  it("dernière position avec sa vitesse (affichage « en mouvement »), historique sans vitesse", async () => {
    const org = await createOrg("Légal Vitesse");
    const d = await createDriver(org, { presence: "available" });
    await rpc(d.userId, "update_driver_location", [48.86, 2.35, 90, 13.9, 5, 0.8, null]);
    const [last] = await sql("select speed_mps from public.driver_locations where driver_id = $1", [d.id]);
    expect(Number(last.speed_mps)).toBeCloseTo(13.9, 1);
    const history = await sql("select speed_mps, heading from public.driver_location_history where driver_id = $1", [d.id]);
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((h) => h.speed_mps === null)).toBe(true);
    expect(Number(history[0].heading)).toBe(90);
  });
});

// -----------------------------------------------------------------------------
describe("E-mail de validation du réseau partagé : constat daté, sans garantie", () => {
  it("validation : correspondance avec le registre à une date, ni sélection ni garantie ; refus inchangé", async () => {
    const org = await createOrg("Légal Réseau");
    await sql(
      `insert into public.network_memberships (organization_id, approved_at, approved_legal_name, approved_siret, approved_vtc_registration)
       values ($1, now(), 'Légal Réseau SAS', '12345678901234', 'EVTC075230001')`,
      [org.id],
    );
    const [ok] = await sql("select private.network_review_email($1, true, null) as m", [org.id]);
    const body = ok.m.body as string;
    expect(body).toContain("Rydar a constaté, le ");
    expect(body).toContain("correspondent au registre des exploitants VTC consulté à cette date");
    expect(body).toContain("n'est ni une sélection ni une garantie");
    expect(body).not.toContain("a vérifié l'inscription");
    const [no] = await sql("select private.network_review_email($1, false, 'SIRET introuvable') as m", [org.id]);
    expect(no.m.body).toContain(`Motif${NB}: SIRET introuvable`);
  });
});

// -----------------------------------------------------------------------------
describe("Relances WhatsApp de Rydar au propriétaire : refus noté et respecté", () => {
  it("refus noté (super admin, journal) → relance WhatsApp refusée sans consommer la limite ; refus retiré → de nouveau possible", async () => {
    const sa = await superAdmin();
    await sql("delete from public.platform_whatsapp_secrets");
    await sql("delete from public.platform_whatsapp");
    expect((await svc("svc_whatsapp_save", [null, sa, "200000000000002", "EAAGtest-token-legal-0123456789", "+33 1 00 00 00 00", "Rydar Drive", "rappel_frais_plateforme", "fr", true])).code).toBe("SAVED");
    const org = await centrale("Légal WhatsApp");
    await sql("update public.organizations set platform_fee_fixed_cents = 500 where id = $1", [org.id]);
    await sql("update public.users set phone = '07 11 22 33 55' where id = $1", [org.ownerId]);
    await insertRideBypass(org, { completed_at: new Date() });

    // Service role seulement, auteur super admin revérifié
    await expect(as({ sub: org.ownerId }, (q) => q("select public.svc_platform_whatsapp_refusal($1, $2, true)", [org.id, org.ownerId]))).rejects.toThrow();
    expect(await svc("svc_platform_whatsapp_refusal", [org.id, sa, true, "Courriel du 4 octobre"])).toMatchObject({ ok: true, code: "REFUSED" });
    const target = (await as({ sub: sa }, (q) => q("select public.admin_platform_whatsapp($1) as r", [org.id])))[0].r;
    expect(target).toMatchObject({ ready: false, reason: "OPTED_OUT" });
    expect(target.refused_at).toBeTruthy();

    const refused = await svc("svc_platform_remind", [org.id, sa, null, true]);
    expect(refused).toMatchObject({ ok: false, code: "WHATSAPP_OPTED_OUT" });
    expect((await sql("select platform_reminded_at from public.organizations where id = $1", [org.id]))[0].platform_reminded_at).toBeNull();
    // Relance affichée dans le tableau de bord : toujours possible
    expect(await svc("svc_platform_remind", [org.id, sa, "Merci de régler", false])).toMatchObject({ ok: true, whatsapp: false });

    expect(await svc("svc_platform_whatsapp_refusal", [org.id, sa, false])).toMatchObject({ ok: true, code: "ALLOWED" });
    expect((await as({ sub: sa }, (q) => q("select public.admin_platform_whatsapp($1) as r", [org.id])))[0].r).toMatchObject({
      ready: true, reason: null, refused_at: null,
    });
    const actions = await sql(
      "select action, metadata from public.audit_logs where organization_id = $1 and action like 'platform_fee.whatsapp_%' order by id",
      [org.id],
    );
    expect(actions.map((a) => a.action)).toEqual(["platform_fee.whatsapp_refused", "platform_fee.whatsapp_allowed"]);
    expect(actions[0].metadata.note).toBe("Courriel du 4 octobre");
  });
});

// -----------------------------------------------------------------------------
describe("Coordonnées des clients : effacées 3 ans après la fin de l'année de la course", () => {
  it("téléphone, e-mail et précisions effacés ; nom, adresses et prix gardés ; course récente intacte ; une fois par jour", async () => {
    const org = await createOrg("Légal Clients");
    const year = new Date().getUTCFullYear();
    const old = await insertRideBypass(org, {
      pickup_at: new Date(Date.UTC(year - 4, 5, 1)), customer_email: "client@exemple.fr", comment: "Siège enfant", flight_number: "AF123",
    });
    const recent = await insertRideBypass(org, {
      pickup_at: new Date(Date.UTC(year - 2, 5, 1)), customer_email: "recent@exemple.fr", comment: "Pancarte",
    });
    await sql("delete from private.housekeeping_runs where task = 'customer_contacts'");
    const res = (await sql("select private.housekeeping() as r"))[0].r as Row;
    expect(res.errors).toBeUndefined();
    expect(res.customer_contacts_purged).toBeGreaterThanOrEqual(1);
    const rows = await sql(
      "select id, customer_name, customer_phone, customer_email, comment, flight_number, price_cents, pickup_address from public.rides where id = any ($1::uuid[])",
      [[old, recent]],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[old]).toMatchObject({
      customer_name: "Client Historique", customer_phone: "effacé", customer_email: null, comment: null, flight_number: "AF123", price_cents: 5000,
    });
    expect(byId[old].pickup_address).toContain("Opéra");
    expect(byId[recent]).toMatchObject({ customer_phone: "+33600000001", customer_email: "recent@exemple.fr", comment: "Pancarte" });
    // Passage suivant le même jour : rien n'est relu
    expect(((await sql("select private.housekeeping() as r"))[0].r as Row).customer_contacts_purged).toBeNull();
  });
});

// -----------------------------------------------------------------------------
describe("Mini-site : accusé de réception de la réservation", () => {
  async function bookingOrg() {
    await setBookingSitesEnabled(true);
    const org = await createOrg("Légal Mini-site");
    await sql("update public.organizations set legal_name = 'Légal Mini-site SAS' where id = $1", [org.id]);
    await sql(
      "update public.booking_sites set enabled = true, phone = '01 23 45 67 89', email = 'resa@legal-minisite.fr' where organization_id = $1",
      [org.id],
    );
    return org;
  }

  it("contenu fixe tiré de la base (jamais l'adresse saisie), une fois par réservation, 3 par adresse et par 24 h", async () => {
    const org = await bookingOrg();
    const to = `client-${randomUUID().slice(0, 6)}@exemple.fr`;
    const ride = await insertRideBypass(org, {
      status: "SEARCHING_DRIVER", source: "booking_site", customer_email: to, pickup_address: "Cliquez sur http://spam.example",
      pickup_at: new Date(Date.UTC(2030, 0, 5, 7, 30)), price_cents: 4250, passengers: 2,
    });
    expect(await svc("svc_booking_receipt", [ride])).toMatchObject({ ok: true, code: "QUEUED" });
    expect(await svc("svc_booking_receipt", [ride])).toMatchObject({ ok: true, code: "ALREADY_QUEUED" });
    const [mail] = await sql("select * from public.email_outbox where kind = 'booking_receipt' and ride_id = $1", [ride]);
    expect(mail).toMatchObject({ to_email: to, reply_to: "resa@legal-minisite.fr", organization_id: org.id });
    expect(mail.subject).toMatch(/^Votre réservation n° \d+ auprès de Légal Mini-site SAS$/);
    const body = mail.body_text as string;
    expect(body).toContain("Légal Mini-site SAS a bien reçu votre réservation n° ");
    expect(body).toContain(`Prise en charge${NB}: le 5 janvier 2030 à 08:30 (heure locale du départ).`);
    expect(body).toContain(`Véhicule${NB}: Business, 2 passagers.`);
    expect(body).toContain(`Prix${NB}: 42,50 € TTC, payable à Légal Mini-site SAS selon ses conditions.`);
    expect(body).toContain("01 23 45 67 89, resa@legal-minisite.fr");
    expect(body).toContain("qui n'est pas partie au contrat de transport");
    expect(body).not.toContain("spam");

    for (let i = 0; i < 2; i++) {
      const again = await insertRideBypass(org, { status: "SEARCHING_DRIVER", source: "booking_site", customer_email: to, price_cents: null });
      expect(await svc("svc_booking_receipt", [again])).toMatchObject({ ok: true, code: "QUEUED" });
    }
    const fourth = await insertRideBypass(org, { status: "SEARCHING_DRIVER", source: "booking_site", customer_email: to });
    expect(await svc("svc_booking_receipt", [fourth])).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    const unpriced = await sql("select body_text from public.email_outbox where kind = 'booking_receipt' and to_email = $1 and body_text like '%confirme avant la course%'", [to]);
    expect(unpriced.length).toBeGreaterThan(0);
  });

  it("seulement pour une réservation du mini-site, avec une adresse valide ; service role seulement", async () => {
    const org = await bookingOrg();
    const dashboard = await insertRideBypass(org, { status: "SEARCHING_DRIVER", customer_email: "client@exemple.fr" });
    expect(await svc("svc_booking_receipt", [dashboard])).toMatchObject({ ok: false, code: "NOT_FOUND" });
    const noEmail = await insertRideBypass(org, { status: "SEARCHING_DRIVER", source: "booking_site" });
    expect(await svc("svc_booking_receipt", [noEmail])).toMatchObject({ ok: false, code: "NO_EMAIL" });
    await expect(as({ sub: org.ownerId }, (q) => q("select public.svc_booking_receipt($1)", [noEmail]))).rejects.toThrow();
  });
});
