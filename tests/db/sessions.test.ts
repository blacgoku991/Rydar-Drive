import { afterAll, describe, expect, it } from "vitest";
import { as, createAuthUser, createDriver, createOrg, expectPgError, pool, sql } from "./helpers";

afterAll(async () => {
  await pool.end();
});

/** Simule une session Supabase Auth ouverte (session + refresh token). */
async function openSession(userId: string) {
  await sql("insert into auth.sessions (user_id) values ($1)", [userId]);
  await sql("insert into auth.refresh_tokens (token, user_id, revoked) values ($1, $2, false)", [`rt-${userId}-${Math.random()}`, userId]);
}
async function sessionCount(userId: string) {
  const [{ s }] = await sql("select count(*)::int as s from auth.sessions where user_id = $1", [userId]);
  const [{ t }] = await sql("select count(*)::int as t from auth.refresh_tokens where user_id = $1::text", [userId]);
  return s + t;
}

describe("Révocation des sessions", () => {
  it("suspendre un chauffeur ferme toutes ses sessions", async () => {
    const org = await createOrg("Sess Driver");
    const d = await createDriver(org);
    await openSession(d.userId);
    await openSession(d.userId);
    expect(await sessionCount(d.userId)).toBe(4);

    await as({ sub: org.ownerId }, (q) => q("update public.drivers set status = 'suspended' where id = $1", [d.id]));
    expect(await sessionCount(d.userId)).toBe(0);
  });

  it("retirer un membre de l'organisation ferme ses sessions", async () => {
    const org = await createOrg("Sess Member");
    const userId = await createAuthUser(`dispatch-${Date.now()}@test.dev`, "Dispatch");
    await sql("insert into public.organization_users (organization_id, user_id, role) values ($1, $2, 'dispatcher')", [org.id, userId]);
    await openSession(userId);
    await sql("delete from public.organization_users where organization_id = $1 and user_id = $2", [org.id, userId]);
    expect(await sessionCount(userId)).toBe(0);
  });

  it("suspendre une organisation ferme les sessions de ses chauffeurs et membres, pas celles d'un membre d'une autre organisation active", async () => {
    const A = await createOrg("Sess Org A");
    const B = await createOrg("Sess Org B");
    const d = await createDriver(A);
    const shared = await createAuthUser(`shared-${Date.now()}@test.dev`, "Multi");
    await sql("insert into public.organization_users (organization_id, user_id, role) values ($1, $3, 'admin'), ($2, $3, 'admin')", [A.id, B.id, shared]);
    for (const u of [d.userId, A.ownerId, shared]) await openSession(u);

    await sql("update public.organizations set status = 'suspended' where id = $1", [A.id]);
    expect(await sessionCount(d.userId)).toBe(0);
    expect(await sessionCount(A.ownerId)).toBe(0);
    expect(await sessionCount(shared)).toBe(2); // toujours actif chez B
  });

  it("« Déconnecter tous les appareils » : owner/admin uniquement, jamais une autre organisation", async () => {
    const A = await createOrg("Sess RPC A");
    const B = await createOrg("Sess RPC B");
    const d = await createDriver(A);
    const dispatcher = await createAuthUser(`disp-${Date.now()}@test.dev`, "Disp");
    await sql("insert into public.organization_users (organization_id, user_id, role) values ($1, $2, 'dispatcher')", [A.id, dispatcher]);
    await openSession(d.userId);

    for (const sub of [B.ownerId, dispatcher, d.userId]) {
      const err = await expectPgError(as({ sub }, (q) => q("select public.revoke_driver_sessions($1)", [d.id])));
      expect(err.code).toBe("42501");
    }
    expect(await sessionCount(d.userId)).toBe(2);

    const [{ r }] = await as({ sub: A.ownerId }, (q) => q("select public.revoke_driver_sessions($1) as r", [d.id]));
    expect(r).toEqual({ ok: true, revoked: 2 });
    expect(await sessionCount(d.userId)).toBe(0);
    const [log] = await sql("select action, severity from public.audit_logs where entity_id = $1 and action = 'driver.sessions_revoked'", [d.id]);
    expect(log).toEqual({ action: "driver.sessions_revoked", severity: "warning" });
  });
});
