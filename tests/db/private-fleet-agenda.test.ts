// Flotte Privée : agenda du chauffeur (public.driver_agenda, migration 20260924007600, docs/FLOTTE-PRIVEE.md § 4.3-J2 et
// § 13.1) et lectures de l'app (driver_home, driver_account_state : § 4.3-K). Période bornée (62 jours) ; ses courses de
// la période, closes comprises pour un membre de l'organisation, jamais l'historique d'un chauffeur non membre ;
// réservations à traiter (Flotte Privée) quelle que soit la période, avec offre, échéance et état ; limites 500 et 100.
import { afterAll, describe, expect, it } from "vitest";
import { PRIVATE_FLEET_AGENDA_MAX_DAYS } from "../../packages/shared/src/private-fleet";
import {
  as, asFresh, createApiRide, createDriver, createOrg, createPrivateFleet, createRideAsOwner, expectPgError, inMinutes,
  insertRideBypass, pool, sql, type Org,
} from "./helpers";

type Row = Record<string, any>;

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

afterAll(async () => {
  await pool.end();
});

/** Appel du chauffeur (jeton récent : exigé pour l'adhésion activée du propriétaire d'une Flotte Privée). */
const call = async (sub: string, fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await asFresh(sub, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Row;
};
const agenda = (sub: string, from: string | null, to: string | null) => call(sub, "driver_agenda", [from, to]);
const ids = (list: Row[]) => list.map((x) => x.id as string);

/** Course close vieillie de plus de 24 h (updated_at est tenu par un déclencheur : vieillie sans déclencheurs). */
async function ageRide(rideId: string, days: number) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query("update public.rides set updated_at = now() - make_interval(days => $2) where id = $1", [rideId, days]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** n courses insérées d'un coup (mode import), une par minute à partir de `first`. */
async function bulkRides(org: Org, n: number, first: number, fields: { status: string; driverId?: string; vehicleId?: string }) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('rydar.bypass_ride_rules', 'on', true)");
    await client.query(
      `insert into public.rides (organization_id, type, status, source, pickup_address, pickup_lat, pickup_lng, dropoff_address,
                                 pickup_at, customer_name, customer_phone, passengers, vehicle_category, price_cents, driver_id,
                                 vehicle_id, accepted_at)
       select $1, 'scheduled', $2::public.ride_status, 'api', 'Place de l''Opéra, 75009 Paris', 48.872, 2.3316,
              'Gare de Lyon, 75012 Paris', $3::timestamptz + make_interval(mins => g), 'Client ' || g, '+33600000001', 1,
              'business', 5000, $4::uuid, $5::uuid, case when $4::uuid is not null then now() end
         from generate_series(1, $6::integer) g`,
      [org.id, fields.status, new Date(first), fields.driverId ?? null, fields.vehicleId ?? null, n],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// -----------------------------------------------------------------------------
describe("driver_agenda : droits et période", () => {
  it("période nulle, inversée, vide ou de plus de 62 jours → AGENDA_RANGE_INVALID (22023) ; 62 jours tout juste acceptés", async () => {
    const pf = await createPrivateFleet("Agenda Période");
    const now = Date.now();
    const bad: [string | null, string | null][] = [
      [null, iso(now)], [iso(now), null], [null, null], [iso(now), iso(now - 1000)], [iso(now), iso(now)],
      [iso(now), iso(now + PRIVATE_FLEET_AGENDA_MAX_DAYS * DAY + 1000)],
    ];
    for (const [from, to] of bad) {
      const e = await expectPgError(agenda(pf.ownerId, from, to));
      expect(e.code, `${from} → ${to}`).toBe("22023");
      expect(e.message).toMatch(/^AGENDA_RANGE_INVALID/);
    }
    const ok = await agenda(pf.ownerId, iso(now), iso(now + PRIVATE_FLEET_AGENDA_MAX_DAYS * DAY));
    expect(ok).toMatchObject({ timezone: "Europe/Paris", private_fleet: true, rides: [] });
    expect(new Date(ok.from).getTime()).toBe(now);
    expect(new Date(ok.to).getTime()).toBe(now + PRIVATE_FLEET_AGENDA_MAX_DAYS * DAY);
  });

  it("anon : refus d'exécution ; compte sans fiche active (fiche inactive) : FORBIDDEN", async () => {
    const anon = await expectPgError(as({ role: "anon" }, (q) => q("select public.driver_agenda(now(), now() + interval '1 day')")));
    expect(anon.code).toBe("42501");
    expect(anon.message).toMatch(/permission denied for function driver_agenda/);

    const org = await createOrg("Agenda Inactif");
    const inactive = await createDriver(org, { status: "inactive" });
    const forbidden = await expectPgError(agenda(inactive.userId, iso(Date.now()), iso(Date.now() + DAY)));
    expect(forbidden.code).toBe("42501");
    expect(forbidden.message).toMatch(/^FORBIDDEN/);
  });
});

// -----------------------------------------------------------------------------
describe("driver_agenda : contenu", () => {
  it("Flotte Privée (membre) : ses courses de la période, closes comprises ; réservations à traiter avec offre, échéance et état", async () => {
    const pf = await createPrivateFleet("Agenda Privé");
    const now = Date.now();

    // Ses courses : une terminée il y a 3 jours (close depuis plus de 24 h), une acceptée à J+2
    const done = await insertRideBypass(pf, {
      type: "scheduled", status: "COMPLETED", driver_id: pf.driverId, vehicle_id: pf.vehicleId, pickup_at: new Date(now - 3 * DAY),
      accepted_at: new Date(now - 4 * DAY), completed_at: new Date(now - 3 * DAY + HOUR),
    });
    await ageRide(done, 3);
    const accepted = await createApiRide(pf.id, { pickup_at: inMinutes(2 * 24 * 60) });
    const [acceptOffer] = await sql("select id from public.ride_offers where ride_id = $1 and status = 'pending'", [accepted.id]);
    expect(await call(pf.ownerId, "accept_ride_offer", [acceptOffer.id])).toMatchObject({ ok: true, code: "ACCEPTED" });

    // À traiter : à confirmer (J+1), refusée (J+3), à vérifier (van, J+4), non confirmée (il y a 2 h), à confirmer hors période (J+40)
    const toConfirm = await createApiRide(pf.id, { pickup_at: inMinutes(24 * 60) });
    const [offer] = await sql("select id, expires_at from public.ride_offers where ride_id = $1 and status = 'pending'", [toConfirm.id]);
    const declined = await createApiRide(pf.id, { pickup_at: inMinutes(3 * 24 * 60) });
    const [declineOffer] = await sql("select id from public.ride_offers where ride_id = $1 and status = 'pending'", [declined.id]);
    expect(await call(pf.ownerId, "decline_ride_offer", [declineOffer.id])).toMatchObject({ ok: true });
    const toCheck = await createApiRide(pf.id, { vehicle_category: "van", pickup_at: inMinutes(4 * 24 * 60) });
    const notConfirmed = await insertRideBypass(pf, { type: "scheduled", status: "NO_DRIVER_FOUND", pickup_at: new Date(now - 2 * HOUR) });
    const farAway = await createApiRide(pf.id, { pickup_at: inMinutes(40 * 24 * 60) });
    // Exclues : prise en charge passée depuis plus de 6 h ; réservation d'une autre organisation
    await insertRideBypass(pf, { type: "scheduled", status: "NO_DRIVER_FOUND", pickup_at: new Date(now - 7 * HOUR) });
    const other = await createOrg("Agenda Autre Organisation");
    const foreign = await createRideAsOwner(other, { pickup_at: inMinutes(24 * 60) });

    const res = await agenda(pf.ownerId, iso(now - 7 * DAY), iso(now + 7 * DAY));
    expect(res).toMatchObject({ timezone: "Europe/Paris", private_fleet: true });
    expect(ids(res.rides)).toEqual([done, accepted.id]);
    expect(res.rides[0]).toMatchObject({ status: "COMPLETED", customer_name: "Client Historique" });
    expect(res.rides[1]).toMatchObject({ status: "ACCEPTED", number: Number(accepted.number) });

    expect(ids(res.unassigned)).toEqual([notConfirmed, toConfirm.id, declined.id, toCheck.id, farAway.id]);
    expect(res.unassigned.map((x: Row) => x.state)).toEqual(["not_confirmed", "to_confirm", "declined", "to_check", "to_confirm"]);
    const confirm = res.unassigned[1];
    expect(confirm).toMatchObject({ offer_id: offer.id, status: "OFFERED", customer_phone: "+33611223344" });
    expect(new Date(confirm.offer_expires_at).getTime()).toBe(offer.expires_at.getTime());
    for (const x of [res.unassigned[0], res.unassigned[2], res.unassigned[3]]) {
      expect(x).toMatchObject({ offer_id: null, offer_expires_at: null });
    }
    expect(ids(res.rides).concat(ids(res.unassigned))).not.toContain(foreign.id);

    // Accueil : réservations à vérifier ou non confirmées (ni offre en attente, ni refus) ; drapeaux
    const home = await call(pf.ownerId, "driver_home");
    expect(home.private).toEqual({ unassigned: 2 });
    expect(home.organization.private_fleet).toBe(true);
    expect(home.driver.owner_driver).toBe(true);
    expect((await call(pf.ownerId, "driver_account_state")).organization).toMatchObject({ private_fleet: true });
  });

  it("chauffeur d'une flotte standard non membre : course close depuis plus de 24 h exclue, unassigned nul ; clés de l'accueil", async () => {
    const org = await createOrg("Agenda Standard");
    const d = await createDriver(org);
    const now = Date.now();
    const old = await insertRideBypass(org, {
      type: "scheduled", status: "COMPLETED", driver_id: d.id, vehicle_id: d.vehicleId, pickup_at: new Date(now - 3 * DAY),
      completed_at: new Date(now - 3 * DAY + HOUR),
    });
    await ageRide(old, 3);
    const recent = await insertRideBypass(org, {
      type: "scheduled", status: "COMPLETED", driver_id: d.id, vehicle_id: d.vehicleId, pickup_at: new Date(now - 2 * DAY),
      completed_at: new Date(now - 2 * DAY + HOUR),
    });
    const upcoming = await insertRideBypass(org, {
      type: "scheduled", status: "ACCEPTED", driver_id: d.id, vehicle_id: d.vehicleId, pickup_at: new Date(now + DAY),
      accepted_at: new Date(now),
    });
    // Course de l'organisation sans chauffeur, et course d'une autre organisation : jamais renvoyées
    await createRideAsOwner(org, { pickup_at: inMinutes(2 * 24 * 60) });
    const other = await createOrg("Agenda Standard Autre");
    const foreign = await createRideAsOwner(other, { pickup_at: inMinutes(24 * 60) });

    const res = await agenda(d.userId, iso(now - 7 * DAY), iso(now + 7 * DAY));
    expect(res).toMatchObject({ private_fleet: false, unassigned: null });
    expect(ids(res.rides)).toEqual([recent, upcoming]);
    expect(ids(res.rides)).not.toContain(foreign.id);

    const home = await call(d.userId, "driver_home");
    expect(home).not.toHaveProperty("private");
    expect(home.organization.private_fleet).toBe(false);
    expect(home.driver.owner_driver).toBe(false);
    expect((await call(d.userId, "driver_account_state")).organization).toMatchObject({ private_fleet: false });
  });

  it("membre d'une flotte standard (gérant qui roule) : historique de ses courses de la période, unassigned nul", async () => {
    const org = await createOrg("Agenda Gérant Standard");
    const [vehicle] = await sql(
      `insert into public.vehicles (organization_id, model, plate, category, seats) values ($1, 'Classe E', $2, 'business', 4) returning id`,
      [org.id, `AG-${Date.now().toString(36).toUpperCase().slice(-5)}`],
    );
    const [fiche] = await sql(
      `insert into public.drivers (organization_id, user_id, first_name, last_name, phone, status, vehicle_id)
       values ($1, $2, 'Gérant', 'Standard', '+33600000002', 'active', $3) returning id`,
      [org.id, org.ownerId, vehicle.id],
    );
    const now = Date.now();
    const old = await insertRideBypass(org, {
      type: "scheduled", status: "COMPLETED", driver_id: fiche.id, vehicle_id: vehicle.id, pickup_at: new Date(now - 5 * DAY),
      completed_at: new Date(now - 5 * DAY + HOUR),
    });
    await ageRide(old, 5);
    await createRideAsOwner(org, { pickup_at: inMinutes(24 * 60) });
    const res = await agenda(org.ownerId, iso(now - 7 * DAY), iso(now + 7 * DAY));
    expect(res).toMatchObject({ private_fleet: false, unassigned: null });
    expect(ids(res.rides)).toEqual([old]);
  });

  it("limites : 500 courses, 100 réservations à traiter (triées par heure de prise en charge)", async () => {
    const pf = await createPrivateFleet("Agenda Limites");
    const now = Date.now();
    await bulkRides(pf, 501, now + DAY, { status: "ACCEPTED", driverId: pf.driverId, vehicleId: pf.vehicleId });
    await bulkRides(pf, 101, now + 2 * DAY, { status: "NO_DRIVER_FOUND" });
    const res = await agenda(pf.ownerId, iso(now), iso(now + 10 * DAY));
    expect(res.rides).toHaveLength(500);
    expect(res.unassigned).toHaveLength(100);
    for (const list of [res.rides, res.unassigned] as Row[][]) {
      const times = list.map((x) => new Date(x.pickup_at).getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
    expect(res.unassigned.every((x: Row) => x.state === "not_confirmed")).toBe(true);
    expect((await call(pf.ownerId, "driver_home")).private).toEqual({ unassigned: 100 });
  });
});
