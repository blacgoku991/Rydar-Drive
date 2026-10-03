// Audit « comptes » (20260924004700) : compte partagé chauffeur / gestion, invitations de membres prouvées par
// l'adresse e-mail, révocation des sessions, statut d'un chauffeur par RPC.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { as, createAuthUser, createDriver, createMember, createOrg, expectPgError, inMinutes, insertRideBypass, pool, sql } from "./helpers";

afterAll(async () => {
  await pool.end();
});

type Row = Record<string, any>;
type Q = <R extends pg.QueryResultRow = any>(text: string, params?: unknown[]) => Promise<R[]>;

/** Comme `as`, avec des claims JWT complets (amr : méthode d'authentification de la session Supabase). */
async function asClaims<T>(claims: Record<string, unknown>, fn: (q: Q) => Promise<T>): Promise<T> {
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

const amr = (method: string) => [{ method, timestamp: Math.floor(Date.now() / 1000) }];
const accept = async (userId: string, method: string) =>
  (await asClaims({ sub: userId, amr: amr(method) }, (q) => q("select public.accept_member_invitations() as r")))[0].r as Row;
const rpc = async (sub: string, fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ sub }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Row;
};
const shared = async (userId: string) =>
  (await as({ role: "service_role" }, (q) => q("select public.svc_login_account_shared($1) as r", [userId])))[0].r as boolean;

/** Session Supabase Auth ouverte (session + refresh token). */
async function openSession(userId: string) {
  await sql("insert into auth.sessions (user_id) values ($1)", [userId]);
  await sql("insert into auth.refresh_tokens (token, user_id, revoked) values ($1, $2, false)", [`rt-${userId}-${Math.random()}`, userId]);
}
async function sessionCount(userId: string) {
  const [{ s }] = await sql("select count(*)::int as s from auth.sessions where user_id = $1", [userId]);
  const [{ t }] = await sql("select count(*)::int as t from auth.refresh_tokens where user_id = $1::text", [userId]);
  return s + t;
}
const newUser = (label: string) => createAuthUser(`${label}-${randomUUID().slice(0, 8)}@test.dev`, `Personne ${label}`);
async function invite(orgId: string, userId: string, role = "dispatcher") {
  const [row] = await sql(
    "insert into public.organization_users (organization_id, user_id, role, status) values ($1, $2, $3, 'invited') returning id",
    [orgId, userId, role],
  );
  return row.id as string;
}
const memberStatus = async (orgId: string, userId: string) =>
  (await sql("select status from public.organization_users where organization_id = $1 and user_id = $2", [orgId, userId]))[0]?.status;

describe("Compte partagé (fiche chauffeur + gestion)", () => {
  it("svc_login_account_shared : service role seul ; adhésion ACTIVE (centrale non archivée) ou super admin", async () => {
    const A = await createOrg("Partage A");
    const B = await createOrg("Partage B");
    const driver = await createDriver(A);
    expect(await shared(driver.userId)).toBe(false);
    expect(await shared(A.ownerId)).toBe(true);

    const invited = await createDriver(A);
    await invite(B.id, invited.userId);
    expect(await shared(invited.userId)).toBe(false); // une invitation en attente ne donne aucun accès

    const disabled = await createMember(B, "dispatcher");
    await sql("update public.organization_users set status = 'disabled' where user_id = $1", [disabled]);
    expect(await shared(disabled)).toBe(false);

    const admin = await newUser("sa");
    await sql("update public.users set is_super_admin = true where id = $1", [admin]);
    expect(await shared(admin)).toBe(true);

    const archived = await createOrg("Partage archivée");
    const former = await createMember(archived, "admin");
    await sql("update public.organizations set status = 'archived' where id = $1", [archived.id]);
    expect(await shared(former)).toBe(false);

    for (const who of [{ sub: A.ownerId }, { role: "anon" as const }]) {
      await expect(as(who, (q) => q("select public.svc_login_account_shared($1)", [driver.userId]))).rejects.toThrow(/permission denied/);
    }
  });

  it("la centrale du chauffeur ne ferme pas les sessions d'un compte qui gère une autre centrale", async () => {
    const A = await createOrg("Sess partage A");
    const B = await createOrg("Sess partage B");
    const d = await createDriver(A);
    await sql("insert into public.organization_users (organization_id, user_id, role) values ($1, $2, 'admin')", [B.id, d.userId]);
    await openSession(d.userId);

    // « Déconnecter tous les appareils » : refus explicite, rien n'est fermé
    expect(await rpc(A.ownerId, "revoke_driver_sessions", [d.id])).toMatchObject({ ok: false, code: "SHARED_ACCOUNT" });
    // Suspension de la fiche : sessions de gestion conservées (la base coupe l'accès chauffeur)
    expect((await rpc(A.ownerId, "set_driver_status", [d.id, "suspended", null])).ok).toBe(true);
    expect(await sessionCount(d.userId)).toBe(2);
    const [{ id }] = await as({ sub: d.userId }, (q) => q("select private.current_driver_id() as id"));
    expect(id).toBeNull();

    // Chauffeur seul : comportement inchangé
    const solo = await createDriver(A);
    await openSession(solo.userId);
    expect(await rpc(A.ownerId, "revoke_driver_sessions", [solo.id])).toEqual({ ok: true, revoked: 2 });
  });

  it("suspension de la centrale du chauffeur : le compte qui gère une autre centrale garde ses sessions", async () => {
    const A = await createOrg("Sess org partage A");
    const B = await createOrg("Sess org partage B");
    const d = await createDriver(A);
    const solo = await createDriver(A);
    await sql("insert into public.organization_users (organization_id, user_id, role) values ($1, $2, 'dispatcher')", [B.id, d.userId]);
    for (const u of [d.userId, solo.userId]) await openSession(u);
    await sql("update public.organizations set status = 'suspended' where id = $1", [A.id]);
    expect(await sessionCount(d.userId)).toBe(2);
    expect(await sessionCount(solo.userId)).toBe(0);
  });
});

