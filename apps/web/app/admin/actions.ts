"use server";
import { organizationCreateSchema, planSchema, type OrganizationCreateInput } from "@rydar/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** Crée un rattacheur + son compte propriétaire + abonnement d'essai. */
export async function createOrganization(input: z.input<typeof organizationCreateSchema>): Promise<Result<{ id: string; password?: string }>> {
  const session = await requireSuperAdmin();
  const parsed = organizationCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Formulaire invalide." };
  const v: OrganizationCreateInput = parsed.data;
  const admin = createAdminClient();
  const { data: plan } = await admin.from("plans").select("id").eq("code", v.planCode).maybeSingle();
  if (!plan) return { ok: false, error: "Offre inconnue." };

  const { data: org, error } = await admin
    .from("organizations")
    .insert({ name: v.name, slug: v.slug, plan_id: (plan as any).id, email: v.email, phone: v.phone || null, city: v.city ?? null, created_by: session.user.id } as never)
    .select("id")
    .single();
  if (error || !org) return { ok: false, error: error?.code === "23505" ? "Ce slug est déjà utilisé." : "Création impossible." };
  const orgId = (org as any).id as string;

  const { data: existing } = await admin.from("users").select("id").ilike("email", v.ownerEmail).maybeSingle();
  let ownerId = (existing as any)?.id as string | undefined;
  if (!ownerId) {
    const res = v.ownerPassword
      ? await admin.auth.admin.createUser({ email: v.ownerEmail, password: v.ownerPassword, email_confirm: true, user_metadata: { full_name: v.ownerName } })
      : await admin.auth.admin.inviteUserByEmail(v.ownerEmail, { data: { full_name: v.ownerName }, redirectTo: `${env.appUrl}/auth/set-password` });
    if (res.error || !res.data.user) {
      await admin.from("organizations").delete().eq("id", orgId);
      return { ok: false, error: "Compte propriétaire impossible à créer (e-mail d'invitation non configuré ? fournissez un mot de passe)." };
    }
    ownerId = res.data.user.id;
  }
  await admin.from("organization_users").insert({ organization_id: orgId, user_id: ownerId, role: "owner", invited_by: session.user.id } as never);
  await admin.from("subscriptions").insert({
    organization_id: orgId, plan_id: (plan as any).id, status: "trialing",
    trial_ends_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  } as never);
  await audit({ organizationId: orgId, actorUserId: session.user.id, actorType: "super_admin", action: "organization.created", entityType: "organizations", entityId: orgId, metadata: { plan: v.planCode, owner: v.ownerEmail } });
  revalidatePath("/admin");
  return { ok: true, id: orgId };
}

/** Suspendre / réactiver / archiver : effet immédiat via la RLS + ban des comptes Auth. */
export async function setOrganizationStatus(orgId: string, status: "active" | "suspended" | "archived", reason?: string): Promise<Result> {
  const session = await requireSuperAdmin();
  const admin = createAdminClient();
  const patch: Record<string, unknown> = { status };
  if (status === "suspended") Object.assign(patch, { suspended_at: new Date().toISOString(), suspended_reason: reason ?? null });
  if (status === "archived") Object.assign(patch, { archived_at: new Date().toISOString() });
  if (status === "active") Object.assign(patch, { suspended_at: null, suspended_reason: null, archived_at: null });
  const { error } = await admin.from("organizations").update(patch as never).eq("id", orgId);
  if (error) return { ok: false, error: "Mise à jour impossible." };

  const [{ data: members }, { data: drivers }] = await Promise.all([
    admin.from("organization_users").select("user_id").eq("organization_id", orgId),
    admin.from("drivers").select("user_id").eq("organization_id", orgId).not("user_id", "is", null),
  ]);
  const userIds = [...(members ?? []), ...(drivers ?? [])].map((x: any) => x.user_id as string);
  await Promise.all(userIds.map((id) => admin.auth.admin.updateUserById(id, { ban_duration: status === "active" ? "none" : "876000h" }).catch(() => null)));
  if (status !== "active") await admin.from("drivers").update({ presence: "offline", online_since: null } as never).eq("organization_id", orgId);

  await audit({ organizationId: orgId, actorUserId: session.user.id, actorType: "super_admin", action: `organization.${status}`, entityType: "organizations", entityId: orgId, severity: status === "active" ? "info" : "warning", metadata: { reason, users: userIds.length } });
  revalidatePath(`/admin/organizations/${orgId}`);
  revalidatePath("/admin");
  return { ok: true };
}

const limitsOverrideSchema = z.record(z.string(), z.union([z.number().int().min(0), z.boolean(), z.null()]));

export async function updateOrganizationPlan(orgId: string, planId: string, limitsOverride: Record<string, unknown>): Promise<Result> {
  const session = await requireSuperAdmin();
  const parsed = limitsOverrideSchema.safeParse(limitsOverride);
  if (!parsed.success) return { ok: false, error: "Limites invalides." };
  const { error } = await createAdminClient().from("organizations").update({ plan_id: planId, limits_override: parsed.data } as never).eq("id", orgId);
  if (error) return { ok: false, error: "Mise à jour impossible." };
  await audit({ organizationId: orgId, actorUserId: session.user.id, actorType: "super_admin", action: "organization.plan_changed", entityType: "organizations", entityId: orgId, metadata: { planId, limitsOverride: parsed.data } });
  revalidatePath(`/admin/organizations/${orgId}`);
  return { ok: true };
}

export async function savePlan(id: string | null, input: z.input<typeof planSchema>): Promise<Result> {
  const session = await requireSuperAdmin();
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Offre invalide." };
  const admin = createAdminClient();
  const { error } = id ? await admin.from("plans").update(parsed.data as never).eq("id", id) : await admin.from("plans").insert(parsed.data as never);
  if (error) return { ok: false, error: error.code === "23505" ? "Code déjà utilisé." : "Enregistrement impossible." };
  await audit({ actorUserId: session.user.id, actorType: "super_admin", action: id ? "plan.updated" : "plan.created", entityType: "plans", entityId: id ?? parsed.data.code });
  revalidatePath("/admin/plans");
  return { ok: true };
}
