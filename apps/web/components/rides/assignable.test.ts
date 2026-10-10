import { describe, expect, it } from "vitest";
import { ASSIGN_SEARCH_MIN, assignGroup, assignableDrivers, groupAssignable, matchesAssignable, type AssignableSource } from "./assignable";

// Départ : Opéra (Paris 9e)
const ride = { driver_id: "d-course", pickup_lat: 48.8719, pickup_lng: 2.3316 };

function driver(id: string, extra: Partial<AssignableSource> = {}): AssignableSource {
  return {
    id,
    number: Number(id.replace(/\D/g, "")) || 1,
    first_name: `Prénom${id}`,
    last_name: "Test",
    status: "active",
    presence: "available",
    vehicle: { model: "Classe E", plate: "AB-123-CD", category: "business" },
    location: null,
    ...extra,
  };
}

/** Positions de plus en plus loin du départ (≈ 110 m par millième de degré de latitude). */
const at = (dLat: number) => ({ lat: ride.pickup_lat + dLat, lng: ride.pickup_lng });

describe("chauffeurs attribuables (fiche course et En direct)", () => {
  it("garde tous les chauffeurs actifs sauf celui de la course, hors ligne compris (aucun retiré)", () => {
    const drivers = [
      driver("d1"),
      driver("d2", { presence: "offline" }),
      driver("d3", { presence: "on_trip" }),
      driver("d-course"),
      driver("d4", { status: "inactive" }),
      driver("d5", { status: "suspended", presence: "available" }),
      driver("d6", { presence: "inconnue" }),
    ];
    const list = assignableDrivers(drivers, ride);
    expect(list.map((d) => d.id).sort()).toEqual(["d1", "d2", "d3", "d6"]);
    // Présence inconnue : rangée hors ligne, jamais retirée
    expect(list.find((d) => d.id === "d6")!.presence).toBe("offline");
    // Chaque chauffeur gardé apparaît une fois et une seule dans les groupes
    const groups = groupAssignable(list);
    expect([...groups.available, ...groups.busy, ...groups.offline].map((d) => d.id).sort()).toEqual(["d1", "d2", "d3", "d6"]);
  });

  it("trois groupes : disponibles, occupés (proposée, en route, arrivé, en course), hors ligne", () => {
    expect(assignGroup("available")).toBe("available");
    for (const p of ["offered", "en_route", "arrived", "on_trip"] as const) expect(assignGroup(p)).toBe("busy");
    expect(assignGroup("offline")).toBe("offline");
    const groups = groupAssignable(
      assignableDrivers(
        [driver("d1", { presence: "offered" }), driver("d2"), driver("d3", { presence: "offline" }), driver("d4", { presence: "arrived" })],
        ride,
      ),
    );
    expect(groups.available.map((d) => d.id)).toEqual(["d2"]);
    expect(groups.busy.map((d) => d.id).sort()).toEqual(["d1", "d4"]);
    expect(groups.offline.map((d) => d.id)).toEqual(["d3"]);
  });

  it("dans chaque groupe : du plus proche au plus loin, sans position à la fin, puis par nom", () => {
    const list = assignableDrivers(
      [
        driver("d1", { location: at(0.03) }),
        driver("d2", { location: at(0.002) }),
        driver("d3"),
        driver("d4", { location: at(0.01), presence: "offline" }),
        driver("d5", { location: at(0.001), presence: "offline" }),
        driver("d6", { first_name: "Alice" }),
      ],
      ride,
    );
    expect(list.map((d) => d.id)).toEqual(["d2", "d1", "d6", "d3", "d5", "d4"]);
    const near = list[0]!;
    expect(near.distance_m).toBeGreaterThan(200);
    expect(near.distance_m).toBeLessThan(240);
    expect(Number.isInteger(near.distance_m)).toBe(true);
    expect(list.find((d) => d.id === "d3")!.distance_m).toBeNull();
  });

  it("véhicule : modèle · plaque · catégorie, ou « Sans véhicule »", () => {
    const list = assignableDrivers([driver("d1"), driver("d2", { vehicle: null, location: at(0.5) })], ride);
    const a = list.find((d) => d.id === "d1");
    const b = list.find((d) => d.id === "d2");
    expect(a!.vehicle).toBe("Classe E · AB-123-CD · Business");
    expect(a!.plate).toBe("AB-123-CD");
    expect(b!.vehicle).toBe("Sans véhicule");
    expect(b!.plate).toBeNull();
    expect(a!.name).toBe("Prénomd1 Test");
  });

  it("recherche « Nom, plaque » : nom sans accents ni casse, plaque sans tirets, numéro", () => {
    const [d] = assignableDrivers([driver("d12", { first_name: "Hélène", last_name: "Durand", vehicle: { model: "Model 3", plate: "GR-118-ZT", category: "green" } })], ride);
    expect(matchesAssignable(d!, "helene")).toBe(true);
    expect(matchesAssignable(d!, "DURAND")).toBe(true);
    expect(matchesAssignable(d!, "gr118")).toBe(true);
    expect(matchesAssignable(d!, "GR-118-ZT")).toBe(true);
    expect(matchesAssignable(d!, "#12")).toBe(true);
    expect(matchesAssignable(d!, "12")).toBe(true);
    expect(matchesAssignable(d!, "Karim")).toBe(false);
    expect(matchesAssignable(d!, "  ")).toBe(true);
    const groups = groupAssignable([d!], "karim");
    expect(groups.available.length + groups.busy.length + groups.offline.length).toBe(0);
  });

  it("champ de recherche à partir de 8 chauffeurs", () => {
    expect(ASSIGN_SEARCH_MIN).toBe(8);
  });
});
