import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  as, CDG, CHAMPS_ELYSEES, createAuthUser, createDriver, createOrg, createRideAsOwner, expectPgError, insertRideBypass,
  north, pool, rideState, sql, type Driver, type Org,
} from "./helpers";

const MIN = 60_000;
const HOUR = 60 * MIN;
const AIRPORT = "Aéroport Paris-Charles de Gaulle, Terminal 2E, 95700 Roissy-en-France";
const PARIS = "12 Avenue des Champs-Élysées, 75008 Paris";

/** Instant arrondi à la minute (les heures recalées sont tronquées à la minute). */
const minuteFromNow = (ms: number) => new Date(Math.ceil((Date.now() + ms) / MIN) * MIN);
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

const hm = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
const dm = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", timeZone: "Europe/Paris" });
const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" });
/** Même règle que private.fmt_local_time : « HH:MM », ou « DD/MM à HH:MM » si la date locale diffère. */
const label = (d: Date, ref: Date) => (ymd.format(d) === ymd.format(ref) ? hm.format(d) : `${dm.format(d)} à ${hm.format(d)}`);

type Flight = {
  status?: string | null;
  scheduled?: Date | null;
  estimated?: Date | null;
  actual?: Date | null;
  terminal?: string | null;
  origin?: string | null;
  provider?: string | null;
  /** Numéro interrogé par le worker (garde contre une modification entre-temps). */
  flightNumber?: string | null;
};

/** Résultat du fournisseur appliqué comme le worker (connexion directe). */
async function apply(rideId: string, f: Flight) {
  const [row] = await sql("select private.apply_flight_status($1, $2, $3, $4, $5, $6, $7, $8, $9) as r", [
    rideId, f.status ?? null, f.scheduled ?? null, f.estimated ?? null, f.actual ?? null, f.terminal ?? null,
    f.origin ?? null, f.provider ?? "test", f.flightNumber ?? null,
  ]);
  return row.r as {
    ok: boolean; code: string; mode: string; flight_status: string; delay_minutes: number | null; pickup_changed: boolean;
    pickup_at: string; previous_pickup_at: string; pickup_at_original: string | null; events: string[]; notified: boolean;
  };
}

async function airportRide(org: Org, pickupAt: Date, overrides: Record<string, unknown> = {}) {
  return createRideAsOwner(org, {
    pickup_address: AIRPORT, pickup_lat: CDG[0], pickup_lng: CDG[1],
    dropoff_address: PARIS, dropoff_lat: CHAMPS_ELYSEES[0], dropoff_lng: CHAMPS_ELYSEES[1],
    flight_number: "AF 1234", pickup_at: pickupAt.toISOString(), ...overrides,
  });
}

const flightEvents = async (rideId: string) =>
  sql("select type, level, message, data from public.ride_events where ride_id = $1 and type like 'flight.%' order by id", [rideId]);
const flightNotifs = async (rideId: string) =>
  sql("select driver_id, type, title, body, data, priority, status from public.notifications where ride_id = $1 and type = 'flight_update' order by created_at, id", [rideId]);
const orgRideMessages = async (org: Org, rideId: string) =>
  sql("select payload from realtime.messages where event = 'ride.updated' and topic = $1 and payload->>'id' = $2 order by id", [`org:${org.id}`, rideId]);
const assign = (org: Org, rideId: string, driverId: string) =>
  as({ sub: org.ownerId }, (q) => q("select public.assign_ride($1, $2) as r", [rideId, driverId])).then((r) => r[0].r);

let A: Org;
let B: Org;

beforeAll(async () => {
  A = await createOrg("Vols A");
  B = await createOrg("Vols B");
});

afterAll(async () => {
  await pool.end();
});

describe("Détection aéroport et mode du vol", () => {
  it("reconnaît les adresses d'aéroport sans faux positifs évidents", async () => {
    const cases: [string, boolean][] = [
      [AIRPORT, true],
      ["AÉROPORT DE NICE CÔTE D'AZUR, 06200 Nice", true],
      ["Nice Côte d’Azur, 06200 Nice", true],
      ["Orly Sud, 94390 Orly", true],
      ["Paris Beauvais Airport, 60000 Tillé", true],
      ["Aérogare 1, Roissy-en-France", true],
      ["Aéroport de Paris-Le Bourget", true],
      ["CDG T2", true],
      [PARIS, false],
      ["Place Charles de Gaulle, 75008 Paris", false],
      ["10 Promenade des Anglais, 06000 Nice, Provence-Alpes-Côte d'Azur", false],
      ["Gare de Lyon, 75012 Paris", false],
      ["", false],
    ];
    const rows = await sql("select a, private.is_airport_address(a) as airport from unnest($1::text[]) as a", [cases.map((c) => c[0])]);
    for (const [address, expected] of cases) {
      expect({ address, airport: rows.find((r) => r.a === address)?.airport }).toEqual({ address, airport: expected });
    }
    const [nul] = await sql("select private.is_airport_address(null) as airport");
    expect(nul.airport).toBe(false);
  });

  it("flight_mode (colonne générée) : arrivée si départ aéroport, départ sinon, null sans vol", async () => {
    const arrival = await airportRide(A, minuteFromNow(3 * HOUR));
    const departure = await createRideAsOwner(A, { flight_number: "AF1680", pickup_at: minuteFromNow(3 * HOUR).toISOString() });
    const none = await createRideAsOwner(A, { pickup_address: AIRPORT, pickup_at: minuteFromNow(3 * HOUR).toISOString() });
    const rows = await sql("select id, flight_mode from public.rides where id = any($1)", [[arrival.id, departure.id, none.id]]);
    const mode = (id: string) => rows.find((r) => r.id === id)?.flight_mode;
    expect(mode(arrival.id)).toBe("arrival");
    expect(mode(departure.id)).toBe("departure");
    expect(mode(none.id)).toBeNull();
  });
});

