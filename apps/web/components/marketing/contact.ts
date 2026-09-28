import { env } from "@/lib/env";

/** Adresse du contact commercial (contact@ le domaine de la plateforme), affichable par la page Contact. */
export const CONTACT_EMAIL = `contact@${env.rootDomain}`;

/**
 * Sujets du formulaire de contact tels qu'ils apparaissent dans l'URL (/contact?sujet=…). La page Contact les
 * traduit en sujets enregistrés (CONTACT_TOPIC_PARAM de @rydar/shared : tarif → pricing, question → question…).
 */
export type ContactSubject = "tarif" | "question" | "partenariat" | "autre";

/** Lien vers le formulaire de contact, sujet et offre (code de /admin/plans) préremplis. */
export function contactHref(sujet?: ContactSubject, offre?: string): string {
  const params = new URLSearchParams();
  if (sujet) params.set("sujet", sujet);
  if (offre) params.set("offre", offre);
  const query = params.toString();
  return query ? `/contact?${query}` : "/contact";
}

/** « Demander un tarif » : formulaire de contact, sujet « Demande de tarif ». */
export const PRICING_HREF = contactHref("tarif");

/** « Poser une question » : formulaire de contact, sujet « Question sur Rydar Drive ». */
export const QUESTION_HREF = contactHref("question");
