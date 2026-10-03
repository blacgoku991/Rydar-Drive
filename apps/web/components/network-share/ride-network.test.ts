import { describe, expect, it } from "vitest";
import {
  NETWORK_DONE_LOCK_MESSAGE, NETWORK_LOCK_MESSAGE, checkLines, clientReadsText, dayLabel, givenItemOf, liveNetworkLabel, liveNetworkLock,
  livePartner, networkLockMessage, networkRidesOrFilter, partnerOrgOf, partnerTag, proposedToNetwork, rideListNetworkCell, rideNetworkActions,
  rideTouchesNetwork, shareSummary, suspectLabels,
} from "./ride-network";
import { DRIVER, ORG_A, ORG_B, givenItem, orgNetworkRide } from "./test-fixtures";

// Fiche course d'une course confiée (A) : quand lire org_network_ride, montants verrouillés, actions.

const own = { organization_id: ORG_A, driver_id: DRIVER, driver_org_id: ORG_A, network_at: null, status: "ACCEPTED" };
const partner = { ...own, driver_org_id: ORG_B, network_at: "2026-09-20T08:55:00.000Z" };
const TZ = "Europe/Paris";

describe("course partagée ou non", () => {
  it("course propre (ou jamais passée par le réseau) : rien ne change, aucune lecture réseau", () => {
    expect(partnerOrgOf(own, ORG_A)).toBeNull();
    expect(rideTouchesNetwork(own, ORG_A, ["dispatch.started", "offer.accepted"])).toBe(false);
    expect(networkLockMessage(own, ORG_A)).toBeNull();
    // Réseau jamais ouvert : colonnes absentes (undefined) → même chose
    expect(rideTouchesNetwork({ status: "SEARCHING_DRIVER", driver_id: null }, ORG_A)).toBe(false);
  });

  it("tenue par un chauffeur partenaire, proposée au réseau ou passée par le réseau (journal)", () => {
    expect(partnerOrgOf(partner, ORG_A)).toBe(ORG_B);
    expect(rideTouchesNetwork(partner, ORG_A)).toBe(true);
    expect(rideTouchesNetwork({ ...own, driver_id: null, driver_org_id: null, network_at: "2026-09-20T08:55:00.000Z", status: "SEARCHING_DRIVER" }, ORG_A)).toBe(true);
    // Partenaire retiré puis course reprise par un chauffeur propre : l'historique du partage reste lisible
    expect(rideTouchesNetwork(own, ORG_A, ["dispatch.network"])).toBe(true);
    expect(rideTouchesNetwork(own, ORG_A, ["dispatch.network_skipped"])).toBe(true);
  });

  it("« Proposée au réseau » seulement pendant la recherche, sans chauffeur", () => {
    expect(proposedToNetwork({ driver_id: null, network_at: "2026-09-20T08:55:00Z", status: "SEARCHING_DRIVER" })).toBe(true);
    expect(proposedToNetwork({ driver_id: DRIVER, network_at: "2026-09-20T08:55:00Z", status: "ACCEPTED" })).toBe(false);
    expect(proposedToNetwork({ driver_id: null, network_at: null, status: "SEARCHING_DRIVER" })).toBe(false);
    expect(proposedToNetwork({ driver_id: null, network_at: "2026-09-20T08:55:00Z", status: "NO_DRIVER_FOUND" })).toBe(false);
  });

  it("étiquette « Réseau · {B} »", () => {
    expect(partnerTag("Flotte B")).toBe("Réseau · Flotte B");
    expect(partnerTag(null)).toBe("Réseau partagé");
  });
});

describe("montants et adresses verrouillés (garde G6)", () => {
  it("tant qu'un partenaire tient la course : « retirez-la au partenaire pour la modifier »", () => {
    for (const status of ["ACCEPTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS"]) {
      expect(networkLockMessage({ ...partner, status }, ORG_A), status).toBe(NETWORK_LOCK_MESSAGE);
    }
    expect(NETWORK_LOCK_MESSAGE).toBe("Course confiée : retirez-la au partenaire pour la modifier.");
  });

  it("terminée par le partenaire : figée ; annulée : plus rien à modifier ici", () => {
    expect(networkLockMessage({ ...partner, status: "COMPLETED" }, ORG_A)).toBe(NETWORK_DONE_LOCK_MESSAGE);
    expect(networkLockMessage({ ...partner, status: "CANCELLED" }, ORG_A)).toBeNull();
    // Retirée au partenaire (chauffeur vidé) : de nouveau modifiable
    expect(networkLockMessage({ ...partner, driver_id: null, driver_org_id: null, status: "SEARCHING_DRIVER" }, ORG_A)).toBeNull();
  });
});

