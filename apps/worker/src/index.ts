import { createServer } from "node:http";
import { config, log } from "./config";
import { listen, pool } from "./db";
import { selectFlightProvider, withCache } from "./flights";
import { flightJob, type QueryFn } from "./flights/job";
import { checkPushReceipts, processNotifications, stopNotifications } from "./notifications";

const state = {
  lastTick: 0,
  lastNotify: 0,
  ticks: 0,
  errors: 0,
  flights: { provider: null as string | null, reason: "", lastRun: 0, runs: 0, checked: 0, updated: 0, shifted: 0, notFound: 0, errors: 0 },
  watch: { lastRun: 0, runs: 0, last: null as Record<string, unknown> | null },
  documents: { lastRun: 0, last: null as Record<string, unknown> | null },
};

/** Travaux en cours (tick, envoi, accusés, ménage) : attendus à l'arrêt avant de fermer le pool. */
const inflight = new Set<Promise<unknown>>();
let stopping = false;
function run(job: () => Promise<unknown>) {
  if (stopping) return;
  const p = job().catch((error) => log("error", "job failed", { job: job.name, error: (error as Error).message }));
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
}

/** Une seule exécution à la fois par tâche : run() suit les travaux en cours mais n'empêche pas le chevauchement. */
function single(name: string, fn: () => Promise<unknown>) {
  let busy = false;
  const job = async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } finally {
      busy = false;
    }
  };
  Object.defineProperty(job, "name", { value: name });
  return job;
}

async function dispatchTick() {
  try {
    const { rows } = await pool.query<{ r: Record<string, number> }>("select private.dispatch_tick() as r");
    const r = rows[0]?.r ?? {};
    state.lastTick = Date.now();
    state.ticks++;
    if (r.waves || r.escalated || r.no_driver) log("info", "dispatch tick", r);
    if (r.waves || r.escalated) run(processNotifications);
  } catch (error) {
    state.errors++;
    log("error", "dispatch tick failed", { error: (error as Error).message });
  }
}

async function housekeeping() {
  try {
    const { rows } = await pool.query("select private.housekeeping() as r");
    log("info", "housekeeping", rows[0]?.r);
  } catch (error) {
    log("error", "housekeeping failed", { error: (error as Error).message });
  }
}

// ----------------------------------------------------------------- vols
const flightChoice = selectFlightProvider(process.env, config.flights.timeoutMs);
state.flights.provider = flightChoice.provider?.name ?? null;
state.flights.reason = flightChoice.reason;
const flights = flightChoice.provider
  ? flightJob({
      query: ((sql: string, params?: unknown[]) => pool.query(sql, params)) as QueryFn,
      provider: withCache(flightChoice.provider, config.flights.cacheMs),
      batch: config.flights.batch,
      concurrency: config.flights.concurrency,
      log,
    })
  : null;

/** Toutes les 60 s : horaires des vols → prise en charge recalée, journal, notification chauffeur. */
const flightCheck = single("flightCheck", async () => {
  if (!flights) return;
  try {
    const s = await flights.tick();
    if (!s) return;
    const f = state.flights;
    f.lastRun = Date.now();
    f.runs++;
    f.checked += s.checked;
    f.updated += s.updated;
    f.shifted += s.shifted;
    f.notFound += s.notFound;
    f.errors += s.errors;
    if (s.notified) run(processNotifications);
  } catch (error) {
    state.errors++;
    log("error", "flight check failed", { error: (error as Error).message });
  }
});

// ----------------------------------------------------------------- surveillance
type SqlSummary = Record<string, unknown> & { ok?: boolean; code?: string; opened?: number; resolved?: number; reminders?: number };

