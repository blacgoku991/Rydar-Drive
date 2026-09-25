"use server";
import {
  banDriverSchema, driverCreateSchema, driverStatusChangeSchema, driverUpdateSchema, fieldErrors, humanizeError,
  type BanDriverResult, type DriverCreateInput, type TrustLevel,
} from "@rydar/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { isAdminRole } from "@/lib/auth";
import { env } from "@/lib/env";
import { actionError } from "@/lib/errors";
import { getOrgContext } from "@/lib/org-context";
import { createAdminClient } from "@/lib/supabase/admin";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string; fieldErrors?: Record<string, string> };

async function fleetManager() {
  const ctx = await getOrgContext();
  if (!ctx || !isAdminRole(ctx.role)) return null;
  return ctx;
}

/** Erreurs de triggers liées au bannissement (réactivation, identité refusée) → message lisible. */
function banAwareError(error: { code?: string; message?: string } | null) {
  const msg = error?.message ?? "";
  if (/DRIVER_BANNED/.test(msg)) return "Chauffeur banni : levez d'abord le bannissement.";
  if (/IDENTITY_BANNED/.test(msg)) return `Identité bannie${msg.includes("plateforme") ? " par la plateforme Rydar" : " dans votre centrale"} : modification refusée.`;
  return humanizeError(msg, actionError(error));
}

/** Ban « définitif » (100 ans) au niveau du compte Auth. */
const BAN_FOREVER = "876000h";

/** Crée le compte chauffeur (Supabase Auth) + véhicule + fiche, de manière compensée. */
export async function createDriver(input: z.input<typeof driverCreateSchema>): Promise<Result<{ id: string }>> {
  const ctx = await fleetManager();
  if (!ctx) return { ok: false, error: "Seuls les administrateurs peuvent créer des chauffeurs." };
  const parsed = driverCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Vérifiez le formulaire.", fieldErrors: fieldErrors(parsed.error) };
  const v: DriverCreateInput = parsed.data;
  const admin = createAdminClient();

  // 1) Compte d'authentification (mot de passe ou invitation par e-mail)
  const metadata = { full_name: `${v.firstName} ${v.lastName}`, phone: v.phone, kind: "driver" };
  const created =
    v.access === "password"
      ? await admin.auth.admin.createUser({ email: v.email, password: v.password!, email_confirm: true, user_metadata: metadata })
      : await admin.auth.admin.inviteUserByEmail(v.email, { data: metadata, redirectTo: `${env.appUrl}/auth/set-password` });
  if (created.error || !created.data.user) {
    const msg = created.error?.message ?? "";
    return {
      ok: false,
      error: /already|exists|registered/i.test(msg) ? "Cette adresse e-mail est déjà utilisée." : "Impossible de créer le compte d'accès.",
      fieldErrors: /already|exists|registered/i.test(msg) ? { email: "Adresse déjà utilisée" } : undefined,
    };
  }
  const userId = created.data.user.id;

  // 2) Véhicule + fiche chauffeur (tenant imposé par le serveur)
  const { data: vehicle, error: vErr } = await admin
    .from("vehicles")
    .insert({
      organization_id: ctx.org.id,
      brand: v.vehicle.brand ?? null,
      model: v.vehicle.model,
      color: v.vehicle.color ?? null,
      plate: v.vehicle.plate,
      category: v.vehicle.category,
      seats: v.vehicle.seats,
      luggage_capacity: v.vehicle.luggageCapacity,
    } as never)
    .select("id")
    .single();
  if (vErr || !vehicle) {
    await admin.auth.admin.deleteUser(userId);
    return { ok: false, error: vErr?.code === "23505" ? "Cette plaque existe déjà dans votre flotte." : actionError(vErr) };
  }
  const { data: driver, error: dErr } = await admin
    .from("drivers")
    .insert({
      organization_id: ctx.org.id,
      user_id: userId,
      first_name: v.firstName,
      last_name: v.lastName,
      phone: v.phone,
      email: v.email,
      photo_url: v.photoUrl || null,
      vtc_card_number: v.vtcCardNumber ?? null,
      status: v.access === "invite" ? "invited" : v.status,
      vehicle_id: (vehicle as { id: string }).id,
      created_by: ctx.user.id,
    } as never)
    .select("id")
    .single();
  if (dErr || !driver) {
    await admin.from("vehicles").delete().eq("id", (vehicle as { id: string }).id);
    await admin.auth.admin.deleteUser(userId);
    return { ok: false, error: humanizeError(dErr?.message, actionError(dErr)) };
  }

  await audit({
    organizationId: ctx.org.id,
    actorUserId: ctx.user.id,
    action: "driver.account_created",
    entityType: "drivers",
    entityId: (driver as { id: string }).id,
    metadata: { access: v.access, email: v.email },
  });
  revalidatePath("/dashboard/drivers");
  return { ok: true, id: (driver as { id: string }).id };
}

