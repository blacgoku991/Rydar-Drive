"use server";
import {
  describeError, dispatchModelSchema, emailSchema, fieldErrors, humanizeError, ORGANIZATION_CREATE_LABELS, organizationCreateSchema,
  planSchema, type DispatchModelInput, type OrganizationCreateInput,
} from "@rydar/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { findUserIdByEmail, sendMemberInvitationEmail } from "@/lib/member-invite";
import { createAdminClient } from "@/lib/supabase/admin";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string; fieldErrors?: Record<string, string> };

const uuid = z.string().uuid();
/** Motif / note libre (≤ 500 caractères, vide → null). */
const note = (v: string | null | undefined) => v?.trim().slice(0, 500) || null;
/** Ban Auth « définitif » (100 ans) / levée. */
const BAN_FOREVER = "876000h";
/** Noms des champs pour les messages d'erreur (« Frais plateforme (%) : maximum 50 »). */
const FEE_LABELS = { dispatchModel: "Modèle d'exploitation", platformFeePercent: "Frais plateforme (%)", platformFeeFixedCents: "Frais fixes par course" };
const ACCESS_LABELS = { fullName: "Nom complet", email: "E-mail", role: "Rôle", password: "Mot de passe provisoire" };
const PLAN_LABELS = {
  code: "Code", name: "Nom", description: "Description", price_monthly_cents: "Prix mensuel", price_yearly_cents: "Prix annuel",
  limits: "Limites", features: "Avantages",
};

/**
 * Crée un rattacheur + son compte propriétaire + abonnement d'essai, avec son modèle d'exploitation.
 * Propriétaire dont l'adresse a DÉJÀ un compte (autre que le super admin lui-même) : adhésion « invitée » + lien
 * envoyé à l'adresse ; la personne active son accès en choisissant son mot de passe (le mot de passe provisoire saisi
 * n'est pas appliqué). Jamais de rattachement direct d'un compte dont le mot de passe peut être connu d'un tiers.
 */
export async function createOrganization(
  input: z.input<typeof organizationCreateSchema>,
  dispatch?: z.input<typeof dispatchModelSchema>,
): Promise<Result<{ id: string; ownerInvited: boolean; emailSent: boolean; passwordIgnored: boolean }>> {
  const session = await requireSuperAdmin();
  const parsed = organizationCreateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeError(parsed.error, ORGANIZATION_CREATE_LABELS), fieldErrors: fieldErrors(parsed.error) };
  }
  const model = dispatchModelSchema.safeParse(dispatch ?? { dispatchModel: "fleet", platformFeePercent: 0, platformFeeFixedCents: 0 });
  if (!model.success) return { ok: false, error: describeError(model.error, FEE_LABELS), fieldErrors: fieldErrors(model.error) };
  const v: OrganizationCreateInput = parsed.data;
  const m: DispatchModelInput = model.data;
  const admin = createAdminClient();
  // Offre facultative : sans offre, aucune limite (tests, offres pas encore définies)
  let planId: string | null = null;
  if (v.planCode) {
    const { data: plan } = await admin.from("plans").select("id").eq("code", v.planCode).maybeSingle();
    if (!plan) return { ok: false, error: "Offre introuvable : choisissez-en une dans la liste.", fieldErrors: { planCode: "Offre introuvable" } };
    planId = (plan as { id: string }).id;
  }

  const { data: org, error } = await admin
    .from("organizations")
    .insert({ name: v.name, slug: v.slug, plan_id: planId, email: v.email, phone: v.phone || null, city: v.city ?? null, created_by: session.user.id } as never)
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

  let ownerId = (await findUserIdByEmail(v.ownerEmail)) ?? undefined;
  const existingOwner = !!ownerId;
  // Compte existant : invitation prouvée par l'adresse, sauf le super admin qui se nomme lui-même
  const ownerInvited = existingOwner && ownerId !== session.user.id;
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
  const { error: ownerError } = await admin
    .from("organization_users")
    .insert({ organization_id: orgId, user_id: ownerId, role: "owner", invited_by: session.user.id, status: ownerInvited ? "invited" : "active" } as never);
  if (ownerError) {
    // Centrale sans propriétaire : annulée (et le compte créé ici supprimé)
    if (!existingOwner) await admin.auth.admin.deleteUser(ownerId).catch(() => null);
    await admin.from("organizations").delete().eq("id", orgId);
    return { ok: false, error: humanizeError(ownerError.message, "Compte propriétaire impossible à rattacher.") };
  }
  const emailSent = ownerInvited ? await sendMemberInvitationEmail(v.ownerEmail) : false;
  if (planId) {
    await admin.from("subscriptions").insert({
      organization_id: orgId, plan_id: planId, status: "trialing",
      trial_ends_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    } as never);
  }
  await audit({
    organizationId: orgId, actorUserId: session.user.id, actorType: "super_admin", action: "organization.created", entityType: "organizations", entityId: orgId,
    metadata: {
      plan: v.planCode || null, owner: v.ownerEmail, dispatch_model: m.dispatchModel, platform_fee_percent: m.platformFeePercent, platform_fee_fixed_cents: m.platformFeeFixedCents,
      owner_existing_account: existingOwner, owner_invited: ownerInvited, invitation_email_sent: emailSent,
    },
  });
  revalidatePath("/admin");
  revalidatePath("/admin/organizations");
  revalidatePath("/admin/centrales");
  return { ok: true, id: orgId, ownerInvited, emailSent, passwordIgnored: existingOwner && !!v.ownerPassword };
}

