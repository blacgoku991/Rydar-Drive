import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Suppression du compte chauffeur, partagée par la route de l'application (/api/driver/delete-account) et l'outil
 * super admin (/admin/suppressions, demandes reçues par e-mail).
 *
 *  1. SQL (svc_delete_driver_account / svc_admin_delete_driver) : refus si une course est attribuée ; données
 *     personnelles supprimées, fiche et traces anonymisées (« Chauffeur supprimé (#N) »), fiche détachée du compte
 *     de connexion, suppression mise en FILE (private.account_deletions) ;
 *  2. ici, aussitôt : purge de TOUT le dossier `{organisation}/{chauffeur}/` du bucket des justificatifs, puis
 *     suppression du compte de connexion (sauf s'il sert aussi à gérer une centrale ou la plateforme) ;
 *  3. échec du stockage ou de Supabase Auth : la file garde l'étape (essais, dernière erreur) et le worker la reprend
 *     (apps/worker/src/account-deletions.ts) ; la réponse dit alors « suppression en cours », jamais « supprimé ».
 */

/** Bucket privé des justificatifs (apps/driver/src/lib/api.ts DOCUMENTS_BUCKET). */
export const DOCUMENTS_BUCKET = "driver-documents";
/** Taille de page de la liste du stockage et des lots de suppression. */
const PAGE = 1000;

/** Suppression en file, telle que la renvoient les fonctions SQL (private.account_deletion_json). */
export type AccountDeletionJob = {
  deletion_id: string | null;
  driver_id: string;
  organization_id: string;
  number: number;
  user_id: string | null;
  keep_auth: boolean;
  storage_prefix: string;
  storage_done: boolean;
  auth_done: boolean;
  done: boolean;
  pending: boolean;
  abandoned?: boolean;
  attempts?: number;
  last_error?: string | null;
};

type SvcDeletion = Partial<AccountDeletionJob> & { ok: boolean; code: string; message?: string; already_deleted?: boolean };

/** Codes renvoyés à l'application (et à l'outil super admin). */
export type DriverDeletionCode = "DELETED" | "DRIVER_PROFILE_DELETED" | "DELETION_PENDING";

export type DriverDeletionResult =
  | {
      ok: true;
      /** DELETED : tout est supprimé ; DRIVER_PROFILE_DELETED : compte de gestion conservé ; DELETION_PENDING : fin en cours. */
      code: DriverDeletionCode;
      /** Étapes restantes (fichiers, compte de connexion), terminées automatiquement par le serveur. */
      pending: boolean;
      keepAuth: boolean;
      alreadyDeleted: boolean;
      driverId: string;
      organizationId: string;
      number: number;
      deletionId: string | null;
      /** Message prêt à afficher (FR). */
      message: string;
    }
  | { ok: false; code: string; status: number; message: string };

/**
 * Supprime le compte du chauffeur : par l'utilisateur authentifié (application) ou par le super admin (fiche
 * désignée, demande reçue sans l'application). Toujours après contrôle de l'appelant.
 */
export async function deleteDriverAccount(
  target: { userId: string } | { driverId: string; actorId: string },
): Promise<DriverDeletionResult> {
  const admin = createAdminClient();
  const { data, error } =
    "userId" in target
      ? await admin.rpc("svc_delete_driver_account", { p_user_id: target.userId })
      : await admin.rpc("svc_admin_delete_driver", { p_driver_id: target.driverId, p_actor: target.actorId });
  if (error || !data) {
    if (error?.code === "42501") return { ok: false, code: "FORBIDDEN", status: 403, message: "Accès refusé." };
    console.error("[driver-deletion] suppression impossible", error?.message);
    return { ok: false, code: "SERVER_ERROR", status: 500, message: "Suppression impossible pour le moment. Réessayez." };
  }
  const r = data as SvcDeletion;
  if (!r.ok) {
    const status = r.code === "RIDES_ASSIGNED" ? 409 : r.code === "NOT_DRIVER" ? 404 : 403;
    return { ok: false, code: r.code, status, message: r.message ?? "Suppression impossible." };
  }

  let job = r as AccountDeletionJob;
  // Étapes restantes (première demande, ou demande rejouée alors que la file n'a pas fini) : traitées aussitôt.
  // Les données sont déjà effacées : une panne ici laisse la suppression « en cours » (reprise par le worker).
  if (job.deletion_id && !job.done) job = await processAccountDeletion(job).catch(() => ({ ...job, done: false, pending: true }));
  return describeDeletion(job, !!r.already_deleted);
}

/** « Réessayer » (super admin) : compteur remis à zéro par SQL, puis traitement immédiat. */
export async function retryAccountDeletion(deletionId: string, actorId: string): Promise<DriverDeletionResult> {
  const { data, error } = await createAdminClient().rpc("svc_account_deletion_retry", { p_id: deletionId, p_actor: actorId });
  if (error || !data) {
    if (error?.code === "42501") return { ok: false, code: "FORBIDDEN", status: 403, message: "Accès refusé." };
    return { ok: false, code: "SERVER_ERROR", status: 500, message: "Relance impossible pour le moment. Réessayez." };
  }
  const r = data as SvcDeletion;
  if (!r.ok) return { ok: false, code: r.code, status: 409, message: r.message ?? "Relance impossible." };
  const job = r as AccountDeletionJob;
  return describeDeletion(await processAccountDeletion(job).catch(() => job), true);
}

/**
 * Termine une suppression en file : dossier de stockage, puis compte de connexion. Étapes indépendantes et
 * rejouables ; l'avancement (et l'erreur éventuelle) est enregistré dans la file.
 */
export async function processAccountDeletion(job: AccountDeletionJob): Promise<AccountDeletionJob> {
  if (!job.deletion_id) return job;
  const admin = createAdminClient();
  const errors: string[] = [];

  let storageDone = job.storage_done;
  if (!storageDone) {
    const problem = await purgeDriverFolder(admin, job.storage_prefix).catch((e: unknown) => (e as Error).message || "erreur inconnue");
    if (problem) errors.push(`Stockage : ${problem}`);
    else storageDone = true;
  }

  // Pas de compte à supprimer (fiche sans compte, compte de gestion conservé) : étape sans objet
  let authDone = job.auth_done || !job.user_id || job.keep_auth;
  if (!authDone && job.user_id) {
    const problem = await deleteAuthUser(admin, job.user_id).catch((e: unknown) => (e as Error).message || "erreur inconnue");
    if (problem) errors.push(`Compte de connexion : ${problem}`);
    else authDone = true;
  }

  const { data, error } = await admin.rpc("svc_account_deletion_progress", {
    p_id: job.deletion_id,
    p_storage_done: storageDone,
    p_auth_done: authDone,
    p_error: errors.length ? errors.join(" · ").slice(0, 500) : null,
  });
  if (error || !data) {
    // Avancement non enregistré : la file reste « en cours » et le worker rejoue les étapes (idempotentes)
    console.error("[driver-deletion] avancement non enregistré", error?.message);
    return { ...job, storage_done: storageDone, auth_done: authDone, done: false, pending: true };
  }
  if (errors.length) console.warn("[driver-deletion] suppression à reprendre", { deletion: job.deletion_id, errors });
  return { ...job, ...(data as Partial<AccountDeletionJob>) };
}

/**
 * Liste TOUT le dossier du chauffeur (pagination, sous-dossiers) puis supprime les fichiers par lots.
 * Renvoie null si le dossier est vide ensuite, sinon le message d'erreur du stockage.
 */
async function purgeDriverFolder(admin: SupabaseClient, prefix: string): Promise<string | null> {
  const root = prefix.replace(/\/+$/, "");
  if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(root)) return "dossier invalide";
  const bucket = admin.storage.from(DOCUMENTS_BUCKET);
  const files: string[] = [];
  const folders = [root];
  while (folders.length) {
    const dir = folders.pop()!;
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await bucket.list(dir, { limit: PAGE, offset, sortBy: { column: "name", order: "asc" } });
      if (error) return noStorage(error.message) ? null : error.message;
      for (const item of data ?? []) {
        // Sous-dossier : objet sans identifiant
        if (item.id == null) folders.push(`${dir}/${item.name}`);
        else files.push(`${dir}/${item.name}`);
      }
      if ((data?.length ?? 0) < PAGE) break;
    }
  }
  for (let i = 0; i < files.length; i += PAGE) {
    const { error } = await bucket.remove(files.slice(i, i + PAGE));
    if (error) return error.message;
  }
  return null;
}

/**
 * Pas de stockage du tout : bucket absent (aucun fichier n'a pu y être déposé) ou pile locale sans service de
 * stockage (scripts/local-stack/gateway.mjs). Toute autre erreur est une vraie panne, à reprendre.
 */
function noStorage(message: string) {
  return /bucket not found/i.test(message) || /not available in local stack/i.test(message);
}

/** Supprime le compte Supabase Auth (public.users suit). Déjà supprimé : réussite. Deux essais rapprochés. */
async function deleteAuthUser(admin: SupabaseClient, userId: string): Promise<string | null> {
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 400));
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (!error) return null;
    if (error.status === 404 || error.code === "user_not_found") return null;
    last = error.message || `erreur ${error.status ?? ""}`.trim();
  }
  return last;
}

