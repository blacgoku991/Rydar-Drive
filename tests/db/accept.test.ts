import { afterAll, describe, expect, it } from "vitest";
import {
  as, CHAMPS_ELYSEES, createDriver, createOrg, createRideAsOwner, north, pool, rideState, sql,
} from "./helpers";

afterAll(async () => {
  await pool.end();
});

describe("Premier chauffeur qui accepte (atomicité)", () => {
  it("10 chauffeurs acceptent en même temps : UN SEUL obtient la course", async () => {
    const org = await createOrg("Race");
    const drivers = [];
    for (let i = 0; i < 10; i++) {
      drivers.push(await createDriver(org, { firstName: `Racer${i}`, at: north(CHAMPS_ELYSEES, 200 + i * 150) }));
    }
    const ride = await createRideAsOwner(org);
    const { offers } = await rideState(ride.id);
    expect(offers).toHaveLength(10);

    const results = await Promise.all(
      drivers.map((d) => {
        const offer = offers.find((o) => o.driver_id === d.id)!;
        return as({ sub: d.userId }, (q) => q("select public.accept_ride_offer($1) as r", [offer.id])).then(
          (rows) => rows[0].r as { ok: boolean; code: string; message: string },
        );
      }),
    );

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(9);
    expect(losers.every((r) => r.code === "RIDE_ALREADY_ASSIGNED" && r.message === "Course déjà attribuée.")).toBe(true);

    const state = await rideState(ride.id);
    expect(state.ride.status).toBe("ACCEPTED");
    const assignments = await sql("select * from public.ride_assignments where ride_id = $1", [ride.id]);
    expect(assignments).toHaveLength(1);
    expect(assignments[0].driver_id).toBe(state.ride.driver_id);
    expect(state.offers.filter((o) => o.status === "accepted")).toHaveLength(1);
    expect(state.offers.filter((o) => o.status === "pending")).toHaveLength(0);

    const messages = state.events.map((e) => e.message);
    expect(messages).toContain("Course verrouillée");
    expect(messages.some((m) => /autres offres fermées/.test(m))).toBe(true);

    const presences = await sql("select id, presence from public.drivers where organization_id = $1", [org.id]);
    for (const p of presences) {
      expect(p.presence).toBe(p.id === state.ride.driver_id ? "en_route" : "available");
    }
  });

  it("l'index unique partiel interdit toute double affectation, même en SQL brut", async () => {
    const org = await createOrg("Index");
    const d1 = await createDriver(org, { at: north(CHAMPS_ELYSEES, 300) });
    const d2 = await createDriver(org, { at: north(CHAMPS_ELYSEES, 400) });
    const ride = await createRideAsOwner(org);
    await sql(
      "insert into public.ride_assignments (organization_id, ride_id, driver_id, method) values ($1, $2, $3, 'manual')",
      [org.id, ride.id, d1.id],
    );
    await expect(
      sql("insert into public.ride_assignments (organization_id, ride_id, driver_id, method) values ($1, $2, $3, 'manual')", [
        org.id, ride.id, d2.id,
      ]),
    ).rejects.toThrow(/ride_assignments_one_active_uidx/);
  });

  it("cycle complet de la course côté chauffeur + transitions invalides refusées", async () => {
    const org = await createOrg("Lifecycle");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 500) });
    const ride = await createRideAsOwner(org);
    const { offers } = await rideState(ride.id);
    const call = (fn: string, ...args: unknown[]) =>
      as({ sub: d.userId }, (q) => q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).then(
        (rows) => rows[0].r,
      );

    expect((await call("accept_ride_offer", offers[0].id)).ok).toBe(true);
    expect((await call("driver_update_ride_status", ride.id, "IN_PROGRESS")).code).toBe("INVALID_TRANSITION");
    for (const status of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS", "COMPLETED"]) {
      const res = await call("driver_update_ride_status", ride.id, status);
      expect(res.ok, `${status}: ${JSON.stringify(res)}`).toBe(true);
    }
    const [r] = await sql("select status, completed_at from public.rides where id = $1", [ride.id]);
    expect(r.status).toBe("COMPLETED");
    const [p] = await sql("select presence, current_ride_id from public.drivers where id = $1", [d.id]);
    expect(p).toEqual({ presence: "available", current_ride_id: null });

    const history = await sql("select from_status, to_status from public.ride_status_history where ride_id = $1 order by id", [ride.id]);
    expect(history.map((h) => h.to_status)).toEqual([
      "CREATED", "SEARCHING_DRIVER", "OFFERED", "ACCEPTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED",
      "PASSENGER_ONBOARD", "IN_PROGRESS", "COMPLETED",
    ]);

    const home = await call("driver_home");
    expect(home.today.rides).toBe(1);
    expect(home.today.revenue_cents).toBe(7200);
  });

  it("course planifiée acceptée : rappels 24 h / 3 h / 1 h / 30 min programmés", async () => {
    const org = await createOrg("Reminders");
    const d = await createDriver(org, { presence: "offline" });
    const pickup = new Date(Date.now() + 30 * 3600 * 1000).toISOString();
    const ride = await createRideAsOwner(org, { pickup_at: pickup });
    const { offers } = await rideState(ride.id);
    const [res] = await as({ sub: d.userId }, (q) => q("select public.accept_ride_offer($1) as r", [offers[0].id]));
    expect(res.r.ok).toBe(true);
    const reminders = await sql(
      "select data->>'offset_minutes' as m from public.notifications where ride_id = $1 and type = 'ride_reminder' order by scheduled_for",
      [ride.id],
    );
    expect(reminders.map((r) => Number(r.m))).toEqual([1440, 180, 60, 30]);
  });

  it("annulation : offres fermées, chauffeur libéré et notifié", async () => {
    const org = await createOrg("Cancel");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 500) });
    const ride = await createRideAsOwner(org);
    const { offers } = await rideState(ride.id);
    await as({ sub: d.userId }, (q) => q("select public.accept_ride_offer($1)", [offers[0].id]));
    const [res] = await as({ sub: org.ownerId }, (q) => q("select public.cancel_ride($1, 'Client injoignable') as r", [ride.id]));
    expect(res.r.ok).toBe(true);
    const [p] = await sql("select presence from public.drivers where id = $1", [d.id]);
    expect(p.presence).toBe("available");
    const notifs = await sql("select type from public.notifications where ride_id = $1 and type = 'ride_cancelled'", [ride.id]);
    expect(notifs).toHaveLength(1);
  });

  it("attribution manuelle par le rattacheur", async () => {
    const org = await createOrg("Manual");
    const d = await createDriver(org, { presence: "offline" });
    const ride = await createRideAsOwner(org);
    const [res] = await as({ sub: org.ownerId }, (q) => q("select public.assign_ride($1, $2) as r", [ride.id, d.id]));
    expect(res.r.ok).toBe(true);
    const [r] = await sql("select status, driver_id from public.rides where id = $1", [ride.id]);
    expect(r).toEqual({ status: "ACCEPTED", driver_id: d.id });
  });
});
