// Suivi des vols : types communs aux fournisseurs et fonctions de normalisation (pures, testées).
import type { FlightMode, FlightStatus } from "@rydar/shared";

export type { FlightMode, FlightStatus };
export type FlightProviderName = "aerodatabox" | "aviationstack" | "flightaware" | "mock";

/**
 * Horaires d'un vol tels que private.apply_flight_status les attend :
 *  - mode « arrival » : ARRIVÉE du vol, origin = provenance ;
 *  - mode « departure » : DÉPART du vol (même champs), origin = destination.
 * Heures en ISO 8601 UTC (ou null si inconnues).
 */
export type FlightInfo = {
  status: FlightStatus;
  scheduled: string | null;
  estimated: string | null;
  actual: string | null;
  terminal: string | null;
  origin: string | null;
};

/** Contexte de la course (sert au choix du bon tronçon et au fournisseur « mock »). */
export type FlightContext = {
  /** arrival (défaut) : on attend le client à l'aéroport ; departure : il part en avion. */
  mode?: FlightMode;
  /** Code IATA de l'aéroport de la course (départ en arrival, destination en departure), si reconnu. */
  airport?: string | null;
  /** Adresse de l'aéroport de la course (terminal éventuel). */
  airportAddress?: string | null;
  /** Horaire prévu déjà connu (colonne flight_scheduled_arrival). */
  knownScheduled?: string | null;
  /** Heure demandée par le client (pickup_at_original, sinon pickup_at). */
  requestedAt?: string | null;
  /** Marge bagages de l'organisation (minutes). */
  bufferMinutes?: number | null;
  /** Annulation (arrêt du worker, délai maximal). */
  signal?: AbortSignal;
};

export interface FlightProvider {
  readonly name: FlightProviderName;
  /** null = vol introuvable chez le fournisseur ; exception = erreur (réseau, quota, clé…). */
  getFlightStatus(flightNumber: string, date: string, ctx?: FlightContext): Promise<FlightInfo | null>;
}

/** Erreur d'un fournisseur (HTTP, quota, format). */
export class FlightProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "FlightProviderError";
  }
}

// ----------------------------------------------------------------- normalisation

/** « af 1234 » → « AF1234 » (comme private.flights_to_check). */
export function normalizeFlightNumber(n: string): string {
  return n.replace(/\s+/g, "").toUpperCase();
}

/**
 * Statut canonique à partir des vocabulaires fournisseurs (AeroDataBox, aviationstack, AeroAPI).
 * Le SQL normalise aussi, mais le worker connaît mieux les libellés propres à chaque API.
 */
export function normalizeStatus(raw: unknown): FlightStatus {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (/cancel+ed\s*uncertain|canceleduncertain/.test(s)) return "unknown";
  if (/cancel/.test(s)) return "cancelled";
  if (/divert|redirect/.test(s)) return "diverted";
  if (/arriv|landed/.test(s)) return "landed";
  if (/en[\s_-]?route|airborne|departed|active|in[\s_-]?air|approach|in[\s_-]?flight|left gate|taxi/.test(s)) return "departed";
  if (/delay/.test(s)) return "delayed";
  if (/sched|expected|on[\s_-]?time|check[\s_-]?in|boarding|gate[\s_-]?closed|planned/.test(s)) return "scheduled";
  return "unknown";
}

