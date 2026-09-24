import { createServer } from "node:http";
import { config, log } from "./config";
import { listen, pool } from "./db";
import { processNotifications } from "./notifications";

const state = { lastTick: 0, lastNotify: 0, ticks: 0, errors: 0 };

async function dispatchTick() {
  try {
    const { rows } = await pool.query<{ r: Record<string, number> }>("select private.dispatch_tick() as r");
    const r = rows[0]?.r ?? {};
    state.lastTick = Date.now();
    state.ticks++;
    if (r.waves || r.escalated || r.no_driver) log("info", "dispatch tick", r);
    if (r.waves || r.escalated) void processNotifications();
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

async function main() {
  log("info", "rydar worker starting", { tickMs: config.dispatchTickMs, dryRun: config.dryRun, fcm: !!config.fcmServiceAccount, apns: !!config.apns });
  const stop = await listen("rydar_notifications", () => {
    state.lastNotify = Date.now();
    void processNotifications();
  });
  const timers = [
    setInterval(dispatchTick, config.dispatchTickMs),
    setInterval(() => void processNotifications(), config.notificationPollMs),
    setInterval(housekeeping, config.housekeepingMs),
  ];
  void processNotifications();

  const health = createServer((req, res) => {
    const healthy = Date.now() - state.lastTick < config.dispatchTickMs * 5;
    res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ healthy, ...state }));
  }).listen(config.healthPort);

  const shutdown = async () => {
    log("info", "shutting down");
    timers.forEach(clearInterval);
    health.close();
    await stop();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
