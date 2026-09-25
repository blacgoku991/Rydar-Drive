// Tâche « vols » : private.flights_to_check(n) → fournisseur (concurrence limitée, cache, délai max)
// → private.apply_flight_status(...). Une erreur fournisseur est journalisée sans interrompre le lot :
// la course a été réservée (flight_checked_at) et revient au créneau suivant (5 ou 30 min).
import type { ApplyFlightStatusResult } from "@rydar/shared";
import { airportFromAddress, normalizeInfo, type FlightContext, type FlightMode, type FlightProvider } from "./types";

export type QueryFn = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
type Log = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;

export type FlightRow = {
  id: string;
  organization_id: string;
  number: string;
  flight_number: string;
  flight_date: string;
  mode: FlightMode;
  timezone: string;
  pickup_at: Date | string;
  flight_status: string | null;
  flight_scheduled_arrival: Date | string | null;
};

type RideContext = { id: string; pickup_address: string | null; dropoff_address: string | null; requested_at: Date | string | null; buffer: number | null };

export type FlightTickStats = { checked: number; updated: number; shifted: number; notified: number; notFound: number; errors: number; skipped: number };

/** Colonnes de la réservation ; `date` et `bigint` en texte (node-postgres convertirait la date en minuit local). */
export const FLIGHTS_TO_CHECK_SQL = `select id, organization_id, number::text as number, flight_number, flight_date::text as flight_date,
  mode, timezone, pickup_at, flight_status, flight_scheduled_arrival from private.flights_to_check($1)`;

export const APPLY_FLIGHT_SQL = `select private.apply_flight_status($1::uuid, $2, $3::timestamptz, $4::timestamptz, $5::timestamptz, $6, $7, $8, $9) as r`;

const CONTEXT_SQL = `select r.id, r.pickup_address, r.dropoff_address, coalesce(r.pickup_at_original, r.pickup_at) as requested_at,
  s.flight_pickup_buffer_minutes as buffer
  from public.rides r left join public.organization_settings s on s.organization_id = r.organization_id
  where r.id = any($1::uuid[])`;

/** Exécute fn sur chaque élément avec au plus `limit` appels simultanés. */
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

const iso = (v: Date | string | null | undefined) => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString());

export type FlightJobOptions = { query: QueryFn; provider: FlightProvider; batch?: number; concurrency?: number; log?: Log };

export function flightJob(opts: FlightJobOptions) {
  const { query, provider } = opts;
  const log: Log = opts.log ?? (() => undefined);
  const abort = new AbortController();
  let running = false;
  let stopping = false;

  async function contexts(rows: FlightRow[]): Promise<Map<string, RideContext>> {
    try {
      const { rows: ctx } = await query<RideContext>(CONTEXT_SQL, [rows.map((r) => r.id)]);
      return new Map(ctx.map((c) => [c.id, c]));
    } catch (error) {
      log("warn", "flight context failed", { error: (error as Error).message });
      return new Map();
    }
  }

  async function checkOne(row: FlightRow, c: RideContext | undefined, stats: FlightTickStats) {
    if (stopping) {
      stats.skipped++;
      return;
    }
    const airportAddress = (row.mode === "arrival" ? c?.pickup_address : c?.dropoff_address) ?? null;
    const ctx: FlightContext = {
      mode: row.mode,
      airport: airportFromAddress(airportAddress),
      airportAddress,
      knownScheduled: iso(row.flight_scheduled_arrival),
      requestedAt: iso(c?.requested_at ?? row.pickup_at),
      bufferMinutes: c?.buffer ?? 15,
      signal: abort.signal,
    };
    const tag = { ride: row.number, flight: row.flight_number, date: row.flight_date, mode: row.mode, provider: provider.name };
    let info;
    try {
      info = await provider.getFlightStatus(row.flight_number, row.flight_date, ctx);
    } catch (error) {
      stats.errors++;
      if (!stopping) log("warn", "flight lookup failed", { ...tag, error: (error as Error).message });
      return;
    }
    stats.checked++;
    if (!info) {
      // Introuvable : rien n'est écrit (un statut « inconnu » s'afficherait comme un vol à l'heure) ;
      // nouvel essai au créneau suivant.
      stats.notFound++;
      log("warn", "flight not found", tag);
      return;
    }
    const n = normalizeInfo(info, row.mode);
    try {
      const { rows } = await query<{ r: ApplyFlightStatusResult }>(APPLY_FLIGHT_SQL, [
        row.id, n.status, n.scheduled, n.estimated, n.actual, n.terminal, n.origin, provider.name, row.flight_number,
      ]);
      const r = rows[0]?.r;
      if (!r?.ok) {
        if (r?.code !== "FLIGHT_CHANGED" && r?.code !== "RIDE_CLOSED") log("info", "flight not applied", { ...tag, code: r?.code });
        return;
      }
      if (r.code === "UPDATED") {
        stats.updated++;
        if (r.pickup_changed) stats.shifted++;
        if (r.notified) stats.notified++;
        log("info", "flight updated", {
          ...tag, status: r.flight_status, delay: r.delay_minutes, events: r.events, pickup_changed: r.pickup_changed,
          pickup_at: r.pickup_at, notified: r.notified,
        });
      }
    } catch (error) {
      stats.errors++;
      log("error", "apply_flight_status failed", { ...tag, error: (error as Error).message });
    }
  }

  /** Un passage (jamais deux en parallèle dans ce processus ; plusieurs workers : SKIP LOCKED). */
  async function tick(): Promise<FlightTickStats | null> {
    if (running || stopping) return null;
    running = true;
    const stats: FlightTickStats = { checked: 0, updated: 0, shifted: 0, notified: 0, notFound: 0, errors: 0, skipped: 0 };
    try {
      const { rows } = await query<FlightRow>(FLIGHTS_TO_CHECK_SQL, [opts.batch ?? 30]);
      if (!rows.length) return stats;
      const ctx = await contexts(rows);
      await mapLimit(rows, opts.concurrency ?? 3, (row) => checkOne(row, ctx.get(row.id), stats));
      if (stats.errors || stats.updated || stats.notFound) log("info", "flights checked", { ...stats, rides: rows.length, provider: provider.name });
      return stats;
    } finally {
      running = false;
    }
  }

  /** Arrêt : plus de nouvelle requête, requêtes en cours annulées. */
  function stop() {
    stopping = true;
    abort.abort();
  }

  return { tick, stop, provider };
}
