"use server";
import {
  driverCreateSchema, driverStatusChangeSchema, driverUpdateSchema, fieldErrors, humanizeError,
  type DriverCreateInput,
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
  if (error || !driver) return { ok: false, error: error ? actionError(error) : "Accès refusé." };
  const vehicle = {
    brand: v.vehicle.brand ?? null, model: v.vehicle.model, color: v.vehicle.color ?? null, plate: v.vehicle.plate,
    category: v.vehicle.category, seats: v.vehicle.seats, luggage_capacity: v.vehicle.luggageCapacity,
  };
  if (driver.vehicle_id) {
    const { error: vErr } = await ctx.supabase.from("vehicles").update(vehicle).eq("id", driver.vehicle_id);
    if (vErr) return { ok: false, error: actionError(vErr) };
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
  if (error || !driver) return { ok: false, error: error ? humanizeError(error.message, actionError(error)) : "Accès refusé." };

  const admin = createAdminClient();
  if (status !== "active") {
    await admin.from("drivers").update({ presence: "offline", online_since: null } as never).eq("id", driverId);
    if (driver.user_id) await admin.auth.admin.updateUserById(driver.user_id, { ban_duration: "876000h" });
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
