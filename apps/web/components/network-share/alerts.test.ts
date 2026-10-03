import { describe, expect, it } from "vitest";
import { acceptedBy, networkProposedAlert, networkSettlementLink, noDriverNetworkLine } from "./alerts";

// Alertes du rattacheur : réseau partagé en information, « aucun chauffeur » qui mentionne le réseau, acceptation
// par un chauffeur partenaire (libellé court seulement), règlements des courses confiées vers « Réseau partagé ».

describe("alertes du réseau partagé", () => {
  it("acceptation : chauffeur propre inchangé, chauffeur partenaire reconnu", () => {
    expect(acceptedBy("Karim accepte")).toEqual({ who: "Karim", network: false });
    expect(acceptedBy("Karim B. (Flotte B) accepte — chauffeur du réseau partagé")).toEqual({ who: "Karim B. (Flotte B)", network: true });
    expect(acceptedBy("Karim B. (Flotte B) accepte", { network: true })).toEqual({ who: "Karim B. (Flotte B)", network: true });
    expect(acceptedBy("", null)).toEqual({ who: "Un chauffeur", network: false });
  });

  it("course proposée au réseau : information, compteur de partenaires seulement", () => {
    expect(networkProposedAlert({ data: { partners_nearby: 2 } }, { label: "#1783", route: "Bastille → Orly" })).toEqual({
      title: "Course #1783 proposée au réseau partagé",
      body: "Aucun de vos chauffeurs n'a accepté · 2 chauffeurs partenaires à proximité · Bastille → Orly",
    });
    expect(networkProposedAlert({ data: null }, { label: "", route: "" })).toEqual({
      title: "Course proposée au réseau partagé",
      body: "Aucun de vos chauffeurs n'a accepté",
    });
    // Planifiée dans la fenêtre réseau (006800 : stage « scheduled_window ») : proposée en plus à la flotte
    expect(networkProposedAlert({ data: { partners_nearby: 1, stage: "scheduled_window" } }, { label: "#1790", route: "Opéra → CDG" })).toEqual({
      title: "Planifiée #1790 proposée aussi au réseau partagé",
      body: "Toujours sans chauffeur · 1 chauffeur partenaire à proximité · Opéra → CDG",
    });
  });

  it("aucun chauffeur : mention du réseau (donnée, sinon message complété par le SQL)", () => {
    expect(noDriverNetworkLine({ message: "Personne n'a accepté la course (4 → 8 km)", data: {} })).toBeNull();
    expect(noDriverNetworkLine({ message: "Personne n'a accepté la course (4 → 8 km), réseau partagé : 3 chauffeurs partenaires sollicités" })).toBe(
      "Réseau partagé : 3 chauffeurs partenaires sollicités",
    );
    // Données du SQL (006800) : { waves, last_radius_m, closed_offers, network: true, partners_offered }
    expect(noDriverNetworkLine({ message: "", data: { network: true, partners_offered: 1 } })).toBe("Réseau partagé : 1 chauffeur partenaire sollicité");
    expect(noDriverNetworkLine({ message: "", data: { network: true, partners_offered: 0 } })).toBe("Réseau partagé : aucun chauffeur partenaire disponible");
    // Partage arrêté après trois erreurs (C8) : network sans compteur, jamais de détail technique
    expect(
      noDriverNetworkLine({ message: "Personne n'a accepté la course (réseau partagé interrompu par des erreurs) — attribuez-la ou relancez", data: { network: true } }),
    ).toBe("Réseau partagé interrompu");
  });

  it("règlement d'une course confiée : « Réseau partagé › Courses confiées », jamais Encaissements", () => {
    expect(networkSettlementLink("declared", "driver_owes")).toEqual({ href: "/dashboard/reseau-partage?tab=confiees&filtre=to_confirm", cta: "Réseau partagé" });
    expect(networkSettlementLink("created", "centrale_owes").href).toBe("/dashboard/reseau-partage?tab=confiees&filtre=to_pay");
    // Payée à bord : « À encaisser » (et non toute la liste) ; sous-onglet toujours explicite
    expect(networkSettlementLink("created", "driver_owes").href).toBe("/dashboard/reseau-partage?tab=confiees&filtre=to_collect");
  });
});
