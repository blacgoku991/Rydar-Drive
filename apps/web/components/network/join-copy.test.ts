import { describe, expect, it } from "vitest";
import {
  JOIN_ALREADY_REGISTERED, JOIN_LINK_INACTIVE, autoApproveHelp, joinBadge, joinErrorCopy, joinInfoModel, joinMessage, joinNavLabel,
  joinPageCopy, joinShareText, joinSuccessCopy, joinedLabel, rejectReasons,
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
    joinBadge(model),
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
    ...Object.values(joinErrorCopy("Taxi Sud", model)),
  ].filter((t): t is string => typeof t === "string");
}

describe("textes du lien d'inscription selon le modèle", () => {
  it("flotte : entrée « Inscriptions », aucune mention de commission ni de réseau", () => {
    expect(joinNavLabel("fleet")).toBe("Inscriptions");
    for (const text of allTexts("fleet")) expect(text).not.toMatch(COMMISSION_WORDS);
  });

  it("réseau partagé ouvert : « Inscriptions » pour les deux modèles", () => {
    expect(joinNavLabel("centrale", true)).toBe("Inscriptions");
    expect(joinNavLabel("fleet", true)).toBe("Inscriptions");
    expect(joinNavLabel("centrale", false)).toBe("Réseau");
  });

  it("centrale : textes historiques inchangés", () => {
    expect(joinNavLabel("centrale")).toBe("Réseau");
    expect(joinMessage("Taxi Sud", URL, "centrale")).toBe(`Rejoignez le réseau Taxi Sud sur Rydar Drive : ${URL}`);
    expect(joinShareText("Taxi Sud", "centrale")).toBe("Rejoignez le réseau Taxi Sud sur Rydar Drive");
    expect(autoApproveHelp("centrale", true)).toMatch(/^Actifs dès l'inscription, au niveau « Nouveau » \(courses plafonnées\)\. /);
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

  it("validation automatique : rappel du contrôle des documents ; badge sans vocabulaire d'embauche", () => {
    for (const model of ["fleet", "centrale"] as const) {
      expect(autoApproveHelp(model, true)).toContain(`La validation automatique ne vaut pas vérification de leurs documents${NB}:`);
      expect(autoApproveHelp(model, true)).toContain("carte professionnelle VTC, le permis");
      expect(autoApproveHelp(model, false)).not.toMatch(/vérification/);
      expect(joinBadge(model)).not.toMatch(/recrut|embauch|emploi/i);
    }
    expect(autoApproveHelp("centrale", true)).toContain("inscription au registre des exploitants VTC");
    // Validation manuelle : l'aide renvoie à la liste « Candidatures » de la page (jamais « ci-contre », faux sur téléphone)
    for (const model of ["fleet", "centrale"] as const) {
      expect(autoApproveHelp(model, false)).toBe("Chaque inscrit attend votre validation dans Candidatures.");
      expect(autoApproveHelp(model, false)).not.toContain("ci-contre");
    }
    expect(joinBadge("centrale")).toBe("Inscription chauffeurs VTC indépendants");
    expect(joinBadge("fleet")).toBe("Inscription chauffeurs VTC");
  });

  it("réponse sans modèle (base d'avant 20260924006300 : seules les centrales avaient un lien) → centrale, partout", () => {
    expect(joinInfoModel(undefined)).toBe("centrale");
    expect(joinInfoModel(null)).toBe("centrale");
    expect(joinInfoModel("centrale")).toBe("centrale");
    expect(joinInfoModel("fleet")).toBe("fleet");
    expect(joinInfoModel("autre")).toBe("centrale");
  });

  it("erreurs de l'inscription : jamais « centrale » pour une flotte ; centrale inchangée ; textes communs neutres", () => {
    const fleet = joinErrorCopy("Taxi Sud", "fleet");
    for (const text of Object.values(fleet)) expect(text).not.toMatch(/centrale/i);
    expect(fleet.refusal).toBe("Inscription impossible. Contactez Taxi Sud.");
    expect(fleet.phone).toBe(`Ce numéro est déjà inscrit dans cette flotte${NB}: connectez-vous à l'application avec votre compte.`);
    expect(joinErrorCopy("Taxi Sud", "centrale")).toEqual({
      refusal: "Inscription impossible. Contactez la centrale.",
      phone: "Ce numéro est déjà inscrit dans cette centrale : connectez-vous à l'application avec votre compte.",
      email: "Cette adresse e-mail est déjà inscrite dans cette centrale.",
      plate: "Cette plaque est déjà enregistrée dans cette centrale.",
    });
    expect(JOIN_LINK_INACTIVE).toContain("à la centrale ou à la flotte");
    expect(JOIN_ALREADY_REGISTERED).toBe("Ce compte est déjà rattaché à une centrale ou à une flotte.");
  });
});
