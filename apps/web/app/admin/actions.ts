"use server";
import {
  dispatchModelSchema, emailSchema, humanizeError, organizationCreateSchema, planSchema,
  type DispatchModelInput, type OrganizationCreateInput,
} from "@rydar/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string; fieldErrors?: Record<string, string> };

const uuid = z.string().uuid();
/** Motif / note libre (≤ 500 caractères, vide → null). */
const note = (v: string | null | undefined) => v?.trim().slice(0, 500) || null;
/** Échappe % et _ pour une recherche ilike exacte (insensible à la casse). */
const likeExact = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);
/** Ban Auth « définitif » (100 ans) / levée. */
const BAN_FOREVER = "876000h";

/** Crée un rattacheur + son compte propriétaire + abonnement d'essai, avec son modèle d'exploitation. */
export async function createOrganization(
  input: z.input<typeof organizationCreateSchema>,
  dispatch?: z.input<typeof dispatchModelSchema>,
): Promise<Result<{ id: string; password?: string }>> {
  const session = await requireSuperAdmin();
  const parsed = organizationCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Formulaire invalide." };
  const model = dispatchModelSchema.safeParse(dispatch ?? { dispatchModel: "fleet", platformFeePercent: 0, platformFeeFixedCents: 0 });
  if (!model.success) return { ok: false, error: model.error.issues[0]?.message ?? "Frais plateforme invalides." };
  const v: OrganizationCreateInput = parsed.data;
  const m: DispatchModelInput = model.data;
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

  // Modèle d'exploitation + frais plateforme (colonnes réservées au super admin)
  const { error: modelError } = await admin
    .from("organizations")
    .update({ dispatch_model: m.dispatchModel, platform_fee_percent: m.platformFeePercent, platform_fee_fixed_cents: m.platformFeeFixedCents } as never)
    .eq("id", orgId);
  if (modelError) {
    await admin.from("organizations").delete().eq("id", orgId);
    return { ok: false, error: "Modèle d'exploitation impossible à enregistrer." };
  }

  const { data: existing } = await admin.from("users").select("id").ilike("email", likeExact(v.ownerEmail)).maybeSingle();
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
  await audit({
    organizationId: orgId, actorUserId: session.user.id, actorType: "super_admin", action: "organization.created", entityType: "organizations", entityId: orgId,
    metadata: { plan: v.planCode, owner: v.ownerEmail, dispatch_model: m.dispatchModel, platform_fee_percent: m.platformFeePercent, platform_fee_fixed_cents: m.platformFeeFixedCents },
  });
  revalidatePath("/admin");
  revalidatePath("/admin/organizations");
  revalidatePath("/admin/centrales");
  return { ok: true, id: orgId };
}

/**
 * Modèle d'exploitation (flotte / centrale à commission) + frais plateforme d'un compte.
 * Retour au mode flotte : le lien d'inscription est coupé par le trigger SQL (organizations_dispatch_model_guard).
 */
export async function updateDispatchModel(orgId: string, input: z.input<typeof dispatchModelSchema>): Promise<Result<{ joinDisabled: boolean }>> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(orgId).success) return { ok: false, error: "Organisation inconnue." };
  const parsed = dispatchModelSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Paramètres invalides." };
  const v = parsed.data;
  const admin = createAdminClient();
  const { data: before } = await admin
    .from("organizations")
    .select("dispatch_model, platform_fee_percent, platform_fee_fixed_cents, join_enabled")
    .eq("id", orgId)
    .maybeSingle();
  if (!before) return { ok: false, error: "Organisation introuvable." };
  const b = before as { dispatch_model: string; platform_fee_percent: number; platform_fee_fixed_cents: number; join_enabled: boolean };

  const { error } = await admin
    .from("organizations")
    .update({ dispatch_model: v.dispatchModel, platform_fee_percent: v.platformFeePercent, platform_fee_fixed_cents: v.platformFeeFixedCents } as never)
    .eq("id", orgId);
  if (error) return { ok: false, error: error.code === "23514" ? "Frais plateforme hors limites (0 à 50 %, 0 à 1 000 €)." : "Mise à jour impossible." };

  const modelChanged = b.dispatch_model !== v.dispatchModel;
  const joinDisabled = modelChanged && v.dispatchModel === "fleet" && b.join_enabled;
  await audit({
    organizationId: orgId,
    actorUserId: session.user.id,
    actorType: "super_admin",
    action: modelChanged ? "organization.dispatch_model_changed" : "organization.platform_fee_changed",
    entityType: "organizations",
    entityId: orgId,
    severity: modelChanged ? "warning" : "info",
    metadata: {
      before: { dispatch_model: b.dispatch_model, platform_fee_percent: Number(b.platform_fee_percent), platform_fee_fixed_cents: b.platform_fee_fixed_cents },
      after: { dispatch_model: v.dispatchModel, platform_fee_percent: v.platformFeePercent, platform_fee_fixed_cents: v.platformFeeFixedCents },
      join_link_disabled: joinDisabled,
    },
  });
  revalidatePath(`/admin/organizations/${orgId}`);
  revalidatePath("/admin/organizations");
  revalidatePath("/admin/centrales");
  return { ok: true, joinDisabled };
}