export async function updateDriver(driverId: string, input: z.input<typeof driverUpdateSchema>): Promise<Result> {
  const ctx = await getOrgContext();
  if (!ctx) return { ok: false, error: "Accès refusé." };
  const parsed = driverUpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Vérifiez le formulaire.", fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  const { data: driver, error } = await ctx.supabase
    .from("drivers")
    .update({ first_name: v.firstName, last_name: v.lastName, phone: v.phone, email: v.email, vtc_card_number: v.vtcCardNumber ?? null, notes: v.notes ?? null })
    .eq("id", driverId)
    .eq("organization_id", ctx.org.id)
    .select("id, vehicle_id")
    .maybeSingle();
  if (error || !driver) return { ok: false, error: error ? banAwareError(error) : "Accès refusé." };
  const vehicle = {
    brand: v.vehicle.brand ?? null, model: v.vehicle.model, color: v.vehicle.color ?? null, plate: v.vehicle.plate,
    category: v.vehicle.category, seats: v.vehicle.seats, luggage_capacity: v.vehicle.luggageCapacity,
  };
  if (driver.vehicle_id) {
    const { error: vErr } = await ctx.supabase.from("vehicles").update(vehicle).eq("id", driver.vehicle_id);
    if (vErr) return { ok: false, error: banAwareError(vErr) };
  } else {
    const { data: created, error: vErr } = await ctx.supabase.from("vehicles").insert({ ...vehicle, organization_id: ctx.org.id }).select("id").single();
    if (vErr || !created) return { ok: false, error: actionError(vErr) };
    await ctx.supabase.from("drivers").update({ vehicle_id: created.id }).eq("id", driverId);
  }
  revalidatePath(`/dashboard/drivers/${driverId}`);
  return { ok: true };
}

/** Activer / désactiver / suspendre : effet immédiat (RLS) + révocation de l'accès Auth. */
export async function setDriverStatus(driverId: string, input: z.input<typeof driverStatusChangeSchema>): Promise<Result> {
  const ctx = await fleetManager();
  if (!ctx) return { ok: false, error: "Seuls les administrateurs peuvent modifier ce statut." };
  const parsed = driverStatusChangeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Statut invalide." };
  const { status, reason } = parsed.data;
  const { data: driver, error } = await ctx.supabase
    .from("drivers")
    .update({ status, suspended_reason: status === "suspended" ? (reason ?? null) : null })
    .eq("id", driverId)
    .eq("organization_id", ctx.org.id)
    .select("id, user_id, current_ride_id")
    .maybeSingle();
  if (error || !driver) return { ok: false, error: error ? banAwareError(error) : "Accès refusé." };

  const admin = createAdminClient();
  if (status !== "active") {
    await admin.from("drivers").update({ presence: "offline", online_since: null } as never).eq("id", driverId);
    if (driver.user_id) await admin.auth.admin.updateUserById(driver.user_id, { ban_duration: BAN_FOREVER });
  } else if (driver.user_id) {
    await admin.auth.admin.updateUserById(driver.user_id, { ban_duration: "none" });
  }
  await audit({
    organizationId: ctx.org.id,
    actorUserId: ctx.user.id,
    action: `driver.${status}`,
    entityType: "drivers",
    entityId: driverId,
    severity: status === "suspended" ? "warning" : "info",
    metadata: { reason },
  });
  revalidatePath(`/dashboard/drivers/${driverId}`);
  revalidatePath("/dashboard/drivers");
  return { ok: true };
}

