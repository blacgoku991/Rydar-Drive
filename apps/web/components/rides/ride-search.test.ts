import { describe, expect, it } from "vitest";
import { rideMatches, rideSearch } from "./ride-search";

// Recherche de l'écran Courses (organisation standard, filtre PostgREST inchangé) et Réservations (Flotte Privée : même
// règle sur les réservations déjà lues).

describe("filtre PostgREST", () => {
  it("« #1678 » : numéro de course seul", () => {
    expect(rideSearch("#1678")).toEqual({ number: 1678 });
    expect(rideSearch("# 42")).toEqual({ number: 42 });
  });

  it("nom : client, téléphone et adresses ; caractères réservés de or() neutralisés", () => {
    expect(rideSearch("Martin")).toEqual({
      or: "customer_name.ilike.%Martin%,customer_phone.ilike.%Martin%,pickup_address.ilike.%Martin%,dropoff_address.ilike.%Martin%",
    });
    const r = rideSearch("Dupont (gare), 50%");
    expect("or" in r && r.or).toBe(
      "customer_name.ilike.%Dupont  gare   50 %,customer_phone.ilike.%Dupont  gare   50 %,pickup_address.ilike.%Dupont  gare   50 %,dropoff_address.ilike.%Dupont  gare   50 %",
    );
  });

  it("nombre court : numéro de course ET adresses (code postal « 75012 »)", () => {
    const r = rideSearch("75012");
    expect("or" in r && r.or.split(",")).toEqual([
      "customer_name.ilike.%75012%",
      "customer_phone.ilike.%75012%",
      "pickup_address.ilike.%75012%",
      "dropoff_address.ilike.%75012%",
      "number.eq.75012",
      "customer_phone.ilike.%75012%",
    ]);
  });

  it("téléphone saisi comme on le lit : comparé au format enregistré (E.164) et par fin de numéro", () => {
    const r = rideSearch("06 12 34 56 78");
    expect("or" in r && r.or.split(",").slice(4)).toEqual(["customer_phone.eq.+33612345678", "customer_phone.ilike.%612345678%"]);
    const intl = rideSearch("+33 6 12 34 56 78");
    expect("or" in intl && intl.or.split(",").slice(4)).toEqual(["customer_phone.eq.+33612345678", "customer_phone.ilike.%33612345678%"]);
  });
});

describe("même recherche sur une réservation déjà lue", () => {
  const ride = {
    number: 1678,
    customer_name: "Mme Durand",
    customer_phone: "+33612345678",
    pickup_address: "Gare de Lyon, 75012 Paris",
    dropoff_address: "Aéroport Charles de Gaulle, 95700 Roissy",
  };

  it("recherche vide : tout ; « #1678 » : numéro exact seulement", () => {
    expect(rideMatches(ride, "  ")).toBe(true);
    expect(rideMatches(ride, "#1678")).toBe(true);
    expect(rideMatches(ride, "#167")).toBe(false);
  });

  it("client et adresses sans tenir compte de la casse ; numéro court ; code postal", () => {
    expect(rideMatches(ride, "durand")).toBe(true);
    expect(rideMatches(ride, "ROISSY")).toBe(true);
    expect(rideMatches(ride, "1678")).toBe(true);
    expect(rideMatches(ride, "75012")).toBe(true);
    expect(rideMatches(ride, "Martin")).toBe(false);
  });

  it("téléphone : format lu, international ou fin de numéro", () => {
    expect(rideMatches(ride, "06 12 34 56 78")).toBe(true);
    expect(rideMatches(ride, "06.12.34.56.78")).toBe(true);
    expect(rideMatches(ride, "+33 6 12 34 56 78")).toBe(true);
    expect(rideMatches(ride, "5678")).toBe(true);
    expect(rideMatches(ride, "07 12 34 56 78")).toBe(false);
    expect(rideMatches({ number: 1, customer_phone: null }, "0612345678")).toBe(false);
  });
});
