// Suppressions de compte chauffeur à terminer (file private.account_deletions, migration 20260924004000).
// La route web /api/driver/delete-account et l'outil super admin /admin/suppressions traitent la file aussitôt ;
// ici, toutes les 5 min, les échecs sont repris :
//  1. purge de TOUT le dossier `{organisation}/{chauffeur}/` du bucket privé des justificatifs (API Storage) ;
//  2. suppression du compte de connexion (API d'administration de Supabase Auth ; public.users suit), sauf compte
//     conservé parce qu'il sert aussi à gérer une centrale ou la plateforme ;
//  3. avancement enregistré (private.complete_account_deletion) : nouvel essai espacé, abandon au 10e essai avec
//     alerte (journal du worker + journal d'audit critique en base), relance possible par le super admin.
// Toutes les 6 h : bannissements des comptes supprimés depuis 3 ans effacés (private.purge_deleted_driver_bans).
import { config, log } from "./config";
import { pool } from "./db";

/** Bucket privé des justificatifs (apps/driver/src/lib/api.ts DOCUMENTS_BUCKET). */
export const DOCUMENTS_BUCKET = "driver-documents";
const PAGE = 1000;
const BATCH = 10;
const PURGE_EVERY_MS = 6 * 3600_000;

export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

/** API Supabase appelée avec la clé service role (Storage, Auth admin). */
export type SupabaseApi = { url: string; key: string; fetch?: typeof fetch; timeoutMs?: number };

/** Ligne de private.account_deletions reprise par private.claim_account_deletions(). */
export type ClaimedDeletion = {
  id: string;
  driver_id: string;
  organization_id: string;
  driver_number: number;
  user_id: string | null;
  keep_auth: boolean;
  storage_prefix: string;
  storage_done_at: Date | string | null;
  auth_done_at: Date | string | null;
  attempts: number;
};

type Progress = { done: boolean; abandoned: boolean; attempts: number; last_error: string | null };

/** API configurée (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY), sinon null : la file n'est pas traitée ici. */
export function supabaseApi(): SupabaseApi | null {
  const { url, serviceRoleKey } = config.supabase;
  return url && serviceRoleKey ? { url, key: serviceRoleKey } : null;
}

