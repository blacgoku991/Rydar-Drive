// Flotte Privée : libellés et règles d'affichage d'une réservation (Accueil, Réservations, fiche, Agenda) — module
// pur, testé (booking-meta.test.ts). Couleur = information : AGENDA_KIND_META de @rydar/shared (comme l'application).
import {
  AGENDA_KIND_META, ONGOING_STATUSES, agendaKind, formatPrice, formatRelative, formatRideDate, formatTime, localIsoDay,
  shortAddress,
  type AgendaKind, type DriverPresence, type DriverStatus, type PrivateFleetBookingState, type RideStatus, type RideType, type Tone,
} from "@rydar/shared";

const NB = "\u00a0";

/** Catégorie d'affichage (à confirmer, non confirmée, confirmée, en cours, terminée, annulée, heure dépassée…). */
export function bookingKind(b: { status: RideStatus; type?: RideType | null; pickup_at: string; state?: PrivateFleetBookingState | null }, now = Date.now()): AgendaKind {
  return agendaKind(b, now);
}

export function bookingKindMeta(kind: AgendaKind): { label: string; tone: Tone } {
  return AGENDA_KIND_META[kind];
}

/** « Orly → Paris 8e » (adresses abrégées). */
export function bookingRoute(b: { pickup_address: string | null; dropoff_address: string | null }): string {
  return `${shortAddress(b.pickup_address)} → ${shortAddress(b.dropoff_address)}`;
}

/**
 * Échéance de réponse d'une réservation à confirmer : « Réponse avant 07:30 » (aujourd'hui, fuseau de l'organisation),
 * sinon « Réponse avant demain 07:30 » / « avant jeu. 16/10 07:30 » ; échéance passée : « Réponse attendue maintenant ».
 */
export function responseDeadline(expiresAt: string | null | undefined, timeZone: string, now = Date.now()): string | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return null;
  if (at <= now) return "Réponse attendue maintenant";
  if (localIsoDay(new Date(at), timeZone) === localIsoDay(new Date(now), timeZone)) return `Réponse avant ${formatTime(expiresAt, timeZone)}`;
  const label = formatRideDate(expiresAt, timeZone, new Date(now));
  return `Réponse avant ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

/**
 * Moment dans une phrase (fuseau de l'organisation) : « aujourd'hui à 11:04 », « hier à 18:20 », « jeu. 08/10 à 18:36 »
 * — « Mon site » (« dernière réservation : aujourd'hui à 11:04 »), carte « Mon site » de l'Accueil.
 */
export function rideDateAt(date: string | null | undefined, timeZone: string, now = Date.now()): string {
  if (!date) return "—";
  const label = formatRideDate(date, timeZone, new Date(now));
  const cut = label.lastIndexOf(" ");
  const day = label.slice(0, cut);
  return `${day.charAt(0).toLowerCase()}${day.slice(1)} à ${label.slice(cut + 1)}`;
}

/** Origine d'une réservation, au vocabulaire du chauffeur-propriétaire. */
export const PRIVATE_SOURCE_LABELS: Record<string, string> = {
  api: "Votre site",
  dashboard: "Téléphone",
  booking_site: "Mini-site",
};

/** « 85 € » ou « prix à fixer » (demande sans prix du site). */
export function bookingPrice(cents: number | null | undefined, currency?: string | null): string {
  return cents == null ? "prix à fixer" : formatPrice(cents, currency || "EUR");
}

/** Réservation confirmée à venir ou en cours (« Prochaines courses »). */
export const UPCOMING_STATUSES: readonly RideStatus[] = ["ACCEPTED", ...ONGOING_STATUSES];

/** Fiche qui ne reçoit plus de réservation (accord au féminin : « la fiche »). */
const INACTIVE_LABEL: Partial<Record<DriverStatus, string>> = {
  invited: "Fiche en attente d'activation",
  inactive: "Fiche désactivée",
  suspended: "Fiche suspendue",
};

/** État de l'application du chauffeur (en-tête de l'Accueil, Mon profil chauffeur). */
export type AppPresence = { label: string; tone: Tone; detail: string | null };

export function appPresence(
  driver: { status: DriverStatus; presence: DriverPresence; last_seen_at: string | null } | null,
  now = Date.now(),
): AppPresence {
  if (!driver) return { label: "Fiche chauffeur supprimée", tone: "red", detail: "vos réservations ne vous sont plus proposées" };
  if (driver.status !== "active") {
    return { label: INACTIVE_LABEL[driver.status] ?? "Fiche inactive", tone: "red", detail: "vos réservations ne vous sont plus proposées" };
  }
  const seen = driver.last_seen_at ? `dernière activité ${formatRelative(driver.last_seen_at, new Date(now))}` : "application jamais ouverte";
  switch (driver.presence) {
    case "available":
    case "offered":
      return { label: "Application en ligne", tone: "brand", detail: null };
    case "en_route":
    case "arrived":
    case "on_trip":
      return { label: "En course", tone: "cyan", detail: null };
    default:
      return { label: "Application hors ligne", tone: "neutral", detail: seen };
  }
}

/** « 3 réservations » */
export const countLabel = (n: number, one: string, many: string) => `${n}${NB}${n > 1 ? many : one}`;
