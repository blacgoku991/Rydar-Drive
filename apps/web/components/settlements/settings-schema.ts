// Réglages « Commission & encaissement » : messages en français par champ du schéma partagé
// (centraleSettingsSchema) — utilisés par le formulaire et par l'action serveur.
import type { z } from "zod";

export const CENTRALE_FIELD_MESSAGES: Record<string, string> = {
  commissionPercent: "Commission : entre 0 et 100 %",
  commissionFixedCents: "Montant fixe : entre 0 et 1 000 €",
  graceHours: "Délai de règlement : entre 0 et 720 heures",
  creditLimitCents: "Plafond d'encours : entre 0 et 100 000 €",
  newDriverMaxPriceCents: "Plafond des nouveaux chauffeurs : entre 0 et 100 000 €",
  trustAfterRides: "Confirmation automatique : entre 1 et 1 000 courses",
  instructions: "Instructions : 500 caractères au maximum",
};

/** Erreurs du schéma → { champ: message FR } (messages métier du schéma conservés : moyens, lien). */
export function centraleIssues(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "_");
    if (out[key]) continue;
    if (key === "link" && issue.code === "too_big") out[key] = "Lien : 500 caractères au maximum";
    else out[key] = key === "methods" || key === "link" ? issue.message : (CENTRALE_FIELD_MESSAGES[key] ?? "Valeur invalide");
  }
  return out;
}
