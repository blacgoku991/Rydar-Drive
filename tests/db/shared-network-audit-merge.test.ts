// Réseau partagé × audit d'octobre 2026 (20260924006650_audit_fixes.sql, appliquée AVANT les migrations réseau) :
// les corrections de l'audit restent vraies sur les chemins réseau (acceptation rejouée d'une offre partenaire), et les
// fonctions nouvelles de l'audit respectent les règles du réseau (20260924007200, section 3) : bannissement plateforme
// d'un partenaire qui tient une course de A (rendue par private.unassign_network_ride, jamais un UPDATE direct),
// suspension d'une organisation dont un chauffeur est en route pour A (DRIVER_ON_RIDE).
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDriver, createOrg, pool, setSharedNetwork, sql } from "./helpers";
import { networkPair, partnerAccepts, rpc, siteMaker, stepAs, superAdmin, svc } from "./network-fixtures";

afterAll(async () => {
  await setSharedNetwork(false);
  await pool.end();
});

beforeEach(async () => {
  await setSharedNetwork(true);
});

const nextSite = siteMaker(80);

describe("Réseau partagé et audit 006650", () => {
  it("acceptation rejouée d'une offre partenaire : succès, pas « Course déjà attribuée. »", async () => {
    const p = await networkPair(nextSite());
    const { ride } = await partnerAccepts(p);
    const [offer] = await sql(`select id from public.ride_offers where ride_id = $1 and driver_id = $2 and status = 'accepted'`, [
      ride.id, p.partner.id,
    ]);
    expect(await rpc(p.partner.userId, "accept_ride_offer", [offer.id])).toMatchObject({ ok: true, code: "ACCEPTED", ride_id: ride.id });
    expect(await sql(`select 1 from public.ride_network_executions where ride_id = $1`, [ride.id])).toHaveLength(1);
  });

  it("bannissement plateforme du partenaire : course de A rendue (« executor_unavailable »), journal de A sans son nom", async () => {
    const p = await networkPair(nextSite());
    const { ride, execution } = await partnerAccepts(p);
    // Fiche jumelle (même téléphone) bannie par une autre centrale, signalée à la plateforme
    const C = await createOrg("Centrale signalante");
    await sql(`update public.organizations set dispatch_model = 'centrale' where id = $1`, [C.id]);
    const twin = await createDriver(C);
    await sql(`update public.drivers set phone = (select phone from public.drivers where id = $2) where id = $1`, [twin.id, p.partner.id]);
    const ban = await rpc(C.ownerId, "ban_driver", [twin.id, "Fraude avérée", "fraud", true, false]);
    expect(ban).toMatchObject({ ok: true, code: "BANNED" });

    const res = await svc("svc_platform_ban", [ban.report_id, await superAdmin(), null, [p.partner.id]]);
    expect(res).toMatchObject({ ok: true, code: "PLATFORM_BANNED", reassigned_rides: 1 });
    const [r] = await sql(`select status, driver_id, driver_org_id, network_at from public.rides where id = $1`, [ride.id]);
    expect(r.driver_id).toBeNull();
    expect(r.network_at).toBeNull();
    expect(["SEARCHING_DRIVER", "OFFERED", "CREATED"]).toContain(r.status);
    const [e] = await sql(`select ended_at, end_reason from public.ride_network_executions where id = $1`, [execution.id]);
    expect(e.ended_at).not.toBeNull();
    expect(e.end_reason).toBe("executor_unavailable");
    expect((await sql(`select ban_scope, current_ride_id from public.drivers where id = $1`, [p.partner.id]))[0])
      .toEqual({ ban_scope: "platform", current_ride_id: null });
    const events = await sql(`select type, message, data from public.ride_events where ride_id = $1`, [ride.id]);
    expect(events.map((x) => x.type)).toContain("ride.network_unassigned");
    expect(JSON.stringify(events)).not.toContain("Tazi");
    expect(JSON.stringify(events)).not.toContain(p.partner.id);
  });

  it("suspension de B refusée tant que son chauffeur est en route pour A (DRIVER_ON_RIDE)", async () => {
    const p = await networkPair(nextSite());
    const { ride } = await partnerAccepts(p);
    expect(await stepAs(p.partner, ride.id, "DRIVER_EN_ROUTE")).toMatchObject({ ok: true });
    const sa = await superAdmin();
    expect(await svc("svc_platform_set_org_status", [p.B.id, sa, "suspended", "Contrôle"])).toMatchObject({
      ok: false, code: "DRIVER_ON_RIDE", count: 1,
    });
    expect((await sql(`select status from public.organizations where id = $1`, [p.B.id]))[0].status).toBe("active");
    // A aussi (course de A tenue par le partenaire : déjà comptée avant le réseau)
    expect(await svc("svc_platform_set_org_status", [p.A.id, sa, "suspended", "Contrôle"])).toMatchObject({
      ok: false, code: "DRIVER_ON_RIDE", count: 1,
    });
  });
});
