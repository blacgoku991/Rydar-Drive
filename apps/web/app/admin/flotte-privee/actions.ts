"use server";
// Super admin — Flotte Privée (docs/FLOTTE-PRIVEE.md § 8 et § 9.4) : création d'un client (compte Auth NEUF prouvé,
// invitation, puis RPC svc_platform_create_private_fleet, tout ou rien ; seul le compte créé ici, sans adhésion ni
// fiche, est supprimé si la création échoue), clé du site (après acceptation des CGV et de l'accord de traitement,
// débit réglable, affichée une fois, révocable), fiche du gérant recréée, lien d'accès renvoyé, changement d'offre de
// service (svc_platform_set_private_fleet, offre comprise). Écritures par le service role après requireSuperAdmin() ;
// les RPC revérifient l'auteur (p_actor) et écrivent audit_logs elles-mêmes (aucun audit() doublé). Fichier
// « use server » : fonctions async seulement.
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
import {
  apiAccessOf, appendNote, effectiveLimits, limitEnabled, SITE_KEY_RATE_LABEL, siteKeyRate, SWITCH_TARGET_META,
} from "@/components/admin/private-fleet-state";
import { frSpaces } from "@/components/platform-fees/org-platform-format";
import { insertKey } from "@/lib/api-keys-server";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { likeExact, sendMemberInvitationEmail } from "@/lib/member-invite";
import { createAdminClient } from "@/lib/supabase/admin";

export type PrivateFleetActionResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export type PrivateFleetSwitchActionResult =
  | { ok: true; code: "PRIVATE_FLEET_ENABLED" | "PRIVATE_FLEET_DISABLED" | "UNCHANGED"; message: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string>; blockers?: PrivateFleetBlocker[]; minEffectiveOn?: string };

type Admin = ReturnType<typeof createAdminClient>;

const uuid = z.string().uuid();
const CHECK_FAILED = frSpaces("Vérification impossible pour le moment : réessayez.");
const EXISTING_ACCOUNT = frSpaces("Cette adresse a déjà un compte Rydar : demandez une autre adresse au client.");
const EXISTING_ACCOUNT_FIELD = { ownerEmail: "Adresse déjà utilisée par un compte Rydar" };

/**
 * Refus de svc_platform_create_private_fleet qui disent le compte déjà utilisé, ou introuvable : jamais de
 * compensation sur ces codes (le compte n'est pas, ou plus, celui que cette action vient de créer).
 */
const ACCOUNT_IN_USE_CODES: ReadonlySet<string> = new Set(["NOT_FOUND", "SELF_NOT_ALLOWED", "ALREADY_REGISTERED", "OWNER_NOT_NEW"]);

