// Audit « bannissement » (20260924004600) : normalisation du téléphone + rattrapage des empreintes, appareil
// partagé au bannissement, signalement plateforme fabriqué par une centrale, comptes de gestion, levée.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { normalizePhone } from "../../packages/shared/src/format";
import { as, createAuthUser, createOrg, expectPgError, pool, sql, type Org } from "./helpers";

afterAll(async () => {
  await pool.end();
});

type D = { id: string; userId: string; phone: string; email: string; vehicleId: string };

/** Numéro unique « 06XXXXXXXX » (les bannissements portent sur l'identité : jamais de valeur partagée entre tests). */
const uniquePhone = () => `06${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
const uniquePlate = () => `${randomUUID().slice(0, 2)}-${randomUUID().slice(0, 3)}-${randomUUID().slice(0, 2)}`.toUpperCase();
/** « 0633333333 » → « +33 (0)6 33 33 33 33 ». */
const withTrunk = (digits: string) => `+33 (0)${digits.slice(1, 2)} ${digits.slice(2).replace(/(\d{2})(?=\d)/g, "$1 ")}`;
/** Empreinte calculée avec l'ANCIENNE règle (avant 004600) pour un numéro « +330… ». */
const legacyHash = (normalized: string) => createHash("sha256").update(`rydar:phone:${normalized}`).digest("hex");

async function centrale(name: string, orgFields: Record<string, unknown> = {}) {
  const org = await createOrg(name);
  const fields = { dispatch_model: "centrale", ...orgFields };
  const keys = Object.keys(fields);
  await sql(`update public.organizations set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1`, [org.id, ...Object.values(fields)]);
  return org;
}

async function driverIn(
  org: Org,
  opts: { phone?: string; email?: string; vtc?: string; userId?: string; status?: string; application?: string } = {},
): Promise<D> {
  const phone = opts.phone ?? uniquePhone();
  const email = opts.email ?? `ban-${randomUUID().slice(0, 8)}@test.dev`;
  const userId = opts.userId ?? (await createAuthUser(email, "Chauffeur Ban"));
  const [v] = await sql(
    `insert into public.vehicles (organization_id, model, plate, category, seats) values ($1, 'Classe E', $2, 'business', 4) returning id`,
    [org.id, uniquePlate()],
  );
  const [d] = await sql(
    `insert into public.drivers (organization_id, user_id, first_name, last_name, phone, email, vtc_card_number, status, presence, vehicle_id, application_status)
     values ($1, $2, 'Karim', 'Test', $3, $4, $5, $6, 'offline', $7, $8) returning id`,
    [org.id, userId, phone, email, opts.vtc ?? null, opts.status ?? "active", v.id, opts.application ?? null],
  );
  return { id: d.id, userId, phone, email, vehicleId: v.id };
}

const rpc = async (sub: string, fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ sub }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Record<string, any>;
};
const svc = async (fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ role: "service_role" }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Record<string, any>;
};
const banScope = async (orgId: string, kind: string, value: string) =>
  (await sql(`select private.identity_ban_scope($1, $2, $3) as s`, [orgId, kind, value]))[0].s as string | null;
const fiche = async (id: string) =>
  (await sql(`select status, banned_at, ban_scope, ban_reason, ban_report_id, suspended_reason, application_status from public.drivers where id = $1`, [id]))[0];

async function superAdmin() {
  const sa = await createAuthUser(`super-${randomUUID().slice(0, 6)}@rydar.dev`, "Super Admin");
  await sql(`update public.users set is_super_admin = true where id = $1`, [sa]);
  return sa;
}

// -----------------------------------------------------------------------------
describe("Téléphone : même numéro, autre écriture (sql-rpc-argent#2, flux-comptes#4)", () => {
  it("empreinte SQL = normalizePhone (JS) pour les écritures courantes", async () => {
    const inputs = [
      "06 33 33 33 33", "+33 (0)6 33 33 33 33", "+33 06 33 33 33 33", "+33 0 6 33 33 33 33", "0033 (0)6 33 33 33 33",
      "0033 06 33 33 33 33", "+33.6.33.33.33.33", "33 6 33 33 33 33", "+262 (0)692 12 34 56", "+590 0690 12 34 56",
      "+44 (0)20 7946 0958", "+39 06 1234 5678",
    ];
    const rows = await sql(`select v, private.identity_normalize('phone', v) as n from unnest($1::text[]) v`, [inputs]);
    for (const r of rows) expect(r.n, r.v).toBe(normalizePhone(r.v));
    expect(rows.slice(0, 8).every((r) => r.n === "+33633333333")).toBe(true);
  });

  it("banni puis réinscription par lien avec « +33 (0)6… » : refusée (centrale puis plateforme)", async () => {
    const org = await centrale("Ban Téléphone", { join_enabled: true, join_auto_approve: true });
    const other = await centrale("Ban Téléphone Ailleurs");
    const digits = uniquePhone();
    const sami = await driverIn(org, { phone: digits.replace(/(\d{2})(?=\d)/g, "$1 ") });
    const ban = await rpc(org.ownerId, "ban_driver", [sami.id, "Commissions jamais réglées", "unpaid", true, false]);
    expect(ban).toMatchObject({ ok: true, code: "BANNED" });

    const plate = uniquePlate();
    for (const phone of [withTrunk(digits), `+330${digits.slice(1)}`, `0033 0${digits.slice(1)}`]) {
      expect(await svc("svc_identity_check", [org.id, phone, `nouveau-${randomUUID().slice(0, 6)}@test.dev`, null, plate]), phone)
        .toEqual({ banned: true, duplicate: "phone" });
    }
    const u = await createAuthUser(`retour-${randomUUID().slice(0, 6)}@test.dev`, "Retour");
    const applied = await svc("svc_driver_apply", [org.id, u, "Sami", "Fraudeur", withTrunk(digits), `retour-${randomUUID().slice(0, 4)}@test.dev`, null, JSON.stringify({ model: "Clio", plate }), null]);
    expect(applied).toMatchObject({ ok: false });
    expect(await sql(`select id from public.drivers where user_id = $1`, [u])).toHaveLength(0);
    // Création directe par une centrale : garde-fou en base
    expect((await expectPgError(driverIn(org, { phone: `+33 0${digits.slice(1)}` }))).message).toMatch(/IDENTITY_BANNED/);

    // Plateforme : même règle partout
    const sa = await superAdmin();
    expect((await svc("svc_platform_ban", [ban.report_id, sa, "Confirmé"])).code).toBe("PLATFORM_BANNED");
    expect(await banScope(other.id, "phone", withTrunk(digits))).toBe("platform");
  });

  it("rattrapage : empreintes à l'ancienne recalculées (bannissement, signalement), contournements signalés, idempotent", async () => {
    const org = await centrale("Ban Rattrapage");
    const digits = uniquePhone();
    const stored = `+330${digits.slice(1)}`; // écriture stockée par l'ancien normalizePhone pour « +33 (0)6… »
    const canonical = `+33${digits.slice(1)}`;
    const x = await driverIn(org, { phone: stored });
    // Même numéro écrit autrement (« 06… », « +33 (0)6… ») sur des fiches de la centrale : l'ancienne empreinte ne les
    // reconnaissait pas (enregistrées ici avant le bannissement : depuis 20260924005400, la recherche reconnaît aussi
    // l'ancienne empreinte et refuserait ces fiches après lui)
    const z = await driverIn(org, { phone: digits });
    const w = await driverIn(org, { phone: withTrunk(digits) });
    const other = await driverIn(org);
    const ban = await rpc(org.ownerId, "ban_driver", [x.id, "Faux paiements répétés", "fraud", true, false]);
    expect(ban.code).toBe("BANNED");

    // État d'avant la migration : empreinte du téléphone calculée avec l'ancienne règle (« +330… » tel quel)
    const oldHash = legacyHash(stored);
    const [{ new_hash: newHash }] = await sql(`select private.identity_hash('phone', $1) as new_hash`, [stored]);
    expect(newHash).not.toBe(oldHash);
    await sql(`update public.banned_identities set value_hash = $2 where driver_id = $1 and kind = 'phone'`, [x.id, oldHash]);
    await sql(
      `update public.fraud_reports set identities = (
         select jsonb_agg(case when e ->> 'kind' = 'phone' then e || jsonb_build_object('hash', $2::text) else e end)
         from jsonb_array_elements(identities) e) where id = $1`,
      [ban.report_id, oldHash],
    );
    // Ancienne empreinte reconnue par la recherche (20260924005400) même avant le rattrapage
    expect(await banScope(org.id, "phone", digits)).toBe("org");

    const res = (await sql(`select private.rehash_phone_identities() as r`))[0].r;
    expect(res.bans).toBeGreaterThanOrEqual(1);
    expect(res.reports).toBeGreaterThanOrEqual(1);
    expect(res.flagged).toBeGreaterThanOrEqual(2);

    // Bannissement : nouvelle forme, en place (levée et historique inchangés)
    const rows = await sql(`select value_hash, lifted_at from public.banned_identities where driver_id = $1 and kind = 'phone'`, [x.id]);
    expect(rows).toEqual([{ value_hash: newHash, lifted_at: null }]);
    for (const phone of [digits, canonical, withTrunk(digits), stored]) expect(await banScope(org.id, "phone", phone), phone).toBe("org");
    const [report] = await sql(`select identities from public.fraud_reports where id = $1`, [ban.report_id]);
    expect(report.identities.find((e: { kind: string }) => e.kind === "phone").hash).toBe(newHash);

    // Fiches qui contournaient : suspendues « vérification requise », journal ; les autres intactes
    for (const d of [z, w]) {
      expect(await fiche(d.id)).toMatchObject({ status: "suspended", banned_at: null, suspended_reason: "Téléphone déjà utilisé par un compte banni — vérification requise" });
      const [audit] = await sql(`select severity, metadata from public.audit_logs where action = 'driver.banned_identity' and entity_id = $1`, [d.id]);
      expect(audit).toMatchObject({ severity: "critical", metadata: { kind: "phone", scope: "org", suspended: true } });
    }
    expect((await fiche(other.id)).status).toBe("active");
    expect((await fiche(x.id)).ban_scope).toBe("org");

    // Rejouable sans effet
    expect((await sql(`select private.rehash_phone_identities() as r`))[0].r).toEqual({ bans: 0, reports: 0, flagged: 0 });
    // La levée par la centrale emporte l'empreinte recalculée
    expect((await rpc(org.ownerId, "lift_driver_ban", [x.id, "Dette réglée"])).code).toBe("LIFTED");
    expect(await banScope(org.id, "phone", digits)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
describe("Appareil partagé au moment du bannissement (flux-comptes#10)", () => {
  it("les autres fiches de la centrale déjà enregistrées sur l'appareil du banni sont signalées", async () => {
    const org = await centrale("Ban Appareil");
    const elsewhere = await centrale("Ban Appareil Ailleurs");
    const install = `and-fraudphone-${randomUUID().slice(0, 8)}`;
    const f1 = await driverIn(org);
    const f2 = await driverIn(org);
    const applicant = await driverIn(org, { status: "inactive", application: "pending" });
    const onlyOther = await driverIn(org);
    const outside = await driverIn(elsewhere);
    for (const d of [f1, f2, applicant, outside]) await rpc(d.userId, "driver_register_device", [install, "android"]);
    await rpc(onlyOther.userId, "driver_register_device", [`and-autre-${randomUUID().slice(0, 8)}`, "android"]);

    const ban = await rpc(org.ownerId, "ban_driver", [f1.id, "Arnaque au client", "fraud", false, false]);
    expect(ban).toMatchObject({ ok: true, code: "BANNED", flagged_drivers: 2 });
    expect(ban.message).toMatch(/2 autres fiches de votre centrale utilisent le même appareil/);
    expect(ban.message).not.toMatch(/même avec un nouveau compte/);

    expect(await fiche(f2.id)).toMatchObject({ status: "suspended", banned_at: null, suspended_reason: "Appareil déjà utilisé par un compte banni — vérification requise" });
    expect(await fiche(applicant.id)).toMatchObject({ status: "inactive", application_status: "rejected" });
    const [audit] = await sql(`select severity, metadata from public.audit_logs where action = 'driver.banned_device' and entity_id = $1`, [f2.id]);
    expect(audit).toMatchObject({ severity: "critical", metadata: { scope: "org", suspended: true, banned_driver_id: f1.id } });
    const [alert] = await sql(`select payload from realtime.messages where event = 'driver.flagged' and topic = $1 and payload ->> 'driver_id' = $2`, [`org:${org.id}`, f2.id]);
    expect(alert.payload.reason).toBe("banned_device");
    // Autre appareil, autre centrale : intacts
    expect((await fiche(onlyOther.id)).status).toBe("active");
    expect((await fiche(outside.id)).status).toBe("active");
  });
});

// -----------------------------------------------------------------------------
describe("Signalement plateforme fabriqué par une centrale (flux-comptes#11, sql-rpc-argent#4, actions-admin#1)", () => {
  it("identités recopiées datées, aperçu super admin, fiche d'une autre centrale touchée seulement si confirmée", async () => {
    const orgA = await centrale("Ban Tricheuse A");
    const orgB = await centrale("Ban Concurrente B");
    const orgC = await centrale("Ban Neutre C");
    const leoVtc = `EVTC 075 ${Math.floor(Math.random() * 1e6)}`;
    const leo = await driverIn(orgB, { vtc: leoVtc });
    const pion = await driverIn(orgA);
    const pionDevice = `ios-pion-${randomUUID().slice(0, 8)}`;
    const pion2 = await driverIn(orgA);
    await rpc(pion.userId, "driver_register_device", [pionDevice, "ios"]);
    await rpc(pion2.userId, "driver_register_device", [pionDevice, "ios"]);

    // L'owner de A recopie le téléphone et la carte VTC (justificatif) du chauffeur de B sur sa propre fiche
    await as({ sub: orgA.ownerId }, (q) => q(`update public.drivers set phone = $1 where id = $2`, [leo.phone.replace(/^0/, "+33 "), pion.id]));
    await as({ sub: orgA.ownerId }, (q) =>
      q(`insert into public.driver_documents (organization_id, driver_id, type, label, number, status, expires_at) values ($1, $2, 'vtc_card', 'Carte VTC', $3, 'valid', current_date + 365)`, [
        orgA.id, pion.id, leoVtc.replace(/ /g, "-"),
      ]),
    );
    // Numéro de pièce journalisé (auteur, empreinte), jamais en clair
    const [docAudit] = await sql(`select actor_user_id, metadata from public.audit_logs where action = 'driver_documents.number_set' and entity_type = 'drivers' and entity_id = $1`, [pion.id]);
    expect(docAudit.actor_user_id).toBe(orgA.ownerId);
    expect(docAudit.metadata).toMatchObject({ kind: "vtc_card", type: "vtc_card" });
    expect(docAudit.metadata.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(docAudit.metadata)).not.toContain(leoVtc.slice(-6));

    const ban = await rpc(orgA.ownerId, "ban_driver", [pion.id, "Fraude aux paiements, faux justificatifs", "fraud", true, false]);
    expect(ban.code).toBe("BANNED");
    const reportId = ban.report_id as string;
    const [report] = await sql(`select identities from public.fraud_reports where id = $1`, [reportId]);
    const byKind = (k: string) => (report.identities as { kind: string; edited_by_org_at?: string }[]).filter((e) => e.kind === k);
    expect(byKind("phone")[0].edited_by_org_at).toBeTruthy();
    expect(byKind("vtc_card")[0].edited_by_org_at).toBeTruthy();
    // E-mail et appareil : jamais saisis par la centrale
    expect(byKind("email").every((e) => !e.edited_by_org_at)).toBe(true);
    expect(byKind("device").every((e) => !e.edited_by_org_at)).toBe(true);

    // Aperçu : super admin seulement ; la fiche de B apparaît AVANT la décision
    const sa = await superAdmin();
    expect((await expectPgError(rpc(orgA.ownerId, "admin_fraud_report_matches", [reportId]))).code).toBe("42501");
    expect((await expectPgError(as({ role: "anon" }, (q) => q(`select public.admin_fraud_report_matches($1)`, [reportId])))).code).toBe("42501");
    const preview = await rpc(sa, "admin_fraud_report_matches", [reportId]);
    expect(preview.ok).toBe(true);
    const leoMatch = preview.matches.find((m: { driver_id: string }) => m.driver_id === leo.id);
    expect(leoMatch).toMatchObject({ same_org: false, organization_name: "Ban Concurrente B", kinds: ["phone", "vtc_card"], banned: false, manages_org: false });
    expect(preview.matches.find((m: { driver_id: string }) => m.driver_id === pion2.id)).toMatchObject({ same_org: true, kinds: ["device"] });
    expect(preview.identities.find((i: { kind: string }) => i.kind === "phone").edited_by_org_at).toBeTruthy();

    // Décision sans confirmation : Leo intact, identités partagées non bannies ailleurs, le reste banni partout
    const platform = await svc("svc_platform_ban", [reportId, sa, "Preuves vérifiées"]);
    expect(platform).toMatchObject({ ok: true, code: "PLATFORM_BANNED", drivers: 2, extended: 0, skipped_drivers: 1, identities_skipped: 2 });
    expect(platform.user_ids).toEqual(expect.arrayContaining([pion.userId, pion2.userId]));
    expect(platform.user_ids).not.toContain(leo.userId);
    expect(await fiche(leo.id)).toMatchObject({ status: "active", banned_at: null, ban_scope: null });
    expect(await fiche(pion2.id)).toMatchObject({ ban_scope: "platform" });
    expect(await banScope(orgC.id, "phone", leo.phone)).toBeNull();
    expect(await banScope(orgC.id, "vtc_card", leoVtc)).toBeNull();
    expect(await banScope(orgC.id, "email", pion.email)).toBe("platform");
    expect(await banScope(orgA.id, "phone", leo.phone)).toBe("org");

    // Levée puis nouvelle décision AVEC confirmation de la fiche de B (un id étranger au signalement est ignoré)
    expect((await svc("svc_platform_unban", [reportId, sa, "Revue"])).code).toBe("LIFTED");
    const stranger = await driverIn(orgC);
    const again = await svc("svc_platform_ban", [reportId, sa, "Confirmé", [leo.id, stranger.id]]);
    expect(again).toMatchObject({ ok: true, drivers: 3, extended: 1, skipped_drivers: 0, identities_skipped: 0 });
    expect(await fiche(leo.id)).toMatchObject({ status: "suspended", ban_scope: "platform", ban_report_id: reportId });
    expect((await fiche(stranger.id)).status).toBe("active");
    expect(await banScope(orgC.id, "phone", leo.phone)).toBe("platform");
    const [extended] = await sql(`select metadata from public.audit_logs where action = 'driver.platform_banned' and entity_id = $1 order by created_at desc limit 1`, [leo.id]);
    expect(extended.metadata).toMatchObject({ report_id: reportId, extended: true });
  });

  it("compte qui gère une centrale : fiche bannie, connexion (Auth) conservée", async () => {
    const orgA = await centrale("Ban Gérant A");
    const orgB = await centrale("Ban Gérant B");
    // Le propriétaire de B conduit aussi : sa fiche chauffeur est liée à son compte de gestion
    const boss = await driverIn(orgB, { userId: orgB.ownerId });
    const fake = await driverIn(orgA, { phone: boss.phone });
    const ban = await rpc(orgA.ownerId, "ban_driver", [fake.id, "Faux profil", "fraud", true, false]);
    const sa = await superAdmin();
    const preview = await rpc(sa, "admin_fraud_report_matches", [ban.report_id]);
    expect(preview.matches.find((m: { driver_id: string }) => m.driver_id === boss.id)).toMatchObject({ manages_org: true, same_org: false });

    const res = await svc("svc_platform_ban", [ban.report_id, sa, null, [boss.id]]);
    expect(res).toMatchObject({ ok: true, drivers: 2, extended: 1 });
    expect(res.user_ids).toEqual([fake.userId]);
    expect(res.kept_user_ids).toEqual([orgB.ownerId]);
    expect(await fiche(boss.id)).toMatchObject({ status: "suspended", ban_scope: "platform" });
    const [audit] = await sql(`select metadata from public.audit_logs where action = 'driver.platform_banned' and entity_id = $1`, [boss.id]);
    expect(audit.metadata.login_kept).toBe(true);
  });
});

// -----------------------------------------------------------------------------
describe("Levée d'un bannissement plateforme (actions-admin#3, sql-rpc-argent#7)", () => {
  it("le bannissement posé par une autre centrale sur SON chauffeur lui est rendu (motif, compte verrouillé)", async () => {
    const orgA = await centrale("Ban Levée A");
    const orgC = await centrale("Ban Levée C");
    const amine = await driverIn(orgC);
    expect((await rpc(orgC.ownerId, "ban_driver", [amine.id, "Vol de la recette", "fraud", false, false])).code).toBe("BANNED");
    const twin = await driverIn(orgA, { phone: amine.phone });
    const ban = await rpc(orgA.ownerId, "ban_driver", [twin.id, "Faux paiements", "fraud", true, false]);
    const sa = await superAdmin();
    expect(await svc("svc_platform_ban", [ban.report_id, sa, null, [amine.id]])).toMatchObject({ ok: true, drivers: 2, extended: 1 });
    expect(await fiche(amine.id)).toMatchObject({ ban_scope: "platform", ban_reason: "Vol de la recette" });

    const lift = await svc("svc_platform_unban", [ban.report_id, sa, "Erreur d'identité"]);
    expect(lift.code).toBe("LIFTED");
    expect(lift.user_ids).toEqual([]);
    const after = await fiche(amine.id);
    expect(after).toMatchObject({ status: "suspended", ban_scope: "org", ban_reason: "Vol de la recette", ban_report_id: null, suspended_reason: "Banni : Vol de la recette" });
    expect(after.banned_at).not.toBeNull();
    // La centrale C garde la main : réactivation refusée, levée possible
    const react = await expectPgError(rpc(orgC.ownerId, "set_driver_status", [amine.id, "active", null]));
    expect(react.message).toMatch(/DRIVER_BANNED/);
    expect((await rpc(orgC.ownerId, "lift_driver_ban", [amine.id, "Dette réglée"])).code).toBe("LIFTED");
    // Le chauffeur signalé reste banni par sa centrale
    expect(await fiche(twin.id)).toMatchObject({ ban_scope: "org" });
  });
});