describe("Droits et réglages", () => {
  it("les colonnes vol se lisent mais ne s'écrivent pas côté client ; fonctions worker réservées", async () => {
    const ride = await airportRide(A, minuteFromNow(3 * HOUR));
    const rows = await as({ sub: A.ownerId }, (q) =>
      q("select flight_status, flight_mode, pickup_at_original, flight_checked_at from public.rides where id = $1", [ride.id]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].flight_mode).toBe("arrival");

    for (const set of ["flight_status = 'landed'", "pickup_at_original = now()", "flight_checked_at = now()", "flight_delay_minutes = 5"]) {
      const err = await expectPgError(as({ sub: A.ownerId }, (q) => q(`update public.rides set ${set} where id = $1`, [ride.id])));
      expect(err.code).toBe("42501");
    }
    const insertErr = await expectPgError(
      as({ sub: A.ownerId }, (q) =>
        q(`insert into public.rides (organization_id, pickup_address, pickup_lat, pickup_lng, dropoff_address, customer_name, customer_phone, flight_number, flight_status)
           values ($1, $2, $3, $4, $5, 'X', '+33600000000', 'AF1', 'landed')`, [A.id, AIRPORT, CDG[0], CDG[1], PARIS]),
      ),
    );
    expect(insertErr.code).toBe("42501");

    for (const call of [
      "select * from private.flights_to_check(10)",
      `select private.apply_flight_status('${ride.id}', 'landed')`,
    ]) {
      const err = await expectPgError(as({ sub: A.ownerId }, (q) => q(call)));
      expect(err.code).toBe("42501");
    }

    // Autre tenant : la course n'existe pas pour lui
    const foreign = await as({ sub: B.ownerId }, (q) => q("select id, flight_status from public.rides where id = $1", [ride.id]));
    expect(foreign).toHaveLength(0);
  });

  it("réglages : valeurs par défaut, modifiables par owner/admin seulement, bornés", async () => {
    const org = await createOrg("Vols Réglages");
    const [s] = await sql("select flight_tracking_enabled, flight_pickup_buffer_minutes from public.organization_settings where organization_id = $1", [org.id]);
    expect(s).toEqual({ flight_tracking_enabled: true, flight_pickup_buffer_minutes: 15 });

    const updated = await as({ sub: org.ownerId }, (q) =>
      q("update public.organization_settings set flight_pickup_buffer_minutes = 25, flight_tracking_enabled = false where organization_id = $1 returning flight_pickup_buffer_minutes", [org.id]),
    );
    expect(updated).toEqual([{ flight_pickup_buffer_minutes: 25 }]);

    const dispatcher = await createAuthUser(`disp-${org.slug}@test.dev`, "Dispatch");
    await sql("insert into public.organization_users (organization_id, user_id, role) values ($1, $2, 'dispatcher')", [org.id, dispatcher]);
    const byDispatcher = await as({ sub: dispatcher }, (q) =>
      q("update public.organization_settings set flight_pickup_buffer_minutes = 5 where organization_id = $1 returning 1", [org.id]),
    );
    expect(byDispatcher).toHaveLength(0);
    const byOtherTenant = await as({ sub: B.ownerId }, (q) =>
      q("update public.organization_settings set flight_pickup_buffer_minutes = 5 where organization_id = $1 returning 1", [org.id]),
    );
    expect(byOtherTenant).toHaveLength(0);

    const tooBig = await expectPgError(
      as({ sub: org.ownerId }, (q) => q("update public.organization_settings set flight_pickup_buffer_minutes = 121 where organization_id = $1", [org.id])),
    );
    expect(tooBig.code).toBe("23514");
    const [after] = await sql("select flight_pickup_buffer_minutes from public.organization_settings where organization_id = $1", [org.id]);
    expect(after.flight_pickup_buffer_minutes).toBe(25);
  });
});

