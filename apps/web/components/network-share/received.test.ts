import { formatPrice } from "@rydar/shared";
import { describe, expect, it } from "vitest";
import { driverShortLabel, receivedMoneyLine, receivedRoute, receivedState, showReceivedTab } from "./received";
import { givenItem, receivedFromGiven } from "./test-fixtures";

// « Courses reçues » (B) : lecture seule — communes, chauffeur, prix et part du chauffeur, état du règlement entre le
// chauffeur et l'organisation qui confie. Jamais le client ni l'adresse exacte.

const item = (o: Parameters<typeof givenItem>[0] = {}) => receivedFromGiven(givenItem(o), "Taxi A");

describe("état du règlement vu par l'organisation du chauffeur", () => {
  it("payée à bord : à reverser, en retard, payé à confirmer, reversé, non reçu", () => {
    expect(receivedState(item({ payment: "cash" }))).toEqual({ label: "À reverser à Taxi A", tone: "amber" });
    expect(receivedState(item({ payment: "cash", overdue: true }))).toEqual({ label: "Reversement en retard", tone: "red" });
    expect(receivedState(item({ payment: "cash", settlement: "declared" }))).toEqual({ label: "Payé, à confirmer par Taxi A", tone: "blue" });
    expect(receivedState(item({ payment: "cash", settlement: "paid" }))).toEqual({ label: "Reversé à Taxi A", tone: "green" });
    expect(receivedState(item({ payment: "cash", settlement: "disputed" }))).toEqual({ label: "Non reçu par Taxi A", tone: "red" });
  });

  it("déjà payée : à verser par A, retenu (à vérifier), versé, annulé", () => {
    expect(receivedState(item({ payment: "online" }))).toEqual({ label: "À verser par Taxi A", tone: "violet" });
    expect(receivedState(item({ payment: "online", onHold: true }))).toEqual({ label: "Retenu : course à vérifier", tone: "amber" });
    expect(receivedState(item({ payment: "online", settlement: "paid" }))).toEqual({ label: "Versé par Taxi A", tone: "green" });
    expect(receivedState(item({ payment: "online", settlement: "waived" }))).toEqual({ label: "Annulé", tone: "neutral" });
  });

  it("sans règlement : étape de la course ou fin d'exécution", () => {
    expect(receivedState(item({ status: "PASSENGER_ONBOARD" }))).toEqual({ label: "À bord", tone: "cyan" });
    expect(receivedState(item({ status: "SEARCHING_DRIVER", endedAt: "2026-09-20T09:40:00.000Z", endReason: "removed_by_giver", settlement: null }))).toEqual({
      label: "Retirée au chauffeur",
      tone: "neutral",
    });
  });
});

describe("textes de la ligne", () => {
  it("une seule ligne d'argent, communes seulement", () => {
    expect(receivedMoneyLine(item({ payment: "cash" }))).toBe(`Payée à bord · le chauffeur reverse ${formatPrice(1250)} à Taxi A`);
    expect(receivedMoneyLine(item({ payment: "online" }))).toBe(`Déjà payée · Taxi A verse ${formatPrice(3750)} au chauffeur`);
    expect(receivedRoute(item())).toBe("75011 Paris → Orly");
    expect(receivedRoute({ ...item(), ride: { ...item().ride, pickup_area: null, dropoff_area: null } })).toBe("Départ non précisé → Arrivée non précisée");
  });

  it("libellé court du chauffeur identique à celui de l'organisation qui confie", () => {
    expect(driverShortLabel({ first_name: "Karim", last_name: "benali" })).toBe("Karim B.");
    expect(driverShortLabel({ first_name: "Karim", last_name: "" })).toBe("Karim");
    expect(driverShortLabel(null)).toBe("Chauffeur supprimé");
  });
});

describe("onglet « Courses reçues »", () => {
  it("masqué si la réception est coupée et sans historique, visible sinon", () => {
    expect(showReceivedTab({ shareIn: false, inProgress: 0, monthRides: 0, totalRides: 0 })).toBe(false);
    expect(showReceivedTab({ shareIn: false, inProgress: 0, monthRides: 0, totalRides: null })).toBe(false);
    expect(showReceivedTab({ shareIn: true, inProgress: 0, monthRides: 0, totalRides: 0 })).toBe(true);
    expect(showReceivedTab({ shareIn: false, inProgress: 0, monthRides: 0, totalRides: 3 })).toBe(true);
    expect(showReceivedTab({ shareIn: false, inProgress: 1, monthRides: 0, totalRides: null })).toBe(true);
  });
});
