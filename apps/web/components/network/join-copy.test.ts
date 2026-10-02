import { describe, expect, it } from "vitest";
import {
  autoApproveHelp, joinMessage, joinNavLabel, joinPageCopy, joinShareText, joinSuccessCopy, joinedLabel, rejectReasons,
} from "./join-copy";

// Lien d'inscription des chauffeurs (20260924006300) : flotte comme centrale. Textes de la centrale inchangés ;
// flotte : jamais de commission, de part chauffeur, de plafond ni de « réseau ».

const NB = " ";
const URL = "https://rydardrive.com/rejoindre/0123456789abcdef";
const COMMISSION_WORDS = /commission|part chauffeur|votre part|plafonn|réseau|indépendant|Nouveau/i;

/** Tous les textes destinés aux chauffeurs ou à l'organisation pour un modèle donné. */
function allTexts(model: "fleet" | "centrale") {
  return [
    joinNavLabel(model),
    joinMessage("Taxi Sud", URL, model),
    joinShareText("Taxi Sud", model),
    joinedLabel(model),
    autoApproveHelp(model, true),
    autoApproveHelp(model, false),
    ...rejectReasons(model),
    ...Object.values(joinPageCopy("Taxi Sud", model, true)),
    ...Object.values(joinPageCopy("Taxi Sud", model, false)),
    ...Object.values(joinSuccessCopy("Taxi Sud", model, true)),
    ...Object.values(joinSuccessCopy("Taxi Sud", model, false)),
  ].filter((t): t is string => typeof t === "string");
}

describe("textes du lien d'inscription selon le modèle", () => {
  it("flotte : entrée « Inscriptions », aucune mention de commission ni de réseau", () => {
    expect(joinNavLabel("fleet")).toBe("Inscriptions");
    for (const text of allTexts("fleet")) expect(text).not.toMatch(COMMISSION_WORDS);
  });

  it("centrale : textes historiques inchangés", () => {
    expect(joinNavLabel("centrale")).toBe("Réseau");
    expect(joinMessage("Taxi Sud", URL, "centrale")).toBe(`Rejoignez le réseau Taxi Sud sur Rydar Drive : ${URL}`);
    expect(joinShareText("Taxi Sud", "centrale")).toBe("Rejoignez le réseau Taxi Sud sur Rydar Drive");
    expect(autoApproveHelp("centrale", true)).toBe("Actifs dès l'inscription, au niveau « Nouveau » (courses plafonnées).");
    expect(rejectReasons("centrale")).toContain("Réseau complet");
    const page = joinPageCopy("Taxi Sud", "centrale", false);
    expect(page.title).toBe("Rejoignez le réseau Taxi Sud");
    expect(page.lead).toBe("Inscription en 2 minutes. La centrale valide votre profil, puis vous recevez les courses dans l'application Rydar Drive.");
    expect(page.formSubtitle).toBe("Chauffeur VTC indépendant · réponse de Taxi Sud");
    expect(joinSuccessCopy("Taxi Sud", "centrale", true).text).toBe("Vous faites maintenant partie du réseau Taxi Sud.");
  });

  it("flotte : nom de l'organisation et espace insécable avant les deux-points et le point d'exclamation", () => {
    expect(joinMessage("Taxi Sud", URL, "fleet")).toBe(`Rejoignez Taxi Sud comme chauffeur VTC sur Rydar Drive${NB}: ${URL}`);
    const page = joinPageCopy("Taxi Sud", "fleet", false);
    expect(page.title).toBe("Rejoignez Taxi Sud");
    expect(page.lead).toContain("Taxi Sud valide votre profil");
    expect(page.formSubtitle).toBe("Chauffeur VTC · réponse de Taxi Sud");
    expect(joinPageCopy("Taxi Sud", "fleet", true).formSubtitle).toBe("Chauffeur VTC · activation immédiate");
    expect(joinSuccessCopy("Taxi Sud", "fleet", false).text).toMatch(new RegExp(`^Merci${NB}! Taxi Sud étudie votre candidature`));
    expect(autoApproveHelp("fleet", true)).toContain(`inscription${NB}:`);
    expect(rejectReasons("fleet")).toContain("Flotte complète");
  });

  it("modèle inconnu (réponse sans modèle) : textes de flotte, jamais de commission annoncée à tort", () => {
    expect(joinNavLabel(undefined)).toBe("Inscriptions");
    expect(joinMessage("Taxi Sud", URL, null)).not.toMatch(COMMISSION_WORDS);
  });
});
