"use server";
// Super admin : interrupteur plateforme des mini-sites de réservation (Offres & limites). Écriture par le service role
// après requireSuperAdmin() ; svc_set_booking_sites_enabled revérifie l'auteur et écrit audit_logs.
import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth";
import { actionError } from "@/lib/errors";
import { createAdminClient } from "@/lib/supabase/admin";

type Result = { ok: true; enabled: boolean; changed: boolean } | { ok: false; error: string };

export async function setBookingSitesEnabled(enabled: boolean): Promise<Result> {
  const session = await requireSuperAdmin();
  if (typeof enabled !== "boolean") return { ok: false, error: "Valeur invalide." };
  const { data, error } = await createAdminClient().rpc("svc_set_booking_sites_enabled", { p_actor: session.user.id, p_enabled: enabled });
  if (error) return { ok: false, error: actionError(error, "Enregistrement impossible.") };
  const res = (data ?? {}) as { ok?: boolean; message?: string; enabled?: boolean; changed?: boolean };
  if (!res.ok) return { ok: false, error: res.message ?? "Enregistrement impossible." };
  // Menu de tous les tableaux de bord, éditeur du mini-site, offres
  revalidatePath("/admin/plans");
  revalidatePath("/dashboard", "layout");
  return { ok: true, enabled: res.enabled === true, changed: res.changed === true };
}
