import "server-only";

/**
 * Éditeur de l'application (pages publiques /confidentialite et /suppression-compte, exigées par l'App Store et
 * Google Play). Variables du serveur : LEGAL_NAME (société), LEGAL_EMAIL (contact données personnelles),
 * LEGAL_ADDRESS (adresse du siège).
 */
export function legalInfo() {
  return {
    name: process.env.LEGAL_NAME || "Rydar Drive",
    email: process.env.LEGAL_EMAIL || "",
    address: process.env.LEGAL_ADDRESS || "",
  };
}

/** Date de dernière mise à jour affichée sur les pages légales. */
export const LEGAL_UPDATED_AT = "27 septembre 2026";
