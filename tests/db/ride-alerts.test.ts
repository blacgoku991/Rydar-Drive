import { afterAll, describe, expect, it } from "vitest";
import {
  as, CHAMPS_ELYSEES, createDriver, createMember, createOrg, createRideAsOwner, expectPgError, inMinutes, north, pool,
  rideState, sql, type Driver, type Org,
} from "./helpers";

afterAll(async () => {
  await pool.end();
});

type Alert = {
  id: string;
  organization_id: string;
  ride_id: string;
  driver_id: string | null;
  kind: "late" | "stalled" | "no_gps" | "not_started";
  severity: "warning" | "critical";
  message: string;
  data: Record<string, any>;
  status: "open" | "acknowledged" | "resolved";
  resolution: string | null;
  muted_until: Date | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  updated_at: Date;
};

/** Passage du worker (connexion directe, comme apps/worker). */
const watch = async () => (await sql("select private.watch_rides() as r"))[0].r as Record<string, any>;
const alertsOf = (rideId: string) =>
  sql<Alert>("select * from public.ride_alerts where ride_id = $1 order by created_at, id", [rideId]);
const openAlert = async (rideId: string, kind: Alert["kind"]) =>
  (await sql<Alert>("select * from public.ride_alerts where ride_id = $1 and kind = $2 and status = 'open'", [rideId, kind]))[0];
const eventsOf = (rideId: string, type: string) =>
  sql("select * from public.ride_events where ride_id = $1 and type = $2 order by id", [rideId, type]);
const alertBroadcasts = (alertId: string) =>
  sql("select topic, payload from realtime.messages where event = 'ride.alert' and payload->>'id' = $1 order by id", [alertId]);

const rpc = async (sub: string, fn: string, args: unknown[]) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ sub }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Record<string, any>;
};
const assign = (org: Org, rideId: string, driverId: string) => rpc(org.ownerId, "assign_ride", [rideId, driverId]);
const driverStatus = (d: Driver, rideId: string, status: string) => rpc(d.userId, "driver_update_ride_status", [rideId, status]);

/** Position courante (upsert) : point + âge en secondes. */
async function setLocation(org: Org, d: Driver, point: [number, number], ageSeconds = 5) {
  await sql(
    `insert into public.driver_locations (driver_id, organization_id, lat, lng, recorded_at, updated_at)
     values ($1, $2, $3, $4, now() - make_interval(secs => $5), now() - make_interval(secs => $5))
     on conflict (driver_id) do update
       set lat = excluded.lat, lng = excluded.lng, recorded_at = excluded.recorded_at, updated_at = excluded.updated_at`,
    [d.id, org.id, point[0], point[1], ageSeconds],
  );
}

async function addHistory(org: Org, d: Driver, point: [number, number], secondsAgo: number) {
  await sql(
    `insert into public.driver_location_history (organization_id, driver_id, lat, lng, recorded_at)
     values ($1, $2, $3, $4, now() - make_interval(secs => $5))`,
    [org.id, d.id, point[0], point[1], secondsAgo],
  );
}

/** Course instantanée acceptée par le chauffeur (offre GPS). */
async function acceptedInstant(org: Org, d: Driver) {
  const ride = await createRideAsOwner(org);
  const offer = (await rideState(ride.id)).offers.find((o) => o.driver_id === d.id);
  expect(offer).toBeDefined();
  const res = await rpc(d.userId, "accept_ride_offer", [offer.id]);
  expect(res.code).toBe("ACCEPTED");
  return ride;
}

/** Course instantanée attribuée manuellement à un chauffeur au GPS muet → alerte no_gps ouverte. */
async function rideWithNoGpsAlert(name: string) {
  const org = await createOrg(name);
  const d = await createDriver(org, { firstName: "Lina", at: north(CHAMPS_ELYSEES, 1500), locationAgeSeconds: 600 });
  const ride = await createRideAsOwner(org);
  expect((await assign(org, ride.id, d.id)).code).toBe("ASSIGNED");
  await watch();
  const alert = await openAlert(ride.id, "no_gps");
  expect(alert).toBeDefined();
  return { org, d, ride, alert };
}