/**
 * Modèle d'exploitation (flotte / centrale à commission) + frais plateforme d'un compte.
 * Retour au mode flotte : refusé s'il reste des règlements chauffeur ouverts (trigger SQL
 * organizations_dispatch_model_guard). Le lien d'inscription des chauffeurs est conservé dans les deux sens (code, état,
 * validation automatique ; candidatures en attente inchangées, 20260924006300). Passage en centrale : répartition des
 * courses non clôturées (SQL).
 */
export async function updateDispatchModel(orgId: string, input: z.input<typeof dispatchModelSchema>): Promise<Result> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(orgId).success) return { ok: false, error: "Organisation inconnue." };
  const parsed = dispatchModelSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: describeError(parsed.error, FEE_LABELS), fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  const admin = createAdminClient();
  const { data: before } = await admin
    .from("organizations")
    .select("dispatch_model, platform_fee_percent, platform_fee_fixed_cents, join_enabled")
    .eq("id", orgId)
    .maybeSingle();
  if (!before) return { ok: false, error: "Organisation introuvable." };
  const b = before as { dispatch_model: string; platform_fee_percent: number; platform_fee_fixed_cents: number; join_enabled: boolean };

  // Retour au mode flotte : refusé tant qu'il reste des règlements chauffeur ouverts (écrans Encaissements /
  // Commissions et relances réservés au mode centrale : dettes et parts à verser ne seraient plus suivies)
  const openSettlements = (n: number) =>
    `${n} règlement${n > 1 ? "s" : ""} chauffeur encore ouvert${n > 1 ? "s" : ""} (à régler, signalé${n > 1 ? "s" : ""} payé${n > 1 ? "s" : ""} ou contesté${n > 1 ? "s" : ""}) : la centrale doit les solder ou les annuler dans Encaissements avant le retour au mode flotte.`;
  if (b.dispatch_model === "centrale" && v.dispatchModel === "fleet") {
    const { count, error: countError } = await admin
      .from("ride_settlements")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .in("status", ["due", "declared", "disputed"]);
    if (countError) return { ok: false, error: "Mise à jour impossible." };
    if (count) return { ok: false, error: openSettlements(count) };
  }

  const { error } = await admin
    .from("organizations")
    .update({ dispatch_model: v.dispatchModel, platform_fee_percent: v.platformFeePercent, platform_fee_fixed_cents: v.platformFeeFixedCents } as never)
    .eq("id", orgId);
  if (error) {
    // Garde SQL (organizations_dispatch_model_guard) : règlement ouvert entre-temps
    const open = /SETTLEMENTS_OPEN: (\d+)/.exec(error.message ?? "");
    if (open) return { ok: false, error: openSettlements(Number(open[1])) };
    return { ok: false, error: error.code === "23514" ? "Frais plateforme hors limites (0 à 50 %, 0 à 1 000 €)." : "Mise à jour impossible." };
  }

  const modelChanged = b.dispatch_model !== v.dispatchModel;
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
      // Lien d'inscription conservé tel quel lors d'un changement de modèle
      join_link_enabled: b.join_enabled,
    },
  });
  revalidatePath(`/admin/organizations/${orgId}`);
  revalidatePath("/admin/organizations");
  revalidatePath("/admin/centrales");
  // Frais Rydar (centrales ET flottes) : vue d'ensemble et compte relus ; le tableau de bord de l'organisation est
  // prévenu par la base (trigger organizations_platform_rates_broadcast : « platform.updated », rates / model)
  revalidatePath("/admin/frais");
  revalidatePath(`/admin/frais/${orgId}`);
  return { ok: true };
}

