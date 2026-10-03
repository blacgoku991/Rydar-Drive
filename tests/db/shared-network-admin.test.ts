// Réseau partagé, lot 6 — administration (20260924007100_shared_network_admin) : super admin (interrupteur, validation
// avec instantané, refus, suspension, vue d'ensemble), réglages de l'organisation (set_network_settings), exclusions
// d'organisations, lisibilité « pourquoi rien n'arrive » (organisation et chauffeur). Scénarios §14.1 n° 26 et 27 de la
// spécification. L'interrupteur est rouvert avant chaque test et recoupé à la fin du fichier.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  as, createDriver, createMember, createOrg, expectPgError, networkTermsVersion, north, pool, setSharedNetwork, sql, type Org,
} from "./helpers";
import {
  networkPair, partnerAccepts, pendingOffer, readyPartner, rideAtNetworkStep, rpc, sharedRide, siteMaker, superAdmin, svc, tag,
} from "./network-fixtures";

afterAll(async () => {
  await setSharedNetwork(false);
  await pool.end();
});

beforeEach(async () => {
  await setSharedNetwork(true);
});

const nextSite = siteMaker(-40);

/** Comme `as`, avec des claims JWT complets (iat : jeton émis avant / après l'activation de l'adhésion). */
async function asClaims<T>(claims: Record<string, unknown>, fn: (q: (text: string, params?: unknown[]) => Promise<any[]>) => Promise<T>): Promise<T> {
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

const settings = (who: string, org: Org, p: { out?: boolean | null; in?: boolean | null; terms?: string | null; insurance?: boolean | null; limit?: number | null }) =>
  rpc(who, "set_network_settings", [org.id, p.out ?? null, p.in ?? null, p.terms ?? null, p.insurance ?? null, p.limit ?? null]);

const membership = async (org: Org) => (await sql(`select * from public.network_memberships where organization_id = $1`, [org.id]))[0];
const auditOf = (org: Org, action: string) =>
  sql(`select actor_type, actor_user_id, metadata from public.audit_logs where organization_id = $1 and action = $2 order by created_at`, [org.id, action]);

// =============================================================================
// Super admin (§6.3, §12.4)
// =============================================================================
describe("Super admin : RPC svc_* et vue d'ensemble (§6.3, §12.4)", () => {
  it("svc_* : service role seulement, auteur revérifié en base ; admin_network_overview : super admin seulement", async () => {
    const sa = await superAdmin();
    const A = await createOrg(`Droits ${tag()}`);
    for (const [fn, sig] of [
      ["svc_set_shared_network_enabled", "uuid, boolean"],
      ["svc_network_approve", "uuid, uuid, boolean, boolean, text"],
      ["svc_network_suspend", "uuid, uuid, boolean, text"],
    ]) {
      const [r] = await sql(
        `select has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as auth,
                has_function_privilege('service_role', $1, 'execute') as svc`,
        [`public.${fn}(${sig})`],
      );
      expect(r, fn).toEqual({ anon: false, auth: false, svc: true });
    }
    for (const sig of ["admin_network_overview()", "org_network_readiness(uuid)", "network_driver_readiness(uuid)",
      "set_network_settings(uuid, boolean, boolean, text, boolean, integer)", "set_network_exclusion(uuid, uuid, boolean)"]) {
      const [r] = await sql(`select has_function_privilege('anon', $1, 'execute') as anon`, [`public.${sig}`]);
      expect(r.anon, sig).toBe(false);
    }
    // Même un super admin connecté ne les appelle pas directement (actions serveur seulement)
    expect((await expectPgError(rpc(sa, "svc_set_shared_network_enabled", [sa, true]))).code).toBe("42501");
    // Auteur qui n'est pas super admin : refusé, rien n'est écrit
    for (const [fn, args] of [
      ["svc_set_shared_network_enabled", [A.ownerId, false]],
      ["svc_network_approve", [A.ownerId, A.id, true, false, null]],
      ["svc_network_suspend", [A.ownerId, A.id, true, "Manquement constaté"]],
      ["svc_network_approve", [null, A.id, true, false, null]],
    ] as const) {
      const e = await expectPgError(svc(fn, [...args]));
      expect(e.code, fn).toBe("42501");
    }
    expect(await membership(A)).toBeUndefined();
    expect(await sql(`select 1 from public.platform_settings where id and shared_network_enabled`)).toHaveLength(1);
    // Vue d'ensemble : propriétaire refusé, super admin servi
    expect((await expectPgError(rpc(A.ownerId, "admin_network_overview"))).code).toBe("42501");
    const overview = await rpc(sa, "admin_network_overview");
    expect(overview).toMatchObject({ enabled: true, terms: { version: await networkTermsVersion() } });
  });

  it("interrupteur : coupure → offres réseau en attente fermées, courses acceptées gardées ; idempotent ; audit", async () => {
    const sa = await superAdmin();
    const p = await networkPair(nextSite());
    const other = await readyPartner(p.B, { firstName: "Nadia", at: north(p.site, 900) });
    const { ride: kept } = await partnerAccepts(p);
    const waiting = await rideAtNetworkStep({ ...p, partner: other });
    const offer = await pendingOffer(waiting.id, other.id);
    expect(offer).toBeTruthy();

    expect(await svc("svc_set_shared_network_enabled", [sa, null])).toMatchObject({ ok: false, code: "INVALID" });
    const off = await svc("svc_set_shared_network_enabled", [sa, false]);
    expect(off).toMatchObject({ ok: true, enabled: false, changed: true });
    expect(off.closed_offers).toBeGreaterThanOrEqual(1);
    const [closed] = await sql(`select status, closed_reason from public.ride_offers where id = $1`, [offer!.id]);
    expect(closed).toEqual({ status: "closed", closed_reason: "network_unavailable" });
    const [still] = await sql(`select driver_id, status from public.rides where id = $1`, [kept.id]);
    expect(still).toEqual({ driver_id: p.partner.id, status: "ACCEPTED" });
    expect(await svc("svc_set_shared_network_enabled", [sa, false])).toEqual({ ok: true, enabled: false, changed: false, closed_offers: 0 });
    const [audit] = await sql(
      `select actor_type, actor_user_id, metadata from public.audit_logs where action = 'platform.shared_network_disabled' and actor_user_id = $1`,
      [sa],
    );
    expect(audit).toMatchObject({ actor_type: "super_admin", metadata: { from: true, to: false, closed_offers: off.closed_offers } });
    expect(await svc("svc_set_shared_network_enabled", [sa, true])).toMatchObject({ ok: true, enabled: true, changed: true, closed_offers: 0 });
  });

  it("n° 27 — validation : instantané normalisé, fiche vide ou invalide (IDENTITY_INCOMPLETE, jamais 23514), dérogation « frais à 0 », e-mail, audit", async () => {
    const sa = await superAdmin();
    const A = await createOrg(`Validation ${tag()}`);
    const version = await networkTermsVersion();
    const asked = await settings(A.ownerId, A, { out: true, terms: version });
    expect(asked.membership).toMatchObject({ share_out: true, terms_version: version, terms_accepted_by: A.ownerId });
    expect(asked.membership.requested_at).toBeTruthy();
    expect(asked.readiness.approval.status).toBe("pending");

    const incomplete = await svc("svc_network_approve", [sa, A.id, true, false, null]);
    expect(incomplete).toMatchObject({ ok: false, code: "IDENTITY_INCOMPLETE", missing: ["legal_name", "siret", "vtc_registration"] });
    await sql(`update public.organizations set legal_name = ' X ', siret = '123 456', vtc_registration = 'EVTC 0752' where id = $1`, [A.id]);
    expect(await svc("svc_network_approve", [sa, A.id, true, false, null])).toMatchObject({ code: "IDENTITY_INCOMPLETE", missing: ["legal_name", "siret"] });
    expect((await membership(A)).approved_at).toBeNull();

    // Saisie libre (espaces, points, tirets) : normalisée dans l'instantané
    await sql(
      `update public.organizations set legal_name = '  Taxis   Bleus  SAS ', siret = '123.456.789-00012', vtc_registration = ' EVTC075230001 '
        where id = $1`,
      [A.id],
    );
    const ok = await svc("svc_network_approve", [sa, A.id, true, true, null]);
    expect(ok).toMatchObject({
      ok: true, code: "APPROVED",
      membership: { approved_legal_name: "Taxis Bleus SAS", approved_siret: "12345678900012", approved_vtc_registration: "EVTC075230001", fee_waiver: true, approved_by: sa, refused_reason: null },
    });
    const [audit] = await auditOf(A, "network.approved");
    expect(audit).toMatchObject({ actor_type: "super_admin", actor_user_id: sa, metadata: { from: "pending", fee_waiver: true, siret: "12345678900012", emails: 1 } });
    const [mail] = await sql(`select to_email, subject, body_text, created_by from public.email_outbox where organization_id = $1 and kind = 'network_review'`, [A.id]);
    expect(mail).toMatchObject({ to_email: `owner-${A.slug}@test.dev`, created_by: sa });
    expect(mail.subject).toContain("validée");
    expect(mail.body_text).toContain("Taxis Bleus SAS");
    expect(mail.body_text).toContain("12345678900012");

    // Sans frais Rydar : partage actif grâce à la dérogation, dès qu'un moyen de paiement en ligne existe
    let r = await rpc(A.ownerId, "org_network_readiness", [A.id]);
    expect(r.share_out.missing).toEqual(["online_payment_method"]);
    await sql(`update public.organization_settings set settlement_methods = '{link}', settlement_link = 'https://pay.example.com/a' where organization_id = $1`, [A.id]);
    r = await rpc(A.ownerId, "org_network_readiness", [A.id]);
    expect(r.share_out).toEqual({ active: true, missing: [], warnings: [] });
    expect(r.approval).toMatchObject({ status: "approved" });
  });

  it("n° 27 — refus motivé (offres fermées, e-mail), nouvelle demande en réactivant ; G11 : nom ou n° modifié → validation perdue, offres fermées, à revalider", async () => {
    const sa = await superAdmin();
    const version = await networkTermsVersion();
    const C = await createOrg(`Refus ${tag()}`);
    await settings(C.ownerId, C, { in: true, terms: version });
    expect(await svc("svc_network_approve", [sa, C.id, false, false, "  abc  "])).toMatchObject({ ok: false, code: "REASON_REQUIRED" });
    const refused = await svc("svc_network_approve", [sa, C.id, false, false, "N° VTC introuvable au registre"]);
    expect(refused).toMatchObject({ ok: true, code: "REFUSED", membership: { refused_reason: "N° VTC introuvable au registre", approved_at: null, fee_waiver: false } });
    const before = await rpc(C.ownerId, "org_network_readiness", [C.id]);
    expect(before.approval).toMatchObject({ status: "refused", refused_reason: "N° VTC introuvable au registre" });
    expect(before.share_in.missing).toContain("approval_refused");
    const [mail] = await sql(`select subject, body_text from public.email_outbox where organization_id = $1 and kind = 'network_review'`, [C.id]);
    expect(mail.body_text).toContain("N° VTC introuvable au registre");
    expect((await auditOf(C, "network.refused"))[0].metadata).toMatchObject({ reason: "N° VTC introuvable au registre", from: "pending" });
    // Assurance seule : pas une nouvelle demande
    await settings(C.ownerId, C, { insurance: true });
    expect((await membership(C)).refused_reason).toBe("N° VTC introuvable au registre");
    // Réception réactivée : nouvelle demande, motif effacé
    const again = await settings(C.ownerId, C, { in: true });
    expect(again.membership.refused_reason).toBeNull();
    expect(again.readiness.approval.status).toBe("pending");
    const overview = await rpc(sa, "admin_network_overview");
    expect(overview.to_review.map((x: { id: string }) => x.id)).toContain(C.id);

    // G11 : A validée par Rydar, puis son n° VTC modifié par son propriétaire → offres fermées, validation perdue
    const p = await networkPair(nextSite());
    await sql(`update public.network_memberships set approved_by = $2 where organization_id = $1`, [p.A.id, sa]);
    const ride = await rideAtNetworkStep(p);
    const offer = await pendingOffer(ride.id, p.partner.id);
    expect(offer).toBeTruthy();
    await as({ sub: p.A.ownerId }, (q) => q(`update public.organizations set vtc_registration = 'EVTC075230999' where id = $1`, [p.A.id]));
    const lost = await membership(p.A);
    expect(lost).toMatchObject({ approved_at: null, approved_by: sa });
    expect(lost.approved_vtc_registration).toBe("EVTC075230001");
    expect((await sql(`select status, closed_reason from public.ride_offers where id = $1`, [offer!.id]))[0]).toEqual({ status: "closed", closed_reason: "sharing_stopped" });
    expect((await auditOf(p.A, "network.approval_lost"))[0].metadata).toMatchObject({ fields: ["vtc_registration"] });
    const readiness = await rpc(p.A.ownerId, "org_network_readiness", [p.A.id]);
    expect(readiness.approval.status).toBe("lost");
    expect(readiness.share_out.missing).toContain("approval_lost");
    const row = (await rpc(sa, "admin_network_overview")).to_review.find((x: { id: string }) => x.id === p.A.id);
    expect(row).toMatchObject({ approval: "lost", vtc_registration: "EVTC075230999" });
    // Revalidation : nouvel instantané
    expect(await svc("svc_network_approve", [sa, p.A.id, true, false, null])).toMatchObject({ code: "APPROVED", membership: { approved_vtc_registration: "EVTC075230999" } });
  });

  it("suspension : motif obligatoire, offres fermées dans les deux sens, courses non commencées de ses chauffeurs rendues ; rétablissement", async () => {
    const sa = await superAdmin();
    const p = await networkPair(nextSite());
    const other = await readyPartner(p.B, { firstName: "Nadia", at: north(p.site, 900) });
    const { ride } = await partnerAccepts(p);
    const waiting = await rideAtNetworkStep({ ...p, partner: other });
    const offer = await pendingOffer(waiting.id, other.id);
    expect(offer).toBeTruthy();

    expect(await svc("svc_network_suspend", [sa, p.B.id, true, "abc"])).toMatchObject({ ok: false, code: "REASON_REQUIRED" });
    expect(await svc("svc_network_suspend", [sa, "00000000-0000-0000-0000-000000000000", true, "Manquement constaté"])).toMatchObject({ ok: false, code: "NOT_FOUND" });
    const res = await svc("svc_network_suspend", [sa, p.B.id, true, "Manquement à la convention (retards)"]);
    expect(res).toMatchObject({ ok: true, code: "SUSPENDED", released_rides: 1 });
    expect(res.closed_offers).toBeGreaterThanOrEqual(1);
    expect((await sql(`select status from public.ride_offers where id = $1`, [offer!.id]))[0].status).toBe("closed");
    const [back] = await sql(`select driver_id, status from public.rides where id = $1`, [ride.id]);
    expect(back.driver_id).toBeNull();
    expect((await sql(`select end_reason from public.ride_network_executions where ride_id = $1`, [ride.id]))[0].end_reason).toBe("executor_unavailable");
    expect(await membership(p.B)).toMatchObject({ suspended_reason: "Manquement à la convention (retards)", suspended_by: sa });
    expect((await rpc(p.B.ownerId, "org_network_readiness", [p.B.id])).share_in.missing).toContain("suspended");
    expect((await sql(`select private.network_pair_ok($1, $2) as ok`, [p.A.id, p.B.id]))[0].ok).toBe(false);
    expect((await auditOf(p.B, "network.suspended"))[0]).toMatchObject({ actor_user_id: sa, metadata: { released_rides: 1 } });

    expect(await svc("svc_network_suspend", [sa, p.B.id, false, null])).toEqual({ ok: true, code: "RESTORED", closed_offers: 0, released_rides: 0 });
    expect(await membership(p.B)).toMatchObject({ suspended_at: null, suspended_reason: null, suspended_by: null });
    expect((await auditOf(p.B, "network.restored"))[0].metadata).toMatchObject({ suspended_reason: "Manquement à la convention (retards)" });
    expect((await sql(`select private.network_pair_ok($1, $2) as ok`, [p.A.id, p.B.id]))[0].ok).toBe(true);
  });

  it("vue d'ensemble : à valider (= pastille du menu), organisations et chiffres sur 30 jours, seuils, chauffeurs exclus, dernières courses, totaux", async () => {
    const sa = await superAdmin();
    const p = await networkPair(nextSite());
    const first = await sharedRide(p, { payment_method: "cash" });
    const second = await sharedRide(p, { payment_method: "cash" });
    for (const s of [first, second]) {
      expect(await rpc(p.A.ownerId, "contest_network_ride", [s.ride.id, "Trajet non conforme"])).toMatchObject({ ok: true });
    }
    await sql(`update public.driver_network_settings set excluded_until = now() + interval '20 days' where driver_id = $1`, [p.partner.id]);
    const D = await createOrg(`Demande ${tag()}`);
    await settings(D.ownerId, D, { out: true, terms: await networkTermsVersion() });

    const o = await rpc(sa, "admin_network_overview");
    const [badge] = await sql(
      `select count(*)::int as n from public.network_memberships
        where requested_at is not null and approved_at is null and refused_reason is null and (share_out or share_in)`,
    );
    expect(o.to_review).toHaveLength(badge.n);
    expect(o.totals.to_review).toBe(badge.n);
    expect(o.to_review.find((x: { id: string }) => x.id === D.id)).toMatchObject({ approval: "pending", share_out: true, terms_ok: true });
    const b = o.organizations.find((x: { id: string }) => x.id === p.B.id);
    expect(b).toMatchObject({ share_in: true, approval: "approved", flags: ["contests"] });
    expect(b.stats_30d).toMatchObject({ rides_received: 2, offers_accepted: 2, contested_rides: 2, rides_given: 0 });
    const a = o.organizations.find((x: { id: string }) => x.id === p.A.id);
    expect(a.stats_30d).toMatchObject({ rides_given: 2, rides_received: 0, contested_rides: 0 });
    expect(a.platform_fee_percent).toBe(10);
    expect(o.auto_excluded_drivers.find((x: { organization: { id: string } }) => x.organization.id === p.B.id)).toMatchObject({
      driver_label: `Karim Tazi (#${p.partner.number})`, organization: { name: p.bName }, releases_30d: 0,
    });
    const recent = o.recent_rides.find((x: { execution_id: string }) => x.execution_id === second.execution.id);
    expect(recent).toMatchObject({ giver: { id: p.A.id, name: p.aName }, executor: { id: p.B.id, name: p.bName }, status: "COMPLETED", price_cents: 5000, currency: "EUR" });
    expect(o.recent_rides.length).toBeLessThanOrEqual(50);
    expect(o.totals.members).toBe(o.organizations.length);
    expect(o.totals.rides_30d).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// Organisation (§6.1, n° 26)
// =============================================================================
describe("Réglages de l'organisation (§6.1, §14.1 n° 26)", () => {
  it("convention (version en vigueur, preuve), première activation = demande ; n° VTC, moyen en ligne et assurance dans la lisibilité ; plafond", async () => {
    const A = await createOrg(`Reglages ${tag()}`);
    const version = await networkTermsVersion();
    // Rien à enregistrer : aucune adhésion créée
    expect(await settings(A.ownerId, A, {})).toMatchObject({ ok: true, membership: null, closed_offers: 0 });
    expect(await membership(A)).toBeUndefined();
    // Activer sans convention : refusé ; version périmée : refusée
    expect((await expectPgError(settings(A.ownerId, A, { out: true }))).message).toMatch(/^NETWORK_TERMS_REQUIRED/);
    expect((await expectPgError(settings(A.ownerId, A, { out: true, terms: "2020-01-01" }))).message).toMatch(/^NETWORK_TERMS_OUTDATED/);

    const res = await settings(A.ownerId, A, { out: true, in: true, terms: version });
    expect(res).toMatchObject({ ok: true, closed_offers: 0, membership: { share_out: true, share_in: true, terms_version: version } });
    expect(res.readiness.share_out.missing).toEqual(["vtc_registration", "approval_pending", "online_payment_method", "platform_fee"]);
    expect(res.readiness.share_in.missing).toEqual(["vtc_registration", "approval_pending", "insurance"]);
    const [proof] = await sql(
      `select user_id, version, source, accepted_by_email from public.legal_acceptances where organization_id = $1 and document = 'network'`,
      [A.id],
    );
    expect(proof).toEqual({ user_id: A.ownerId, version, source: "web", accepted_by_email: `owner-${A.slug}@test.dev` });
    expect((await auditOf(A, "network.terms_accepted"))[0].metadata).toMatchObject({ version, previous: null });
    expect((await auditOf(A, "network.settings"))[0].metadata).toMatchObject({ share_out: true, share_in: true, requested: true });

    // Assurance confirmée par un admin (auteur gardé), plafond par chauffeur
    const admin = await createMember(A, "admin", "Admin Réglages");
    const ins = await settings(admin, A, { insurance: true, limit: 25000 });
    expect(ins.membership).toMatchObject({ insurance_confirmed_by: admin, executor_credit_limit_cents: 25000 });
    expect(ins.readiness.share_in.missing).toEqual(["vtc_registration", "approval_pending"]);
    expect((await settings(A.ownerId, A, { insurance: true })).membership.insurance_confirmed_by).toBe(admin);
    expect((await expectPgError(settings(A.ownerId, A, { limit: 100001 }))).code).toBe("22023");
    // Même convention acceptée de nouveau : idempotent (une seule preuve)
    await settings(A.ownerId, A, { terms: version });
    expect(await sql(`select 1 from public.legal_acceptances where organization_id = $1 and document = 'network'`, [A.id])).toHaveLength(1);
  });

  it("dispatcher refusé ; jeton émis avant l'activation de l'adhésion refusé ; réseau fermé : NETWORK_DISABLED", async () => {
    const A = await createOrg(`Acces ${tag()}`);
    const version = await networkTermsVersion();
    const dispatcher = await createMember(A, "dispatcher", "Dispatcher");
    expect((await expectPgError(settings(dispatcher, A, { out: true, terms: version }))).code).toBe("42501");
    expect((await expectPgError(rpc(dispatcher, "set_network_exclusion", [A.id, A.id, true]))).code).toBe("42501");
    // Lisibilité : lecture pour tout membre
    expect((await rpc(dispatcher, "org_network_readiness", [A.id])).share_out.missing).toContain("not_sharing");

    const admin = await createMember(A, "admin", "Admin activé");
    const s = Math.floor(Date.now() / 1000) - 60;
    await sql(`update public.organization_users set activated_at = to_timestamp($3::double precision + 0.5) where organization_id = $1 and user_id = $2`, [A.id, admin, s]);
    const call = (iat: number) =>
      asClaims({ sub: admin, iat }, (q) => q(`select public.set_network_settings($1, true, null, $2, null, null) as r`, [A.id, version]));
    expect((await expectPgError(call(s))).code).toBe("42501");
    const [{ r }] = await call(s + 1);
    expect(r.membership.share_out).toBe(true);

    await setSharedNetwork(false);
    for (const [fn, args] of [
      ["set_network_settings", [A.id, false, null, null, null, null]],
      ["set_network_exclusion", [A.id, A.id, true]],
      ["org_network_readiness", [A.id]],
    ] as const) {
      expect((await expectPgError(rpc(A.ownerId, fn, [...args]))).message, fn).toMatch(/^NETWORK_DISABLED/);
    }
  });

  it("coupure d'un sens ou assurance retirée → offres réseau en attente fermées ; G12 : dernier moyen en ligne retiré pendant le partage refusé", async () => {
    const p = await networkPair(nextSite());
    let ride = await rideAtNetworkStep(p);
    let offer = await pendingOffer(ride.id, p.partner.id);
    expect(offer).toBeTruthy();
    const off = await settings(p.B.ownerId, p.B, { insurance: false });
    expect(off.closed_offers).toBe(1);
    expect(off.readiness.share_in).toMatchObject({ active: false, missing: ["insurance"] });
    expect((await sql(`select closed_reason from public.ride_offers where id = $1`, [offer!.id]))[0].closed_reason).toBe("sharing_stopped");
    expect((await auditOf(p.B, "network.settings")).at(-1)!.metadata).toMatchObject({ insurance_confirmed: false, closed_offers: 1 });

    await settings(p.B.ownerId, p.B, { insurance: true });
    ride = await rideAtNetworkStep(p);
    offer = await pendingOffer(ride.id, p.partner.id);
    expect(offer).toBeTruthy();
    expect((await settings(p.A.ownerId, p.A, { out: false })).closed_offers).toBeGreaterThanOrEqual(1);
    expect((await sql(`select closed_reason from public.ride_offers where id = $1`, [offer!.id]))[0].closed_reason).toBe("sharing_stopped");

    // G12 : partage demandé, réseau ouvert, dernier moyen en ligne retiré → refusé ; un moyen en ligne gardé : permis
    await settings(p.A.ownerId, p.A, { out: true });
    const e = await expectPgError(as({ sub: p.A.ownerId }, (q) =>
      q(`update public.organization_settings set settlement_methods = '{cash}' where organization_id = $1`, [p.A.id])));
    expect(e.message).toMatch(/^NETWORK_PAYMENT_METHODS_REQUIRED/);
    await as({ sub: p.A.ownerId }, (q) =>
      q(`update public.organization_settings set settlement_methods = '{link}' where organization_id = $1`, [p.A.id]));
  });
});

// =============================================================================
// Exclusions entre organisations (§6.1)
// =============================================================================
describe("Exclusions entre organisations (§6.1)", () => {
  it("organisation jamais rencontrée : même réponse, rien d'écrit ; rencontrée : exclusion symétrique (offres fermées), invisible pour l'exclue, levée", async () => {
    const p = await networkPair(nextSite());
    const other = await readyPartner(p.B, { firstName: "Nadia", at: north(p.site, 900) });
    const stranger = await createOrg(`Inconnue ${tag()}`);
    expect(await rpc(p.A.ownerId, "set_network_exclusion", [p.A.id, stranger.id, true])).toEqual({ ok: true });
    expect(await rpc(p.A.ownerId, "set_network_exclusion", [p.A.id, p.B.id, true])).toEqual({ ok: true });
    expect(await sql(`select 1 from public.network_exclusions where organization_id = $1`, [p.A.id])).toHaveLength(0);

    await partnerAccepts(p);
    const waiting = await rideAtNetworkStep({ ...p, partner: other });
    const offer = await pendingOffer(waiting.id, other.id);
    expect(offer).toBeTruthy();
    expect(await rpc(p.A.ownerId, "set_network_exclusion", [p.A.id, p.B.id, true])).toEqual({ ok: true });
    expect(await rpc(p.A.ownerId, "set_network_exclusion", [p.A.id, p.B.id, true])).toEqual({ ok: true });
    expect(await sql(`select created_by from public.network_exclusions where organization_id = $1 and excluded_org_id = $2`, [p.A.id, p.B.id])).toEqual([
      { created_by: p.A.ownerId },
    ]);
    expect((await sql(`select closed_reason from public.ride_offers where id = $1`, [offer!.id]))[0].closed_reason).toBe("network_unavailable");
    const pair = async () => (await sql(`select private.network_pair_ok($1, $2) as ab, private.network_pair_ok($2, $1) as ba`, [p.A.id, p.B.id]))[0];
    expect(await pair()).toEqual({ ab: false, ba: false });
    expect(await as({ sub: p.B.ownerId }, (q) => q(`select * from public.network_exclusions`))).toEqual([]);
    expect(await as({ sub: p.A.ownerId }, (q) => q(`select excluded_org_id from public.network_exclusions`))).toEqual([{ excluded_org_id: p.B.id }]);
    const audits = await auditOf(p.A, "network.exclusion");
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ partner: p.B.id, excluded: true, closed_offers: 1 });
    // B ne lève pas l'exclusion posée par A ; A la lève
    expect(await rpc(p.B.ownerId, "set_network_exclusion", [p.B.id, p.A.id, false])).toEqual({ ok: true });
    expect(await pair()).toEqual({ ab: false, ba: false });
    expect(await rpc(p.A.ownerId, "set_network_exclusion", [p.A.id, p.B.id, false])).toEqual({ ok: true });
    expect(await pair()).toEqual({ ab: true, ba: false });
  });
});

// =============================================================================
// Lisibilité (§6.4)
// =============================================================================
describe("Lisibilité « pourquoi rien n'arrive » (§6.4)", () => {
  it("network_driver_readiness : le chauffeur lui-même, owner / admin de son organisation ; jamais A ni un dispatcher ; une raison et une action par condition", async () => {
    const p = await networkPair(nextSite());
    const ready = { ready: true, missing: [], warnings: [], terms_grace_until: null, excluded_until: null };
    expect(await rpc(p.partner.userId, "network_driver_readiness", [null])).toEqual(ready);
    expect(await rpc(p.partner.userId, "network_driver_readiness", [p.partner.id])).toEqual(ready);
    expect(await rpc(p.B.ownerId, "network_driver_readiness", [p.partner.id])).toEqual(ready);
    expect((await expectPgError(rpc(p.A.ownerId, "network_driver_readiness", [p.partner.id]))).code).toBe("42501");
    const dispatcher = await createMember(p.B, "dispatcher", "Dispatcher B");
    expect((await expectPgError(rpc(dispatcher, "network_driver_readiness", [p.partner.id]))).code).toBe("42501");
    expect((await expectPgError(rpc(p.B.ownerId, "network_driver_readiness", [null]))).code).toBe("42501");
    expect((await expectPgError(rpc(p.B.ownerId, "network_driver_readiness", ["00000000-0000-0000-0000-000000000000"]))).message).toMatch(/^DRIVER_NOT_FOUND/);

    // Nouveau chauffeur de B : chaque condition manquante, dans l'ordre de DRIVER_NETWORK_READINESS_CODES
    const fresh = await createDriver(p.B, { firstName: "Nouveau" });
    await sql(`update public.drivers set vtc_card_number = null where id = $1`, [fresh.id]);
    expect((await rpc(p.B.ownerId, "network_driver_readiness", [fresh.id])).missing).toEqual([
      "driver_off", "terms", "app_update", "vtc_card", "insurance", "vehicle_registration", "driving_license", "vtc_card_number",
    ]);
    // Réception de B coupée : la raison de l'organisation d'abord
    await rpc(p.B.ownerId, "set_network_settings", [p.B.id, null, false, null, null, null]);
    expect((await rpc(p.partner.userId, "network_driver_readiness", [null])).missing).toEqual(["org_reception_off"]);

    await setSharedNetwork(false);
    expect((await expectPgError(rpc(p.partner.userId, "network_driver_readiness", [null]))).message).toMatch(/^NETWORK_DISABLED/);
  });

  it("org_network_readiness = la lisibilité du résumé (org_network_summary), une raison par condition", async () => {
    const p = await networkPair(nextSite());
    const r = await rpc(p.A.ownerId, "org_network_readiness", [p.A.id]);
    expect(r).toEqual((await rpc(p.A.ownerId, "org_network_summary", [p.A.id])).readiness);
    expect(r.share_out).toEqual({ active: true, missing: [], warnings: [] });
    expect(r.share_in.active).toBe(false);
    expect(r.share_in.missing).toEqual(["not_receiving", "insurance"]);
    const stranger = await createOrg(`Etrangere ${tag()}`);
    expect((await expectPgError(rpc(stranger.ownerId, "org_network_readiness", [p.A.id]))).code).toBe("42501");
  });
});

