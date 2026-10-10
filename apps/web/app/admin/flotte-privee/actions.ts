"use server";
// Super admin — Flotte Privée (docs/FLOTTE-PRIVEE.md § 8 et § 9.4) : création d'un client (invitation Auth puis RPC
// svc_platform_create_private_fleet, tout ou rien ; compte Auth supprimé si la RPC échoue), clé du site (après
// acceptation des CGV et de l'accord de traitement, affichée une fois, révocable), fiche du gérant recréée, lien
// d'accès renvoyé, changement d'offre de service (svc_platform_set_private_fleet). Écritures par le service role après
// requireSuperAdmin() ; les RPC revérifient l'auteur (p_actor) et écrivent audit_logs elles-mêmes (aucun audit()
// doublé). Fichier « use server » : fonctions async seulement.
import {
  CONTACT_LIMITS, describeError, ERROR_MESSAGES, extractErrorCode, fieldErrors, humanizeError, legalDateLabel, ORG_LEGAL_EFFECTIVE_AT,
  ORG_LEGAL_VERSION, PRIVATE_FLEET_BLOCKER_LABELS, PRIVATE_FLEET_CREATE_LABELS, PRIVATE_FLEET_SITE_KEY_LABELS, PRIVATE_FLEET_SWITCH_LABELS,
  privateFleetCreatePayload, privateFleetCreateSchema, privateFleetDriverPayload, privateFleetDriverSchema, privateFleetSiteKeySchema,
  privateFleetSwitchArgs, privateFleetSwitchSchema, type PrivateFleetAttachResult, type PrivateFleetBlocker, type PrivateFleetCreateResult,
  type PrivateFleetSiteKeyKind, type PrivateFleetSwitchResult,
} from "@rydar/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { updateContactRequest } from "@/app/admin/contacts/actions";
import { apiAccessOf, appendNote, effectiveLimits, limitEnabled, SITE_KEY_RATE_LIMIT_PER_MINUTE, SWITCH_TARGET_META } from "@/components/admin/private-fleet-state";
import { frSpaces } from "@/components/platform-fees/org-platform-format";
import { insertKey } from "@/lib/api-keys-server";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { findUserIdByEmail, sendMemberInvitationEmail } from "@/lib/member-invite";
import { createAdminClient } from "@/lib/supabase/admin";

export type PrivateFleetActionResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export type PrivateFleetSwitchActionResult =
  | { ok: true; code: "PRIVATE_FLEET_ENABLED" | "PRIVATE_FLEET_DISABLED" | "UNCHANGED"; message: string; planApplied: boolean | null }
  | { ok: false; error: string; fieldErrors?: Record<string, string>; blockers?: PrivateFleetBlocker[]; minEffectiveOn?: string };

const uuid = z.string().uuid();
const CHECK_FAILED = frSpaces("Vérification impossible pour le moment : réessayez.");
const EXISTING_ACCOUNT = frSpaces("Cette adresse a déjà un compte Rydar : demandez une autre adresse au client.");

/**
 * Termes des CGV transmis aux RPC qui règlent les frais (svc_platform_set_fees) : version en vigueur, entrée en
 * vigueur, origine du site pour les liens des e-mails (contenu fixe, mis en file par la base).
 */
const feeTermsParams = () => ({
  p_org_legal_version: ORG_LEGAL_VERSION,
  p_org_legal_effective_on: ORG_LEGAL_EFFECTIVE_AT,
  p_app_url: env.appUrl || null,
});

/** Refus renvoyé par une RPC (`field` : champ du formulaire) → message et erreur de champ. */
const refusal = (res: { message: string; field?: string }) => ({
  ok: false as const,
  error: res.message,
  fieldErrors: res.field ? { [res.field]: res.message } : undefined,
});

/** Fiche de l'organisation et listes relues après un changement. */
function refresh(orgId: string) {
  revalidatePath(`/admin/organizations/${orgId}`);
  revalidatePath("/admin/organizations");
}

// -----------------------------------------------------------------------------
// Création
// -----------------------------------------------------------------------------

