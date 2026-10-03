import { formatPrice } from "@rydar/shared";
import { describe, expect, it } from "vitest";
import { driverShortLabel, receivedMoneyLine, receivedRoute, receivedState, showReceivedTab, sinceText } from "./received";
import { givenItem, receivedFromGiven } from "./test-fixtures";

// « Courses reçues » (B) : lecture seule — communes, chauffeur, prix et part du chauffeur, état du règlement entre le
// chauffeur et l'organisation qui confie. Jamais le client ni l'adresse exacte.

const item = (o: Parameters<typeof givenItem>[0] = {}) => receivedFromGiven(givenItem(o), "Taxi A");

describe("état du règlement vu par l'organisation du chauffeur", () => {
  it("payée à bord : à reverser, en retard, payé à confirmer, reversé, non reçu (libellés courts : l'organisation a sa colonne)", () => {
    expect(receivedState(item({ payment: "cash" }))).toEqual({ label: "À reverser", tone: "amber" });
    expect(receivedState(item({ payment: "cash", overdue: true }))).toEqual({ label: "Reversement en retard", tone: "red" });
    expect(receivedState(item({ payment: "cash", settlement: "declared" }))).toEqual({ label: "Payé, à confirmer", tone: "blue" });
    expect(receivedState(item({ payment: "cash", settlement: "paid" }))).toEqual({ label: "Reversé", tone: "green" });
    expect(receivedState(item({ payment: "cash", settlement: "disputed" }))).toEqual({ label: "Non reçu", tone: "red" });
  });

  it("déjà payée : versement attendu, retenu (à vérifier), versé, annulé", () => {
    expect(receivedState(item({ payment: "online" }))).toEqual({ label: "Versement attendu", tone: "violet" });
    expect(receivedState(item({ payment: "online", onHold: true }))).toEqual({ label: "Retenu : à vérifier", tone: "amber" });
    expect(receivedState(item({ payment: "online", settlement: "paid" }))).toEqual({ label: "Versé au chauffeur", tone: "green" });
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
    expect(receivedMoneyLine(item({ payment: "cash" }))).toBe(`Payée à bord · le chauffeur reverse ${formatPrice(1250)}`);
    expect(receivedMoneyLine(item({ payment: "online" }))).toBe(`Déjà payée · le chauffeur reçoit ${formatPrice(3750)}`);
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

describe("« En course partenaire maintenant » : durée écoulée", () => {
  const now = Date.parse("2026-10-03T10:00:00.000Z");
  it("jamais « depuis à l'instant » : moins d'1 min, minutes, heures, jours", () => {
    expect(sinceText("2026-10-03T09:59:40.000Z", now)).toBe("depuis moins d'1\u00a0min");
    expect(sinceText("2026-10-03T10:00:30.000Z", now)).toBe("depuis moins d'1\u00a0min"); // horloge en avance
    expect(sinceText("2026-10-03T09:48:00.000Z", now)).toBe("depuis 12\u00a0min");
    expect(sinceText("2026-10-03T08:00:00.000Z", now)).toBe("depuis 2\u00a0h");
    expect(sinceText("2026-10-01T10:00:00.000Z", now)).toBe("depuis 2\u00a0j");
    expect(sinceText("pas une date", now)).toBe("");
  });
});
