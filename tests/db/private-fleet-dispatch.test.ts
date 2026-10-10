// Flotte Privée : vie d'une réservation (migration 20260924007600, docs/FLOTTE-PRIVEE.md § 4.3-G/H/J1, § 5 et § 13.1) —
// offre « à confirmer » à la fiche unique sans condition de présence ni de position, « NOUVELLE RÉSERVATION » (sonnerie
// si la réponse est attendue dans 15 min), rappels « à confirmer », refus = « Refusée », dernier appel GPS (100 km), puis
// « Non confirmée » ; véhicule incompatible = « À vérifier » ; « La prendre » ; réservation saisie par le chauffeur
// attribuée d'office ; vol retardé ; suspension et bannissement (D13) ; app 1.1.0 ; vagues standard inchangées.
// Revue : échéance annoncée tenue (délai de confirmation augmenté, délai de réponse de 10 min), offre recréée par le
// moteur notifiée « NOUVELLE RÉSERVATION », rappels replanifiés quand les réglages changent ou annulés hors Flotte Privée.
import { afterAll, describe, expect, it } from "vitest";
import { PRIVATE_FLEET_REMINDER_RULES, PRIVATE_FLEET_RING_WINDOW_S, PRIVATE_FLEET_TITLES } from "../../packages/shared/src/private-fleet";
import {
  as, asFresh, CHAMPS_ELYSEES, createApiRide, createAuthUser, createDriver, createOrg, createPrivateFleet, createRideAsOwner,
  expectPgError, inMinutes, insertRideBypass, nextWave, north, pool, rideState, sql,
} from "./helpers";

type Row = Record<string, any>;

const MIN = 60_000;
/** Départ des réservations de createApiRide (aéroport d'Orly). */
const ORLY: [number, number] = [48.7262, 2.3652];

afterAll(async () => {
  await pool.end();
});

