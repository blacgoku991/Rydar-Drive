// Audit « dispatch » (migration 20260924004500) : double acceptation, motif du refus, enchaînement des courses,
// vol retardé d'une planifiée en recherche GPS, blocage frais plateforme / quota à la relance et à l'attribution.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { ERROR_MESSAGES } from "../../packages/shared/src/domain";
import {
  as, CDG, CHAMPS_ELYSEES, createAuthUser, createDriver, createOrg, createRideAsOwner, insertRideBypass, nextWave, north, pool,
  rideState, sql, type Driver, type Org,
} from "./helpers";

afterAll(async () => {
  await pool.end();
});

const MIN = 60_000;
const AIRPORT = "Aéroport Paris-Charles de Gaulle, Terminal 2E, 95700 Roissy-en-France";
const PARIS = "12 Avenue des Champs-Élysées, 75008 Paris";
const minuteFromNow = (ms: number) => new Date(Math.ceil((Date.now() + ms) / MIN) * MIN);
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

const rpc = async (sub: string, fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ sub }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Record<string, any>;
};
const accept = (d: Driver, offerId: string) => rpc(d.userId, "accept_ride_offer", [offerId]);
const advance = async (d: Driver, rideId: string, statuses: string[]) => {
  for (const s of statuses) {
    const res = await rpc(d.userId, "driver_update_ride_status", [rideId, s]);
    expect(res.ok, `${s} : ${JSON.stringify(res)}`).toBe(true);
  }
};
const presence = async (d: Driver) =>
  (await sql("select presence, current_ride_id from public.drivers where id = $1", [d.id]))[0] as {
    presence: string; current_ride_id: string | null;
  };
const pendingOffer = async (rideId: string, d: Driver) => (await rideState(rideId)).offers.find((o) => o.driver_id === d.id && o.status === "pending");

// -----------------------------------------------------------------------------
describe("accept_ride_offer : double acceptation concurrente (flux-course#2)", () => {
  it("deux offres acceptées en même temps par le même chauffeur : une seule passe, l'autre DRIVER_BUSY", async () => {
    const org = await createOrg("Double acceptation");
    const d = await createDriver(org, { firstName: "Double", at: north(CHAMPS_ELYSEES, 300) });
    const x = await createRideAsOwner(org);
    const ox = await pendingOffer(x.id, d);
    expect(ox).toBeTruthy();
    const y = await createRideAsOwner(org); // chauffeur déjà sollicité : pas d'offre
    // Seconde offre en attente pour le même chauffeur (fenêtre tick ∥ création reproduite par l'audit)
    const [oy] = await sql(
      `insert into public.ride_offers (organization_id, ride_id, driver_id, status, mode, wave, distance_m, expires_at)
       values ($1, $2, $3, 'pending', 'geo', 1, 300, now() + interval '60 seconds') returning id`,
      [org.id, y.id, d.id],
    );

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    const begin = async (c: typeof c1) => {
      await c.query("begin");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: d.userId, role: "authenticated" })]);
      await c.query("set local role authenticated");
    };
    try {
      await begin(c1);
      await begin(c2);
      // 1re acceptation : validée mais pas encore commitée
      const r1 = (await c1.query("select public.accept_ride_offer($1) as r", [ox!.id])).rows[0].r;
      expect(r1.code).toBe("ACCEPTED");
      const pid = (await c2.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      const p2 = c2.query("select public.accept_ride_offer($1) as r", [oy.id]);
      // La seconde attend un verrou (ligne du chauffeur) tenu par la première
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const [a] = await sql("select wait_event_type from pg_stat_activity where pid = $1", [pid]);
        waiting = a?.wait_event_type === "Lock";
        if (!waiting) await new Promise((r) => setTimeout(r, 50));
      }
      expect(waiting).toBe(true);
      await c1.query("commit");
      const r2 = (await p2).rows[0].r;
      await c2.query("commit");
      expect(r2).toMatchObject({ ok: false, code: "DRIVER_BUSY" });
    } finally {
      await c1.query("rollback").catch(() => undefined);
      await c2.query("rollback").catch(() => undefined);
      c1.release();
      c2.release();
    }

    const rides = await sql("select id, status, driver_id from public.rides where id = any($1)", [[x.id, y.id]]);
    expect(rides.find((r) => r.id === x.id)).toMatchObject({ status: "ACCEPTED", driver_id: d.id });
    expect(rides.find((r) => r.id === y.id)?.driver_id).toBeNull();
    expect(await presence(d)).toEqual({ presence: "en_route", current_ride_id: x.id });
  });
});