/** Toutes les 30 s : alertes retard / immobile / GPS muet / pas démarrée (verrou SQL : un seul passage à la fois). */
const watchRides = single("watchRides", async () => {
  try {
    const { rows } = await pool.query<{ r: SqlSummary }>("select private.watch_rides() as r");
    const r = rows[0]?.r ?? {};
    state.watch.lastRun = Date.now();
    state.watch.runs++;
    state.watch.last = r;
    if (r.opened || r.resolved) log("info", "watch rides", r);
  } catch (error) {
    state.errors++;
    log("error", "watch rides failed", { error: (error as Error).message });
  }
});

/** Au démarrage puis toutes les 6 h : documents échus, rappels d'échéance (idempotent, verrou SQL). */
const documentReminders = single("documentReminders", async () => {
  try {
    const { rows } = await pool.query<{ r: SqlSummary }>("select private.document_reminders() as r");
    const r = rows[0]?.r ?? {};
    state.documents.lastRun = Date.now();
    state.documents.last = r;
    log("info", "document reminders", r);
    if (r.reminders) run(processNotifications);
  } catch (error) {
    state.errors++;
    log("error", "document reminders failed", { error: (error as Error).message });
  }
});

/** Attente d'un travail en cours pendant l'arrêt : 1 s (LISTEN) + 8 s (tick / lot) + 1 s (pool) ≈ grâce de `docker stop`. */
const SHUTDOWN_TIMEOUT_MS = 8_000;
const RECEIPT_POLL_MS = 5_000;

/** true si p s'est terminée (même en erreur) avant ms. */
function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.then(() => true, () => true),
    new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms))),
  ]).finally(() => clearTimeout(timer));
}

async function main() {
  log("info", "rydar worker starting", {
    tickMs: config.dispatchTickMs,
    dryRun: config.dryRun,
    fcm: !!config.fcmServiceAccount,
    apns: !!config.apns,
    flights: flightChoice.provider?.name ?? "off",
    flightsReason: flightChoice.reason,
  });
  const stop = await listen("rydar_notifications", () => {
    state.lastNotify = Date.now();
    run(processNotifications);
  });
  const timers = [
    setInterval(() => run(dispatchTick), config.dispatchTickMs),
    setInterval(() => run(processNotifications), config.notificationPollMs),
    setInterval(() => run(checkPushReceipts), RECEIPT_POLL_MS),
    setInterval(() => run(housekeeping), config.housekeepingMs),
    setInterval(() => run(watchRides), config.watchRidesMs),
    setInterval(() => run(documentReminders), config.documentRemindersMs),
    ...(flights ? [setInterval(() => run(flightCheck), config.flights.pollMs)] : []),
  ];
  run(processNotifications);
  run(documentReminders);
  if (flights) run(flightCheck);

  const health = createServer((req, res) => {
    const healthy = !stopping && Date.now() - state.lastTick < config.dispatchTickMs * 5;
    res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ healthy, ...state }));
  }).listen(config.healthPort);

  let stoppingAt = 0;
  const shutdown = async (signal: string) => {
    if (stopping) {
      // `tsx watch` relaie Ctrl-C : deux SIGINT arrivent presque ensemble — seul un second appui force la sortie
      if (Date.now() - stoppingAt < 1_000) return;
      log("warn", "forced exit", { signal });
      process.exit(1);
    }
    stopping = true;
    stoppingAt = Date.now();
    log("info", "shutting down", { signal, inflight: inflight.size });
    timers.forEach(clearInterval);
    stopNotifications();
    flights?.stop();
    health.close();
    await within(stop(), 1_000);
    // On laisse finir le tick / le lot en cours (sinon notifications bloquées en « sending »).
    const drained = await within(Promise.allSettled([...inflight]), SHUTDOWN_TIMEOUT_MS);
    if (!drained) log("warn", "shutdown timeout, in-flight work abandoned", { inflight: inflight.size });
    // pool.end() attend la libération des connexions : bornée si une requête est restée bloquée.
    if (!(await within(pool.end(), 1_000))) log("warn", "pool end timeout");
    log("info", "stopped");
    process.exit(drained ? 0 : 1);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
