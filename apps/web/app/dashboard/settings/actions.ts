"use server";
import {
  centraleSettingsSchema, describeError, emailSchema, humanizeError, orgSettingsSchema, organizationUpdateSchema, reminderChannelsSchema,
  VEHICLE_CATEGORIES, whatsappConfigSchema,
} from "@rydar/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { centraleIssues } from "@/components/settlements/settings-schema";
import { audit } from "@/lib/audit";
import { isAdminRole } from "@/lib/auth";
import { env } from "@/lib/env";
import { actionError } from "@/lib/errors";
import { findUserIdByEmail, sendMemberInvitationEmail } from "@/lib/member-invite";
import { getOrgContext } from "@/lib/org-context";
import { createAdminClient } from "@/lib/supabase/admin";
import { removeWhatsApp, saveWhatsApp, testWhatsApp, type WhatsAppActionResult } from "@/lib/whatsapp";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** Noms des réglages de dispatch pour les messages d'erreur. */
const SETTINGS_LABELS: Record<string, string> = {
  dispatch_radii_m: "Rayons de recherche", dispatch_retry_radii_m: "Relance", offer_timeout_seconds: "Délai de réponse du chauffeur", max_search_seconds: "Durée maximale de recherche",
  max_offers_per_wave: "Chauffeurs sollicités par vague", instant_threshold_minutes: "Seuil course immédiate",
  scheduled_dispatch_lead_minutes: "Anticipation des courses planifiées", reminder_offsets_minutes: "Rappels",
  location_max_age_seconds: "Fraîcheur de la position GPS", default_payment_method: "Paiement par défaut",
};

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
      address: v.address ?? null, city: v.city ?? null, postal_code: v.postalCode ?? null, vtc_registration: v.vtcRegistration ?? null,
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
  if (!parsed.success) return { ok: false, error: describeError(parsed.error, SETTINGS_LABELS) };
  // Mode centrale : la commission se règle dans « Commission & encaissement » (jamais écrasée d'ici)
  const { driver_commission_percent: _commission, ...dispatch } = parsed.data;
  const patch = ctx.org.dispatch_model === "centrale" ? dispatch : parsed.data;
  const { error } = await ctx.supabase.from("organization_settings").update(patch).eq("organization_id", ctx.org.id);
  if (error) return { ok: false, error: actionError(error) };
  revalidatePath("/dashboard/settings");
  return { ok: true };
}