describe("Retrait d'un membre : sessions", () => {
  it("une invitation annulée ne ferme rien ; un membre retiré qui a un autre accès garde ses sessions", async () => {
    const A = await createOrg("Retrait A");
    const B = await createOrg("Retrait B");
    // Chauffeur de A invité par B, puis invitation supprimée : l'app chauffeur n'est pas déconnectée
    const d = await createDriver(A);
    await openSession(d.userId);
    await invite(B.id, d.userId);
    await sql("delete from public.organization_users where organization_id = $1 and user_id = $2", [B.id, d.userId]);
    expect(await sessionCount(d.userId)).toBe(2);

    // Chauffeur actif de A devenu dispatcher de B, retiré par B : ses sessions (app chauffeur) restent
    await sql("insert into public.organization_users (organization_id, user_id, role) values ($1, $2, 'dispatcher')", [B.id, d.userId]);
    await sql("update public.organization_users set status = 'disabled' where organization_id = $1 and user_id = $2", [B.id, d.userId]);
    expect(await sessionCount(d.userId)).toBe(2);

    // Membre des deux centrales retiré de l'une : sessions conservées ; retiré de la dernière : fermées
    const both = await createMember(A, "admin");
    await sql("insert into public.organization_users (organization_id, user_id, role) values ($1, $2, 'admin')", [B.id, both]);
    await openSession(both);
    await sql("delete from public.organization_users where organization_id = $1 and user_id = $2", [A.id, both]);
    expect(await sessionCount(both)).toBe(2);
    await sql("update public.organization_users set status = 'disabled' where organization_id = $1 and user_id = $2", [B.id, both]);
    expect(await sessionCount(both)).toBe(0);
  });
});

