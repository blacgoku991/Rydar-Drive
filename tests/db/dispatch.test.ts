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
  it("n'offre la course qu'aux chauffeurs du tenant, en ligne, compatibles, à moins de 4 km", async () => {
    const org = await createOrg("Geo");
    const other = await createOrg("Geo Other");
    const near1 = await createDriver(org, { firstName: "Near1", at: north(CHAMPS_ELYSEES, 900) });
    const near2 = await createDriver(org, { firstName: "Near2", at: north(CHAMPS_ELYSEES, 2500) });
    await createDriver(org, { firstName: "Far", at: north(CHAMPS_ELYSEES, 4600) });
    await createDriver(org, { firstName: "Offline", at: north(CHAMPS_ELYSEES, 300), presence: "offline" });
    await createDriver(org, { firstName: "Stale", at: north(CHAMPS_ELYSEES, 300), locationAgeSeconds: 900 });
    await createDriver(org, { firstName: "Van", at: north(CHAMPS_ELYSEES, 200), category: "van", seats: 7 });
    await createDriver(org, { firstName: "Inactive", at: north(CHAMPS_ELYSEES, 100), status: "inactive" });
    const foreign = await createDriver(other, { firstName: "Foreign", at: north(CHAMPS_ELYSEES, 50) });

    const ride = await createRideAsOwner(org, { vehicle_category: "business" });
    const { ride: r, offers, events } = await rideState(ride.id);

    expect(r.type).toBe("instant");
    expect(r.status).toBe("OFFERED");
    expect(r.dispatch_radius_m).toBe(4000);
    expect(offers.map((o) => o.driver_id).sort()).toEqual([near1.id, near2.id].sort());
    expect(offers.find((o) => o.driver_id === foreign.id)).toBeUndefined();
    expect(offers[0].distance_m).toBeGreaterThan(800);
    expect(offers[0].distance_m).toBeLessThan(1000);

    const messages = events.map((e) => e.message);
    expect(messages).toContain("Course créée par le rattacheur");
    expect(messages).toContain("Course instantanée détectée");
    expect(messages).toContain("2 chauffeurs à moins de 4 km");
    expect(messages).toContain("2 notifications envoyées");

    const notifs = await sql("select driver_id, title, body from public.notifications where ride_id = $1", [ride.id]);
    expect(notifs).toHaveLength(2);
    expect(notifs[0].title).toBe("NOUVELLE COURSE");
    expect(notifs[0].body).toContain("72 €");

    const presences = await sql("select presence from public.drivers where id = any($1)", [[near1.id, near2.id]]);
    expect(presences.every((p) => p.presence === "offered")).toBe(true);
  });

  it("élargit immédiatement le rayon (4 → 8 km) quand personne n'est proche", async () => {
    const org = await createOrg("Waves");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 4300) });
    const ride = await createRideAsOwner(org);
    const { ride: r, offers, events } = await rideState(ride.id);
    expect(r.status).toBe("OFFERED");
    expect(r.dispatch_wave).toBe(2);
    expect(r.dispatch_radius_m).toBe(8000);
    expect(offers.map((o) => o.driver_id)).toEqual([d.id]);
    expect(events.map((e) => e.message)).toContain("0 chauffeur à moins de 4 km");
  });

  it("diffuse en dernier l'état à jour de la course (pas un « CREATED » périmé)", async () => {
    const org = await createOrg("Broadcast");
    await createDriver(org, { at: north(CHAMPS_ELYSEES, 800) });
    const ride = await createRideAsOwner(org);
    const msgs = await sql(
      "select payload->>'op' as op, payload->>'status' as status from realtime.messages where event = 'ride.updated' and topic = $1 and payload->>'id' = $2 order by id",
      [`org:${org.id}`, ride.id],
    );
    expect(msgs.some((m) => m.op === "insert")).toBe(true);
    expect(msgs.at(-1)?.status).toBe("OFFERED");
    expect(msgs.map((m) => m.status)).not.toContain("CREATED");
  });

  it.each([
    [2500, 1, 4000],
    [6000, 2, 8000],
    [10500, 3, 12000],
    [15000, 4, 16000],
  ])("chauffeur à %i m → vague %i, rayon %i m (4 → 8 → 12 → 16 km)", async (distance, wave, radius) => {
    const org = await createOrg(`Waves ${distance}`);
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, distance) });
    const ride = await createRideAsOwner(org);
    const { ride: r, offers } = await rideState(ride.id);
    expect(r.status).toBe("OFFERED");
    expect(r.dispatch_wave).toBe(wave);
    expect(r.dispatch_radius_m).toBe(radius);
    expect(offers.map((o) => [o.driver_id, o.wave, o.radius_m])).toEqual([[d.id, wave, radius]]);
  });

  it("au-delà de 16 km, personne n'est sollicité et la course reste en recherche", async () => {
    const org = await createOrg("Too far");
    await createDriver(org, { at: north(CHAMPS_ELYSEES, 17500) });
    const ride = await createRideAsOwner(org);
    const { ride: r, offers, events } = await rideState(ride.id);
    expect(r.status).toBe("SEARCHING_DRIVER");
    expect(offers).toHaveLength(0);
    const messages = events.map((e) => e.message);
    for (const km of [4, 8, 12, 16]) expect(messages).toContain(`0 chauffeur à moins de ${km} km`);
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

  it("tick : l'offre reste ouverte (prolongée), le rayon s'élargit, puis NO_DRIVER_FOUND", async () => {
    const org = await createOrg("Tick", { settings: { max_search_seconds: 60 } });
    const d1 = await createDriver(org, { at: north(CHAMPS_ELYSEES, 1000) });
    const ride = await createRideAsOwner(org);
    let state = await rideState(ride.id);
    expect(state.offers).toHaveLength(1);
    const firstExpiry = new Date(state.offers[0].expires_at).getTime();

    // Personne ne répond : on simule l'écoulement du délai
    await sql("update public.ride_offers set expires_at = now() - interval '1 second' where ride_id = $1", [ride.id]);
    await sql("update public.rides set next_dispatch_at = now() - interval '1 second' where id = $1", [ride.id]);
    await sql("select private.dispatch_tick()");
    state = await rideState(ride.id);
    expect(state.offers).toHaveLength(1);
    expect(state.offers[0].status).toBe("pending");
    expect(new Date(state.offers[0].expires_at).getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(new Date(state.offers[0].expires_at).getTime()).toBeGreaterThanOrEqual(firstExpiry);
    expect(state.ride.status).toBe("OFFERED");
    expect(state.ride.dispatch_wave).toBeGreaterThanOrEqual(2);
    const [p] = await sql("select presence from public.drivers where id = $1", [d1.id]);
    expect(p.presence).toBe("offered");
    const notifs = await sql("select count(*)::int as n from public.notifications where ride_id = $1 and driver_id = $2", [ride.id, d1.id]);
    expect(notifs[0].n).toBe(1);

    await sql(
      "update public.rides set next_dispatch_at = now() - interval '1 second', dispatch_started_at = now() - interval '2 minutes' where id = $1",
      [ride.id],
    );
    await sql("select private.dispatch_tick()");
    state = await rideState(ride.id);
    expect(state.ride.status).toBe("NO_DRIVER_FOUND");
    expect(state.offers[0].status).toBe("expired");
    expect(state.events.at(-1)?.level).toBe("error");
    const [p2] = await sql("select presence from public.drivers where id = $1", [d1.id]);
    expect(p2.presence).toBe("available");
  });

  it("vagues cumulatives : à 8 km, le chauffeur à 1 km garde son offre et celui à 6 km est ajouté", async () => {
    const org = await createOrg("Cumulative");
    const near = await createDriver(org, { firstName: "Near", at: north(CHAMPS_ELYSEES, 1000) });
    const mid = await createDriver(org, { firstName: "Mid", at: north(CHAMPS_ELYSEES, 6000) });
    const ride = await createRideAsOwner(org);
    let state = await rideState(ride.id);
    expect(state.offers.map((o) => o.driver_id)).toEqual([near.id]);

    await sql("update public.rides set next_dispatch_at = now() - interval '1 second' where id = $1", [ride.id]);
    await sql("select private.dispatch_tick()");
    state = await rideState(ride.id);
    expect(state.ride.dispatch_wave).toBe(2);
    expect(state.ride.dispatch_radius_m).toBe(8000);
    const byDriver = Object.fromEntries(state.offers.map((o) => [o.driver_id, o]));
    expect(byDriver[near.id].status).toBe("pending");
    expect(byDriver[mid.id].status).toBe("pending");
    expect(byDriver[mid.id].wave).toBe(2);
    expect(state.events.map((e) => e.message)).toContain("2 chauffeurs sollicités à moins de 8 km, dont 1 nouveau");

    // Le chauffeur à 1 km peut toujours accepter
    const [res] = await as({ sub: near.userId }, (q) => q("select public.accept_ride_offer($1) as r", [byDriver[near.id].id]));
    expect(res.r.code).toBe("ACCEPTED");
  });

  it("après 16 km : pas de nouvelle sonnerie pour les mêmes chauffeurs, seulement pour les nouveaux", async () => {
    const org = await createOrg("NoSpam", { settings: { max_search_seconds: 600 } });
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 1000) });
    const ride = await createRideAsOwner(org);
    for (let i = 0; i < 6; i++) {
      await sql("update public.rides set next_dispatch_at = now() - interval '1 second' where id = $1", [ride.id]);
      await sql("select private.dispatch_tick()");
    }
    const late = await createDriver(org, { firstName: "Late", at: north(CHAMPS_ELYSEES, 9000) });
    await sql("update public.rides set next_dispatch_at = now() - interval '1 second' where id = $1", [ride.id]);
    await sql("select private.dispatch_tick()");
    const counts = await sql(
      "select driver_id, count(*)::int as n from public.notifications where ride_id = $1 and type = 'ride_offer' group by driver_id",
      [ride.id],
    );
    const n = Object.fromEntries(counts.map((c) => [c.driver_id, c.n]));
    expect(n[d.id]).toBe(1);
    expect(n[late.id]).toBe(1);
    const state = await rideState(ride.id);
    expect(state.ride.status).toBe("OFFERED");
    expect(state.offers.filter((o) => o.status === "pending")).toHaveLength(2);
  });

  it("tick : l'offre d'un chauffeur parti sur une autre course est fermée, pas prolongée", async () => {
    const org = await createOrg("Busy elsewhere");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 800) });
    const x = await createRideAsOwner(org);
    const offerX = (await rideState(x.id)).offers[0];
    // Le chauffeur est parti sur une autre course (attribuée par le rattacheur)
    await sql("update public.drivers set presence = 'en_route' where id = $1", [d.id]);
    await sql("update public.rides set next_dispatch_at = now() - interval '1 second' where id = $1", [x.id]);
    await sql("select private.dispatch_tick()");
    const [o] = await sql("select status, closed_reason from public.ride_offers where id = $1", [offerX.id]);
    expect(o).toEqual({ status: "expired", closed_reason: "driver_unavailable" });
  });

  it("réglages absents : rayons par défaut, pas de boucle infinie", async () => {
    const org = await createOrg("No settings");
    await createDriver(org, { at: north(CHAMPS_ELYSEES, 6000) });
    await sql("delete from public.organization_settings where organization_id = $1", [org.id]);
    await sql("set statement_timeout = '5s'");
    try {
      const ride = await createRideAsOwner(org);
      const { ride: r } = await rideState(ride.id);
      expect(r.dispatch_radius_m).toBe(8000);
    } finally {
      await sql("set statement_timeout = 0");
    }
  });

  it("sans réponse pendant deux délais : offre fermée « ignorée », chauffeur libéré et pas re-sollicité", async () => {
    const org = await createOrg("Ignored");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 900) });
    const ride = await createRideAsOwner(org);
    const offer = (await rideState(ride.id)).offers[0];
    await sql("update public.ride_offers set sent_at = now() - interval '61 seconds' where id = $1", [offer.id]);
    await sql("update public.rides set next_dispatch_at = now() - interval '1 second', dispatch_started_at = now() - interval '62 seconds' where id = $1", [ride.id]);
    await sql("select private.dispatch_tick()");
    const [o] = await sql("select status, closed_reason from public.ride_offers where id = $1", [offer.id]);
    expect(o).toEqual({ status: "expired", closed_reason: "ignored" });
    const [p] = await sql("select presence from public.drivers where id = $1", [d.id]);
    expect(p.presence).toBe("available");
    await sql("update public.rides set next_dispatch_at = now() - interval '1 second' where id = $1", [ride.id]);
    await sql("select private.dispatch_tick()");
    const offers = await sql("select id from public.ride_offers where ride_id = $1 and driver_id = $2", [ride.id, d.id]);
    expect(offers).toHaveLength(1);
  });

  it("une offre expirée ne peut plus être acceptée", async () => {
    const org = await createOrg("Expired accept");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 800) });
    const ride = await createRideAsOwner(org);
    const { offers } = await rideState(ride.id);
    await sql("update public.ride_offers set status = 'expired', closed_reason = 'driver_offline' where id = $1", [offers[0].id]);
    const [res] = await as({ sub: d.userId }, (q) => q("select public.accept_ride_offer($1) as r", [offers[0].id]));
    expect(res.r.code).toBe("OFFER_EXPIRED");
    const [r] = await sql("select driver_id from public.rides where id = $1", [ride.id]);
    expect(r.driver_id).toBeNull();
  });

  it("« Relancer » après NO_DRIVER_FOUND repart de 4 km (le chauffeur proche est resollicité)", async () => {
    const org = await createOrg("Relaunch", { settings: { max_search_seconds: 60 } });
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 1000) });
    const ride = await createRideAsOwner(org);
    await sql(
      "update public.rides set next_dispatch_at = now() - interval '1 second', dispatch_started_at = now() - interval '2 minutes' where id = $1",
      [ride.id],
    );
    await sql("select private.dispatch_tick()");
    expect((await rideState(ride.id)).ride.status).toBe("NO_DRIVER_FOUND");

    const [res] = await as({ sub: org.ownerId }, (q) => q("select public.redispatch_ride($1) as r", [ride.id]));
    expect(res.r.ok).toBe(true);
    const state = await rideState(ride.id);
    expect(state.ride.status).toBe("OFFERED");
    expect(state.ride.dispatch_radius_m).toBe(4000);
    const pending = state.offers.filter((o) => o.status === "pending");
    expect(pending.map((o) => [o.driver_id, o.wave, o.radius_m])).toEqual([[d.id, 1, 4000]]);
  });

  it("ignore les positions trop imprécises (> 1,5 km)", async () => {
    const org = await createOrg("Accuracy");
    const coarse = await createDriver(org, { firstName: "Coarse", at: north(CHAMPS_ELYSEES, 500) });
    const fine = await createDriver(org, { firstName: "Fine", at: north(CHAMPS_ELYSEES, 2500) });
    await sql("update public.driver_locations set accuracy_m = 3000 where driver_id = $1", [coarse.id]);
    const ride = await createRideAsOwner(org);
    const { offers } = await rideState(ride.id);
    expect(offers.map((o) => o.driver_id)).toEqual([fine.id]);
  });

  it("refuse en base des rayons qui ne sont pas strictement croissants", async () => {
    const org = await createOrg("Radii");
    await expect(
      as({ sub: org.ownerId }, (q) => q("update public.organization_settings set dispatch_radii_m = '{8000,4000}' where organization_id = $1", [org.id])),
    ).rejects.toThrow(/organization_settings_radii_increasing/);
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

    // T-lead atteint (prise en charge dans moins de scheduled_dispatch_lead_minutes)
    await sql("update public.rides set pickup_at = now() + interval '50 minutes', next_dispatch_at = now() - interval '1 second' where id = $1", [ride.id]);
    await sql("select private.dispatch_tick()");
    state = await rideState(ride.id);
    expect(state.ride.dispatch_mode).toBe("geo");
    expect(state.events.map((e) => e.type)).toContain("dispatch.escalated");
  });

  it("bascule planifiée → GPS : le chauffeur à 1 km (déjà sollicité par la flotte) reçoit l'offre à 4 km", async () => {
    const org = await createOrg("Escalation");
    const near = await createDriver(org, { firstName: "Near", at: north(CHAMPS_ELYSEES, 1000) });
    const far = await createDriver(org, { firstName: "Far", at: north(CHAMPS_ELYSEES, 10_000) });
    const ride = await createRideAsOwner(org, { pickup_at: new Date(Date.now() + 3 * 3600_000).toISOString() });
    let state = await rideState(ride.id);
    expect(state.offers.map((o) => o.driver_id).sort()).toEqual([near.id, far.id].sort());

    await sql("update public.rides set pickup_at = now() + interval '50 minutes', next_dispatch_at = now() - interval '1 second' where id = $1", [ride.id]);
    await sql("select private.dispatch_tick()");
    state = await rideState(ride.id);
    const geo = state.offers.filter((o) => o.mode === "geo" && o.status === "pending");
    expect(state.ride.status).toBe("OFFERED");
    expect(state.ride.dispatch_radius_m).toBe(4000);
    expect(geo.map((o) => [o.driver_id, o.wave, o.radius_m])).toEqual([[near.id, 1, 4000]]);
  });

  it("planifiée : un chauffeur ajouté après la création reçoit l'offre au passage suivant (toutes les 5 min)", async () => {
    const org = await createOrg("Fleet refresh");
    const first = await createDriver(org, { firstName: "First", presence: "offline" });
    const ride = await createRideAsOwner(org, { pickup_at: new Date(Date.now() + 26 * 3600_000).toISOString() });
    let state = await rideState(ride.id);
    expect(state.offers.map((o) => o.driver_id)).toEqual([first.id]);
    const [nd] = await sql("select next_dispatch_at < now() + interval '6 minutes' as soon from public.rides where id = $1", [ride.id]);
    expect(nd.soon).toBe(true);

    const late = await createDriver(org, { firstName: "Late", presence: "offline" });
    await sql("update public.rides set next_dispatch_at = now() - interval '1 second' where id = $1", [ride.id]);
    await sql("select private.dispatch_tick()");
    state = await rideState(ride.id);
    expect(state.ride.dispatch_mode).toBe("fleet");
    expect(state.ride.status).toBe("OFFERED");
    expect(state.offers.map((o) => o.driver_id).sort()).toEqual([first.id, late.id].sort());
    const n = await sql("select driver_id from public.notifications where ride_id = $1 and type = 'ride_offer_scheduled'", [ride.id]);
    expect(n.map((x) => x.driver_id).sort()).toEqual([first.id, late.id].sort());
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
