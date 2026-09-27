import { describe, expect, it } from "vitest";
import { fr } from "./typo";

const NBSP = " ";

describe("fr() : typographie française de la page d'accueil", () => {
  it("met une espace insécable avant : ; ! ?", () => {
    expect(fr("Carte, alertes, commissions : vous pilotez")).toBe(`Carte, alertes, commissions${NBSP}: vous pilotez`);
    expect(fr("Rydar est-il un transporteur ?")).toBe(`Rydar est-il un transporteur${NBSP}?`);
    expect(fr("jour ; nuit")).toBe(`jour${NBSP}; nuit`);
    expect(fr("Enfin !")).toBe(`Enfin${NBSP}!`);
  });

  it("met une espace insécable à l'intérieur des guillemets", () => {
    expect(fr("Les autres voient « Course déjà attribuée »")).toBe(`Les autres voient «${NBSP}Course déjà attribuée${NBSP}»`);
  });

  it("lie un nombre à son unité", () => {
    expect(fr("par vagues de 4 à 16 km.")).toBe(`par vagues de 4 à 16${NBSP}km.`);
    expect(fr("Dans 300 m, à droite")).toBe(`Dans 300${NBSP}m, à droite`);
    expect(fr("30 s pour accepter")).toBe(`30${NBSP}s pour accepter`);
    expect(fr("Retardé · +35 min")).toBe(`Retardé · +35${NBSP}min`);
    expect(fr("À 1,8 km · 65 €")).toBe(`À 1,8${NBSP}km · 65${NBSP}€`);
    expect(fr("sous 14 jours")).toBe(`sous 14${NBSP}jours`);
    expect(fr("arrivée à 10 h")).toBe(`arrivée à 10${NBSP}h`);
  });

  it("ne touche pas aux mots qui commencent comme une unité", () => {
    for (const s of ["3 sites", "2 passagers", "5 minutes", "8 hôtels", "4 millions", "12 heures"]) expect(fr(s)).toBe(s);
  });

  it("laisse intacts les heures, les liens et le texte sans ponctuation haute", () => {
    for (const s of ["14:32:02", "https://exemple.fr/api?x=1", "Vague 2 sur 4", "Sans chauffeur"]) expect(fr(s)).toBe(s);
  });

  it("est idempotente", () => {
    const s = "Relance : 4 puis 8 km ; « Sans chauffeur » ? Oui !";
    expect(fr(fr(s))).toBe(fr(s));
  });
});