describe("Invitation d'un compte existant", () => {
  it("adhésion « invited » : aucun accès, nom et téléphone non visibles de la centrale qui invite", async () => {
    const A = await createOrg("Invit profil");
    const x = await newUser("invite");
    await sql("update public.users set full_name = 'Xavier Invité', phone = '+33611112222' where id = $1", [x]);
    await invite(A.id, x);

    const seen = await as({ sub: A.ownerId }, (q) => q("select full_name, phone from public.users where id = $1", [x]));
    expect(seen).toEqual([]);
    const [{ member }] = await as({ sub: x }, (q) => q("select private.is_org_member($1) as member", [A.id]));
    expect(member).toBe(false);

    expect(await accept(x, "otp")).toMatchObject({ ok: true, code: "ACTIVATED", activated: 1 });
    const after = await as({ sub: A.ownerId }, (q) => q("select full_name, phone from public.users where id = $1", [x]));
    expect(after).toEqual([{ full_name: "Xavier Invité", phone: "+33611112222" }]);
  });

  it("activation : jamais par une session mot de passe ; oui par une session ouverte depuis le lien e-mail", async () => {
    const A = await createOrg("Invit activation");
    const B = await createOrg("Invit activation B");
    const archived = await createOrg("Invit archivée");
    const x = await newUser("attaque");
    await invite(A.id, x, "admin");
    await invite(B.id, x, "dispatcher");
    await invite(archived.id, x);
    await sql("update public.organizations set status = 'archived' where id = $1", [archived.id]);

    // Compte pré-créé par un tiers qui connaît le mot de passe : refus, adhésion toujours invitée
    expect(await accept(x, "password")).toMatchObject({ ok: false, code: "EMAIL_PROOF_REQUIRED", pending: 2 });
    expect(
      (await asClaims({ sub: x }, (q) => q("select public.accept_member_invitations() as r")))[0].r,
    ).toMatchObject({ ok: false, code: "EMAIL_PROOF_REQUIRED" });
    expect(await memberStatus(A.id, x)).toBe("invited");

    // Lien de réinitialisation (flux PKCE : amr « recovery ») : les deux invitations actives, pas la centrale archivée
    const res = await accept(x, "recovery");
    expect(res).toMatchObject({ ok: true, code: "ACTIVATED", activated: 2 });
    expect((res.organizations as Row[]).map((o) => o.id).sort()).toEqual([A.id, B.id].sort());
    expect(await memberStatus(A.id, x)).toBe("active");
    expect(await memberStatus(archived.id, x)).toBe("invited");
    const [log] = await sql(
      "select actor_user_id, severity, metadata from public.audit_logs where organization_id = $1 and action = 'member.invitation_accepted'",
      [A.id],
    );
    expect(log).toMatchObject({ actor_user_id: x, severity: "info", metadata: { role: "admin" } });
    // Plus rien en attente : réponse neutre
    expect(await accept(x, "password")).toMatchObject({ ok: true, code: "NONE", activated: 0 });

    await expect(as({ role: "anon" }, (q) => q("select public.accept_member_invitations()"))).rejects.toThrow(/permission denied/);
  });

  it("aucune autre voie (service role compris) ne sort une adhésion de l'état « invited » ; la supprimer reste possible", async () => {
    const A = await createOrg("Invit garde");
    const x = await newUser("garde");
    await invite(A.id, x);
    for (const status of ["active", "disabled"]) {
      const err = await expectPgError(sql("update public.organization_users set status = $3 where organization_id = $1 and user_id = $2", [A.id, x, status]));
      expect(err.message).toMatch(/INVITATION_PENDING/);
      await expect(
        as({ role: "service_role" }, (q) => q("update public.organization_users set status = $3 where organization_id = $1 and user_id = $2", [A.id, x, status])),
      ).rejects.toThrow(/INVITATION_PENDING/);
    }
    // Rôle modifiable, invitation annulée = supprimée
    await sql("update public.organization_users set role = 'admin' where organization_id = $1 and user_id = $2", [A.id, x]);
    await sql("delete from public.organization_users where organization_id = $1 and user_id = $2", [A.id, x]);
    expect(await memberStatus(A.id, x)).toBeUndefined();
    // Un membre actif peut toujours être désactivé puis réactivé
    const m = await createMember(A, "dispatcher");
    await sql("update public.organization_users set status = 'disabled' where user_id = $1", [m]);
    await sql("update public.organization_users set status = 'active' where user_id = $1", [m]);
    expect(await memberStatus(A.id, m)).toBe("active");
  });
});

