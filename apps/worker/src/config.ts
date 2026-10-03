// Configuration du worker (variables d'environnement).
import { webhookAllowPrivate } from "./webhooks/ssrf";

function num(name: string, fallback: number) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Modes TLS acceptés pour DATABASE_SSLMODE (kit VPS : verify-full par défaut, deploy/docker-compose.yml). */
export const DATABASE_SSL_MODES = ["verify-full", "no-verify", "disable"] as const;

/** Hôte d'une chaîne de connexion postgresql://utilisateur:mot-de-passe@hôte:port/base (sans crochets IPv6), "" si illisible. */
export function dbUrlHost(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(url)?.[1] ?? "";
  }
  return host.replace(/^\[|\]$/g, "").toLowerCase();
}

/**
 * Base « locale » (Supabase auto-hébergé sur ce serveur ou sur un réseau privé), seule autorisée sans chiffrement
 * (DATABASE_SSLMODE=disable) : localhost, 127.x, ::1, adresse privée (10.x, 172.16 à 172.31.x, 192.168.x) ou nom
 * sans point (conteneur Docker, ex. supavisor). Même règle que deploy/pg-url.sh (pg_local_host).
 */
export function isLocalDbHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((x) => x > 255)) return false;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/.test(h);
}

/**
 * DATABASE_URL avec le mode TLS imposé par DATABASE_SSLMODE (vide : chaîne inchangée) :
 *  - verify-full : certificat du serveur vérifié (nom compris) avec la racine DATABASE_CA_FILE (sslrootcert) —
 *    racine publique Supabase versionnée dans deploy/supabase-ca.crt ;
 *  - no-verify : ancien mode, chiffré SANS vérification (repli seulement, docs/DEPLOYMENT.md) ;
 *  - disable : sans chiffrement, pour une base locale seulement (Supabase auto-hébergé, isLocalDbHost) ; refusé
 *    pour une base distante.
 * Les sslmode / sslrootcert de la chaîne sont remplacés (le sslmode de l'URL l'emporte sur toute option `ssl` de pg).
 */
export function withSslMode(url: string, mode?: string, caFile?: string): string {
  const m = (mode || "").trim();
  if (!m) return url;
  if (!(DATABASE_SSL_MODES as readonly string[]).includes(m)) {
    throw new Error(`DATABASE_SSLMODE invalide : « ${m} » (attendu : verify-full, no-verify ou disable)`);
  }
  if (m === "disable" && !isLocalDbHost(dbUrlHost(url))) {
    throw new Error(
      "DATABASE_SSLMODE=disable refusé : base distante. Sans chiffrement, seulement une base sur ce serveur ou sur un réseau privé (Supabase auto-hébergé) ; sinon verify-full",
    );
  }
  const q = url.indexOf("?");
  const params = (q < 0 ? "" : url.slice(q + 1)).split("&").filter((p) => p && !/^(sslmode|sslrootcert)=/i.test(p));
  params.push(`sslmode=${m}`);
  if (m === "verify-full" && caFile) params.push(`sslrootcert=${encodeURIComponent(caFile)}`);
  return `${q < 0 ? url : url.slice(0, q)}?${params.join("&")}`;
}

/** Échec de la vérification du certificat de la base : indication de contrôle / repli ajoutée au journal. */
export function dbTlsHint(error: unknown): { hint?: string } {
  const msg = error instanceof Error ? error.message : String(error);
  return /certificate|self[- ]signed|altnames|sslrootcert|supabase-ca/i.test(msg)
    ? { hint: "certificat de la base non vérifié (DATABASE_SSLMODE=verify-full) : contrôle et repli dans docs/DEPLOYMENT.md, « Connexion chiffrée à la base »" }
    : {};
}