// -----------------------------------------------------------------------------
describe("accept_ride_offer : motif réel du refus (flux-course#3)", () => {
  it("course annulée → RIDE_CANCELLED ; recherche terminée → SEARCH_ENDED ; attribuée → RIDE_ALREADY_ASSIGNED", async () => {
    const org = await createOrg("Motif refus");
    const d = await createDriver(org, { firstName: "Tardif", at: north(CHAMPS_ELYSEES, 300) });
    const lateEvent = async (rideId: string) =>
      (await sql("select message, data from public.ride_events where ride_id = $1 and type = 'offer.rejected_late' order by id", [rideId])).at(-1);

    // Annulée pendant l'offre
    const a = await createRideAsOwner(org);
    const oa = await pendingOffer(a.id, d);
    expect((await rpc(org.ownerId, "cancel_ride", [a.id, "Client injoignable"])).ok).toBe(true);
    const ra = await accept(d, oa!.id);
    expect(ra).toEqual({ ok: false, code: "RIDE_CANCELLED", message: "Course annulée." });
    expect(ERROR_MESSAGES[ra.code]).toBe(ra.message);
    expect((await lateEvent(a.id))?.message).toBe(`Tardif (#${d.number}) a tenté d'accepter — course annulée`);

    // Personne n'a accepté : NO_DRIVER_FOUND
    const b = await createRideAsOwner(org);
    const ob = await pendingOffer(b.id, d);
    await nextWave(b.id, 6);
    expect((await rideState(b.id)).ride.status).toBe("NO_DRIVER_FOUND");
    const rb = await accept(d, ob!.id);
    expect(rb).toEqual({ ok: false, code: "SEARCH_ENDED", message: "Recherche terminée : la course n'est plus proposée." });
    expect(ERROR_MESSAGES[rb.code]).toBe(rb.message);
    expect((await lateEvent(b.id))?.message).toBe(`Tardif (#${d.number}) a tenté d'accepter — recherche terminée`);

    // Attribuée à un autre chauffeur : inchangé
    const other = await createDriver(org, { firstName: "Autre", presence: "offline" });
    const c = await createRideAsOwner(org);
    const oc = await pendingOffer(c.id, d);
    expect((await rpc(org.ownerId, "assign_ride", [c.id, other.id])).code).toBe("ASSIGNED");
    const rc = await accept(d, oc!.id);
    expect(rc).toEqual({ ok: false, code: "RIDE_ALREADY_ASSIGNED", message: "Course déjà attribuée." });
    expect((await lateEvent(c.id))?.message).toBe(`Tardif (#${d.number}) a tenté d'accepter — course déjà attribuée`);
    expect(await presence(d)).toMatchObject({ presence: "available", current_ride_id: null });
  });
});

// -----------------------------------------------------------------------------
describe("Enchaînement : instantanée attribuée pendant une course (flux-course#5)", () => {
  it("course en cours terminée : le chauffeur enchaîne sur la suivante et peut la démarrer", async () => {
    const org = await createOrg("Enchainement fin");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 300) });
    const first = await createRideAsOwner(org);
    expect((await accept(d, (await pendingOffer(first.id, d))!.id)).code).toBe("ACCEPTED");
    await advance(d, first.id, ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS"]);

    const second = await createRideAsOwner(org); // chauffeur en course : pas d'offre
    expect((await rpc(org.ownerId, "assign_ride", [second.id, d.id])).code).toBe("ASSIGNED");
    expect(await presence(d)).toEqual({ presence: "on_trip", current_ride_id: first.id });

    await advance(d, first.id, ["COMPLETED"]);
    expect(await presence(d)).toEqual({ presence: "en_route", current_ride_id: second.id });
    // Accueil de l'app : course en cours = la suivante
    const home = await rpc(d.userId, "driver_home");
    expect(home.driver.current_ride_id).toBe(second.id);
    await advance(d, second.id, ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS", "COMPLETED"]);
    expect(await presence(d)).toEqual({ presence: "available", current_ride_id: null });
  });

  it("annulation, retrait ou réattribution de la course en cours : enchaîne ; course suivante annulée : rien ne change", async () => {
    const org = await createOrg("Enchainement annulation");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 300) });
    const d2 = await createDriver(org, { presence: "offline" });
    const assign = async (rideId: string, driverId: string) =>
      expect((await rpc(org.ownerId, "assign_ride", [rideId, driverId])).code).toBe("ASSIGNED");

    const a = await createRideAsOwner(org);
    expect((await accept(d, (await pendingOffer(a.id, d))!.id)).code).toBe("ACCEPTED");
    await advance(d, a.id, ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED"]);
    const b = await createRideAsOwner(org);
    await assign(b.id, d.id);
    const extra = await createRideAsOwner(org);
    await assign(extra.id, d.id);
    // Course suivante annulée : la course en cours reste la même
    expect((await rpc(org.ownerId, "cancel_ride", [extra.id, null])).ok).toBe(true);
    expect(await presence(d)).toEqual({ presence: "arrived", current_ride_id: a.id });

    // Annulation de la course en cours → B
    expect((await rpc(org.ownerId, "cancel_ride", [a.id, "Client absent"])).ok).toBe(true);
    expect(await presence(d)).toEqual({ presence: "en_route", current_ride_id: b.id });

    // Retrait par la centrale (« Relancer ») → C
    const c = await createRideAsOwner(org);
    await assign(c.id, d.id);
    expect((await rpc(org.ownerId, "reassign_ride", [b.id, "Trop loin", d.id])).ok).toBe(true);
    expect(await presence(d)).toEqual({ presence: "en_route", current_ride_id: c.id });

    // Réattribution à un autre chauffeur → E
    const e = await createRideAsOwner(org);
    await assign(e.id, d.id);
    await assign(c.id, d2.id);
    expect(await presence(d)).toEqual({ presence: "en_route", current_ride_id: e.id });

    // Plus rien derrière : disponible
    expect((await rpc(org.ownerId, "cancel_ride", [e.id, null])).ok).toBe(true);
    expect(await presence(d)).toEqual({ presence: "available", current_ride_id: null });
  });
});

