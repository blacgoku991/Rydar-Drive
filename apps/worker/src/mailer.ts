// Expéditeur d'e-mails de Rydar Drive (service « mailer » de deploy/docker-compose.yml, même image que le worker :
// node dist/mailer.js). Le site n'envoie rien lui-même : il écrit dans public.email_outbox (formulaire de contact :
// notification au super admin, accusé de réception, réponses, e-mail de test) ; ce processus lit la file et envoie en
// SMTP, par défaut au serveur mail du VPS sur 127.0.0.1:25 (email/smtp.ts).
//  - réveil immédiat par LISTEN rydar_emails (déclencheur après insertion), sondage de secours toutes les MAIL_POLL_MS ;
//  - un seul cycle à la fois (réservation SKIP LOCKED côté SQL : plusieurs expéditeurs possibles) ;
//  - serveur SMTP vérifié au démarrage, puis chaque minute tant qu'il est injoignable : pendant ce temps la file est en
//    pause (aucune tentative comptée, les e-mails ne passent jamais en échec pour une panne du serveur) ; dès qu'il
//    répond, et au démarrage, les e-mails en attente d'un nouvel essai sont relancés aussitôt ;
//  - état écrit en base toutes les 30 s (public.mailer_status : signe de vie, serveur SMTP joignable ou motif), lu
//    par /admin/contacts ;
//  - point de santé HTTP sur 127.0.0.1 seulement (le service tourne sur le réseau de l'hôte) : état de la base, du
//    serveur SMTP (« smtpReady »), dernier envoi réussi, dernière erreur ;
//  - journal sans objet, corps ni adresse complète (identifiant, type, domaine du destinataire).
import { createServer } from "node:http";
import { config, dbTlsHint, log } from "./config";
import { createPool, listen } from "./db";
import { redactAddresses, runMailCycle, type Outcome, type QueryFn } from "./email/outbox";
import { classifySmtpError, createSmtpSender, smtpSettings } from "./email/smtp";

const settings = smtpSettings(process.env);
const sender = createSmtpSender(settings);
// Une requête à la fois (un seul cycle, requêtes successives) : une connexion, plus celle du LISTEN, gardées ouvertes
// entre deux sondages — le pooler en mode session de Supabase compte chaque connexion
const pool = createPool("rydar-mailer", { max: 1, idleTimeoutMillis: 5 * 60_000, connectionTimeoutMillis: 15_000 });
const { pollMs, healthPort } = config.mailer;

/** Serveur SMTP indisponible : nouvelle vérification chaque minute (la file reprend dès qu'il répond). */
const SMTP_RECHECK_MS = 60_000;
/** État écrit en base (public.mailer_status) ; /admin/contacts signale un service arrêté au bout de 3 min sans nouvelles. */
const STATUS_EVERY_MS = 30_000;
/** Rappel au journal tant que le serveur SMTP ou la base restent indisponibles. */
const REMIND_EVERY_MS = 3600_000;
/** Attente du cycle en cours à l'arrêt (grâce de 10 s de `docker stop`). */
const SHUTDOWN_TIMEOUT_MS = 8_000;

const state = {
  startedAt: Date.now(),
  lastCycleAt: 0,
  lastNotifyAt: 0,
  db: { lastOkAt: 0, lastErrorAt: 0, lastError: null as string | null },
  smtp: {
    ready: null as boolean | null,
    /** Panne confirmée par une vérification (pas seulement un envoi en échec) : e-mails relancés à son retour. */
    confirmedDown: false,
    lastCheckAt: 0,
    lastSentAt: 0,
    lastErrorAt: 0,
    lastError: null as string | null,
    warnedAt: 0,
  },
  counters: { cycles: 0, sent: 0, retried: 0, failed: 0 },
};

let stopping = false;
let current: Promise<void> | null = null;
let again = false;
let checking = false;
let reporting: Promise<void> | null = null;
let reportAgain = false;

const iso = (ms: number) => (ms ? new Date(ms).toISOString() : null);

/**
 * Serveur SMTP utilisable ou non (vérification, envoi réussi, échec de connexion) : journal et état en base aux
 * changements ; de nouveau utilisable (ou au démarrage) : reprise de la file.
 */
