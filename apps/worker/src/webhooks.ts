// Webhooks sortants (migration 20260924006000) : à chaque changement d'état d'une course, la base écrit une ligne
// par point de terminaison abonné dans public.webhook_deliveries puis NOTIFY rydar_webhooks. Ici :
//  - réveil par LISTEN rydar_webhooks, sondage de secours toutes les 5 s ;
//  - file continue : private.claim_webhook_deliveries(n) réserve autant de lignes que de places libres (5 envois en
//    cours au plus ; SKIP LOCKED, bail de 2 min repris si le worker tombe) avec l'URL, le secret et l'état ACTUEL de
//    la course ; chaque envoi part dès sa réservation et, dès qu'il se termine, une nouvelle réservation remplit sa
//    place (recharges regroupées : une réservation toutes les 50 ms au plus tant que des envois sont en cours) : un
//    point de terminaison lent n'occupe que la sienne. Le CHOIX des lignes (un seul envoi en cours par point de
//    terminaison, partage entre centrales, rien pour une centrale suspendue ou archivée) est fait par la réservation
//    SQL (migration 20260924006100) : le worker sert les lignes dans l'ordre rendu, sans tri ni plafond de son côté ;
//  - ordre gardé : une seule requête à la fois pour une même course vers un même point de terminaison ;
//  - un essai = UN délai de 10 s pour tout : résolution DNS, connexion, TLS, en-têtes (un DNS lent ne prolonge pas
//    l'occupation d'une place) ;
//  - arrêt (stop) : plus aucune réservation ; les envois en cours (et ceux d'une réservation déjà en vol) se terminent
//    (10 s au plus) et leur résultat est enregistré avant la fermeture du pool (index.ts attend WEBHOOK_DRAIN_MS) : un
//    envoi parti a le temps d'aboutir et d'être enregistré. Doublon encore possible si l'enregistrement échoue ou si
//    l'attente est dépassée (la ligne repart à la fin de son bail) : livraison « au moins une fois » ;
//  - corps et signature : webhooks/sign.ts ; garde SSRF : webhooks/ssrf.ts ; envoi HTTP : webhooks/http.ts ;
//  - private.complete_webhook_delivery enregistre le résultat (réessais espacés et désactivation automatique côté SQL) ;
//  - private.purge_webhook_deliveries() toutes les heures ;
//  - fonctions absentes (migration pas encore appliquée) : avertissement unique, nouvel essai au passage suivant.
// Journal : identifiants, type, nom d'hôte de la cible, code HTTP et erreur — jamais le secret, le corps ni l'URL
// complète (son chemin peut porter un jeton).
import { log } from "./config";
import { postWebhook, timeoutMessage, type PostResult } from "./webhooks/http";
import { buildWebhookBody, webhookHeaders, type ClaimedWebhook } from "./webhooks/sign";
import { resolveWebhookTarget, WebhookUrlError, type Resolver } from "./webhooks/ssrf";

export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

