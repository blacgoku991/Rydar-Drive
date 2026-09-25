import { createServer } from "node:http";
import { config, log } from "./config";
import { listen, pool } from "./db";
import { checkPushReceipts, processNotifications, stopNotifications } from "./notifications";

const state = { lastTick: 0, lastNotify: 0, ticks: 0, errors: 0 };

/** Travaux en cours (tick, envoi, accusés, ménage) : attendus à l'arrêt avant de fermer le pool. */
const inflight = new Set<Promise<unknown>>();
let stopping = false;
function run(job: () => Promise<unknown>) {
  if (stopping) return;
  const p = job().catch((error) => log("error", "job failed", { job: job.name, error: (error as Error).message }));
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
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
  log("info", "rydar worker starting", { tickMs: config.dispatchTickMs, dryRun: config.dryRun, fcm: !!config.fcmServiceAccount, apns: !!config.apns });
  const stop = await listen("rydar_notifications", () => {
    state.lastNotify = Date.now();
    run(processNotifications);
  });
  const timers = [
    setInterval(() => run(dispatchTick), config.dispatchTickMs),
    setInterval(() => run(processNotifications), config.notificationPollMs),
    setInterval(() => run(checkPushReceipts), RECEIPT_POLL_MS),
    setInterval(() => run(housekeeping), config.housekeepingMs),
  ];
  run(processNotifications);

  const health = createServer((req, res) => {
    const healthy = !stopping && Date.now() - state.lastTick < config.dispatchTickMs * 5;
    res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ healthy, ...state }));
  }).listen(config.healthPort);

  const shutdown = async (signal: string) => {
    if (stopping) {
      log("warn", "forced exit", { signal });
      process.exit(1);
    }
    stopping = true;
    log("info", "shutting down", { signal, inflight: inflight.size });
    timers.forEach(clearInterval);
    stopNotifications();
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