export const config = {
  databaseUrl: withSslMode(
    process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/rydar",
    process.env.DATABASE_SSLMODE,
    process.env.DATABASE_CA_FILE,
  ),
  /** Mode TLS imposé (journal de démarrage) ; vide = celui de DATABASE_URL. */
  databaseSslMode: (process.env.DATABASE_SSLMODE || "").trim(),
  dispatchTickMs: num("DISPATCH_TICK_MS", 2000),
  /** Sans tick de dispatch réussi depuis ce délai : sortie en erreur, relance par Docker (index.ts ; WORKER_WATCHDOG=0 : coupé). */
  watchdogMs: num("WORKER_WATCHDOG_MS", 120_000),
  notificationPollMs: num("NOTIFICATION_POLL_MS", 3000),
  housekeepingMs: num("HOUSEKEEPING_MS", 5 * 60_000),
  /** Surveillance des courses en cours (retard, immobile, GPS muet, pas démarrée) : private.watch_rides(). */
  watchRidesMs: num("WATCH_RIDES_MS", 30_000),
  /** Chauffeurs en ligne dont l'app est fermée (ni position ni signe de vie depuis 3 min) → hors ligne, private.watch_driver_gps(). */
  watchDriverGpsMs: num("WATCH_DRIVER_GPS_MS", 30_000),
  /** Échéances des documents chauffeur (au démarrage puis toutes les 6 h) : private.document_reminders(). */
  documentRemindersMs: num("DOCUMENT_REMINDERS_MS", 6 * 3600_000),
  /** Mode centrale : relance des commissions en retard (au démarrage puis toutes les 15 min) : private.settlement_reminders(). */
  settlementRemindersMs: num("SETTLEMENT_REMINDERS_MS", 15 * 60_000),
  /** Suppressions de compte chauffeur à terminer (fichiers, compte de connexion) : account-deletions.ts, toutes les 5 min. */
  accountDeletionsMs: num("ACCOUNT_DELETIONS_MS", 5 * 60_000),
  /**
   * API Supabase avec la clé service role (Storage, administration d'Auth) : REQUISE en production. Sans elle, la file
   * des suppressions de compte n'est jamais reprise (échecs de la route web, rattrapage des anciennes suppressions) :
   * erreur au démarrage puis toutes les heures tant qu'elle n'est pas vide (account-deletions.ts).
   */
  supabase: {
    url: (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, ""),
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "",
  },
  /** Suivi des vols (fournisseur : voir flights/index.ts, FLIGHT_PROVIDER). */
  flights: {
    pollMs: num("FLIGHT_POLL_MS", 60_000),
    batch: num("FLIGHT_BATCH", 30),
    concurrency: num("FLIGHT_CONCURRENCY", 3),
    timeoutMs: num("FLIGHT_TIMEOUT_MS", 5_000),
    cacheMs: num("FLIGHT_CACHE_MS", 120_000),
  },
  batchSize: num("NOTIFICATION_BATCH", 200),
  /**
   * Webhooks sortants (webhooks.ts) : URL publique du site pour le lien « self » des courses, comme l'API v1 (APP_URL,
   * à défaut NEXT_PUBLIC_APP_URL ; deploy/docker-compose.yml : https://DOMAIN). WEBHOOK_ALLOW_PRIVATE_URLS=1 : adresses
   * internes et http:// acceptées, pour les tests et le développement SEULEMENT (jamais en production : SSRF).
   */
  webhooks: {
    appUrl: (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").trim().replace(/\/+$/, ""),
    /** false : lien « self » vers localhost (avertissement au démarrage). */
    appUrlConfigured: !!(process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL),
    allowPrivateUrls: webhookAllowPrivate(process.env),
  },
  /** Relances WhatsApp (API WhatsApp Business Cloud) : identifiants par expéditeur en base, voir docs/WHATSAPP.md. */
  whatsapp: {
    batch: num("WHATSAPP_BATCH", 20),
    apiVersion: process.env.WHATSAPP_API_VERSION || undefined,
  },
  healthPort: num("HEALTH_PORT", 8080),
  /**
   * Expéditeur d'e-mails (dist/mailer.js, service « mailer » du kit VPS) : file public.email_outbox → SMTP
   * (réglages SMTP_* et MAIL_FROM : email/smtp.ts). Réveil par LISTEN rydar_emails, sondage de secours toutes les
   * MAIL_POLL_MS. Point de santé sur 127.0.0.1 seulement : MAILER_HEALTH_PORT, à défaut HEALTH_PORT (celui que lit le
   * HEALTHCHECK de l'image), sinon 8081.
   */
  mailer: {
    pollMs: num("MAIL_POLL_MS", 10_000),
    healthPort: num("MAILER_HEALTH_PORT", num("HEALTH_PORT", 8081)),
  },
  expoAccessToken: process.env.EXPO_ACCESS_TOKEN || undefined,
  fcmServiceAccount: process.env.FCM_SERVICE_ACCOUNT_B64
    ? (JSON.parse(Buffer.from(process.env.FCM_SERVICE_ACCOUNT_B64, "base64").toString("utf8")) as { project_id: string; client_email: string; private_key: string })
    : null,
  apns: process.env.APNS_KEY_P8_B64
    ? {
        key: Buffer.from(process.env.APNS_KEY_P8_B64, "base64").toString("utf8"),
        keyId: process.env.APNS_KEY_ID || "",
        teamId: process.env.APNS_TEAM_ID || "",
        bundleId: process.env.APNS_BUNDLE_ID || "app.rydar.driver",
        production: process.env.APNS_PRODUCTION !== "false",
      }
    : null,
  dryRun: process.env.PUSH_DRY_RUN === "true",
};

export const log = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  (level === "error" ? console.error : console.log)(line);
};