/** Envois en cours au plus (lignes réservées et pas encore terminées). */
export const WEBHOOK_CONCURRENCY = 5;
/** Sondage de secours (en plus du réveil par LISTEN rydar_webhooks). */
export const WEBHOOK_POLL_MS = 5_000;
/** Purge des envois anciens (private.purge_webhook_deliveries). */
export const WEBHOOK_PURGE_MS = 3600_000;
/** Délai total d'un essai : résolution DNS, connexion, TLS, en-têtes de la réponse. */
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** Arrêt du worker : temps laissé aux envois en cours (un essai entier + l'enregistrement de son résultat). */
export const WEBHOOK_DRAIN_MS = WEBHOOK_TIMEOUT_MS + 2_000;
/** Recharges de la file regroupées : une réservation au plus par intervalle tant que des envois sont en cours. */
export const WEBHOOK_REFILL_MS = 50;
/** Bilan journalisé pendant un passage long (trafic continu : le passage peut ne jamais se terminer). */
export const WEBHOOK_PROGRESS_LOG_MS = 60_000;
/** Corps de la réponse lu au plus (ignoré). */
export const WEBHOOK_MAX_RESPONSE_BYTES = 2048;

const CLAIM_SQL = "select * from private.claim_webhook_deliveries($1::integer)";
const COMPLETE_SQL = "select private.complete_webhook_delivery($1::uuid, $2::boolean, $3::integer, $4::text)";
const PURGE_SQL = "select private.purge_webhook_deliveries() as n";

/** Codes PostgreSQL d'une fonction ou d'un schéma absents (migration pas encore appliquée). */
const MISSING = new Set(["42883", "3F000"]);
const isMissing = (error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && MISSING.has(code);
};

export type WebhookDeps = {
  query: QueryFn;
  /** URL publique du site (lien « self » des courses), sans « / » final. */
  appUrl: string;
  /** WEBHOOK_ALLOW_PRIVATE_URLS=1 : adresses internes et http:// acceptées (tests, développement). */
  allowPrivate: boolean;
  resolve?: Resolver;
  /** Délai total d'un essai (WEBHOOK_TIMEOUT_MS par défaut). */
  timeoutMs?: number;
  /** Envois en cours au plus (WEBHOOK_CONCURRENCY par défaut). */
  concurrency?: number;
  now?: () => number;
};

export type WebhookStats = {
  lastRunAt: number;
  claimed: number;
  delivered: number;
  failed: number;
  lastErrorAt: number;
  lastError: string | null;
};

/** Nom d'hôte de l'URL pour le journal (ni chemin, ni requête, ni identifiants). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
}

/** p, ou l'erreur de late() si p n'a pas abouti dans ms (p continue alors sans être attendue). */
function withDeadline<T>(p: Promise<T>, ms: number, late: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(late()), Math.max(0, ms));
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Un essai : cible validée, corps signé, POST, puis résultat enregistré. Un seul délai (timeoutMs) couvre la
 * résolution DNS, la connexion, TLS et les en-têtes. Une erreur de la base remonte.
 */
export async function deliverWebhook(d: ClaimedWebhook, deps: WebhookDeps): Promise<PostResult> {
  const timeoutMs = deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let result: PostResult;
  try {
    // Résolution bornée par le délai de l'essai : la place se libère à l'échéance, même si le résolveur du système
    // (non interruptible) répond plus tard ; sa réponse tardive est ignorée.
    const target = await withDeadline(
      resolveWebhookTarget(d.url, { allowPrivate: deps.allowPrivate, resolve: deps.resolve }),
      timeoutMs,
      () => new WebhookUrlError(`${timeoutMessage(timeoutMs)} pendant la résolution DNS`, "dns"),
    );
    const body = buildWebhookBody(d, deps.appUrl);
    result = await postWebhook(target, body, webhookHeaders(d, body, deps.now?.() ?? Date.now()), {
      timeoutMs: deadline - Date.now(),
      totalMs: timeoutMs,
      maxResponseBytes: WEBHOOK_MAX_RESPONSE_BYTES,
    });
  } catch (error) {
    result = {
      ok: false,
      statusCode: null,
      error: error instanceof WebhookUrlError ? error.message : `Erreur interne du worker (${(error as Error)?.name || "Error"})`,
    };
  }
  const error = result.ok ? null : (result.error || "Échec").slice(0, 500);
  await deps.query(COMPLETE_SQL, [d.id, result.ok, result.statusCode, error]);
  if (!result.ok) {
    log("warn", "webhook not delivered, retry scheduled by the database", {
      id: d.id,
      type: d.event_type,
      endpoint: d.endpoint_id,
      org: d.organization_id,
      host: hostOf(d.url),
      attempt: (Number(d.attempts) || 0) + 1,
      status: result.statusCode,
      error,
    });
  }
  return { ...result, error };
}

/** File d'une ligne : (point de terminaison, course) ; une ligne sans course (ping) a la sienne. */
function laneKey(d: ClaimedWebhook): string {
  const rideId = d.ride && typeof d.ride.id === "string" ? d.ride.id : d.id;
  return `${d.endpoint_id}:${rideId}`;
}

/**
 * Signal de la file : fin d'un envoi, réveil (LISTEN, sondage) ou arrêt. Une seule attente à la fois (la boucle de
 * runWebhookCycle) : aucun rappel ne s'accumule, quel que soit le nombre de signaux.
 */
export class WebhookSignal {
  private fired = false;
  private pending: Promise<void> | null = null;
  private release: (() => void) | null = null;

  notify() {
    this.fired = true;
    const release = this.release;
    this.pending = null;
    this.release = null;
    release?.();
  }

  /** true si notify() a eu lieu depuis le dernier take() (et remet à zéro). */
  take(): boolean {
    const fired = this.fired;
    this.fired = false;
    return fired;
  }

  /** Attend le prochain notify() ; aussitôt s'il a déjà eu lieu sans être consommé par take(). */
  wait(): Promise<void> {
    if (this.fired) return Promise.resolve();
    if (!this.pending) this.pending = new Promise<void>((resolve) => (this.release = resolve));
    return this.pending;
  }
}

export type CycleResult = { claimed: number; delivered: number; failed: number };

export type CycleDeps = WebhookDeps & {
  /** Arrêt demandé : plus de réservation (les lignes déjà réservées en tête de file partent quand même). */
  shouldStop?: () => boolean;
  /** Compteurs du répartiteur, tenus à jour à chaque envoi. */
  stats?: WebhookStats;
  /** Réveils reçus pendant le passage (répartiteur) ; un signal propre au passage sinon. */
  signal?: WebhookSignal;
  /** Intervalle minimal entre deux réservations tant que des envois sont en cours (WEBHOOK_REFILL_MS). */
  refillMs?: number;
  /** Bilan journalisé pendant un passage long (WEBHOOK_PROGRESS_LOG_MS). */
  progressLogMs?: number;
};

/**
 * Passage de la file continue : réserve autant de lignes que de places libres, lance chaque envoi aussitôt et, dès
 * qu'un envoi se termine (ou qu'un réveil arrive), réserve de nouveau (50 ms au moins entre deux réservations tant
 * que des envois sont en cours : les places libérées ensemble sont rechargées par une seule réservation). Se termine
 * quand plus rien n'est dû ni en cours. Arrêt demandé : plus de réservation ; les lignes déjà réservées en tête de
 * leur file partent quand même (réservation en vol au moment de l'arrêt comprise : sinon bloquées 2 min) et leur
 * résultat est enregistré ; une ligne en attente derrière un envoi de la même course ne part pas : elle reste
 * « sending » et repart à la fin de son bail (2 min), sans doublon puisqu'elle n'a pas été envoyée. Une réservation
 * en erreur : plus de réservation, les envois en cours se terminent, puis l'erreur remonte.
 */
export async function runWebhookCycle(deps: CycleDeps): Promise<CycleResult> {
  const result: CycleResult = { claimed: 0, delivered: 0, failed: 0 };
  const limit = Math.max(1, Math.floor(deps.concurrency ?? WEBHOOK_CONCURRENCY));
  const signal = deps.signal ?? new WebhookSignal();
  const stopping = () => deps.shouldStop?.() ?? false;
  const stats = deps.stats;
  const refillMs = Math.max(0, deps.refillMs ?? WEBHOOK_REFILL_MS);
  const progressLogMs = deps.progressLogMs ?? WEBHOOK_PROGRESS_LOG_MS;
  const lanes = new Map<string, ClaimedWebhook[]>();
  let lastClaimAt = 0;
  let lastProgressAt = Date.now();
  let held = 0; // lignes réservées pas encore terminées (en cours d'envoi ou en attente dans leur file)
  let notStarted = 0;
  let more = true; // une réservation peut trouver des lignes dues
  let claimFailed = false;
  let claimError: unknown;

  const send = async (d: ClaimedWebhook) => {
    try {
      const r = await deliverWebhook(d, deps);
      if (r.ok) {
        result.delivered++;
        if (stats) stats.delivered++;
      } else {
        result.failed++;
        if (stats) {
          stats.failed++;
          stats.lastErrorAt = Date.now();
          stats.lastError = r.error;
        }
      }
    } catch (error) {
      // Résultat non enregistré (base) : la ligne reste « sending » et repart à la fin de son bail (2 min)
      result.failed++;
      if (stats) stats.failed++;
      log("error", "webhook result not saved, delivery retried after its lease", { id: d.id, error: (error as Error).message });
    }
  };

  const runLane = async (key: string, lane: ClaimedWebhook[]) => {
    try {
      // Tête de file : envoyée même après l'arrêt (déjà réservée, un essai tient dans l'attente d'arrêt) ; la suite
      // de la file (même course) seulement sans arrêt
      do {
        await send(lane[0]!);
        lane.shift();
        held--;
        signal.notify();
      } while (lane.length && !stopping());
    } finally {
      // Arrêt : lignes de la file pas encore parties, laissées à la fin de leur bail
      if (lane.length) {
        notStarted += lane.length;
        held -= lane.length;
        lane.length = 0;
      }
      lanes.delete(key);
      signal.notify();
    }
  };

  const enqueue = (d: ClaimedWebhook) => {
    const key = laneKey(d);
    const lane = lanes.get(key);
    if (lane) {
      lane.push(d); // même course, même point de terminaison : après l'envoi en cours
      return;
    }
    const fresh = [d];
    lanes.set(key, fresh);
    void runLane(key, fresh);
  };

  for (;;) {
    if (signal.take()) more = true;
    if (progressLogMs > 0 && Date.now() - lastProgressAt >= progressLogMs) {
      lastProgressAt = Date.now();
      log("info", "webhooks pass in progress", { ...result, inFlight: held });
    }
    if (more && held < limit && !claimFailed && !stopping()) {
      // Recharge pendant des envois en cours : une réservation au plus toutes les refillMs (charge de la base)
      const wait = held > 0 ? lastClaimAt + refillMs - Date.now() : 0;
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      more = false;
      lastClaimAt = Date.now();
      const want = limit - held;
      let rows: ClaimedWebhook[];
      try {
        rows = (await deps.query(CLAIM_SQL, [want])).rows as ClaimedWebhook[];
      } catch (error) {
        claimFailed = true;
        claimError = error;
        continue;
      }
      if (rows.length >= want) more = true;
      result.claimed += rows.length;
      if (stats) {
        stats.claimed += rows.length;
        stats.lastRunAt = Date.now();
      }
      held += rows.length;
      for (const d of rows) enqueue(d);
      continue;
    }
    if (held <= 0) break;
    await signal.wait(); // fin d'un envoi, réveil ou arrêt
  }
  if (notStarted) log("info", "webhook deliveries not started before shutdown, sent again after their lease (2 min)", { count: notStarted });
  if (claimFailed) throw claimError;
  return result;
}

/**
 * Répartiteur du worker : process() (LISTEN, sondage), purge() (toutes les heures), stop() (arrêt : plus de
 * réservation, les envois des lignes déjà réservées se terminent). Un réveil pendant un passage déclenche une
 * réservation dès qu'une place est libre (aucun envoi n'attend le sondage suivant).
 */
export function createWebhookDispatcher(deps: WebhookDeps) {
  const stats: WebhookStats = { lastRunAt: 0, claimed: 0, delivered: 0, failed: 0, lastErrorAt: 0, lastError: null };
  const signal = new WebhookSignal();
  let running = false;
  let stopping = false;
  let claimMissingLogged = false;
  let purgeMissingLogged = false;

  async function process(): Promise<number> {
    if (stopping) return 0;
    if (running) {
      signal.notify();
      return 0;
    }
    running = true;
    signal.take(); // le passage commence par une réservation
    try {
      const r = await runWebhookCycle({ ...deps, shouldStop: () => stopping, stats, signal });
      claimMissingLogged = false;
      stats.lastRunAt = Date.now();
      if (r.claimed) log("info", "webhooks processed", { ...r });
      return r.claimed;
    } catch (error) {
      if (isMissing(error)) {
        if (!claimMissingLogged) {
          claimMissingLogged = true;
          log("warn", "webhooks skipped: private.claim_webhook_deliveries() missing (migration not applied yet)");
        }
      } else {
        stats.lastErrorAt = Date.now();
        stats.lastError = (error as Error).message;
        log("error", "webhooks failed", { error: (error as Error).message });
      }
      return 0;
    } finally {
      running = false;
    }
  }

  /** Envois de plus de 30 jours (aboutis ou en échec) et de plus de 45 jours (tous) supprimés. */
  async function purge(): Promise<number | null> {
    if (stopping) return null;
    try {
      const { rows } = await deps.query(PURGE_SQL);
      purgeMissingLogged = false;
      const n = Number(rows[0]?.n) || 0;
      if (n > 0) log("info", "webhook deliveries purged", { count: n });
      return n;
    } catch (error) {
      if (isMissing(error)) {
        if (!purgeMissingLogged) {
          purgeMissingLogged = true;
          log("warn", "webhook purge skipped: private.purge_webhook_deliveries() missing (migration not applied yet)");
        }
        return null;
      }
      log("warn", "webhook purge failed, retried next run", { error: (error as Error).message });
      return null;
    }
  }

  return {
    process,
    purge,
    stats,
    /** Arrêt : plus aucune réservation ; le passage en cours se termine avec ses envois (lignes déjà réservées). */
    stop() {
      stopping = true;
      signal.notify();
    },
  };
}
