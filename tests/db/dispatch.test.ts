import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  as, CHAMPS_ELYSEES, createDriver, createOrg, createRideAsOwner, north, pool, rideState, sql, type Org,
} from "./helpers";

let A: Org;
let B: Org;

beforeAll(async () => {
  A = await createOrg("Dispatch A");
  B = await createOrg("Dispatch B");
});

afterAll(async () => {
  await pool.end();
});

describe("Dispatch instantané (PostGIS)", () => {
  it("n'offre la course qu'aux chauffeurs du tenant, en ligne, compatibles, à moins de 3 km", async () => {
    const org = await createOrg("Geo");
    const other = await createOrg("Geo Other");
    const near1 = await createDriver(org, { firstName: "Near1", at: north(CHAMPS_ELYSEES, 900) });
    const near2 = await createDriver(org, { firstName: "Near2", at: north(CHAMPS_ELYSEES, 2500) });
    await createDriver(org, { firstName: "Far", at: north(CHAMPS_ELYSEES, 4200) });
    await createDriver(org, { firstName: "Offline", at: north(CHAMPS_ELYSEES, 300), presence: "offline" });
    await createDriver(org, { firstName: "Stale", at: north(CHAMPS_ELYSEES, 300), locationAgeSeconds: 900 });
    await createDriver(org, { firstName: "Van", at: north(CHAMPS_ELYSEES, 200), category: "van", seats: 7 });
    await createDriver(org, { firstName: "Inactive", at: north(CHAMPS_ELYSEES, 100), status: "inactive" });
    const foreign = await createDriver(other, { firstName: "Foreign", at: north(CHAMPS_ELYSEES, 50) });

    const ride = await createRideAsOwner(org, { vehicle_category: "business" });
    const { ride: r, offers, events } = await rideState(ride.id);

    expect(r.type).toBe("instant");
    expect(r.status).toBe("OFFERED");
    expect(r.dispatch_radius_m).toBe(3000);
    expect(offers.map((o) => o.driver_id).sort()).toEqual([near1.id, near2.id].sort());
    expect(offers.find((o) => o.driver_id === foreign.id)).toBeUndefined();
    expect(offers[0].distance_m).toBeGreaterThan(800);
    expect(offers[0].distance_m).toBeLessThan(1000);

    const messages = events.map((e) => e.message);
    expect(messages).toContain("Course créée par le rattacheur");
    expect(messages).toContain("Course instantanée détectée");
    expect(messages).toContain("2 chauffeurs à moins de 3 km");
    expect(messages).toContain("2 notifications envoyées");

    const notifs = await sql("select driver_id, title, body from public.notifications where ride_id = $1", [ride.id]);
    expect(notifs).toHaveLength(2);
    expect(notifs[0].title).toBe("NOUVELLE COURSE");
    expect(notifs[0].body).toContain("72 €");

    const presences = await sql("select presence from public.drivers where id = any($1)", [[near1.id, near2.id]]);
    expect(presences.every((p) => p.presence === "offered")).toBe(true);
  });

  it("élargit immédiatement le rayon (3 → 5 km) quand personne n'est proche", async () => {
    const org = await createOrg("Waves");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 4300) });
    const ride = await createRideAsOwner(org);
    const { ride: r, offers, events } = await rideState(ride.id);
    expect(r.status).toBe("OFFERED");
    expect(r.dispatch_wave).toBe(2);
    expect(r.dispatch_radius_m).toBe(5000);
    expect(offers.map((o) => o.driver_id)).toEqual([d.id]);
    expect(events.map((e) => e.message)).toContain("0 chauffeur à moins de 3 km");
  });

  it("respecte catégorie, upgrade et nombre de places", async () => {
    const org = await createOrg("Categories", { settings: { allow_category_upgrade: false } });
    const std = await createDriver(org, { category: "standard", at: north(CHAMPS_ELYSEES, 500) });
    await createDriver(org, { category: "first", at: north(CHAMPS_ELYSEES, 600) });
    const van = await createDriver(org, { category: "van", seats: 7, at: north(CHAMPS_ELYSEES, 700) });
    const r1 = await createRideAsOwner(org, { vehicle_category: "standard" });
    expect((await rideState(r1.id)).offers.map((o) => o.driver_id)).toEqual([std.id]);
    const r2 = await createRideAsOwner(org, { vehicle_category: "van", passengers: 6 });
    expect((await rideState(r2.id)).offers.map((o) => o.driver_id)).toEqual([van.id]);
  });

  it("tick : expiration de la vague, vague suivante, puis NO_DRIVER_FOUND", async () => {
    const org = await createOrg("Tick", { settings: { max_search_seconds: 60 } });
    const d1 = await createDriver(org, { at: north(CHAMPS_ELYSEES, 1000) });
    const ride = await createRideAsOwner(org);
    let state = await rideState(ride.id);
    expect(state.offers).toHaveLength(1);

    // Personne ne répond : on simule l'écoulement du délai
    await sql("update public.rides set next_dispatch_at = now() - interval '1 second' where id = $1", [ride.id]);
    await sql("select private.dispatch_tick()");
    state = await rideState(ride.id);
    expect(state.offers.find((o) => o.driver_id === d1.id)?.status).toBe("expired");
    expect(state.ride.status).toBe("SEARCHING_DRIVER");
    const [p] = await sql("select presence from public.drivers where id = $1", [d1.id]);
    expect(p.presence).toBe("available");

    await sql(
      "update public.rides set next_dispatch_at = now() - interval '1 second', dispatch_started_at = now() - interval '2 minutes' where id = $1",
      [ride.id],
    );
    await sql("select private.dispatch_tick()");
    state = await rideState(ride.id);
    expect(state.ride.status).toBe("NO_DRIVER_FOUND");
    expect(state.events.at(-1)?.level).toBe("error");
  });

  it("refus de tous les chauffeurs → vague suivante accélérée", async () => {
    const org = await createOrg("Decline");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 500) });
    const ride = await createRideAsOwner(org);
    const { offers } = await rideState(ride.id);
    const [res] = await as({ sub: d.userId }, (q) => q("select public.decline_ride_offer($1) as r", [offers[0].id]));
    expect(res.r.ok).toBe(true);
    const [r] = await sql("select next_dispatch_at <= now() as due from public.rides where id = $1", [ride.id]);
    expect(r.due).toBe(true);
  });

  it("course planifiée : proposée à toute la flotte compatible, puis bascule GPS à T-lead", async () => {
    const org = await createOrg("Scheduled");
    const online = await createDriver(org, { at: north(CHAMPS_ELYSEES, 20_000) });
    const offline = await createDriver(org, { presence: "offline" });
    await createDriver(org, { category: "standard", at: north(CHAMPS_ELYSEES, 100) });
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const ride = await createRideAsOwner(org, { pickup_at: tomorrow, vehicle_category: "business" });
    let state = await rideState(ride.id);
    expect(state.ride.type).toBe("scheduled");
    expect(state.ride.dispatch_mode).toBe("fleet");
    expect(state.ride.status).toBe("OFFERED");
    expect(state.offers.map((o) => o.driver_id).sort()).toEqual([online.id, offline.id].sort());
    const [presence] = await sql("select presence from public.drivers where id = $1", [online.id]);
    expect(presence.presence).toBe("available");

    await sql("update public.rides set next_dispatch_at = now() - interval '1 second' where id = $1", [ride.id]);
    await sql("select private.dispatch_tick()");
    state = await rideState(ride.id);
    expect(state.ride.dispatch_mode).toBe("geo");
    expect(state.events.map((e) => e.type)).toContain("dispatch.escalated");
  });

  it("classification : pickup dans 20 min = instantanée, dans 2 h = planifiée", async () => {
    const soon = await createRideAsOwner(A, { pickup_at: new Date(Date.now() + 20 * 60_000).toISOString() });
    const later = await createRideAsOwner(A, { pickup_at: new Date(Date.now() + 2 * 3600_000).toISOString() });
    expect(soon.type).toBe("instant");
    expect(later.type).toBe("scheduled");
  });

  it("refuse une prise en charge dans le passé", async () => {
    await expect(
      createRideAsOwner(B, { pickup_at: new Date(Date.now() - 3600_000).toISOString() }),
    ).rejects.toThrow(/PICKUP_IN_PAST/);
  });
});
