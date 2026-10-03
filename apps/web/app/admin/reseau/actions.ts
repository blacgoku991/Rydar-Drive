"use server";
// Super admin — réseau partagé (/admin/reseau) : interrupteur de toute la plateforme, validation des organisations
// (vérification administrative de l'inscription au registre VTC, dérogation « frais à 0 »), refus motivé, suspension
// pour manquement à la convention ou aux CGV, rétablissement. Écriture par le service role après requireSuperAdmin() ;
// chaque RPC svc_* revérifie l'auteur (p_actor) et écrit audit_logs. Fichier « use server » : fonctions async seulement.
import {
  describeError, fieldErrors,
  type SvcNetworkApproveResult, type SvcNetworkSuspendResult, type SvcSharedNetworkResult,
} from "@rydar/shared";
import { revalidatePath } from "next/cache";
import { IDENTITY_LABELS, networkReviewSchema, networkSuspendSchema } from "@/components/network-share/admin";
import { requireSuperAdmin } from "@/lib/auth";
import { actionError } from "@/lib/errors";
import { createAdminClient } from "@/lib/supabase/admin";

export type AdminNetworkResult<T = object> =
  | ({ ok: true; message: string } & T)
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

const PATH = "/admin/reseau";

function refresh(orgId?: string) {
  revalidatePath(PATH);
  if (orgId) revalidatePath(`/admin/organizations/${orgId}`);
}

/** Interrupteur de toute la plateforme. Coupure : offres réseau en attente fermées, courses acceptées au bout. */
export async function setSharedNetworkEnabled(enabled: boolean): Promise<AdminNetworkResult<{ enabled: boolean; closedOffers: number }>> {
  const session = await requireSuperAdmin();
  if (typeof enabled !== "boolean") return { ok: false, error: "Valeur invalide." };
  const { data, error } = await createAdminClient().rpc("svc_set_shared_network_enabled", { p_actor: session.user.id, p_enabled: enabled });
  if (error) return { ok: false, error: actionError(error, "Enregistrement impossible.") };
  const res = (data ?? {}) as SvcSharedNetworkResult;
  if (!res.ok) return { ok: false, error: res.message || "Enregistrement impossible." };
  refresh();
  // Menu, bandeaux et onglet de tous les tableaux de bord
  revalidatePath("/dashboard", "layout");
  const closed = res.closed_offers ?? 0;
  return {
    ok: true,
    enabled: res.enabled === true,
    closedOffers: closed,
    message: res.enabled
      ? "Réseau partagé ouvert : les organisations peuvent demander à y participer."
      : `Réseau partagé fermé${closed ? ` · ${closed} offre${closed > 1 ? "s" : ""} en attente retirée${closed > 1 ? "s" : ""}` : ""}. Les courses déjà acceptées vont à leur terme.`,
  };
}

/** Valider (instantané raison sociale / SIRET / n° VTC, dérogation éventuelle) ou refuser une organisation. */
export async function reviewNetworkOrg(input: { orgId: string; approved: boolean; feeWaiver?: boolean; reason?: string }): Promise<AdminNetworkResult> {
  const session = await requireSuperAdmin();
  const parsed = networkReviewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: describeError(parsed.error, { reason: "Motif" }), fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  const { data, error } = await createAdminClient().rpc("svc_network_approve", {
    p_actor: session.user.id,
    p_org: v.orgId,
    p_approved: v.approved,
    p_fee_waiver: v.approved ? v.feeWaiver : false,
    p_reason: v.approved ? null : v.reason,
  });
  if (error) return { ok: false, error: actionError(error, "Décision impossible pour le moment.") };
  const res = (data ?? {}) as SvcNetworkApproveResult;
  if (!res.ok) {
    if (res.code === "IDENTITY_INCOMPLETE") {
      const missing = (res.missing ?? []).map((m) => IDENTITY_LABELS[m]).join(", ");
      return { ok: false, error: `Fiche de l'organisation incomplète${missing ? ` : ${missing}` : ""}. Elle doit la compléter dans ses réglages.` };
    }
    if (res.code === "REASON_REQUIRED") return { ok: false, error: "Indiquez le motif du refus.", fieldErrors: { reason: "Motif obligatoire" } };
    if (res.code === "NOT_FOUND") return { ok: false, error: "Organisation introuvable." };
    return { ok: false, error: res.message || "Décision impossible." };
  }
  refresh(v.orgId);
  return {
    ok: true,
    message: v.approved
      ? `Organisation validée${v.feeWaiver ? " (dérogation « frais à 0 »)" : ""} : son propriétaire est prévenu par e-mail.`
      : "Demande refusée : le motif est affiché à l'organisation.",
  };
}

/** Suspendre (manquement à la convention ou aux CGV) ou rétablir la participation d'une organisation. */
export async function suspendNetworkOrg(input: { orgId: string; suspended: boolean; reason?: string }): Promise<AdminNetworkResult> {
  const session = await requireSuperAdmin();
  const parsed = networkSuspendSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: describeError(parsed.error, { reason: "Motif" }), fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  const { data, error } = await createAdminClient().rpc("svc_network_suspend", {
    p_actor: session.user.id,
    p_org: v.orgId,
    p_suspended: v.suspended,
    p_reason: v.reason,
  });
  if (error) return { ok: false, error: actionError(error, "Décision impossible pour le moment.") };
  const res = (data ?? {}) as SvcNetworkSuspendResult;
  if (!res.ok) {
    if (res.code === "REASON_REQUIRED") return { ok: false, error: "Indiquez le manquement constaté.", fieldErrors: { reason: "Motif obligatoire" } };
    if (res.code === "NOT_FOUND") return { ok: false, error: "Organisation introuvable." };
    return { ok: false, error: res.message || "Décision impossible." };
  }
  refresh(v.orgId);
  const released = res.released_rides ?? 0;
  return {
    ok: true,
    message: v.suspended
      ? `Participation suspendue${released ? ` · ${released} course${released > 1 ? "s" : ""} non commencée${released > 1 ? "s" : ""} remise${released > 1 ? "s" : ""} en recherche` : ""}.`
      : "Participation rétablie.",
  };
}
