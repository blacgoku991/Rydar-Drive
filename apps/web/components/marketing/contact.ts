import { contactHref } from "@rydar/shared";

/**
 * Liens vers le formulaire de contact (/contact?sujet=…&offre=…) : contactHref de @rydar/shared, qui traduit le sujet
 * enregistré en paramètre d'URL (pricing → « tarif ») et ignore un code d'offre invalide.
 */
export { contactHref };

/** « Demander un tarif » : formulaire de contact, sujet « Demande de tarif ». */
export const PRICING_HREF = contactHref("pricing");

/** « Poser une question » : formulaire de contact, sujet « Question sur Rydar Drive ». */
export const QUESTION_HREF = contactHref("question");