describe("bloc « Réseau partagé »", () => {
  it("état du partage en clair, compteur de partenaires seulement", () => {
    const open = shareSummary({ status: "open", cycle: 1, stage: "instant", opened_at: "2026-09-20T08:55:00.000Z", partners_offered: 3, closed_at: null, closed_reason: null }, TZ);
    expect(open.label).toBe("Proposée au réseau partagé");
    expect(open.tone).toBe("violet");
    expect(open.detail).toBe("depuis 10:55 · 3 chauffeurs partenaires sollicités · vos chauffeurs restent prioritaires");
    const closed = shareSummary(
      { status: "closed", cycle: 2, stage: "instant", opened_at: "2026-09-20T08:55:00.000Z", partners_offered: 1, closed_at: "2026-09-20T09:05:00.000Z", closed_reason: "removed_by_giver" },
      TZ,
    );
    expect(closed.detail).toBe("Retirée au partenaire · à 11:05 · 1 chauffeur partenaire sollicité");
  });

  it("contrôles figés : n° de carte, échéances (dates sans fuseau), échéance dépassée à la prise en charge signalée", () => {
    const data = orgNetworkRide();
    const lines = checkLines(data.execution!.checks, "2027-01-15T08:00:00.000Z");
    expect(lines.map((l) => [l.label, l.value, l.expired])).toEqual([
      ["N° de carte VTC", "VTC-075-123456", false],
      ["Carte VTC", "valable jusqu'au 31/03/2027", false],
      ["Assurance", "valable jusqu'au 31/12/2026", true],
      ["Carte grise", "sans échéance", false],
      ["Permis de conduire", "valable jusqu'au 01/01/2030", false],
    ]);
    expect(dayLabel("2026-02-03")).toBe("03/02/2026");
    expect(dayLabel(null)).toBeNull();
  });

  it("lectures des coordonnées du client et raisons « à vérifier »", () => {
    expect(clientReadsText({ reads: 0, first_read_at: null, last_read_at: null }, TZ)).toBe("Coordonnées du client pas encore consultées par le chauffeur.");
    expect(clientReadsText({ reads: 3, first_read_at: "2026-09-20T08:31:00.000Z", last_read_at: "2026-09-20T09:02:00.000Z" }, TZ)).toBe(
      "Coordonnées du client consultées 3 fois par le chauffeur (première à 10:31, dernière à 11:02).",
    );
    expect(suspectLabels(["no_gps", "closed_by_giver"])).toEqual(["Position absente pendant la course", "Clôturée par l'organisation"]);
  });
});