/**
 * « Nouveau client Flotte Privée » : client, chauffeur-propriétaire (compte NEUF, phase 1 : une adresse qui a déjà un
 * compte est refusée), véhicule, frais Rydar par course, offre facultative (avec l'API), référence du contrat signé.
 * Compte invité par e-mail (lien « choisir son mot de passe ») ; mot de passe provisoire seulement sur case cochée.
 * Organisation, adhésion, fiche et frais : une seule RPC, tout ou rien ; si elle échoue, le compte Auth créé ici est
 * supprimé. Depuis une demande de contact (`contactRequestId`) : la demande passe « traitée » avec la note
 * « Client créé : <organisation> » (action des demandes).
 */
export async function createPrivateFleet(
  input: z.input<typeof privateFleetCreateSchema>,
  contactRequestId?: string | null,
): Promise<PrivateFleetActionResult<{ id: string; name: string; message: string; contactUpdated: boolean | null }>> {
  const session = await requireSuperAdmin();
  const parsed = privateFleetCreateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeError(parsed.error, PRIVATE_FLEET_CREATE_LABELS), fieldErrors: fieldErrors(parsed.error) };
  }
  if (contactRequestId != null && !uuid.safeParse(contactRequestId).success) return { ok: false, error: "Demande de contact introuvable." };
  const v = parsed.data;
  const admin = createAdminClient();

  // Phase 1 (D5) : jamais un compte existant, dont le mot de passe peut être connu d'un tiers (la base le refuse aussi :
  // OWNER_NOT_NEW). Contrôles refaits par la RPC, faits ici AVANT l'invitation : aucun e-mail pour une création vouée
  // à l'échec.
  if (await findUserIdByEmail(v.ownerEmail)) {
    return { ok: false, error: EXISTING_ACCOUNT, fieldErrors: { ownerEmail: "Adresse déjà utilisée par un compte Rydar" } };
  }
  const [slugTaken, plan] = await Promise.all([
    admin.from("organizations").select("id").eq("slug", v.slug).maybeSingle(),
    v.planId ? admin.from("plans").select("id, is_active, limits").eq("id", v.planId).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  if (slugTaken.error || plan.error) return { ok: false, error: CHECK_FAILED };
  if (slugTaken.data) return { ok: false, error: ERROR_MESSAGES.SLUG_TAKEN, fieldErrors: { slug: "Déjà utilisé" } };
  const p = plan.data as { is_active: boolean; limits: Record<string, unknown> | null } | null;
  if (v.planId && (!p || !p.is_active || !limitEnabled(p.limits?.api_access))) {
    return { ok: false, error: ERROR_MESSAGES.PRIVATE_FLEET_PLAN_INVALID, fieldErrors: { planId: "Offre inactive ou sans accès à l'API" } };
  }

  const fullName = `${v.ownerFirstName} ${v.ownerLastName}`.trim();
  const created =
    v.temporaryPassword && v.password
      ? await admin.auth.admin.createUser({ email: v.ownerEmail, password: v.password, email_confirm: true, user_metadata: { full_name: fullName } })
      : await admin.auth.admin.inviteUserByEmail(v.ownerEmail, { data: { full_name: fullName }, redirectTo: `${env.appUrl}/auth/set-password` });
  if (created.error || !created.data.user) {
    if (/already|exists|registered/i.test(created.error?.message ?? "")) {
      return { ok: false, error: EXISTING_ACCOUNT, fieldErrors: { ownerEmail: "Adresse déjà utilisée par un compte Rydar" } };
    }
    return {
      ok: false,
      error: frSpaces(
        v.temporaryPassword
          ? "Compte impossible à créer pour le moment : réessayez."
          : "Invitation impossible (envoi des e-mails d'authentification non configuré ?) : réessayez, ou cochez « Mot de passe provisoire ».",
      ),
    };
  }
  const ownerId = created.data.user.id;

  const { data, error } = await admin.rpc("svc_platform_create_private_fleet", {
    p_actor: session.user.id,
    p_owner: ownerId,
    ...privateFleetCreatePayload(v),
    ...feeTermsParams(),
  });
  const res = (data ?? null) as PrivateFleetCreateResult | null;
  if (error || !res || !res.ok) {
    // Compensation : la RPC n'a rien écrit (tout ou rien) ; le compte Auth créé ici est supprimé
    const removed = await admin.auth.admin.deleteUser(ownerId).then(
      (r) => !r.error,
      () => false,
    );
    const failure = res && !res.ok ? refusal(res) : { ok: false as const, error: humanizeError(error?.message, "Création impossible pour le moment."), fieldErrors: undefined };
    return removed
      ? failure
      : {
          ...failure,
          error: frSpaces(`${failure.error} Le compte créé pour ${v.ownerEmail} n'a pas pu être supprimé : supprimez-le (Supabase, Authentication) avant de réessayer.`),
        };
  }

  revalidatePath("/admin");
  revalidatePath("/admin/organizations");

  // Passerelle depuis une demande de contact : « traitée », note gardée et complétée
  let contactUpdated: boolean | null = null;
  if (contactRequestId) {
    const { data: request } = await admin.from("contact_requests").select("admin_note").eq("id", contactRequestId).maybeSingle();
    contactUpdated = request
      ? (
          await updateContactRequest(contactRequestId, {
            status: "done",
            note: appendNote((request as { admin_note: string | null }).admin_note, `Client créé : ${v.name}`, CONTACT_LIMITS.adminNote),
          })
        ).ok
      : false;
  }

  return {
    ok: true,
    id: res.organization_id,
    name: v.name,
    contactUpdated,
    message: frSpaces(
      v.temporaryPassword
        ? "Client créé avec le mot de passe provisoire : transmettez-le au client, qui le change par « Mot de passe oublié ». Il accepte les CGV dans son espace web, puis se connecte à l'application avec les mêmes identifiants."
        : `Invitation envoyée à ${v.ownerEmail} : le client choisit son mot de passe, accepte les CGV dans son espace web, puis se connecte à l'application avec les mêmes identifiants.`,
    ),
  };
}

// -----------------------------------------------------------------------------
// Clé du site
// -----------------------------------------------------------------------------

/**
 * Clé du site du client (D16 : gérée par l'équipe Rydar) : Flotte Privée active, CGV et accord de traitement en
 * vigueur acceptés au nom de l'organisation. Clé serveur (devis, réservations, suivi, annulation, webhooks) ou clé
 * navigateur (devis et réservations, depuis les origines https listées et leur variante www). La clé complète n'est
 * renvoyée qu'UNE fois ; la garde api_keys_plan_limit (offre avec l'API) s'applique.
 */
export async function createPrivateFleetSiteKey(
  orgId: string,
  input: z.input<typeof privateFleetSiteKeySchema>,
): Promise<PrivateFleetActionResult<{ key: string; prefix: string; kind: PrivateFleetSiteKeyKind; scopes: string[]; origins: string[] }>> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(orgId).success) return { ok: false, error: "Organisation inconnue." };
  const parsed = privateFleetSiteKeySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeError(parsed.error, PRIVATE_FLEET_SITE_KEY_LABELS), fieldErrors: fieldErrors(parsed.error) };
  }
  const v = parsed.data;
  const admin = createAdminClient();
  const [org, acceptances] = await Promise.all([
    admin.from("organizations").select("id, status, private_fleet").eq("id", orgId).maybeSingle(),
    admin.from("legal_acceptances").select("document").eq("organization_id", orgId).eq("version", ORG_LEGAL_VERSION).in("document", ["cgv", "dpa"]),
  ]);
  if (org.error || acceptances.error) return { ok: false, error: CHECK_FAILED };
  const o = org.data as { status: string; private_fleet: boolean } | null;
  if (!o) return { ok: false, error: "Organisation introuvable." };
  if (!o.private_fleet) return { ok: false, error: ERROR_MESSAGES.PRIVATE_FLEET_ONLY };
  if (o.status !== "active") return { ok: false, error: frSpaces("Organisation suspendue ou archivée : aucune clé ne peut être créée.") };
  const docs = new Set(((acceptances.data ?? []) as { document: string }[]).map((a) => a.document));
  if (!docs.has("cgv") || !docs.has("dpa")) {
    return {
      ok: false,
      error: frSpaces(
        `CGV et accord de traitement du ${legalDateLabel(ORG_LEGAL_VERSION)} pas encore acceptés par le client : la clé du site se crée après leur acceptation, dans son espace web.`,
      ),
    };
  }

  const res = await insertKey(orgId, session.user.id, {
    name: v.name,
    scopes: v.scopes,
    rateLimitPerMinute: SITE_KEY_RATE_LIMIT_PER_MINUTE,
    allowedOrigins: v.origins,
    expiresAt: null,
  });
  if (!("key" in res) || !res.key) {
    const noApi = extractErrorCode(res.error?.message) === "PLAN_FEATURE_API";
    return {
      ok: false,
      error: noApi
        ? frSpaces(`${ERROR_MESSAGES.PRIVATE_FLEET_PLAN_INVALID} Changez d'abord l'offre (« Offre & limites »).`)
        : humanizeError(res.error?.message, "Impossible de créer la clé."),
    };
  }
  await audit({
    organizationId: orgId,
    actorUserId: session.user.id,
    actorType: "super_admin",
    action: "api_key.created",
    entityType: "api_keys",
    entityId: res.id,
    metadata: { prefix: res.prefix, kind: v.kind, scopes: v.scopes, origins: v.origins },
  });
  revalidatePath(`/admin/organizations/${orgId}`);
  return { ok: true, key: res.key, prefix: res.prefix, kind: v.kind, scopes: v.scopes, origins: v.origins };
}