describe("watch_rides — retard", () => {
  it("planifiée imminente, chauffeur à 30 km : alerte « late » critique + journal + temps réel org", async () => {
    const org = await createOrg("Late Far");
    const other = await createOrg("Late Other");
    const d = await createDriver(org, { firstName: "Karim", at: north(CHAMPS_ELYSEES, 30_000) });
    const ride = await createRideAsOwner(org, { pickup_at: inMinutes(60) });
    expect(ride.type).toBe("scheduled");
    expect((await assign(org, ride.id, d.id)).code).toBe("ASSIGNED");

    const summary = await watch();
    expect(summary.ok).toBe(true);
    expect(summary.opened).toBeGreaterThanOrEqual(1);

    const alerts = await alertsOf(ride.id);
    expect(alerts.map((a) => a.kind)).toEqual(["late"]);
    const a = alerts[0];
    expect(a.status).toBe("open");
    expect(a.severity).toBe("critical");
    expect(a.organization_id).toBe(org.id);
    expect(a.driver_id).toBe(d.id);
    expect(a.message).toMatch(/^Karim sera en retard d'environ (20|21|22) min$/);
    expect(a.data).toMatchObject({
      alert_id: a.id, ride_number: Number(ride.number), driver_id: d.id, driver_name: "Karim", driver_number: d.number,
      actions: ["keep", "reassign", "relaunch"], tolerance_minutes: 5,
    });
    expect(a.data.delay_minutes).toBeGreaterThanOrEqual(20);
    expect(a.data.eta_minutes).toBeGreaterThanOrEqual(80);
    expect(a.data.distance_m).toBeGreaterThan(29_000);

    const [ev] = await eventsOf(ride.id, "alert.late");
    expect(ev).toMatchObject({ category: "timeline", level: "warning", message: a.message, actor_type: "system" });
    expect(ev.data).toMatchObject({ alert_id: a.id, kind: "late", severity: "critical", actions: ["keep", "reassign", "relaunch"] });

    const msgs = await alertBroadcasts(a.id);
    expect(msgs.map((m) => m.topic)).toEqual([`org:${org.id}`]);
    expect(msgs[0].payload).toMatchObject({ op: "insert", id: a.id, ride_id: ride.id, kind: "late", status: "open", severity: "critical" });
    const leaked = await sql("select 1 from realtime.messages where event = 'ride.alert' and topic = $1", [`org:${other.id}`]);
    expect(leaked).toHaveLength(0);
  });

  it("retard sous la tolérance de l'organisation : pas d'alerte ; au-dessus : « warning »", async () => {
    const strict = await createOrg("Late Tolerance 5");
    const lax = await createOrg("Late Tolerance 10", { settings: { late_alert_tolerance_minutes: 10 } });
    const results: Record<string, Alert[]> = {};
    for (const org of [strict, lax]) {
      const d = await createDriver(org, { firstName: "Omar", at: north(CHAMPS_ELYSEES, 25_000) });
      const ride = await createRideAsOwner(org, { pickup_at: inMinutes(60) });
      await assign(org, ride.id, d.id);
      await watch();
      results[org.id] = await alertsOf(ride.id);
    }
    // ~25 km → ETA ≈ 68 min pour une prise en charge dans 60 min : ≈ 8 min de retard
    expect(results[strict.id].map((a) => [a.kind, a.severity])).toEqual([["late", "warning"]]);
    expect(results[strict.id][0].message).toMatch(/^Omar sera en retard d'environ (7|8|9) min$/);
    expect(results[lax.id]).toHaveLength(0);
  });

  it("planifiée dans plus de 90 min : pas surveillée", async () => {
    const org = await createOrg("Late Not Yet");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 60_000) });
    const ride = await createRideAsOwner(org, { pickup_at: inMinutes(120) });
    await assign(org, ride.id, d.id);
    await watch();
    expect(await alertsOf(ride.id)).toHaveLength(0);
  });

  it("instantanée : référence = heure promise à l'acceptation ; message mis à jour ; close automatiquement", async () => {
    const org = await createOrg("Late Instant");
    const d = await createDriver(org, { firstName: "Samir", at: north(CHAMPS_ELYSEES, 3000) });
    const ride = await acceptedInstant(org, d);

    // Juste après l'acceptation, le chauffeur est « à l'heure » (ETA annoncé = ETA actuel)
    await watch();
    expect(await openAlert(ride.id, "late")).toBeUndefined();

    // 10 minutes plus tard, il n'a pas avancé
    await sql(
      "update public.rides set accepted_at = accepted_at - interval '10 minutes', pickup_at = pickup_at - interval '10 minutes' where id = $1",
      [ride.id],
    );
    await watch();
    const a = await openAlert(ride.id, "late");
    expect(a).toBeDefined();
    expect(a.severity).toBe("warning");
    expect(a.message).toMatch(/^Samir sera en retard d'environ (10|11) min$/);

    // Idempotent : deux passages de plus ne changent rien
    await watch();
    await watch();
    const same = await alertsOf(ride.id);
    expect(same.filter((x) => x.kind === "late")).toHaveLength(1);
    expect(same.find((x) => x.kind === "late")!.updated_at).toEqual(a.updated_at);
    expect(await eventsOf(ride.id, "alert.late")).toHaveLength(1);

    // Il s'éloigne (6 km) : même alerte, message et gravité mis à jour, pas de nouvel événement
    await setLocation(org, d, north(CHAMPS_ELYSEES, 6000));
    await watch();
    const worse = await openAlert(ride.id, "late");
    expect(worse.id).toBe(a.id);
    expect(worse.severity).toBe("critical");
    expect(worse.message).toMatch(/^Samir sera en retard d'environ (17|18|19) min$/);
    expect(await eventsOf(ride.id, "alert.late")).toHaveLength(1);
    expect((await alertBroadcasts(a.id)).map((m) => m.payload.op)).toEqual(["insert", "update"]);

    // Il arrive presque au départ : alerte close automatiquement
    await setLocation(org, d, north(CHAMPS_ELYSEES, 100));
    const s = await watch();
    expect(s.resolved).toBeGreaterThanOrEqual(1);
    const [closed] = await sql<Alert>("select * from public.ride_alerts where id = $1", [a.id]);
    expect(closed).toMatchObject({ status: "resolved", resolution: "auto_resolved", resolved_by: null });
    expect(closed.resolved_at).not.toBeNull();
    const [ev] = await eventsOf(ride.id, "alert.resolved");
    expect(ev).toMatchObject({ category: "dispatch", level: "info", message: "Alerte close : retard" });
    expect((await alertBroadcasts(a.id)).map((m) => m.payload.op)).toEqual(["insert", "update", "resolve"]);
  });

  it("position périmée : pas de verdict « retard » (c'est le GPS qui alerte)", async () => {
    const org = await createOrg("Late Unknown");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 40_000), locationAgeSeconds: 900 });
    const ride = await createRideAsOwner(org, { pickup_at: inMinutes(60) });
    await assign(org, ride.id, d.id);
    await watch();
    expect((await alertsOf(ride.id)).map((a) => a.kind)).not.toContain("late");
  });
});

