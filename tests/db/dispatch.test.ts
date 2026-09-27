import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  as, CHAMPS_ELYSEES, createDriver, createOrg, createRideAsOwner, nextWave, north, pool, rideState, sql, type Org,
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
    // Position qui n'arrive plus depuis 15 min : pas sollicité (position en direct uniquement)
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

  it("position en direct uniquement : sollicité si sa position a moins de 3 min, pas sur une ancienne position", async () => {
    const org = await createOrg("Live position");
    const live = await createDriver(org, { firstName: "Live", at: north(CHAMPS_ELYSEES, 1200), locationAgeSeconds: 60 });
    await createDriver(org, { firstName: "Old", at: north(CHAMPS_ELYSEES, 800), locationAgeSeconds: 240 });
    const ride = await createRideAsOwner(org);
    const { offers } = await rideState(ride.id);
    expect(offers.map((o) => o.driver_id)).toEqual([live.id]);
  });

  it("vague vide : le rayon ne s'élargit qu'une fois le délai écoulé (4 km, puis 8 km)", async () => {
    const org = await createOrg("Waves");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 4300) });
    const ride = await createRideAsOwner(org);
    let state = await rideState(ride.id);
    expect(state.ride.status).toBe("SEARCHING_DRIVER");
    expect(state.ride.dispatch_wave).toBe(1);
    expect(state.ride.dispatch_radius_m).toBe(4000);
    expect(state.offers).toHaveLength(0);
    const [due] = await sql("select next_dispatch_at > now() + interval '25 seconds' as later from public.rides where id = $1", [ride.id]);
    expect(due.later).toBe(true);
    // Délai non écoulé : rien ne bouge
    await sql("select private.dispatch_tick()");
    expect((await rideState(ride.id)).ride.dispatch_wave).toBe(1);

    await nextWave(ride.id);
    state = await rideState(ride.id);
    expect(state.ride.status).toBe("OFFERED");
    expect(state.ride.dispatch_wave).toBe(2);
    expect(state.ride.dispatch_radius_m).toBe(8000);
    expect(state.offers.map((o) => o.driver_id)).toEqual([d.id]);
    const messages = state.events.map((e) => e.message);
    expect(messages).toContain("0 chauffeur à moins de 4 km");
    expect(messages.indexOf("Personne n'a accepté — rayon élargi à 8 km")).toBeGreaterThan(messages.indexOf("0 chauffeur à moins de 4 km"));
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
    // Une vague par délai : personne n'est sollicité avant la vague qui couvre sa distance
    for (let w = 1; w < wave; w++) {
      expect((await rideState(ride.id)).offers).toHaveLength(0);
      await nextWave(ride.id);
    }
    const { ride: r, offers } = await rideState(ride.id);
    expect(r.status).toBe("OFFERED");
    expect(r.dispatch_wave).toBe(wave);
    expect(r.dispatch_radius_m).toBe(radius);
    expect(offers.map((o) => [o.driver_id, o.wave, o.radius_m])).toEqual([[d.id, wave, radius]]);
  });

  it("personne : 4 → 8 → 12 → 16 km puis relance 4 → 8 km, une vague par délai, enfin NO_DRIVER_FOUND", async () => {
    const org = await createOrg("Too far");
    await createDriver(org, { at: north(CHAMPS_ELYSEES, 17500) });
    const ride = await createRideAsOwner(org);
    const radii: number[] = [];
    for (let i = 0; i < 6; i++) {
      const { ride: r } = await rideState(ride.id);
      expect(r.status).toBe("SEARCHING_DRIVER");
      expect(r.dispatch_wave).toBe(i + 1);
      radii.push(r.dispatch_radius_m);
      await nextWave(ride.id);
    }
    expect(radii).toEqual([4000, 8000, 12000, 16000, 4000, 8000]);
    const { ride: r, offers, events } = await rideState(ride.id);
    expect(r.status).toBe("NO_DRIVER_FOUND");
    expect(r.no_driver_at).not.toBeNull();
    expect(offers).toHaveLength(0);
    const messages = events.map((e) => e.message);
    [4, 8, 12, 16].forEach((km, i) => expect(messages).toContain(`Recherche GPS — rayon ${km} km (vague ${i + 1})`));
    expect(messages).toContain("Aucun chauffeur disponible jusqu'à 16 km — relance à 4 km");
    expect(messages).toContain("Relance — rayon 4 km (vague 5)");
    expect(messages).toContain("Relance — rayon 8 km (vague 6)");
    const end = events.find((e) => e.type === "dispatch.no_driver");
    expect(end?.message).toBe("Personne n'a accepté la course (4 km → 8 km → 12 km → 16 km, relance 4 km → 8 km) — attribuez-la ou relancez");
    expect(end?.level).toBe("error");
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

  it("tick : l'offre reste ouverte (prolongée), le rayon s'élargit, puis NO_DRIVER_FOUND après la relance", async () => {
    const org = await createOrg("Tick");
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

    // 12, 16 km puis relance 4 et 8 km : l'offre encore ouverte n'est pas re-sonnée
    await nextWave(ride.id, 4);
    state = await rideState(ride.id);
    expect(state.ride.dispatch_wave).toBe(6);
    expect(state.ride.status).toBe("OFFERED");
    expect(state.events.map((e) => e.message)).toContain("Personne n'a accepté jusqu'à 16 km — relance à 4 km");
    await nextWave(ride.id);
    state = await rideState(ride.id);
    expect(state.ride.status).toBe("NO_DRIVER_FOUND");
    expect(state.offers.map((o) => [o.status, o.closed_reason])).toEqual([["expired", "timeout"]]);
    expect(state.events.find((e) => e.type === "dispatch.no_driver")?.level).toBe("error");
    // Explication : le chauffeur sollicité n'a pas répondu
    expect(state.events.at(-1)?.message).toMatch(/^1 chauffeur en ligne n'a pas pris la course — Chauffeur\w+ T\. \(1(,0)? km\) : n'a pas répondu à l'offre$/);
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

  it("relance : le chauffeur resté sans réponse est re-sonné à 4 km, pas celui qui a refusé ; un nouveau venu est sollicité", async () => {
    const org = await createOrg("Relance");
    const quiet = await createDriver(org, { firstName: "Quiet", at: north(CHAMPS_ELYSEES, 1000) });
    const no = await createDriver(org, { firstName: "No", at: north(CHAMPS_ELYSEES, 1500) });
    const ride = await createRideAsOwner(org);
    const first = (await rideState(ride.id)).offers;
    const noOffer = first.find((o) => o.driver_id === no.id);
    const [dec] = await as({ sub: no.userId }, (q) => q("select public.decline_ride_offer($1) as r", [noOffer.id]));
    expect(dec.r.ok).toBe(true);
    // Quiet ne répond pas pendant deux délais : offre « ignorée », pas re-sonnée au premier passage
    await sql("update public.ride_offers set sent_at = sent_at - interval '10 minutes' where ride_id = $1", [ride.id]);
    await sql("update public.rides set dispatch_started_at = dispatch_started_at - interval '10 minutes' where id = $1", [ride.id]);
    await nextWave(ride.id);
    let state = await rideState(ride.id);
    expect(state.offers.filter((o) => o.driver_id === quiet.id).map((o) => o.closed_reason)).toEqual(["ignored"]);

    await nextWave(ride.id, 2);
    const late = await createDriver(org, { firstName: "Late", at: north(CHAMPS_ELYSEES, 3000) });
    await nextWave(ride.id); // relance 4 km
    state = await rideState(ride.id);
    expect(state.ride.dispatch_wave).toBe(5);
    expect(state.ride.dispatch_radius_m).toBe(4000);
    const pending = state.offers.filter((o) => o.status === "pending").map((o) => [o.driver_id, o.wave]);
    expect(pending.sort()).toEqual([[quiet.id, 5], [late.id, 5]].sort());
    const notifs = await sql(
      "select driver_id, title from public.notifications where ride_id = $1 and type = 'ride_offer' order by created_at",
      [ride.id],
    );
    expect(notifs.filter((x) => x.driver_id === quiet.id).map((x) => x.title)).toEqual(["NOUVELLE COURSE", "COURSE TOUJOURS DISPONIBLE"]);
    expect(notifs.filter((x) => x.driver_id === late.id).map((x) => x.title)).toEqual(["NOUVELLE COURSE"]);
    expect(notifs.filter((x) => x.driver_id === no.id)).toHaveLength(1);

    const offer = state.offers.find((o) => o.driver_id === quiet.id && o.status === "pending");
    const [res] = await as({ sub: quiet.userId }, (q) => q("select public.accept_ride_offer($1) as r", [offer.id]));
    expect(res.r.code).toBe("ACCEPTED");
  });

  it("relance réglable : sans relance, fin de la recherche après 16 km", async () => {
    const org = await createOrg("No relance", { settings: { dispatch_retry_radii_m: [] } });
    const ride = await createRideAsOwner(org);
    await nextWave(ride.id, 4);
    const { ride: r, events } = await rideState(ride.id);
    expect(r.status).toBe("NO_DRIVER_FOUND");
    expect(events.find((e) => e.type === "dispatch.no_driver")?.message).toBe(
      "Personne n'a accepté la course (4 km → 8 km → 12 km → 16 km) — attribuez-la ou relancez",
    );
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
      expect((await rideState(ride.id)).ride.dispatch_radius_m).toBe(4000);
      await nextWave(ride.id);
      const { ride: r, offers } = await rideState(ride.id);
      expect(r.dispatch_radius_m).toBe(8000);
      expect(offers).toHaveLength(1);
      await nextWave(ride.id, 5);
      expect((await rideState(ride.id)).ride.status).toBe("NO_DRIVER_FOUND");
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
    const org = await createOrg("Relaunch");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 1000) });
    const ride = await createRideAsOwner(org);
    await nextWave(ride.id, 6);
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

describe("Recherche sans chauffeur : explication dans la chronologie (migration 002900)", () => {
  it("liste les chauffeurs en ligne non sollicités, les plus proches d'abord, avec la raison", async () => {
    const org = await createOrg("Explication");
    await createDriver(org, { firstName: "Berline", at: north(CHAMPS_ELYSEES, 300), category: "standard" });
    await createDriver(org, { firstName: "Ancien", at: north(CHAMPS_ELYSEES, 500), locationAgeSeconds: 2400 });
    await createDriver(org, { firstName: "Occupe", at: north(CHAMPS_ELYSEES, 700), presence: "on_trip" });
    await createDriver(org, { firstName: "Petit", at: north(CHAMPS_ELYSEES, 900), seats: 2 });
    await createDriver(org, { firstName: "Loin", at: north(CHAMPS_ELYSEES, 30000) });
    await createDriver(org, { firstName: "Horsligne", at: north(CHAMPS_ELYSEES, 100), presence: "offline" });

    const ride = await createRideAsOwner(org, { vehicle_category: "business", passengers: 3 });
    // Explication à la fin du premier passage (personne n'a été sollicité jusqu'à 16 km)
    expect((await rideState(ride.id)).events.some((e) => e.type === "dispatch.excluded")).toBe(false);
    await nextWave(ride.id, 4);
    const { ride: r, events } = await rideState(ride.id);
    expect(r.status).toBe("SEARCHING_DRIVER");
    expect(r.dispatch_wave).toBe(5);

    const retry = events.findIndex((e) => e.type === "dispatch.retry");
    const explained = events.findIndex((e) => e.type === "dispatch.excluded");
    expect(retry).toBeGreaterThan(-1);
    expect(explained).toBe(retry + 1);
    const ev = events[explained];
    expect(ev.level).toBe("warning");
    expect(ev.category).toBe("timeline");
    expect(ev.message).toBe(
      "5 chauffeurs en ligne n'ont pas pris la course — Berline T. (300 m) : véhicule Berline, course Business · Ancien T. (500 m) : aucune position reçue depuis 40 min (application fermée ?) · Occupe T. (700 m) : déjà en course · et 2 autres",
    );
    expect(ev.data.counts).toEqual({ category: 1, stale: 1, busy: 1, seats: 1, far: 1 });
    const labels = Object.fromEntries(ev.data.excluded.map((x: { name: string; label: string }) => [x.name, x.label]));
    expect(labels["Petit T."]).toBe("2 places, 3 passagers");
    expect(labels["Loin T."]).toBe("à 30 km, au-delà du rayon de 16 km");
    expect(labels["Horsligne T."]).toBeUndefined();
  });

  it("n'ajoute rien quand aucun chauffeur n'est en ligne, ni quand la course est proposée", async () => {
    const empty = await createOrg("Explication vide");
    await createDriver(empty, { firstName: "Dort", at: north(CHAMPS_ELYSEES, 200), presence: "offline" });
    const lonely = await createRideAsOwner(empty);
    await nextWave(lonely.id, 6);
    expect((await rideState(lonely.id)).events.some((e) => e.type === "dispatch.excluded")).toBe(false);

    const busy = await createOrg("Explication proposée");
    await createDriver(busy, { firstName: "Proche", at: north(CHAMPS_ELYSEES, 200) });
    const offered = await createRideAsOwner(busy);
    const state = await rideState(offered.id);
    expect(state.ride.status).toBe("OFFERED");
    expect(state.events.some((e) => e.type === "dispatch.excluded")).toBe(false);
  });
});

describe("Position en direct : réveil, alerte, jamais retiré (migrations 003200 / 003300)", () => {
  const pings = (ids: string[]) =>
    sql("select driver_id, status from public.notifications where type = 'location_ping' and driver_id = any($1) order by created_at", [ids]);
  const lostAlerts = (ids: string[]) =>
    sql("select driver_id, title, priority from public.notifications where type = 'gps_lost' and driver_id = any($1) order by created_at", [ids]);

  it("position absente depuis 90 s : réveil silencieux (puis un toutes les 20 min) ; au-delà de 3 min : « POSITION NON REÇUE » une fois", async () => {
    const org = await createOrg("GPS perdu");
    const quiet = await createDriver(org, { firstName: "Muet", at: north(CHAMPS_ELYSEES, 500), locationAgeSeconds: 100 });
    const lost = await createDriver(org, { firstName: "Perdu", at: north(CHAMPS_ELYSEES, 550), locationAgeSeconds: 400 });
    const fresh = await createDriver(org, { firstName: "Frais", at: north(CHAMPS_ELYSEES, 600), locationAgeSeconds: 20 });
    // Repassé en ligne il y a 30 s, position d'hier : rien encore
    const back = await createDriver(org, { firstName: "Revenu", at: north(CHAMPS_ELYSEES, 700), locationAgeSeconds: 86_400 });
    const off = await createDriver(org, { firstName: "Horsligne", at: north(CHAMPS_ELYSEES, 800), locationAgeSeconds: 900, presence: "offline" });
    const ids = [quiet.id, lost.id, fresh.id, back.id, off.id];
    await sql("update public.drivers set online_since = now() - interval '1 hour' where id = any($1) and presence <> 'offline'", [ids]);
    await sql("update public.drivers set online_since = now() - interval '30 seconds' where id = $1", [back.id]);

    await sql("select private.watch_driver_gps()");
    await sql("select private.watch_driver_gps()");
    expect((await pings(ids)).map((x) => x.driver_id).sort()).toEqual([quiet.id, lost.id].sort());
    expect(await lostAlerts(ids)).toEqual([{ driver_id: lost.id, title: "POSITION NON REÇUE", priority: "high" }]);

    // Moins de 20 min après : pas de nouveau réveil ; 20 min après, toujours rien : nouveau réveil, l'ancien
    // (encore en file) est annulé ; pas de 2e alerte
    await sql("update public.driver_locations set updated_at = now() - interval '30 minutes' where driver_id = $1", [quiet.id]);
    await sql("update public.drivers set gps_ping_at = now() - interval '10 minutes' where id = $1", [quiet.id]);
    await sql("select private.watch_driver_gps()");
    expect(await pings([quiet.id])).toHaveLength(1);
    await sql("update public.drivers set gps_ping_at = now() - interval '1201 seconds' where id = $1", [quiet.id]);
    await sql("select private.watch_driver_gps()");
    expect((await pings([quiet.id])).map((x) => x.status)).toEqual(["cancelled", "queued"]);
    // (Muet a dépassé 3 min entre-temps : son alerte, une seule fois)
    expect((await lostAlerts(ids)).map((x) => x.driver_id).sort()).toEqual([lost.id, quiet.id].sort());

    // La position est revenue après l'alerte puis s'est de nouveau coupée : nouvelle alerte
    await sql("update public.drivers set gps_lost_notified_at = now() - interval '20 minutes' where id = $1", [lost.id]);
    await sql("update public.driver_locations set updated_at = now() - interval '4 minutes' where driver_id = $1", [lost.id]);
    await sql("select private.watch_driver_gps()");
    expect(await lostAlerts(ids)).toHaveLength(3);
  });

  it("le chauffeur n'est jamais retiré : toujours en ligne après le ménage, même sans position depuis 1 h", async () => {
    const org = await createOrg("Jamais retiré");
    const d = await createDriver(org, { firstName: "Toujours", at: north(CHAMPS_ELYSEES, 500), locationAgeSeconds: 3600 });
    await sql("update public.drivers set online_since = now() - interval '2 hours' where id = $1", [d.id]);
    await sql("select private.housekeeping()");
    const [row] = await sql("select presence, online_since is not null as since from public.drivers where id = $1", [d.id]);
    expect(row).toEqual({ presence: "available", since: true });
    const off = await sql("select 1 from public.notifications where type = 'driver_offline' and driver_id = $1", [d.id]);
    expect(off).toHaveLength(0);
  });

  it("réveil : priorité normale, un seul essai, annulé s'il n'est pas parti dans la minute", async () => {
    const org = await createOrg("Réveil essai");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 500), locationAgeSeconds: 100 });
    await sql("update public.drivers set online_since = now() - interval '1 hour' where id = $1", [d.id]);
    await sql("select private.watch_driver_gps()");
    const [ping] = await sql("select id, priority from public.notifications where type = 'location_ping' and driver_id = $1", [d.id]);
    expect(ping.priority).toBe("normal");
    await sql("update public.notifications set status = 'sending', attempts = 1 where id = $1", [ping.id]);
    await sql("select private.complete_notification($1, false, 'HTTP_503', 'expo', null, true)", [ping.id]);
    const [failed] = await sql("select status from public.notifications where id = $1", [ping.id]);
    expect(failed.status).toBe("failed");

    await sql("update public.drivers set gps_ping_at = now() - interval '21 minutes' where id = $1", [d.id]);
    await sql("select private.watch_driver_gps()");
    const [late] = await sql("select id from public.notifications where type = 'location_ping' and driver_id = $1 and status = 'queued'", [d.id]);
    await sql("update public.notifications set created_at = now() - interval '2 minutes' where id = $1", [late.id]);
    await sql("select * from private.claim_notifications(500)");
    const [expired] = await sql("select status, last_error from public.notifications where id = $1", [late.id]);
    expect(expired).toEqual({ status: "cancelled", last_error: "wake_expired" });
  });

  it("réveils et alertes GPS n'écrivent rien dans le journal d'audit", async () => {
    const org = await createOrg("GPS audit");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 500), locationAgeSeconds: 400 });
    await sql("update public.drivers set online_since = now() - interval '1 hour' where id = $1", [d.id]);
    const before = await sql("select count(*)::int as n from public.audit_logs where entity_id = $1", [d.id]);
    await sql("select private.watch_driver_gps()");
    const [x] = await sql("select gps_ping_at is not null as pinged, gps_lost_notified_at is not null as warned from public.drivers where id = $1", [d.id]);
    expect(x).toEqual({ pinged: true, warned: true });
    const after = await sql("select count(*)::int as n from public.audit_logs where entity_id = $1", [d.id]);
    expect(after[0].n).toBe(before[0].n);
  });

  it("après « Relancer » (chauffeur retiré), personne jusqu'à 16 km : « Aucun chauffeur disponible » + explication", async () => {
    const org = await createOrg("Retiré puis relance");
    const x = await createDriver(org, { firstName: "Retire", at: north(CHAMPS_ELYSEES, 900) });
    const ride = await createRideAsOwner(org);
    const offer = (await rideState(ride.id)).offers[0];
    const [acc] = await as({ sub: x.userId }, (q) => q("select public.accept_ride_offer($1) as r", [offer.id]));
    expect(acc.r.code).toBe("ACCEPTED");
    const [res] = await as({ sub: org.ownerId }, (q) => q("select public.reassign_ride($1, $2) as r", [ride.id, "Injoignable"]));
    expect(res.r.ok).toBe(true);
    await nextWave(ride.id, 4);
    const { events } = await rideState(ride.id);
    const retry = events.findIndex((e) => e.type === "dispatch.retry");
    expect(retry).toBeGreaterThan(-1);
    expect(events[retry].message).toBe("Aucun chauffeur disponible jusqu'à 16 km — relance à 4 km");
    expect(events[retry + 1].type).toBe("dispatch.excluded");
    expect(events[retry + 1].message).toContain("Retire T. (900 m) : retiré de cette course par la centrale");
  });

  it("un « Refuser » tardif (offre déjà close) ne raccourcit pas la vague en cours", async () => {
    const org = await createOrg("Refus tardif");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 800) });
    const ride = await createRideAsOwner(org);
    const offer = (await rideState(ride.id)).offers[0];
    await sql("update public.ride_offers set status = 'expired', closed_reason = 'ignored' where id = $1", [offer.id]);
    const [res] = await as({ sub: d.userId }, (q) => q("select public.decline_ride_offer($1) as r", [offer.id]));
    expect(res.r.ok).toBe(true);
    const [r] = await sql("select next_dispatch_at > now() + interval '20 seconds' as later from public.rides where id = $1", [ride.id]);
    expect(r.later).toBe(true);
  });

  it("rayons de relance : croissants, 4 au plus, bornés", async () => {
    const org = await createOrg("Relance réglages");
    await as({ sub: org.ownerId }, (q) => q("update public.organization_settings set dispatch_retry_radii_m = '{2000,6000}' where organization_id = $1", [org.id]));
    for (const bad of ["{8000,4000}", "{100}", "{1000,2000,3000,4000,5000}"]) {
      await expect(
        as({ sub: org.ownerId }, (q) => q("update public.organization_settings set dispatch_retry_radii_m = $2 where organization_id = $1", [org.id, bad])),
      ).rejects.toThrow(/organization_settings_retry_radii_check/);
    }
  });
});