/** Révocation immédiate d'une clé de l'organisation (le site qui l'utilise ne peut plus réserver). */
export async function revokePrivateFleetSiteKey(orgId: string, keyId: string): Promise<PrivateFleetActionResult> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(orgId).success || !uuid.safeParse(keyId).success) return { ok: false, error: "Clé introuvable." };
  const { data, error } = await createAdminClient()
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString(), revoked_by: session.user.id } as never)
    .eq("id", keyId)
    .eq("organization_id", orgId)
    .is("revoked_at", null)
    .select("prefix")
    .maybeSingle();
  if (error || !data) return { ok: false, error: "Clé introuvable ou déjà révoquée." };
  await audit({
    organizationId: orgId,
    actorUserId: session.user.id,
    actorType: "super_admin",
    action: "api_key.revoked",
    entityType: "api_keys",
    entityId: keyId,
    severity: "warning",
    metadata: { prefix: (data as { prefix: string }).prefix },
  });
  revalidatePath(`/admin/organizations/${orgId}`);
  return { ok: true };
}

// -----------------------------------------------------------------------------
// Fiche du gérant et accès du propriétaire
// -----------------------------------------------------------------------------

/**
 * « Recréer la fiche chauffeur » (svc_platform_attach_private_fleet_driver) : après une suppression de compte
 * chauffeur (fiche figée), sur le compte du propriétaire actif ; e-mail de la fiche = celui du compte.
 */