const accessSchema = z.object({
  fullName: z.string().trim().min(2, "Nom requis").max(120),
  email: emailSchema,
  role: z.enum(["owner", "admin", "dispatcher"]),
  password: z.union([z.literal(""), z.string().min(10, "10 caractères minimum").max(72)]).optional(),
});

/**
 * « Donner un accès » : crée le compte Auth (adresse sans compte) ou réutilise le compte existant, puis l'adhésion.
 * Compte créé ici puis adhésion refusée (limite de l'offre…) → le compte est supprimé (compensation).
 * Compte EXISTANT sans adhésion (autre que le super admin lui-même) : adhésion « invitée » + lien envoyé à l'adresse,
 * activée par la personne (mot de passe provisoire non appliqué) ; invitation déjà en attente : lien renvoyé.
 * Adhésion désactivée : rétablie (la personne avait déjà eu cet accès).
 */
export async function grantOrganizationAccess(
  orgId: string,
  input: z.input<typeof accessSchema>,
): Promise<Result<{ created: boolean; invited: boolean; reactivated: boolean; pending: boolean; emailSent: boolean; passwordIgnored: boolean }>> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(orgId).success) return { ok: false, error: "Organisation inconnue." };
  const parsed = accessSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: describeError(parsed.error, ACCESS_LABELS), fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  const admin = createAdminClient();
  const { data: org } = await admin.from("organizations").select("id, name").eq("id", orgId).maybeSingle();
  if (!org) return { ok: false, error: "Organisation introuvable." };

  let userId = (await findUserIdByEmail(v.email)) ?? undefined;
  const existingAccount = !!userId;
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
  // Compte existant jamais membre (sauf le super admin lui-même) ou invitation en attente : preuve par l'adresse exigée
  const pending = !created && (current ? current.status === "invited" : userId !== session.user.id);
  const { error } = current
    ? await admin
        .from("organization_users")
        .update((current.status === "invited" ? { role: v.role } : { role: v.role, status: "active" }) as never)
        .eq("id", current.id)
    : await admin
        .from("organization_users")
        .insert({ organization_id: orgId, user_id: userId, role: v.role, invited_by: session.user.id, status: pending ? "invited" : "active" } as never);
  if (error) {
    if (created) await admin.auth.admin.deleteUser(userId).catch(() => null);
    const limit = /PLAN_LIMIT_ADMINS/.test(error.message ?? "");
    return {
      ok: false,
      error: limit ? "Limite d'administrateurs de l'offre atteinte : augmentez-la dans « Offre & limites »." : humanizeError(error.message, "Accès impossible à enregistrer."),
    };
  }
  const emailSent = pending ? await sendMemberInvitationEmail(v.email) : false;

  await audit({
    organizationId: orgId,
    actorUserId: session.user.id,
    actorType: "super_admin",
    action: pending ? "member.invited" : current ? "member.access_restored" : "member.access_granted",
    entityType: "organization_users",
    entityId: userId,
    severity: v.role === "dispatcher" ? "info" : "warning",
    metadata: {
      email: v.email, role: v.role, previous_role: current?.role ?? null, account_created: created, invitation: invited,
      existing_account: existingAccount, pending_invitation: pending, invitation_email_sent: emailSent,
    },
  });
  revalidatePath(`/admin/organizations/${orgId}`);
  return {
    ok: true, created, invited, reactivated: !!current && !pending, pending, emailSent,
    passwordIgnored: existingAccount && !!v.password,
  };
}