describe("Worker : courses à vérifier (flights_to_check)", () => {
  it("sélectionne, normalise, réserve une seule fois et respecte les cadences 5 / 30 min", async () => {
    const org = await createOrg("Vols Check");
    const off = await createOrg("Vols Check Off", { settings: { flight_tracking_enabled: false } });
    const soon = await airportRide(org, minuteFromNow(2 * HOUR), { flight_number: "af 1234" });
    const later = await airportRide(org, minuteFromNow(6 * HOUR), { flight_number: "BA305" });
    const departure = await createRideAsOwner(org, { flight_number: "U2 4711", pickup_at: minuteFromNow(5 * HOUR).toISOString() });
    const tooFar = await airportRide(org, minuteFromNow(26 * HOUR));
    const noFlight = await createRideAsOwner(org, { pickup_address: AIRPORT, pickup_at: minuteFromNow(2 * HOUR).toISOString() });
    const disabled = await airportRide(off, minuteFromNow(2 * HOUR));
    const cancelled = await airportRide(org, minuteFromNow(2 * HOUR));
    await as({ sub: org.ownerId }, (q) => q("select public.cancel_ride($1, 'test')", [cancelled.id]));
    const onboard = await insertRideBypass(org, {
      status: "PASSENGER_ONBOARD", pickup_address: AIRPORT, pickup_lat: CDG[0], pickup_lng: CDG[1],
      pickup_at: new Date(Date.now() - 20 * MIN), flight_number: "AF9",
    });
    const messagesBefore = (await orgRideMessages(org, soon.id)).length;

    const svc = await as({ role: "service_role" }, (q) => q("select *, flight_date::text as flight_day from private.flights_to_check(500)"));
    const mine = svc.filter((r) => r.organization_id === org.id || r.organization_id === off.id);
    const ids = mine.map((r) => r.id);
    expect(ids).toContain(soon.id);
    expect(ids).toContain(later.id);
    expect(ids).toContain(departure.id);
    for (const excluded of [tooFar.id, noFlight.id, disabled.id, cancelled.id, onboard]) expect(ids).not.toContain(excluded);

    const s = mine.find((r) => r.id === soon.id)!;
    expect(s.flight_number).toBe("AF1234");
    expect(s.mode).toBe("arrival");
    expect(s.timezone).toBe("Europe/Paris");
    expect(s.number).toBeDefined();
    // Date du vol = date locale de (prise en charge − marge 15 min)
    expect(s.flight_day).toBe(ymd.format(plus(new Date(s.pickup_at), -15 * MIN)));
    expect(mine.find((r) => r.id === departure.id)?.mode).toBe("departure");
    expect(mine.find((r) => r.id === departure.id)?.flight_number).toBe("U24711");

    // Réservé : flight_checked_at posé, pas de seconde sélection, pas de diffusion temps réel
    const [checked] = await sql("select flight_checked_at from public.rides where id = $1", [soon.id]);
    expect(checked.flight_checked_at).not.toBeNull();
    const again = await sql("select id from private.flights_to_check(500)");
    expect(again.map((r) => r.id)).not.toContain(soon.id);
    expect((await orgRideMessages(org, soon.id)).length).toBe(messagesBefore);

    // Cadence : < 3 h → 5 min ; sinon 30 min
    await sql("update public.rides set flight_checked_at = now() - interval '10 minutes' where id = any($1)", [[soon.id, later.id]]);
    let next = (await sql("select id from private.flights_to_check(500)")).map((r) => r.id);
    expect(next).toContain(soon.id);
    expect(next).not.toContain(later.id);
    await sql("update public.rides set flight_checked_at = now() - interval '31 minutes' where id = $1", [later.id]);
    next = (await sql("select id from private.flights_to_check(500)")).map((r) => r.id);
    expect(next).toContain(later.id);

    // Vol atterri / annulé : plus interrogé
    await apply(soon.id, { status: "landed", actual: new Date() });
    await sql("update public.rides set flight_checked_at = null where id = $1", [soon.id]);
    next = (await sql("select id from private.flights_to_check(500)")).map((r) => r.id);
    expect(next).not.toContain(soon.id);
  });

  it("deux workers en parallèle ne réservent jamais la même course", async () => {
    const org = await createOrg("Vols Parallel");
    const rides = [];
    for (let i = 0; i < 6; i++) rides.push(await airportRide(org, minuteFromNow((2 + i / 10) * HOUR), { flight_number: `AF${100 + i}` }));
    const ids = new Set(rides.map((r) => r.id));
    const [w1, w2] = await Promise.all([
      sql("select id from private.flights_to_check(3)"),
      sql("select id from private.flights_to_check(3)"),
    ]);
    const claimed = [...w1, ...w2].map((r) => r.id).filter((id) => ids.has(id));
    expect(new Set(claimed).size).toBe(claimed.length);
  });
});

