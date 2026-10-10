// Écran « Supprimer mon compte » (docs/FLOTTE-PRIVEE.md § 10.4) : compte chauffeur inchangé ; Flotte Privée (compte
// partagé : DRIVER_PROFILE_DELETED) : la fiche seule est supprimée, le compte de connexion, l'espace web et les
// réservations restent — jamais annoncé autrement, ni réattribution par une centrale.
import { describe, expect, it } from "vitest";
import { deletionCopy, type DeletionCopy } from "./account-deletion";

const NBSP = " ";

const allText = (c: DeletionCopy) =>
  [c.lead, c.notice ?? "", ...c.deleted, c.keptTitle, ...c.keptItems, c.keptText ?? "", c.button, c.confirmTitle, c.confirm, c.ridesAssigned ?? ""];

describe("deletionCopy", () => {
  it("compte chauffeur : compte de connexion et données supprimés (textes inchangés)", () => {
    const c = deletionCopy(false);
    expect(c.lead).toBe(
      "La suppression est définitive. Si une course vous est attribuée, terminez-la ou demandez à votre centrale de la réattribuer avant de supprimer votre compte.",
    );
    expect(c.notice).toBeNull();
    expect(c.deleted).toEqual([
      "Votre compte de connexion, votre nom, téléphone, e-mail et photo",
      "Vos documents (carte VTC, permis…) et tous leurs fichiers",
      "Vos positions, appareils et notifications",
      "Vos messages avec la centrale, vos signalements et vos votes",
    ]);
    expect(c.keptTitle).toBe("Conservé sans votre nom ni vos coordonnées");
    expect(c.keptItems).toEqual([]);
    expect(c.keptText).toBe(
      `Les courses réalisées, gains, commissions et règlements restent enregistrés 10 ans pour les obligations comptables de la centrale, rattachés à une fiche anonyme «${NBSP}Chauffeur supprimé${NBSP}».`,
    );
    expect(c.button).toBe("Supprimer définitivement");
    expect(c.confirmTitle).toBe(`Supprimer définitivement${NBSP}?`);
    expect(c.confirm.startsWith("Votre compte et vos données personnelles seront supprimés. Cette action est irréversible.")).toBe(true);
    expect(c.ridesAssigned).toBeNull();
  });

  it("Flotte Privée : la fiche chauffeur seule ; compte de connexion, espace web et réservations conservés", () => {
    const c = deletionCopy(true);
    expect(c.deleted).toEqual([
      `Votre profil chauffeur${NBSP}: nom, téléphone, photo et n° de carte VTC`,
      "Vos documents (carte VTC, permis…) et tous leurs fichiers",
      "Vos positions, appareils et notifications",
    ]);
    expect(c.deleted.join(" ")).not.toMatch(/compte/i);
    expect(c.keptTitle).toBe("Conservé");
    expect(c.keptItems).toEqual([
      "Votre compte de connexion (même e-mail, même mot de passe)",
      "Votre espace web et votre entreprise",
      `Vos réservations et courses passées, rattachées à une fiche anonyme «${NBSP}Chauffeur supprimé${NBSP}»`,
    ]);
    expect(c.keptText).toBeNull();
    expect(c.notice).toBe(
      `Votre fiche chauffeur sera supprimée${NBSP}: les réservations de votre site ne vous seront plus proposées tant que l'équipe Rydar ne l'a pas recréée. Votre espace web et vos réservations restent.`,
    );
    expect(c.button).toBe("Supprimer ma fiche chauffeur");
    expect(c.confirmTitle).toBe(`Supprimer votre fiche chauffeur${NBSP}?`);
    expect(c.confirm).toBe(
      `Votre fiche chauffeur et ses données seront supprimées${NBSP}; votre compte et votre espace web restent. Cette action est irréversible.`,
    );
  });

  it("Flotte Privée : un seul chauffeur — terminer ou annuler ses réservations, jamais « réattribuer » ni « centrale »", () => {
    const c = deletionCopy(true);
    expect(c.lead).toBe("La suppression est définitive. Terminez ou annulez vos réservations confirmées avant de supprimer votre fiche chauffeur.");
    expect(c.ridesAssigned).toBe("Terminez ou annulez vos réservations confirmées, puis supprimez votre fiche chauffeur.");
    for (const text of allText(c)) expect(text).not.toMatch(/réattribu|centrale|seront supprimés\./);
  });

  it("typographie française : espace insécable avant « : ; ? ! » et dans les guillemets", () => {
    for (const c of [deletionCopy(false), deletionCopy(true)]) {
      for (const text of allText(c)) {
        expect(text).not.toMatch(/ [:;?!»]/);
        expect(text).not.toMatch(/« /);
      }
    }
  });
});
