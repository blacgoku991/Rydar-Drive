// Configuration du worker (variables d'environnement).
function num(name: string, fallback: number) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/rydar",
  dispatchTickMs: num("DISPATCH_TICK_MS", 2000),
  notificationPollMs: num("NOTIFICATION_POLL_MS", 3000),
  housekeepingMs: num("HOUSEKEEPING_MS", 5 * 60_000),
  /** Surveillance des courses en cours (retard, immobile, GPS muet, pas démarrée) : private.watch_rides(). */
  watchRidesMs: num("WATCH_RIDES_MS", 30_000),
  /** Échéances des documents chauffeur (au démarrage puis toutes les 6 h) : private.document_reminders(). */
  documentRemindersMs: num("DOCUMENT_REMINDERS_MS", 6 * 3600_000),
  /** Suivi des vols (fournisseur : voir flights/index.ts, FLIGHT_PROVIDER). */
  flights: {
    pollMs: num("FLIGHT_POLL_MS", 60_000),
    batch: num("FLIGHT_BATCH", 30),
    concurrency: num("FLIGHT_CONCURRENCY", 3),
    timeoutMs: num("FLIGHT_TIMEOUT_MS", 5_000),
    cacheMs: num("FLIGHT_CACHE_MS", 120_000),
  },
  batchSize: num("NOTIFICATION_BATCH", 200),
  healthPort: num("HEALTH_PORT", 8080),
  expoAccessToken: process.env.EXPO_ACCESS_TOKEN || undefined,
  fcmServiceAccount: process.env.FCM_SERVICE_ACCOUNT_B64
    ? (JSON.parse(Buffer.from(process.env.FCM_SERVICE_ACCOUNT_B64, "base64").toString("utf8")) as { project_id: string; client_email: string; private_key: string })
    : null,
  apns: process.env.APNS_KEY_P8_B64
    ? {
        key: Buffer.from(process.env.APNS_KEY_P8_B64, "base64").toString("utf8"),
        keyId: process.env.APNS_KEY_ID ?? "",
        teamId: process.env.APNS_TEAM_ID ?? "",
        bundleId: process.env.APNS_BUNDLE_ID ?? "app.rydar.driver",
        production: process.env.APNS_PRODUCTION !== "false",
      }
    : null,
  dryRun: process.env.PUSH_DRY_RUN === "true",
};

export const log = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  (level === "error" ? console.error : console.log)(line);
};
