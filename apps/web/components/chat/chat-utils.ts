// Utilitaires de la messagerie (sans dépendance client : utilisables par les actions serveur).
import { extractErrorCode, type ChatMessage, type ChatMessageRow, type ChatOverview, type ChatThreadKey } from "@rydar/shared";

export const FLEET_THREAD = "fleet" as const;
export const CHAT_MAX_LENGTH = 1000;
export const CHAT_PAGE_SIZE = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DriverThreadSummary = ChatOverview["drivers"][number] & {
  /** Téléphone (bouton « Appeler »), chargé à part : chat_overview ne le renvoie pas */
  phone?: string | null;
};

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
export const driverThread = (driverId: string) => `driver:${driverId}` as ChatThreadKey;
export const threadDriverId = (thread: string | null | undefined) =>
  thread && thread.startsWith("driver:") && isUuid(thread.slice(7)) ? thread.slice(7) : null;
export const isThreadKey = (v: unknown): v is ChatThreadKey => v === FLEET_THREAD || threadDriverId(v as string) !== null;

/** Ligne brute (RLS) → forme RPC / temps réel (clé de fil + signalement actif). */
export function toChatMessage(row: ChatMessageRow, now = Date.now()): ChatMessage {
  return {
    ...row,
    thread: row.channel === "fleet" ? "fleet" : driverThread(row.driver_id ?? ""),
    active: !!row.report_type && !!row.expires_at && new Date(row.expires_at).getTime() > now,
  };
}

/** URL d'un fil (contrat : ?driver=<id> | ?thread=fleet). */
export function threadHref(thread: ChatThreadKey | null) {
  if (!thread) return "/dashboard/messages";
  const id = threadDriverId(thread);
  return id ? `/dashboard/messages?driver=${id}` : "/dashboard/messages?thread=fleet";
}

const CHAT_ERRORS: Record<string, string> = {
  RATE_LIMITED: "Trop de messages d'affilée : patientez une minute avant de réécrire.",
  EMPTY_MESSAGE: "Le message est vide.",
  MESSAGE_TOO_LONG: `Message trop long (${CHAT_MAX_LENGTH} caractères maximum).`,
  INVALID_THREAD: "Conversation introuvable.",
  INVALID_CHANNEL: "Conversation introuvable.",
  FORBIDDEN_TENANT: "Ce chauffeur ne fait pas partie de votre flotte.",
  FORBIDDEN_ROLE: "Votre rôle ne permet pas d'écrire aux chauffeurs.",
};

/** Erreur PostgREST (« CODE: texte », PT429…) → phrase claire. */
export function chatErrorMessage(error: { code?: string; message?: string } | null | undefined, fallback = "Envoi impossible. Réessayez.") {
  const code = extractErrorCode(error?.message) ?? (error?.code === "PT429" ? "RATE_LIMITED" : null);
  if (code && CHAT_ERRORS[code]) return CHAT_ERRORS[code];
  if (code?.startsWith("FORBIDDEN") || error?.code === "42501") return "Accès refusé.";
  return fallback;
}

// ---------------------------------------------------------------- Dates (fuseau de l'organisation)
function dayKey(d: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function sameDay(a: string, b: string, timeZone: string) {
  return dayKey(new Date(a), timeZone) === dayKey(new Date(b), timeZone);
}

export function clockTime(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
}

/** Séparateur de jour : « Aujourd'hui », « Hier », « lundi 22 septembre ». */
export function dayLabel(iso: string, timeZone: string, now = Date.now()) {
  const d = new Date(iso);
  const key = dayKey(d, timeZone);
  if (key === dayKey(new Date(now), timeZone)) return "Aujourd'hui";
  if (key === dayKey(new Date(now - 86_400_000), timeZone)) return "Hier";
  const sameYear = key.slice(0, 4) === dayKey(new Date(now), timeZone).slice(0, 4);
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: sameYear ? undefined : "numeric", timeZone }).format(d);
}

/** Horodatage compact de la liste : « à l'instant », « 5 min », « 14:32 », « hier », « lun. », « 12/09 ». */
export function whenShort(iso: string | null | undefined, timeZone: string, now = Date.now()) {
  if (!iso) return "";
  const d = new Date(iso);
  const diff = now - d.getTime();
  if (diff < 60_000) return "à l'instant";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min`;
  const key = dayKey(d, timeZone);
  if (key === dayKey(new Date(now), timeZone)) return clockTime(iso, timeZone);
  if (key === dayKey(new Date(now - 86_400_000), timeZone)) return "hier";
  if (diff < 6 * 86_400_000) return new Intl.DateTimeFormat("fr-FR", { weekday: "short", timeZone }).format(d);
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", timeZone }).format(d);
}

/** « il y a 6 min », « il y a 2 h » */
export function ago(iso: string, now = Date.now()) {
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (m < 1) return "à l'instant";
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `il y a ${h} h` : `il y a ${Math.floor(h / 24)} j`;
}

/** Minutes restantes avant expiration (arrondi supérieur, 0 si échu). */
export function minutesLeft(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return 0;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 60_000));
}

/** Prénom seul (« Karim H. » → « Karim ») */
export const firstName = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] ?? "";

/** Tri de la liste (miroir de chat_overview) : dernier message, puis en ligne, puis numéro. */
export function sortDriverThreads<T extends DriverThreadSummary>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const ta = a.last_message ? new Date(a.last_message.created_at).getTime() : -Infinity;
    const tb = b.last_message ? new Date(b.last_message.created_at).getTime() : -Infinity;
    if (ta !== tb) return tb - ta;
    const oa = a.driver.presence !== "offline" ? 1 : 0;
    const ob = b.driver.presence !== "offline" ? 1 : 0;
    if (oa !== ob) return ob - oa;
    return a.driver.number - b.driver.number;
  });
}
