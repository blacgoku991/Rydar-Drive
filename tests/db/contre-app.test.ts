import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { as, createAuthUser, createDriver, createOrg, expectPgError, insertRideBypass, pool, sql, type Org } from "./helpers";

// Contre-audit « app » (migration 20260924005500) : commissions encore dues rappelées avant la suppression du compte,
// quel que soit l'état du chauffeur ou de sa centrale, et sans session (app_worker#2).

type Row = Record<string, any>;

afterAll(async () => {
  await pool.end();
});

/** RPC du chauffeur connecté (jeton de l'app). */
const mine = async (sub: string) => {
  const [row] = await as({ sub }, (q) => q(`select public.driver_deletion_debt() as r`));
  return row.r as Row | null;
};
/** Route /api/driver/delete-account (aperçu), compte vérifié par jeton ou mot de passe : service role. */
const svc = async (userId: string | null) => {
  const [row] = await as({ role: "service_role" }, (q) => q(`select public.svc_driver_deletion_debt($1) as r`, [userId]));
  return row.r as Row | null;
};

async function centrale(name: string) {
  const org = await createOrg(name);
  await sql(`update public.organizations set dispatch_model = 'centrale' where id = $1`, [org.id]);
  return org;
}

/** Règlement d'une course terminée (commission due par le chauffeur, ou part due par la centrale). */
async function settlement(org: Org, driverId: string, cents: number, status: string, direction = "driver_owes") {
  const ride = await insertRideBypass(org, { status: "COMPLETED", driver_id: driverId, pickup_at: new Date(), payment_method: "cash" });
  await sql(
    `insert into public.ride_settlements (organization_id, ride_id, driver_id, driver_label, direction, amount_cents, price_cents,
       commission_cents, driver_payout_cents, payment_method, reference, status, due_at, declared_at, settled_at)
     values ($1, $2, $3, 'Chauffeur Test', $4, $5, 5000, $5, 5000 - $5, 'cash', $6, $7, now() - interval '1 day',
       case when $7 = 'declared' then now() end, case when $7 in ('paid', 'waived') then now() end)`,
    [org.id, ride, driverId, direction, cents, `CA-${randomUUID().slice(0, 8)}`, status],
  );
}

describe("Commissions dues avant la suppression du compte (app_worker#2)", () => {
  it("chauffeur suspendu, banni, désactivé ou centrale suspendue : driver_settlements refusé, montant dû toujours lisible", async () => {
    const org = await centrale("Contre app dette");
    const d = await createDriver(org, { presence: "offline" });
    // À régler 2 600 + contesté 400 ; signalé payé 1 200 ; hors dette : payé, abandonné, montant nul, part due par la centrale
    await settlement(org, d.id, 2600, "due");
    await settlement(org, d.id, 400, "disputed");
    await settlement(org, d.id, 1200, "declared");
    await settlement(org, d.id, 999, "paid");
    await settlement(org, d.id, 777, "waived");
    await settlement(org, d.id, 0, "due");
    await settlement(org, d.id, 5000, "due", "centrale_owes");
    const expected = { owed_cents: 3000, declared_cents: 1200, currency: "EUR", organization: "Contre app dette" };

    // Actif : mêmes montants que le relevé des commissions
    expect(await mine(d.userId)).toEqual(expected);
    const [{ r: settlements }] = await as({ sub: d.userId }, (q) => q(`select public.driver_settlements(1) as r`));
    expect(settlements.summary).toMatchObject({ owed_cents: 3000, declared_cents: 1200 });

    // Suspendu : le relevé est refusé (défaut constaté), le montant dû reste lisible (jeton de l'app)
    await sql(`update public.drivers set status = 'suspended' where id = $1`, [d.id]);
    const refused = await expectPgError(as({ sub: d.userId }, (q) => q(`select public.driver_settlements(1)`)));
    expect(refused.message).toMatch(/FORBIDDEN/);
    expect(await mine(d.userId)).toEqual(expected);

    // Banni, désactivé, centrale suspendue : idem ; sans session (écran de connexion) : par la route (service role)
    await sql(`update public.drivers set banned_at = now() where id = $1`, [d.id]);
    expect(await mine(d.userId)).toEqual(expected);
    await sql(`update public.drivers set banned_at = null, status = 'inactive' where id = $1`, [d.id]);
    expect(await mine(d.userId)).toEqual(expected);
    await sql(`update public.drivers set status = 'active' where id = $1`, [d.id]);
    await sql(`update public.organizations set status = 'suspended' where id = $1`, [org.id]);
    expect(await mine(d.userId)).toEqual(expected);
    expect(await svc(d.userId)).toEqual(expected);
  });

  it("rien de dû : montants nuls ; aucune fiche chauffeur, ou fiche supprimée : null", async () => {
    const org = await centrale("Contre app sans dette");
    const d = await createDriver(org, { presence: "offline" });
    await settlement(org, d.id, 1500, "paid");
    expect(await mine(d.userId)).toEqual({ owed_cents: 0, declared_cents: 0, currency: "EUR", organization: "Contre app sans dette" });
    // Gérant sans fiche chauffeur, compte inconnu, appel sans compte
    expect(await mine(org.ownerId)).toBeNull();
    expect(await svc(randomUUID())).toBeNull();
    expect(await svc(null)).toBeNull();

    await settlement(org, d.id, 900, "due");
    const [{ r: deleted }] = await as({ role: "service_role" }, (q) => q(`select public.svc_delete_driver_account($1) as r`, [d.userId]));
    expect(deleted).toMatchObject({ ok: true });
    // Fiche anonymisée et détachée du compte : plus rien à rappeler à ce compte
    expect(await mine(d.userId)).toBeNull();
    expect(await svc(d.userId)).toBeNull();
  });

  it("chacun sa dette : aucun paramètre côté app, service role seul pour un compte désigné, anonyme refusé", async () => {
    const org = await centrale("Contre app accès");
    const d = await createDriver(org, { presence: "offline" });
    await settlement(org, d.id, 2500, "due");
    const other = await createDriver(org, { presence: "offline" });
    // Un autre chauffeur, le gérant ou un compte quelconque ne lisent que leur propre dette
    expect(await mine(other.userId)).toMatchObject({ owed_cents: 0, declared_cents: 0 });
    expect(await mine(org.ownerId)).toBeNull();
    expect(await mine(await createAuthUser(`x-${randomUUID().slice(0, 6)}@test.dev`, "X"))).toBeNull();

    for (const who of [{ sub: other.userId }, { sub: org.ownerId }]) {
      const e = await expectPgError(as(who, (q) => q(`select public.svc_driver_deletion_debt($1)`, [d.userId])));
      expect(e.message).toMatch(/permission denied/);
    }
    for (const call of [`select public.driver_deletion_debt()`, `select public.svc_driver_deletion_debt('${d.userId}')`]) {
      const e = await expectPgError(as({ role: "anon" }, (q) => q(call)));
      expect(e.message, call).toMatch(/permission denied/);
    }
    const helper = await expectPgError(as({ sub: d.userId }, (q) => q(`select private.driver_deletion_debt($1)`, [d.userId])));
    expect(helper.message).toMatch(/permission denied/);
  });
});