/** RPC du chauffeur : compte du propriétaire (adhésion activée → jeton récent). */
const rpc = async (sub: string, fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await asFresh(sub, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Row;
};

const notifications = (rideId: string) =>
  sql(
    `select id, driver_id, ride_id, offer_id, type, title, body, data, status, scheduled_for
       from public.notifications where ride_id = $1 order by created_at, scheduled_for, id`,
    [rideId],
  );

/** Statuts des notifications « COURSE ATTRIBUÉE » (ride_assigned) de la course : jamais en file quand il agit lui-même (§ 6). */
const assignedStatuses = async (rideId: string) =>
  (await notifications(rideId)).filter((x) => x.type === "ride_assigned").map((x) => x.status as string);

/** Rappels « à confirmer » de la réservation, par heure d'envoi. */
const privateReminders = (rideId: string, status = "queued") =>
  sql(
    `select id, type, title, body, data, offer_id, status, scheduled_for from public.notifications
      where ride_id = $1 and data ->> 'kind' = 'private_reminder' and status = $2 order by scheduled_for`,
    [rideId, status],
  );

/** Minutes avant la prise en charge de chaque rappel. */
const minutesBefore = (pickup: number, rows: Row[]) => rows.map((n) => (pickup - n.scheduled_for.getTime()) / MIN);

/** Réglage de l'onglet « Réservations » enregistré par le propriétaire (colonnes ouvertes en écriture). */
const setBookingSettings = (pf: { id: string; ownerId: string }, set: string) =>
  asFresh(pf.ownerId, (q) => q(`update public.organization_settings set ${set} where organization_id = $1`, [pf.id]));

/** Webhooks « ride.no_driver_found » en file pour la réservation (site du client prévenu). */
const noDriverWebhooks = (rideId: string) =>
  sql("select 1 from public.webhook_deliveries where ride_id = $1 and event_type = 'ride.no_driver_found'", [rideId]);

const pendingOffer = async (rideId: string) =>
  (await sql("select * from public.ride_offers where ride_id = $1 and status = 'pending' order by sent_at", [rideId]))[0];

/** Échéance de l'offre et prochain passage dépassés, puis passage du dispatch (fin de la fenêtre « à confirmer »). */
async function elapse(rideId: string) {
  await sql("update public.ride_offers set expires_at = now() - interval '1 second' where ride_id = $1 and status = 'pending'", [rideId]);
  await nextWave(rideId);
}

// -----------------------------------------------------------------------------
describe("offre « à confirmer »", () => {
  it("1. immédiate par l'API, chauffeur hors ligne (position à 200 km) : offre de 5 min, « NOUVELLE RÉSERVATION » qui sonne, aucune offre GPS", async () => {
    const pf = await createPrivateFleet("Disp Immédiate", { at: north(ORLY, 200_000), presence: "offline" });
    const ride = await createApiRide(pf.id);
    const { ride: r, offers, events } = await rideState(ride.id);
    expect(r).toMatchObject({ type: "instant", status: "OFFERED", dispatch_mode: "fleet", source: "api" });
    expect(offers.map((o) => [o.driver_id, o.mode, o.status])).toEqual([[pf.driverId, "fleet", "pending"]]);
    const ttl = (offers[0].expires_at.getTime() - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(280);
    expect(ttl).toBeLessThanOrEqual(301);

    const n = await notifications(ride.id);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({
      driver_id: pf.driverId, offer_id: offers[0].id, type: "ride_offer", title: PRIVATE_FLEET_TITLES.newBooking, status: "queued",
    });
    expect(n[0].data).toMatchObject({ type: "ride_offer", kind: "private_new", offer_id: offers[0].id, ride_id: ride.id });

    const types = events.map((e) => e.type);
    expect(events.find((e) => e.type === "ride.classified")?.message).toBe("Réservation immédiate");
    const proposed = events.find((e) => e.type === "dispatch.private_offer");
    expect(proposed?.message).toMatch(/^Proposée — réponse attendue avant (\d{2}\/\d{2} à )?\d{2}:\d{2}$/);
    expect(proposed?.data).toMatchObject({ offer_id: offers[0].id, ring: true, private_fleet: true });
    for (const t of ["dispatch.search", "dispatch.online", "dispatch.candidates"]) expect(types).not.toContain(t);
    // Hors ligne : rien ne ferme l'offre « fleet » (présence et position ignorées)
    expect((await sql("select presence from public.drivers where id = $1", [pf.driverId]))[0].presence).toBe("offline");
  });

  it("2. planifiée à J+3 : échéance = prise en charge − 60 min, sans sonnerie, rappels aux heures attendues", async () => {
    const pf = await createPrivateFleet("Disp J3");
    const ride = await createApiRide(pf.id, { pickup_at: inMinutes(3 * 24 * 60) });
    const { ride: r, offers, events } = await rideState(ride.id);
    expect(r).toMatchObject({ type: "scheduled", status: "OFFERED", dispatch_mode: "fleet" });
    const pickup = r.pickup_at.getTime();
    expect(offers).toHaveLength(1);
    expect(offers[0].expires_at.getTime()).toBe(pickup - 60 * MIN);
    expect(events.find((e) => e.type === "ride.classified")?.message).toMatch(/^Réservation du \d{2}\/\d{2} à \d{2}:\d{2}$/);

    const initial = (await notifications(ride.id)).filter((n) => n.data.kind === "private_new");
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ type: "ride_offer_scheduled", title: PRIVATE_FLEET_TITLES.newBooking, offer_id: offers[0].id });
    expect(initial[0].data.type).toBe("ride_offer_scheduled");

    // Rappels {1440,180,60,30} + dernier rappel (échéance − 30 min) ; gardés entre maintenant + 20 min et échéance − 5 min
    const reminders = await privateReminders(ride.id);
    expect(reminders.map((n) => (pickup - n.scheduled_for.getTime()) / MIN)).toEqual([1440, 180, 90]);
    for (const n of reminders) {
      expect(n).toMatchObject({ type: "ride_offer_scheduled", title: PRIVATE_FLEET_TITLES.reminder, offer_id: offers[0].id });
      expect(n.data).toMatchObject({
        type: "ride_offer_scheduled", kind: "private_reminder", offer_id: offers[0].id, ride_id: ride.id, ride_type: "scheduled",
        price_cents: 8500, passengers: 2,
      });
      expect(new Date(n.data.expires_at).getTime()).toBe(pickup - 60 * MIN);
    }
    expect(reminders[0].body).toMatch(/^Prise en charge dans 24 h · \d{2}\/\d{2} \d{2}:\d{2} · .+ → .+ · /);
    expect(reminders[1].body).toMatch(/^Prise en charge dans 3 h · /);
    expect(reminders[2].body).toMatch(/^Dernier rappel : répondez avant (\d{2}\/\d{2} à )?\d{2}:\d{2} · \d{2}\/\d{2} \d{2}:\d{2} · .+ → /);
  });

  it("2 bis. rappels : 4 au plus, 15 min d'écart, aucun avant maintenant + 20 min ; dans 70 min → sonnerie", async () => {
    const rules = PRIVATE_FLEET_REMINDER_RULES;
    const pf = await createPrivateFleet("Disp Rappels");
    await sql("update public.organization_settings set reminder_offsets_minutes = '{2880,1440,1430,600,300,180}' where organization_id = $1", [pf.id]);

    const far = await createApiRide(pf.id, { pickup_at: inMinutes(3 * 24 * 60) });
    const pickup = (await rideState(far.id)).ride.pickup_at.getTime();
    // 1430 écarté (moins de 15 min après 1440), puis 4 au plus : ni 180, ni le dernier rappel
    expect((await privateReminders(far.id)).map((n) => (pickup - n.scheduled_for.getTime()) / MIN)).toEqual([2880, 1440, 600, 300]);
    expect(rules.max).toBe(4);
    expect(rules.minGapMinutes).toBe(15);

    // Dans 100 min : échéance dans 40 min, dernier rappel dans 10 min (< 20 min) → aucun rappel
    const soon = await createApiRide(pf.id, { pickup_at: inMinutes(100) });
    expect(await privateReminders(soon.id)).toHaveLength(0);
    // Dans 130 min : seul le dernier rappel, dans 40 min
    const later = await createApiRide(pf.id, { pickup_at: inMinutes(130) });
    const [last] = await privateReminders(later.id);
    const offer = await pendingOffer(later.id);
    expect(last.scheduled_for.getTime()).toBe(offer.expires_at.getTime() - rules.lastCallMinutes * MIN);
    expect(last.body).toMatch(/^Dernier rappel : répondez avant /);
    expect(last.scheduled_for.getTime()).toBeGreaterThanOrEqual(Date.now() + rules.minAheadMinutes * MIN - 5_000);

    // Dans 70 min : échéance dans 10 min (≤ 15 min) → notification « ride_offer » (sonnerie), aucun rappel
    const ring = await createApiRide(pf.id, { pickup_at: inMinutes(70) });
    const ringOffer = await pendingOffer(ring.id);
    expect(ringOffer.expires_at.getTime() - Date.now()).toBeLessThanOrEqual(PRIVATE_FLEET_RING_WINDOW_S * 1000);
    const [initial] = await notifications(ring.id);
    expect(initial).toMatchObject({ type: "ride_offer", title: PRIVATE_FLEET_TITLES.newBooking, offer_id: ringOffer.id });
    expect(initial.data).toMatchObject({ type: "ride_offer", kind: "private_new" });
    expect(await privateReminders(ring.id)).toHaveLength(0);
  });

  it("3. acceptation : ACCEPTED, rappels « à confirmer » annulés, rappels de course programmés", async () => {
    const pf = await createPrivateFleet("Disp Acceptation");
    const ride = await createApiRide(pf.id, { pickup_at: inMinutes(3 * 24 * 60) });
    const offer = await pendingOffer(ride.id);
    expect(await privateReminders(ride.id)).toHaveLength(3);
    expect(await rpc(pf.ownerId, "accept_ride_offer", [offer.id])).toMatchObject({ ok: true, code: "ACCEPTED" });
    expect((await rideState(ride.id)).ride).toMatchObject({ status: "ACCEPTED", driver_id: pf.driverId });
    expect(await privateReminders(ride.id)).toHaveLength(0);
    expect(await privateReminders(ride.id, "cancelled")).toHaveLength(3);
    const n = await notifications(ride.id);
    expect(n.filter((x) => x.type === "ride_offer_scheduled" && x.status === "queued")).toHaveLength(0);
    expect(n.filter((x) => x.type === "ride_reminder" && x.status === "queued")).toHaveLength(4);
  });

  it("4. refus : « Refusée » tout de suite, ni notification ni explication ; refus d'une offre déjà expirée : rien", async () => {
    const pf = await createPrivateFleet("Disp Refus");
    const ride = await createApiRide(pf.id, { pickup_at: inMinutes(2 * 24 * 60) });
    const offer = await pendingOffer(ride.id);
    expect(await rpc(pf.ownerId, "decline_ride_offer", [offer.id])).toMatchObject({ ok: true, code: "DECLINED" });
    const { ride: r, events } = await rideState(ride.id);
    expect(r).toMatchObject({ status: "NO_DRIVER_FOUND", next_dispatch_at: null, driver_id: null });
    expect(r.no_driver_at).not.toBeNull();
    const declined = events.filter((e) => e.type === "dispatch.private_declined");
    expect(declined).toHaveLength(1);
    expect(declined[0]).toMatchObject({ level: "warning", actor_type: "driver", actor_id: pf.driverId });
    const types = events.map((e) => e.type);
    for (const t of ["dispatch.no_driver", "dispatch.excluded"]) expect(types).not.toContain(t);
    expect((await notifications(ride.id)).filter((x) => x.type === "ride_unconfirmed")).toHaveLength(0);

    // Offre déjà fermée par la fin de la fenêtre (immédiate, hors ligne : dernier appel sans personne)
    const late = await createApiRide(pf.id);
    const lateOffer = await pendingOffer(late.id);
    await elapse(late.id);
    expect((await rideState(late.id)).ride.status).toBe("SEARCHING_DRIVER");
    expect(await rpc(pf.ownerId, "decline_ride_offer", [lateOffer.id])).toMatchObject({ ok: true, code: "DECLINED" });
    const after = await rideState(late.id);
    expect(after.ride.status).toBe("SEARCHING_DRIVER");
    expect(after.events.map((e) => e.type)).not.toContain("dispatch.private_declined");
  });

  it("5. sans réponse : dernier appel GPS (hors ligne : personne), puis « Non confirmée » — notification sans ride_id", async () => {
    const pf = await createPrivateFleet("Disp Silence");
    const ride = await createApiRide(pf.id);
    await elapse(ride.id);
    let state = await rideState(ride.id);
    expect(state.ride).toMatchObject({ status: "SEARCHING_DRIVER", dispatch_mode: "geo", dispatch_wave: 1, dispatch_radius_m: 100_000 });
    expect(state.offers.map((o) => [o.mode, o.status, o.closed_reason])).toEqual([["fleet", "expired", "fleet_window_elapsed"]]);
    expect(state.events.map((e) => e.type)).toContain("dispatch.escalated");
    expect((await notifications(ride.id)).filter((x) => x.type === "ride_unconfirmed")).toHaveLength(0);

    await nextWave(ride.id);
    state = await rideState(ride.id);
    expect(state.ride.status).toBe("NO_DRIVER_FOUND");
    expect(state.events.map((e) => e.type)).toContain("dispatch.no_driver");
    const unconfirmed = (await notifications(ride.id)).filter((x) => x.type === "ride_unconfirmed");
    expect(unconfirmed).toHaveLength(1);
    expect(unconfirmed[0]).toMatchObject({
      driver_id: pf.driverId, ride_id: ride.id, offer_id: null, title: PRIVATE_FLEET_TITLES.unconfirmed, status: "queued",
    });
    expect(unconfirmed[0].data).toEqual({ type: "ride_unconfirmed", reason: "not_confirmed", booking_id: ride.id, number: Number(ride.number) });
    expect(unconfirmed[0].body).toMatch(
      new RegExp(`^#${ride.number} · \\d{2}/\\d{2} \\d{2}:\\d{2} · .+ → .+ : confirmez-la quand même ou prévenez votre client\\.$`),
    );
  });

  it("6. dernier appel : en ligne à 80 km avec une position récente → offre GPS (rayon 100 km) qui sonne", async () => {
    const pf = await createPrivateFleet("Disp Dernier Appel", { at: north(ORLY, 80_000) });
    const ride = await createApiRide(pf.id);
    await elapse(ride.id);
    const { ride: r, offers } = await rideState(ride.id);
    const geo = offers.filter((o) => o.mode === "geo");
    expect(geo).toHaveLength(1);
    expect(geo[0]).toMatchObject({ driver_id: pf.driverId, status: "pending", wave: 1, radius_m: 100_000 });
    expect(geo[0].distance_m).toBeGreaterThan(79_000);
    expect(geo[0].distance_m).toBeLessThan(81_000);
    expect(r).toMatchObject({ status: "OFFERED", dispatch_mode: "geo", dispatch_radius_m: 100_000 });
    const n = (await notifications(ride.id)).filter((x) => x.offer_id === geo[0].id);
    expect(n.map((x) => [x.type, x.status])).toEqual([["ride_offer", "queued"]]);
  });

  it("7. véhicule incompatible (van demandé, berline) : aucune offre, « À VÉRIFIER », course en recherche ; « La prendre » → ACCEPTED", async () => {
    const pf = await createPrivateFleet("Disp Van");
    const ride = await createApiRide(pf.id, { vehicle_category: "van", pickup_at: inMinutes(24 * 60) });
    let state = await rideState(ride.id);
    expect(state.offers).toHaveLength(0);
    expect(state.ride).toMatchObject({ status: "SEARCHING_DRIVER", dispatch_mode: "fleet", driver_id: null });
    expect(state.events.map((e) => e.type)).toContain("dispatch.private_incompatible");
    const toCheck = (await notifications(ride.id)).filter((x) => x.type === "ride_unconfirmed");
    expect(toCheck).toHaveLength(1);
    expect(toCheck[0]).toMatchObject({ driver_id: pf.driverId, title: PRIVATE_FLEET_TITLES.toCheck, offer_id: null });
    expect(toCheck[0].data).toEqual({ type: "ride_unconfirmed", reason: "to_check", booking_id: ride.id, number: Number(ride.number) });
    expect(toCheck[0].body).toContain(" : catégorie ou nombre de places au-delà de votre véhicule. Prenez-la quand même ou prévenez votre client.");

    const taken = await rpc(pf.ownerId, "driver_take_ride", [ride.id]);
    expect(taken).toMatchObject({ ok: true, code: "ACCEPTED", ride_id: ride.id, chained: false });
    state = await rideState(ride.id);
    expect(state.ride).toMatchObject({ status: "ACCEPTED", driver_id: pf.driverId });
    const taker = state.events.filter((e) => e.type === "ride.taken_by_driver");
    expect(taker).toHaveLength(1);
    expect(taker[0]).toMatchObject({ actor_type: "driver", actor_id: pf.driverId });
    expect(await assignedStatuses(ride.id)).toEqual(["cancelled"]);
  });

  it("8. saisie par le chauffeur au tableau de bord : ACCEPTED d'office, aucune offre, aucun « ride_assigned » en file", async () => {
    const pf = await createPrivateFleet("Disp Saisie");
    const [row] = await asFresh(pf.ownerId, (q) =>
      q(
        `insert into public.rides (organization_id, pickup_address, pickup_lat, pickup_lng, dropoff_address, customer_name,
                                   customer_phone, passengers, vehicle_category, price_cents, pickup_at)
         values ($1, 'Gare de Lyon, 75012 Paris', 48.8443, 2.3744, 'Aéroport d''Orly, 94390 Orly', 'Client Téléphone',
                 '+33622334455', 1, 'business', 6000, $2)
         returning id`,
        [pf.id, inMinutes(2 * 24 * 60)],
      ),
    );
    const { ride: r, offers, events } = await rideState(row.id);
    expect(r).toMatchObject({ status: "ACCEPTED", driver_id: pf.driverId, source: "dashboard", created_by: pf.ownerId });
    expect(offers).toHaveLength(0);
    expect(events.find((e) => e.type === "dispatch.private_self")).toMatchObject({ level: "success" });
    const n = await notifications(row.id);
    expect(await assignedStatuses(row.id)).toEqual(["cancelled"]);
    expect(n.filter((x) => ["ride_offer", "ride_offer_scheduled", "ride_unconfirmed"].includes(x.type))).toHaveLength(0);
    expect(n.filter((x) => x.type === "ride_reminder" && x.status === "queued").length).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
describe("9. « La prendre » (driver_take_ride)", () => {
  it("« Je la prends » sur le web (takeBooking : driver_take_ride, jeton du propriétaire) : réservation à J+2 à confirmer → offre acceptée, aucune « COURSE ATTRIBUÉE » vers son propre téléphone", async () => {
    const pf = await createPrivateFleet("Prendre Web");
    const ride = await createApiRide(pf.id, { pickup_at: inMinutes(2 * 24 * 60) });
    const offer = await pendingOffer(ride.id);
    expect((await rideState(ride.id)).ride.status).toBe("OFFERED");
    expect(await rpc(pf.ownerId, "driver_take_ride", [ride.id])).toMatchObject({ ok: true, code: "ACCEPTED" });
    const state = await rideState(ride.id);
    expect(state.ride).toMatchObject({ status: "ACCEPTED", driver_id: pf.driverId });
    // Comme « Confirmer » dans l'application : l'offre est acceptée (taux de confirmation), pas fermée par une attribution
    expect(state.offers.map((o) => [o.id, o.status])).toEqual([[offer.id, "accepted"]]);
    expect(state.events.map((e) => e.type)).not.toContain("ride.assigned_manually");
    expect(await assignedStatuses(ride.id)).toEqual([]);
    const n = await notifications(ride.id);
    expect(n.filter((x) => ["ride_offer", "ride_offer_scheduled"].includes(x.type) && x.status === "queued")).toHaveLength(0);
    expect(n.filter((x) => x.type === "ride_reminder" && x.status === "queued").length).toBeGreaterThan(0);
  });

  it("réservation refusée → ACCEPTED ; déjà à lui → UNCHANGED ; annulée → RIDE_NOT_ASSIGNABLE", async () => {
    const pf = await createPrivateFleet("Prendre Refusée");
    const ride = await createApiRide(pf.id, { pickup_at: inMinutes(2 * 24 * 60) });
    await rpc(pf.ownerId, "decline_ride_offer", [(await pendingOffer(ride.id)).id]);
    expect((await rideState(ride.id)).ride.status).toBe("NO_DRIVER_FOUND");
    expect(await rpc(pf.ownerId, "driver_take_ride", [ride.id])).toMatchObject({ ok: true, code: "ACCEPTED", chained: false });
    const state = await rideState(ride.id);
    expect(state.ride).toMatchObject({ status: "ACCEPTED", driver_id: pf.driverId });
    expect(state.events.find((e) => e.type === "ride.taken_by_driver")?.data).toMatchObject({ previous_status: "NO_DRIVER_FOUND" });
    expect(await assignedStatuses(ride.id)).toEqual(["cancelled"]);
    expect(await rpc(pf.ownerId, "driver_take_ride", [ride.id])).toEqual({ ok: true, code: "UNCHANGED", ride_id: ride.id });

    const cancelled = await insertRideBypass(pf, {
      type: "scheduled", status: "CANCELLED", pickup_at: new Date(Date.now() + 24 * 3600_000), cancelled_at: new Date(),
    });
    expect(await rpc(pf.ownerId, "driver_take_ride", [cancelled])).toMatchObject({ ok: false, code: "RIDE_NOT_ASSIGNABLE" });
  });

  it("course d'une autre organisation → RIDE_NOT_FOUND ; flotte standard → PRIVATE_FLEET_ONLY ; sans fiche ou anon → refus", async () => {
    const pf = await createPrivateFleet("Prendre Ailleurs");
    const other = await createOrg("Prendre Autre Organisation");
    const foreign = await createRideAsOwner(other, { pickup_at: inMinutes(24 * 60) });
    expect(await rpc(pf.ownerId, "driver_take_ride", [foreign.id])).toMatchObject({ ok: false, code: "RIDE_NOT_FOUND" });
    expect((await rideState(foreign.id)).ride.driver_id).toBeNull();

    const std = await createDriver(other);
    const [row] = await as({ sub: std.userId }, (q) => q("select public.driver_take_ride($1) as r", [foreign.id]));
    expect(row.r).toMatchObject({ ok: false, code: "PRIVATE_FLEET_ONLY" });

    const nobody = await createAuthUser(`prendre-${Date.now()}@test.dev`, "Sans fiche");
    const forbidden = await expectPgError(as({ sub: nobody }, (q) => q("select public.driver_take_ride($1)", [foreign.id])));
    expect(forbidden.code).toBe("42501");
    expect(forbidden.message).toMatch(/^FORBIDDEN/);
    const anon = await expectPgError(as({ role: "anon" }, (q) => q("select public.driver_take_ride($1)", [foreign.id])));
    expect(anon.code).toBe("42501");
  });

  it("plus de 6 h après l'heure prévue → RIDE_TOO_LATE ; 5 h après → ACCEPTED", async () => {
    const pf = await createPrivateFleet("Prendre Tard");
    const old = await insertRideBypass(pf, { type: "scheduled", status: "NO_DRIVER_FOUND", pickup_at: new Date(Date.now() - 7 * 3600_000) });
    const res = await rpc(pf.ownerId, "driver_take_ride", [old]);
    expect(res).toEqual({ ok: false, code: "RIDE_TOO_LATE", message: "Heure de prise en charge dépassée depuis plus de 6 h." });
    expect((await rideState(old)).ride.driver_id).toBeNull();
    const recent = await insertRideBypass(pf, { type: "scheduled", status: "NO_DRIVER_FOUND", pickup_at: new Date(Date.now() - 5 * 3600_000) });
    expect(await rpc(pf.ownerId, "driver_take_ride", [recent])).toMatchObject({ ok: true, code: "ACCEPTED" });
    expect(await assignedStatuses(recent)).toEqual(["cancelled"]);
  });

  it("immédiate pendant une course : DRIVER_BUSY à l'acceptation, « La prendre » → ACCEPTED, enchaînée à la fin", async () => {
    const pf = await createPrivateFleet("Prendre Enchaînée");
    const first = await createApiRide(pf.id);
    expect(await rpc(pf.ownerId, "accept_ride_offer", [(await pendingOffer(first.id)).id])).toMatchObject({ ok: true, code: "ACCEPTED" });
    expect((await sql("select current_ride_id from public.drivers where id = $1", [pf.driverId]))[0].current_ride_id).toBe(first.id);

    const second = await createApiRide(pf.id, { customer_name: "Second Client" });
    const offer = await pendingOffer(second.id);
    expect(offer).toMatchObject({ driver_id: pf.driverId, mode: "fleet" });
    expect(await rpc(pf.ownerId, "accept_ride_offer", [offer.id])).toMatchObject({ ok: false, code: "DRIVER_BUSY" });
    const taken = await rpc(pf.ownerId, "driver_take_ride", [second.id]);
    expect(taken).toMatchObject({ ok: true, code: "ACCEPTED", ride_id: second.id, chained: true });
    expect((await rideState(second.id)).ride).toMatchObject({ status: "ACCEPTED", driver_id: pf.driverId });
    expect(await assignedStatuses(second.id)).toEqual(["cancelled"]);
    expect((await sql("select current_ride_id from public.drivers where id = $1", [pf.driverId]))[0].current_ride_id).toBe(first.id);

    for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS", "COMPLETED"]) {
      expect((await rpc(pf.ownerId, "driver_update_ride_status", [first.id, s])).ok, s).toBe(true);
    }
    expect((await sql("select current_ride_id from public.drivers where id = $1", [pf.driverId]))[0].current_ride_id).toBe(second.id);
  });
});

// -----------------------------------------------------------------------------
describe("cas particuliers", () => {
  it("10. auto_dispatch mis à faux par le client : l'offre part quand même", async () => {
    const pf = await createPrivateFleet("Disp Auto");
    await asFresh(pf.ownerId, (q) => q("update public.organization_settings set auto_dispatch = false where organization_id = $1", [pf.id]));
    expect((await sql("select auto_dispatch from public.organization_settings where organization_id = $1", [pf.id]))[0].auto_dispatch).toBe(false);
    const ride = await createApiRide(pf.id, { pickup_at: inMinutes(24 * 60) });
    const { ride: r, offers } = await rideState(ride.id);
    expect(r.status).toBe("OFFERED");
    expect(offers.map((o) => [o.driver_id, o.mode, o.status])).toEqual([[pf.driverId, "fleet", "pending"]]);
  });

  it("11. fiche suspendue : NO_DRIVER_FOUND immédiat (dispatch.private_no_driver), ni offre ni notification", async () => {
    const pf = await createPrivateFleet("Disp Suspendue");
    expect(await rpc(pf.ownerId, "set_driver_status", [pf.driverId, "suspended", "Contrôle des documents"])).toMatchObject({ ok: true });
    const ride = await createApiRide(pf.id, { pickup_at: inMinutes(24 * 60) });
    const { ride: r, offers, events } = await rideState(ride.id);
    expect(r).toMatchObject({ status: "NO_DRIVER_FOUND", dispatch_mode: "fleet", next_dispatch_at: null });
    expect(r.no_driver_at).not.toBeNull();
    expect(r.dispatch_started_at).not.toBeNull();
    expect(offers).toHaveLength(0);
    const noDriver = events.filter((e) => e.type === "dispatch.private_no_driver");
    expect(noDriver).toHaveLength(1);
    expect(noDriver[0].level).toBe("error");
    expect((await notifications(ride.id)).filter((x) => x.driver_id === pf.driverId)).toHaveLength(0);
  });

  it("12. vol retardé : échéance recalculée, anciens rappels annulés, nouveaux posés", async () => {
    const pf = await createPrivateFleet("Disp Vol");
    const ride = await createApiRide(pf.id, { pickup_at: inMinutes(2 * 24 * 60), flight_number: "AF1234" });
    const before = (await rideState(ride.id)).ride.pickup_at.getTime();
    expect(await privateReminders(ride.id)).toHaveLength(3);

    // Vol prévu 30 min avant la prise en charge, annoncé avec 2 h de retard
    const [res] = await sql("select private.apply_flight_status($1, 'delayed', $2, $3) as r", [
      ride.id, new Date(before - 30 * MIN), new Date(before + 90 * MIN),
    ]);
    expect(res.r).toMatchObject({ ok: true });
    const { ride: r, offers } = await rideState(ride.id);
    const pickup = r.pickup_at.getTime();
    expect(pickup - before).toBeGreaterThan(115 * MIN);
    expect(offers.filter((o) => o.status === "pending").map((o) => o.expires_at.getTime())).toEqual([pickup - 60 * MIN]);
    expect(await privateReminders(ride.id, "cancelled")).toHaveLength(3);
    expect((await privateReminders(ride.id)).map((n) => (pickup - n.scheduled_for.getTime()) / MIN)).toEqual([1440, 180, 90]);
  });

  it("13. suspension puis bannissement de la fiche pendant une course acceptée : acceptés (D13), course remise en recherche", async () => {
    const pf = await createPrivateFleet("Disp D13");
    const ride = await createApiRide(pf.id, { pickup_at: inMinutes(2 * 24 * 60) });
    expect(await rpc(pf.ownerId, "accept_ride_offer", [(await pendingOffer(ride.id)).id])).toMatchObject({ ok: true, code: "ACCEPTED" });

    expect(await rpc(pf.ownerId, "set_driver_status", [pf.driverId, "suspended", "Contrôle"])).toMatchObject({
      ok: true, code: "STATUS_CHANGED", reassigned_rides: 1,
    });
    let state = await rideState(ride.id);
    expect(state.ride).toMatchObject({ driver_id: null, status: "SEARCHING_DRIVER" });
    expect(state.events.map((e) => e.type)).toContain("ride.reassigned");

    // Réactivée, la fiche reprend la réservation (« La prendre » ignore le marqueur removed_by_dispatch)
    expect(await rpc(pf.ownerId, "set_driver_status", [pf.driverId, "active", null])).toMatchObject({ ok: true });
    expect(await rpc(pf.ownerId, "driver_take_ride", [ride.id])).toMatchObject({ ok: true, code: "ACCEPTED" });

    expect(await rpc(pf.ownerId, "ban_driver", [pf.driverId, "Fraude avérée", "fraud", false, false])).toMatchObject({
      ok: true, code: "BANNED", reassigned_rides: 1,
    });
    state = await rideState(ride.id);
    expect(state.ride).toMatchObject({ driver_id: null, status: "SEARCHING_DRIVER" });
  });

  it("14. compatibilité de l'app 1.1.0 : l'offre figure dans driver_offers_v2", async () => {
    const pf = await createPrivateFleet("Disp Compat");
    const ride = await createApiRide(pf.id, { pickup_at: inMinutes(24 * 60) });
    const offer = await pendingOffer(ride.id);
    const list = (await rpc(pf.ownerId, "driver_offers_v2")) as unknown as Row[];
    expect(list.find((o) => o.offer_id === offer.id)).toMatchObject({ ride_id: ride.id, mode: "fleet", status: "pending" });
  });
});

// -----------------------------------------------------------------------------
describe("échéance annoncée tenue (H5, H6)", () => {
  it("délai de confirmation porté à 24 h pendant l'attente : la réservation garde son échéance, ni « Non confirmée » ni webhook avant ; à l'échéance, chemin normal", async () => {
    const pf = await createPrivateFleet("Disp Délai Augmenté");
    await sql("insert into public.webhook_endpoints (organization_id, url) values ($1, 'https://site.example/hook')", [pf.id]);
    const ride = await createApiRide(pf.id, { pickup_at: inMinutes(10 * 60) });
    const offer = await pendingOffer(ride.id);
    const pickup = (await rideState(ride.id)).ride.pickup_at.getTime();
    const deadline = offer.expires_at.getTime();
    expect(deadline).toBe(pickup - 60 * MIN);
    const reminders = await privateReminders(ride.id);
    expect(minutesBefore(pickup, reminders)).toEqual([180, 90]);

    // « Confirmer au plus tard 24 h avant » : la fenêtre « flotte » serait déjà close (prise en charge dans 10 h)
    await setBookingSettings(pf, "scheduled_dispatch_lead_minutes = 1440");
    expect((await rideState(ride.id)).ride.next_dispatch_at.getTime()).toBe(deadline);
    await sql("select private.dispatch_tick()");
    let state = await rideState(ride.id);
    expect(state.ride).toMatchObject({ status: "OFFERED", dispatch_mode: "fleet" });
    expect(state.offers.map((o) => [o.id, o.status, o.expires_at.getTime()])).toEqual([[offer.id, "pending", deadline]]);
    expect((await privateReminders(ride.id)).map((n) => n.id)).toEqual(reminders.map((n) => n.id));
    expect((await notifications(ride.id)).filter((x) => x.type === "ride_unconfirmed")).toHaveLength(0);
    expect(await noDriverWebhooks(ride.id)).toHaveLength(0);

    // À l'échéance annoncée : dernier appel (hors ligne : personne), puis « Non confirmée »
    await elapse(ride.id);
    state = await rideState(ride.id);
    expect(state.ride).toMatchObject({ status: "SEARCHING_DRIVER", dispatch_mode: "geo", dispatch_radius_m: 100_000 });
    expect(state.offers.map((o) => [o.status, o.closed_reason])).toEqual([["expired", "fleet_window_elapsed"]]);
    await nextWave(ride.id);
    expect((await rideState(ride.id)).ride.status).toBe("NO_DRIVER_FOUND");
    expect(await noDriverWebhooks(ride.id)).toHaveLength(1);

    // Réservation reçue après le changement : le nouveau délai s'applique (réponse attendue tout de suite, sonnerie)
    const next = await createApiRide(pf.id, { pickup_at: inMinutes(10 * 60) });
    const nextOffer = await pendingOffer(next.id);
    expect(nextOffer.expires_at.getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    expect((await notifications(next.id)).find((x) => x.offer_id === nextOffer.id)?.type).toBe("ride_offer");
  });

  it("délai porté à 6 h (fenêtre encore ouverte mais close avant l'échéance) : échéance gardée ; délai réduit : échéance reportée, rappels replanifiés", async () => {
    const pf = await createPrivateFleet("Disp Délai Six Heures");
    const ride = await createApiRide(pf.id, { pickup_at: inMinutes(10 * 60) });
    const offer = await pendingOffer(ride.id);
    const pickup = (await rideState(ride.id)).ride.pickup_at.getTime();
    await setBookingSettings(pf, "scheduled_dispatch_lead_minutes = 360");
    expect((await rideState(ride.id)).ride.next_dispatch_at.getTime()).toBe(offer.expires_at.getTime());
    await sql("select private.dispatch_tick()");
    expect((await pendingOffer(ride.id)).expires_at.getTime()).toBe(pickup - 60 * MIN);

    // Délai réduit à 30 min : au passage suivant, l'échéance est reportée (plus de temps), rappels replanifiés
    await setBookingSettings(pf, "scheduled_dispatch_lead_minutes = 30");
    await nextWave(ride.id);
    const later = await pendingOffer(ride.id);
    expect(later).toMatchObject({ id: offer.id });
    expect(later.expires_at.getTime()).toBe(pickup - 30 * MIN);
    expect(minutesBefore(pickup, await privateReminders(ride.id))).toEqual([180, 60]);
  });

  it("délai de réponse de 10 min : la réservation immédiate garde ses 10 min (passage à l'échéance, pas au bout de 5 min)", async () => {
    const pf = await createPrivateFleet("Disp Dix Minutes");
    await setBookingSettings(pf, "offer_timeout_seconds = 600");
    const ride = await createApiRide(pf.id);
    const offer = await pendingOffer(ride.id);
    const ttl = (offer.expires_at.getTime() - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(580);
    expect(ttl).toBeLessThanOrEqual(601);
    expect((await rideState(ride.id)).ride.next_dispatch_at.getTime()).toBe(offer.expires_at.getTime());
    await elapse(ride.id);
    expect((await rideState(ride.id)).offers.map((o) => [o.status, o.closed_reason])).toEqual([["expired", "fleet_window_elapsed"]]);
  });

  it("organisation standard : délai augmenté sans effet sur le prochain passage (non-régression)", async () => {
    const org = await createOrg("Disp Standard Délai");
    await createDriver(org, { presence: "offline" });
    const ride = await createRideAsOwner(org, { pickup_at: inMinutes(10 * 60) });
    const before = (await rideState(ride.id)).ride.next_dispatch_at.getTime();
    expect(before - Date.now()).toBeLessThanOrEqual(5 * MIN);
    await as({ sub: org.ownerId }, (q) =>
      q("update public.organization_settings set scheduled_dispatch_lead_minutes = 1440 where organization_id = $1", [org.id]));
    const [lead] = await sql("select scheduled_dispatch_lead_minutes as m from public.organization_settings where organization_id = $1", [org.id]);
    expect(lead.m).toBe(1440);
    expect((await rideState(ride.id)).ride.next_dispatch_at.getTime()).toBe(before);
  });
});

// -----------------------------------------------------------------------------
describe("« NOUVELLE RÉSERVATION » pour toute offre faite (H4)", () => {
  it("véhicule corrigé après « À VÉRIFIER » : offre faite au passage suivant, notification qui sonne (fenêtre de 10 min)", async () => {
    const pf = await createPrivateFleet("Disp Van Corrigé");
    const ride = await createApiRide(pf.id, { vehicle_category: "van", pickup_at: inMinutes(70) });
    expect((await rideState(ride.id)).offers).toHaveLength(0);
    await sql("update public.vehicles set category = 'van', seats = 7 where id = $1", [pf.vehicleId]);
    await nextWave(ride.id);
    const offer = await pendingOffer(ride.id);
    expect(offer).toMatchObject({ driver_id: pf.driverId, mode: "fleet" });
    expect(offer.expires_at.getTime() - Date.now()).toBeLessThanOrEqual(PRIVATE_FLEET_RING_WINDOW_S * 1000);
    const n = (await notifications(ride.id)).filter((x) => x.offer_id === offer.id);
    expect(n.map((x) => [x.type, x.title, x.status])).toEqual([["ride_offer", PRIVATE_FLEET_TITLES.newBooking, "queued"]]);
    expect(n[0].data).toMatchObject({ type: "ride_offer", kind: "private_new", offer_id: offer.id, ride_id: ride.id });
  });

  it("vol retardé d'une réservation « maintenant » : requalifiée et reproposée, notifiée « NOUVELLE RÉSERVATION » qui sonne", async () => {
    const pf = await createPrivateFleet("Disp Vol Immédiate");
    const ride = await createApiRide(pf.id, { flight_number: "AF1234" });
    const first = await pendingOffer(ride.id);
    const [res] = await sql(
      "select private.apply_flight_status($1, 'delayed', now() - interval '1 minute', now() + interval '60 minutes') as r",
      [ride.id],
    );
    expect(res.r).toMatchObject({ ok: true, requalified: "fleet" });
    const { ride: r, offers } = await rideState(ride.id);
    expect(r).toMatchObject({ type: "scheduled", status: "OFFERED", dispatch_mode: "fleet" });
    expect(offers.find((o) => o.id === first.id)).toMatchObject({ status: "closed", closed_reason: "flight_rescheduled" });
    const again = offers.find((o) => o.status === "pending")!;
    expect(again).toMatchObject({ driver_id: pf.driverId, mode: "fleet" });
    const n = (await notifications(ride.id)).filter((x) => x.offer_id === again.id);
    expect(n.map((x) => [x.type, x.title])).toEqual([["ride_offer", PRIVATE_FLEET_TITLES.newBooking]]);
    expect(n[0].data).toMatchObject({ type: "ride_offer", kind: "private_new", offer_id: again.id });
  });
});

// -----------------------------------------------------------------------------
describe("rappels « à confirmer » : réglages changés, organisation sortie (H1, H6)", () => {
  it("rappels changés dans les réglages : replanifiés (encore prévus et déjà dus gardés) ; réglages réenregistrés à l'identique : rien ne bouge", async () => {
    const pf = await createPrivateFleet("Disp Rappels Réglés");
    const ride = await createApiRide(pf.id, { pickup_at: inMinutes(3 * 24 * 60) });
    const pickup = (await rideState(ride.id)).ride.pickup_at.getTime();
    const [day, three, last] = await privateReminders(ride.id);
    expect(minutesBefore(pickup, [day!, three!, last!])).toEqual([1440, 180, 90]);
    // Rappel de la veille déjà dû, pas encore envoyé : il part tel quel
    await sql("update public.notifications set scheduled_for = now() - interval '1 minute' where id = $1", [day!.id]);

    await setBookingSettings(pf, "reminder_offsets_minutes = '{720,120}'");
    const queued = await privateReminders(ride.id);
    expect(queued.map((n) => n.id)).toEqual([day!.id, expect.any(String), expect.any(String), last!.id]);
    expect(minutesBefore(pickup, queued.slice(1))).toEqual([720, 120, 90]);
    expect(queued[1]!.body).toMatch(/^Prise en charge dans 12 h · /);
    expect((await privateReminders(ride.id, "cancelled")).map((n) => n.id)).toEqual([three!.id]);

    // Onglet enregistré sans changement (toutes les colonnes réécrites) : aucun rappel remplacé
    await setBookingSettings(pf, "scheduled_dispatch_lead_minutes = 60, offer_timeout_seconds = 300, reminder_offsets_minutes = '{720,120}'");
    expect((await privateReminders(ride.id)).map((n) => n.id)).toEqual(queued.map((n) => n.id));
  });

  it("organisation qui n'est plus une Flotte Privée : un changement d'échéance annule les rappels restants", async () => {
    const pf = await createPrivateFleet("Disp Rappels Drapeau");
    const ride = await createApiRide(pf.id, { pickup_at: inMinutes(2 * 24 * 60) });
    expect(await privateReminders(ride.id)).toHaveLength(3);
    // Drapeau retiré seul (marqueur des RPC, sans la bascule) : seuls les déclencheurs de l'offre jouent
    await as({ role: "service_role" }, async (q) => {
      await q("select set_config('rydar.private_fleet_change', $1, true)", [pf.id]);
      await q("update public.organizations set private_fleet = false where id = $1", [pf.id]);
    });
    await sql("update public.ride_offers set expires_at = expires_at - interval '30 minutes' where ride_id = $1 and status = 'pending'", [ride.id]);
    expect(await privateReminders(ride.id)).toHaveLength(0);
    expect(await privateReminders(ride.id, "cancelled")).toHaveLength(3);
  });
});

// -----------------------------------------------------------------------------
describe("15. non-régression : flotte standard", () => {
  it("course immédiate : vagues GPS 4 → 8 → 12 → 16 km puis relance 4 → 8 km, sans notification Flotte Privée", async () => {
    const org = await createOrg("Disp Standard Vagues");
    await createDriver(org, { at: north(CHAMPS_ELYSEES, 17_500) });
    const ride = await createRideAsOwner(org);
    const radii: number[] = [];
    for (let i = 0; i < 6; i++) {
      const { ride: r } = await rideState(ride.id);
      expect(r).toMatchObject({ status: "SEARCHING_DRIVER", dispatch_mode: "geo", dispatch_wave: i + 1 });
      radii.push(r.dispatch_radius_m);
      await nextWave(ride.id);
    }
    expect(radii).toEqual([4000, 8000, 12000, 16000, 4000, 8000]);
    const { ride: r, events } = await rideState(ride.id);
    expect(r.status).toBe("NO_DRIVER_FOUND");
    expect(events.map((e) => e.type).filter((t) => t.startsWith("dispatch.private_"))).toEqual([]);
    expect((await notifications(ride.id)).filter((x) => x.type === "ride_unconfirmed")).toHaveLength(0);
  });

  it("planifiée : titre « NOUVELLE COURSE PLANIFIÉE », aucun rappel « à confirmer » ; un refus ne clôt pas la recherche", async () => {
    const org = await createOrg("Disp Standard Planifiée");
    const d = await createDriver(org, { presence: "offline" });
    const ride = await createRideAsOwner(org, { pickup_at: inMinutes(2 * 24 * 60) });
    const offer = await pendingOffer(ride.id);
    const n = await notifications(ride.id);
    expect(n.map((x) => [x.type, x.title])).toEqual([["ride_offer_scheduled", "NOUVELLE COURSE PLANIFIÉE"]]);
    expect(n[0].data).not.toHaveProperty("kind");
    const [row] = await as({ sub: d.userId }, (q) => q("select public.decline_ride_offer($1) as r", [offer.id]));
    expect(row.r).toMatchObject({ ok: true, code: "DECLINED" });
    expect((await rideState(ride.id)).ride.status).not.toBe("NO_DRIVER_FOUND");
  });
});