describe("actions de la fiche", () => {
  const now = Date.parse("2026-09-21T10:00:00.000Z");

  it("élément « Courses confiées » reconstruit (sans téléphone ni contrôles) pour réutiliser Reçu / Versé / Valider", () => {
    const g = givenItem();
    const item = givenItemOf(g.ride, orgNetworkRide(g))!;
    expect(item.execution.id).toBe(g.execution.id);
    expect("driver_phone" in item.execution).toBe(false);
    expect("checks" in item.execution).toBe(false);
    expect(item.settlement?.id).toBe(g.settlement?.id);
    expect(givenItemOf(g.ride, orgNetworkRide(g, { execution: null }))).toBeNull();
  });

  it("la base a le dernier mot pour Retirer, Clôturer, Valider, Contester et les exclusions", () => {
    const g = givenItem({ payment: "cash", status: "IN_PROGRESS", settlement: null });
    const data = orgNetworkRide(g, { can: { remove: true, close: true, validate: false, contest: false, exclude_driver: true, exclude_partner: false } });
    const a = rideNetworkActions(givenItemOf(g.ride, data), data, { canManage: true, now });
    expect(a.remove).toBe(true);
    expect(a.close).toBe(true);
    expect(a.contest).toBe(false);
    expect(a.excludeDriver).toBe(true);
    expect(a.excludePartner).toBe(false);
    // Course en cours : aucun règlement encore, donc ni Reçu ni Versé
    expect(a.confirm || a.payout || a.dispute).toBe(false);
  });

  it("dispatcher : Retirer si la base le permet, jamais l'argent ni Clôturer", () => {
    const g = givenItem({ payment: "cash" });
    const data = orgNetworkRide(g, { can: { remove: true, close: true, validate: true, contest: true, exclude_driver: true, exclude_partner: true } });
    const a = rideNetworkActions(givenItemOf(g.ride, data), data, { canManage: false, now });
    expect(a.remove).toBe(true);
    expect([a.close, a.confirm, a.dispute, a.waive, a.payout, a.validate, a.contest, a.excludeDriver, a.excludePartner].some(Boolean)).toBe(false);
    expect(a.remind).toBe(true);
  });

  it("owner / admin, course terminée payée à bord : Reçu, Pas reçu, Contester", () => {
    const g = givenItem({ payment: "cash" });
    const data = orgNetworkRide(g);
    const a = rideNetworkActions(givenItemOf(g.ride, data), data, { canManage: true, now });
    expect(a.confirm && a.dispute && a.contest).toBe(true);
    expect(a.remove || a.close).toBe(false);
  });
});

describe("En direct (A)", () => {
  const partners = { [ORG_B]: "Flotte B" };

  it("instantané : chauffeur d'une autre organisation → « Réseau · Flotte B »", () => {
    expect(livePartner(partner, ORG_A)).toEqual({ held: true, orgId: ORG_B });
    expect(liveNetworkLabel(partner, ORG_A, partners)).toBe("Réseau · Flotte B");
    expect(liveNetworkLabel(partner, ORG_A, {})).toBe("Réseau partagé");
  });

  it("diffusion : chauffeur masqué (driver_id null, network: true) → toujours partenaire", () => {
    const broadcast = { ...partner, driver_id: null, network: true };
    expect(livePartner(broadcast, ORG_A).held).toBe(true);
    expect(liveNetworkLock(broadcast, ORG_A)).toBe(NETWORK_LOCK_MESSAGE);
    expect(liveNetworkLock({ ...broadcast, status: "COMPLETED" }, ORG_A)).toBe(NETWORK_DONE_LOCK_MESSAGE);
  });

  it("course propre ou recherche : rien, ou « proposée au réseau partagé »", () => {
    expect(liveNetworkLabel(own, ORG_A, partners)).toBeNull();
    expect(liveNetworkLock(own, ORG_A)).toBeNull();
    expect(liveNetworkLabel({ ...own, driver_id: null, driver_org_id: null, network_at: "2026-09-20T08:55:00Z", status: "SEARCHING_DRIVER" }, ORG_A, partners)).toBe(
      "proposée au réseau partagé",
    );
    // Organisation inconnue côté client (hors tableau de bord) : jamais d'étiquette inventée
    expect(livePartner(partner, null)).toEqual({ held: false, orgId: null });
  });
});

describe("liste des courses", () => {
  it("filtre « Réseau partagé » : proposée au réseau OU chauffeur d'une autre organisation", () => {
    expect(networkRidesOrFilter(ORG_A)).toBe(`network_at.not.is.null,driver_org_id.neq.${ORG_A}`);
    expect(networkRidesOrFilter("x),id.neq.(y")).toBeNull();
  });

  it("colonne Chauffeur : « Réseau · Flotte B », « Proposée au réseau », sinon rien (chauffeur propre)", () => {
    expect(rideListNetworkCell(partner, ORG_A, { [ORG_B]: "Flotte B" })).toBe("Réseau · Flotte B");
    expect(rideListNetworkCell({ ...partner, status: "COMPLETED" }, ORG_A, null)).toBe("Réseau partagé");
    expect(rideListNetworkCell({ ...own, driver_id: null, driver_org_id: null, network_at: "2026-09-20T08:55:00Z", status: "OFFERED" }, ORG_A, null)).toBe("Proposée au réseau");
    expect(rideListNetworkCell(own, ORG_A, null)).toBeNull();
  });
});
