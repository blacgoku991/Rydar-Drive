// Webhooks sortants (migration 20260924006000) : à chaque changement d'état d'une course, la base écrit une ligne
// par point de terminaison abonné dans public.webhook_deliveries puis NOTIFY rydar_webhooks. Ici :
//  - réveil par LISTEN rydar_webhooks, sondage de secours toutes les 5 s ;
//  - private.claim_webhook_deliveries(20) réserve un lot (SKIP LOCKED, bail de 2 min repris si le worker tombe) avec
//    l'URL, le secret et l'état ACTUEL de la course ; envoi en parallèle (5 au plus), mais une seule requête à la fois
//    pour une même course vers un même point de terminaison (ordre des événements gardé dans le lot) ;
//  - corps et signature : webhooks/sign.ts ; garde SSRF : webhooks/ssrf.ts ; envoi HTTP : webhooks/http.ts ;
//  - private.complete_webhook_delivery enregistre le résultat (réessais espacés et désactivation automatique côté SQL) ;
//  - private.purge_webhook_deliveries() toutes les heures ;
//  - fonctions absentes (migration pas encore appliquée) : avertissement unique, nouvel essai au passage suivant.
// Journal : identifiants, type, nom d'hôte de la cible, code HTTP et erreur — jamais le secret, le corps ni l'URL
// complète (son chemin peut porter un jeton).
import { log } from "./config";
import { postWebhook, type PostResult } from "./webhooks/http";
import { buildWebhookBody, webhookHeaders, type ClaimedWebhook } from "./webhooks/sign";
import { resolveWebhookTarget, WebhookUrlError, type Resolver } from "./webhooks/ssrf";

export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

/** Lignes réservées par passage (private.claim_webhook_deliveries). */
export const WEBHOOK_CLAIM_BATCH = 20;
/** Requêtes HTTP en cours au plus. */
export const WEBHOOK_CONCURRENCY = 5;
/** Sondage de secours (en plus du réveil par LISTEN rydar_webhooks). */
export const WEBHOOK_POLL_MS = 5_000;
/** Purge des envois anciens (private.purge_webhook_deliveries). */
export const WEBHOOK_PURGE_MS = 3600_000;
/** Délai total d'un essai (connexion, TLS, réponse). */
export const WEBHOOK_TIMEOUT_MS = 10_000;
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
  timeoutMs?: number;
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

/** Un essai : cible validée, corps signé, POST, puis résultat enregistré. Une erreur de la base remonte. */
export async function deliverWebhook(d: ClaimedWebhook, deps: WebhookDeps): Promise<PostResult> {
  let result: PostResult;
  try {
    const target = await resolveWebhookTarget(d.url, { allowPrivate: deps.allowPrivate, resolve: deps.resolve });
    const body = buildWebhookBody(d, deps.appUrl);
    result = await postWebhook(target, body, webhookHeaders(d, body, deps.now?.() ?? Date.now()), {
      timeoutMs: deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS,
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

/** Exécute fn sur chaque élément, `limit` à la fois au plus. */
async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

/**
 * Files d'envoi : une par (point de terminaison, course), dans l'ordre de réservation (événements les plus anciens
 * d'abord) ; les files partent en parallèle, les envois d'une même file l'un après l'autre.
 */
export function deliveryLanes(rows: ClaimedWebhook[]): ClaimedWebhook[][] {
  const lanes = new Map<string, ClaimedWebhook[]>();
  for (const d of rows) {
    const rideId = d.ride && typeof d.ride.id === "string" ? d.ride.id : d.id;
    const key = `${d.endpoint_id}:${rideId}`;
    const lane = lanes.get(key);
    if (lane) lane.push(d);
    else lanes.set(key, [d]);
  }
  return [...lanes.values()];
}

export type CycleResult = { claimed: number; delivered: number; failed: number };

/** Lots successifs jusqu'à vider la file des envois dus (ou arrêt demandé). */
export async function runWebhookCycle(deps: WebhookDeps & { shouldStop?: () => boolean; stats?: WebhookStats }): Promise<CycleResult> {
  const result: CycleResult = { claimed: 0, delivered: 0, failed: 0 };
  while (!deps.shouldStop?.()) {
    const { rows } = await deps.query(CLAIM_SQL, [WEBHOOK_CLAIM_BATCH]);
    const batch = rows as ClaimedWebhook[];
    if (!batch.length) break;
    result.claimed += batch.length;
    await eachLimited(deliveryLanes(batch), deps.concurrency ?? WEBHOOK_CONCURRENCY, async (lane) => {
      for (const d of lane) {
        try {
          const r = await deliverWebhook(d, deps);
          if (r.ok) result.delivered++;
          else {
            result.failed++;
            if (deps.stats) {
              deps.stats.lastErrorAt = Date.now();
              deps.stats.lastError = r.error;
            }
          }
        } catch (error) {
          // Résultat non enregistré (base) : la ligne reste « sending » et repart à la fin de son bail (2 min)
          result.failed++;
          log("error", "webhook result not saved, delivery retried after its lease", { id: d.id, error: (error as Error).message });
        }
      }
    });
    if (batch.length < WEBHOOK_CLAIM_BATCH) break;
  }
  return result;
}

/**
 * Répartiteur du worker : process() (LISTEN, sondage), purge() (toutes les heures), stop() (arrêt : plus de nouveau
 * lot, le lot en cours se termine). Un réveil pendant un passage en relance un juste après (aucun envoi n'attend le
 * sondage suivant).
 */
export function createWebhookDispatcher(deps: WebhookDeps) {
  const stats: WebhookStats = { lastRunAt: 0, claimed: 0, delivered: 0, failed: 0, lastErrorAt: 0, lastError: null };
  let running = false;
  let again = false;
  let stopping = false;
  let claimMissingLogged = false;
  let purgeMissingLogged = false;

  async function process(): Promise<number> {
    if (stopping) return 0;
    if (running) {
      again = true;
      return 0;
    }
    running = true;
    let total = 0;
    try {
      do {
        again = false;
        const r = await runWebhookCycle({ ...deps, shouldStop: () => stopping, stats });
        claimMissingLogged = false;
        stats.lastRunAt = Date.now();
        stats.claimed += r.claimed;
        stats.delivered += r.delivered;
        stats.failed += r.failed;
        total += r.claimed;
        if (r.claimed) log("info", "webhooks processed", { ...r });
      } while (again && !stopping);
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
    } finally {
      running = false;
    }
    return total;
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
    stop() {
      stopping = true;
    },
  };
}