export async function resetDriverPassword(driverId: string, password: string): Promise<Result> {
  const ctx = await fleetManager();
  if (!ctx) return { ok: false, error: "Accès refusé." };
  if (password.length < 10) return { ok: false, error: "10 caractères minimum." };
  const { data: driver } = await ctx.supabase.from("drivers").select("user_id").eq("id", driverId).eq("organization_id", ctx.org.id).maybeSingle();
  if (!driver?.user_id) return { ok: false, error: "Chauffeur introuvable." };
  const { error } = await createAdminClient().auth.admin.updateUserById(driver.user_id, { password });
  if (error) return { ok: false, error: "Impossible de modifier le mot de passe." };
  // Nouveau mot de passe = déconnexion de tous les appareils
  await ctx.supabase.rpc("revoke_driver_sessions", { p_driver_id: driverId });
  await audit({ organizationId: ctx.org.id, actorUserId: ctx.user.id, action: "driver.password_reset", entityType: "drivers", entityId: driverId, severity: "warning" });
  return { ok: true };
}

/** Ferme toutes les sessions du chauffeur (téléphone perdu, changement d'appareil…). */
export async function revokeDriverSessions(driverId: string): Promise<Result> {
  const ctx = await fleetManager();
  if (!ctx) return { ok: false, error: "Seuls les administrateurs peuvent déconnecter un chauffeur." };
  const { error } = await ctx.supabase.rpc("revoke_driver_sessions", { p_driver_id: driverId });
  if (error) return { ok: false, error: humanizeError(error.message, actionError(error)) };
  revalidatePath(`/dashboard/drivers/${driverId}`);
  return { ok: true };
}

const documentSchema = z.object({
  type: z.enum(["driving_license", "vtc_card", "insurance", "vehicle_registration", "identity", "medical", "other"]),
  number: z.string().trim().max(60).optional(),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  filePath: z.string().max(300).optional(),
});

export async function addDriverDocument(driverId: string, input: z.input<typeof documentSchema>): Promise<Result> {
  const ctx = await getOrgContext();
  if (!ctx) return { ok: false, error: "Accès refusé." };
  const parsed = documentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Document invalide." };
  const { error } = await ctx.supabase.from("driver_documents").insert({
    organization_id: ctx.org.id,
    driver_id: driverId,
    type: parsed.data.type,
    number: parsed.data.number || null,
    expires_at: parsed.data.expiresAt || null,
    file_path: parsed.data.filePath || null,
    status: "valid",
  });
  if (error) return { ok: false, error: actionError(error) };
  revalidatePath(`/dashboard/drivers/${driverId}`);
  return { ok: true };
}

const reviewSchema = z.object({
  documentId: z.string().uuid(),
  approve: z.boolean(),
  note: z.string().trim().max(500).optional(),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
});

/** Validation / refus d'un document déposé par le chauffeur (review_driver_document : push + journal + temps réel). */
export async function reviewDriverDocument(
  input: z.input<typeof reviewSchema>,
): Promise<{ ok: true; code: string } | { ok: false; error: string; code?: string }> {
  const ctx = await getOrgContext();
  if (!ctx) return { ok: false, error: "Accès refusé." };
  const parsed = reviewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Demande invalide." };
  const { documentId, approve, note, expiresAt } = parsed.data;
  const { data, error } = await ctx.supabase.rpc("review_driver_document", {
    p_document_id: documentId,
    p_approve: approve,
    p_note: note || null,
    p_expires_at: expiresAt || null,
  });
  if (error || !data) return { ok: false, error: actionError(error) };
  const res = data as { ok: boolean; code: string; message?: string; document?: { driver_id: string } };
  if (!res.ok) return { ok: false, code: res.code, error: res.message ?? "Action impossible." };
  if (res.document?.driver_id) revalidatePath(`/dashboard/drivers/${res.document.driver_id}`);
  revalidatePath("/dashboard/drivers");
  return { ok: true, code: res.code };
}

// -----------------------------------------------------------------------------
// Confiance et bannissement définitif (modes flotte et centrale)
// -----------------------------------------------------------------------------

/** Niveau de confiance : « Nouveau » (courses plafonnées en prix) ou « Confirmé » — owner / admin. */
export async function setDriverTrustLevel(driverId: string, trustLevel: TrustLevel): Promise<Result> {
  const ctx = await fleetManager();
  if (!ctx) return { ok: false, error: "Seuls les administrateurs peuvent modifier le niveau de confiance." };
  if (!z.string().uuid().safeParse(driverId).success || !["new", "trusted"].includes(trustLevel)) return { ok: false, error: "Demande invalide." };
  const { data, error } = await ctx.supabase
    .from("drivers")
    .update({ trust_level: trustLevel })
    .eq("id", driverId)
    .eq("organization_id", ctx.org.id)
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, error: error ? actionError(error) : "Chauffeur introuvable." };
  await audit({
    organizationId: ctx.org.id,
    actorUserId: ctx.user.id,
    action: "driver.trust_level_changed",
    entityType: "drivers",
    entityId: driverId,
    metadata: { trust_level: trustLevel },
  });
  revalidatePath(`/dashboard/drivers/${driverId}`);
  return { ok: true };
}