/** « Renvoyer l'invitation » (super admin) : nouveau lien envoyé à l'adresse d'un compte invité. */
export async function resendOrganizationInvitation(orgId: string, memberId: string): Promise<Result> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(orgId).success || !uuid.safeParse(memberId).success) return { ok: false, error: "Demande invalide." };
  const { data } = await createAdminClient()
    .from("organization_users")
    .select("user_id, role, status, user:users!organization_users_user_id_fkey(email)")
    .eq("id", memberId)
    .eq("organization_id", orgId)
    .maybeSingle();
  const m = data as { user_id: string; role: string; status: string; user: { email: string } | { email: string }[] | null } | null;
  if (!m || m.status !== "invited") return { ok: false, error: "Invitation introuvable (déjà acceptée ou annulée ?)." };
  const email = (Array.isArray(m.user) ? m.user[0] : m.user)?.email;
  if (!email) return { ok: false, error: "Adresse du compte introuvable." };
  if (!(await sendMemberInvitationEmail(email))) return { ok: false, error: "Envoi impossible pour le moment : réessayez dans une minute." };
  await audit({
    organizationId: orgId, actorUserId: session.user.id, actorType: "super_admin", action: "member.invitation_resent",
    entityType: "organization_users", entityId: m.user_id, metadata: { email, role: m.role },
  });
  return { ok: true };
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
  if (m.status === "invited") {
    // Invitation en attente : seule la personne l'active (lien reçu par e-mail) ; « Retirer » = l'annuler (suppression)
    if (status === "active") return { ok: false, error: "Invitation en attente : seule la personne invitée peut l'activer, avec le lien reçu par e-mail." };
    const { error: delError } = await admin.from("organization_users").delete().eq("id", memberId).eq("status", "invited");
    if (delError) return { ok: false, error: humanizeError(delError.message, "Annulation impossible.") };
    await audit({
      organizationId: orgId, actorUserId: session.user.id, actorType: "super_admin", action: "member.invitation_cancelled",
      entityType: "organization_users", entityId: m.user_id, metadata: { email: (Array.isArray(m.user) ? m.user[0] : m.user)?.email ?? null, role: m.role },
    });
    revalidatePath(`/admin/organizations/${orgId}`);
    return { ok: true };
  }
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
type SvcBanResult = {
  ok: boolean; code: string; message?: string; user_ids?: string[]; drivers?: number; identities?: number;
  identities_skipped?: number; extended?: number; skipped_drivers?: number; kept_user_ids?: string[];
};

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

type FraudReportPreview = {
  reportedAt: string;
  /** Identités du signalement ; edited_by_org_at = dernière saisie de cette valeur par la centrale qui signale. */
  identities: { kind: import("@rydar/shared").IdentityKind; hint: string | null; edited_by_org_at: string | null }[];
  /** Fiches qui partagent une identité : même centrale (suspendues avec lui) ou autres centrales (à confirmer). */
  matches: {
    driver_id: string; number: number; first_name: string; last_name: string; organization_id: string; organization_name: string;
    same_org: boolean; created_at: string; status: import("@rydar/shared").DriverStatus; application_status: string | null;
    banned: boolean; kinds: import("@rydar/shared").IdentityKind[]; manages_org: boolean;
  }[];
};

