import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publicRide } from "./index";

const APP = "https://rydar.example";

const row = {
  id: "8d0c0000-0000-4000-8000-000000000001",
  number: 1042,
  type: "scheduled",
  status: "ACCEPTED",
  pickup_address: "Gare de Lyon, Paris",
  pickup_lat: 48.8443,
  pickup_lng: 2.3744,
  dropoff_address: "Aéroport CDG T2",
  dropoff_lat: 49.0097,
  dropoff_lng: 2.5479,
  pickup_at: "2026-10-03T08:30:00+00:00",
  passengers: 2,
  luggage: 3,
  vehicle_category: "van",
  price_cents: 8900,
  currency: "EUR",
  payment_method: "card_onboard",
  flight_number: "AF1234",
  external_reference: "RP-AB12C",
  estimated_distance_m: 32100,
  estimated_duration_s: 2700,
  route_polyline: "_p~iF~ps|U",
  created_at: "2026-10-02T10:00:00+00:00",
  accepted_at: "2026-10-02T10:01:00+00:00",
  driver_arrived_at: null,
  started_at: null,
  completed_at: null,
  cancelled_at: null,
  // Champs internes jamais exposés
  customer_phone: "+33600000000",
  notes_internal: "VIP",
  driver_id: "d1",
  driver: { first_name: "Karim", vehicle: { brand: "Mercedes", model: "Classe V", color: "Noir", plate: "AB-123-CD" } },
};

describe("publicRide (API v1 et webhooks)", () => {
  it("forme publique complète, sans champ interne", () => {
    expect(publicRide(row, APP)).toEqual({
      id: row.id,
      number: 1042,
      type: "scheduled",
      status: "ACCEPTED",
      pickup: { address: "Gare de Lyon, Paris", lat: 48.8443, lng: 2.3744 },
      dropoff: { address: "Aéroport CDG T2", lat: 49.0097, lng: 2.5479 },
      pickup_at: "2026-10-03T08:30:00+00:00",
      passengers: 2,
      luggage: 3,
      vehicle_category: "van",
      price_cents: 8900,
      currency: "EUR",
      payment_method: "card_onboard",
      flight_number: "AF1234",
      external_reference: "RP-AB12C",
      route: { distance_m: 32100, duration_s: 2700, polyline: "_p~iF~ps|U" },
      driver: { first_name: "Karim", vehicle: { model: "Mercedes Classe V", color: "Noir", plate: "AB-123-CD" } },
      timestamps: {
        created_at: "2026-10-02T10:00:00+00:00",
        accepted_at: "2026-10-02T10:01:00+00:00",
        driver_arrived_at: null,
        started_at: null,
        completed_at: null,
        cancelled_at: null,
      },
      links: { self: `${APP}/api/v1/rides/${row.id}` },
    });
    const json = JSON.stringify(publicRide(row, APP));
    expect(json).not.toContain("customer_phone");
    expect(json).not.toContain("VIP");
    expect(json).not.toContain("driver_id");
  });

  it("relations PostgREST en tableau, sans chauffeur, sans véhicule, sans itinéraire", () => {
    const arr = publicRide({ ...row, driver: [{ first_name: "Inès", vehicle: [{ brand: null, model: "Prius", color: "Gris", plate: "XY-1" }] }] }, APP);
    expect(arr.driver).toEqual({ first_name: "Inès", vehicle: { model: "Prius", color: "Gris", plate: "XY-1" } });
    expect(publicRide({ ...row, driver: { first_name: "Inès", vehicle: null } }, APP).driver).toEqual({ first_name: "Inès", vehicle: null });
    expect(publicRide({ ...row, driver: null }, APP).driver).toBeNull();
    expect(publicRide({ ...row, driver: [] }, APP).driver).toBeNull();
    const noRoute = publicRide({ ...row, estimated_distance_m: null, route_polyline: null }, APP);
    expect(noRoute.route).toBeNull();
    expect(publicRide({ ...row, route_polyline: undefined }, APP).route).toEqual({ distance_m: 32100, duration_s: 2700, polyline: null });
    // Horodatages absents (ligne partielle) : null, jamais undefined (clé présente dans le JSON)
    const partial = publicRide({ id: "x", created_at: "t" }, APP);
    expect(Object.keys(partial.timestamps)).toHaveLength(6);
    expect(partial.timestamps.started_at).toBeNull();
  });

  it("chauffeur partenaire (réseau partagé, public.ride_public_driver) : prénom, véhicule figé, exploitant ; jamais d'autre champ", () => {
    const partner = {
      ...row,
      driver: { first_name: "Karim", vehicle: { brand: "Toyota", model: "Prius", color: "Gris", plate: "GH-456-JK" }, operator: { name: "Flotte B SAS", siret: "123" } },
    };
    expect(publicRide(partner, APP).driver).toEqual({
      first_name: "Karim",
      vehicle: { model: "Toyota Prius", color: "Gris", plate: "GH-456-JK" },
      operator: { name: "Flotte B SAS" },
    });
    // Chauffeur de l'organisation : aucune clé « operator » (objet d'avant)
    expect(Object.keys(publicRide(row, APP).driver!)).toEqual(["first_name", "vehicle"]);
    // 24 h après la fin de la course partenaire : plus de chauffeur
    expect(publicRide({ ...partner, driver: null }, APP).driver).toBeNull();
  });

  it("chaque colonne de PUBLIC_RIDE_SELECT est lue, et seulement elles (ligne SQL des webhooks : mêmes noms)", () => {
    const src = readFileSync(join(__dirname, "../../../apps/web/lib/api/v1.ts"), "utf8");
    const select = /PUBLIC_RIDE_SELECT\s*=\s*"([^"]+)"/.exec(src)?.[1];
    expect(select).toBeTruthy();
    const columns = select!.replace(/,?\s*driver:.*$/, "").split(",").map((c) => c.trim());
    const read = new Set<string>();
    const spy = new Proxy({ ...row }, { get: (t, k) => (typeof k === "string" && read.add(k), (t as any)[k]) });
    publicRide(spy, APP);
    read.delete("driver");
    expect([...read].sort()).toEqual([...columns].sort());
    // « driver » : colonne calculée public.ride_public_driver (même objet que private.webhook_ride_json)
    expect(select!.trim().endsWith("driver:ride_public_driver")).toBe(true);
  });
});
