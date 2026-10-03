// Audit qualité / sécurité d'octobre 2026 (20260924006650_audit_fixes.sql) : droits directs retirés, insertions
// bornées, conservation, attribution d'un chauffeur bloqué, acceptation rejouée, bannissement plateforme, statut d'une
// organisation, conditions de paiement, file des notifications.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  CHAMPS_ELYSEES, DB_URL, as, createAuthUser, createDriver, createMember, createOrg, createRideAsOwner, expectPgError,
  insertRideBypass, north, pool, rideState, sql, type Driver, type Org,
} from "./helpers";

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
async function superAdmin() {
  const sa = await createAuthUser(`super-${randomUUID().slice(0, 6)}@rydar.dev`, "Super Admin");
  await sql(`update public.users set is_super_admin = true where id = $1`, [sa]);
  return sa;
}
async function centrale(name: string) {
  const org = await createOrg(name);
  await sql("update public.organizations set dispatch_model = 'centrale' where id = $1", [org.id]);
  return org;
}
/** Commission « à régler » échue (le chauffeur est bloqué si la centrale bloque les impayés). */
async function dueSettlement(org: Org, d: Driver, amount = 1500) {
  const ride = await insertRideBypass(org, { status: "COMPLETED", driver_id: d.id, vehicle_id: d.vehicleId, completed_at: new Date() });
  await sql(
    `insert into public.ride_settlements (organization_id, ride_id, driver_id, driver_label, direction, amount_cents, price_cents,
       commission_cents, platform_fee_cents, driver_payout_cents, payment_method, reference, due_at)
     values ($1, $2, $3, 'Audit (#1)', 'driver_owes', $4, 5000, $4, 0, 5000 - $4, 'cash', 'C1', now() - interval '1 hour')`,
    [org.id, ride, d.id, amount],
  );
}