export async function attachPrivateFleetDriver(
  orgId: string,
  input: z.input<typeof privateFleetDriverSchema>,
): Promise<PrivateFleetActionResult<{ driverId: string }>> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(orgId).success) return { ok: false, error: "Organisation inconnue." };
  const parsed = privateFleetDriverSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeError(parsed.error, PRIVATE_FLEET_CREATE_LABELS), fieldErrors: fieldErrors(parsed.error) };
  }
  const { data, error } = await createAdminClient().rpc("svc_platform_attach_private_fleet_driver", {
    p_org: orgId,
    p_actor: session.user.id,
    ...privateFleetDriverPayload(parsed.data),
  });
  // Identité bannie, garde de la fiche unique… : libellé du code levé par la base
  if (error) return { ok: false, error: humanizeError(error.message, "Fiche impossible à recréer pour le moment.") };
  const res = (data ?? null) as PrivateFleetAttachResult | null;
  if (!res) return { ok: false, error: "Fiche impossible à recréer pour le moment." };
  if (!res.ok) return refusal(res);
  refresh(orgId);
  return { ok: true, driverId: res.driver_id };
}

/**
 * Nouveau lien « choisir son mot de passe » envoyé au propriétaire d'une Flotte Privée qui ne s'est encore jamais
 * connecté (invitation expirée ou perdue). Ensuite, il utilise « Mot de passe oublié ».
 */
