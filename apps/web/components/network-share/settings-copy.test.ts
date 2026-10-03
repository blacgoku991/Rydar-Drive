import { describe, expect, it } from "vitest";
import { RECEIVE_COPY, activateCopy, driverGraceHours } from "./settings-copy";

// Réglages du réseau partagé : textes justes pour chaque modèle (une centrale n'a ni véhicules ni assurance pour ses
// chauffeurs indépendants) et sens des paiements (le chauffeur reverse avec VOS moyens ; vous versez sur SON compte).

describe("fenêtre « Activer le partage »", () => {
  it("chauffeur → organisation : moyens de l'organisation et délai (au moins 48 h) ; organisation → chauffeur : 7 jours", () => {
    const [, money] = activateCopy("out", "fleet", 48).points;
    expect(money).toBe(
      "Course payée à bord : le chauffeur vous reverse votre part avec vos moyens de paiement (lien, RIB, espèces), sous 48 h. " +
        "Course déjà payée : vous lui versez la sienne sous 7 jours.",
    );
    // « avec vos moyens de paiement » ne qualifie jamais le versement de l'organisation au chauffeur
    expect(money!.indexOf("avec vos moyens de paiement")).toBeLessThan(money!.indexOf("Course déjà payée"));
    expect(driverGraceHours(null)).toBe(48);
    expect(driverGraceHours(12)).toBe(48);
    expect(driverGraceHours(72)).toBe(72);
  });
});

describe("réception : flotte ou centrale", () => {
  it("flotte : vos véhicules, votre assurance", () => {
    expect(RECEIVE_COPY.fleet.description).toContain("vos véhicules et sous votre assurance");
    expect(activateCopy("in", "fleet", 48).points).toContain(RECEIVE_COPY.fleet.activate);
  });

  it("centrale : chauffeurs indépendants, leur véhicule et leur assurance ; jamais « vos véhicules »", () => {
    for (const text of [RECEIVE_COPY.centrale.description, RECEIVE_COPY.centrale.activate, RECEIVE_COPY.centrale.insurance]) {
      expect(text).not.toMatch(/vos véhicules|votre assurance|Mon assurance/);
    }
    expect(RECEIVE_COPY.centrale.description).toBe(
      "Vos chauffeurs indépendants les font avec leur véhicule et sous leur assurance ; votre centrale ne touche rien.",
    );
    expect(activateCopy("in", "centrale", 48).points).toContain(RECEIVE_COPY.centrale.activate);
  });
});