/** Aperçu avant « Bannir de toute la plateforme » : fiches qui partagent une identité du signalement (toutes centrales). */
export async function fraudReportMatches(reportId: string): Promise<Result<{ preview: FraudReportPreview }>> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(reportId).success) return { ok: false, error: "Signalement inconnu." };
  // Session du super admin : contrôle d'accès dans la fonction SQL
  const { data, error } = await session.supabase.rpc("admin_fraud_report_matches", { p_report_id: reportId });
  if (error || !data) return { ok: false, error: "Aperçu indisponible." };
  const res = data as { ok: boolean; message?: string; reported_at?: string } & Partial<Omit<FraudReportPreview, "reportedAt">>;
  if (!res.ok) return { ok: false, error: res.message ?? "Signalement introuvable." };
  return { ok: true, preview: { reportedAt: res.reported_at ?? new Date().toISOString(), identities: res.identities ?? [], matches: res.matches ?? [] } };
}

/**
 * « Bannir de toute la plateforme » : identités refusées dans toutes les centrales ; chauffeur signalé et fiches de sa
 * centrale suspendus ; fiches d'AUTRES centrales seulement si confirmées (extendDriverIds, cf. fraudReportMatches) ;
 * comptes bannis (Auth), sauf ceux qui gèrent aussi une centrale (fiche bannie, connexion conservée).
 */
export async function platformBanReport(
  reportId: string,
  reviewNote?: string,
  extendDriverIds: string[] = [],
): Promise<Result<{ drivers: number; identities: number; identitiesSkipped: number; extended: number; message: string }>> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(reportId).success) return { ok: false, error: "Signalement inconnu." };
  const extend = z.array(uuid).max(500).safeParse(extendDriverIds);
  if (!extend.success) return { ok: false, error: "Sélection de fiches invalide." };
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("svc_platform_ban", {
    p_report_id: reportId, p_actor: session.user.id, p_note: note(reviewNote), p_extend_driver_ids: [...new Set(extend.data)],
  });
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
      identities_skipped: res.identities_skipped ?? 0, extended: res.extended ?? 0, skipped_drivers: res.skipped_drivers ?? 0,
      auth_banned: authBanned, auth_kept: (res.kept_user_ids ?? []).length, user_ids: userIds, note: note(reviewNote),
    },
  });
  revalidatePath("/admin/centrales");
  return {
    ok: true, drivers: res.drivers ?? 0, identities: res.identities ?? 0, identitiesSkipped: res.identities_skipped ?? 0,
    extended: res.extended ?? 0, message: res.message ?? "Banni de toute la plateforme.",
  };
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
type DriverBanRow = { user_id: string | null; status: string; application_status: string | null; banned_at: string | null; deleted_at: string | null };
/** Fiche qui autorise la connexion à l'app : active ou candidature en attente, non bannie, non supprimée. */
const driverMayLogin = (d: DriverBanRow) => !d.banned_at && !d.deleted_at && (d.status === "active" || d.application_status === "pending");

/**
 * Réactivation : comptes dont un ANCIEN bannissement Auth hérité est levé (ancienne suspension de centrale, ancienne
 * désactivation de fiche qui bannissait le compte) :
 *  - chauffeurs de la centrale autorisés à se connecter (fiche active ou candidature en attente) ;
 *  - membres actifs : comptes de gestion, jamais verrouillés pour une raison de fiche chauffeur — levée même si leur
 *    fiche (ici ou ailleurs) est inactive ou suspendue, SAUF fiche bannie (centrale ou plateforme) : vrai bannissement,
 *    levé là où il a été décidé.
 */
