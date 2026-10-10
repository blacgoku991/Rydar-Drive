// Urgence d'une offre de course (ouverture plein écran, sonnerie, compte à rebours) et échéance de réponse d'une
// réservation Flotte Privée (docs/FLOTTE-PRIVEE.md § 10.6). Module pur, sans dépendance native (offer-urgency.test.ts) :
// il n'importe que @rydar/shared et des chemins relatifs.
import { PRIVATE_FLEET_RING_WINDOW_S, type DriverOfferV2 } from "@rydar/shared";
import { formatWhen, NBSP } from "./settlement-text";

/** Fenêtre (s) en deçà de laquelle une offre est traitée comme urgente (sonnerie, compte à rebours). */
export const URGENT_OFFER_S = 120;

type OfferTiming = Pick<DriverOfferV2, "mode" | "sent_at" | "expires_at">;

/** Réglage de l'organisation du chauffeur : Flotte Privée (driver_home().organization.private_fleet). */
export type UrgencyContext = { privateFleet?: boolean };

/** Fenêtre de réponse d'une offre (s), de l'envoi à l'échéance ; null sans échéance (ou dates illisibles). */
export function offerWindowSeconds(o: Pick<DriverOfferV2, "sent_at" | "expires_at">): number | null {
  if (!o.expires_at) return null;
  const s = (Date.parse(o.expires_at) - Date.parse(o.sent_at)) / 1000;
  return Number.isFinite(s) ? s : null;
}

/**
 * Fenêtre de réponse urgente : 2 min au plus (course planifiée proche) ; Flotte Privée : 15 min au plus, comme la
 * sonnerie décidée par le serveur (PRIVATE_FLEET_RING_WINDOW_S : réservation immédiate, ou prise en charge proche).
 */
export function isUrgentWindow(windowS: number | null | undefined, ctx: UrgencyContext = {}): boolean {
  if (windowS == null) return false;
  return windowS <= URGENT_OFFER_S || (ctx.privateFleet === true && windowS <= PRIVATE_FLEET_RING_WINDOW_S);
}

/**
 * Offre à traiter tout de suite : dispatch GPS, fenêtre courte, ou (Flotte Privée) réservation dont la réponse est
 * attendue dans 15 min au plus. Règle des organisations standard inchangée.
 */
export function isUrgentOffer(o: OfferTiming, ctx: UrgencyContext = {}): boolean {
  if (o.mode === "geo") return true;
  return isUrgentWindow(offerWindowSeconds(o), ctx);
}

/**
 * Ouverture plein écran à la lecture des offres : une offre GPS toujours ; une offre urgente de la flotte jamais pendant
 * une course (toute la flotte la reçoit ; Flotte Privée : la réservation reste dans l'agenda, « La prendre à la suite »).
 */
export function shouldOpenOffer(o: OfferTiming, ctx: UrgencyContext & { onRide?: boolean } = {}): boolean {
  if (o.mode === "geo") return true;
  return !ctx.onRide && isUrgentOffer(o, ctx);
}

/** Valeur affichée au centre de l'anneau du compte à rebours. */
export type CountdownView = { value: number; unit: "s" | "min"; label: string };

/**
 * Compte à rebours : secondes pour une fenêtre courte (2 min au plus) et pour la dernière minute ; minutes sinon
 * (réservation Flotte Privée : « 4 min » plutôt que « 240 »). label : texte du lecteur d'écran.
 */
export function countdownView(remainingS: number, windowS: number): CountdownView {
  const left = Math.max(0, remainingS);
  if (windowS > URGENT_OFFER_S && left > 60) {
    const minutes = Math.ceil(left / 60);
    return { value: minutes, unit: "min", label: `${minutes}${NBSP}minute${minutes > 1 ? "s" : ""} pour répondre` };
  }
  const seconds = Math.ceil(left);
  return { value: seconds, unit: "s", label: `${seconds}${NBSP}seconde${seconds > 1 ? "s" : ""} pour répondre` };
}

/**
 * Réservation (Flotte Privée) : « Réponse avant 07:30 », « Réponse avant demain 07:30 », « Réponse avant le jeu. 16/10
 * 07:30 » (heure du fuseau de l'organisation) ; null sans échéance.
 */
export function answerBeforeText(expiresAt: string | null | undefined, tz?: string, now = Date.now()): string | null {
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) return null;
  return `Réponse avant ${formatWhen(expiresAt, tz, new Date(now))}`;
}