// -----------------------------------------------------------------------------
describe("Vol retardé d'une planifiée déjà en recherche GPS (flux-course#1, flux-annexes#3)", () => {
  const airportRide = (org: Org, pickupAt: Date) =>
    createRideAsOwner(org, {
      pickup_address: AIRPORT, pickup_lat: CDG[0], pickup_lng: CDG[1],
      dropoff_address: PARIS, dropoff_lat: CHAMPS_ELYSEES[0], dropoff_lng: CHAMPS_ELYSEES[1],
      flight_number: "AF 7777", pickup_at: pickupAt.toISOString(),
    });
  const apply = async (rideId: string, f: { status: string; scheduled: Date; estimated: Date }) =>
    (await sql("select private.apply_flight_status($1, $2, $3, $4, null, null, null, 'test', null) as r", [
      rideId, f.status, f.scheduled, f.estimated,
    ]))[0].r as Record<string, any>;

  it("recherche GPS en cours puis retard de 3 h : de nouveau proposée à la flotte, pas de NO_DRIVER_FOUND", async () => {
    const org = await createOrg("Vol GPS retard");
    const T0 = minuteFromNow(50 * MIN);
    const ride = await airportRide(org, T0);
    expect(ride.type).toBe("scheduled");
    await nextWave(ride.id); // T-60 min dépassé : bascule GPS
    expect((await rideState(ride.id)).ride.dispatch_mode).toBe("geo");

    const S = plus(T0, -15 * MIN);
    const res = await apply(ride.id, { status: "delayed", scheduled: S, estimated: plus(S, 180 * MIN) });
    expect(res).toMatchObject({ ok: true, pickup_changed: true, requalified: "fleet" });
    let state = await rideState(ride.id);
    expect(state.ride).toMatchObject({ type: "scheduled", dispatch_mode: "fleet", status: "SEARCHING_DRIVER", no_driver_at: null });
    const [ev] = await sql("select message from public.ride_events where ride_id = $1 and type = 'ride.requalified'", [ride.id]);
    expect(ev.message).toContain("course de nouveau proposée à toute la flotte");

    // Nouveau chauffeur : reçoit l'offre flotte ; les passages suivants restent en flotte (bascule à la nouvelle heure − 60 min)
    const late = await createDriver(org, { firstName: "Nadia", at: north(CDG, 900) });
    await nextWave(ride.id, 8);
    state = await rideState(ride.id);
    expect(state.ride).toMatchObject({ dispatch_mode: "fleet", status: "OFFERED" });
    expect(state.offers.some((o) => o.driver_id === late.id && o.mode === "fleet" && o.status === "pending")).toBe(true);
  });

  it("course NO_DRIVER_FOUND : toujours suivie par flights_to_check, reproposée à la flotte sur un nouveau retard", async () => {
    const org = await createOrg("Vol sans chauffeur");
    const T0 = minuteFromNow(50 * MIN);
    const ride = await airportRide(org, T0);
    await nextWave(ride.id); // bascule GPS
    await nextWave(ride.id, 6); // toutes les vagues : personne
    expect((await rideState(ride.id)).ride.status).toBe("NO_DRIVER_FOUND");

    const due = await as({ role: "service_role" }, (q) => q("select id from private.flights_to_check(500)"));
    expect(due.map((r) => r.id)).toContain(ride.id);

    const S = plus(T0, -15 * MIN);
    const res = await apply(ride.id, { status: "delayed", scheduled: S, estimated: plus(S, 150 * MIN) });
    expect(res).toMatchObject({ pickup_changed: true, requalified: "fleet" });
    expect((await rideState(ride.id)).ride).toMatchObject({ dispatch_mode: "fleet", status: "SEARCHING_DRIVER", no_driver_at: null });
  });

  it("retard qui laisse la prise en charge dans la fenêtre GPS : la recherche GPS continue", async () => {
    const org = await createOrg("Vol GPS court");
    const T0 = minuteFromNow(50 * MIN);
    const ride = await airportRide(org, T0);
    await nextWave(ride.id);
    const S = plus(T0, -15 * MIN);
    // 7 min de retard : nouvelle heure − 60 min toujours dépassée
    const res = await apply(ride.id, { status: "delayed", scheduled: S, estimated: plus(S, 7 * MIN) });
    expect(res).toMatchObject({ pickup_changed: true, requalified: null });
    expect((await rideState(ride.id)).ride.dispatch_mode).toBe("geo");
  });
});

