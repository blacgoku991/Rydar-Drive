"use server";
import {
  emailSchema, humanizeError, orgSettingsSchema, organizationUpdateSchema, VEHICLE_CATEGORIES,
} from "@rydar/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { isAdminRole } from "@/lib/auth";
import { env } from "@/lib/env";
import { actionError } from "@/lib/errors";
import { getOrgContext } from "@/lib/org-context";
import { createAdminClient } from "@/lib/supabase/admin";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function adminCtx() {
  const ctx = await getOrgContext();
  return ctx && isAdminRole(ctx.role) ? ctx : null;
}

export async function updateOrganization(input: z.input<typeof organizationUpdateSchema>): Promise<Result> {
  const ctx = await adminCtx();
  if (!ctx) return { ok: false, error: "Réservé aux administrateurs." };
  const parsed = organizationUpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Vérifiez les champs." };
  const v = parsed.data;
  const { error } = await ctx.supabase
    .from("organizations")
    .update({
      name: v.name, legal_name: v.legalName ?? null, siret: v.siret ?? null, email: v.email || null, phone: v.phone ?? null,
      address: v.address ?? null, city: v.city ?? null, postal_code: v.postalCode ?? null,
    })
    .eq("id", ctx.org.id);
  if (error) return { ok: false, error: actionError(error) };
  revalidatePath("/dashboard", "layout");
  return { ok: true };
}

export async function updateDispatchSettings(input: z.input<typeof orgSettingsSchema>): Promise<Result> {
  const ctx = await adminCtx();
  if (!ctx) return { ok: false, error: "Réservé aux administrateurs." };
  const parsed = orgSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Paramètres invalides." };
  const { error } = await ctx.supabase.from("organization_settings").update(parsed.data).eq("organization_id", ctx.org.id);
  if (error) return { ok: false, error: actionError(error) };
  revalidatePath("/dashboard/settings");
  return { ok: true };
}

const pricingSchema = z.object({
  vehicle_category: z.enum(VEHICLE_CATEGORIES),
  name: z.string().trim().min(1).max(60),
  base_fare_cents: z.number().int().min(0).max(1_000_000),
  per_km_cents: z.number().int().min(0).max(100_000),
  per_minute_cents: z.number().int().min(0).max(100_000),
  minimum_fare_cents: z.number().int().min(0).max(1_000_000),
  night_surcharge_percent: z.number().min(0).max(200),
  fixed_fares: z.array(z.object({ label: z.string().trim().min(1).max(80), price_cents: z.number().int().min(0) })).max(30),
});

export async function savePricingRule(input: z.input<typeof pricingSchema>): Promise<Result> {
  const ctx = await adminCtx();
  if (!ctx) return { ok: false, error: "Réservé aux administrateurs." };
  const parsed = pricingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Tarif invalide." };
  const v = parsed.data;
  const { data: existing } = await ctx.supabase
    .from("pricing_rules")
    .select("id")
    .eq("organization_id", ctx.org.id)
    .eq("vehicle_category", v.vehicle_category)
    .eq("is_active", true)
    .maybeSingle();
  const { error } = existing
    ? await ctx.supabase.from("pricing_rules").update(v).eq("id", existing.id)
    : await ctx.supabase.from("pricing_rules").insert({ ...v, organization_id: ctx.org.id });
  if (error) return { ok: false, error: actionError(error) };
  revalidatePath("/dashboard/settings");
  return { ok: true };
}

const inviteSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: emailSchema,
  role: z.enum(["admin", "dispatcher"]),
  password: z.string().min(10).max(72).optional().or(z.literal("")),
});

/** Ajoute un membre de l'équipe (admin / dispatcher) — compte Supabase Auth. */
export async function inviteMember(input: z.input<typeof inviteSchema>): Promise<Result<{ password?: string }>> {
  const ctx = await adminCtx();
  if (!ctx) return { ok: false, error: "Réservé aux administrateurs." };
  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Vérifiez les champs." };
  const v = parsed.data;
  const admin = createAdminClient();
  const { data: existing } = await admin.from("users").select("id").ilike("email", v.email).maybeSingle();
  let userId = (existing as { id: string } | null)?.id;
  if (!userId) {
    const res = v.password
      ? await admin.auth.admin.createUser({ email: v.email, password: v.password, email_confirm: true, user_metadata: { full_name: v.fullName } })
      : await admin.auth.admin.inviteUserByEmail(v.email, { data: { full_name: v.fullName }, redirectTo: `${env.appUrl}/auth/set-password` });
    if (res.error || !res.data.user) return { ok: false, error: "Impossible de créer le compte (invitation e-mail non configurée ?)." };
    userId = res.data.user.id;
  }
  const { error } = await admin
    .from("organization_users")
    .insert({ organization_id: ctx.org.id, user_id: userId, role: v.role, invited_by: ctx.user.id, status: "active" } as never);
  if (error) return { ok: false, error: error.code === "23505" ? "Cette personne fait déjà partie de l'équipe." : humanizeError(error.message, actionError(error)) };
  await audit({ organizationId: ctx.org.id, actorUserId: ctx.user.id, action: "member.added", entityType: "organization_users", entityId: userId, metadata: { role: v.role, email: v.email } });
  revalidatePath("/dashboard/settings");
  return { ok: true };
}

export async function updateMember(memberId: string, patch: { role?: "admin" | "dispatcher"; status?: "active" | "disabled" }): Promise<Result> {
  const ctx = await getOrgContext();
  if (!ctx || ctx.role !== "owner") return { ok: false, error: "Réservé au propriétaire du compte." };
  const admin = createAdminClient();
  const { data: member } = await admin.from("organization_users").select("user_id, role").eq("id", memberId).eq("organization_id", ctx.org.id).maybeSingle();
  if (!member) return { ok: false, error: "Membre introuvable." };
  if ((member as any).role === "owner") return { ok: false, error: "Le propriétaire ne peut pas être modifié." };
  const { error } = await admin.from("organization_users").update(patch as never).eq("id", memberId);
  if (error) return { ok: false, error: humanizeError(error.message, actionError(error)) };
  await audit({ organizationId: ctx.org.id, actorUserId: ctx.user.id, action: "member.updated", entityType: "organization_users", entityId: memberId, metadata: patch, severity: patch.status === "disabled" ? "warning" : "info" });
  revalidatePath("/dashboard/settings");
  return { ok: true };
}