type BanOutcome = { message: string; identities: number; reassignedRides: number; reported: boolean };

/**
 * « Bannir définitivement » : ban_driver (identités hachées refusées, courses non commencées remises en
 * recherche, signalement éventuel à Rydar) puis blocage du compte Auth.
 */
export async function banDriver(
  driverId: string,
  input: z.input<typeof banDriverSchema>,
): Promise<Result<BanOutcome> | { ok: false; error: string; code?: string; fieldErrors?: Record<string, string> }> {
  const ctx = await fleetManager();
  if (!ctx) return { ok: false, error: "Seuls les administrateurs peuvent bannir un chauffeur." };
  if (!z.string().uuid().safeParse(driverId).success) return { ok: false, error: "Chauffeur introuvable." };
  const parsed = banDriverSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Vérifiez le formulaire.", fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  const { data, error } = await ctx.supabase.rpc("ban_driver", {
    p_driver_id: driverId,
    p_reason: v.reason,
    p_category: v.category,
    p_report_to_platform: v.reportToPlatform,
    p_ban_vehicle: v.banVehicle,
  });
  if (error || !data) return { ok: false, error: actionError(error, "Bannissement impossible.") };
  const res = data as BanDriverResult;
  if (!res.ok) {
    return {
      ok: false,
      code: res.code,
      error: res.message ?? "Bannissement impossible.",
      fieldErrors: res.code === "REASON_REQUIRED" ? { reason: res.message ?? "Indiquez le motif" } : undefined,
    };
  }

  // Connexion bloquée au niveau du compte (sessions déjà révoquées par trigger SQL)
  let authBanned = false;
  if (res.user_id) {
    const { error: banError } = await createAdminClient().auth.admin.updateUserById(res.user_id, { ban_duration: BAN_FOREVER });
    authBanned = !banError;
  }
  // ban_driver journalise déjà « driver.banned » en base ; ici : verrou du compte Auth (+ IP / navigateur)
  await audit({
    organizationId: ctx.org.id,
    actorUserId: ctx.user.id,
    action: "driver.account_locked",
    entityType: "drivers",
    entityId: driverId,
    severity: "critical",
    metadata: {
      reason: v.reason, category: v.category, report_to_platform: v.reportToPlatform, ban_vehicle: v.banVehicle,
      identities: res.identities ?? 0, reassigned_rides: res.reassigned_rides ?? 0, report_id: res.report_id ?? null, auth_banned: authBanned,
    },
  });
  revalidatePath(`/dashboard/drivers/${driverId}`);
  revalidatePath("/dashboard/drivers");
  revalidatePath("/dashboard/network");
  return {
    ok: true,
    message: res.message ?? "Chauffeur banni.",
    identities: res.identities ?? 0,
    reassignedRides: res.reassigned_rides ?? 0,
    reported: !!res.report_id,
  };
}

/** Lever un bannissement décidé par la centrale : le chauffeur reste suspendu (réactivation manuelle). */
export async function liftDriverBan(driverId: string, reason?: string): Promise<Result<{ message: string }> | { ok: false; error: string; code?: string }> {
  const ctx = await fleetManager();
  if (!ctx) return { ok: false, error: "Seuls les administrateurs peuvent lever un bannissement." };
  if (!z.string().uuid().safeParse(driverId).success) return { ok: false, error: "Chauffeur introuvable." };
  const motive = reason?.trim().slice(0, 500) || null;
  const { data, error } = await ctx.supabase.rpc("lift_driver_ban", { p_driver_id: driverId, p_reason: motive });
  if (error || !data) return { ok: false, error: actionError(error, "Levée impossible.") };
  const res = data as { ok: boolean; code: string; message?: string; identities?: number };
  if (!res.ok) return { ok: false, code: res.code, error: res.message ?? "Levée impossible." };
  // Journal : « driver.ban_lifted » écrit par lift_driver_ban. Compte Auth débloqué à la réactivation (setDriverStatus).
  revalidatePath(`/dashboard/drivers/${driverId}`);
  revalidatePath("/dashboard/drivers");
  revalidatePath("/dashboard/network");
  return { ok: true, message: res.message ?? "Bannissement levé." };
}