describe("Droits directs retirés (sql-rls-1, -3, -4)", () => {
  it("fiche chauffeur : ni suppression ni changement de statut par l'API, même par l'owner", async () => {
    const A = await createOrg("Audit droits fiche");
    const d = await createDriver(A, { presence: "on_trip" });
    expect((await expectPgError(as({ sub: A.ownerId }, (q) => q("delete from public.drivers where id = $1", [d.id])))).code).toBe("42501");
    expect((await expectPgError(as({ sub: A.ownerId }, (q) => q("update public.drivers set status = 'suspended' where id = $1", [d.id])))).code)
      .toBe("42501");
    // Le reste de la fiche reste modifiable (formulaire « Modifier le chauffeur »)
    expect(await as({ sub: A.ownerId }, (q) => q("update public.drivers set notes = 'ok' where id = $1 returning id", [d.id]))).toHaveLength(1);
    expect((await sql("select status from public.drivers where id = $1", [d.id]))[0].status).toBe("active");
  });

  it("justificatifs : ajout aux règles de l'action serveur, ni modification ni suppression directes", async () => {
    const C = await createOrg("Audit justificatifs");
    const disp = await createMember(C, "dispatcher");
    const d = await createDriver(C);
    const insert = (fields: Row) =>
      as({ sub: disp }, (q) =>
        q(`insert into public.driver_documents (organization_id, driver_id, type, status, expires_at, file_path)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [C.id, d.id, fields.type, fields.status ?? "valid", fields.expires_at ?? null, fields.file_path ?? null]));
    // Pièce obligatoire sans échéance, déjà expirée, « en attente », fichier d'un autre chauffeur : refusés
    for (const bad of [
      { type: "driving_license" },
      { type: "vtc_card", expires_at: "2020-01-01" },
      { type: "other", status: "pending" },
      { type: "other", file_path: `${C.id}/${randomUUID()}/x.jpg` },
    ]) {
      expect((await expectPgError(insert(bad))).code, JSON.stringify(bad)).toBe("42501");
    }
    const [ok] = await insert({ type: "vtc_card", expires_at: "2031-01-01", file_path: `${C.id}/${d.id}/vtc.jpg` });
    expect(ok.id).toBeTruthy();
    expect((await expectPgError(as({ sub: disp }, (q) => q("update public.driver_documents set status = 'valid' where id = $1", [ok.id])))).code)
      .toBe("42501");
    expect((await expectPgError(as({ sub: C.ownerId }, (q) => q("delete from public.driver_documents where id = $1", [ok.id])))).code)
      .toBe("42501");
  });
});

describe("Insertions bornées (sql-rls-5, -6)", () => {
  it("relance manuelle : deux appels simultanés n'envoient qu'une relance", async () => {
    const E = await centrale("Audit relance concurrente");
    const disp = await createMember(E, "dispatcher");
    const d = await createDriver(E);
    await dueSettlement(E, d);
    const open = async () => {
      const c = new pg.Client({ connectionString: DB_URL });
      await c.connect();
      await c.query("begin");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: disp, role: "authenticated" })]);
      await c.query("set local role authenticated");
      return c;
    };
    const c1 = await open();
    const c2 = await open();
    try {
      const r1 = (await c1.query("select public.remind_driver_settlements($1) as r", [d.id])).rows[0].r;
      const p2 = c2.query("select public.remind_driver_settlements($1) as r", [d.id]);
      await new Promise((r) => setTimeout(r, 300));
      await c1.query("commit");
      const r2 = (await p2).rows[0].r;
      await c2.query("commit");
      expect(r1).toMatchObject({ ok: true, code: "REMINDED" });
      expect(r2).toMatchObject({ ok: false, code: "RATE_LIMITED" });
      expect(await sql("select 1 from public.notifications where driver_id = $1 and type = 'settlement_reminder'", [d.id])).toHaveLength(1);
    } finally {
      await c1.end().catch(() => undefined);
      await c2.end().catch(() => undefined);
    }
  });

  it("acceptations légales : 50 versions au plus par compte ; appareils : 20 nouvelles installations par 24 h", async () => {
    const F = await createOrg("Audit insertions");
    const d = await createDriver(F);
    const accept = (v: string) => rpc(d.userId, "accept_legal_documents", [["cgu", "privacy"], v]);
    for (let i = 0; i < 50; i++) {
      expect((await accept(new Date(Date.UTC(2001, 0, 1) + i * 86_400_000).toISOString().slice(0, 10))).ok).toBe(true);
    }
    expect(await accept("2010-01-01")).toMatchObject({ ok: false, code: "TOO_MANY_VERSIONS" });
    expect((await accept("2001-01-01")).ok).toBe(true); // déjà acceptée : idempotent
    expect((await sql("select count(*)::int as n from public.legal_acceptances where user_id = $1", [d.userId]))[0].n).toBe(100);

    for (let i = 0; i < 20; i++) {
      expect((await rpc(d.userId, "driver_register_device", [`install-${i}-${randomUUID()}`, "android"])).ok).toBe(true);
    }
    expect(await rpc(d.userId, "driver_register_device", [`install-x-${randomUUID()}`, "android"])).toMatchObject({ ok: false, code: "TOO_MANY_DEVICES" });
    const [known] = await sql("select installation_id from public.driver_devices where driver_id = $1 limit 1", [d.id]);
    expect((await rpc(d.userId, "driver_register_device", [known.installation_id, "android"])).ok).toBe(true);
  });
});

describe("Données personnelles (sql-rls-7, -8, super-admin-8)", () => {
  it("dernière position : purgée par le ménage après 30 jours sans envoi", async () => {
    const G = await createOrg("Audit position");
    const old = await createDriver(G, { presence: "offline", at: [48.85, 2.35], locationAgeSeconds: 31 * 86_400 });
    const fresh = await createDriver(G, { at: [48.85, 2.35] });
    const res = (await sql("select private.housekeeping() as r"))[0].r;
    expect(res.last_positions_purged).toBeGreaterThanOrEqual(1);
    expect(await sql("select 1 from public.driver_locations where driver_id = $1", [old.id])).toHaveLength(0);
    expect(await sql("select 1 from public.driver_locations where driver_id = $1", [fresh.id])).toHaveLength(1);
  });

  it("chauffeur : courses terminées lisibles 24 h, pas l'historique de ses clients", async () => {
    const H = await createOrg("Audit clients");
    const d = await createDriver(H);
    const recent = await insertRideBypass(H, { status: "COMPLETED", driver_id: d.id, vehicle_id: d.vehicleId, completed_at: new Date() });
    const past = await insertRideBypass(H, { status: "COMPLETED", driver_id: d.id, vehicle_id: d.vehicleId, completed_at: new Date() });
    // updated_at est tenu par un déclencheur : vieilli sans déclencheurs
    await sql(`begin; set local session_replication_role = replica;
      update public.rides set updated_at = now() - interval '30 days' where id = '${past}'; commit;`);
    const ids = (await as({ sub: d.userId }, (q) => q("select id from public.rides where driver_id = $1", [d.id]))).map((r) => r.id);
    expect(ids).toEqual([recent]);
  });

  it("journal : les lignes du super admin (IP, comptes d'autres centrales) ne sont pas lues par la centrale", async () => {
    const A = await createOrg("Audit journal");
    await sql(
      `insert into public.audit_logs (organization_id, actor_type, action, entity_type, ip, metadata)
       values ($1, 'super_admin', 'fraud_report.platform_banned', 'fraud_reports', '203.0.113.7', '{"user_ids":["x"]}'),
              ($1, 'user', 'driver.updated', 'drivers', null, '{}')`,
      [A.id],
    );
    const rows = await as({ sub: A.ownerId }, (q) => q("select actor_type from public.audit_logs where organization_id = $1", [A.id]));
    expect(rows.map((r) => r.actor_type)).toContain("user");
    expect(rows.map((r) => r.actor_type)).not.toContain("super_admin");
  });
});

describe("Attribution et acceptation (tableau-de-bord-10, app-chauffeur-9)", () => {
  it("centrale : un chauffeur bloqué (commission échue) ne reçoit pas la course par attribution manuelle", async () => {
    const C = await centrale("Audit attribution bloqué");
    const blocked = await createDriver(C);
    const free = await createDriver(C);
    await dueSettlement(C, blocked);
    const ride = await insertRideBypass(C, { status: "NO_DRIVER_FOUND", pickup_at: new Date(Date.now() + 3600_000) });
    expect(await rpc(C.ownerId, "assign_ride", [ride, blocked.id])).toMatchObject({ ok: false, code: "DRIVER_BLOCKED", reason: "unpaid" });
    expect(await rpc(C.ownerId, "assign_ride", [ride, free.id])).toMatchObject({ ok: true, code: "ASSIGNED" });
  });

  it("acceptation rejouée par le même chauffeur : succès, pas « Course déjà attribuée. »", async () => {
    const org = await createOrg("Audit acceptation rejouée");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 300) });
    const ride = await createRideAsOwner(org);
    const offer = (await rideState(ride.id)).offers.find((o) => o.driver_id === d.id)!;
    expect(await rpc(d.userId, "accept_ride_offer", [offer.id])).toMatchObject({ ok: true, code: "ACCEPTED" });
    expect(await rpc(d.userId, "accept_ride_offer", [offer.id])).toMatchObject({ ok: true, code: "ACCEPTED", ride_id: ride.id });
    expect(await sql("select 1 from public.ride_assignments where ride_id = $1", [ride.id])).toHaveLength(1);
  });
});

describe("Bannissement plateforme (super-admin-1, -7)", () => {
  async function bannedWithTwin(name: string) {
    const A = await centrale(`${name} A`);
    const B = await centrale(`${name} B`);
    const phone = `06${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const x = await createDriver(A);
    const y = await createDriver(B);
    await sql("update public.drivers set phone = $2 where id = any ($1)", [[x.id, y.id], phone]);
    const ban = await rpc(A.ownerId, "ban_driver", [x.id, "Fraude avérée", "fraud", true, false]);
    expect(ban).toMatchObject({ ok: true, code: "BANNED" });
    return { A, B, x, y, report: ban.report_id as string };
  }

  it("fiche confirmée : client à bord → refus sans rien écrire ; course attribuée à venir → remise en recherche", async () => {
    const { B, y, report } = await bannedWithTwin("Audit ban courses");
    const sa = await superAdmin();
    const onboard = await insertRideBypass(B, { status: "IN_PROGRESS", driver_id: y.id, vehicle_id: y.vehicleId });
    expect(await svc("svc_platform_ban", [report, sa, null, [y.id]])).toMatchObject({ ok: false, code: "DRIVER_ON_RIDE" });
    expect((await sql("select status from public.fraud_reports where id = $1", [report]))[0].status).toBe("open");

    await sql("update public.rides set status = 'COMPLETED', completed_at = now() where id = $1", [onboard]);
    const later = await insertRideBypass(B, {
      status: "ACCEPTED", type: "scheduled", driver_id: y.id, vehicle_id: y.vehicleId, pickup_at: new Date(Date.now() + 86_400_000),
    });
    expect(await svc("svc_platform_ban", [report, sa, null, [y.id]])).toMatchObject({ ok: true, code: "PLATFORM_BANNED", reassigned_rides: 1 });
    const [r] = await sql("select status, driver_id from public.rides where id = $1", [later]);
    expect(r.driver_id).toBeNull();
    expect(["SEARCHING_DRIVER", "OFFERED", "CREATED"]).toContain(r.status);
    expect((await sql("select ban_scope, current_ride_id from public.drivers where id = $1", [y.id]))[0])
      .toEqual({ ban_scope: "platform", current_ride_id: null });
  });

  it("bannissement levé par la centrale : signalement classé, plus de bannissement plateforme", async () => {
    const { A, x, report } = await bannedWithTwin("Audit ban levé");
    expect(await rpc(A.ownerId, "lift_driver_ban", [x.id, "Erreur"])).toMatchObject({ ok: true, code: "LIFTED" });
    expect((await sql("select status from public.fraud_reports where id = $1", [report]))[0].status).toBe("dismissed");
    // Signalement remis « à examiner » à la main : la plateforme refuse encore (fiche plus bannie)
    await sql("update public.fraud_reports set status = 'open' where id = $1", [report]);
    expect(await svc("svc_platform_ban", [report, await superAdmin(), null, []])).toMatchObject({ ok: false, code: "REPORTED_DRIVER_NOT_BANNED" });
  });
});

describe("Organisation suspendue (super-admin-5) et conditions de paiement (super-admin-6)", () => {
  it("suspension refusée pendant une course ; ensuite : offres fermées, dispatch arrêté pour ses courses", async () => {
    const org = await createOrg("Audit suspension");
    const sa = await superAdmin();
    const d = await createDriver(org, { presence: "on_trip" });
    const onboard = await insertRideBypass(org, { status: "IN_PROGRESS", driver_id: d.id, vehicle_id: d.vehicleId });
    expect(await svc("svc_platform_set_org_status", [org.id, sa, "suspended", "Impayé"])).toMatchObject({ ok: false, code: "DRIVER_ON_RIDE", count: 1 });
    expect((await sql("select status from public.organizations where id = $1", [org.id]))[0].status).toBe("active");

    await sql("update public.rides set status = 'COMPLETED', completed_at = now() where id = $1", [onboard]);
    const waiting = await insertRideBypass(org, { status: "SEARCHING_DRIVER", next_dispatch_at: new Date(Date.now() - 5_000), dispatch_started_at: new Date() });
    expect(await svc("svc_platform_set_org_status", [org.id, sa, "suspended", "Impayé"])).toMatchObject({ ok: true, code: "UPDATED" });
    expect((await sql("select status, suspended_reason from public.organizations where id = $1", [org.id]))[0])
      .toEqual({ status: "suspended", suspended_reason: "Impayé" });
    expect((await sql("select presence from public.drivers where id = $1", [d.id]))[0].presence).toBe("offline");
    const before = (await sql("select next_dispatch_at from public.rides where id = $1", [waiting]))[0].next_dispatch_at;
    await sql("select private.dispatch_tick()");
    expect((await sql("select next_dispatch_at from public.rides where id = $1", [waiting]))[0].next_dispatch_at).toEqual(before);
    expect(await sql("select 1 from public.audit_logs where organization_id = $1 and action = 'organization.suspended'", [org.id])).toHaveLength(1);
    expect(await svc("svc_platform_set_org_status", [org.id, sa, "active", null])).toMatchObject({ ok: true });
    expect((await sql("select status, suspended_reason from public.organizations where id = $1", [org.id]))[0])
      .toEqual({ status: "active", suspended_reason: null });
  });

  it("délai raccourci, cycle hebdomadaire ou blocage ajouté : accord écrit obligatoire", async () => {
    const org = await centrale("Audit conditions");
    const sa = await superAdmin();
    expect(await svc("svc_platform_terms", [org.id, sa, "weekly", 5, null])).toMatchObject({ ok: false, code: "CONSENT_REQUIRED", field: "consentNote" });
    expect(await svc("svc_platform_terms", [org.id, sa, "monthly", 2, 10])).toMatchObject({ ok: false, code: "CONSENT_REQUIRED" });
    expect(await svc("svc_platform_terms", [org.id, sa, "monthly", 2, 10, "Accord écrit reçu par e-mail le 02/10"])).toMatchObject({ ok: true });
    // Changement favorable : sans note
    expect(await svc("svc_platform_terms", [org.id, sa, "monthly", 10, null])).toMatchObject({ ok: true });
    const [log] = await sql(
      `select severity, metadata from public.audit_logs where organization_id = $1 and action = 'platform_fee.terms_changed' order by created_at, id limit 1`,
      [org.id],
    );
    expect(log).toMatchObject({ severity: "warning", metadata: { unfavorable: true, consent_note: "Accord écrit reçu par e-mail le 02/10" } });
  });
});

describe("File des notifications (worker-perf-2)", () => {
  it("offre GPS d'une course immédiate prise avant une rafale d'offres planifiées", async () => {
    const org = await createOrg("Audit file");
    const d = await createDriver(org);
    await sql("update public.notifications set status = 'cancelled' where status = 'queued'");
    for (let i = 0; i < 5; i++) {
      await sql(`select private.queue_notification($1, $2, null, null, 'ride_offer_scheduled', 'PLANIFIÉE', 'x', '{}'::jsonb, 'high', null)`, [org.id, d.id]);
    }
    await sql(`select private.queue_notification($1, $2, null, null, 'ride_offer', 'NOUVELLE COURSE', 'x', '{}'::jsonb, 'high', null)`, [org.id, d.id]);
    const [first] = await sql("select type from private.claim_notifications(1)");
    expect(first.type).toBe("ride_offer");
  });
});