describe("apply_flight_status — prise en charge à l'aéroport", () => {
  let driver: Driver;

  beforeAll(async () => {
    driver = await createDriver(A, { firstName: "Karim", at: north(CDG, 500) });
  });

  it("1re information sans écart : suivi journalisé, pas de recalage ; appel identique = aucun doublon", async () => {
    const T0 = minuteFromNow(3 * HOUR);
    const S = plus(T0, -15 * MIN);
    const ride = await airportRide(A, T0);

    const r1 = await apply(ride.id, { status: "scheduled", scheduled: S, terminal: "2E", origin: "Lisbonne" });
    expect(r1).toMatchObject({ ok: true, code: "UPDATED", mode: "arrival", flight_status: "scheduled", pickup_changed: false, events: ["flight.updated"] });
    const { ride: row } = await rideState(ride.id);
    expect(row.flight_status).toBe("scheduled");
    expect(row.flight_terminal).toBe("2E");
    expect(row.flight_origin).toBe("Lisbonne");
    expect(new Date(row.flight_scheduled_arrival).getTime()).toBe(S.getTime());
    expect(new Date(row.pickup_at).getTime()).toBe(T0.getTime());
    expect(row.pickup_at_original).toBeNull();
    expect(row.flight_checked_at).not.toBeNull();
    const events = await flightEvents(ride.id);
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe(`Vol AF1234 suivi — arrivée prévue à ${label(S, T0)} (terminal 2E)`);

    const messages = (await orgRideMessages(A, ride.id)).length;
    const r2 = await apply(ride.id, { status: "scheduled", scheduled: S, terminal: "2E" });
    expect(r2).toMatchObject({ ok: true, code: "UNCHANGED", pickup_changed: false, events: [] });
    expect(await flightEvents(ride.id)).toHaveLength(1);
    expect((await orgRideMessages(A, ride.id)).length).toBe(messages);
  });

  it("vol retardé (course proposée à la flotte) : prise en charge, bascule GPS et offres recalées", async () => {
    const T0 = minuteFromNow(3 * HOUR);
    const S = plus(T0, -15 * MIN);
    const ride = await airportRide(A, T0);
    let state = await rideState(ride.id);
    expect(state.ride.dispatch_mode).toBe("fleet");
    expect(state.offers.some((o) => o.driver_id === driver.id && o.status === "pending")).toBe(true);

    await apply(ride.id, { status: "scheduled", scheduled: S });
    // Le fournisseur annonce encore « scheduled » mais avec 35 min de retard → « delayed »
    const res = await apply(ride.id, { status: "scheduled", scheduled: S, estimated: plus(S, 35 * MIN) });
    const T1 = plus(T0, 35 * MIN);
    expect(res).toMatchObject({ ok: true, code: "UPDATED", flight_status: "delayed", delay_minutes: 35, pickup_changed: true, events: ["flight.delayed"], notified: false });
    expect(new Date(res.pickup_at).getTime()).toBe(T1.getTime());

    state = await rideState(ride.id);
    expect(new Date(state.ride.pickup_at).getTime()).toBe(T1.getTime());
    expect(new Date(state.ride.pickup_at_original).getTime()).toBe(T0.getTime());
    expect(state.ride.flight_delay_minutes).toBe(35);
    expect(state.ride.flight_status).toBe("delayed");
    // Bascule GPS à T1 − 60 min, repassage flotte au plus tard dans 5 min
    const next = new Date(state.ride.next_dispatch_at).getTime();
    expect(Math.abs(next - (Date.now() + 5 * MIN))).toBeLessThan(10_000);
    const pending = state.offers.filter((o) => o.status === "pending" && o.mode === "fleet");
    expect(pending.length).toBeGreaterThan(0);
    for (const o of pending) expect(new Date(o.expires_at).getTime()).toBe(T1.getTime() - HOUR);

    const ev = (await flightEvents(ride.id)).at(-1)!;
    expect(ev.type).toBe("flight.delayed");
    expect(ev.level).toBe("warning");
    expect(ev.message).toBe(`Vol AF1234 retardé de 35 min — prise en charge à ${label(T1, T0)}`);
    expect(ev.data).toMatchObject({ flight_number: "AF1234", mode: "arrival", delay_minutes: 35, provider: "test" });
    expect(await flightNotifs(ride.id)).toHaveLength(0);

    // Temps réel dashboard : champs vol dans ride.updated
    const last = (await orgRideMessages(A, ride.id)).at(-1)!.payload;
    expect(last).toMatchObject({ flight_number: "AF 1234", flight_mode: "arrival", flight_status: "delayed", flight_delay_minutes: 35 });
    expect(new Date(last.pickup_at_original).getTime()).toBe(T0.getTime());
    expect(new Date(last.pickup_at).getTime()).toBe(T1.getTime());
    expect(last.flight_estimated_arrival).not.toBeNull();

    // Offres chauffeur : champs vol exposés, heure à jour
    const offers = await as({ sub: driver.userId }, (q) => q("select public.driver_offers() as o")).then((r) => r[0].o as any[]);
    const offer = offers.find((o) => o.ride_id === ride.id);
    expect(offer).toMatchObject({ flight_number: "AF 1234", flight_mode: "arrival", flight_status: "delayed", flight_delay_minutes: 35 });
    expect(new Date(offer.pickup_at).getTime()).toBe(T1.getTime());
    expect(new Date(offer.pickup_at_original).getTime()).toBe(T0.getTime());
  });

  it("chauffeur attribué : notification, rappels recalés, puis atterrissage sans nouveau recalage < 5 min", async () => {
    const T0 = minuteFromNow(3 * HOUR);
    const S = plus(T0, -15 * MIN);
    const ride = await airportRide(A, T0);
    expect((await assign(A, ride.id, driver.id)).ok).toBe(true);
    await apply(ride.id, { status: "scheduled", scheduled: S, terminal: "2E" });
    expect(await flightNotifs(ride.id)).toHaveLength(0);

    const res = await apply(ride.id, { status: "delayed", scheduled: S, estimated: plus(S, 35 * MIN) });
    const T1 = plus(T0, 35 * MIN);
    expect(res).toMatchObject({ pickup_changed: true, notified: true, events: ["flight.delayed"] });
    let notifs = await flightNotifs(ride.id);
    expect(notifs).toHaveLength(1);
    expect(notifs[0]).toMatchObject({ driver_id: driver.id, title: "VOL RETARDÉ", priority: "high", status: "queued" });
    expect(notifs[0].body).toBe(`Vol AF1234 retardé de 35 min — prise en charge à ${label(T1, T0)}`);
    expect(notifs[0].data).toMatchObject({ type: "flight_update", event: "flight.delayed", ride_id: ride.id, flight_number: "AF1234", delay_minutes: 35, flight_status: "delayed" });

    // Rappels : annulés puis recréés relativement à la nouvelle heure (offsets 180, 60, 30 min)
    const reminders = await sql(
      "select scheduled_for, data->>'offset_minutes' as offset from public.notifications where ride_id = $1 and type = 'ride_reminder' and status = 'queued' order by scheduled_for",
      [ride.id],
    );
    expect(reminders.map((r) => Number(r.offset))).toEqual([180, 60, 30]);
    for (const r of reminders) expect(new Date(r.scheduled_for).getTime()).toBe(T1.getTime() - Number(r.offset) * MIN);

    // Canal chauffeur : l'heure de prise en charge est diffusée
    const [driverMsg] = await sql(
      "select payload from realtime.messages where event = 'ride.updated' and topic = $1 and payload->>'id' = $2 order by id desc limit 1",
      [`driver:${driver.id}`, ride.id],
    );
    expect(new Date(driverMsg.payload.pickup_at).getTime()).toBe(T1.getTime());
    expect(driverMsg.payload.customer_phone).toBeUndefined();

    // Atterrissage à S+33 : écart de 2 min seulement → pas de recalage, mais notification « atterri »
    const landed = await apply(ride.id, { status: "landed", scheduled: S, actual: plus(S, 33 * MIN), terminal: "2E" });
    expect(landed).toMatchObject({ flight_status: "landed", delay_minutes: 33, pickup_changed: false, events: ["flight.landed"], notified: true });
    const { ride: row } = await rideState(ride.id);
    expect(new Date(row.pickup_at).getTime()).toBe(T1.getTime());
    notifs = await flightNotifs(ride.id);
    expect(notifs).toHaveLength(2);
    expect(notifs[1]).toMatchObject({ title: "VOL ATTERRI", body: "Le vol AF1234 a atterri (terminal 2E)" });
    const ev = (await flightEvents(ride.id)).at(-1)!;
    expect(ev).toMatchObject({ type: "flight.landed", level: "success" });
    expect(ev.message).toBe(`Vol AF1234 atterri à ${label(plus(S, 33 * MIN), T0)} (terminal 2E)`);
  });

  it("changement de terminal : journalisé et signalé au chauffeur", async () => {
    const T0 = minuteFromNow(4 * HOUR);
    const S = plus(T0, -15 * MIN);
    const ride = await airportRide(A, T0);
    await assign(A, ride.id, driver.id);
    await apply(ride.id, { status: "scheduled", scheduled: S, terminal: "2E" });
    const res = await apply(ride.id, { status: "scheduled", scheduled: S, terminal: "2F" });
    expect(res).toMatchObject({ pickup_changed: false, events: ["flight.terminal"], notified: true });
    const ev = (await flightEvents(ride.id)).at(-1)!;
    expect(ev.message).toBe("Vol AF1234 : changement de terminal — 2F (au lieu de 2E)");
    const notifs = await flightNotifs(ride.id);
    expect(notifs.at(-1)).toMatchObject({ title: "TERMINAL MODIFIÉ", body: "Vol AF1234 : arrivée au terminal 2F" });
  });

  it("vol en avance : prise en charge avancée ; fenêtre flotte dépassée → bascule GPS au tick", async () => {
    const T0 = minuteFromNow(70 * MIN);
    const S = plus(T0, -15 * MIN);
    const ride = await airportRide(A, T0);
    expect(ride.type).toBe("scheduled");
    const res = await apply(ride.id, { status: "departed", scheduled: S, estimated: plus(S, -30 * MIN) });
    const T1 = plus(T0, -30 * MIN);
    expect(res).toMatchObject({ flight_status: "departed", delay_minutes: -30, pickup_changed: true, events: ["flight.early"] });
    let state = await rideState(ride.id);
    expect(new Date(state.ride.pickup_at).getTime()).toBe(T1.getTime());
    // T1 − 60 min est déjà passé : le dispatch est dû immédiatement
    expect(new Date(state.ride.next_dispatch_at).getTime()).toBe(T1.getTime() - HOUR);
    const ev = (await flightEvents(ride.id)).at(-1)!;
    expect(ev).toMatchObject({ type: "flight.early", level: "info" });
    expect(ev.message).toBe(`Vol AF1234 en avance de 30 min — prise en charge à ${label(T1, T0)}`);

    await sql("select private.dispatch_tick()");
    state = await rideState(ride.id);
    expect(state.ride.dispatch_mode).toBe("geo");
    expect(state.offers.filter((o) => o.mode === "fleet").every((o) => o.status !== "pending")).toBe(true);
  });

  it("client qui a prévu plus que la marge : vol à l'heure = heure inchangée, retard = même décalage", async () => {
    const T0 = minuteFromNow(3 * HOUR);
    const S = plus(T0, -40 * MIN); // le client a demandé 40 min après l'atterrissage (marge 15 min)
    const ride = await airportRide(A, T0);
    const onTime = await apply(ride.id, { status: "scheduled", scheduled: S, estimated: S });
    expect(onTime).toMatchObject({ pickup_changed: false });
    expect(new Date((await rideState(ride.id)).ride.pickup_at).getTime()).toBe(T0.getTime());
    const late = await apply(ride.id, { status: "delayed", scheduled: S, estimated: plus(S, 25 * MIN) });
    expect(late).toMatchObject({ pickup_changed: true, delay_minutes: 25 });
    expect(new Date(late.pickup_at).getTime()).toBe(plus(T0, 25 * MIN).getTime());
    // Le retard se résorbe : retour vers l'heure demandée (référence = heure d'origine, pas l'heure décalée)
    const back = await apply(ride.id, { status: "delayed", scheduled: S, estimated: plus(S, 5 * MIN) });
    expect(new Date(back.pickup_at).getTime()).toBe(plus(T0, 5 * MIN).getTime());
    expect(new Date(back.pickup_at_original).getTime()).toBe(T0.getTime());
  });

  it("heure idéale déjà passée : prise en charge à maintenant, jamais dans le passé, sans recalage répété", async () => {
    const T0 = minuteFromNow(20 * MIN);
    const ride = await airportRide(A, T0);
    expect(ride.type).toBe("instant");
    const S = plus(T0, -15 * MIN);
    const actual = plus(S, -45 * MIN); // atterri il y a ~40 min, 45 min d'avance → idéal ≈ il y a 25 min
    const before = Date.now();
    const res = await apply(ride.id, { status: "landed", scheduled: S, actual });
    expect(res).toMatchObject({ pickup_changed: true, events: ["flight.early", "flight.landed"], delay_minutes: -45 });
    const { ride: row } = await rideState(ride.id);
    const pickup = new Date(row.pickup_at).getTime();
    expect(pickup).toBeGreaterThanOrEqual(before - 1000);
    expect(pickup).toBeLessThanOrEqual(Date.now() + 1000);
    expect(new Date(row.pickup_at_original).getTime()).toBe(T0.getTime());
    expect(row.dispatch_mode).toBe("geo");

    const again = await apply(ride.id, { status: "landed", scheduled: S, actual });
    expect(again).toMatchObject({ code: "UNCHANGED", pickup_changed: false, events: [] });
    const [after] = await sql("select pickup_at, pickup_at_original from public.rides where id = $1", [ride.id]);
    expect(new Date(after.pickup_at).getTime()).toBe(pickup);
    expect(new Date(after.pickup_at_original).getTime()).toBe(T0.getTime());
  });

  it("vol annulé : aucun recalage, alerte journal + chauffeur", async () => {
    const T0 = minuteFromNow(3 * HOUR);
    const S = plus(T0, -15 * MIN);
    const ride = await airportRide(A, T0);
    await assign(A, ride.id, driver.id);
    const res = await apply(ride.id, { status: "canceled", scheduled: S, estimated: plus(S, 90 * MIN) });
    expect(res).toMatchObject({ flight_status: "cancelled", pickup_changed: false, events: ["flight.cancelled"], notified: true });
    const { ride: row } = await rideState(ride.id);
    expect(new Date(row.pickup_at).getTime()).toBe(T0.getTime());
    expect((await flightEvents(ride.id)).at(-1)).toMatchObject({ type: "flight.cancelled", level: "warning", message: "Vol AF1234 annulé" });
    expect((await flightNotifs(ride.id)).at(-1)).toMatchObject({
      title: "VOL ANNULÉ", body: "Le vol AF1234 est annulé — attendez les consignes de la centrale",
    });
    // Rejoué : pas de doublon
    const again = await apply(ride.id, { status: "cancelled", scheduled: S, estimated: plus(S, 90 * MIN) });
    expect(again).toMatchObject({ code: "UNCHANGED", events: [], notified: false });
  });

  it("horaire incohérent (> 24 h d'écart) : pas de recalage, avertissement unique", async () => {
    const T0 = minuteFromNow(3 * HOUR);
    const ride = await airportRide(A, T0);
    const S = plus(T0, 30 * HOUR);
    const res = await apply(ride.id, { status: "scheduled", scheduled: S });
    expect(res).toMatchObject({ pickup_changed: false, events: ["flight.incoherent"] });
    expect((await flightEvents(ride.id)).at(-1)).toMatchObject({
      level: "warning", message: "Horaires du vol AF1234 incohérents avec la prise en charge — vérifiez le numéro de vol",
    });
    const again = await apply(ride.id, { status: "scheduled", scheduled: S, estimated: plus(S, 3 * MIN) });
    expect(again.events).toEqual([]);
    const { ride: row } = await rideState(ride.id);
    expect(new Date(row.pickup_at).getTime()).toBe(T0.getTime());
  });

  it("statuts fournisseur normalisés ; « inconnu » ne remplace pas un statut connu", async () => {
    const T0 = minuteFromNow(3 * HOUR);
    const S = plus(T0, -15 * MIN);
    const ride = await airportRide(A, T0);
    expect((await apply(ride.id, { status: "active", scheduled: S })).flight_status).toBe("departed");
    expect((await apply(ride.id, { status: "n'importe quoi" })).flight_status).toBe("departed");
    expect((await apply(ride.id, { status: null })).flight_status).toBe("departed");
    const fresh = await airportRide(A, T0);
    expect((await apply(fresh.id, { status: "???" })).flight_status).toBe("unknown");
    // Champs absents : dernières valeurs connues conservées
    const { ride: row } = await rideState(ride.id);
    expect(new Date(row.flight_scheduled_arrival).getTime()).toBe(S.getTime());
  });

  it("client à bord, course close, suivi désactivé, sans vol, course inconnue", async () => {
    const onboard = await insertRideBypass(A, {
      status: "PASSENGER_ONBOARD", pickup_address: AIRPORT, pickup_lat: CDG[0], pickup_lng: CDG[1],
      pickup_at: new Date(Date.now() - 10 * MIN), flight_number: "AF77",
    });
    const [before] = await sql("select pickup_at from public.rides where id = $1", [onboard]);
    const res = await apply(onboard, { status: "landed", scheduled: new Date(Date.now() - 2 * HOUR), actual: new Date(Date.now() - 30 * MIN) });
    expect(res).toMatchObject({ ok: true, pickup_changed: false });
    const [after] = await sql("select pickup_at, pickup_at_original, flight_status from public.rides where id = $1", [onboard]);
    expect(after.pickup_at.getTime()).toBe(before.pickup_at.getTime());
    expect(after.pickup_at_original).toBeNull();
    expect(after.flight_status).toBe("landed");

    const completed = await insertRideBypass(A, { status: "COMPLETED", pickup_address: AIRPORT, flight_number: "AF78" });
    expect(await apply(completed, { status: "landed" })).toMatchObject({ ok: false, code: "RIDE_CLOSED" });

    const off = await createOrg("Vols Off", { settings: { flight_tracking_enabled: false } });
    const offRide = await airportRide(off, minuteFromNow(3 * HOUR));
    expect(await apply(offRide.id, { status: "delayed" })).toMatchObject({ ok: false, code: "TRACKING_DISABLED" });

    const noFlight = await createRideAsOwner(A, { pickup_address: AIRPORT, pickup_at: minuteFromNow(3 * HOUR).toISOString() });
    expect(await apply(noFlight.id, { status: "delayed" })).toMatchObject({ ok: false, code: "NO_FLIGHT" });

    expect(await apply("00000000-0000-0000-0000-000000000000", { status: "landed" })).toMatchObject({ ok: false, code: "RIDE_NOT_FOUND" });
  });

  it("instantanée non attribuée repoussée de 3 h : repasse en planifiée, proposée à la flotte (pas de NO_DRIVER_FOUND)", async () => {
    const org = await createOrg("Vols requalif");
    const T0 = minuteFromNow(20 * MIN);
    const ride = await airportRide(org, T0); // aucun chauffeur : recherche GPS en cours
    expect(ride.type).toBe("instant");
    const S = plus(T0, -15 * MIN);
    const res = await apply(ride.id, { status: "delayed", scheduled: S, estimated: plus(S, 180 * MIN) });
    expect(res).toMatchObject({ pickup_changed: true, requalified: "fleet" });
    const late = await createDriver(org, { firstName: "Nadia", at: north(CDG, 900) });
    await sql("update public.rides set next_dispatch_at = now() - interval '1 second' where id = $1", [ride.id]);
    await sql("select private.dispatch_tick()");
    const state = await rideState(ride.id);
    expect(state.ride).toMatchObject({ type: "scheduled", dispatch_mode: "fleet", status: "OFFERED" });
    expect(state.offers.some((o) => o.driver_id === late.id && o.mode === "fleet" && o.status === "pending")).toBe(true);
    const [ev] = await sql("select message from public.ride_events where ride_id = $1 and type = 'ride.requalified'", [ride.id]);
    expect(ev.message).toContain("course repassée en planifiée et proposée à toute la flotte");
    // plusieurs heures avant la prise en charge, la recherche ne s'arrête pas au bout de 5 min
    await sql("update public.rides set dispatch_started_at = now() - interval '10 minutes', next_dispatch_at = now() - interval '1 second' where id = $1", [ride.id]);
    await sql("select private.dispatch_tick()");
    expect((await rideState(ride.id)).ride.status).not.toBe("NO_DRIVER_FOUND");
  });

  it("instantanée acceptée repoussée d'1 h 30 : planifiée, chauffeur gardé mais libéré d'ici là", async () => {
    const org = await createOrg("Vols requalif acceptée");
    const d = await createDriver(org, { firstName: "Yanis", at: north(CDG, 500) });
    const T0 = minuteFromNow(20 * MIN);
    const ride = await airportRide(org, T0);
    const offer = (await rideState(ride.id)).offers.find((o) => o.driver_id === d.id)!;
    const [acc] = await as({ sub: d.userId }, (q) => q("select public.accept_ride_offer($1) as r", [offer.id]));
    expect(acc.r.code).toBe("ACCEPTED");
    const S = plus(T0, -15 * MIN);
    const res = await apply(ride.id, { status: "delayed", scheduled: S, estimated: plus(S, 90 * MIN) });
    expect(res).toMatchObject({ pickup_changed: true, requalified: "assigned" });
    const [r] = await sql("select type, status, driver_id from public.rides where id = $1", [ride.id]);
    expect(r).toEqual({ type: "scheduled", status: "ACCEPTED", driver_id: d.id });
    const [dx] = await sql("select presence, current_ride_id from public.drivers where id = $1", [d.id]);
    expect(dx).toEqual({ presence: "available", current_ride_id: null });
    const reminders = await sql("select count(*)::int as n from public.notifications where ride_id = $1 and type = 'ride_reminder' and status = 'queued'", [ride.id]);
    expect(reminders[0].n).toBeGreaterThan(0);
  });

  it("réservation avant l'atterrissage : prise en charge à l'arrivée + marge (0 min ici)", async () => {
    const org = await createOrg("Vols Marge", { settings: { flight_pickup_buffer_minutes: 0 } });
    const T0 = minuteFromNow(3 * HOUR);
    const ride = await airportRide(org, T0);
    const res = await apply(ride.id, { status: "scheduled", scheduled: plus(T0, 20 * MIN) });
    expect(res).toMatchObject({ pickup_changed: true, events: ["flight.updated"] });
    const { ride: row } = await rideState(ride.id);
    expect(new Date(row.pickup_at).getTime()).toBe(T0.getTime() + 20 * MIN);
    expect((await flightEvents(ride.id)).at(-1)?.message).toBe(
      `Vol AF1234 — prise en charge ajustée à ${label(plus(T0, 20 * MIN), T0)} (arrivée ${label(plus(T0, 20 * MIN), T0)} + 0 min)`,
    );
  });
});

