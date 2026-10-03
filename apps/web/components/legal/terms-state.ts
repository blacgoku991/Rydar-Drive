// Bandeau d'acceptation des conditions affiché en haut du tableau de bord (dashboard/layout.tsx), un seul à la fois.
// Deux versions (@rydar/shared) :
//  - ORG_LEGAL_VERSION : CGV + accord de traitement, au nom de l'organisation (owner / admin) ;
//  - LEGAL_VERSION : CGU + politique de confidentialité, à titre personnel (tout membre, dispatcher compris).
// Module sans « use client » : lu par la mise en page (serveur) et par les tests.
import { ORG_LEGAL_VERSION, legalAcceptanceState } from "@rydar/shared";

export type TermsBannerChoice = { kind: "org"; updated: boolean } | { kind: "user" } | null;

/** Documents acceptés à titre personnel par chaque membre. */
export const USER_TERMS_DOCUMENTS = ["cgu", "privacy"] as const;

/**
 * - Owner / admin dont l'organisation n'a pas accepté ORG_LEGAL_VERSION : bandeau de l'organisation (il couvre aussi
 *   les CGU et la politique à titre personnel), en mode « mise à jour » quand une version antérieure avait été
 *   acceptée ;
 * - sinon, membre qui n'a pas accepté LEGAL_VERSION des CGU et de la politique : bandeau des CGU ;
 * - lecture en échec (null) : pas de bandeau de ce type (non bloquant, réaffiché à la lecture suivante).
 */
export function termsBannerChoice({
  admin,
  orgVersions,
  userDocuments,
}: {
  admin: boolean;
  /** Versions de l'accord de traitement (« dpa ») acceptées au nom de l'organisation ; null : non lues ou en erreur */
  orgVersions: readonly string[] | null;
  /** Documents acceptés par la personne pour LEGAL_VERSION (lecture filtrée par la mise en page) ; null : en erreur */
  userDocuments: readonly string[] | null;
}): TermsBannerChoice {
  if (admin && orgVersions) {
    const state = legalAcceptanceState(orgVersions, ORG_LEGAL_VERSION);
    if (state !== "accepted") return { kind: "org", updated: state === "updated" };
  }
  if (userDocuments && !USER_TERMS_DOCUMENTS.every((d) => userDocuments.includes(d))) return { kind: "user" };
  return null;
}