async function inheritedBanUserIds(orgId: string) {
  const admin = createAdminClient();
  const [{ data: members }, { data: drivers }] = await Promise.all([
    admin.from("organization_users").select("user_id").eq("organization_id", orgId).eq("status", "active"),
    admin.from("drivers").select("user_id, status, application_status, banned_at, deleted_at").eq("organization_id", orgId).not("user_id", "is", null),
  ]);
  // Une seule fiche par compte (drivers.user_id unique) : celle des chauffeurs d'ici est déjà lue
  const candidates = new Set<string>(((drivers ?? []) as DriverBanRow[]).filter(driverMayLogin).map((d) => d.user_id!));
  const memberIds = ((members ?? []) as { user_id: string }[]).map((m) => m.user_id);
  if (memberIds.length) {
    // Membre qui est aussi chauffeur (ici ou ailleurs) : seule une fiche bannie garde le verrou
    const { data: rows } = await admin.from("drivers").select("user_id, status, application_status, banned_at, deleted_at").in("user_id", memberIds);
    const banned = new Set(((rows ?? []) as DriverBanRow[]).filter((d) => !!d.banned_at).map((d) => d.user_id));
    for (const id of memberIds) if (!banned.has(id)) candidates.add(id);
  }
  return [...candidates];
}

/**
 * « Débloquer la connexion » d'un membre (page de la centrale, carte « Accès ») : lève le verrou Auth d'un compte qui
 * n'est PAS banni — victime d'un ancien bannissement hérité (suspension de centrale, désactivation de sa fiche chauffeur
 * par une autre centrale avant le correctif), qu'aucune autre action ne lève. Fiche chauffeur bannie (centrale ou
 * plateforme) : refus, ce bannissement se lève là où il a été décidé. Journalisé (member.login_unlocked).
 */
export async function unlockMemberLogin(orgId: string, memberId: string): Promise<Result<{ message: string }>> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(orgId).success || !uuid.safeParse(memberId).success) return { ok: false, error: "Demande invalide." };
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("organization_users")
    .select("user_id, role, status, user:users!organization_users_user_id_fkey(email)")
    .eq("id", memberId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!member) return { ok: false, error: "Membre introuvable." };
  const m = member as unknown as { user_id: string; role: string; status: string; user: { email: string } | { email: string }[] | null };
  const email = (Array.isArray(m.user) ? m.user[0] : m.user)?.email ?? null;

  const [{ data: row, error: cardError }, { data: account, error: accountError }] = await Promise.all([
    admin.from("drivers").select("id, status, banned_at, ban_scope, organization_id").eq("user_id", m.user_id).maybeSingle(),
    admin.auth.admin.getUserById(m.user_id),
  ]);
  if (cardError || accountError || !account?.user) return { ok: false, error: "Vérification impossible pour le moment : réessayez." };
  const card = row as { id: string; status: string; banned_at: string | null; ban_scope: string | null; organization_id: string } | null;
  if (card?.banned_at) {
    return {
      ok: false,
      error:
        card.ban_scope === "platform"
          ? "Compte banni de la plateforme (signalement de fraude) : la connexion reste bloquée tant que ce bannissement n'est pas levé (Centrales)."
          : "Fiche chauffeur bannie par sa centrale : la connexion reste bloquée ; seule cette centrale peut lever le bannissement.",
    };
  }
  const bannedUntil = account.user.banned_until ? Date.parse(account.user.banned_until) : NaN;
  if (!(bannedUntil > Date.now())) return { ok: true, message: "Ce compte n'est pas bloqué : aucune action nécessaire." };

  const { error } = await admin.auth.admin.updateUserById(m.user_id, { ban_duration: "none" });
  if (error) return { ok: false, error: "Déblocage impossible pour le moment : réessayez." };
  await audit({
    organizationId: orgId,
    actorUserId: session.user.id,
    actorType: "super_admin",
    action: "member.login_unlocked",
    entityType: "organization_users",
    entityId: m.user_id,
    severity: "warning",
    metadata: {
      email, role: m.role, member_status: m.status, banned_until: account.user.banned_until ?? null,
      driver_id: card?.id ?? null, driver_status: card?.status ?? null, driver_organization_id: card?.organization_id ?? null,
    },
  });
  revalidatePath(`/admin/organizations/${orgId}`);
  return { ok: true, message: `Connexion débloquée : ${email ?? "ce compte"} peut de nouveau se connecter.` };
}

