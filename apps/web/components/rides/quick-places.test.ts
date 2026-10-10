import { describe, expect, it } from "vitest";
import { inIleDeFrance, isAirport, quickPlaces } from "../../lib/places";

// « Nouvelle course » : raccourcis d'adresses parisiens seulement pour une flotte d'Île-de-France ; repli « Ajouter un
// vol, un e-mail ou une note » ouvert d'office pour un aéroport.
describe("Nouvelle course : raccourcis d'adresses et aéroports", () => {
  it("raccourcis seulement en Île-de-France, libellés courts sans « Aéroport » ni « d' »", () => {
    const paris = quickPlaces({ lat: 48.8566, lng: 2.3522 });
    expect(paris.map((p) => p.short)).toEqual(["CDG — Terminal 2E", "Orly — Terminal 4", "Gare de Lyon", "Gare du Nord", "La Défense — Parvis"]);
    expect(paris.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.address.length > 0)).toBe(true);
    // Versailles, Roissy, Melun : Île-de-France
    for (const p of [{ lat: 48.8049, lng: 2.1204 }, { lat: 49.0097, lng: 2.5479 }, { lat: 48.5394, lng: 2.6608 }]) expect(inIleDeFrance(p)).toBe(true);
    // Nice, Lyon, Lille, Rouen, Beauvais, aucun centre connu : rien
    for (const p of [{ lat: 43.7102, lng: 7.262 }, { lat: 45.764, lng: 4.8357 }, { lat: 50.6292, lng: 3.0573 }, { lat: 49.4431, lng: 1.0993 }, { lat: 49.4544, lng: 2.1128 }]) {
      expect(quickPlaces(p)).toEqual([]);
    }
    expect(quickPlaces(null)).toEqual([]);
    expect(quickPlaces(undefined)).toEqual([]);
  });

  it("aéroport au départ ou à l'arrivée", () => {
    expect(isAirport("Aéroport de Paris-Orly, Terminal 4, 94390 Orly", "")).toBe(true);
    expect(isAirport("12 rue de Rivoli, 75001 Paris", "Aeroport Nice Côte d'Azur")).toBe(true);
    expect(isAirport("CDG T2E", null)).toBe(true);
    expect(isAirport("Gare de Lyon, Paris", "Opéra Garnier")).toBe(false);
    expect(isAirport(undefined, null, "")).toBe(false);
  });
});
