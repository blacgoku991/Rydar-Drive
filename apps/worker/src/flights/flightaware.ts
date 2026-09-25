// FlightAware AeroAPI v4 (https://www.flightaware.com/aeroapi/).
//   GET https://aeroapi.flightaware.com/aeroapi/flights/{ident}?start=…&end=…   (en-tête x-apikey)
// Réponse : { flights: [{ ident, ident_iata, status, cancelled, diverted, origin, destination,
//   scheduled_out/off/on/in, estimated_out/off/on/in, actual_out/off/on/in (ISO UTC),
//   terminal_origin, terminal_destination, arrival_delay, departure_delay }] }
// « in » = au contact de la porte (arrivée), « on » = atterrissage ; « out » = départ porte, « off » = décollage.
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

type FaAirport = { code?: string | null; code_iata?: string | null; code_icao?: string | null; name?: string | null; city?: string | null; timezone?: string | null } | null;
export type FaFlight = {
  ident?: string;
  ident_iata?: string | null;
  status?: string | null;
  cancelled?: boolean;
  diverted?: boolean;
  origin?: FaAirport;
  destination?: FaAirport;
  terminal_origin?: string | null;
  terminal_destination?: string | null;
} & Partial<Record<`${"scheduled" | "estimated" | "actual"}_${"out" | "off" | "on" | "in"}`, string | null>>;

export type FlightAwareOptions = { key: string; baseUrl?: string; timeoutMs?: number; fetch?: FetchLike; now?: () => number };

const DAY = 86_400_000;

/** Fenêtre de recherche autour du jour du vol (AeroAPI : au plus ~2 jours dans le futur). */
export function flightawareUrl(opts: Pick<FlightAwareOptions, "baseUrl" | "now">, flightNumber: string, date: string) {
  const base = (opts.baseUrl ?? "https://aeroapi.flightaware.com/aeroapi").replace(/\/$/, "");
  const day = Date.parse(`${date}T00:00:00Z`);
  const now = (opts.now ?? Date.now)();
  const start = Math.max(day - DAY, now - 9 * DAY);
  const end = Math.min(day + 2 * DAY, now + 2 * DAY - 60_000);
  const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
  return `${base}/flights/${encodeURIComponent(flightNumber)}?start=${encodeURIComponent(iso(start))}&end=${encodeURIComponent(iso(Math.max(end, start + 3600_000)))}`;
}

function place(a: FaAirport | undefined): string | null {
  if (!a) return null;
  const name = a.city || a.name || null;
  const code = a.code_iata || a.code || null;
  if (name && code) return `${name} (${code})`;
  return name || code;
}

export function parseFlightAware(json: unknown, date: string, ctx: FlightContext = {}): FlightInfo | null {
  const flights = ((json ?? {}) as { flights?: FaFlight[] }).flights ?? [];
  if (!flights.length) return null;
  const mode = ctx.mode ?? "arrival";
  const airportOf = (f: FaFlight) => (mode === "arrival" ? f.destination : f.origin);
  const pick = (f: FaFlight, kind: "scheduled" | "estimated" | "actual") =>
    mode === "arrival" ? toIso(f[`${kind}_in`]) ?? toIso(f[`${kind}_on`]) : toIso(f[`${kind}_out`]) ?? toIso(f[`${kind}_off`]);

  const airport = ctx.airport?.toUpperCase();
  const atAirport = airport ? flights.filter((f) => [airportOf(f)?.code_iata, airportOf(f)?.code].some((c) => c?.toUpperCase() === airport)) : [];
  const f = closestTo(atAirport.length ? atAirport : flights, (x) => pick(x, "scheduled"), referenceTime(date, ctx));
  if (!f) return null;

  const landed = !!(f.actual_in || f.actual_on);
  const departed = !!(f.actual_out || f.actual_off);
  const status = f.cancelled ? "cancelled" : f.diverted ? "diverted" : landed ? "landed" : departed ? "departed" : normalizeStatus(f.status);
  return normalizeInfo(
    {
      status,
      scheduled: pick(f, "scheduled"),
      estimated: pick(f, "estimated"),
      actual: pick(f, "actual"),
      terminal: (mode === "arrival" ? f.terminal_destination : f.terminal_origin) ?? null,
      origin: place(mode === "arrival" ? f.origin : f.destination),
    },
    mode,
  );
}

export function flightawareProvider(opts: FlightAwareOptions): FlightProvider {
  const fetchImpl = opts.fetch ?? fetch;
  return {
    name: "flightaware",
    async getFlightStatus(flightNumber, date, ctx = {}) {
      const json = await getJson(fetchImpl, flightawareUrl(opts, flightNumber, date), { "x-apikey": opts.key }, requestSignal(opts.timeoutMs ?? 5000, ctx.signal));
      return json == null ? null : parseFlightAware(json, date, ctx);
    },
  };
}
