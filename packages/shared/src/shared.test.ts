import { describe, expect, it } from "vitest";
import {
  apiRideCreateSchema, canDriverTransition, classifyRide, DRIVER_FLOW, estimatePrice, estimateRoute, extractErrorCode,
  formatDistance, formatPrice, haversine, humanizeError, isCategoryCompatible, normalizePhone, rideFormSchema, TENANT_FIELDS,
} from "./index";

describe("format", () => {
  it("prix et distances en français", () => {
    expect(formatPrice(6500)).toBe("65 €");
    expect(formatPrice(7250)).toBe("72,50 €");
    expect(formatDistance(1800)).toBe("1,8 km");
    expect(formatDistance(640)).toBe("640 m");
    expect(formatDistance(12_400)).toBe("12 km");
  });
  it("normalise les téléphones", () => {
    expect(normalizePhone("06 12 34 56 78")).toBe("+33612345678");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("abc")).toBeNull();
  });
});

describe("domaine", () => {
  it("machine à états chauffeur", () => {
    expect(canDriverTransition("ACCEPTED", "DRIVER_EN_ROUTE")).toBe(true);
    expect(canDriverTransition("ACCEPTED", "COMPLETED")).toBe(false);
    expect(DRIVER_FLOW.IN_PROGRESS?.label).toBe("Terminer la course");
  });
  it("compatibilité des catégories (miroir SQL)", () => {
    expect(isCategoryCompatible("standard", "business", true)).toBe(true);
    expect(isCategoryCompatible("standard", "business", false)).toBe(false);
    expect(isCategoryCompatible("business", "van", true)).toBe(false);
    expect(isCategoryCompatible("van", "van", false)).toBe(true);
  });
  it("classification instantanée / planifiée", () => {
    const now = new Date("2026-09-24T10:00:00Z");
    expect(classifyRide(null, now)).toBe("instant");
    expect(classifyRide(new Date("2026-09-24T10:30:00Z"), now)).toBe("instant");
    expect(classifyRide(new Date("2026-09-24T12:00:00Z"), now)).toBe("scheduled");
  });
  it("codes d'erreur métier", () => {
    expect(extractErrorCode("PLAN_LIMIT_DRIVERS: limite de 10 chauffeurs")).toBe("PLAN_LIMIT_DRIVERS");
    expect(humanizeError("FORBIDDEN_TENANT: accès refusé")).toBe("Accès refusé.");
  });
});

describe("géo & tarifs", () => {
  it("haversine Paris → CDG ≈ 25 km", () => {
    const d = haversine({ lat: 48.8698, lng: 2.3075 }, { lat: 49.0047, lng: 2.571 });
    expect(d).toBeGreaterThan(23_000);
    expect(d).toBeLessThan(26_000);
  });
  it("estimation de prix avec minimum et majoration de nuit", () => {
    const rule = {
      vehicle_category: "business" as const, base_fare_cents: 1200, per_km_cents: 220, per_minute_cents: 55,
      minimum_fare_cents: 3500, night_surcharge_percent: 15, night_start: "21:00", night_end: "06:00",
    };
    const { distanceM, durationS } = estimateRoute({ lat: 48.8698, lng: 2.3075 }, { lat: 49.0047, lng: 2.571 });
    const day = estimatePrice(rule, distanceM, durationS, new Date("2026-09-24T12:00:00Z"));
    const night = estimatePrice(rule, distanceM, durationS, new Date("2026-09-24T23:30:00Z"));
    expect(day).toBeGreaterThan(8000);
    expect(night).toBeGreaterThan(day);
    expect(estimatePrice(rule, 500, 120)).toBe(3500);
  });
});

describe("schémas", () => {
  const base = {
    pickup: { address: "12 Avenue des Champs-Élysées, Paris", lat: 48.87, lng: 2.3 },
    dropoff: { address: "Aéroport CDG Terminal 2E" },
    customer: { name: "Client", phone: "06 12 34 56 78" },
  };
  it("API : accepte un payload minimal et applique les valeurs par défaut", () => {
    const parsed = apiRideCreateSchema.parse(base);
    expect(parsed.passengers).toBe(1);
    expect(parsed.vehicle_category).toBe("standard");
    expect(parsed.customer.phone).toBe("+33612345678");
  });
  it("API : refuse organization_id (champ inconnu) — la clé API décide du tenant", () => {
    expect(TENANT_FIELDS).toContain("organization_id");
    const res = apiRideCreateSchema.safeParse({ ...base, organization_id: "x" });
    expect(res.success).toBe(false);
  });
  it("formulaire dashboard : planifiée sans date → erreur", () => {
    const res = rideFormSchema.safeParse({
      pickup: base.pickup, dropoff: base.dropoff, when: "scheduled", customerName: "A", customerPhone: "0612345678",
      passengers: 1, luggage: 0, vehicleCategory: "business", paymentMethod: "card",
    });
    expect(res.success).toBe(false);
  });
});