const accessSchema = z.object({
  fullName: z.string().trim().min(2, "Nom requis").max(120),
  email: emailSchema,
  role: z.enum(["owner", "admin", "dispatcher"]),
  password: z.union([z.literal(""), z.string().min(10, "10 caractères minimum").max(72)]).optional(),
});

/**
 * « Donner un accès » : crée (ou réutilise) le compte Auth, puis l'adhésion à l'organisation.
 * Compte créé ici puis adhésion refusée (limite de l'offre…) → le compte est supprimé (compensation).
 */
export async function grantOrganizationAccess(
  orgId: string,
  input: z.input<typeof accessSchema>,
): Promise<Result<{ created: boolean; invited: boolean; reactivated: boolean }>> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(orgId).success) return { ok: false, error: "Organisation inconnue." };
  const parsed = accessSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue?.message ?? "Vérifiez les champs.", fieldErrors: issue ? { [String(issue.path[0] ?? "_")]: issue.message } : undefined };
  }
  const v = parsed.data;
  const admin = createAdminClient();
  const { data: org } = await admin.from("organizations").select("id, name").eq("id", orgId).maybeSingle();
  if (!org) return { ok: false, error: "Organisation introuvable." };

  const { data: existing } = await admin.from("users").select("id").ilike("email", likeExact(v.email)).maybeSingle();
  let userId = (existing as { id: string } | null)?.id;
  let created = false;
  let invited = false;
  if (!userId && input.password !== undefined && !v.password) {
    // Formulaire « mot de passe provisoire » laissé vide pour un nouveau compte
    return { ok: false, error: "Nouveau compte : indiquez un mot de passe provisoire (ou choisissez l'invitation).", fieldErrors: { password: "Mot de passe requis" } };
  }
  if (!userId) {
    const res = v.password
      ? await admin.auth.admin.createUser({ email: v.email, password: v.password, email_confirm: true, user_metadata: { full_name: v.fullName } })
      : await admin.auth.admin.inviteUserByEmail(v.email, { data: { full_name: v.fullName }, redirectTo: `${env.appUrl}/auth/set-password` });
    if (res.error || !res.data.user) {
      const taken = /already|exists|registered/i.test(res.error?.message ?? "");
      return {
        ok: false,
        error: taken
          ? "Un compte existe déjà avec cet e-mail."
          : v.password
            ? "Impossible de créer le compte."
            : "Invitation impossible (e-mail non configuré ?) : indiquez un mot de passe provisoire.",
      };
    }
    userId = res.data.user.id;
    created = true;
    invited = !v.password;
  }

  const { data: membership } = await admin
    .from("organization_users")
    .select("id, role, status")
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  const current = membership as { id: string; role: string; status: string } | null;
  if (current?.status === "active" && current.role === v.role) {
    return { ok: false, error: "Cette personne a déjà cet accès.", fieldErrors: { email: "Déjà membre avec ce rôle" } };
  }
  const { error } = current
    ? await admin.from("organization_users").update({ role: v.role, status: "active" } as never).eq("id", current.id)
    : await admin.from("organization_users").insert({ organization_id: orgId, user_id: userId, role: v.role, invited_by: session.user.id, status: "active" } as never);
  if (error) {
    if (created) await admin.auth.admin.deleteUser(userId).catch(() => null);
    const limit = /PLAN_LIMIT_ADMINS/.test(error.message ?? "");
    return {
      ok: false,
      error: limit ? "Limite d'administrateurs de l'offre atteinte : augmentez-la dans « Offre & limites »." : humanizeError(error.message, "Accès impossible à enregistrer."),
    };
  }

  await audit({
    organizationId: orgId,
    actorUserId: session.user.id,
    actorType: "super_admin",
    action: current ? "member.access_restored" : "member.access_granted",
    entityType: "organization_users",
    entityId: userId,
    severity: v.role === "dispatcher" ? "info" : "warning",
    metadata: { email: v.email, role: v.role, previous_role: current?.role ?? null, account_created: created, invitation: invited },
  });
  revalidatePath(`/admin/organizations/${orgId}`);
  return { ok: true, created, invited, reactivated: !!current };
}