describe("watch_rides — chauffeur immobile", () => {
  async function enRoute(name: string, at: [number, number]) {
    const org = await createOrg(name);
    const d = await createDriver(org, { firstName: "Yanis", at });
    const ride = await acceptedInstant(org, d);
    expect((await driverStatus(d, ride.id, "DRIVER_EN_ROUTE")).code).toBe("UPDATED");
    return { org, d, ride };
  }

  it("en route, n'a pas bougé de 150 m depuis 6 min à 2 km du départ → « stalled », puis close quand il repart", async () => {
    const { org, d, ride } = await enRoute("Stalled", north(CHAMPS_ELYSEES, 2000));
    await sql(
      "update public.rides set accepted_at = now() - interval '7 minutes', driver_en_route_at = now() - interval '6 minutes' where id = $1",
      [ride.id],
    );
    for (const [s, jitter] of [[400, 0], [300, 40], [180, 0], [60, 60]]) {
      await addHistory(org, d, north(CHAMPS_ELYSEES, 2000 + jitter), s);
    }
    await watch();
    const a = await openAlert(ride.id, "stalled");
    expect(a).toBeDefined();
    expect(a.severity).toBe("warning");
    expect(a.message).toBe("Yanis est immobile depuis 6 min, à 2 km du départ");
    expect(a.data).toMatchObject({ still_minutes: 6, threshold_minutes: 4 });
    expect(a.data.distance_m).toBeGreaterThan(1900);
    expect((await eventsOf(ride.id, "alert.stalled"))[0].level).toBe("warning");

    // Il a roulé il y a 90 s (point à 1 km), puis s'est arrêté : plus « immobile »
    await addHistory(org, d, north(CHAMPS_ELYSEES, 3000), 90);
    await watch();
    const [closed] = await sql<Alert>("select status, resolution from public.ride_alerts where id = $1", [a.id]);
    expect(closed).toEqual({ status: "resolved", resolution: "auto_resolved" });
  });

  it("jamais « immobile » à moins de 800 m du départ, ni juste après le départ", async () => {
    const near = await enRoute("Stalled Near", north(CHAMPS_ELYSEES, 600));
    await sql("update public.rides set driver_en_route_at = now() - interval '10 minutes' where id = $1", [near.ride.id]);
    for (const s of [590, 400, 200, 30]) await addHistory(near.org, near.d, north(CHAMPS_ELYSEES, 600), s);

    const fresh = await enRoute("Stalled Fresh", north(CHAMPS_ELYSEES, 3000));
    await sql("update public.rides set driver_en_route_at = now() - interval '1 minute' where id = $1", [fresh.ride.id]);
    for (const s of [900, 400, 200, 30]) await addHistory(fresh.org, fresh.d, north(CHAMPS_ELYSEES, 3000), s);

    await watch();
    expect(await openAlert(near.ride.id, "stalled")).toBeUndefined();
    expect(await openAlert(fresh.ride.id, "stalled")).toBeUndefined();
  });

  it("seuil réglable par organisation (stalled_alert_minutes)", async () => {
    const org = await createOrg("Stalled Setting", { settings: { stalled_alert_minutes: 10 } });
    const d = await createDriver(org, { firstName: "Yanis", at: north(CHAMPS_ELYSEES, 2000) });
    const ride = await acceptedInstant(org, d);
    await driverStatus(d, ride.id, "DRIVER_EN_ROUTE");
    await sql("update public.rides set driver_en_route_at = now() - interval '6 minutes' where id = $1", [ride.id]);
    for (const s of [400, 200, 30]) await addHistory(org, d, north(CHAMPS_ELYSEES, 2000), s);
    await watch();
    expect(await openAlert(ride.id, "stalled")).toBeUndefined();
  });
});

describe("watch_rides — GPS muet", () => {
  it("course active sans position depuis 10 min → « no_gps » critique ; position revenue → close", async () => {
    const { org, d, ride, alert } = await rideWithNoGpsAlert("No GPS");
    expect(alert.severity).toBe("critical");
    expect(alert.message).toBe("Plus de position GPS de Lina depuis 10 min");
    expect(alert.data).toMatchObject({ location_age_s: expect.any(Number), max_age_s: 180 });
    expect(alert.data.location_age_s).toBeGreaterThanOrEqual(600);

    await setLocation(org, d, north(CHAMPS_ELYSEES, 1500));
    await watch();
    const [closed] = await sql<Alert>("select status, resolution from public.ride_alerts where id = $1", [alert.id]);
    expect(closed).toEqual({ status: "resolved", resolution: "auto_resolved" });
  });

  it("position vieille de 4 min → « warning » ; aucune position → « Aucune position GPS reçue »", async () => {
    const org = await createOrg("No GPS Mix");
    const late = await createDriver(org, { firstName: "Hugo", at: north(CHAMPS_ELYSEES, 1000), locationAgeSeconds: 240 });
    const none = await createDriver(org, { firstName: "Nora" });
    const r1 = await createRideAsOwner(org);
    await assign(org, r1.id, late.id);
    const r2 = await createRideAsOwner(org);
    await assign(org, r2.id, none.id);
    await watch();
    const a1 = await openAlert(r1.id, "no_gps");
    expect([a1.severity, a1.message]).toEqual(["warning", "Plus de position GPS de Hugo depuis 4 min"]);
    const a2 = await openAlert(r2.id, "no_gps");
    expect([a2.severity, a2.message]).toEqual(["critical", "Aucune position GPS reçue de Nora"]);
    expect(a2.data.last_location_at).toBeNull();
  });

  it("client à bord, GPS coupé : alerte aussi (course active jusqu'à IN_PROGRESS)", async () => {
    const org = await createOrg("No GPS Onboard");
    const d = await createDriver(org, { firstName: "Ilyes", at: north(CHAMPS_ELYSEES, 500) });
    const ride = await acceptedInstant(org, d);
    for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS"]) {
      expect((await driverStatus(d, ride.id, s)).code).toBe("UPDATED");
    }
    await setLocation(org, d, north(CHAMPS_ELYSEES, 500), 400);
    await watch();
    expect((await openAlert(ride.id, "no_gps"))?.severity).toBe("warning");

    // Course terminée : l'alerte est close au passage suivant
    await setLocation(org, d, north(CHAMPS_ELYSEES, 500), 400);
    expect((await driverStatus(d, ride.id, "COMPLETED")).code).toBe("UPDATED");
    await watch();
    expect((await alertsOf(ride.id)).every((a) => a.status === "resolved" && a.resolution === "auto_resolved")).toBe(true);
  });
});

