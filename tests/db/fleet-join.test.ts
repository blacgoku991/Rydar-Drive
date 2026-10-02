import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { as, createAuthUser, createDriver, createMember, createOrg, expectPgError, insertRideBypass, pool, sql, type Org } from "./helpers";

// Lien d'inscription des chauffeurs pour les FLOTTES (migration 20260924006300) : même parcours et mêmes contrôles que
// pour une centrale (rôles, jeton émis après l'activation de l'adhésion, identités bannies, empreintes d'un débiteur,
// limite de chauffeurs de l'offre, compte déjà rattaché) ; fiche « nouveau » (sans effet en flotte), validée par un
// administrateur = « confirmé », validation automatique = reste « nouveau » ; changement de modèle sans coupure.

afterAll(async () => {
  await pool.end();
});

type Row = Record<string, any>;

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
/** Comme `as`, avec des claims JWT complets (iat). */
async function asClaims<T>(claims: Record<string, unknown>, fn: (q: (t: string, p?: unknown[]) => Promise<Row[]>) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", ...claims })]);
    await client.query("set local role authenticated");
    const result = await fn(async (text, params = []) => (await client.query(text, params)).rows);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const uniquePhone = () => `06${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
const uniquePlate = () => `FJ-${String(Math.floor(Math.random() * 900) + 100)}-${randomUUID().slice(0, 2).toUpperCase()}`;
const uniqueVtc = () => `EVTC${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

type Identity = { phone?: string; email?: string; vtc?: string | null; first?: string };

/** Candidature telle que la route serveur la crée (compte Auth puis svc_driver_apply). */
async function apply(org: Org, id: Identity = {}) {
  const email = id.email ?? `candidat-${randomUUID().slice(0, 8)}@test.dev`;
  const userId = await createAuthUser(`${randomUUID().slice(0, 6)}-${email}`, "Candidat Flotte");
  const res = await svc("svc_driver_apply", [org.id, userId, id.first ?? "Samir", "Candidat", id.phone ?? uniquePhone(), email,
    id.vtc === undefined ? uniqueVtc() : id.vtc, JSON.stringify({ brand: "Toyota", model: "Corolla", plate: uniquePlate(), category: "standard" }),
    "Disponible le week-end"]);
  return { ...res, userId };
}

const driverRow = async (id: string) =>
  (await sql(`select status, application_status, trust_level, joined_via from public.drivers where id = $1`, [id]))[0];

/** Flotte (modèle par défaut) avec son lien d'inscription. */
async function fleetWithLink(name: string, autoApprove = false) {
  const org = await createOrg(name);
  const link = await rpc(org.ownerId, "set_join_link", [org.id, true, false, autoApprove]);
  return { org, link };
}

// -----------------------------------------------------------------------------
describe("Flotte : lien d'inscription et candidatures", () => {
  it("owner / admin seulement ; lien actif, coupé, régénéré ; page publique avec le modèle", async () => {
    const org = await createOrg("Flotte Lien");
    const dispatcher = await createMember(org, "dispatcher");
    const admin = await createMember(org, "admin");
    expect((await expectPgError(rpc(dispatcher, "set_join_link", [org.id, true, false, null]))).code).toBe("42501");
    // Autre organisation : refus
    const other = await createOrg("Flotte Voisine");
    expect((await expectPgError(rpc(other.ownerId, "set_join_link", [org.id, true, false, null]))).code).toBe("42501");

    const link = await rpc(admin, "set_join_link", [org.id, true, false, null]);
    expect(link).toMatchObject({ ok: true, code: "UPDATED", join_enabled: true, join_auto_approve: false, dispatch_model: "fleet" });
    expect(link.join_code).toMatch(/^[0-9a-f]{16}$/);
    const [audit] = await sql(`select metadata from public.audit_logs where action = 'organization.join_link' and organization_id = $1`, [org.id]);
    expect(audit.metadata).toMatchObject({ enabled: true, dispatch_model: "fleet" });

    const info = await svc("svc_join_info", [link.join_code.toUpperCase()]);
    expect(info).toMatchObject({ ok: true, auto_approve: false, dispatch_model: "fleet", organization: { id: org.id, name: "Flotte Lien" } });
    expect((await expectPgError(rpc(org.ownerId, "svc_join_info", [link.join_code]))).code).toBe("42501");

    // Coupé : page invalide, candidature refusée
    expect((await rpc(org.ownerId, "set_join_link", [org.id, false, false, null])).join_enabled).toBe(false);
    expect((await svc("svc_join_info", [link.join_code])).code).toBe("JOIN_LINK_INVALID");
    expect((await apply(org)).code).toBe("JOIN_DISABLED");

    // Régénéré : l'ancien code ne fonctionne plus
    const fresh = await rpc(org.ownerId, "set_join_link", [org.id, true, true, null]);
    expect(fresh.join_code).not.toBe(link.join_code);
    expect((await svc("svc_join_info", [link.join_code])).code).toBe("JOIN_LINK_INVALID");
    expect((await svc("svc_join_info", [fresh.join_code])).ok).toBe(true);

    // Flotte suspendue : lien inactif
    await sql(`update public.organizations set status = 'suspended' where id = $1`, [org.id]);
    expect((await svc("svc_join_info", [fresh.join_code])).code).toBe("JOIN_LINK_INVALID");
    expect((await apply(org)).code).toBe("JOIN_DISABLED");
    await sql(`update public.organizations set status = 'active' where id = $1`, [org.id]);
  });

  it("candidature en attente → validée « confirmée » comme un chauffeur créé par la flotte ; refus puis reconsidération", async () => {
    const { org } = await fleetWithLink("Flotte Candidatures");
    const dispatcher = await createMember(org, "dispatcher");

    const applied = await apply(org);
    expect(applied.code).toBe("PENDING");
    // Réponse au candidat : mêmes clés qu'en centrale
    expect(Object.keys(applied).filter((k) => k !== "userId").sort()).toEqual(["code", "driver_id", "number", "ok", "organization"]);
    expect(await driverRow(applied.driver_id)).toEqual({ status: "inactive", application_status: "pending", trust_level: "new", joined_via: "join_link" });
    const [event] = await sql(`select message from public.ride_events where type = 'driver.applied' and data ->> 'driver_id' = $1`, [applied.driver_id]);
    expect(event.message).toContain("demande à rejoindre la flotte");
    const [realtime] = await sql(`select payload from realtime.messages where event = 'driver.application' and topic = $1 order by id desc limit 1`, [`org:${org.id}`]);
    expect(realtime.payload).toMatchObject({ action: "applied", driver: { id: applied.driver_id } });

    // Candidat : écran d'attente + documents, pas de courses
    expect((await rpc(applied.userId, "driver_account_state")).state).toBe("pending");
    expect((await rpc(applied.userId, "driver_documents")).missing_types).toContain("vtc_card");
    expect((await expectPgError(rpc(applied.userId, "driver_home"))).code).toBe("42501");

    // Compte déjà rattaché à une fiche chauffeur : jamais une seconde fiche
    const again = await svc("svc_driver_apply", [org.id, applied.userId, "Bis", "Bis", uniquePhone(), `bis-${randomUUID().slice(0, 6)}@test.dev`, null,
      JSON.stringify({ model: "Zoé", plate: uniquePlate() }), null]);
    expect(again).toMatchObject({ code: "ALREADY_REGISTERED", message: "Ce compte est déjà rattaché à une centrale ou à une flotte." });
    // Messages de la flotte : jamais « cette centrale »
    const [{ phone: takenPhone }] = await sql(`select phone from public.drivers where id = $1`, [applied.driver_id]);
    const dupPhone = await apply(org, { phone: takenPhone });
    expect(dupPhone).toMatchObject({ ok: false, code: "PHONE_TAKEN", message: "Ce numéro est déjà inscrit dans cette flotte." });
    const driverOfFleet = await createDriver(org);
    expect((await svc("svc_driver_apply", [org.id, driverOfFleet.userId, "Ter", "Ter", uniquePhone(), `ter-${randomUUID().slice(0, 6)}@test.dev`, null,
      JSON.stringify({ model: "Zoé", plate: uniquePlate() }), null])).code).toBe("ALREADY_REGISTERED");

    // Validation : owner / admin seulement ; niveau « confirmé » même si « nouveau » est demandé
    expect((await expectPgError(rpc(dispatcher, "approve_driver_application", [applied.driver_id, null]))).code).toBe("42501");
    expect((await rpc(org.ownerId, "approve_driver_application", [applied.driver_id, "nimporte"])).code).toBe("INVALID_TRUST");
    expect((await rpc(org.ownerId, "approve_driver_application", [applied.driver_id, "new"])).code).toBe("APPROVED");
    expect(await driverRow(applied.driver_id)).toEqual({ status: "active", application_status: "approved", trust_level: "trusted", joined_via: "join_link" });
    expect((await rpc(applied.userId, "driver_account_state")).state).toBe("active");
    expect((await rpc(applied.userId, "driver_home")).driver.trust_level).toBe("trusted");
    const [welcome] = await sql(`select body from public.notifications where driver_id = $1 and type = 'application_approved'`, [applied.driver_id]);
    expect(welcome.body).toContain("Bienvenue chez Flotte Candidatures");
    expect((await rpc(org.ownerId, "approve_driver_application", [applied.driver_id, null])).code).toBe("NOT_PENDING");

    // Refus (motif transmis), puis reconsidération
    const second = await apply(org, { first: "Karim" });
    expect((await expectPgError(rpc(dispatcher, "reject_driver_application", [second.driver_id, "Non"]))).code).toBe("42501");
    expect((await rpc(org.ownerId, "reject_driver_application", [second.driver_id, "Zone non couverte"])).code).toBe("REJECTED");
    expect(await rpc(second.userId, "driver_account_state")).toMatchObject({ state: "rejected", reason: "Zone non couverte" });
    expect((await rpc(org.ownerId, "approve_driver_application", [second.driver_id, null])).code).toBe("APPROVED");
    expect((await driverRow(second.driver_id)).trust_level).toBe("trusted");

    // Une autre organisation ne touche pas aux candidatures de la flotte
    const third = await apply(org, { first: "Nadia" });
    const stranger = await createOrg("Flotte Etrangere");
    expect((await expectPgError(rpc(stranger.ownerId, "approve_driver_application", [third.driver_id, null]))).code).toBe("42501");
    expect((await expectPgError(rpc(stranger.ownerId, "reject_driver_application", [third.driver_id, null]))).code).toBe("42501");
  });

  it("validation automatique (reste « nouveau » : personne ne l'a vérifié) ; limite de chauffeurs → en attente, validation manuelle refusée", async () => {
    const { org } = await fleetWithLink("Flotte Auto", true);
    const ok = await apply(org);
    expect(ok.code).toBe("APPROVED");
    expect(await driverRow(ok.driver_id)).toEqual({ status: "active", application_status: "approved", trust_level: "new", joined_via: "join_link" });
    const [event] = await sql(`select message from public.ride_events where type = 'driver.applied' and data ->> 'driver_id' = $1`, [ok.driver_id]);
    expect(event.message).toContain("a rejoint la flotte");
    expect((await rpc(ok.userId, "driver_account_state")).state).toBe("active");

    // Offre limitée à 1 chauffeur (déjà atteinte) : la validation automatique échoue sans erreur → en attente
    await sql(`update public.organizations set plan_id = null, limits_override = '{"max_drivers":1}' where id = $1`, [org.id]);
    const capped = await apply(org);
    expect(capped.code).toBe("PENDING");
    expect(await driverRow(capped.driver_id)).toMatchObject({ status: "inactive", application_status: "pending" });
    const err = await expectPgError(rpc(org.ownerId, "approve_driver_application", [capped.driver_id, null]));
    expect(err.message).toMatch(/PLAN_LIMIT_DRIVERS/);
    expect(await driverRow(capped.driver_id)).toMatchObject({ status: "inactive", application_status: "pending" });
  });
});

// -----------------------------------------------------------------------------
describe("Flotte : bannissements et empreintes d'un débiteur", () => {
  it("identité bannie par la flotte ou par la plateforme : refus neutre, aucune fiche créée ; autre flotte non concernée", async () => {
    const { org } = await fleetWithLink("Flotte Bannis", true);
    const vtc = uniqueVtc();
    const cheat = await createDriver(org);
    await sql(`update public.drivers set vtc_card_number = $2 where id = $1`, [cheat.id, vtc]);
    expect((await rpc(org.ownerId, "ban_driver", [cheat.id, "Vol de courses", "fraud", false, false])).code).toBe("BANNED");

    expect((await svc("svc_identity_check", [org.id, uniquePhone(), "x@test.dev", vtc.toLowerCase(), null])).banned).toBe(true);
    const refused = await apply(org, { vtc: vtc.toLowerCase() });
    expect(refused).toMatchObject({ ok: false, code: "IDENTITY_BANNED", message: "Inscription impossible. Contactez Flotte Bannis." });
    expect(await sql(`select id from public.drivers where user_id = $1`, [refused.userId])).toHaveLength(0);

    // Bannissement de la flotte : limité à elle
    const elsewhere = (await fleetWithLink("Flotte Sans Ban", true)).org;
    expect((await apply(elsewhere, { vtc })).code).toBe("APPROVED");

    // Bannissement plateforme : toutes les organisations, flottes comprises
    const phone = uniquePhone();
    await sql(`insert into public.banned_identities (scope, kind, value_hash, reason) values ('platform', 'phone', private.identity_hash('phone', $1), 'Fraude')`, [phone]);
    expect((await svc("svc_identity_check", [elsewhere.id, phone.replace(/^0/, "+33"), "y@test.dev", null, null])).banned).toBe(true);
    expect((await apply(elsewhere, { phone: phone.replace(/^0/, "+33 ") })).code).toBe("IDENTITY_BANNED");
  });

  it("ancienne centrale passée en flotte : même identité qu'un chauffeur parti en devant des commissions → jamais validé d'office", async () => {
    const org = await createOrg("Flotte Ex Centrale");
    await sql(`update public.organizations set dispatch_model = 'centrale', join_enabled = true, join_auto_approve = true where id = $1`, [org.id]);
    const id = { phone: uniquePhone(), email: `dette-${randomUUID().slice(0, 6)}@test.dev`, vtc: uniqueVtc() };
    const first = await apply(org, id);
    expect(first.code).toBe("APPROVED");
    const ride = await insertRideBypass(org, { status: "COMPLETED", driver_id: first.driver_id, pickup_at: new Date(), payment_method: "cash" });
    await sql(
      `insert into public.ride_settlements (organization_id, ride_id, driver_id, driver_label, direction, amount_cents, price_cents,
         commission_cents, driver_payout_cents, payment_method, reference, status, due_at)
       values ($1, $2, $3, 'Samir Candidat', 'driver_owes', 1900, 5000, 1900, 3100, 'cash', $4, 'due', now() - interval '1 day')`,
      [org.id, ride, first.driver_id, `FJ-${randomUUID().slice(0, 8)}`],
    );
    expect((await svc("svc_delete_driver_account", [first.userId])).code).toBe("DELETED");
    expect((await sql(`select count(*)::int as n from private.debtor_identities where driver_id = $1`, [first.driver_id]))[0].n).toBeGreaterThan(0);

    // Retour en flotte refusé tant que la dette est ouverte (garde inchangée)…
    expect((await expectPgError(sql(`update public.organizations set dispatch_model = 'fleet' where id = $1`, [org.id]))).message).toMatch(/SETTLEMENTS_OPEN/);
    // … données héritées (garde contournée) : la candidature d'une flotte reste contrôlée
    const client = await pool.connect();
    try {
      await client.query("set session_replication_role = replica");
      await client.query(`update public.organizations set dispatch_model = 'fleet' where id = $1`, [org.id]);
    } finally {
      await client.query("set session_replication_role = origin").catch(() => undefined);
      client.release();
    }

    const again = await apply(org, { phone: uniquePhone(), email: `autre-${randomUUID().slice(0, 6)}@test.dev`, vtc: id.vtc.toLowerCase() });
    expect(again.code).toBe("PENDING");
    expect(await driverRow(again.driver_id)).toMatchObject({ status: "inactive", application_status: "pending", trust_level: "new" });
    const [warn] = await sql(`select level, data from public.ride_events where type = 'driver.applied_debtor' and data ->> 'driver_id' = $1`, [again.driver_id]);
    expect(warn).toMatchObject({ level: "warning", data: { owed_cents: 1900, owed_settlements: 1 } });
    // Réponse identique à une candidature en attente : rien n'est dit au candidat
    expect(Object.keys(again).filter((k) => k !== "userId").sort()).toEqual(["code", "driver_id", "number", "ok", "organization"]);
    // Identité sans lien : validation automatique inchangée
    expect((await apply(org)).code).toBe("APPROVED");
  });
});

// -----------------------------------------------------------------------------
describe("Changement de modèle : le lien n'est plus coupé", () => {
  it("flotte → centrale → flotte : code, état et validation automatique conservés ; candidatures toujours en attente", async () => {
    const { org, link } = await fleetWithLink("Flotte Bascule");
    const fleetApplicant = await apply(org);
    expect(fleetApplicant.code).toBe("PENDING");
    // Validé par un administrateur de la flotte → « confirmé » ; entré par la validation automatique → « nouveau »
    const vetted = await apply(org, { first: "Valide" });
    expect((await rpc(org.ownerId, "approve_driver_application", [vetted.driver_id, null])).code).toBe("APPROVED");
    await rpc(org.ownerId, "set_join_link", [org.id, true, false, true]);
    const unvetted = await apply(org, { first: "Auto" });
    expect(unvetted.code).toBe("APPROVED");
    await rpc(org.ownerId, "set_join_link", [org.id, true, false, false]);

    await sql(`update public.organizations set dispatch_model = 'centrale' where id = $1`, [org.id]);
    const [c] = await sql(`select join_code, join_enabled, join_auto_approve from public.organizations where id = $1`, [org.id]);
    expect(c).toEqual({ join_code: link.join_code, join_enabled: true, join_auto_approve: false });
    expect(await svc("svc_join_info", [link.join_code])).toMatchObject({ ok: true, dispatch_model: "centrale" });
    expect((await driverRow(fleetApplicant.driver_id)).application_status).toBe("pending");
    // Passage en centrale : le chauffeur jamais vérifié est plafonné (« nouveau »), celui validé par la flotte non
    expect((await driverRow(vetted.driver_id)).trust_level).toBe("trusted");
    expect(await driverRow(unvetted.driver_id)).toMatchObject({ status: "active", trust_level: "new" });
    // Centrale : nouveau candidat au niveau « nouveau » ; la candidature reçue en flotte suit les règles de la centrale
    const centraleApplicant = await apply(org);
    expect((await driverRow(centraleApplicant.driver_id)).trust_level).toBe("new");
    expect((await rpc(org.ownerId, "approve_driver_application", [fleetApplicant.driver_id, null])).code).toBe("APPROVED");
    expect((await driverRow(fleetApplicant.driver_id)).trust_level).toBe("new");
    const [enter] = await sql(`select message from public.ride_events where type = 'driver.applied' and data ->> 'driver_id' = $1`, [centraleApplicant.driver_id]);
    expect(enter.message).toContain("demande à rejoindre la centrale");

    // Retour en flotte (aucun règlement ouvert) : lien et candidature conservés, validée « confirmée »
    await sql(`update public.organizations set dispatch_model = 'fleet' where id = $1`, [org.id]);
    const [f] = await sql(`select join_code, join_enabled from public.organizations where id = $1`, [org.id]);
    expect(f).toEqual({ join_code: link.join_code, join_enabled: true });
    expect(await svc("svc_join_info", [link.join_code])).toMatchObject({ ok: true, dispatch_model: "fleet" });
    expect((await driverRow(centraleApplicant.driver_id)).application_status).toBe("pending");
    expect((await rpc(org.ownerId, "approve_driver_application", [centraleApplicant.driver_id, "new"])).code).toBe("APPROVED");
    expect((await driverRow(centraleApplicant.driver_id)).trust_level).toBe("trusted");

    // Création directe d'une flotte avec un lien actif : plus de coupure par trigger
    const slug = `flotte-directe-${randomUUID().slice(0, 6)}`;
    const [direct] = await sql(
      `insert into public.organizations (name, slug, join_code, join_enabled) values ('Flotte Directe', $1, $2, true) returning join_enabled, dispatch_model`,
      [slug, randomUUID().replace(/-/g, "").slice(0, 16)],
    );
    expect(direct).toEqual({ join_enabled: true, dispatch_model: "fleet" });
  });
});

// -----------------------------------------------------------------------------
describe("Adhésion activée : jeton émis avant l'activation refusé (20260924005300)", () => {
  it("set_join_link et validation d'une candidature de flotte exigent un jeton émis après l'activation", async () => {
    const { org } = await fleetWithLink("Flotte Jeton");
    const admin = await createMember(org, "admin");
    await sql(`update public.organization_users set activated_at = now() where organization_id = $1 and user_id = $2`, [org.id, admin]);
    const before = Math.floor(Date.now() / 1000) - 60;
    const fresh = Math.floor(Date.now() / 1000) + 2;
    const call = (iat: number, fn: string, args: unknown[]) =>
      asClaims({ sub: admin, iat }, async (q) => (await q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args))[0]!.r as Row);

    expect((await expectPgError(call(before, "set_join_link", [org.id, true, true, null]))).code).toBe("42501");
    expect((await call(fresh, "set_join_link", [org.id, true, false, null])).ok).toBe(true);

    const applied = await apply(org);
    expect((await expectPgError(call(before, "approve_driver_application", [applied.driver_id, null]))).code).toBe("42501");
    expect((await expectPgError(call(before, "reject_driver_application", [applied.driver_id, null]))).code).toBe("42501");
    expect((await call(fresh, "approve_driver_application", [applied.driver_id, null])).code).toBe("APPROVED");
  });
});