/** Code et message affichés à partir de l'état de la file. */
function describeDeletion(job: AccountDeletionJob, alreadyDeleted: boolean): DriverDeletionResult {
  const pending = !job.done;
  const keepAuth = !!job.keep_auth;
  const remaining = [
    !job.storage_done && "de vos justificatifs",
    !keepAuth && job.user_id && !job.auth_done && "de votre compte de connexion",
  ].filter(Boolean) as string[];
  const tail = remaining.length
    ? ` La suppression ${remaining.join(" et ")} se termine automatiquement, sans action de votre part.`
    : "";
  let code: DriverDeletionCode;
  let message: string;
  if (keepAuth) {
    code = "DRIVER_PROFILE_DELETED";
    message = `Profil chauffeur supprimé. Votre compte de gestion (tableau de bord de la centrale) est conservé.${tail}`;
  } else if (pending) {
    code = "DELETION_PENDING";
    message = `Suppression en cours : vos données personnelles sont effacées de Rydar Drive.${tail}`;
  } else {
    code = "DELETED";
    message = "Votre compte Rydar Drive et vos données personnelles ont été supprimés.";
  }
  return {
    ok: true,
    code,
    pending,
    keepAuth,
    alreadyDeleted,
    driverId: job.driver_id,
    organizationId: job.organization_id,
    number: job.number,
    deletionId: job.deletion_id,
    message,
  };
}
