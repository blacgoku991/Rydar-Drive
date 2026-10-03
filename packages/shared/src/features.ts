import { dateTimeFormat, formatTime } from "./format";
import type {
  ChatMessage, ChatOverview, DocumentState, DriverChatOverview, FleetReportType, FlightStatus, RideAlertKind, RideAlertSeverity,
} from "./types";

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

// -----------------------------------------------------------------------------
// Modération du fil « Chauffeurs » (migration 20260924004100_chat_moderation) : signaler un message, masquer
// un auteur (app chauffeur) ; supprimer un message, ignorer un signalement (dashboard de la centrale).
// -----------------------------------------------------------------------------

export type ChatReportStatus = "open" | "dismissed" | "removed";

/** Chauffeur dont le chauffeur connecté a masqué les messages (driver_chat_overview.blocked). */
export interface ChatBlockedAuthor {
  driver_id: string;
  /** « Sofiane T. » (comme dans les messages) */
  name: string;
  blocked_at: string;
}

/**
 * driver_chat_overview, avec les auteurs masqués et la dernière version des CGU acceptée par le compte (champs
 * absents des réponses d'un serveur antérieur à la migration).
 */
export type DriverChatOverviewModerated = DriverChatOverview & {
  blocked?: ChatBlockedAuthor[];
  /** Dernière version des CGU (= règles du fil) acceptée : à l'inscription par lien ou dans l'application ; null : jamais */
  rules_version?: string | null;
};

/** chat_overview (dashboard), avec le nombre de messages du fil flotte signalés en attente de décision. */
export type ChatOverviewModerated = ChatOverview & { open_reports?: number };

export interface ReportChatMessageResult {
  ok: true;
  code: "REPORTED" | "ALREADY_REPORTED";
  report_id: string;
  message_id: string;
  status: ChatReportStatus;
}

export interface BlockChatAuthorResult {
  ok: true;
  code: "BLOCKED" | "ALREADY_BLOCKED";
  driver_id: string;
  name: string;
}

export interface UnblockChatAuthorResult {
  ok: true;
  code: "UNBLOCKED" | "NOT_BLOCKED";
  driver_id: string;
}

export interface RemoveChatMessageResult {
  ok: true;
  code: "REMOVED" | "ALREADY_REMOVED";
  message_id: string;
  /** Signalements ouverts passés à « removed » */
  reports?: number;
}

export interface DismissChatReportResult {
  ok: true;
  code: "DISMISSED" | "ALREADY_RESOLVED";
  message_id: string;
  /** Signalements ouverts de ce message classés ensemble */
  dismissed?: number;
  /**
   * ALREADY_RESOLVED : « removed » (message retiré entre-temps, par exemple par un autre membre), « dismissed »
   * (signalements déjà classés) ou null (signalement effacé avec le compte de son auteur).
   */
  status?: ChatReportStatus | null;
}

/** Un signalement d'un message (file de modération). */
export interface ChatModerationReport {
  id: string;
  reason: string | null;
  created_at: string;
  reporter_type: "driver" | "user";
  reporter_name: string;
}

/** Message signalé en attente de décision (chat_moderation_queue), avec tous ses signalements ouverts. */
export interface ChatModerationItem {
  message: ChatMessage;
  report_count: number;
  first_reported_at: string;
  last_reported_at: string;
  reports: ChatModerationReport[];
}

export interface ChatModerationQueue {
  organization_id: string;
  /** Messages signalés en attente (au-delà de la page renvoyée si elle est pleine) */
  open: number;
  items: ChatModerationItem[];
}

/** Temps réel « chat.moderation » sur org:<org> : identifiants seulement, jamais le texte. */
export interface ChatModerationEvent {
  action: "reported" | "dismissed" | "removed";
  organization_id: string;
  message_id: string;
  report_id?: string;
}

/** Motifs proposés au signalement d'un message (facultatifs ; le chauffeur peut préciser, 200 caractères au plus). */
export const CHAT_REPORT_REASONS = ["Insultes ou harcèlement", "Contenu choquant", "Spam ou publicité", "Fausse information"] as const;
export const CHAT_REPORT_REASON_MAX = 200;

/**
 * Règles d'usage du fil « Chauffeurs », rappelées au-dessus du champ de saisie de l'app (la centrale modère son fil ;
 * Rydar Drive fournit l'outil). Typographie : frTypo à l'affichage.
 */
export const FLEET_CHAT_RULES =
  "Fil modéré par votre centrale : restez courtois. Appui long sur un message pour le signaler ou masquer son auteur.";

/**
 * Règles du fil « Chauffeurs » (résumé du § 8 des CGU), acceptées dans l'app avant la première publication dans
 * le fil (message ou signalement de la flotte). Typographie : frTypo à l'affichage.
 */