describe("set_driver_status (activer / désactiver / suspendre)", () => {
  it("owner / admin de la centrale du chauffeur seulement", async () => {
    const A = await createOrg("Statut droits A");
    const B = await createOrg("Statut droits B");
    const d = await createDriver(A);
    const dispatcher = await createMember(A, "dispatcher");
    for (const sub of [dispatcher, B.ownerId, d.userId]) {
      const err = await expectPgError(as({ sub }, (q) => q("select public.set_driver_status($1, 'suspended')", [d.id])));
      expect(err.code).toBe("42501");
    }
    await expect(as({ role: "anon" }, (q) => q("select public.set_driver_status($1, 'suspended')", [d.id]))).rejects.toThrow(/permission denied/);
    expect(await rpc(A.ownerId, "set_driver_status", [d.id, "invited"])).toMatchObject({ ok: false, code: "INVALID_STATUS" });
    expect(await rpc(A.ownerId, "set_driver_status", [randomUUID(), "inactive"])).toMatchObject({ ok: false, code: "DRIVER_NOT_FOUND" });
  });

  it("suspension : courses non commencées remises en recherche, offres fermées, chauffeur hors ligne ; refus si client à bord", async () => {
    const A = await createOrg("Statut courses");
    const d = await createDriver(A, { presence: "available" });

    // Client à bord : refus, rien ne change
    const busy = await createDriver(A, { presence: "on_trip" });
    const onboard = await insertRideBypass(A, { status: "IN_PROGRESS", driver_id: busy.id, vehicle_id: busy.vehicleId });
    await sql("update public.drivers set current_ride_id = $2 where id = $1", [busy.id, onboard]);
    for (const status of ["suspended", "inactive"]) {
      expect(await rpc(A.ownerId, "set_driver_status", [busy.id, status, "Document expiré"])).toMatchObject({ ok: false, code: "DRIVER_ON_RIDE" });
    }
    expect((await sql("select status, current_ride_id from public.drivers where id = $1", [busy.id]))[0]).toEqual({ status: "active", current_ride_id: onboard });

    // Planifiée acceptée pour demain + offre en attente sur une autre course
    const planned = await insertRideBypass(A, {
      type: "scheduled", status: "ACCEPTED", driver_id: d.id, vehicle_id: d.vehicleId, pickup_at: inMinutes(24 * 60), accepted_at: new Date(),
    });
    const offered = await insertRideBypass(A, { status: "OFFERED", pickup_at: inMinutes(5) });
    await sql(
      `insert into public.ride_offers (organization_id, ride_id, driver_id, status, mode, wave, sent_at, expires_at)
       values ($1, $2, $3, 'pending', 'geo', 1, now(), now() + interval '30 seconds')`,
      [A.id, offered, d.id],
    );

    const res = await rpc(A.ownerId, "set_driver_status", [d.id, "suspended", "Document expiré"]);
    expect(res).toMatchObject({ ok: true, code: "STATUS_CHANGED", status: "suspended", user_id: d.userId, reassigned_rides: 1 });
    const [ride] = await sql("select status, driver_id from public.rides where id = $1", [planned]);
    expect(ride.driver_id).toBeNull();
    expect(["SEARCHING_DRIVER", "OFFERED", "CREATED"]).toContain(ride.status);
    const [offer] = await sql("select status, closed_reason from public.ride_offers where ride_id = $1 and driver_id = $2", [offered, d.id]);
    expect(offer).toEqual({ status: "closed", closed_reason: "driver_inactive" });
    const [row] = await sql("select status, presence, current_ride_id, suspended_reason from public.drivers where id = $1", [d.id]);
    expect(row).toEqual({ status: "suspended", presence: "offline", current_ride_id: null, suspended_reason: "Document expiré" });

    // Réactivation
    expect(await rpc(A.ownerId, "set_driver_status", [d.id, "active"])).toMatchObject({ ok: true, status: "active", user_id: d.userId });
    expect((await sql("select status, suspended_reason from public.drivers where id = $1", [d.id]))[0]).toEqual({ status: "active", suspended_reason: null });
  });

  it("un chauffeur banni ne se réactive pas par cette voie", async () => {
    const A = await createOrg("Statut banni");
    const d = await createDriver(A);
    expect((await rpc(A.ownerId, "ban_driver", [d.id, "Fraude avérée", "fraud", false, false])).ok).toBe(true);
    const err = await expectPgError(as({ sub: A.ownerId }, (q) => q("select public.set_driver_status($1, 'active')", [d.id])));
    expect(err.message).toMatch(/DRIVER_BANNED/);
  });
});

describe("Invitation activée : un jeton émis AVANT l'activation ne donne pas l'accès (20260924005300)", () => {
  it("jeton antérieur (compte pré-créé par un tiers) : aucun accès ; jeton rafraîchi après l'activation : accès", async () => {
    const A = await createOrg("Invit jeton");
    const x = await newUser("jeton");
    await invite(A.id, x, "admin");
    const before = Math.floor(Date.now() / 1000) - 60; // jeton du tiers, émis avant l'activation
    expect(await accept(x, "recovery")).toMatchObject({ ok: true, code: "ACTIVATED", activated: 1 });
    const [{ activated_at }] = await sql("select activated_at from public.organization_users where organization_id = $1 and user_id = $2", [A.id, x]);
    expect(activated_at).not.toBeNull();

    const probe = (iat: number) =>
      asClaims({ sub: x, iat }, async (q) => ({
        members: (await q("select private.member_org_ids() as id")).map((r) => r.id),
        admins: (await q("select private.admin_org_ids() as id")).map((r) => r.id),
        role: (await q("select private.has_org_role($1, array['owner','admin']::public.org_role[]) as ok", [A.id]))[0].ok,
        own: (await q("select organization_id from public.organization_users where user_id = $1", [x])).map((r) => r.organization_id),
      }));

    expect(await probe(before)).toEqual({ members: [], admins: [], role: false, own: [] });
    const fresh = Math.floor(Date.now() / 1000) + 1;
    expect(await probe(fresh)).toEqual({ members: [A.id], admins: [A.id], role: true, own: [A.id] });
  });

  it("adhésion créée directement active (sans activation) : aucun changement, même sans claim iat", async () => {
    const A = await createOrg("Invit jeton direct");
    const m = await createMember(A, "admin");
    const [row] = await as({ sub: m }, (q) => q("select array(select private.member_org_ids()) as ids"));
    expect(row.ids).toEqual([A.id]);
  });
});
