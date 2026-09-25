// aviationstack (https://aviationstack.com, APILayer) — vols en temps réel.
//   GET https://api.aviationstack.com/v1/flights?access_key=…&flight_iata=AF1234&limit=20
//   (HTTPS réservé aux offres payantes : AVIATIONSTACK_URL=http://api.aviationstack.com/v1 sur l'offre gratuite)
// Réponse : { data: [{ flight_date, flight_status, departure: {...}, arrival: {...}, flight: { iata } }] }
//   departure / arrival : airport, timezone, iata, terminal, gate, delay, scheduled, estimated, actual,
//   estimated_runway, actual_runway ; flight_status : scheduled | active | landed | cancelled | incident | diverted.
// Les heures portent « +00:00 » mais sont l'heure LOCALE de l'aéroport (fuseau dans `timezone`) :
// converties par défaut (AVIATIONSTACK_TIMES=utc pour les prendre telles quelles).
// Erreurs : { error: { code, message } }.
import {
  closestTo,
  FlightProviderError,
  getJson,
  normalizeInfo,
  normalizeStatus,
  referenceTime,
  requestSignal,
  toIso,
  wallTimeToIso,
  type FetchLike,
  type FlightContext,
  type FlightInfo,
  type FlightProvider,
} from "./types";

type AsMovement = {
  airport?: string | null;
  timezone?: string | null;
  iata?: string | null;
  terminal?: string | null;
  scheduled?: string | null;
  estimated?: string | null;
  actual?: string | null;
  estimated_runway?: string | null;
  actual_runway?: string | null;
};
export type AsFlight = { flight_date?: string; flight_status?: string; departure?: AsMovement | null; arrival?: AsMovement | null; flight?: { iata?: string | null } };

export type AviationstackOptions = {
  key: string;
  baseUrl?: string;
  /** local (défaut) : heures locales de l'aéroport malgré « +00:00 » ; utc : ISO pris tel quel. */
  times?: "local" | "utc";
  timeoutMs?: number;
  fetch?: FetchLike;
};

export function aviationstackUrl(opts: Pick<AviationstackOptions, "key" | "baseUrl">, flightNumber: string) {
  const base = (opts.baseUrl ?? "https://api.aviationstack.com/v1").replace(/\/$/, "");
  const q = new URLSearchParams({ access_key: opts.key, flight_iata: flightNumber, limit: "20" });
  return `${base}/flights?${q}`;
}

export function parseAviationstack(json: unknown, date: string, ctx: FlightContext = {}, times: "local" | "utc" = "local"): FlightInfo | null {
  const body = (json ?? {}) as { data?: AsFlight[]; error?: { code?: string; message?: string; info?: string } };
  if (body.error) throw new FlightProviderError(`${body.error.code ?? "ERROR"}: ${body.error.message ?? body.error.info ?? ""}`.trim());
  const flights = Array.isArray(body.data) ? body.data : [];
  if (!flights.length) return null;
  const mode = ctx.mode ?? "arrival";
  const side = (f: AsFlight) => (mode === "arrival" ? f.arrival : f.departure) ?? undefined;
  const at = (m: AsMovement | undefined, v: string | null | undefined) => (times === "utc" ? toIso(v) : wallTimeToIso(v, m?.timezone));

  // Le jour du vol (±1 j : flight_date = date de départ locale), puis l'aéroport de la course
  const day = Date.parse(`${date}T00:00:00Z`);
  const near = flights.filter((f) => !f.flight_date || Math.abs(Date.parse(`${f.flight_date}T00:00:00Z`) - day) <= 86_400_000);
  const pool = near.length ? near : flights;
  const airport = ctx.airport?.toUpperCase();
  const atAirport = airport ? pool.filter((f) => side(f)?.iata?.toUpperCase() === airport) : [];
  const f = closestTo(atAirport.length ? atAirport : pool, (x) => at(side(x), side(x)?.scheduled), referenceTime(date, ctx));
  if (!f) return null;
  const m = side(f);
  const other = mode === "arrival" ? f.departure : f.arrival;

  const status = normalizeStatus(f.flight_status);
  const actual = at(m, m?.actual) ?? at(m, m?.actual_runway);
  return normalizeInfo(
    {
      status,
      scheduled: at(m, m?.scheduled),
      estimated: at(m, m?.estimated) ?? at(m, m?.estimated_runway),
      // « landed » sans heure réelle (fréquent sur l'offre gratuite) : estimée à défaut
      actual: actual ?? (status === "landed" && mode === "arrival" ? at(m, m?.estimated) : null),
      terminal: m?.terminal ?? null,
      origin: other?.airport ? (other.iata ? `${other.airport} (${other.iata})` : other.airport) : other?.iata ?? null,
    },
    mode,
  );
}

export function aviationstackProvider(opts: AviationstackOptions): FlightProvider {
  const fetchImpl = opts.fetch ?? fetch;
  return {
    name: "aviationstack",
    async getFlightStatus(flightNumber, date, ctx = {}) {
      const json = await getJson(fetchImpl, aviationstackUrl(opts, flightNumber), {}, requestSignal(opts.timeoutMs ?? 5000, ctx.signal));
      return json == null ? null : parseAviationstack(json, date, ctx, opts.times ?? "local");
    },
  };
}
