import { formatTime } from "./format";
import type { DocumentState, FleetReportType, FlightStatus, RideAlertKind, RideAlertSeverity } from "./types";

// -----------------------------------------------------------------------------
// Libellés communs dashboard ⇄ app chauffeur : signalements, vols, alertes de suivi.
// Couleurs = tokens du design (statuts « radar »), icônes = noms lucide (web) / Ionicons (app).
// -----------------------------------------------------------------------------

export const FLEET_REPORT_META: Record<
  FleetReportType,
  { label: string; short: string; emoji: string; color: string; lucide: string; ionicon: string }
> = {
  // Couleurs = thème (apps/driver/src/theme.ts, apps/web globals.css) ; ionicon = pictogramme de l'app (jamais d'emoji) ;
  // emoji conservé pour le dashboard web tant qu'il l'utilise.
  police: { label: "Police", short: "Police", emoji: "🚓", color: "#6AA6FF", lucide: "siren", ionicon: "shield-outline" },
  control: { label: "Contrôle", short: "Contrôle", emoji: "🛑", color: "#F2555A", lucide: "octagon-alert", ionicon: "id-card-outline" },
  accident: { label: "Accident", short: "Accident", emoji: "💥", color: "#F5B544", lucide: "car-front", ionicon: "car-outline" },
  traffic: { label: "Bouchon / travaux", short: "Bouchon", emoji: "🚧", color: "#F5B544", lucide: "construction", ionicon: "construct-outline" },
  danger: { label: "Danger", short: "Danger", emoji: "⚠️", color: "#F2555A", lucide: "triangle-alert", ionicon: "warning-outline" },
  other: { label: "Signalement", short: "Info", emoji: "📍", color: "#B39DFA", lucide: "map-pin", ionicon: "location-outline" },
};

/** Ordre des gros boutons « Signaler » (le type « other » reste accessible par la messagerie). */
export const FLEET_REPORT_BUTTONS: FleetReportType[] = ["police", "control", "accident", "traffic", "danger"];

const REPORT_PHRASE: Record<FleetReportType, string> = {
  police: "Police signalée",
  control: "Contrôle signalé",
  accident: "Accident signalé",
  traffic: "Bouchon signalé",
  danger: "Danger signalé",
  other: "Signalement",
};

/** « Contrôle signalé par Karim », « Police signalée » */
export function fleetReportTitle(type: FleetReportType, author?: string | null): string {
  return author ? `${REPORT_PHRASE[type]} par ${author}` : REPORT_PHRASE[type];
}

export const FLIGHT_STATUS_META: Record<FlightStatus, { label: string; tone: "neutral" | "amber" | "green" | "red" | "blue" | "violet" }> = {
  scheduled: { label: "À l'heure", tone: "green" },
  delayed: { label: "Retardé", tone: "amber" },
  departed: { label: "En vol", tone: "blue" },
  landed: { label: "Atterri", tone: "green" },
  cancelled: { label: "Annulé", tone: "red" },
  diverted: { label: "Dérouté", tone: "red" },
  unknown: { label: "Suivi en cours", tone: "neutral" },
};

type FlightLike = {
  flight_number?: string | null;
  flight_mode?: "arrival" | "departure" | null;
  flight_status?: FlightStatus | null;
  flight_delay_minutes?: number | null;
  flight_estimated_arrival?: string | null;
  flight_actual_arrival?: string | null;
  flight_scheduled_arrival?: string | null;
  flight_terminal?: string | null;
};

/** Numéro de vol normalisé pour l'affichage : « AF 1234 » → « AF1234 ». */
export const flightCode = (n: string | null | undefined) => (n ?? "").replace(/\s+/g, "").toUpperCase();