export async function resendPrivateFleetAccess(orgId: string): Promise<PrivateFleetActionResult<{ email: string }>> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(orgId).success) return { ok: false, error: "Organisation inconnue." };
  const admin = createAdminClient();
  const [org, owner] = await Promise.all([
    admin.from("organizations").select("private_fleet").eq("id", orgId).maybeSingle(),
    admin
      .from("organization_users")
      .select("user_id, user:users!organization_users_user_id_fkey(email)")
      .eq("organization_id", orgId)
      .eq("role", "owner")
      .eq("status", "active")
      .order("created_at")
      .limit(1)
      .maybeSingle(),
  ]);
  if (org.error || owner.error) return { ok: false, error: CHECK_FAILED };
  if (!(org.data as { private_fleet: boolean } | null)?.private_fleet) return { ok: false, error: ERROR_MESSAGES.PRIVATE_FLEET_ONLY };
  const m = owner.data as { user_id: string; user: { email: string } | { email: string }[] | null } | null;
  const email = (Array.isArray(m?.user) ? m?.user[0] : m?.user)?.email;
  if (!m || !email) return { ok: false, error: "Aucun propriétaire actif pour cette organisation." };
  const account = await admin.auth.admin.getUserById(m.user_id).then(
    (r) => (r.error ? null : r.data.user),
    () => null,
  );
  if (!account) return { ok: false, error: CHECK_FAILED };
  if (account.last_sign_in_at) {
    return { ok: false, error: frSpaces("Le client s'est déjà connecté : en cas d'oubli, il utilise « Mot de passe oublié » sur la page de connexion.") };
  }
  if (!(await sendMemberInvitationEmail(email))) return { ok: false, error: frSpaces("Envoi impossible pour le moment : réessayez dans une minute.") };
  await audit({
    organizationId: orgId,
    actorUserId: session.user.id,
    actorType: "super_admin",
    action: "member.invitation_resent",
    entityType: "organization_users",
    entityId: m.user_id,
    metadata: { email, role: "owner", private_fleet: true },
  });
  return { ok: true, email };
}

// -----------------------------------------------------------------------------
// Changer d'offre de service
// -----------------------------------------------------------------------------

const openRidesText = (n: number) =>
  n > 0 ? ` ${n} réservation${n > 1 ? "s" : ""} en recherche relancée${n > 1 ? "s" : ""} avec le nouveau profil de dispatch.` : "";

/**
 * « Changer d'offre de service » (PackConversionDialog) : entrée en Flotte Privée, ou sortie vers une flotte standard
 * ou une centrale, sur place et sans perte, par svc_platform_set_private_fleet (note d'accord obligatoire, frais par
 * svc_platform_set_fees dans la même transaction, tout ou rien). Entrée : offre avec l'API exigée (le site du client
 * réserve par l'API). Sortie : offre choisie (ou absence d'offre assumée) appliquée après la bascule.
 */
