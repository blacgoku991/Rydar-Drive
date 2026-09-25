"use server";
// Page Réseau (mode centrale) : lien d'inscription, candidatures, levée d'un bannissement d'identité.
// Contrôles de rôle ici (owner / admin) ET en base (private.assert_org_member dans chaque RPC).
import { humanizeError, type TrustLevel } from "@rydar/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { isAdminRole } from "@/lib/auth";
import { actionError } from "@/lib/errors";
import { getOrgContext } from "@/lib/org-context";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string; code?: string };
type RpcResult = { ok: boolean; code: string; message?: string } & Record<string, unknown>;

const uuid = z.string().uuid();

async function managerCtx() {
  const ctx = await getOrgContext();
  if (!ctx || !isAdminRole(ctx.role)) return null;
  return ctx;
}

/** Erreurs levées par les triggers (limite de l'offre, identité bannie…) → message lisible. */
function triggerError(error: { code?: string; message?: string } | null, fallback: string) {
  const msg = error?.message ?? "";
  if (/IDENTITY_BANNED/.test(msg)) return `Identité bannie : ${msg.replace(/^.*IDENTITY_BANNED:\s*/, "").replace(/^identité bannie\s*/i, "")}`.trim();
  if (/DRIVER_BANNED/.test(msg)) return "Chauffeur banni : levez d'abord le bannissement.";
  return humanizeError(msg, actionError(error, fallback));
}

export type JoinLinkState = { join_code: string | null; join_enabled: boolean; join_auto_approve: boolean };

/** Lien d'inscription : activer / couper, validation automatique, régénération (l'ancien lien cesse de fonctionner). */
export async function updateJoinLink(input: { enabled?: boolean; regenerate?: boolean; autoApprove?: boolean }): Promise<Result<JoinLinkState>> {
  const ctx = await managerCtx();
  if (!ctx) return { ok: false, error: "Réservé aux administrateurs de la centrale." };
  if (ctx.org.dispatch_model !== "centrale") return { ok: false, error: "Le lien d'inscription est réservé aux comptes en mode centrale." };
  // null = inchangé (coalesce côté SQL)
  const { data, error } = await ctx.supabase.rpc("set_join_link", {
    p_org: ctx.org.id,
    p_enabled: input.enabled ?? null,
    p_regenerate: input.regenerate ?? false,
    p_auto_approve: input.autoApprove ?? null,
  });
  if (error || !data) return { ok: false, error: actionError(error, "Mise à jour du lien impossible.") };
  const res = data as RpcResult & Partial<JoinLinkState>;
  if (!res.ok) return { ok: false, code: res.code, error: res.message ?? "Action impossible." };
  // Journal : « organization.join_link » (activé, régénéré, validation auto) écrit par set_join_link
  revalidatePath("/dashboard/network");
  return { ok: true, join_code: res.join_code ?? null, join_enabled: !!res.join_enabled, join_auto_approve: !!res.join_auto_approve };
}

/** Valider une candidature (niveau de confiance au choix). */
export async function approveApplication(driverId: string, trustLevel: TrustLevel): Promise<Result<{ message: string }>> {
  const ctx = await managerCtx();
  if (!ctx) return { ok: false, error: "Seuls les administrateurs peuvent valider une candidature." };
  if (!uuid.safeParse(driverId).success || !["new", "trusted"].includes(trustLevel)) return { ok: false, error: "Demande invalide." };
  const { data, error } = await ctx.supabase.rpc("approve_driver_application", { p_driver_id: driverId, p_trust_level: trustLevel });
  if (error || !data) return { ok: false, error: triggerError(error, "Validation impossible.") };
  const res = data as RpcResult;
  if (!res.ok) return { ok: false, code: res.code, error: res.message ?? "Validation impossible." };
  await audit({
    organizationId: ctx.org.id,
    actorUserId: ctx.user.id,
    action: "driver.application_approved",
    entityType: "drivers",
    entityId: driverId,
    metadata: { trust_level: trustLevel },
  });
  revalidatePath("/dashboard/network");
  revalidatePath("/dashboard/drivers");
  revalidatePath(`/dashboard/drivers/${driverId}`);
  return { ok: true, message: res.message ?? "Chauffeur validé." };
}

/** Refuser une candidature (motif transmis au candidat dans l'application). */
export async function rejectApplication(driverId: string, reason: string): Promise<Result<{ message: string }>> {
  const ctx = await managerCtx();
  if (!ctx) return { ok: false, error: "Seuls les administrateurs peuvent refuser une candidature." };
  if (!uuid.safeParse(driverId).success) return { ok: false, error: "Demande invalide." };
  const motive = reason.trim().slice(0, 500) || null;
  const { data, error } = await ctx.supabase.rpc("reject_driver_application", { p_driver_id: driverId, p_reason: motive });
  if (error || !data) return { ok: false, error: triggerError(error, "Refus impossible.") };
  const res = data as RpcResult;
  if (!res.ok) return { ok: false, code: res.code, error: res.message ?? "Refus impossible." };
  await audit({
    organizationId: ctx.org.id,
    actorUserId: ctx.user.id,
    action: "driver.application_rejected",
    entityType: "drivers",
    entityId: driverId,
    metadata: { reason: motive },
  });
  revalidatePath("/dashboard/network");
  revalidatePath(`/dashboard/drivers/${driverId}`);
  return { ok: true, message: res.message ?? "Candidature refusée." };
}

/** Débloquer une identité précise (ex. plaque d'une voiture de location reprise par un autre chauffeur). */
export async function liftIdentityBan(identityId: string, reason?: string): Promise<Result<{ message: string }>> {
  const ctx = await managerCtx();
  if (!ctx) return { ok: false, error: "Réservé aux administrateurs de la centrale." };
  if (!uuid.safeParse(identityId).success) return { ok: false, error: "Demande invalide." };
  const { data, error } = await ctx.supabase.rpc("lift_identity_ban", { p_id: identityId, p_reason: reason?.trim().slice(0, 500) || null });
  if (error || !data) return { ok: false, error: actionError(error, "Action impossible.") };
  const res = data as RpcResult;
  if (!res.ok) return { ok: false, code: res.code, error: res.message ?? "Action impossible." };
  revalidatePath("/dashboard/network");
  return { ok: true, message: res.message ?? "Identité débloquée." };
}