describe("watch_rides — planifiée non démarrée", () => {
  it("prise en charge dans 20 min, chauffeur hors ligne → « not_started » ; < 15 min → critique ; en ligne → close", async () => {
    const org = await createOrg("Not Started");
    const d = await createDriver(org, { firstName: "Adam", presence: "offline" });
    const ride = await createRideAsOwner(org, { pickup_at: inMinutes(180) });
    expect(ride.type).toBe("scheduled");
    await assign(org, ride.id, d.id);
    await watch();
    expect(await alertsOf(ride.id)).toHaveLength(0);

    await sql("update public.rides set pickup_at = now() + interval '20 minutes' where id = $1", [ride.id]);
    await watch();
    const a = await openAlert(ride.id, "not_started");
    expect(a.severity).toBe("warning");
    expect(a.message).toMatch(/^Adam n'a pas démarré — prise en charge à \d\d:\d\d, chauffeur hors ligne$/);
    expect(a.data).toMatchObject({ presence: "offline", last_location_at: null });
    expect(a.data.minutes_to_pickup).toBeGreaterThanOrEqual(19);
    expect((await alertsOf(ride.id)).map((x) => x.kind)).toEqual(["not_started"]);

    await sql("update public.rides set pickup_at = now() + interval '10 minutes' where id = $1", [ride.id]);
    await watch();
    const worse = await openAlert(ride.id, "not_started");
    expect([worse.id, worse.severity]).toEqual([a.id, "critical"]);

    // En ligne, position fraîche, proche du départ : close (et pas de retard)
    await sql("update public.drivers set presence = 'available' where id = $1", [d.id]);
    await setLocation(org, d, north(CHAMPS_ELYSEES, 300));
    await watch();
    const all = await alertsOf(ride.id);
    expect(all.map((x) => [x.kind, x.status, x.resolution])).toEqual([["not_started", "resolved", "auto_resolved"]]);
  });

  it("chauffeur en ligne mais sans GPS → « chauffeur sans position GPS »", async () => {
    const org = await createOrg("Not Started GPS");
    const d = await createDriver(org, { firstName: "Rayan", at: north(CHAMPS_ELYSEES, 800), locationAgeSeconds: 1200 });
    const ride = await createRideAsOwner(org, { pickup_at: inMinutes(180) });
    await assign(org, ride.id, d.id);
    await sql("update public.rides set pickup_at = now() + interval '25 minutes' where id = $1", [ride.id]);
    await watch();
    expect((await openAlert(ride.id, "not_started")).message).toMatch(/chauffeur sans position GPS$/);
  });
});

describe("acknowledge_ride_alert — « Garder »", () => {
  it("sourdine 15 min : pas de nouvelle alerte ; à l'échéance, nouvelle alerte si le problème persiste", async () => {
    const { org, ride, alert } = await rideWithNoGpsAlert("Ack Mute");
    const res = await rpc(org.ownerId, "acknowledge_ride_alert", [alert.id]);
    expect(res).toMatchObject({ ok: true, code: "ACKNOWLEDGED" });
    expect(res.alert).toMatchObject({ id: alert.id, status: "acknowledged", resolution: "kept", op: "update" });

    const [row] = await sql<Alert & { muted_ok: boolean }>(
      "select *, muted_until between now() + interval '14 minutes' and now() + interval '16 minutes' as muted_ok from public.ride_alerts where id = $1",
      [alert.id],
    );
    expect(row).toMatchObject({ status: "acknowledged", resolution: "kept", resolved_by: org.ownerId, muted_ok: true });
    const [kept] = await eventsOf(ride.id, "alert.kept");
    expect(kept).toMatchObject({ category: "timeline", actor_type: "user", actor_id: org.ownerId });
    expect(kept.message).toMatch(/^Alerte « GPS muet » : la centrale garde Lina/);
    expect((await alertBroadcasts(alert.id)).at(-1)?.payload).toMatchObject({ op: "update", status: "acknowledged" });

    // Toujours sans GPS, mais en sourdine
    await watch();
    expect(await alertsOf(ride.id)).toHaveLength(1);
    expect((await rpc(org.ownerId, "acknowledge_ride_alert", [alert.id])).code).toBe("ALREADY_ACKNOWLEDGED");

    // Sourdine écoulée : l'ancienne est close (« gardée »), une nouvelle s'ouvre
    await sql("update public.ride_alerts set muted_until = now() - interval '1 second' where id = $1", [alert.id]);
    await watch();
    const all = await alertsOf(ride.id);
    expect(all.map((a) => [a.status, a.resolution])).toEqual([["resolved", "kept"], ["open", null]]);
    expect(all[1].id).not.toBe(alert.id);
    expect(await eventsOf(ride.id, "alert.no_gps")).toHaveLength(2);
    // La relance d'une alerte « gardée » n'est pas journalisée comme « close automatiquement »
    expect(await eventsOf(ride.id, "alert.resolved")).toHaveLength(0);
  });

  it("rôles : dispatcher autorisé ; autre organisation / chauffeur → 42501 ; anon sans droit", async () => {
    const { org, d, alert } = await rideWithNoGpsAlert("Ack Roles");
    const other = await createOrg("Ack Roles Other");
    const e1 = await expectPgError(rpc(other.ownerId, "acknowledge_ride_alert", [alert.id]));
    expect(e1.code).toBe("42501");
    const e2 = await expectPgError(rpc(d.userId, "acknowledge_ride_alert", [alert.id]));
    expect(e2.code).toBe("42501");
    const e3 = await expectPgError(as({ role: "anon" }, (q) => q("select public.acknowledge_ride_alert($1)", [alert.id])));
    expect(e3.code).toBe("42501");
    expect((await sql("select status from public.ride_alerts where id = $1", [alert.id]))[0].status).toBe("open");

    const dispatcher = await createMember(org, "dispatcher");
    expect((await rpc(dispatcher, "acknowledge_ride_alert", [alert.id])).code).toBe("ACKNOWLEDGED");
  });

  it("alerte déjà close → ALERT_CLOSED ; inconnue → ALERT_NOT_FOUND", async () => {
    const { org, ride, alert } = await rideWithNoGpsAlert("Ack Closed");
    await rpc(org.ownerId, "cancel_ride", [ride.id, "Client absent"]);
    await watch();
    expect((await rpc(org.ownerId, "acknowledge_ride_alert", [alert.id])).code).toBe("ALERT_CLOSED");
    expect((await rpc(org.ownerId, "acknowledge_ride_alert", ["00000000-0000-0000-0000-000000000000"])).code).toBe("ALERT_NOT_FOUND");
  });
});

describe("reassign_ride — « Relancer » (retirer la course au chauffeur)", () => {
  async function setup(name: string) {
    const org = await createOrg(name);
    const x = await createDriver(org, { firstName: "Xavier", at: north(CHAMPS_ELYSEES, 900) });
    const y = await createDriver(org, { firstName: "Yacine", at: north(CHAMPS_ELYSEES, 2500) });
    const ride = await acceptedInstant(org, x);
    expect((await driverStatus(x, ride.id, "DRIVER_EN_ROUTE")).code).toBe("UPDATED");
    return { org, x, y, ride };
  }

  it("retire la course, exclut le chauffeur, relance à 4 km, clôt les alertes, prévient tout le monde", async () => {
    const { org, x, y, ride } = await setup("Reassign");
    // Alerte ouverte (GPS muet), puis GPS revenu : Xavier est le plus proche et disponible après retrait
    await setLocation(org, x, north(CHAMPS_ELYSEES, 900), 400);
    await watch();
    const alert = await openAlert(ride.id, "no_gps");
    expect(alert).toBeDefined();
    await setLocation(org, x, north(CHAMPS_ELYSEES, 900));
    const [reminder] = await sql(
      `insert into public.notifications (organization_id, driver_id, ride_id, type, title, body, scheduled_for)
       values ($1, $2, $3, 'ride_reminder', 'Rappel', 'x', now() + interval '1 hour') returning id`,
      [org.id, x.id, ride.id],
    );

    const res = await rpc(org.ownerId, "reassign_ride", [ride.id, "Chauffeur injoignable"]);
    expect(res).toMatchObject({
      ok: true, code: "RELAUNCHED", ride_id: ride.id, previous_driver_id: x.id, type: "instant", status: "OFFERED",
      notified: 1, closed_alerts: 1,
    });

    const state = await rideState(ride.id);
    expect(state.ride).toMatchObject({
      status: "OFFERED", driver_id: null, vehicle_id: null, dispatch_mode: "geo", dispatch_wave: 1, dispatch_radius_m: 4000,
      accepted_at: null, driver_en_route_at: null,
    });
    const marker = state.offers.find((o) => o.driver_id === x.id && o.closed_reason === "removed_by_dispatch");
    expect(marker).toMatchObject({ status: "closed", mode: "geo", wave: 0 });
    expect(state.offers.filter((o) => o.status === "pending").map((o) => [o.driver_id, o.wave, o.radius_m])).toEqual([[y.id, 1, 4000]]);

    const [dx] = await sql("select presence, current_ride_id from public.drivers where id = $1", [x.id]);
    expect(dx).toEqual({ presence: "available", current_ride_id: null });

    const assignments = await sql("select is_active, release_reason from public.ride_assignments where ride_id = $1", [ride.id]);
    expect(assignments).toEqual([{ is_active: false, release_reason: "reassigned_by_dispatch" }]);

    const notifs = await sql(
      "select type, title, body, status, data from public.notifications where ride_id = $1 and driver_id = $2 order by created_at",
      [ride.id, x.id],
    );
    expect(notifs.find((n) => n.type === "ride_unassigned")).toMatchObject({
      title: "COURSE RETIRÉE", body: `La centrale a réattribué la course #${ride.number}`, status: "queued",
      data: { type: "ride_unassigned", ride_id: ride.id, reason: "Chauffeur injoignable" },
    });
    expect((await sql("select status from public.notifications where id = $1", [reminder.id]))[0].status).toBe("cancelled");

    const [closed] = await sql<Alert>("select * from public.ride_alerts where id = $1", [alert.id]);
    expect(closed).toMatchObject({ status: "resolved", resolution: "relaunched", resolved_by: org.ownerId });

    const [ev] = await eventsOf(ride.id, "ride.reassigned");
    expect(ev).toMatchObject({ level: "warning", actor_type: "user", actor_id: org.ownerId });
    expect(ev.message).toBe(`Course retirée à Xavier Test (#${x.number}) par la centrale : Chauffeur injoignable — nouvelle recherche`);

    const history = await sql("select from_status, to_status from public.ride_status_history where ride_id = $1 order by id", [ride.id]);
    expect(history).toContainEqual({ from_status: "DRIVER_EN_ROUTE", to_status: "SEARCHING_DRIVER" });

    const unassigned = await sql(
      "select 1 from realtime.messages where event = 'ride.unassigned' and topic = $1 and payload->>'id' = $2",
      [`driver:${x.id}`, ride.id],
    );
    expect(unassigned).toHaveLength(1);

    // Xavier ne peut pas reprendre la course avec son ancienne offre (acceptée avant le retrait)
    const oldOffer = state.offers.find((o) => o.driver_id === x.id && o.status === "accepted")!;
    expect(oldOffer).toBeDefined();
    expect((await rpc(x.userId, "accept_ride_offer", [oldOffer.id])).code).toBe("OFFER_CLOSED");
    expect((await rideState(ride.id)).ride).toMatchObject({ driver_id: null, status: "OFFERED" });

    // Yacine refuse, les vagues suivantes ne re-sollicitent jamais Xavier (pourtant le plus proche)
    const yOffer = state.offers.find((o) => o.driver_id === y.id && o.status === "pending")!;
    expect((await rpc(y.userId, "decline_ride_offer", [yOffer.id])).ok).toBe(true);
    for (let i = 0; i < 3; i++) {
      await sql("update public.rides set next_dispatch_at = now() - interval '1 second' where id = $1", [ride.id]);
      await sql("select private.dispatch_tick()");
    }
    const xOffers = await sql("select status, closed_reason from public.ride_offers where ride_id = $1 and driver_id = $2", [ride.id, x.id]);
    expect(xOffers.filter((o) => o.status === "pending")).toHaveLength(0);
    expect((await rideState(ride.id)).ride.status).toBe("SEARCHING_DRIVER");

    // L'ancienne alerte n'est pas rouverte, et la course (sans chauffeur) n'est plus surveillée
    await watch();
    expect((await alertsOf(ride.id)).filter((a) => a.status !== "resolved")).toHaveLength(0);
  });

  it("chauffeur changé entre-temps : DRIVER_CHANGED, rien n'est retiré", async () => {
    const { org, x, y, ride } = await setup("Reassign CAS");
    expect((await assign(org, ride.id, y.id)).ok).toBe(true);
    const res = await rpc(org.ownerId, "reassign_ride", [ride.id, "Injoignable", x.id]);
    expect(res).toMatchObject({ ok: false, code: "DRIVER_CHANGED", driver_id: y.id });
    const [r] = await sql("select driver_id, status from public.rides where id = $1", [ride.id]);
    expect(r).toEqual({ driver_id: y.id, status: "ACCEPTED" });
    // chauffeur attendu = chauffeur actuel : retrait effectué
    expect((await rpc(org.ownerId, "reassign_ride", [ride.id, null, y.id])).ok).toBe(true);
  });

  it("dispatch automatique désactivé : course retirée, en attente d'attribution manuelle, sans relance", async () => {
    const { org, x, ride } = await setup("Reassign manual");
    await sql("update public.organization_settings set auto_dispatch = false where organization_id = $1", [org.id]);
    const res = await rpc(org.ownerId, "reassign_ride", [ride.id, null]);
    expect(res).toMatchObject({ ok: true, code: "UNASSIGNED", status: "CREATED", notified: 0 });
    const state = await rideState(ride.id);
    expect(state.ride).toMatchObject({ status: "CREATED", driver_id: null, dispatch_started_at: null });
    expect(state.offers.filter((o) => o.status === "pending")).toHaveLength(0);
    const [ev] = await eventsOf(ride.id, "ride.reassigned");
    expect(ev.message).toContain("à attribuer manuellement");
    const [dx] = await sql("select presence from public.drivers where id = $1", [x.id]);
    expect(dx.presence).toBe("available");
  });

  it("le retrait ne compte pas comme un refus du chauffeur (taux d'acceptation intact)", async () => {
    const { org, x, ride } = await setup("Reassign stats");
    await rpc(org.ownerId, "reassign_ride", [ride.id, null]);
    const metrics = await as({ sub: org.ownerId }, (q) => q("select * from public.org_driver_metrics($1, 30)", [org.id]));
    const mx = metrics.find((m) => m.driver_id === x.id)!;
    expect(mx).toMatchObject({ declined: "0" });
    expect(Number(mx.acceptance_rate)).toBe(1);
  });

  it("planifiée : remise à toute la flotte, sauf le chauffeur retiré", async () => {
    const org = await createOrg("Reassign Fleet");
    const x = await createDriver(org, { firstName: "Xavier", at: north(CHAMPS_ELYSEES, 900) });
    const y = await createDriver(org, { firstName: "Yacine", presence: "offline" });
    const ride = await createRideAsOwner(org, { pickup_at: inMinutes(300) });
    await assign(org, ride.id, x.id);
    const res = await rpc(org.ownerId, "reassign_ride", [ride.id, null]);
    expect(res).toMatchObject({ ok: true, type: "scheduled", status: "OFFERED" });
    const state = await rideState(ride.id);
    expect(state.ride.dispatch_mode).toBe("fleet");
    expect(state.offers.filter((o) => o.status === "pending").map((o) => [o.driver_id, o.mode])).toEqual([[y.id, "fleet"]]);
    const [ev] = await eventsOf(ride.id, "ride.reassigned");
    expect(ev.message).toBe(`Course retirée à Xavier Test (#${x.number}) par la centrale — nouvelle recherche`);

    // Re-balayage de la flotte (toutes les 5 min) : toujours pas Xavier
    await sql("update public.rides set next_dispatch_at = now() - interval '1 second' where id = $1", [ride.id]);
    await sql("select private.dispatch_tick()");
    const xPending = await sql("select 1 from public.ride_offers where ride_id = $1 and driver_id = $2 and status = 'pending'", [ride.id, x.id]);
    expect(xPending).toHaveLength(0);
  });

  it("chauffeur arrivé au départ : retrait possible ; client à bord : refusé", async () => {
    const { org, x, ride } = await setup("Reassign Arrived");
    expect((await driverStatus(x, ride.id, "DRIVER_ARRIVED")).code).toBe("UPDATED");
    expect((await rpc(org.ownerId, "reassign_ride", [ride.id, null])).code).toBe("RELAUNCHED");

    const s2 = await setup("Reassign Onboard");
    await driverStatus(s2.x, s2.ride.id, "DRIVER_ARRIVED");
    await driverStatus(s2.x, s2.ride.id, "PASSENGER_ONBOARD");
    const res = await rpc(s2.org.ownerId, "reassign_ride", [s2.ride.id, null]);
    expect(res).toMatchObject({ ok: false, code: "RIDE_NOT_REASSIGNABLE", status: "PASSENGER_ONBOARD" });
    expect((await assign(s2.org, s2.ride.id, s2.y.id)).code).toBe("RIDE_NOT_ASSIGNABLE");
    expect((await rideState(s2.ride.id)).ride.driver_id).toBe(s2.x.id);
  });

  it("course sans chauffeur / inconnue → refus métier ; autre organisation, chauffeur, anon → 42501", async () => {
    const { org, x, ride } = await setup("Reassign Guards");
    const lonely = await createOrg("Reassign Lonely");
    const searching = await createRideAsOwner(lonely);
    expect((await rpc(lonely.ownerId, "reassign_ride", [searching.id, null])).code).toBe("RIDE_NOT_REASSIGNABLE");
    expect((await rpc(org.ownerId, "reassign_ride", ["00000000-0000-0000-0000-000000000000", null])).code).toBe("RIDE_NOT_FOUND");

    const e1 = await expectPgError(rpc(lonely.ownerId, "reassign_ride", [ride.id, null]));
    expect(e1.code).toBe("42501");
    const e2 = await expectPgError(rpc(x.userId, "reassign_ride", [ride.id, null]));
    expect(e2.code).toBe("42501");
    const e3 = await expectPgError(as({ role: "anon" }, (q) => q("select public.reassign_ride($1)", [ride.id])));
    expect(e3.code).toBe("42501");
    expect((await rideState(ride.id)).ride).toMatchObject({ driver_id: x.id, status: "DRIVER_EN_ROUTE" });

    // Le dispatcher de l'organisation peut relancer
    const dispatcher = await createMember(org, "dispatcher");
    expect((await rpc(dispatcher, "reassign_ride", [ride.id, null])).code).toBe("RELAUNCHED");
  });
});

describe("assign_ride — réattribution à un chauffeur choisi", () => {
  it("depuis « en route » : nouveau chauffeur, ancien libéré et prévenu, alertes closes « reassigned »", async () => {
    const org = await createOrg("Assign En Route");
    const x = await createDriver(org, { firstName: "Xavier", at: north(CHAMPS_ELYSEES, 900) });
    const y = await createDriver(org, { firstName: "Yacine", at: north(CHAMPS_ELYSEES, 2500) });
    const ride = await acceptedInstant(org, x);
    await driverStatus(x, ride.id, "DRIVER_EN_ROUTE");
    await setLocation(org, x, north(CHAMPS_ELYSEES, 900), 400);
    await watch();
    const alert = await openAlert(ride.id, "no_gps");
    expect(alert).toBeDefined();

    expect((await assign(org, ride.id, y.id)).code).toBe("ASSIGNED");
    const { ride: r } = await rideState(ride.id);
    expect(r).toMatchObject({ driver_id: y.id, status: "ACCEPTED", driver_en_route_at: null });
    const drivers = await sql("select id, presence, current_ride_id from public.drivers where id = any($1) order by first_name", [[x.id, y.id]]);
    expect(drivers).toEqual([
      { id: x.id, presence: "available", current_ride_id: null },
      { id: y.id, presence: "en_route", current_ride_id: ride.id },
    ]);
    const [closed] = await sql<Alert>("select status, resolution, resolved_by from public.ride_alerts where id = $1", [alert.id]);
    expect(closed).toEqual({ status: "resolved", resolution: "reassigned", resolved_by: org.ownerId });
    const types = await sql("select driver_id, type from public.notifications where ride_id = $1 and type in ('ride_unassigned', 'ride_assigned')", [ride.id]);
    expect(types).toEqual(expect.arrayContaining([{ driver_id: x.id, type: "ride_unassigned" }, { driver_id: y.id, type: "ride_assigned" }]));
    const [ev] = await eventsOf(ride.id, "ride.assigned_manually");
    expect(ev.data).toMatchObject({ previous_driver_id: x.id, previous_status: "DRIVER_EN_ROUTE", closed_alerts: 1 });

    // Le nouveau chauffeur (GPS frais, proche) ne déclenche rien
    await watch();
    expect((await alertsOf(ride.id)).filter((a) => a.status === "open")).toHaveLength(0);
  });
});

describe("watch_rides — clôture, isolation, droits", () => {
  it("course annulée : alertes closes au passage suivant", async () => {
    const { org, ride, alert } = await rideWithNoGpsAlert("Cancelled Alert");
    await rpc(org.ownerId, "cancel_ride", [ride.id, null]);
    await watch();
    const [row] = await sql<Alert>("select status, resolution from public.ride_alerts where id = $1", [alert.id]);
    expect(row).toEqual({ status: "resolved", resolution: "auto_resolved" });
  });

  it("RLS : lecture par l'organisation et le super admin uniquement ; aucune écriture directe", async () => {
    const { org, d, ride, alert } = await rideWithNoGpsAlert("RLS Alerts");
    const other = await createOrg("RLS Alerts Other");

    const own = await as({ sub: org.ownerId }, (q) => q("select id from public.ride_alerts"));
    expect(own.map((a) => a.id)).toContain(alert.id);
    expect(await as({ sub: other.ownerId }, (q) => q("select id from public.ride_alerts where id = $1", [alert.id]))).toHaveLength(0);
    expect(await as({ sub: d.userId }, (q) => q("select id from public.ride_alerts"))).toHaveLength(0);

    const admin = await createMember(other, "admin", "Super Admin");
    await sql("update public.users set is_super_admin = true where id = $1", [admin]);
    expect(await as({ sub: admin }, (q) => q("select id from public.ride_alerts where id = $1", [alert.id]))).toHaveLength(1);

    const writes = [
      q => q(
        "insert into public.ride_alerts (organization_id, ride_id, kind, message) values ($1, $2, 'late', 'x')",
        [org.id, ride.id],
      ),
      q => q("update public.ride_alerts set status = 'resolved' where id = $1", [alert.id]),
      q => q("delete from public.ride_alerts where id = $1", [alert.id]),
    ] as ((q: any) => Promise<unknown>)[];
    for (const w of writes) {
      const err = await expectPgError(as({ sub: org.ownerId }, w));
      expect(err.code).toBe("42501");
    }
    expect((await sql("select status from public.ride_alerts where id = $1", [alert.id]))[0].status).toBe("open");

    // organization_id immuable, même en superutilisateur
    const e = await expectPgError(sql("update public.ride_alerts set organization_id = $1 where id = $2", [other.id, alert.id]));
    expect(e.code).toBe("42501");

    // Temps réel : l'alerte n'est diffusée que sur org:<org>, lisible par ses seuls membres
    const mine = await as({ sub: org.ownerId }, (q) => q("select count(*)::int as n from realtime.messages where event = 'ride.alert'"), {
      topic: `org:${org.id}`,
    });
    expect(mine[0].n).toBeGreaterThan(0);
    const spy = await as({ sub: other.ownerId }, (q) => q("select count(*)::int as n from realtime.messages where event = 'ride.alert'"), {
      topic: `org:${org.id}`,
    });
    expect(spy[0].n).toBe(0);
  });

  it("une alerte ne peut pas être liée à une course d'un autre tenant (clé composite)", async () => {
    const { ride } = await rideWithNoGpsAlert("FK Alerts");
    const other = await createOrg("FK Alerts Other");
    const err = await expectPgError(
      sql("insert into public.ride_alerts (organization_id, ride_id, kind, message) values ($1, $2, 'late', 'x')", [other.id, ride.id]),
    );
    expect(err.code).toBe("23503");
  });

  it("réglages : bornes vérifiées, modifiables par les administrateurs seulement", async () => {
    const org = await createOrg("Alert Settings");
    const rows = await as({ sub: org.ownerId }, (q) =>
      q(
        "update public.organization_settings set late_alert_tolerance_minutes = 12, stalled_alert_minutes = 6 where organization_id = $1 returning late_alert_tolerance_minutes, stalled_alert_minutes",
        [org.id],
      ),
    );
    expect(rows).toEqual([{ late_alert_tolerance_minutes: 12, stalled_alert_minutes: 6 }]);
    for (const [col, value] of [["late_alert_tolerance_minutes", 0], ["late_alert_tolerance_minutes", 61], ["stalled_alert_minutes", 1], ["stalled_alert_minutes", 31]] as const) {
      const err = await expectPgError(
        as({ sub: org.ownerId }, (q) => q(`update public.organization_settings set ${col} = $2 where organization_id = $1`, [org.id, value])),
      );
      expect(err.code).toBe("23514");
    }
    const dispatcher = await createMember(org, "dispatcher");
    const none = await as({ sub: dispatcher }, (q) =>
      q("update public.organization_settings set late_alert_tolerance_minutes = 30 where organization_id = $1 returning 1", [org.id]),
    );
    expect(none).toHaveLength(0);
    const [defaults] = await sql(
      "select late_alert_tolerance_minutes, stalled_alert_minutes from public.organization_settings where organization_id = $1",
      [(await createOrg("Alert Defaults")).id],
    );
    expect(defaults).toEqual({ late_alert_tolerance_minutes: 5, stalled_alert_minutes: 4 });
  });

  it("watch_rides : réservé au worker (service_role), un seul passage à la fois", async () => {
    const org = await createOrg("Watch Grants");
    const err = await expectPgError(as({ sub: org.ownerId }, (q) => q("select private.watch_rides()")));
    expect(err.code).toBe("42501");
    const err2 = await expectPgError(
      as({ sub: org.ownerId }, (q) => q("select private.close_ride_alerts($1, 'kept', null)", ["00000000-0000-0000-0000-000000000000"])),
    );
    expect(err2.code).toBe("42501");
    const [ok] = await as({ role: "service_role" }, (q) => q("select private.watch_rides() as r"));
    expect(ok.r.ok).toBe(true);

    const c1 = await pool.connect();
    try {
      await c1.query("begin");
      await c1.query("select private.watch_rides()");
      const busy = await watch();
      expect(busy).toMatchObject({ ok: false, code: "LOCKED" });
      await c1.query("commit");
    } finally {
      c1.release();
    }
    expect((await watch()).ok).toBe(true);
  });
});