export async function setPrivateFleet(orgId: string, input: z.input<typeof privateFleetSwitchSchema>): Promise<PrivateFleetSwitchActionResult> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(orgId).success) return { ok: false, error: "Organisation inconnue." };
  const parsed = privateFleetSwitchSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeError(parsed.error, PRIVATE_FLEET_SWITCH_LABELS), fieldErrors: fieldErrors(parsed.error) };
  }
  const v = parsed.data;
  const exit = v.target !== "private_fleet";
  const admin = createAdminClient();
  const { data: orgRow, error: orgError } = await admin
    .from("organizations")
    .select("id, plan_id, limits_override, plan:plans(limits)")
    .eq("id", orgId)
    .maybeSingle();
  if (orgError) return { ok: false, error: CHECK_FAILED };
  const org = orgRow as {
    plan_id: string | null;
    limits_override: Record<string, unknown> | null;
    plan: { limits: Record<string, unknown> | null } | { limits: Record<string, unknown> | null }[] | null;
  } | null;
  if (!org) return { ok: false, error: "Organisation introuvable." };
  const plan = Array.isArray(org.plan) ? org.plan[0] : org.plan;
  if (!exit && !apiAccessOf(effectiveLimits({ planId: org.plan_id, planLimits: plan?.limits, override: org.limits_override, privateFleet: true }))) {
    return { ok: false, error: frSpaces(`${ERROR_MESSAGES.PRIVATE_FLEET_PLAN_INVALID} Changez d'abord l'offre (« Offre & limites »).`) };
  }
  const changePlan = exit && v.planId !== org.plan_id;
  if (changePlan && v.planId) {
    const { data: next, error: planError } = await admin.from("plans").select("id, is_active").eq("id", v.planId).maybeSingle();
    if (planError) return { ok: false, error: CHECK_FAILED };
    if (!(next as { is_active: boolean } | null)?.is_active) return { ok: false, error: "Offre introuvable ou inactive.", fieldErrors: { planId: "Offre introuvable ou inactive" } };
  }

  const { data, error } = await admin.rpc("svc_platform_set_private_fleet", {
    p_org: orgId,
    p_actor: session.user.id,
    ...privateFleetSwitchArgs(v),
    ...feeTermsParams(),
  });
  if (error) return { ok: false, error: humanizeError(error.message, "Changement impossible pour le moment.") };
  const res = (data ?? null) as PrivateFleetSwitchResult | null;
  if (!res) return { ok: false, error: "Changement impossible pour le moment." };
  if (!res.ok) {
    if (res.code === "PRIVATE_FLEET_NOT_ELIGIBLE") {
      const reasons = (res.blockers ?? []).map((b) => PRIVATE_FLEET_BLOCKER_LABELS[b] ?? b);
      return { ok: false, error: [res.message, ...reasons].join(" "), blockers: res.blockers ?? [] };
    }
    return { ...refusal(res), minEffectiveOn: "min_effective_on" in res ? res.min_effective_on : undefined };
  }
  if (res.code === "UNCHANGED") {
    return { ok: true, code: "UNCHANGED", message: frSpaces("Aucun changement : l'organisation a déjà cette offre de service."), planApplied: null };
  }

  // Sortie : offre choisie appliquée après la bascule (sans offre : aucune limite, absence assumée dans le dialogue)
  let planApplied: boolean | null = null;
  if (changePlan) {
    const { error: planError } = await admin.from("organizations").update({ plan_id: v.planId } as never).eq("id", orgId);
    planApplied = !planError;
    if (!planError) {
      await audit({
        organizationId: orgId,
        actorUserId: session.user.id,
        actorType: "super_admin",
        action: "organization.plan_changed",
        entityType: "organizations",
        entityId: orgId,
        metadata: { planId: v.planId, previousPlanId: org.plan_id, reason: "private_fleet_disabled" },
      });
    }
  }

  refresh(orgId);
  revalidatePath("/admin/frais");
  revalidatePath(`/admin/frais/${orgId}`);
  if (v.target === "centrale") revalidatePath("/admin/centrales");

  const fees = res.code === "PRIVATE_FLEET_DISABLED" && res.fees?.ok ? ` ${res.fees.message}` : "";
  const open = openRidesText(res.open_rides);
  const planText = planApplied === false ? " L'offre n'a pas pu être appliquée : choisissez-la dans « Offre & limites »." : "";
  return {
    ok: true,
    code: res.code,
    planApplied,
    message: frSpaces(
      res.code === "PRIVATE_FLEET_ENABLED"
        ? `Organisation passée en Flotte Privée : lien d'inscription fermé, profil de dispatch Flotte Privée, une seule fiche (celle du propriétaire).${open}`
        : `Organisation passée en ${SWITCH_TARGET_META[v.target].label.toLowerCase()}.${fees}${open}${planText}`,
    ),
  };
}