/** Retard signé : « +35 min », « −10 min », « +1 h 20 ». */
export function formatDelay(minutes: number | null | undefined): string {
  if (minutes == null) return "";
  const sign = minutes < 0 ? "−" : "+";
  const m = Math.abs(minutes);
  if (m < 60) return `${sign}${m} min`;
  return `${sign}${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, "0")}` : ""}`;
}

/**
 * Badge compact d'une course avec vol, ou null sans vol :
 * « AF1234 · +35 min », « AF1234 · atterri 14:52 · T2E », « AF1234 · annulé », « AF1234 · à l'heure ».
 */
export function flightBadge(r: FlightLike, timeZone?: string): { text: string; tone: (typeof FLIGHT_STATUS_META)[FlightStatus]["tone"] } | null {
  const code = flightCode(r.flight_number);
  if (!code) return null;
  const status = r.flight_status ?? null;
  const terminal = r.flight_terminal ? ` · T${r.flight_terminal.replace(/^T/i, "")}` : "";
  if (!status) return { text: code, tone: "neutral" };
  if (status === "landed") {
    const at = r.flight_actual_arrival ?? r.flight_estimated_arrival;
    return { text: `${code} · atterri${at ? ` ${formatTime(at, timeZone)}` : ""}${terminal}`, tone: "green" };
  }
  if (status === "cancelled" || status === "diverted") return { text: `${code} · ${FLIGHT_STATUS_META[status].label.toLowerCase()}`, tone: "red" };
  const delay = r.flight_delay_minutes ?? 0;
  if (Math.abs(delay) >= 5) return { text: `${code} · ${formatDelay(delay)}${terminal}`, tone: delay > 0 ? "amber" : "blue" };
  return { text: `${code} · à l'heure${terminal}`, tone: status === "departed" ? "blue" : "green" };
}

export const RIDE_ALERT_META: Record<RideAlertKind, { label: string; short: string; lucide: string; ionicon: string }> = {
  late: { label: "Chauffeur en retard", short: "Retard", lucide: "clock-alert", ionicon: "time" },
  stalled: { label: "Chauffeur immobile", short: "Immobile", lucide: "circle-pause", ionicon: "pause-circle" },
  no_gps: { label: "GPS muet", short: "GPS muet", lucide: "satellite-dish", ionicon: "cellular" },
  not_started: { label: "Course pas démarrée", short: "Pas parti", lucide: "timer-off", ionicon: "timer" },
};

export const ALERT_SEVERITY_TONE: Record<RideAlertSeverity, "amber" | "red"> = { warning: "amber", critical: "red" };

// -----------------------------------------------------------------------------
// Documents chauffeur (migration 20260924002400) : statut calculé côté serveur
// -----------------------------------------------------------------------------
/** Statut affiché (serveur) + « missing » pour un type exigé jamais déposé. */
export type DocumentDisplayState = DocumentState | "missing";

export const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  vtc_card: "Carte VTC",
  driving_license: "Permis de conduire",
  identity: "Pièce d'identité",
  insurance: "Attestation d'assurance",
  vehicle_registration: "Carte grise",
  medical: "Visite médicale",
  other: "Document",
};

export const DOCUMENT_STATE_META: Record<DocumentDisplayState, { label: string; tone: "green" | "amber" | "red" | "blue" | "neutral" }> = {
  valid: { label: "Valide", tone: "green" },
  expiring: { label: "Expire bientôt", tone: "amber" },
  expired: { label: "Expiré", tone: "red" },
  pending: { label: "En attente de validation", tone: "blue" },
  rejected: { label: "Refusé", tone: "red" },
  missing: { label: "Manquant", tone: "neutral" },
};

/** « Expire dans 12 j », « Expire aujourd'hui », « Expiré depuis 3 j », sinon le libellé du statut. */
export function documentStateLabel(state: DocumentDisplayState, daysLeft?: number | null): string {
  if (state === "expiring" && daysLeft != null) return daysLeft <= 0 ? "Expire aujourd'hui" : `Expire dans ${daysLeft} j`;
  if (state === "expired" && daysLeft != null && daysLeft < 0) return `Expiré depuis ${-daysLeft} j`;
  return DOCUMENT_STATE_META[state].label;
}