/** Mode centrale : commission, délai de règlement, blocages, moyens et lien de paiement (owner / admin). */
export async function updateCentraleSettings(input: z.input<typeof centraleSettingsSchema>): Promise<Result<{ fieldErrors?: Record<string, string> }>> {
  const ctx = await adminCtx();
  if (!ctx) return { ok: false, error: "Réservé aux administrateurs." };
  if (ctx.org.dispatch_model !== "centrale") return { ok: false, error: "Réservé au mode centrale." };
  const parsed = centraleSettingsSchema.safeParse(input);
  if (!parsed.success) {
    const issues = centraleIssues(parsed.error);
    return { ok: false, error: Object.values(issues)[0] ?? "Réglages invalides." };
  }
  const v = parsed.data;
  const { error } = await ctx.supabase
    .from("organization_settings")
    .update({
      driver_commission_percent: v.commissionPercent,
      driver_commission_fixed_cents: v.commissionFixedCents,
      settlement_grace_hours: v.graceHours,
      settlement_credit_limit_cents: v.creditLimitCents,
      block_unpaid: v.blockUnpaid,
      new_driver_max_price_cents: v.newDriverMaxPriceCents,
      trust_after_rides: v.trustAfterRides,
      settlement_methods: v.methods,
      settlement_link: v.link,
      settlement_instructions: v.instructions,
      settlement_payee_name: v.payeeName,
      settlement_iban: v.iban,
      settlement_bic: v.bic,
    })
    .eq("organization_id", ctx.org.id);
  if (error) return { ok: false, error: actionError(error, "Enregistrement impossible.") };
  // Lien et instructions servent aussi aux réclamations WhatsApp (alertes, fiches) : mise en page relue
  revalidatePath("/dashboard", "layout");
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

/** Adhésion refusée à l'insertion (déjà membre ou invité, limite de l'offre…) → message lisible. */
async function memberInsertError(error: { code?: string; message?: string }, orgId: string, userId: string) {
  if (error.code !== "23505") return humanizeError(error.message, actionError(error));
  const { data } = await createAdminClient().from("organization_users").select("status").eq("organization_id", orgId).eq("user_id", userId).maybeSingle();
  const status = (data as { status: string } | null)?.status;
  return status === "invited"
    ? "Invitation déjà envoyée à cette adresse : utilisez « Renvoyer l'invitation »."
    : status === "disabled"
      ? "Cette personne fait déjà partie de l'équipe (désactivée) : réactivez-la depuis la liste."
      : "Cette personne fait déjà partie de l'équipe.";
}

/**
 * Ajoute un membre de l'équipe (admin / dispatcher).
 *  - Adresse sans compte : compte créé (mot de passe provisoire ou invitation Supabase), accès immédiat ; si l'ajout
 *    échoue ensuite (limite de l'offre…), le compte créé est supprimé.
 *  - Compte EXISTANT : jamais rattaché directement (son mot de passe peut être connu d'un tiers) → adhésion
 *    « invitée » sans accès + lien envoyé à l'adresse ; la personne active l'accès en choisissant son mot de passe.
 *    Le mot de passe provisoire éventuel n'est pas appliqué.
 */
export async function inviteMember(
  input: z.input<typeof inviteSchema>,
): Promise<Result<{ invited: boolean; existingAccount: boolean; emailSent: boolean; passwordIgnored: boolean }>> {
  const ctx = await adminCtx();
  if (!ctx) return { ok: false, error: "Réservé aux administrateurs." };
  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Vérifiez les champs." };
  const v = parsed.data;
  const admin = createAdminClient();

  const existingId = await findUserIdByEmail(v.email);
  if (existingId) {
    const { error } = await admin
      .from("organization_users")
      .insert({ organization_id: ctx.org.id, user_id: existingId, role: v.role, invited_by: ctx.user.id, status: "invited" } as never);
    if (error) return { ok: false, error: await memberInsertError(error, ctx.org.id, existingId) };
    const emailSent = await sendMemberInvitationEmail(v.email);
    await audit({
      organizationId: ctx.org.id, actorUserId: ctx.user.id, action: "member.invited", entityType: "organization_users", entityId: existingId,
      metadata: { role: v.role, email: v.email, existing_account: true, email_sent: emailSent },
    });
    revalidatePath("/dashboard/settings");
    return { ok: true, invited: true, existingAccount: true, emailSent, passwordIgnored: !!v.password };
  }

  const res = v.password
    ? await admin.auth.admin.createUser({ email: v.email, password: v.password, email_confirm: true, user_metadata: { full_name: v.fullName } })
    : await admin.auth.admin.inviteUserByEmail(v.email, { data: { full_name: v.fullName }, redirectTo: `${env.appUrl}/auth/set-password` });
  if (res.error || !res.data.user) {
    return {
      ok: false,
      error: /already|exists|registered/i.test(res.error?.message ?? "")
        ? "Un compte existe déjà avec cet e-mail : réessayez dans un instant."
        : "Impossible de créer le compte (invitation e-mail non configurée ?).",
    };
  }
  const userId = res.data.user.id;
  const { error } = await admin
    .from("organization_users")
    .insert({ organization_id: ctx.org.id, user_id: userId, role: v.role, invited_by: ctx.user.id, status: "active" } as never);
  if (error) {
    // Compte créé ici mais ajout refusé : pas de compte orphelin
    await admin.auth.admin.deleteUser(userId).catch(() => null);
    return { ok: false, error: await memberInsertError(error, ctx.org.id, userId) };
  }
  await audit({ organizationId: ctx.org.id, actorUserId: ctx.user.id, action: "member.added", entityType: "organization_users", entityId: userId, metadata: { role: v.role, email: v.email } });
  revalidatePath("/dashboard/settings");
  return { ok: true, invited: !v.password, existingAccount: false, emailSent: !v.password, passwordIgnored: false };
}

const memberIdSchema = z.string().uuid();
const memberPatchSchema = z
  .object({ role: z.enum(["admin", "dispatcher"]).optional(), status: z.enum(["active", "disabled"]).optional() })
  .strict()
  .refine((p) => p.role !== undefined || p.status !== undefined);

export async function updateMember(memberId: string, patch: { role?: "admin" | "dispatcher"; status?: "active" | "disabled" }): Promise<Result> {
  const ctx = await getOrgContext();
  if (!ctx || ctx.role !== "owner") return { ok: false, error: "Réservé au propriétaire du compte." };
  const parsedPatch = memberPatchSchema.safeParse(patch);
  if (!memberIdSchema.safeParse(memberId).success || !parsedPatch.success) return { ok: false, error: "Demande invalide." };
  // Seuls ces deux champs sont écrits (jamais user_id, organization_id, rôle « owner »…)
  const update = { ...(parsedPatch.data.role ? { role: parsedPatch.data.role } : {}), ...(parsedPatch.data.status ? { status: parsedPatch.data.status } : {}) };
  const admin = createAdminClient();
  const { data: member } = await admin.from("organization_users").select("user_id, role, status").eq("id", memberId).eq("organization_id", ctx.org.id).maybeSingle();
  if (!member) return { ok: false, error: "Membre introuvable." };
  const m = member as { user_id: string; role: string; status: string };
  if (m.role === "owner") return { ok: false, error: "Le propriétaire ne peut pas être modifié." };
  if (m.status === "invited" && update.status) {
    return { ok: false, error: "Invitation en attente : seule la personne invitée peut l'activer. Renvoyez-la ou annulez-la." };
  }
  const { error } = await admin.from("organization_users").update(update as never).eq("id", memberId).eq("organization_id", ctx.org.id);
  if (error) return { ok: false, error: humanizeError(error.message, actionError(error)) };
  await audit({ organizationId: ctx.org.id, actorUserId: ctx.user.id, action: "member.updated", entityType: "organization_users", entityId: memberId, metadata: update, severity: update.status === "disabled" ? "warning" : "info" });
  revalidatePath("/dashboard/settings");
  return { ok: true };
}

/** Invitation en attente de la centrale active (admin / owner). */
async function pendingInvitation(memberId: string) {
  const ctx = await adminCtx();
  if (!ctx) return { ctx: null, error: "Réservé aux administrateurs." } as const;
  if (!memberIdSchema.safeParse(memberId).success) return { ctx: null, error: "Invitation introuvable." } as const;
  const { data } = await createAdminClient()
    .from("organization_users")
    .select("id, user_id, role, status, user:users!organization_users_user_id_fkey(email)")
    .eq("id", memberId)
    .eq("organization_id", ctx.org.id)
    .maybeSingle();
  const row = data as { id: string; user_id: string; role: string; status: string; user: { email: string } | { email: string }[] | null } | null;
  if (!row || row.status !== "invited") return { ctx: null, error: "Invitation introuvable (déjà acceptée ou annulée ?)." } as const;
  const email = (Array.isArray(row.user) ? row.user[0] : row.user)?.email ?? null;
  return { ctx, row, email, error: null } as const;
}

/** « Renvoyer l'invitation » : nouveau lien envoyé à l'adresse du compte invité. */
export async function resendMemberInvitation(memberId: string): Promise<Result> {
  const inv = await pendingInvitation(memberId);
  if (!inv.ctx) return { ok: false, error: inv.error };
  if (!inv.email) return { ok: false, error: "Adresse du compte introuvable." };
  const sent = await sendMemberInvitationEmail(inv.email);
  if (!sent) return { ok: false, error: "Envoi impossible pour le moment : réessayez dans une minute." };
  await audit({
    organizationId: inv.ctx.org.id, actorUserId: inv.ctx.user.id, action: "member.invitation_resent", entityType: "organization_users",
    entityId: inv.row.user_id, metadata: { role: inv.row.role, email: inv.email },
  });
  return { ok: true };
}

/** « Annuler l'invitation » : l'adhésion en attente est supprimée (aucune session n'est touchée). */
export async function cancelMemberInvitation(memberId: string): Promise<Result> {
  const inv = await pendingInvitation(memberId);
  if (!inv.ctx) return { ok: false, error: inv.error };
  const { error } = await createAdminClient()
    .from("organization_users")
    .delete()
    .eq("id", inv.row.id)
    .eq("organization_id", inv.ctx.org.id)
    .eq("status", "invited");
  if (error) return { ok: false, error: humanizeError(error.message, actionError(error)) };
  await audit({
    organizationId: inv.ctx.org.id, actorUserId: inv.ctx.user.id, action: "member.invitation_cancelled", entityType: "organization_users",
    entityId: inv.row.user_id, metadata: { role: inv.row.role, email: inv.email },
  });
  revalidatePath("/dashboard/settings");
  return { ok: true };
}

// ---------------------------------------------------------------------------- relances WhatsApp (mode centrale)
/** Canaux des relances de commission : application, WhatsApp, ou les deux. */
export async function updateReminderChannels(channels: string[]): Promise<Result> {
  const ctx = await adminCtx();
  if (!ctx) return { ok: false, error: "Réservé aux administrateurs." };
  if (ctx.org.dispatch_model !== "centrale") return { ok: false, error: "Réservé au mode centrale." };
  const parsed = reminderChannelsSchema.safeParse([...new Set(channels)]);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Canal invalide." };
  if (parsed.data.includes("whatsapp")) {
    const { data } = await ctx.supabase.from("org_whatsapp").select("enabled").eq("organization_id", ctx.org.id).maybeSingle();
    if (!data?.enabled) return { ok: false, error: "Reliez d'abord votre numéro WhatsApp Business (ci-dessous)." };
  }
  const { error } = await ctx.supabase.from("organization_settings").update({ reminder_channels: parsed.data }).eq("organization_id", ctx.org.id);
  if (error) return { ok: false, error: actionError(error) };
  revalidatePath("/dashboard/settings");
  return { ok: true };
}

export async function saveOrgWhatsApp(input: z.input<typeof whatsappConfigSchema>): Promise<WhatsAppActionResult> {
  const ctx = await adminCtx();
  if (!ctx) return { ok: false, error: "Réservé aux administrateurs." };
  const res = await saveWhatsApp(ctx.org.id, ctx.user.id, input);
  if (res.ok) revalidatePath("/dashboard/settings");
  return res;
}

export async function removeOrgWhatsApp(): Promise<WhatsAppActionResult> {
  const ctx = await adminCtx();
  if (!ctx) return { ok: false, error: "Réservé aux administrateurs." };
  const res = await removeWhatsApp(ctx.org.id, ctx.user.id);
  if (res.ok) revalidatePath("/dashboard/settings");
  return res;
}

export async function testOrgWhatsApp(to: string): Promise<WhatsAppActionResult> {
  const ctx = await adminCtx();
  if (!ctx) return { ok: false, error: "Réservé aux administrateurs." };
  const res = await testWhatsApp(ctx.org.id, ctx.org.name, to);
  revalidatePath("/dashboard/settings");
  return res;
}
