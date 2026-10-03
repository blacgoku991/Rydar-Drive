"use server";
// Super admin : suppression d'un compte chauffeur sur demande reçue sans l'application (e-mail au contact
// « données personnelles », RGPD : sous 30 jours). Recherche par la RPC admin_find_drivers (contrôle super admin
// en base) ; suppression et relance par le service role après requireSuperAdmin() (lib/driver-deletion.ts, partagé
// avec l'application), journalisées en SQL (driver.deleted, driver.deletion_retry) et ici (adresse IP).
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth";
import { deleteDriverAccount, retryAccountDeletion, type DriverDeletionCode } from "@/lib/driver-deletion";
import { actionError } from "@/lib/errors";
import type { DriverMatch } from "./types";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const querySchema = z
  .string()
  .trim()
  .min(3, "Saisissez l'adresse e-mail ou le numéro de téléphone du chauffeur.")
  .max(254, "254 caractères au maximum.");
const uuid = z.string().uuid();

/** Chauffeurs (toutes centrales) dont la fiche ou le compte correspond à l'adresse e-mail ou au téléphone. */
export async function findDriversForDeletion(query: string): Promise<Result<{ drivers: DriverMatch[] }>> {
  const session = await requireSuperAdmin();
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Recherche invalide." };
  const { data, error } = await session.supabase.rpc("admin_find_drivers", { p_query: parsed.data });
  if (error) return { ok: false, error: actionError(error, "Recherche impossible pour le moment.") };
  const drivers = (data ?? []) as DriverMatch[];
  // Recherche de données personnelles dans toutes les centrales : tracée (type de recherche et nombre de résultats,
  // jamais la valeur cherchée)
  await audit({
    actorUserId: session.user.id,
    actorType: "super_admin",
    action: "driver.lookup",
    entityType: "drivers",
    metadata: { by: parsed.data.includes("@") ? "email" : "phone", results: drivers.length },
  });
  return { ok: true, drivers };
}

/** Message pour le super admin (troisième personne) selon l'issue de la suppression. */
function adminMessage(code: DriverDeletionCode, number: number, pending: boolean) {
  if (code === "DRIVER_PROFILE_DELETED") {
    return `Profil chauffeur #${number} supprimé ; son compte de gestion (centrale) est conservé${pending ? " — fichiers en cours de suppression" : ""}.`;
  }
  if (code === "DELETION_PENDING") {
    return `Données du chauffeur #${number} effacées ; la fin de la suppression (fichiers, compte de connexion) est reprise automatiquement.`;
  }
  return `Compte du chauffeur #${number} supprimé : données, justificatifs et compte de connexion.`;
}

/** Supprime le compte du chauffeur désigné (confirmation « SUPPRIMER »). */
export async function deleteDriverOnRequest(
  driverId: string,
  confirm: string,
): Promise<Result<{ code: DriverDeletionCode; pending: boolean; message: string }>> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(driverId).success) return { ok: false, error: "Chauffeur introuvable." };
  if (confirm.trim().toUpperCase() !== "SUPPRIMER") return { ok: false, error: "Tapez SUPPRIMER pour confirmer." };

  const res = await deleteDriverAccount({ driverId, actorId: session.user.id });
  if (!res.ok) return { ok: false, error: res.message };
  await audit({
    organizationId: res.organizationId,
    actorUserId: session.user.id,
    actorType: "super_admin",
    action: "driver.deletion_requested",
    entityType: "drivers",
    entityId: res.driverId,
    severity: "warning",
    metadata: { number: res.number, channel: "email", result: res.code, pending: res.pending, already_deleted: res.alreadyDeleted },
  });
  revalidatePath("/admin/suppressions");
  return { ok: true, code: res.code, pending: res.pending, message: adminMessage(res.code, res.number, res.pending) };
}

/** « Réessayer » une suppression en échec ou en attente (fichiers, compte de connexion). */
export async function retryDriverDeletion(deletionId: string): Promise<Result<{ pending: boolean; message: string }>> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(deletionId).success) return { ok: false, error: "Suppression introuvable." };
  const res = await retryAccountDeletion(deletionId, session.user.id);
  if (!res.ok) return { ok: false, error: res.message };
  revalidatePath("/admin/suppressions");
  return {
    ok: true,
    pending: res.pending,
    message: res.pending
      ? `Chauffeur #${res.number} : toujours incomplète, nouvel essai automatique programmé.`
      : `Chauffeur #${res.number} : suppression terminée.`,
  };
}
