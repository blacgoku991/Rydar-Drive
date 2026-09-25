// AeroDataBox (https://aerodatabox.com) — « Flight Status (single day) » par numéro de vol.
//   RapidAPI   : https://aerodatabox.p.rapidapi.com  (en-têtes X-RapidAPI-Key + X-RapidAPI-Host)
//   API.market : https://prod.api.market/api/v1/aedbx/aerodatabox  (en-tête x-api-market-key)
//   GET /flights/number/{numéro}/{dateLocal}?dateLocalRole=Both&withAircraftImage=false&withLocation=false
// Réponse : tableau de FlightContract { number, status, departure, arrival } ; 204 = aucun vol.
// Heures : { utc: "2026-09-25 14:05Z", local: "2026-09-25 16:05+02:00" } (scheduledTime, revisedTime,
// predictedTime, runwayTime). revisedTime devient l'heure réelle une fois le vol parti / arrivé.
import {
  closestTo,
  getJson,
  normalizeInfo,
  normalizeStatus,
  referenceTime,
  requestSignal,
  toIso,
  type FetchLike,
  type FlightContext,
  type FlightInfo,
  type FlightProvider,
} from "./types";

type AdbTime = { utc?: string | null; local?: string | null } | null | undefined;
type AdbAirport = { iata?: string | null; icao?: string | null; name?: string | null; shortName?: string | null; municipalityName?: string | null; timeZone?: string | null };
type AdbMovement = {
  airport?: AdbAirport | null;
  scheduledTime?: AdbTime;
  revisedTime?: AdbTime;
  predictedTime?: AdbTime;
  runwayTime?: AdbTime;
  terminal?: string | null;
  // Anciennes versions de l'API (v1.0)
  scheduledTimeUtc?: string | null;
  actualTimeUtc?: string | null;
};
export type AdbFlight = { number?: string; status?: string; departure?: AdbMovement | null; arrival?: AdbMovement | null; codeshareStatus?: string };

export type AeroDataBoxOptions = {
  key: string;
  /** rapidapi (défaut) ou apimarket */
  marketplace?: "rapidapi" | "apimarket";
  /** Remplace l'URL de base (proxy, autre place de marché). */
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
};

const RAPIDAPI_HOST = "aerodatabox.p.rapidapi.com";
const APIMARKET_URL = "https://prod.api.market/api/v1/aedbx/aerodatabox";

export function aerodataboxRequest(opts: AeroDataBoxOptions, flightNumber: string, date: string) {
  const market = opts.marketplace ?? (opts.baseUrl?.includes("api.market") ? "apimarket" : "rapidapi");
  const base = (opts.baseUrl ?? (market === "apimarket" ? APIMARKET_URL : `https://${RAPIDAPI_HOST}`)).replace(/\/$/, "");
  // « Both » (recommandé par AeroDataBox) : départ OU arrivée ce jour-là ; le bon tronçon est choisi ensuite
  const url = `${base}/flights/number/${encodeURIComponent(flightNumber)}/${date}?dateLocalRole=Both&withAircraftImage=false&withLocation=false`;
  const headers: Record<string, string> =
    market === "apimarket" ? { "x-api-market-key": opts.key } : { "X-RapidAPI-Key": opts.key, "X-RapidAPI-Host": new URL(base).host };
  return { url, headers };
}

const utc = (t: AdbTime) => toIso(t?.utc ?? null);

function place(a: AdbAirport | null | undefined): string | null {
  if (!a) return null;
  const name = a.municipalityName || a.shortName || a.name || null;
  if (name && a.iata) return `${name} (${a.iata})`;
  return name || a.iata || a.icao || null;
}

/** Choisit le tronçon (aéroport de la course, horaire le plus proche) et le convertit. */
export function parseAeroDataBox(json: unknown, date: string, ctx: FlightContext = {}): FlightInfo | null {
  const flights = (Array.isArray(json) ? json : []) as AdbFlight[];
  if (!flights.length) return null;
  const mode = ctx.mode ?? "arrival";
  const side = (f: AdbFlight) => (mode === "arrival" ? f.arrival : f.departure) ?? undefined;
  const scheduledOf = (f: AdbFlight) => utc(side(f)?.scheduledTime) ?? toIso(side(f)?.scheduledTimeUtc);

  const airport = ctx.airport?.toUpperCase();
  const atAirport = airport ? flights.filter((f) => side(f)?.airport?.iata?.toUpperCase() === airport) : [];
  const f = closestTo(atAirport.length ? atAirport : flights, scheduledOf, referenceTime(date, ctx));
  if (!f) return null;
  const m = side(f) ?? {};
  const other = mode === "arrival" ? f.departure : f.arrival;

  const status = normalizeStatus(f.status);
  const revised = utc(m.revisedTime) ?? toIso(m.actualTimeUtc);
  const estimated = revised ?? utc(m.predictedTime);
  // Heure réelle : arrivée (mode arrivée) une fois « Arrived », départ (mode départ) une fois parti
  const done = mode === "arrival" ? status === "landed" : status === "departed" || status === "landed";
  const actual = done ? revised ?? utc(m.runwayTime) : null;

  return normalizeInfo(
    { status, scheduled: scheduledOf(f), estimated, actual, terminal: m.terminal ?? null, origin: place(other?.airport) },
    mode,
  );
}

export function aerodataboxProvider(opts: AeroDataBoxOptions): FlightProvider {
  const fetchImpl = opts.fetch ?? fetch;
  return {
    name: "aerodatabox",
    async getFlightStatus(flightNumber, date, ctx = {}) {
      const { url, headers } = aerodataboxRequest(opts, flightNumber, date);
      const json = await getJson(fetchImpl, url, headers, requestSignal(opts.timeoutMs ?? 5000, ctx.signal));
      return json == null ? null : parseAeroDataBox(json, date, ctx);
    },
  };
}