function setSmtpReady(ready: boolean, error?: string) {
  const previous = state.smtp.ready;
  state.smtp.ready = ready;
  if (previous !== ready) reportStatus();
  if (ready) {
    if (previous !== true) {
      log("info", "smtp server ready", { host: settings.summary.host, port: settings.summary.port, tls: settings.summary.tls });
      // Démarrage, ou retour après une panne confirmée : e-mails en attente d'un nouvel essai relancés tout de suite.
      // Après un simple envoi en échec (serveur qui répond aux vérifications), les délais normaux s'appliquent.
      const requeue = previous === null || state.smtp.confirmedDown;
      state.smtp.confirmedDown = false;
      void resume(requeue);
    }
    return;
  }
  const now = Date.now();
  if (previous !== false || now - state.smtp.warnedAt >= REMIND_EVERY_MS) {
    state.smtp.warnedAt = now;
    log("warn", "smtp server unavailable: e-mails wait in the queue (docs/DEPLOYMENT.md, « E-mails : formulaire de contact »)", {
      host: settings.summary.host,
      port: settings.summary.port,
      error: error ? redactAddresses(error) : undefined,
    });
  }
}

function onOutcome(_email: unknown, outcome: Outcome) {
  if (outcome.ok) {
    state.counters.sent++;
    state.smtp.lastSentAt = Date.now();
    setSmtpReady(true);
    return;
  }
  if (outcome.final) state.counters.failed++;
  else state.counters.retried++;
  state.smtp.lastErrorAt = Date.now();
  state.smtp.lastError = redactAddresses(outcome.error);
  if (outcome.smtpDown) setSmtpReady(false, outcome.error);
}

/** Connexion + EHLO (+ STARTTLS, identifiants) + QUIT : au démarrage, puis chaque minute tant que ça échoue. */
async function checkSmtp() {
  if (checking || stopping) return;
  checking = true;
  try {
    await sender.verify();
    state.smtp.lastCheckAt = Date.now();
    setSmtpReady(true);
  } catch (error) {
    const c = classifySmtpError(error);
    state.smtp.lastCheckAt = state.smtp.lastErrorAt = Date.now();
    state.smtp.lastError = redactAddresses(c.message);
    state.smtp.confirmedDown = true;
    setSmtpReady(false, c.message);
  } finally {
    checking = false;
  }
}

/** Requête réussie : base joignable (tenu à jour pendant un long cycle, pour que la santé ne le prenne pas pour une panne). */
const query: QueryFn = async (sql, params) => {
  const result = await pool.query(sql, params);
  if (state.db.lastError) log("info", "database reachable again");
  state.db.lastOkAt = Date.now();
  state.db.lastError = null;
  return result;
};

/** Erreur de la base (cycle, état, relance) : journal au premier échec, à chaque nouveau motif, puis toutes les heures. */
function dbFailed(msg: string, error: unknown) {
  const message = redactAddresses((error as Error).message || String(error));
  const now = Date.now();
  if (message !== state.db.lastError || now - state.db.lastErrorAt >= REMIND_EVERY_MS) {
    log("error", msg, { error: message, ...dbTlsHint(error) });
    state.db.lastErrorAt = now;
  }
  state.db.lastError = message;
}

async function cycleOnce() {
  await runMailCycle({
    query,
    send: (email) => sender.send(email),
    classify: classifySmtpError,
    shouldStop: () => stopping,
    canSend: () => state.smtp.ready === true,
    onOutcome,
  });
  state.lastCycleAt = Date.now();
  state.counters.cycles++;
}

/**
 * Réveil (NOTIFY, sondage, reprise) : un seul cycle à la fois, relancé s'il y a eu un réveil entre-temps. Serveur SMTP
 * injoignable ou pas encore vérifié : rien (la vérification relance la file dès qu'il répond).
 */
function trigger() {
  if (stopping || state.smtp.ready !== true) return;
  if (current) {
    again = true;
    return;
  }
  current = (async () => {
    try {
      do {
        again = false;
        await cycleOnce();
      } while (again && !stopping);
    } catch (error) {
      // Les échecs d'envoi sont classés ligne à ligne : ici, la base (réservation ou enregistrement du résultat)
      dbFailed("mail cycle failed (database)", error);
    } finally {
      current = null;
    }
  })();
}

/** Serveur SMTP utilisable : e-mails en attente d'un nouvel essai remis à maintenant (si requeue), puis envoi. */
async function resume(requeue: boolean) {
  if (requeue && !stopping) {
    try {
      const { rows } = await query("select private.requeue_waiting_emails() as n");
      const count = Number(rows[0]?.n) || 0;
      if (count) log("info", "waiting e-mails rescheduled now", { count });
    } catch (error) {
      dbFailed("waiting e-mails not rescheduled (database)", error);
    }
  }
  trigger();
}