describe("apply_flight_status — dépôt pour un vol (information seulement)", () => {
  it("retard ≥ 15 min signalé une fois, heure inchangée ; annulation signalée", async () => {
    const d = await createDriver(A, { firstName: "Sofiane", at: north(CHAMPS_ELYSEES, 400) });
    const T0 = minuteFromNow(3 * HOUR);
    const ride = await createRideAsOwner(A, { flight_number: "AF1680", pickup_at: T0.toISOString() });
    await assign(A, ride.id, d.id);
    const dep = plus(T0, 2 * HOUR);

    const r1 = await apply(ride.id, { status: "scheduled", scheduled: dep, estimated: plus(dep, 10 * MIN) });
    expect(r1).toMatchObject({ mode: "departure", flight_status: "scheduled", delay_minutes: 10, pickup_changed: false, events: ["flight.updated"], notified: false });
    expect((await flightEvents(ride.id)).at(-1)?.message).toBe(`Vol AF1680 suivi — départ estimé à ${label(plus(dep, 10 * MIN), T0)}`);

    const r2 = await apply(ride.id, { status: "delayed", scheduled: dep, estimated: plus(dep, 40 * MIN) });
    expect(r2).toMatchObject({ pickup_changed: false, events: ["flight.departure_delayed"], notified: true });
    const ev = (await flightEvents(ride.id)).at(-1)!;
    expect(ev).toMatchObject({ type: "flight.delayed", level: "warning", message: "Vol AF1680 retardé de 40 min au départ — prise en charge inchangée" });
    expect((await flightNotifs(ride.id)).at(-1)).toMatchObject({
      driver_id: d.id, title: "VOL RETARDÉ", body: `Vol AF1680 retardé de 40 min au départ — prise en charge inchangée à ${hm.format(T0)}`,
    });

    // +5 min de retard : pas de nouvelle alerte
    const r3 = await apply(ride.id, { status: "delayed", scheduled: dep, estimated: plus(dep, 45 * MIN) });
    expect(r3).toMatchObject({ code: "UPDATED", events: [], notified: false });

    const r4 = await apply(ride.id, { status: "cancelled" });
    expect(r4).toMatchObject({ events: ["flight.cancelled"], notified: true });
    const { ride: row } = await rideState(ride.id);
    expect(new Date(row.pickup_at).getTime()).toBe(T0.getTime());
    expect(row.pickup_at_original).toBeNull();
    expect(await flightNotifs(ride.id)).toHaveLength(2);
  });
});

