import { describe, expect, it } from "vitest";
import { acceptedBy, networkProposedAlert, networkRideAlert, networkSettlementLink, noDriverNetworkLine } from "./alerts";

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
    // Compteur plafonné à 50 par la base (20260924007200) : « 50 ou plus »
    expect(networkProposedAlert({ data: { partners_nearby: 50 } }, { label: "#1784", route: "" }).body).toBe(
      "Aucun de vos chauffeurs n'a accepté · 50 chauffeurs partenaires ou plus à proximité",
    );
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

  it("événements réseau d'une course confiée : indisponible (clôture), rendue (relance), clôturée ; rien sinon", () => {
    const ride = { label: "#1783", route: "Bastille → Orly" };
    expect(networkRideAlert({ type: "network.executor_unavailable", data: { cause: "executor_inactive" } }, ride)).toEqual({
      title: "Chauffeur partenaire indisponible · #1783",
      body: "Client à bord (organisation suspendue) · il peut terminer la course ; sinon, clôturez-la · Bastille → Orly",
      level: "warning",
      close: true,
    });
    expect(networkRideAlert({ type: "network.executor_unavailable", data: null }, { label: "", route: "" })).toMatchObject({
      title: "Chauffeur partenaire indisponible",
      body: "Client à bord · il peut terminer la course ; sinon, clôturez-la",
    });
    expect(networkRideAlert({ type: "ride.network_unassigned", data: { reason: "executor_released", auto: true } }, ride)).toEqual({
      title: "Course #1783 retirée au chauffeur partenaire",
      body: "Retirée par l'organisation du chauffeur · recherche relancée, vos chauffeurs d'abord · Bastille → Orly",
      level: "warning",
      close: false,
    });
    expect(networkRideAlert({ type: "ride.network_unassigned", data: { reason: "executor_unavailable", auto: false } }, ride)?.body).toBe(
      "Chauffeur partenaire indisponible · à attribuer à l'un de vos chauffeurs · Bastille → Orly",
    );
    // Retirée par A elle-même : déjà sous les yeux de l'auteur
    expect(networkRideAlert({ type: "ride.network_unassigned", data: { reason: "removed_by_giver" } }, ride)).toBeNull();
    expect(networkRideAlert({ type: "ride.network_closed", data: { cause: "no_position" } }, ride)).toEqual({
      title: "Course #1783 clôturée",
      body: "Course partenaire marquée « à vérifier » · sans position depuis 30 min · Bastille → Orly",
      level: "info",
      close: false,
    });
    expect(networkRideAlert({ type: "dispatch.network", data: {} }, ride)).toBeNull();
  });
});
