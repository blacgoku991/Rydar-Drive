// Destination sans coordonnées (audit flux-course#8) : jamais la prise en charge à sa place.
import { describe, expect, it } from "vitest";
import { navUrl, rideTarget } from "./ride-target";

const ride = {
  pickup_lat: 48.8566, pickup_lng: 2.3522, pickup_address: "1 rue de Rivoli, Paris",
  dropoff_lat: 49.0097, dropoff_lng: 2.5479, dropoff_address: "Aéroport CDG, Terminal 2E",
};

describe("rideTarget", () => {
  it("jusqu'au client : la prise en charge", () => {
    expect(rideTarget(ride, true)).toEqual({ lat: 48.8566, lng: 2.3522, label: "1 rue de Rivoli, Paris" });
  });

  it("client à bord : la destination", () => {
    expect(rideTarget(ride, false)).toEqual({ lat: 49.0097, lng: 2.5479, label: "Aéroport CDG, Terminal 2E" });
  });

  it("destination sans coordonnées : son adresse, jamais la prise en charge", () => {
    const t = rideTarget({ ...ride, dropoff_lat: null, dropoff_lng: null }, false);
    expect(t).toEqual({ lat: null, lng: null, label: "Aéroport CDG, Terminal 2E" });
  });
});

describe("navUrl", () => {
  it("par coordonnées", () => {
    const t = rideTarget(ride, false);
    expect(navUrl("waze", t)).toBe("https://waze.com/ul?ll=49.0097,2.5479&navigate=yes");
    expect(navUrl("google", t)).toBe("https://www.google.com/maps/dir/?api=1&destination=49.0097,2.5479&travelmode=driving");
    expect(navUrl("apple", t)).toContain("daddr=49.0097,2.5479");
  });

  it("par adresse quand la destination n'a pas de coordonnées", () => {
    const t = rideTarget({ ...ride, dropoff_lat: null, dropoff_lng: null }, false);
    const q = encodeURIComponent("Aéroport CDG, Terminal 2E");
    expect(navUrl("waze", t)).toBe(`https://waze.com/ul?q=${q}&navigate=yes`);
    expect(navUrl("google", t)).toBe(`https://www.google.com/maps/dir/?api=1&destination=${q}&travelmode=driving`);
    expect(navUrl("apple", t)).toBe(`http://maps.apple.com/?daddr=${q}`);
    for (const app of ["waze", "google", "apple"] as const) expect(navUrl(app, t)).not.toContain("48.8566");
  });
});