/** « Retirer l'accès » / « Rétablir » : statut de l'adhésion (les sessions sont révoquées par trigger SQL). */
export async function setOrganizationMemberStatus(orgId: string, memberId: string, status: "active" | "disabled"): Promise<Result> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(orgId).success || !uuid.safeParse(memberId).success || !["active", "disabled"].includes(status)) {
    return { ok: false, error: "Demande invalide." };
  }
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("organization_users")
    .select("id, user_id, role, status, user:users!organization_users_user_id_fkey(email)")
    .eq("id", memberId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!member) return { ok: false, error: "Membre introuvable." };
  const m = member as unknown as { user_id: string; role: string; status: string; user: { email: string } | { email: string }[] | null };
  if (m.status === status) return { ok: true };
  const { error } = await admin.from("organization_users").update({ status } as never).eq("id", memberId);
  if (error) {
    const limit = /PLAN_LIMIT_ADMINS/.test(error.message ?? "");
    return { ok: false, error: limit ? "Limite d'administrateurs de l'offre atteinte : augmentez-la dans « Offre & limites »." : humanizeError(error.message, "Mise à jour impossible.") };
  }
  const email = (Array.isArray(m.user) ? m.user[0] : m.user)?.email ?? null;
  await audit({
    organizationId: orgId,
    actorUserId: session.user.id,
    actorType: "super_admin",
    action: status === "disabled" ? "member.access_revoked" : "member.access_restored",
    entityType: "organization_users",
    entityId: m.user_id,
    severity: status === "disabled" ? "warning" : "info",
    metadata: { email, role: m.role },
  });
  revalidatePath(`/admin/organizations/${orgId}`);
  return { ok: true };
}

// -----------------------------------------------------------------------------
// Signalements de fraude : bannissement de toute la plateforme (service role + audit)
// -----------------------------------------------------------------------------
type SvcBanResult = { ok: boolean; code: string; message?: string; user_ids?: string[]; drivers?: number; identities?: number };

async function reportContext(reportId: string) {
  const { data } = await createAdminClient()
    .from("fraud_reports")
    .select("organization_id, driver_id, driver_label, category")
    .eq("id", reportId)
    .maybeSingle();
  return data as { organization_id: string; driver_id: string | null; driver_label: string; category: string } | null;
}

/** Ban / levée au niveau Auth (connexion impossible) ; renvoie le nombre de comptes traités. */
async function setAuthBan(userIds: string[], banned: boolean) {
  const admin = createAdminClient();
  const results = await Promise.all(
    userIds.map((id) =>
      admin.auth.admin
        .updateUserById(id, { ban_duration: banned ? BAN_FOREVER : "none" })
        .then((r) => !r.error)
        .catch(() => false),
    ),
  );
  return results.filter(Boolean).length;
}