/** Adresse déjà connue d'Auth (createUser : « email_exists », confirmée ou non). */
const emailTaken = (e: { code?: string; message?: string } | null | undefined) =>
  e?.code === "email_exists" || /already|exists|registered/i.test(e?.message ?? "");

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
 * Compensation d'une création échouée : supprime le compte Auth que CETTE action vient de créer (createUser l'a prouvé
 * neuf), seulement s'il n'a ni adhésion ni fiche chauffeur. Rattaché (RPC validée dont la réponse s'est perdue) :
 * gardé ; relecture ou suppression impossible : gardé aussi (jamais de suppression à l'aveugle).
 */
async function discardCreatedOwner(admin: Admin, ownerId: string): Promise<"removed" | "linked" | "kept"> {
  const [members, drivers] = await Promise.all([
    admin.from("organization_users").select("organization_id").eq("user_id", ownerId).limit(1),
    admin.from("drivers").select("id").eq("user_id", ownerId).limit(1),
  ]);
  if (members.error || drivers.error) return "kept";
  if (((members.data ?? []) as unknown[]).length > 0 || ((drivers.data ?? []) as unknown[]).length > 0) return "linked";
  const removed = await admin.auth.admin.deleteUser(ownerId).then(
    (r) => !r.error,
    () => false,
  );
  return removed ? "removed" : "kept";
}

/** Échec de la création après celle du compte Auth : compensation (sauf refus qui disent le compte déjà utilisé) et message. */
async function creationFailed(
  admin: Admin,
  ownerId: string,
  email: string,
  failure: { error: string; fieldErrors?: Record<string, string> },
  code: string | null,
): Promise<{ ok: false; error: string; fieldErrors?: Record<string, string> }> {
  const outcome = code && ACCOUNT_IN_USE_CODES.has(code) ? "kept" : await discardCreatedOwner(admin, ownerId);
  if (outcome === "removed") return { ok: false, ...failure };
  return {
    ok: false,
    fieldErrors: failure.fieldErrors,
    error: frSpaces(
      outcome === "linked"
        ? `${failure.error} La création a peut-être abouti malgré l'erreur (compte de ${email} rattaché) : vérifiez la liste des organisations avant de réessayer.`
        : `${failure.error} Le compte créé pour ${email} n'a pas été supprimé : s'il n'est rattaché à aucune organisation, supprimez-le (Supabase, Authentication) avant de réessayer.`,
    ),
  };
}

/**
 * « Nouveau client Flotte Privée » : client, chauffeur-propriétaire (compte NEUF, phase 1 : une adresse qui a déjà un
 * compte est refusée), véhicule, frais Rydar par course, offre facultative (avec l'API), référence du contrat signé.
 * Compte créé par createUser (preuve qu'il est neuf : Auth refuse toute adresse connue, confirmée ou non), puis invité
 * par e-mail (lien « choisir son mot de passe ») ; mot de passe provisoire seulement sur case cochée. Organisation,
 * adhésion, fiche et frais : une seule RPC, tout ou rien ; si la création échoue, le compte créé ici est supprimé
 * (discardCreatedOwner). Depuis une demande de contact (`contactRequestId`) : la demande passe « traitée » avec la
 * note « Client créé : <organisation> » (action des demandes).
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
  // OWNER_NOT_NEW). Contrôles refaits par la RPC, faits ici AVANT tout compte et toute invitation : aucun e-mail pour
  // une création vouée à l'échec. Recherche par égalité (jokers échappés) ; lecture en échec : refus, jamais lue comme
  // « aucun compte ».
  const [existing, slugTaken, plan] = await Promise.all([
    admin.from("users").select("id").ilike("email", likeExact(v.ownerEmail)).limit(1),
    admin.from("organizations").select("id").eq("slug", v.slug).maybeSingle(),
    v.planId ? admin.from("plans").select("id, is_active, limits").eq("id", v.planId).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  if (existing.error || slugTaken.error || plan.error) return { ok: false, error: CHECK_FAILED };
  if (((existing.data ?? []) as unknown[]).length > 0) return { ok: false, error: EXISTING_ACCOUNT, fieldErrors: EXISTING_ACCOUNT_FIELD };
  if (slugTaken.data) return { ok: false, error: ERROR_MESSAGES.SLUG_TAKEN, fieldErrors: { slug: "Déjà utilisé" } };
  const p = plan.data as { is_active: boolean; limits: Record<string, unknown> | null } | null;
  if (v.planId && (!p || !p.is_active || !limitEnabled(p.limits?.api_access))) {
    return { ok: false, error: ERROR_MESSAGES.PRIVATE_FLEET_PLAN_INVALID, fieldErrors: { planId: "Offre inactive ou sans accès à l'API" } };
  }

  // Compte NEUF prouvé : createUser refuse toute adresse déjà connue d'Auth, confirmée ou non (email_exists). Une
  // invitation seule ne le prouve pas : pour un compte existant jamais confirmé, Auth renvoie l'invitation et ce compte.
  const fullName = `${v.ownerFirstName} ${v.ownerLastName}`.trim();
  const temporary = v.temporaryPassword && !!v.password;
  const created = await admin.auth.admin.createUser(
    temporary
      ? { email: v.ownerEmail, password: v.password, email_confirm: true, user_metadata: { full_name: fullName } }
      : { email: v.ownerEmail, email_confirm: false, user_metadata: { full_name: fullName } },
  );
  if (created.error || !created.data.user) {
    if (emailTaken(created.error)) return { ok: false, error: EXISTING_ACCOUNT, fieldErrors: EXISTING_ACCOUNT_FIELD };
    return { ok: false, error: frSpaces("Compte impossible à créer pour le moment : réessayez.") };
  }
  const ownerId = created.data.user.id;
  if (!temporary) {
    // Lien « choisir son mot de passe » vers ce compte neuf (Auth réinvite un compte non confirmé)
    const invited = await admin.auth.admin.inviteUserByEmail(v.ownerEmail, { redirectTo: `${env.appUrl}/auth/set-password` }).then(
      (r) => (r.error ? null : r.data.user),
      () => null,
    );
    if (invited?.id !== ownerId) {
      return creationFailed(
        admin,
        ownerId,
        v.ownerEmail,
        { error: frSpaces("Invitation impossible (envoi des e-mails d'authentification non configuré ?) : réessayez, ou cochez « Mot de passe provisoire ».") },
        null,
      );
    }
  }

  const { data, error } = await admin.rpc("svc_platform_create_private_fleet", {
    p_actor: session.user.id,
    p_owner: ownerId,
    ...privateFleetCreatePayload(v),
    ...feeTermsParams(),
  });
  const res = (data ?? null) as PrivateFleetCreateResult | null;
  if (error || !res || !res.ok) {
    // Refus : la RPC n'a rien écrit (tout ou rien). Erreur sans réponse : elle a pu valider, la relecture le dit
    const failure = res && !res.ok ? refusal(res) : { error: humanizeError(error?.message, "Création impossible pour le moment.") };
    return creationFailed(admin, ownerId, v.ownerEmail, failure, res && !res.ok ? res.code : null);
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
 * navigateur (devis et réservations, depuis les origines https listées et leur variante www). Débit réglable
 * (SITE_KEY_RATE : vide = défaut du type ; clé navigateur : 1 000 par minute par défaut, compté à part pour les devis et
 * pour les réservations). La clé complète n'est renvoyée qu'UNE fois ; la garde api_keys_plan_limit (offre avec l'API)
 * s'applique.
 */
export async function createPrivateFleetSiteKey(
  orgId: string,
  input: z.input<typeof privateFleetSiteKeySchema> & { rateLimitPerMinute?: number | string | null },
): Promise<
  PrivateFleetActionResult<{ key: string; prefix: string; kind: PrivateFleetSiteKeyKind; scopes: string[]; origins: string[]; rateLimitPerMinute: number }>
> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(orgId).success) return { ok: false, error: "Organisation inconnue." };
  const parsed = privateFleetSiteKeySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeError(parsed.error, PRIVATE_FLEET_SITE_KEY_LABELS), fieldErrors: fieldErrors(parsed.error) };
  }
  const v = parsed.data;
  const rate = siteKeyRate(v.kind, input.rateLimitPerMinute);
  if (!rate.ok) {
    return {
      ok: false,
      error: frSpaces(`${SITE_KEY_RATE_LABEL} : ${rate.error.charAt(0).toLowerCase()}${rate.error.slice(1)}`),
      fieldErrors: { rateLimitPerMinute: rate.error },
    };
  }
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
    rateLimitPerMinute: rate.value,
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
    metadata: { prefix: res.prefix, kind: v.kind, scopes: v.scopes, origins: v.origins, rate_limit_per_minute: rate.value },
  });
  revalidatePath(`/admin/organizations/${orgId}`);
  return { ok: true, key: res.key, prefix: res.prefix, kind: v.kind, scopes: v.scopes, origins: v.origins, rateLimitPerMinute: rate.value };
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
 * ou une centrale, sur place et sans perte, par svc_platform_set_private_fleet (note d'accord obligatoire ; offre et
 * frais par svc_platform_set_fees dans la même transaction, tout ou rien). Entrée : offre avec l'API exigée (le site du
 * client réserve par l'API). Sortie : offre choisie (ou absence d'offre assumée) écrite par la RPC après le drapeau.
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
  let nextPlanName: string | null = null;
  if (changePlan && v.planId) {
    const { data: next, error: planError } = await admin.from("plans").select("id, name, is_active").eq("id", v.planId).maybeSingle();
    if (planError) return { ok: false, error: CHECK_FAILED };
    const n = next as { name: string; is_active: boolean } | null;
    if (!n?.is_active) return { ok: false, error: "Offre introuvable ou inactive.", fieldErrors: { planId: "Offre introuvable ou inactive" } };
    nextPlanName = n.name;
  }

  // Offre écrite par la RPC, dans la même transaction que la bascule (après le drapeau) : jamais une organisation
  // sortie de la Flotte Privée avec son ancienne offre, ou sans limite, parce qu'une seconde écriture aurait échoué
  const { data, error } = await admin.rpc("svc_platform_set_private_fleet", {
    p_org: orgId,
    p_actor: session.user.id,
    ...privateFleetSwitchArgs(v),
    ...feeTermsParams(),
    p_set_plan: changePlan,
    p_plan_id: changePlan ? v.planId : null,
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
    return { ok: true, code: "UNCHANGED", message: frSpaces("Aucun changement : l'organisation a déjà cette offre de service.") };
  }

  refresh(orgId);
  revalidatePath("/admin/frais");
  revalidatePath(`/admin/frais/${orgId}`);
  if (v.target === "centrale") revalidatePath("/admin/centrales");

  const fees = res.code === "PRIVATE_FLEET_DISABLED" && res.fees?.ok ? ` ${res.fees.message}` : "";
  const open = openRidesText(res.open_rides);
  const planText = !changePlan ? "" : nextPlanName ? ` Offre « ${nextPlanName} » appliquée.` : " Sans offre : aucune limite.";
  return {
    ok: true,
    code: res.code,
    message: frSpaces(
      res.code === "PRIVATE_FLEET_ENABLED"
        ? `Organisation passée en Flotte Privée : lien d'inscription fermé, profil de dispatch Flotte Privée, une seule fiche (celle du propriétaire).${open}`
        : `Organisation passée en ${SWITCH_TARGET_META[v.target].label.toLowerCase()}.${planText}${fees}${open}`,
    ),
  };
}
