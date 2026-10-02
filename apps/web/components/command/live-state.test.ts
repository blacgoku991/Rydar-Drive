import { describe, expect, it } from "vitest";
import type { LiveDriver, LiveRide, LiveSnapshot } from "@/lib/queries/live";
import { reducer, type State } from "./live-state";

const empty: State = { drivers: {}, rides: {}, offers: {}, alerts: {}, reports: {}, kpis: null };

function driver(id: string, updated_at = "2026-10-01T08:00:00Z"): LiveDriver {
  return {
    id, number: 1, first_name: "Karim", last_name: "Test", phone: "+33600000000", photo_url: null, presence: "available", status: "active",
    current_ride_id: null, online_since: null, vehicle: null, location: { lat: 48.85, lng: 2.35, heading: 0, speed_mps: 0, updated_at },
  };
}

function ride(id: string, extra: Partial<LiveRide> = {}): LiveRide {
  return {
    id, number: 1, type: "instant", status: "ACCEPTED", source: "dashboard", dispatch_mode: null, pickup_address: "A", pickup_lat: 48.85,
    pickup_lng: 2.35, dropoff_address: "B", dropoff_lat: 48.9, dropoff_lng: 2.4, pickup_at: "2026-10-01T08:00:00Z", customer_name: "Client",
    passengers: 1, vehicle_category: "business", price_cents: 5000, driver_id: null, dispatch_wave: 0, dispatch_radius_m: null, next_dispatch_at: null,
    created_at: "2026-10-01T07:00:00Z", updated_at: "2026-10-01T07:00:00Z", ...extra,
  };
}

const snapshot = (s: Partial<LiveSnapshot>): LiveSnapshot => ({ drivers: [], rides: [], offers: [], alerts: [], reports: [], kpis: null, serverTime: "", ...s });

describe("réducteur du centre de commande", () => {
  it("lot de positions : une seule copie, seuls les chauffeurs déplacés changent d'identité", () => {
    const state = reducer(empty, { type: "snapshot", snapshot: snapshot({ drivers: [driver("a"), driver("b"), driver("c")] }) });
    const next = reducer(state, {
      type: "locations",
      payloads: [
        { driver_id: "a", lat: 48.86, lng: 2.36, heading: 90, speed: 10, updated_at: "2026-10-01T08:00:05Z" },
        { driver_id: "inconnu", lat: 0, lng: 0, heading: 0, speed: 0, updated_at: "2026-10-01T08:00:05Z" },
      ],
    });
    expect(next.drivers.a!.location).toEqual({ lat: 48.86, lng: 2.36, heading: 90, speed_mps: 10, updated_at: "2026-10-01T08:00:05Z" });
    expect(next.drivers.b).toBe(state.drivers.b);
    expect(next.drivers.c).toBe(state.drivers.c);
    expect(next.rides).toBe(state.rides);
  });

  it("position plus ancienne que celle connue : ignorée (état inchangé)", () => {
    const state = reducer(empty, { type: "snapshot", snapshot: snapshot({ drivers: [driver("a", "2026-10-01T08:00:10Z")] }) });
    const next = reducer(state, { type: "locations", payloads: [{ driver_id: "a", lat: 1, lng: 1, heading: 0, speed: 0, updated_at: "2026-10-01T08:00:05Z" }] });
    expect(next).toBe(state);
  });

  it("tracé chargé à la demande : gardé par l'instantané suivant tant que le trajet est le même", () => {
    let state = reducer(empty, { type: "snapshot", snapshot: snapshot({ rides: [ride("r1"), ride("r2")] }) });
    expect(state.rides.r1!.route_polyline).toBeUndefined();
    state = reducer(state, { type: "route", id: "r1", polyline: "abc" });
    state = reducer(state, { type: "route", id: "r2", polyline: "xyz" });
    expect(state.rides.r1!.route_polyline).toBe("abc");
    // Instantané sans tracé : r1 inchangé garde le sien ; r2 a changé de destination, son ancien tracé est oublié
    state = reducer(state, { type: "snapshot", snapshot: snapshot({ rides: [ride("r1"), ride("r2", { dropoff_lat: 49 })] }) });
    expect(state.rides.r1!.route_polyline).toBe("abc");
    expect(state.rides.r2!.route_polyline).toBeUndefined();
  });

  it("ride.updated sans tracé : l'existant (ou « à charger ») est conservé ; création sans tracé : aucun", () => {
    let state = reducer(empty, { type: "snapshot", snapshot: snapshot({ rides: [ride("r1")] }) });
    state = reducer(state, { type: "ride", payload: { ...ride("r1", { status: "PASSENGER_ONBOARD" }), op: "update", route_polyline: null } });
    expect(state.rides.r1!.status).toBe("PASSENGER_ONBOARD");
    expect("route_polyline" in state.rides.r1!).toBe(false);
    state = reducer(state, { type: "route", id: "r1", polyline: "abc" });
    state = reducer(state, { type: "ride", payload: { ...ride("r1", { status: "IN_PROGRESS" }), op: "update", route_polyline: null } });
    expect(state.rides.r1!.route_polyline).toBe("abc");
    state = reducer(state, { type: "ride", payload: { ...ride("r9"), op: "insert", route_polyline: null } });
    expect(state.rides.r9!.route_polyline).toBeNull();
    state = reducer(state, { type: "ride", payload: { ...ride("r8"), op: "insert", route_polyline: "def" } });
    expect(state.rides.r8!.route_polyline).toBe("def");
  });

  it("tracé reçu pour une course déjà renseignée ou inconnue : état inchangé", () => {
    const state = reducer(empty, { type: "snapshot", snapshot: snapshot({ rides: [ride("r1", { route_polyline: null })] }) });
    expect(reducer(state, { type: "route", id: "r1", polyline: "abc" })).toBe(state);
    expect(reducer(state, { type: "route", id: "absente", polyline: "abc" })).toBe(state);
  });
});
