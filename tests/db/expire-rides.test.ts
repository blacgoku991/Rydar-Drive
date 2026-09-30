// Courses planifiées acceptées mais jamais démarrées : clôture automatique 6 h après l'heure de prise en charge
// (migration 20260924005900_expire_unstarted_rides : private.expire_unstarted_rides, appelée par private.housekeeping).
import { afterAll, describe, expect, it } from "vitest";
import { as, createDriver, createOrg, expectPgError, insertRideBypass, pool, sql, type Driver, type Org } from "./helpers";

afterAll(async () => {
  await pool.end();
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

/** Course attribuée au chauffeur (planifiée et acceptée par défaut), heure de prise en charge libre. */
function assigned(org: Org, d: Driver, fields: Record<string, unknown>) {
  return insertRideBypass(org, {
    type: "scheduled",
    status: "ACCEPTED",
    driver_id: d.id,
    vehicle_id: d.vehicleId,
    accepted_at: hoursAgo(48),
    ...fields,
  });
}

async function ride(id: string) {
  const [r] = await sql("select status, driver_id, cancel_reason, cancelled_by_type, cancelled_at from public.rides where id = $1", [id]);
  return r;
}

async function cancelPush(id: string) {
  return sql("select title, status from public.notifications where ride_id = $1 and type = 'ride_cancelled'", [id]);
}

describe("Courses planifiées jamais démarrées : clôture automatique", () => {
  it("6 h après l'heure de prise en charge : annulée par le système, motif « Non effectuée », chauffeur prévenu", async () => {
    const org = await createOrg("Expiration jour");
    const d = await createDriver(org);
    const id = await assigned(org, d, { pickup_at: hoursAgo(7) });
    await sql(
      `insert into public.notifications (organization_id, driver_id, ride_id, type, title, body, scheduled_for)
       values ($1, $2, $3, 'ride_reminder', 'RAPPEL', 'Course dans 1 h', now() + interval '1 hour')`,
      [org.id, d.id, id],
    );

    await sql("select private.expire_unstarted_rides()");

    const r = await ride(id);
    expect(r).toMatchObject({ status: "CANCELLED", cancelled_by_type: "system", driver_id: d.id });
    expect(r.cancel_reason).toMatch(/^Non effectuée : pas démarrée 6 h après l'heure de prise en charge/);
    expect(r.cancelled_at).not.toBeNull();
    // Course manquée du jour : notification dédiée, envoyée
    expect(await cancelPush(id)).toEqual([{ title: "COURSE NON EFFECTUÉE", status: "queued" }]);
    // Rappels programmés annulés
    const [reminder] = await sql("select status from public.notifications where ride_id = $1 and type = 'ride_reminder'", [id]);
    expect(reminder.status).toBe("cancelled");
    // Journal de la course : annulation par le système, avec le motif
    const [event] = await sql(
      "select message, actor_type from public.ride_events where ride_id = $1 and type = 'ride.cancelled'",
      [id],
    );
    expect(event).toMatchObject({ actor_type: "system" });
    expect(event.message).toMatch(/^Course annulée — Non effectuée/);
    // Plus démarrable par le chauffeur
    const [res] = await as({ sub: d.userId }, (q) =>
      q("select public.driver_update_ride_status($1, 'DRIVER_EN_ROUTE') as r", [id]),
    );
    expect(res.r).toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
  });

  it("moins de 6 h de retard : encore démarrable (chauffeur en retard), rien ne change", async () => {
    const org = await createOrg("Expiration avant délai");
    const d = await createDriver(org);
    const id = await assigned(org, d, { pickup_at: hoursAgo(5.5) });
    await sql("select private.expire_unstarted_rides()");
    expect((await ride(id)).status).toBe("ACCEPTED");
    expect(await cancelPush(id)).toEqual([]);
  });

  it("rattrapage de plus de 24 h : clôturée sans notification au chauffeur", async () => {
    const org = await createOrg("Expiration rattrapage");
    const d = await createDriver(org);
    const id = await assigned(org, d, { pickup_at: hoursAgo(30) });
    await sql("select private.expire_unstarted_rides()");
    expect((await ride(id)).status).toBe("CANCELLED");
    expect(await cancelPush(id)).toEqual([{ title: "COURSE NON EFFECTUÉE", status: "cancelled" }]);
  });

  it("course démarrée ou instantanée : jamais clôturée ainsi, chauffeur et course en cours intacts", async () => {
    const org = await createOrg("Expiration démarrée");
    const d = await createDriver(org, { presence: "en_route" });
    const started = await assigned(org, d, { pickup_at: hoursAgo(10), status: "DRIVER_EN_ROUTE", driver_en_route_at: hoursAgo(10) });
    await sql("update public.drivers set current_ride_id = $2 where id = $1", [d.id, started]);
    const instant = await assigned(org, d, { type: "instant", pickup_at: hoursAgo(10) });
    const planned = await assigned(org, d, { pickup_at: hoursAgo(8) });

    await sql("select private.expire_unstarted_rides()");

    expect((await ride(started)).status).toBe("DRIVER_EN_ROUTE");
    expect((await ride(instant)).status).toBe("ACCEPTED");
    expect((await ride(planned)).status).toBe("CANCELLED");
    // La course clôturée n'était pas sa course en cours : présence et course en cours inchangées
    const [drv] = await sql("select presence, current_ride_id from public.drivers where id = $1", [d.id]);
    expect(drv).toEqual({ presence: "en_route", current_ride_id: started });
  });

  it("ménage périodique : clôture comptée dans « rides_expired »", async () => {
    const org = await createOrg("Expiration ménage");
    const d = await createDriver(org);
    const id = await assigned(org, d, { pickup_at: hoursAgo(9) });
    const [{ r }] = await sql("select private.housekeeping() as r");
    expect(r.rides_expired).toBeGreaterThanOrEqual(1);
    expect(r.errors).toBeUndefined();
    expect((await ride(id)).status).toBe("CANCELLED");
  });

  it("fonction réservée au ménage (ni client, ni service role)", async () => {
    const org = await createOrg("Expiration droits");
    const d = await createDriver(org);
    const id = await assigned(org, d, { pickup_at: hoursAgo(12) });
    for (const who of [{ role: "anon" as const }, { sub: org.ownerId }, { sub: d.userId }, { role: "service_role" as const }]) {
      const e = await expectPgError(as(who, (q) => q("select private.expire_unstarted_rides()")));
      expect(e.code, JSON.stringify(who)).toBe("42501");
    }
    expect((await ride(id)).status).toBe("ACCEPTED");
  });
});
