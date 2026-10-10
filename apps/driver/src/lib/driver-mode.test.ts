// Détection de la Flotte Privée et de la fiche du gérant (docs/FLOTTE-PRIVEE.md § 10.2) : clé absente = standard.
import { describe, expect, it } from "vitest";
import { driverMode, earningsMoney, moneyModel, unconfirmedBookingId } from "./driver-mode";
import { rideMoneyView, type AppRide } from "./network";

const home = (privateFleet?: boolean, ownerDriver?: boolean) => ({
  organization: privateFleet === undefined ? {} : { private_fleet: privateFleet },
  driver: ownerDriver === undefined ? {} : { owner_driver: ownerDriver },
});

describe("driverMode", () => {
  it("serveur antérieur (clés absentes) : organisation standard, fiche ordinaire", () => {
    expect(driverMode(home(), {})).toEqual({ privateFleet: false, ownerDriver: false });
    expect(driverMode(null, null)).toEqual({ privateFleet: false, ownerDriver: false });
    expect(driverMode(null, { organization: {} })).toEqual({ privateFleet: false, ownerDriver: false });
  });

  it("Flotte Privée lue sur l'accueil ; fiche du gérant", () => {
    expect(driverMode(home(true, true), null)).toEqual({ privateFleet: true, ownerDriver: true });
    expect(driverMode(home(false, true), null)).toEqual({ privateFleet: false, ownerDriver: true });
  });

  it("accueil illisible (compte en attente, suspendu) : état du compte", () => {
    expect(driverMode(null, { organization: { private_fleet: true } })).toEqual({ privateFleet: true, ownerDriver: false });
  });

  it("l'accueil prime : sortie de la Flotte Privée vue dès sa relecture, avant celle de l'état du compte", () => {
    expect(driverMode(home(false), { organization: { private_fleet: true } }).privateFleet).toBe(false);
    expect(driverMode(home(true), { organization: { private_fleet: false } }).privateFleet).toBe(true);
  });
});

describe("moneyModel", () => {
  it("fiche du gérant : jamais de commission (comme une flotte) ; sinon le modèle de l'organisation", () => {
    expect(moneyModel("centrale", true)).toBe("fleet");
    expect(moneyModel("centrale", false)).toBe("centrale");
    expect(moneyModel("fleet", false)).toBe("fleet");
    expect(moneyModel(undefined, false)).toBeUndefined();
  });
});

describe("earningsMoney (Mes gains)", () => {
  // driver_earnings d'une Flotte Privée dont le taux de commission chauffeur est resté à 20 % : commission_percent 20,
  // net de 80 € pour une course de 100 € de la fiche du gérant
  it("fiche du gérant : ni « Net estimé — Après commission de X % », ni « net … » par course, ni part — même en centrale", () => {
    const priceOnly = { centrale: false, commissionPercent: null, rideNet: false };
    expect(earningsMoney({ model: "fleet", commission_percent: 20 }, true)).toEqual(priceOnly);
    expect(earningsMoney({ model: "centrale", commission_percent: 20 }, true)).toEqual(priceOnly);
  });

  it("autres chauffeurs : taux de commission de la flotte et net par course ; centrale : sa part", () => {
    expect(earningsMoney({ model: "fleet", commission_percent: 20 }, false)).toEqual({ centrale: false, commissionPercent: 20, rideNet: true });
    expect(earningsMoney({ model: "centrale", commission_percent: 25 }, false)).toEqual({ centrale: true, commissionPercent: 25, rideNet: true });
    expect(earningsMoney({ model: "fleet", commission_percent: null }, false)).toEqual({ centrale: false, commissionPercent: null, rideNet: true });
    expect(earningsMoney(null, false)).toEqual({ centrale: false, commissionPercent: null, rideNet: true });
  });
});

describe("argent d'une course de la fiche du gérant (Flotte Privée passée en centrale)", () => {
  const money: AppRide["money"] = {
    price_cents: 5_000, currency: "EUR", payment_method: "cash", collects: true, driver_part_cents: 3_750, giver_part_cents: 1_250,
    direction: "driver_owes", amount_cents: 1_250, counterparty: null, creditor_name: "Taxi Martin",
  };

  it("course propre : le prix, jamais « votre part » ni commission (aucun règlement, 20260924007700)", () => {
    expect(rideMoneyView({ money, network: null, currency: "EUR" }, { ownerDriver: true })).toEqual({ kind: "plain", currency: "EUR" });
    expect(rideMoneyView({ money, network: null, currency: "EUR" })).toMatchObject({ kind: "centrale", gainCents: 3_750, deductionCents: 1_250 });
  });

  it("course partenaire (réseau partagé) : affichage partenaire inchangé", () => {
    const network = {
      execution_id: "e1",
      giver: { name: "Taxi Alpha", legal_name: null, vtc_registration: null, phone: null, phone_until: null },
    } as AppRide["network"];
    expect(rideMoneyView({ money, network, currency: "EUR" }, { ownerDriver: true })).toMatchObject({ kind: "partner", gainCents: 3_750 });
  });
});

describe("unconfirmedBookingId", () => {
  it("réservation non confirmée ou à vérifier : booking_id (jamais ride_id)", () => {
    expect(unconfirmedBookingId({ type: "ride_unconfirmed", reason: "not_confirmed", booking_id: "b-1", number: 1042 })).toBe("b-1");
    expect(unconfirmedBookingId({ type: "ride_unconfirmed", reason: "to_check", booking_id: " b-2 " })).toBe("b-2");
  });

  it("autre notification, ou réservation non précisée : rien", () => {
    expect(unconfirmedBookingId({ type: "ride_cancelled", booking_id: "b-1", ride_id: "r-1" })).toBeNull();
    expect(unconfirmedBookingId({ type: "ride_unconfirmed" })).toBeNull();
    expect(unconfirmedBookingId({ type: "ride_unconfirmed", booking_id: 42 })).toBeNull();
  });
});