/** ISO UTC valide ou null (accepte « 2026-09-25 14:05Z » d'AeroDataBox). */
export function toIso(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  const s = String(v).trim().replace(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/, "$1T$2");
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Décalage (ms) du fuseau `timeZone` à l'instant `utcMs` (heure locale − UTC). */
export function zoneOffsetMs(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Heure « murale » (sans fuseau fiable, ex. « 2026-09-25T14:05:00+00:00 » d'aviationstack qui est en
 * réalité l'heure locale de l'aéroport) → ISO UTC, dans le fuseau IANA donné.
 */
export function wallTimeToIso(wall: unknown, timeZone: string | null | undefined): string | null {
  if (wall == null || wall === "") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(wall).trim());
  if (!m) return toIso(wall);
  const guess = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  if (!timeZone) return new Date(guess).toISOString();
  try {
    // Deux passes : exact y compris autour des changements d'heure
    let utc = guess - zoneOffsetMs(timeZone, guess);
    utc = guess - zoneOffsetMs(timeZone, utc);
    return new Date(utc).toISOString();
  } catch {
    return new Date(guess).toISOString();
  }
}

/** Date locale « AAAA-MM-JJ » d'un instant dans un fuseau. */
export function localDate(iso: string | number | Date, timeZone = "Europe/Paris"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** « Terminal 2E » / « T2E » / « 2e » → « 2E » (l'affichage ajoute « T »). */
export function normalizeTerminal(t: unknown): string | null {
  if (t == null) return null;
  const s = String(t).trim().replace(/^terminal\s*/i, "").replace(/^t(?=\s*\d)/i, "").trim().toUpperCase();
  return s ? s.slice(0, 20) : null;
}

/** Nettoie une réponse fournisseur : ISO valides, terminal court, provenance ≤ 60 caractères, statut cohérent. */
export function normalizeInfo(info: FlightInfo, mode: FlightMode = "arrival"): FlightInfo {
  const out: FlightInfo = {
    status: normalizeStatus(info.status),
    scheduled: toIso(info.scheduled),
    estimated: toIso(info.estimated),
    actual: toIso(info.actual),
    terminal: normalizeTerminal(info.terminal),
    origin: info.origin ? String(info.origin).trim().slice(0, 60) || null : null,
  };
  // Heure réelle connue : arrivé (mode arrivée) / parti (mode départ), sauf annulation/déroutement
  if (out.actual && !["cancelled", "diverted"].includes(out.status)) {
    if (mode === "arrival") out.status = "landed";
    else if (out.status !== "landed") out.status = "departed";
  }
  return out;
}

// ----------------------------------------------------------------- aéroports

/** Aéroports reconnus dans une adresse (pour choisir le bon tronçon d'un vol multi-escales). */
const AIRPORTS: { iata: string; re: RegExp }[] = [
  { iata: "CDG", re: /charles[\s-]+de[\s-]+gaulle|roissy|\bcdg\b/i },
  { iata: "ORY", re: /\borly\b|\bory\b/i },
  { iata: "BVA", re: /beauvais|\bbva\b/i },
  { iata: "LBG", re: /bourget|\blbg\b/i },
  { iata: "NCE", re: /nice[\s-]+c[oô]te|\bnce\b/i },
  { iata: "MRS", re: /marseille[\s-]+provence|marignane|\bmrs\b/i },
  { iata: "LYS", re: /saint[\s-]+exup[eé]ry|\blys\b/i },
  { iata: "TLS", re: /blagnac|\btls\b/i },
  { iata: "BOD", re: /m[eé]rignac|\bbod\b/i },
  { iata: "NTE", re: /nantes[\s-]+atlantique|\bnte\b/i },
  { iata: "GVA", re: /gen[eè]ve[\s-]+(a[eé]roport|cointrin)|cointrin|\bgva\b/i },
];

export function airportFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  return AIRPORTS.find((a) => a.re.test(address))?.iata ?? null;
}

/** Terminal indiqué dans l'adresse (« Terminal 2E », « T4 »). */
export function terminalFromAddress(address: string | null | undefined): string | null {
  const m = /\bterminal\s*([0-9]{1,2}[A-G]?)\b|\bT([0-9][A-G]?)\b/i.exec(address ?? "");
  return m ? (m[1] ?? m[2] ?? "").toUpperCase() || null : null;
}

// ----------------------------------------------------------------- HTTP

/** Délai maximal par requête + arrêt du worker. */
export function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, t]) : t;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * GET JSON : 204 / 404 → null (vol introuvable), autre statut non 2xx → FlightProviderError
 * (avec le message du fournisseur quand il y en a un, jamais la clé).
 */
export async function getJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown | null> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: "application/json", ...headers }, signal });
  } catch (error) {
    const e = error as Error;
    throw new FlightProviderError(e.name === "TimeoutError" || e.name === "AbortError" ? "TIMEOUT" : e.message);
  }
  if (res.status === 204 || res.status === 404) return null;
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let detail = "";
    try {
      const j = JSON.parse(text) as { message?: string; error?: { message?: string; info?: string; code?: string } | string; detail?: string; title?: string };
      detail = typeof j.error === "string" ? j.error : j.error?.message ?? j.error?.info ?? j.message ?? j.detail ?? j.title ?? "";
    } catch {
      detail = text.slice(0, 120);
    }
    throw new FlightProviderError(`HTTP_${res.status}${detail ? `: ${detail}` : ""}`, res.status);
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new FlightProviderError("INVALID_JSON", res.status);
  }
}

/** Parmi plusieurs tronçons, celui dont l'horaire prévu est le plus proche de la référence. */
export function closestTo<T>(items: T[], at: (x: T) => string | null, reference: number): T | undefined {
  let best: T | undefined;
  let bestGap = Infinity;
  for (const x of items) {
    const iso = at(x);
    const gap = iso ? Math.abs(Date.parse(iso) - reference) : Infinity - 1;
    if (gap < bestGap) {
      best = x;
      bestGap = gap;
    }
  }
  return best ?? items[0];
}

/** Référence pour départager les tronçons : horaire connu, sinon heure demandée, sinon midi du jour du vol. */
export function referenceTime(date: string, ctx: FlightContext = {}): number {
  const known = ctx.knownScheduled ? Date.parse(ctx.knownScheduled) : Number.NaN;
  if (Number.isFinite(known)) return known;
  const requested = ctx.requestedAt ? Date.parse(ctx.requestedAt) : Number.NaN;
  if (Number.isFinite(requested)) {
    const buffer = (ctx.bufferMinutes ?? 15) * 60_000;
    return (ctx.mode ?? "arrival") === "arrival" ? requested - buffer : requested + 150 * 60_000;
  }
  return Date.parse(`${date}T12:00:00Z`);
}
