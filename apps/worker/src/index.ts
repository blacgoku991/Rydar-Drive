import { createServer } from "node:http";
import { accountDeletionStats, processAccountDeletions, supabaseApi } from "./account-deletions";
import { config, dbTlsHint, log } from "./config";
import { listen, pool } from "./db";
import { selectFlightProvider, withCache } from "./flights";
import { flightJob, type QueryFn } from "./flights/job";
import { createContactPurge, runHousekeeping, type QueryFn as HousekeepingQuery } from "./housekeeping";
import { checkPushReceipts, processNotifications, stopNotifications } from "./notifications";
import { createWebhookDispatcher, WEBHOOK_DRAIN_MS, WEBHOOK_POLL_MS, WEBHOOK_PURGE_MS } from "./webhooks";
import { processWhatsApp, stopWhatsApp } from "./whatsapp";

/**
 * Webhooks sortants des centrales (webhooks.ts) : file continue (5 envois en cours au plus, nouvelle réservation dès
 * qu'une place se libère), réveil par LISTEN rydar_webhooks, sondage toutes les 5 s, purge toutes les heures.
 * Fonctions SQL absentes (migration pas encore appliquée) : avertissement unique, sans erreur.
 */
const webhooks = createWebhookDispatcher({
  query: (sql, params) => pool.query(sql, params),
  appUrl: config.webhooks.appUrl,
  allowPrivate: config.webhooks.allowPrivateUrls,
});
async function processWebhooks() {
  await webhooks.process();
}
const purgeWebhooks = single("purgeWebhooks", webhooks.purge);