// -----------------------------------------------------------------------------
describe("Relance et attribution : mêmes règles que la création (flux-argent#5, sql-rpc-courses#3)", () => {
  const PRICED = { price_cents: 5900, commission_cents: 1400, payment_method: "cash" };

  it("frais plateforme en retard : relancer ou attribuer une course sans chauffeur refusé ; réattribuer reste possible", async () => {
    const org = await createOrg("Relance bloquee", { settings: { settlement_methods: "{link,cash,transfer}" } });
    await sql("update public.organizations set dispatch_model = 'centrale', platform_fee_fixed_cents = 500 where id = $1", [org.id]);
    const sa = await createAuthUser(`sa-${randomUUID().slice(0, 8)}@rydar.dev`, "Super Admin");
    await sql("update public.users set is_super_admin = true where id = $1", [sa]);
    const d1 = await createDriver(org, { presence: "offline" });
    const d2 = await createDriver(org, { presence: "offline" });

    // Avant le blocage : une course sans chauffeur, une course attribuée
    const open = await createRideAsOwner(org, PRICED);
    const assigned = await createRideAsOwner(org, PRICED);
    expect((await rpc(org.ownerId, "assign_ride", [assigned.id, d1.id])).code).toBe("ASSIGNED");

    // Frais échus depuis longtemps + levier « bloquer après 1 jour »
    await insertRideBypass(org, { completed_at: new Date(Date.now() - 75 * 86_400_000) });
    const [terms] = await as({ role: "service_role" }, (q) =>
      q("select public.svc_platform_terms($1, $2, 'monthly', 5, 1) as r", [org.id, sa]));
    expect(terms.r.code).toBe("SAVED");

    const relaunch = await rpc(org.ownerId, "redispatch_ride", [open.id]);
    expect(relaunch).toMatchObject({ ok: false, code: "PLATFORM_FEES_OVERDUE" });
    expect(relaunch.message).toContain("Frais plateforme en retard");
    expect(await rpc(org.ownerId, "assign_ride", [open.id, d2.id])).toMatchObject({ ok: false, code: "PLATFORM_FEES_OVERDUE" });
    expect((await rideState(open.id)).ride.driver_id).toBeNull();

    // Course déjà attribuée avant le blocage : réattribution possible
    expect((await rpc(org.ownerId, "assign_ride", [assigned.id, d2.id])).code).toBe("ASSIGNED");
  });

  it("quota mensuel atteint : une ancienne course sans chauffeur ne se relance ni ne s'attribue ; une course du mois oui", async () => {
    const org = await createOrg("Relance quota");
    const d = await createDriver(org, { presence: "offline" });
    const [{ at }] = await sql("select date_trunc('month', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris' - interval '2 days' as at");
    const old = await insertRideBypass(org, { status: "NO_DRIVER_FOUND", created_at: at, pickup_at: new Date(Date.now() + 20 * MIN) });
    await createRideAsOwner(org);
    const recent = await createRideAsOwner(org);
    await sql(`update public.organizations set limits_override = '{"max_rides_per_month": 2}' where id = $1`, [org.id]);

    const relaunch = await rpc(org.ownerId, "redispatch_ride", [old]);
    expect(relaunch).toMatchObject({ ok: false, code: "PLAN_LIMIT_RIDES" });
    expect(ERROR_MESSAGES[relaunch.code]).toBe(relaunch.message);
    expect(await rpc(org.ownerId, "assign_ride", [old, d.id])).toMatchObject({ ok: false, code: "PLAN_LIMIT_RIDES" });

    // Course créée ce mois-ci (dans le quota) : relance et attribution possibles
    expect((await rpc(org.ownerId, "redispatch_ride", [recent.id])).code).toBe("RELAUNCHED");
    expect((await rpc(org.ownerId, "assign_ride", [recent.id, d.id])).code).toBe("ASSIGNED");
  });
});
