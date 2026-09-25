import { afterAll, describe, expect, it } from "vitest";
import {
  ago, as, CHAMPS_ELYSEES, createDriver, createOrg, createRideAsOwner, expectPgError, insertRideBypass, north, pool, rideState, sql,
} from "./helpers";

afterAll(async () => {
  await pool.end();
});

const DAY = 86_400;

describe("Indicateurs du dashboard", () => {
  it("org_ride_counts : compteurs des filtres, historique borné, courses actives toujours comptées", async () => {
    const org = await createOrg("Counts");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 700) });

    // r1 : proposée puis acceptée ; r2 : personne de libre ; r3 : planifiée demain
    const r1 = await createRideAsOwner(org);
    const { offers } = await rideState(r1.id);
    await as({ sub: d.userId }, (q) => q("select public.accept_ride_offer($1)", [offers[0].id]));
    const r2 = await createRideAsOwner(org);
    const r3 = await createRideAsOwner(org, { pickup_at: new Date(Date.now() + DAY * 1000) });
    expect(r3.type).toBe("scheduled");
    expect((await rideState(r2.id)).ride.status).toBe("SEARCHING_DRIVER");

    // Historique : terminée il y a 2 j, annulée hier, terminée il y a 20 j
    await insertRideBypass(org, { status: "COMPLETED", pickup_at: ago(2 * DAY), driver_id: d.id });
    await insertRideBypass(org, { status: "CANCELLED", pickup_at: ago(DAY) });
    await insertRideBypass(org, { status: "COMPLETED", pickup_at: ago(20 * DAY) });

    const counts = async (sinceDays: number) =>
      (await as({ sub: org.ownerId }, (q) => q("select public.org_ride_counts($1, $2) as c", [org.id, ago(sinceDays * DAY)])))[0].c;

    const week = await counts(7);
    expect(week.all).toBe(5);
    expect(week.instant).toBe(4);
    expect(week.scheduled).toBe(1);
    expect(week.assigned).toBe(1);
    expect(week.completed).toBe(1);
    expect(week.cancelled).toBe(1);
    expect(week.searching + week.offered).toBe(2); // r2 + r3 (selon la flotte disponible)
    expect(week.ongoing).toBe(0);

    const month = await counts(30);
    expect(month.all).toBe(6);
    expect(month.completed).toBe(2);
  });

  it("org_driver_metrics : taux d'acceptation, courses et CA par chauffeur sur la fenêtre", async () => {
    const org = await createOrg("Metrics");
    const fast = await createDriver(org, { firstName: "Fast", at: north(CHAMPS_ELYSEES, 300) });
    const slow = await createDriver(org, { firstName: "Slow", at: north(CHAMPS_ELYSEES, 1200) });

    // r1 proposée aux deux, Fast accepte (l'offre de Slow est fermée, non comptée comme refus)
    const r1 = await createRideAsOwner(org);
    const o1 = (await rideState(r1.id)).offers.find((o) => o.driver_id === fast.id)!;
    await as({ sub: fast.userId }, (q) => q("select public.accept_ride_offer($1)", [o1.id]));
    // r2 : seul Slow est libre et refuse
    const r2 = await createRideAsOwner(org);
    const o2 = (await rideState(r2.id)).offers.find((o) => o.driver_id === slow.id)!;
    await as({ sub: slow.userId }, (q) => q("select public.decline_ride_offer($1)", [o2.id]));

    await insertRideBypass(org, { status: "COMPLETED", driver_id: fast.id, price_cents: 8000, pickup_at: ago(2 * DAY) });
    await insertRideBypass(org, { status: "COMPLETED", driver_id: fast.id, price_cents: 9900, pickup_at: ago(40 * DAY) }); // hors fenêtre
    await insertRideBypass(org, { status: "CANCELLED", driver_id: slow.id, pickup_at: ago(3 * DAY) });

    const rows = await as({ sub: org.ownerId }, (q) => q("select * from public.org_driver_metrics($1, 30)", [org.id]));
    const m = (id: string) => rows.find((r) => r.driver_id === id)!;
    expect(rows).toHaveLength(2);

    expect(m(fast.id)).toMatchObject({ offers: "1", accepted: "1", declined: "0", completed: "1", cancelled: "0", revenue_cents: "8000" });
    expect(Number(m(fast.id).acceptance_rate)).toBe(1);

    expect(m(slow.id)).toMatchObject({ offers: "2", accepted: "0", declined: "1", completed: "0", cancelled: "1", revenue_cents: "0" });
    expect(Number(m(slow.id).acceptance_rate)).toBe(0);
  });

  it("offre ignorée puis prise par un collègue : comptée « manquée » (pas un 100 % d'acceptation)", async () => {
    const org = await createOrg("Missed");
    const near = await createDriver(org, { firstName: "Near", at: north(CHAMPS_ELYSEES, 1000) });
    const mid = await createDriver(org, { firstName: "Mid", at: north(CHAMPS_ELYSEES, 6000) });
    const ride = await createRideAsOwner(org);
    // Near laisse passer sa fenêtre : l'offre est prolongée à la vague suivante, Mid est sollicité
    await sql("update public.rides set next_dispatch_at = now() - interval '1 second' where id = $1", [ride.id]);
    await sql("select private.dispatch_tick()");
    const offers = (await rideState(ride.id)).offers;
    const midOffer = offers.find((o) => o.driver_id === mid.id)!;
    await as({ sub: mid.userId }, (q) => q("select public.accept_ride_offer($1)", [midOffer.id]));

    const rows = await sql("select driver_id, status, closed_reason, missed_at from public.ride_offers where ride_id = $1", [ride.id]);
    const byDriver = Object.fromEntries(rows.map((r) => [r.driver_id, r]));
    expect(byDriver[near.id]).toMatchObject({ status: "closed", closed_reason: "assigned_to_other" });
    expect(byDriver[near.id].missed_at).not.toBeNull();
    expect(byDriver[mid.id].missed_at).toBeNull(); // acceptée dans sa fenêtre

    const metrics = await as({ sub: org.ownerId }, (q) => q("select * from public.org_driver_metrics($1, 30)", [org.id]));
    const m = (id: string) => metrics.find((r) => r.driver_id === id)!;
    expect(m(near.id)).toMatchObject({ offers: "1", accepted: "0", expired: "1" });
    expect(Number(m(near.id).acceptance_rate)).toBe(0);
    expect(Number(m(mid.id).acceptance_rate)).toBe(1);

    const [ds] = await as({ sub: org.ownerId }, (q) => q("select public.driver_stats($1, 30) as s", [near.id]));
    expect(ds.s.offers).toMatchObject({ offers: 1, accepted: 0, expired: 1, acceptance_rate: 0 });
    const [os] = await as({ sub: org.ownerId }, (q) =>
      q("select public.org_stats($1, now() - interval '1 day', now() + interval '1 day') as s", [org.id]),
    );
    expect(os.s.offers).toMatchObject({ offers_sent: 2, accepted: 1, expired: 1, acceptance_rate: 0.5 });
  });

  it("org_kpis : temps d'attribution moyen calculé sur les seules courses instantanées", async () => {
    const org = await createOrg("Kpis");
    const now = Date.now();
    const at = (s: number) => new Date(now - s * 1000);
    await insertRideBypass(org, { type: "instant", dispatch_started_at: at(30), accepted_at: at(0), completed_at: at(0) });
    await insertRideBypass(org, { type: "instant", dispatch_started_at: at(60), accepted_at: at(0), completed_at: at(0) });
    // Planifiée acceptée 3 h après la mise en ligne : ne doit pas fausser la moyenne
    await insertRideBypass(org, { type: "scheduled", dispatch_started_at: at(3 * 3600), accepted_at: at(0), completed_at: at(0) });

    const [{ k }] = await as({ sub: org.ownerId }, (q) => q("select public.org_kpis($1) as k", [org.id]));
    expect(Number(k.avg_assign_seconds_today)).toBe(45);
  });

  it("refuse les indicateurs d'une autre organisation (403) et aux chauffeurs", async () => {
    const A = await createOrg("Kpi A");
    const B = await createOrg("Kpi B");
    const driverA = await createDriver(A);
    const calls = [
      ["select public.org_ride_counts($1, now() - interval '7 days')", [A.id]],
      ["select * from public.org_driver_metrics($1, 30)", [A.id]],
      ["select public.org_kpis($1)", [A.id]],
      ["select public.org_stats($1, now() - interval '7 days', now())", [A.id]],
    ] as const;
    for (const [text, params] of calls) {
      for (const sub of [B.ownerId, driverA.userId]) {
        const err = await expectPgError(as({ sub }, (q) => q(text, [...params])));
        expect(err.code, `${text} par ${sub}`).toBe("42501");
      }
    }
  });
});