describe("Numéro de vol modifié au dashboard", () => {
  it("réinitialise les données du vol précédent, conserve l'heure demandée", async () => {
    const T0 = minuteFromNow(3 * HOUR);
    const ride = await airportRide(A, T0);
    await apply(ride.id, { status: "delayed", scheduled: plus(T0, -15 * MIN), estimated: plus(T0, 25 * MIN), terminal: "2E" });
    let { ride: row } = await rideState(ride.id);
    expect(row.pickup_at_original).not.toBeNull();

    // Même numéro renvoyé par le formulaire : rien n'est effacé
    await as({ sub: A.ownerId }, (q) => q("update public.rides set flight_number = flight_number, comment = 'ok' where id = $1", [ride.id]));
    ({ ride: row } = await rideState(ride.id));
    expect(row.flight_status).toBe("delayed");

    await as({ sub: A.ownerId }, (q) => q("update public.rides set flight_number = 'BA 304' where id = $1", [ride.id]));
    ({ ride: row } = await rideState(ride.id));
    expect(row).toMatchObject({
      flight_number: "BA 304", flight_status: null, flight_scheduled_arrival: null, flight_estimated_arrival: null,
      flight_actual_arrival: null, flight_terminal: null, flight_origin: null, flight_delay_minutes: null, flight_checked_at: null,
    });
    expect(new Date(row.pickup_at_original).getTime()).toBe(T0.getTime());
    const due = (await sql("select id from private.flights_to_check(500)")).map((r) => r.id);
    expect(due).toContain(ride.id);

    // Réponse du fournisseur pour l'ancien vol arrivée après la modification : ignorée
    const stale = await apply(ride.id, { status: "landed", actual: new Date(), terminal: "2E", flightNumber: "AF1234" });
    expect(stale).toMatchObject({ ok: false, code: "FLIGHT_CHANGED" });
    ({ ride: row } = await rideState(ride.id));
    expect(row.flight_status).toBeNull();
    const fresh = await apply(ride.id, { status: "scheduled", scheduled: plus(T0, 60 * MIN), flightNumber: "ba304" });
    expect(fresh).toMatchObject({ ok: true, flight_status: "scheduled", pickup_changed: true });
  });
});