export const FLEET_CHAT_RULES_POINTS = [
  "Vos messages et signalements sont visibles par tous les chauffeurs de votre centrale et par son équipe.",
  "Restez courtois et limitez-vous à l'activité : trafic, contrôles, entraide.",
  "Aucune tolérance pour les contenus choquants ni pour les comportements abusifs : propos injurieux, discriminatoires, menaçants ou à caractère sexuel, harcèlement, données personnelles de tiers (clients notamment), publicité et faux signalements sont interdits.",
  "Votre centrale modère le fil : elle peut retirer un message, suspendre ou exclure son auteur. Appui long sur un message pour le signaler ou masquer son auteur.",
] as const;

// -----------------------------------------------------------------------------
// Documents légaux : deux versions, dates ISO (AAAA-MM-JJ) comparables comme du texte, jamais dans le futur
// (accept_legal_documents refuse une version postérieure au lendemain, heure de Paris ; aucune version en base).
//  - LEGAL_VERSION : CGU + politique de confidentialité, acceptées à titre personnel par TOUT utilisateur (membres du
//    tableau de bord, chauffeurs : app, /rejoindre, règles du fil « Chauffeurs » = CGU § 8). L'app l'embarque : la
//    changer = nouvel écran d'acceptation pour chaque chauffeur (après une mise à jour de l'app) et chaque membre.
//  - ORG_LEGAL_VERSION : CGV + accord de traitement des données, acceptés au nom de l'organisation par le
//    propriétaire ou un administrateur (bandeau du tableau de bord, /admin/legal). La changer ne touche ni les
//    chauffeurs, ni les dispatchers, ni l'app (web seul).
// -----------------------------------------------------------------------------

/**
 * Version des CGU et de la politique de confidentialité (tout utilisateur, app chauffeur comprise). À changer quand
 * leur contenu change de façon importante : membres et chauffeurs sont alors invités à accepter la nouvelle version.
 */
export const LEGAL_VERSION = "2026-09-27";

/**
 * Version des CGV et de l'accord de traitement (au nom de l'organisation, owner / admin). 2026-10-02 : frais
 * plateforme par course pour les flottes comme pour les centrales, en plus de l'abonnement (CGV art. 3 à 5) ; accord
 * de traitement inchangé depuis le 27 septembre 2026.
 */
export const ORG_LEGAL_VERSION = "2026-10-02";

/**
 * Entrée en vigueur de ORG_LEGAL_VERSION pour une organisation déjà cliente à sa publication (version antérieure
 * acceptée) : dès son acceptation, et AU PLUS TARD à cette date ; elle peut résilier sans frais avant (CGV art. 16 :
 * modification défavorable annoncée au moins 30 jours à l'avance). Date ISO AAAA-MM-JJ, à revoir avec chaque
 * nouvelle ORG_LEGAL_VERSION.
 */
export const ORG_LEGAL_EFFECTIVE_AT = "2026-11-05";

/**
 * Version acceptée ÉGALE à celle en vigueur (comme le web) : une version « postérieure » inscrite dans le registre
 * (texte libre, ex. « 9999-12-31 ») ne vaut jamais acceptation des versions à venir.
 */
export function legalVersionAccepted(accepted: string | null | undefined, current: string = LEGAL_VERSION): boolean {
  return !!accepted && accepted === current;
}

/**
 * Acceptation d'un document d'après les versions inscrites au registre (legal_acceptances) :
 *  - « accepted » : version en vigueur acceptée (égalité, legalVersionAccepted) ;
 *  - « updated » : seulement une version ANTÉRIEURE (bandeau de mise à jour) ;
 *  - « pending » : jamais accepté. Une version « postérieure » ou un texte libre du registre ne compte pas.
 */
export type LegalAcceptanceState = "accepted" | "updated" | "pending";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function legalAcceptanceState(versions: readonly (string | null | undefined)[], current: string): LegalAcceptanceState {
  if (versions.some((v) => legalVersionAccepted(v, current))) return "accepted";
  return versions.some((v) => !!v && ISO_DATE.test(v) && v < current) ? "updated" : "pending";
}

/** Date ISO AAAA-MM-JJ (version, entrée en vigueur) en toutes lettres : « 2 octobre 2026 », « 1er novembre 2026 ». */
export function legalDateLabel(iso: string): string {
  const date = new Date(`${iso}T12:00:00Z`);
  if (!ISO_DATE.test(iso) || Number.isNaN(date.getTime())) return iso;
  return dateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .format(date)
    .replace(/^1 /, "1er ");
}

/** Motif envoyé : motif choisi, précision libre, ou les deux (« Spam ou publicité — lien douteux »), borné à 200. */
export function chatReportReason(choice: string | null | undefined, detail: string | null | undefined): string | null {
  const d = (detail ?? "").replace(/\s+/g, " ").trim();
  const c = (choice ?? "").trim();
  const text = c && d ? `${c} — ${d}` : c || d;
  return text ? text.slice(0, CHAT_REPORT_REASON_MAX) : null;
}