/** « Bannir de toute la plateforme » : identités refusées dans toutes les centrales, comptes liés suspendus et bannis (Auth). */
export async function platformBanReport(reportId: string, reviewNote?: string): Promise<Result<{ drivers: number; identities: number; message: string }>> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(reportId).success) return { ok: false, error: "Signalement inconnu." };
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("svc_platform_ban", { p_report_id: reportId, p_actor: session.user.id, p_note: note(reviewNote) });
  if (error || !data) return { ok: false, error: "Bannissement impossible." };
  const res = data as SvcBanResult;
  if (!res.ok) return { ok: false, error: res.message ?? "Action impossible." };

  const userIds = res.user_ids ?? [];
  const authBanned = await setAuthBan(userIds, true);
  const report = await reportContext(reportId);
  await audit({
    organizationId: report?.organization_id ?? null,
    actorUserId: session.user.id,
    actorType: "super_admin",
    action: "fraud_report.platform_banned",
    entityType: "fraud_reports",
    entityId: reportId,
    severity: "critical",
    metadata: {
      driver: report?.driver_label, category: report?.category, drivers: res.drivers ?? 0, identities: res.identities ?? 0,
      auth_banned: authBanned, user_ids: userIds, note: note(reviewNote),
    },
  });
  revalidatePath("/admin/centrales");
  return { ok: true, drivers: res.drivers ?? 0, identities: res.identities ?? 0, message: res.message ?? "Banni de toute la plateforme." };
}

/** « Classer » : le bannissement reste limité à la centrale qui a signalé. */
export async function dismissFraudReport(reportId: string, reviewNote?: string): Promise<Result<{ message: string }>> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(reportId).success) return { ok: false, error: "Signalement inconnu." };
  const { data, error } = await createAdminClient().rpc("svc_platform_dismiss_report", {
    p_report_id: reportId, p_actor: session.user.id, p_note: note(reviewNote),
  });
  if (error || !data) return { ok: false, error: "Action impossible." };
  const res = data as SvcBanResult;
  if (!res.ok) return { ok: false, error: res.message ?? "Action impossible." };
  const report = await reportContext(reportId);
  await audit({
    organizationId: report?.organization_id ?? null,
    actorUserId: session.user.id,
    actorType: "super_admin",
    action: "fraud_report.dismissed",
    entityType: "fraud_reports",
    entityId: reportId,
    severity: "info",
    metadata: { driver: report?.driver_label, note: note(reviewNote) },
  });
  revalidatePath("/admin/centrales");
  return { ok: true, message: res.message ?? "Signalement classé." };
}

/** « Lever » un bannissement plateforme : les comptes touchés par ricochet sont débannis (Auth), le chauffeur signalé reste banni par sa centrale. */
export async function liftPlatformBan(reportId: string, reason?: string): Promise<Result<{ identities: number; accounts: number; message: string }>> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(reportId).success) return { ok: false, error: "Signalement inconnu." };
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("svc_platform_unban", { p_report_id: reportId, p_actor: session.user.id, p_reason: note(reason) });
  if (error || !data) return { ok: false, error: "Levée impossible." };
  const res = data as SvcBanResult;
  if (!res.ok) return { ok: false, error: res.message ?? "Action impossible." };

  const userIds = res.user_ids ?? [];
  const authLifted = await setAuthBan(userIds, false);
  const report = await reportContext(reportId);
  await audit({
    organizationId: report?.organization_id ?? null,
    actorUserId: session.user.id,
    actorType: "super_admin",
    action: "fraud_report.platform_ban_lifted",
    entityType: "fraud_reports",
    entityId: reportId,
    severity: "warning",
    metadata: { driver: report?.driver_label, identities: res.identities ?? 0, auth_unbanned: authLifted, user_ids: userIds, reason: note(reason) },
  });
  revalidatePath("/admin/centrales");
  return { ok: true, identities: res.identities ?? 0, accounts: userIds.length, message: res.message ?? "Bannissement plateforme levé." };
}

// -----------------------------------------------------------------------------
// Statut, offre, plans
// -----------------------------------------------------------------------------
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
  await Promise.all(userIds.map((id) => admin.auth.admin.updateUserById(id, { ban_duration: status === "active" ? "none" : BAN_FOREVER }).catch(() => null)));
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