describe("Isolation multi-tenant", () => {
  it("les diffusions vol restent sur le canal de l'organisation ; offres invisibles d'un autre tenant", async () => {
    const dA = await createDriver(A, { firstName: "Iso", at: north(CDG, 300) });
    const dB = await createDriver(B, { firstName: "Other", at: north(CDG, 300) });
    const ride = await airportRide(A, minuteFromNow(3 * HOUR));
    await apply(ride.id, { status: "delayed", scheduled: minuteFromNow(3 * HOUR - 15 * MIN), estimated: minuteFromNow(3 * HOUR + 30 * MIN) });

    const own = await as(
      { sub: A.ownerId },
      (q) => q("select count(*)::int as n from realtime.messages where payload->>'id' = $1 and payload ? 'flight_status'", [ride.id]),
      { topic: `org:${A.id}` },
    );
    expect(own[0].n).toBeGreaterThan(0);
    const spy = await as(
      { sub: B.ownerId },
      (q) => q("select count(*)::int as n from realtime.messages where payload->>'id' = $1", [ride.id]),
      { topic: `org:${A.id}` },
    );
    expect(spy[0].n).toBe(0);
    const events = await as({ sub: B.ownerId }, (q) => q("select id from public.ride_events where ride_id = $1", [ride.id]));
    expect(events).toHaveLength(0);

    const offersA = await as({ sub: dA.userId }, (q) => q("select public.driver_offers() as o")).then((r) => r[0].o as any[]);
    expect(offersA.some((o) => o.ride_id === ride.id)).toBe(true);
    const offersB = await as({ sub: dB.userId }, (q) => q("select public.driver_offers() as o")).then((r) => r[0].o as any[]);
    expect(offersB.some((o) => o.ride_id === ride.id)).toBe(false);
    const rowsB = await as({ sub: dB.userId }, (q) => q("select id from public.rides where id = $1", [ride.id]));
    expect(rowsB).toHaveLength(0);
  });
});