/** Ligne de public.mailer_status : réglages sans secret (ni identifiant ni mot de passe), état du serveur SMTP. */
function statusRow() {
  const down = state.smtp.ready !== true;
  return {
    started_at: iso(state.startedAt),
    smtp_host: settings.summary.host,
    smtp_port: settings.summary.port,
    smtp_tls: settings.summary.tls,
    smtp_auth: settings.summary.auth,
    mail_from: settings.summary.from,
    smtp_ready: state.smtp.ready,
    smtp_checked_at: iso(state.smtp.lastCheckAt),
    smtp_error: down ? state.smtp.lastError : null,
    smtp_error_at: down ? iso(state.smtp.lastErrorAt) : null,
  };
}

/** État écrit en base (signe de vie et serveur SMTP, lus par /admin/contacts) : une écriture à la fois. */
function reportStatus() {
  if (stopping) return;
  if (reporting) {
    reportAgain = true;
    return;
  }
  reporting = (async () => {
    try {
      do {
        reportAgain = false;
        await query("select private.report_mailer_status($1::jsonb)", [JSON.stringify(statusRow())]);
      } while (reportAgain && !stopping);
    } catch (error) {
      dbFailed("mailer status not recorded (database)", error);
    } finally {
      reporting = null;
    }
  })();
}

function healthBody() {
  const now = Date.now();
  // File en pause (serveur SMTP injoignable) : seule l'écriture de l'état interroge la base, toutes les 30 s
  const dbOk = !state.db.lastError && state.db.lastOkAt > 0 && now - state.db.lastOkAt < Math.max(3 * pollMs, 3 * STATUS_EVERY_MS);
  return {
    healthy: !stopping && dbOk,
    smtpReady: state.smtp.ready,
    /** File en pause : serveur SMTP injoignable ou pas encore vérifié. */
    paused: state.smtp.ready !== true,
    smtp: {
      ...settings.summary,
      lastCheckAt: iso(state.smtp.lastCheckAt),
      lastSentAt: iso(state.smtp.lastSentAt),
      lastErrorAt: iso(state.smtp.lastErrorAt),
      lastError: state.smtp.lastError,
    },
    db: { ok: dbOk, lastOkAt: iso(state.db.lastOkAt), lastError: state.db.lastError },
    counters: state.counters,
    lastCycleAt: iso(state.lastCycleAt),
    lastNotifyAt: iso(state.lastNotifyAt),
    startedAt: iso(state.startedAt),
  };
}

/** true si p s'est terminée (même en erreur) avant ms. */
function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.then(() => true, () => true),
    new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms))),
  ]).finally(() => clearTimeout(timer));
}

async function main() {
  log("info", "rydar mailer starting", { smtp: settings.summary, pollMs, healthPort, dbSsl: config.databaseSslMode || "url" });
  for (const warning of settings.warnings) log("warn", "mailer configuration", { warning });

  let stopListen: (() => Promise<void>) | null = null;
  const timers: NodeJS.Timeout[] = [];

  const health = createServer((_req, res) => {
    const body = healthBody();
    res.writeHead(body.healthy ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  health.on("error", (error) => log("error", "health endpoint unavailable (port taken? MAILER_HEALTH_PORT)", { port: healthPort, error: error.message }));
  // Réseau de l'hôte : jamais 0.0.0.0, le point de santé resterait joignable depuis l'extérieur
  health.listen(healthPort, "127.0.0.1");

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
    log("info", "shutting down", { signal, busy: !!current });
    timers.forEach(clearInterval);
    health.close();
    if (stopListen) await within(stopListen(), 1_000);
    // Le lot réservé se termine (sinon ses lignes attendent la fin du bail de 5 min pour repartir)
    const drained = current ? await within(current, SHUTDOWN_TIMEOUT_MS) : true;
    if (!drained) log("warn", "shutdown timeout, e-mails in progress are retried after their 5 min lease");
    sender.close();
    if (!(await within(pool.end(), 1_000))) log("warn", "pool end timeout");
    log("info", "stopped");
    process.exit(drained ? 0 : 1);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  timers.push(
    setInterval(trigger, pollMs),
    setInterval(() => {
      if (state.smtp.ready !== true) void checkSmtp();
    }, SMTP_RECHECK_MS),
    setInterval(reportStatus, STATUS_EVERY_MS),
  );
  reportStatus();
  // Premier cycle après la vérification du serveur SMTP (setSmtpReady → resume) : aucune tentative comptée s'il manque
  void checkSmtp();

  stopListen = await listen(
    "rydar_emails",
    () => {
      state.lastNotifyAt = Date.now();
      trigger();
    },
    "rydar-mailer-listen",
  );
  // Arrêt demandé pendant la première connexion LISTEN
  if (stopping) await stopListen();
}

main().catch((error: unknown) => {
  // Ex. port de santé invalide : message clair plutôt qu'un rejet non géré (Docker relance le service)
  log("error", "mailer failed to start", { error: (error as Error).message || String(error) });
  process.exit(1);
});