const state = {
  lastTick: 0,
  lastNotify: 0,
  ticks: 0,
  errors: 0,
  flights: { provider: null as string | null, reason: "", lastRun: 0, runs: 0, checked: 0, updated: 0, shifted: 0, notFound: 0, errors: 0 },
  watch: { lastRun: 0, runs: 0, last: null as Record<string, unknown> | null },
  documents: { lastRun: 0, last: null as Record<string, unknown> | null },
  settlements: { lastRun: 0, reminders: 0, last: null as Record<string, unknown> | null },
  deletions: accountDeletionStats,
  webhooks: webhooks.stats,
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

/**
 * Toutes les 2 s : vagues d'offres et relances ; un tick lent n'est pas doublé par le suivant (single). Par lots courts
 * (une transaction chacun) : les courses d'un lot restent verrouillées le temps du lot, pas de tout le tick (acceptation
 * et annulation n'attendent plus) ; on enchaîne tant qu'un lot est plein, 1,5 s au plus.
 */
const DISPATCH_BATCH = 20;
const dispatchTick = single("dispatchTick", async () => {
  try {
    const started = Date.now();
    const total: Record<string, number> = {};
    for (;;) {
      const { rows } = await pool.query<{ r: Record<string, number> }>("select private.dispatch_tick($1) as r", [DISPATCH_BATCH]);
      const r = rows[0]?.r ?? {};
      for (const [k, v] of Object.entries(r)) total[k] = (total[k] ?? 0) + (Number(v) || 0);
      if (r.waves || r.escalated) run(processNotifications);
      if ((r.processed ?? 0) < DISPATCH_BATCH || Date.now() - started > 1_500) break;
    }
    state.lastTick = Date.now();
    state.ticks++;
    if (total.waves || total.escalated || total.no_driver) log("info", "dispatch tick", total);
  } catch (error) {
    state.errors++;
    log("error", "dispatch tick failed", { error: (error as Error).message, ...dbTlsHint(error) });
  }
});

/**
 * Toutes les 30 s : application fermée (ni position ni signe de vie depuis 3 min) → chauffeur hors ligne, sans
 * notification. App ouverte, même en arrière-plan ou téléphone verrouillé, elle envoie sa position en continu.
 */
const watchDriverGps = single("watchDriverGps", async () => {
  try {
    const { rows } = await pool.query<{ r: { offline?: number } }>("select private.watch_driver_gps() as r");
    const r = rows[0]?.r ?? {};
    if (r.offline) log("info", "drivers offline (app closed)", r);
  } catch (error) {
    log("error", "watch driver gps failed", { error: (error as Error).message });
  }
});

/**
 * Toutes les 5 min : durées de conservation ; purge longue en échec (« errors ») → niveau warn (housekeeping.ts).
 * Puis formulaire de contact (demandes, e-mails) : appel séparé, jamais bloquant, toléré avant sa migration.
 */
const purgeContactData = createContactPurge();
const housekeeping = single("housekeeping", async () => {
  const query: HousekeepingQuery = (sql, params) => pool.query(sql, params);
  try {
    await runHousekeeping(query);
  } catch (error) {
    state.errors++;
    log("error", "housekeeping failed", { error: (error as Error).message });
  }
  await purgeContactData(query);
});

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

/** Mode centrale, au démarrage puis toutes les 15 min : relance des commissions en retard (1 / chauffeur / 24 h, 3 au plus). */
const settlementReminders = single("settlementReminders", async () => {
  try {
    const { rows } = await pool.query<{ r: SqlSummary }>("select private.settlement_reminders() as r");
    const r = rows[0]?.r ?? {};
    state.settlements.lastRun = Date.now();
    state.settlements.last = r;
    state.settlements.reminders += Number(r.reminders ?? 0);
    if (r.reminders) {
      log("info", "settlement reminders", r);
      run(processNotifications);
      run(processWhatsApp);
    }
  } catch (error) {
    state.errors++;
    log("error", "settlement reminders failed", { error: (error as Error).message });
  }
});

/**
 * Au démarrage puis toutes les 5 min : suppressions de compte chauffeur à terminer (dossier de stockage, compte de
 * connexion), reprises après un échec de la route web ; abandon au 10e essai (alerte).
 */
const accountDeletions = single("accountDeletions", async () => {
  try {
    await processAccountDeletions();
  } catch (error) {
    state.errors++;
    log("error", "account deletions failed", { error: (error as Error).message });
  }
});

/**
 * Attente d'un travail en cours pendant l'arrêt : 1 s (LISTEN) + 12 s (tick, lot, et surtout webhook en cours : un essai
 * de 10 s au plus, DNS compris, puis son résultat enregistré) + 1 s (pool) = 14 s, sous la grâce de `docker stop` du
 * worker (stop_grace_period: 20s, deploy/docker-compose.yml). Un webhook coupé par la sortie repartirait en double.
 */
const SHUTDOWN_TIMEOUT_MS = Math.max(8_000, WEBHOOK_DRAIN_MS);
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
    dbSsl: config.databaseSslMode || "url",
    dryRun: config.dryRun,
    fcm: !!config.fcmServiceAccount,
    apns: !!config.apns,
    flights: flightChoice.provider?.name ?? "off",
    flightsReason: flightChoice.reason,
    accountDeletions: supabaseApi() ? "on" : "off: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing",
    webhooksAppUrl: config.webhooks.appUrl,
  });
  if (!config.webhooks.appUrlConfigured && process.env.NODE_ENV === "production") {
    log("warn", "webhooks: APP_URL missing, ride links point to http://localhost:3000 (deploy/docker-compose.yml: APP_URL)");
  }
  if (config.webhooks.allowPrivateUrls) {
    log("warn", "webhooks: WEBHOOK_ALLOW_PRIVATE_URLS=1, internal addresses and http:// allowed (tests and development only, never in production)");
  }
  const stop = await listen(["rydar_notifications", "rydar_webhooks"], (_payload, channel) => {
    if (channel === "rydar_webhooks") {
      run(processWebhooks);
      return;
    }
    state.lastNotify = Date.now();
    run(processNotifications);
    run(processWhatsApp);
  });
  const timers = [
    setInterval(() => run(dispatchTick), config.dispatchTickMs),
    setInterval(() => run(processNotifications), config.notificationPollMs),
    setInterval(() => run(processWhatsApp), config.notificationPollMs),
    setInterval(() => run(checkPushReceipts), RECEIPT_POLL_MS),
    setInterval(() => run(housekeeping), config.housekeepingMs),
    setInterval(() => run(watchRides), config.watchRidesMs),
    setInterval(() => run(watchDriverGps), config.watchDriverGpsMs),
    setInterval(() => run(documentReminders), config.documentRemindersMs),
    setInterval(() => run(settlementReminders), config.settlementRemindersMs),
    setInterval(() => run(accountDeletions), config.accountDeletionsMs),
    setInterval(() => run(processWebhooks), WEBHOOK_POLL_MS),
    setInterval(() => run(purgeWebhooks), WEBHOOK_PURGE_MS),
    ...(flights ? [setInterval(() => run(flightCheck), config.flights.pollMs)] : []),
  ];
  run(processNotifications);
  run(processWhatsApp);
  run(processWebhooks);
  run(purgeWebhooks);
  run(documentReminders);
  run(settlementReminders);
  run(accountDeletions);
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
    stopWhatsApp();
    webhooks.stop();
    flights?.stop();
    health.close();
    await within(stop(), 1_000);
    // On laisse finir le tick / le lot en cours (sinon notifications bloquées en « sending ») et les webhooks en cours
    // (webhooks.stop() : plus aucun nouvel envoi ; résultat de chaque envoi parti enregistré avant pool.end()).
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