/**
 * Suspendre / réactiver / archiver : effet immédiat via la RLS (données, actions, connexion chauffeur refusée avec le
 * motif « centrale suspendue ») et le déclencheur SQL des sessions. Plus aucun bannissement Auth : l'équipe doit pouvoir
 * ouvrir /suspended pour régler ses frais, et un membre d'une autre centrale active ou le super admin ne sont jamais
 * verrouillés. Réactivation : levée des anciens bannissements hérités (membres actifs sauf fiche bannie, chauffeurs
 * autorisés : inheritedBanUserIds).
 */
export async function setOrganizationStatus(orgId: string, status: "active" | "suspended" | "archived", reason?: string): Promise<Result> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(orgId).success || !["active", "suspended", "archived"].includes(status)) return { ok: false, error: "Demande invalide." };
  const admin = createAdminClient();
  const motive = note(reason);
  const patch: Record<string, unknown> = { status };
  if (status === "suspended") Object.assign(patch, { suspended_at: new Date().toISOString(), suspended_reason: motive });
  if (status === "archived") Object.assign(patch, { archived_at: new Date().toISOString() });
  if (status === "active") Object.assign(patch, { suspended_at: null, suspended_reason: null, archived_at: null });
  const { error } = await admin.from("organizations").update(patch as never).eq("id", orgId);
  if (error) return { ok: false, error: "Mise à jour impossible." };

  let unbanned = 0;
  if (status === "active") unbanned = await setAuthBan(await inheritedBanUserIds(orgId), false);
  else await admin.from("drivers").update({ presence: "offline", online_since: null } as never).eq("organization_id", orgId);

  await audit({ organizationId: orgId, actorUserId: session.user.id, actorType: "super_admin", action: `organization.${status}`, entityType: "organizations", entityId: orgId, severity: status === "active" ? "info" : "warning", metadata: { reason: motive, auth_unbanned: unbanned } });
  revalidatePath(`/admin/organizations/${orgId}`);
  revalidatePath("/admin");
  return { ok: true };
}

const limitsOverrideSchema = z.record(z.string(), z.union([z.number().int().min(0), z.boolean(), z.null()]));

/** Offre d'une centrale (planId vide = sans offre : aucune limite) + surcharges de limites. */
export async function updateOrganizationPlan(orgId: string, planId: string | null, limitsOverride: Record<string, unknown>): Promise<Result> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(orgId).success) return { ok: false, error: "Organisation inconnue." };
  if (planId && !uuid.safeParse(planId).success) return { ok: false, error: "Offre inconnue." };
  const parsed = limitsOverrideSchema.safeParse(limitsOverride);
  if (!parsed.success) return { ok: false, error: "Limites invalides." };
  const { error } = await createAdminClient().from("organizations").update({ plan_id: planId || null, limits_override: parsed.data } as never).eq("id", orgId);
  if (error) return { ok: false, error: "Mise à jour impossible." };
  await audit({ organizationId: orgId, actorUserId: session.user.id, actorType: "super_admin", action: "organization.plan_changed", entityType: "organizations", entityId: orgId, metadata: { planId, limitsOverride: parsed.data } });
  revalidatePath(`/admin/organizations/${orgId}`);
  return { ok: true };
}

export async function savePlan(id: string | null, input: z.input<typeof planSchema>): Promise<Result> {
  const session = await requireSuperAdmin();
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: describeError(parsed.error, PLAN_LABELS), fieldErrors: fieldErrors(parsed.error) };
  const admin = createAdminClient();
  const { error } = id ? await admin.from("plans").update(parsed.data as never).eq("id", id) : await admin.from("plans").insert(parsed.data as never);
  if (error) return { ok: false, error: error.code === "23505" ? "Code déjà utilisé." : "Enregistrement impossible." };
  await audit({ actorUserId: session.user.id, actorType: "super_admin", action: id ? "plan.updated" : "plan.created", entityType: "plans", entityId: id ?? parsed.data.code });
  revalidatePath("/admin/plans");
  return { ok: true };
}