async function call(api: SupabaseApi, path: string, init: { method: string; body?: unknown }) {
  const res = await (api.fetch ?? fetch)(`${api.url}${path}`, {
    method: init.method,
    headers: { apikey: api.key, authorization: `Bearer ${api.key}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(api.timeoutMs ?? 15_000),
  });
  const text = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, text };
}

const errorOf = (r: { status: number; json: any; text: string }) =>
  String(r.json?.message ?? r.json?.msg ?? r.json?.error ?? (r.text.slice(0, 200) || `HTTP ${r.status}`));

/**
 * Pas de stockage du tout : bucket absent (aucun fichier n'a pu y être déposé) ou pile locale sans service de
 * stockage (scripts/local-stack/gateway.mjs). Même règle que la route web (apps/web/lib/driver-deletion.ts).
 */
const noStorage = (message: string) => /bucket not found/i.test(message) || /not available in local stack/i.test(message);

/**
 * Liste tout le dossier (pagination, sous-dossiers) puis supprime les fichiers par lots.
 * null : dossier vide ensuite ; sinon message d'erreur du stockage.
 */
export async function purgeDriverFolder(api: SupabaseApi, prefix: string): Promise<string | null> {
  const root = prefix.replace(/\/+$/, "");
  if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(root)) return "dossier invalide";
  const files: string[] = [];
  const folders = [root];
  while (folders.length) {
    const dir = folders.pop()!;
    for (let offset = 0; ; offset += PAGE) {
      const r = await call(api, `/storage/v1/object/list/${DOCUMENTS_BUCKET}`, {
        method: "POST",
        body: { prefix: dir, limit: PAGE, offset, sortBy: { column: "name", order: "asc" } },
      });
      if (!r.ok) {
        const message = errorOf(r);
        return noStorage(message) ? null : message;
      }
      const items = (Array.isArray(r.json) ? r.json : []) as { name: string; id: string | null }[];
      for (const item of items) {
        // Sous-dossier : objet sans identifiant
        if (item.id == null) folders.push(`${dir}/${item.name}`);
        else files.push(`${dir}/${item.name}`);
      }
      if (items.length < PAGE) break;
    }
  }
  for (let i = 0; i < files.length; i += PAGE) {
    const r = await call(api, `/storage/v1/object/${DOCUMENTS_BUCKET}`, { method: "DELETE", body: { prefixes: files.slice(i, i + PAGE) } });
    if (!r.ok) return errorOf(r);
  }
  return null;
}

/** Supprime le compte Supabase Auth ; déjà supprimé (404) : réussite. null si réussi, sinon l'erreur. */
export async function deleteAuthUser(api: SupabaseApi, userId: string): Promise<string | null> {
  const r = await call(api, `/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE", body: { should_soft_delete: false } });
  if (r.ok || r.status === 404) return null;
  return errorOf(r);
}

/** Termine une suppression reprise de la file et enregistre l'avancement. */
export async function finishDeletion(job: ClaimedDeletion, deps: { query: QueryFn; api: SupabaseApi }): Promise<Progress> {
  const errors: string[] = [];
  let storageDone = job.storage_done_at != null;
  if (!storageDone) {
    const problem = await purgeDriverFolder(deps.api, job.storage_prefix).catch((e: unknown) => (e as Error).message || "erreur inconnue");
    if (problem) errors.push(`Stockage : ${problem}`);
    else storageDone = true;
  }
  let authDone = job.auth_done_at != null || !job.user_id || job.keep_auth;
  if (!authDone && job.user_id) {
    const problem = await deleteAuthUser(deps.api, job.user_id).catch((e: unknown) => (e as Error).message || "erreur inconnue");
    if (problem) errors.push(`Compte de connexion : ${problem}`);
    else authDone = true;
  }
  const { rows } = await deps.query("select private.complete_account_deletion($1, $2, $3, $4) as r", [
    job.id,
    storageDone,
    authDone,
    errors.length ? errors.join(" · ").slice(0, 500) : null,
  ]);
  const r = (rows[0]?.r ?? {}) as Partial<Progress>;
  return { done: !!r.done, abandoned: !!r.abandoned, attempts: Number(r.attempts ?? job.attempts + 1), last_error: r.last_error ?? null };
}

const stats = { enabled: false, lastRun: 0, done: 0, retried: 0, abandoned: 0, lastPurge: 0, warnedAt: 0, waiting: 0 };
/** État exposé par le point de santé du worker (`waiting` : suppressions en attente que l'API manquante bloque). */
export const accountDeletionStats = stats;
/** Rappel de l'erreur « API manquante » tant que la file n'est pas vide : au démarrage, puis toutes les heures. */
const MISSING_API_EVERY_MS = 3600_000;

/** Tâche du worker : reprise de la file (lot de 10) + purge périodique des bannissements expirés. */
export async function processAccountDeletions(deps: { query?: QueryFn; api?: SupabaseApi | null } = {}) {
  const query = deps.query ?? ((sql: string, params?: unknown[]) => pool.query(sql, params));
  const api = deps.api === undefined ? supabaseApi() : deps.api;
  stats.enabled = !!api;
  stats.lastRun = Date.now();

  if (Date.now() - stats.lastPurge >= PURGE_EVERY_MS) {
    stats.lastPurge = Date.now();
    try {
      const { rows } = await query("select private.purge_deleted_driver_bans() as r");
      const purged = rows[0]?.r as { drivers?: number } | undefined;
      if (purged?.drivers) log("info", "deleted driver bans purged (3 years)", purged);
    } catch (error) {
      log("error", "deleted driver bans purge failed", { error: (error as Error).message });
    }
  }

  if (!api) {
    // Sans API, rien ne peut être terminé (fichiers, comptes de connexion) : les suppressions en échec et celles du
    // rattrapage restent « en cours » pour toujours. ERREUR dès le démarrage s'il reste du travail, puis toutes les
    // heures (deploy/docker-compose.yml doit transmettre SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY au worker).
    if (Date.now() - stats.warnedAt >= MISSING_API_EVERY_MS) {
      const { rows } = await query("select count(*)::int as n from private.account_deletions where done_at is null");
      stats.waiting = Number(rows[0]?.n ?? 0);
      if (stats.waiting) {
        stats.warnedAt = Date.now();
        log("error", "account deletions cannot be completed: worker has no Supabase API (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)", {
          pending: stats.waiting,
        });
      }
    }
    return;
  }
  stats.waiting = 0;

  const { rows: jobs } = await query("select * from private.claim_account_deletions($1)", [BATCH]);
  for (const job of jobs as ClaimedDeletion[]) {
    try {
      const res = await finishDeletion(job, { query, api });
      if (res.done) {
        stats.done++;
        log("info", "account deletion completed", { deletion: job.id, driver_number: job.driver_number });
      } else if (res.abandoned) {
        stats.abandoned++;
        log("error", "account deletion abandoned after 10 attempts: retry from /admin/suppressions", {
          deletion: job.id,
          organization: job.organization_id,
          driver_number: job.driver_number,
          error: res.last_error,
        });
      } else {
        stats.retried++;
        log("warn", "account deletion incomplete, retry scheduled", { deletion: job.id, attempts: res.attempts, error: res.last_error });
      }
    } catch (error) {
      // Avancement non enregistré : le bail de 15 min expire et la ligne est reprise
      log("error", "account deletion failed", { deletion: job.id, error: (error as Error).message });
    }
  }
}
