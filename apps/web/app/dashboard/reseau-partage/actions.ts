"use server";
// Réseau partagé (onglet du tableau de bord) : réglages de l'organisation, décisions sur les courses confiées
// (Reçu, Pas reçu, Annuler, Versé, Valider, Contester la course, Rouvrir), exclusions, relance ; fiche course : Retirer
// la course au partenaire, Clôturer la course. Organisation SUSPENDUE (C12, /suspended/reseau-partage) : seules les
// décisions d'argent sur ses courses confiées restent permises à owner / admin.
// Chaque RPC revérifie en base l'appartenance, le rôle (owner / admin + jwt_issued_after pour l'argent et les réglages),
// l'interrupteur plateforme et les délais ; ici, refus anticipé d'un dispatcher (lecture seule, sauf « Relancer »).
// Fichier « use server » : seules des fonctions async sont exportées (les types sont effacés à la compilation).
import {
  describeError, fieldErrors, humanizeError, settlementPaymentSchema,
  type CloseNetworkRideResult, type ContestNetworkRideResult, type ExcludeNetworkDriverResult, type OrgNetworkPayoutInfo, type OrgNetworkReadiness,
  type OrgNetworkSettingsResult, type RemindNetworkDriverResult, type SetDriverNetworkAllowedResult, type SettlementMethod,
  type SettlementPaymentInput, type ValidateNetworkRideResult,
} from "@rydar/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getPayerContext } from "@/components/platform-fees/org-payer-context";
import { isAdminRole } from "@/lib/auth";
import { actionError } from "@/lib/errors";
import { getOrgContext } from "@/lib/org-context";

export type NetworkActionResult<T = object> =
  | ({ ok: true; message: string } & T)
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

const PATH = "/dashboard/reseau-partage";
/** Organisation suspendue : ses règlements réseau ouverts (owner / admin), hors du tableau de bord. */
const SUSPENDED_PATH = "/suspended/reseau-partage";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADMIN_ONLY = "Réservé au propriétaire et aux administrateurs de l'organisation.";
const METHODS = new Set<string>(["link", "cash", "transfer", "other"]);
const NB = " ";

type Ctx = NonNullable<Awaited<ReturnType<typeof getOrgContext>>>;
type Fail = { ok: false; error: string; fieldErrors?: Record<string, string> };
type PgError = { code?: string; message?: string } | null;

/**
 * Organisation active ; owner / admin si `admin`. `creditor` : décision d'argent sur une course confiée, permise aussi
 * à une organisation SUSPENDUE (même choix d'organisation que le tableau de bord ; la base revérifie le rôle et le
 * statut, assert_network_creditor).
 */
async function context(admin: boolean, opts: { creditor?: boolean } = {}): Promise<Ctx | Fail> {
  const ctx = opts.creditor ? await getPayerContext() : await getOrgContext();
  if (!ctx) return { ok: false, error: "Session expirée ou organisation indisponible : rechargez la page." };
  if (admin && !isAdminRole(ctx.role)) return { ok: false, error: ADMIN_ONLY };
  return ctx;
}
const failed = (v: Ctx | Fail): v is Fail => "ok" in v && v.ok === false;

/** Erreur SQL → message : code métier connu (ERROR_MESSAGES, ex. NETWORK_TERMS_REQUIRED), sinon message générique. */
function rpcError(error: PgError, fallback: string): string {
  return humanizeError(error?.message, actionError(error, fallback));
}

async function call<T>(ctx: Ctx, fn: string, args: Record<string, unknown>, fallback: string): Promise<{ data: T } | Fail> {
  const { data, error } = await ctx.supabase.rpc(fn, args);
  if (error) return { ok: false, error: rpcError(error, fallback) };
  return { data: data as T };
}
const isFail = <T,>(v: { data: T } | Fail): v is Fail => "ok" in v;

function refresh(layout = false) {
  revalidatePath(PATH);
  revalidatePath(SUSPENDED_PATH);
  // Menu (pastille), bandeau de la convention : mise en page relue
  if (layout) revalidatePath("/dashboard", "layout");
}

// =============================================================================================================
// Réglages de l'organisation (owner / admin) — set_network_settings : paramètres NULL = inchangés
// =============================================================================================================

type SettingsPatch = {
  p_share_out?: boolean | null;
  p_share_in?: boolean | null;
  p_terms_version?: string | null;
  p_insurance_confirmed?: boolean | null;
  p_executor_credit_limit_cents?: number | null;
};

async function saveSettings(ctx: Ctx, patch: SettingsPatch): Promise<{ data: OrgNetworkSettingsResult } | Fail> {
  return call<OrgNetworkSettingsResult>(
    ctx,
    "set_network_settings",
    {
      p_org: ctx.org.id,
      p_share_out: patch.p_share_out ?? null,
      p_share_in: patch.p_share_in ?? null,
      p_terms_version: patch.p_terms_version ?? null,
      p_insurance_confirmed: patch.p_insurance_confirmed ?? null,
      p_executor_credit_limit_cents: patch.p_executor_credit_limit_cents ?? null,
    },
    "Réglage impossible pour le moment.",
  );
}

const versionSchema = z.string().trim().min(1).max(40);

/** Message après un changement d'interrupteur : actif, ou en attente (validation Rydar, condition manquante). */
function switchMessage(side: "out" | "in", enabled: boolean, r: OrgNetworkReadiness | undefined, closed: number): string {
  const what = side === "out" ? "Partage de vos courses" : "Réception des courses du réseau";
  if (!enabled) {
    return `${what} désactivé${side === "in" ? "e" : ""}${closed ? ` · ${closed} offre${closed > 1 ? "s" : ""} en attente retirée${closed > 1 ? "s" : ""}` : ""}. Les courses déjà acceptées vont à leur terme.`;
  }
  const s = side === "out" ? r?.share_out : r?.share_in;
  if (s?.active) return `${what} activé${side === "in" ? "e" : ""}.`;
  if (s?.missing.includes("approval_pending")) return `Demande enregistrée${NB}: en attente de validation par Rydar.`;
  return `${what} demandé${side === "in" ? "e" : ""}${NB}: complétez les conditions affichées en haut de la page.`;
}

/**
 * Interrupteur « Partager mes courses non prises » (out) ou « Recevoir les courses du réseau » (in). Première
 * activation : `termsVersion` = version de la convention acceptée (case « J'accepte la convention ») → demande de
 * validation à Rydar (requested_at).
 */
export async function setNetworkSharing(input: { side: "out" | "in"; enabled: boolean; termsVersion?: string | null }): Promise<NetworkActionResult<{ readiness: OrgNetworkReadiness | null }>> {
  const ctx = await context(true);
  if (failed(ctx)) return ctx;
  if ((input.side !== "out" && input.side !== "in") || typeof input.enabled !== "boolean") return { ok: false, error: "Demande invalide." };
  const version = input.termsVersion == null ? null : versionSchema.safeParse(input.termsVersion);
  if (version && !version.success) return { ok: false, error: "Version de la convention invalide." };
  const res = await saveSettings(ctx, {
    [input.side === "out" ? "p_share_out" : "p_share_in"]: input.enabled,
    p_terms_version: version?.success ? version.data : null,
  });
  if (isFail(res)) return res;
  refresh(true);
  const readiness = res.data?.readiness ?? null;
  return { ok: true, message: switchMessage(input.side, input.enabled, readiness ?? undefined, res.data?.closed_offers ?? 0), readiness };
}

/** « J'accepte la convention » (nouvelle version, bandeau ou Réglages). */
export async function acceptNetworkTerms(version: string): Promise<NetworkActionResult> {
  const ctx = await context(true);
  if (failed(ctx)) return ctx;
  const v = versionSchema.safeParse(version);
  if (!v.success) return { ok: false, error: "Version de la convention invalide." };
  const res = await saveSettings(ctx, { p_terms_version: v.data });
  if (isFail(res)) return res;
  refresh(true);
  return { ok: true, message: "Convention du réseau partagé acceptée." };
}

/** Case « Mon assurance couvre les courses faites pour d'autres organisations ». */
export async function setNetworkInsurance(confirmed: boolean): Promise<NetworkActionResult> {
  const ctx = await context(true);
  if (failed(ctx)) return ctx;
  if (typeof confirmed !== "boolean") return { ok: false, error: "Demande invalide." };
  const res = await saveSettings(ctx, { p_insurance_confirmed: confirmed });
  if (isFail(res)) return res;
  refresh(true);
  return { ok: true, message: confirmed ? "Assurance confirmée." : "Confirmation d'assurance retirée : la réception s'arrête." };
}

/** Plafond par chauffeur, en euros (« 150 », « 150,50 ») : 0 à 1 000 €. */
const creditLimitSchema = z.object({
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,4}([.,]\d{1,2})?$/, "Montant invalide (ex. 150)")
    .transform((v) => Math.round(Number(v.replace(",", ".")) * 100))
    .refine((c) => c >= 0 && c <= 100_000, "Entre 0 et 1 000 €"),
});

export async function setExecutorCreditLimit(input: { amount: string }): Promise<NetworkActionResult<{ cents: number }>> {
  const ctx = await context(true);
  if (failed(ctx)) return ctx;
  const parsed = creditLimitSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeError(parsed.error, { amount: "Plafond par chauffeur" }), fieldErrors: fieldErrors(parsed.error) };
  }
  const res = await saveSettings(ctx, { p_executor_credit_limit_cents: parsed.data.amount });
  if (isFail(res)) return res;
  refresh();
  return { ok: true, message: "Plafond par chauffeur enregistré.", cents: parsed.data.amount };
}

/** « Ne plus travailler avec {B} » / lever l'exclusion (symétrique ; même réponse dans tous les cas). */
export async function setNetworkPartnerExcluded(partnerId: string, excluded: boolean): Promise<NetworkActionResult> {
  const ctx = await context(true);
  if (failed(ctx)) return ctx;
  if (!UUID.test(partnerId) || typeof excluded !== "boolean") return { ok: false, error: "Organisation introuvable." };
  const res = await call<{ ok: true }>(ctx, "set_network_exclusion", { p_org: ctx.org.id, p_partner: partnerId, p_excluded: excluded }, "Action impossible pour le moment.");
  if (isFail(res)) return res;
  refresh();
  return {
    ok: true,
    message: excluded
      ? "Organisation exclue : plus aucune course échangée avec elle. Les courses déjà acceptées vont à leur terme."
      : "Exclusion levée : les courses peuvent de nouveau être échangées avec cette organisation.",
  };
}

/** Interrupteur « Autorisé » d'un chauffeur de l'organisation (réception du réseau). */
export async function setDriverNetworkAllowed(driverId: string, allowed: boolean): Promise<NetworkActionResult<{ closedOffers: number }>> {
  const ctx = await context(true);
  if (failed(ctx)) return ctx;
  if (!UUID.test(driverId) || typeof allowed !== "boolean") return { ok: false, error: "Chauffeur introuvable." };
  const res = await call<SetDriverNetworkAllowedResult>(ctx, "set_driver_network_allowed", { p_driver: driverId, p_allowed: allowed }, "Action impossible pour le moment.");
  if (isFail(res)) return res;
  refresh();
  return {
    ok: true,
    message: allowed ? "Chauffeur autorisé à recevoir les courses du réseau." : "Chauffeur retiré du réseau partagé.",
    closedOffers: res.data?.closed_offers ?? 0,
  };
}

/** N° d'exploitant VTC d'un chauffeur indépendant (centrale) : champ « exploitant » du bon de réservation. */
const operatorSchema = z.object({
  value: z
    .string()
    .trim()
    .max(80, "80 caractères au maximum")
    .refine((v) => v === "" || v.length >= 3, "3 caractères au minimum"),
});

export async function setDriverOperatorRegistration(driverId: string, value: string): Promise<NetworkActionResult> {
  const ctx = await context(true);
  if (failed(ctx)) return ctx;
  if (!UUID.test(driverId)) return { ok: false, error: "Chauffeur introuvable." };
  const parsed = operatorSchema.safeParse({ value: typeof value === "string" ? value : "" });
  if (!parsed.success) {
    return { ok: false, error: describeError(parsed.error, { value: "N° d'exploitant VTC" }), fieldErrors: fieldErrors(parsed.error) };
  }
  const { data, error } = await ctx.supabase
    .from("drivers")
    .update({ vtc_operator_registration: parsed.data.value || null })
    .eq("id", driverId)
    .eq("organization_id", ctx.org.id)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: rpcError(error, "Enregistrement impossible.") };
  if (!data) return { ok: false, error: "Chauffeur introuvable." };
  refresh();
  return { ok: true, message: parsed.data.value ? "N° d'exploitant VTC enregistré." : "N° d'exploitant VTC retiré." };
}

/** Noms des champs pour les messages d'erreur (carte « Encaissement »). */
const PAYMENT_LABELS: Record<string, string> = {
  methods: "Moyens acceptés",
  link: "Lien de paiement",
  instructions: "Instructions",
  payeeName: "Bénéficiaire",
  iban: "IBAN",
  bic: "BIC",
};

/**
 * Flotte : moyens de paiement proposés aux chauffeurs partenaires (mêmes colonnes et même schéma que « Commission &
 * encaissement » des centrales, qui restent leur seule source). Retirer le dernier moyen en ligne pendant le partage
 * est refusé en base (NETWORK_PAYMENT_METHODS_REQUIRED).
 */
export async function updateNetworkPaymentMethods(input: Partial<SettlementPaymentInput>): Promise<NetworkActionResult> {
  const ctx = await context(true);
  if (failed(ctx)) return ctx;
  if (ctx.org.dispatch_model === "centrale") {
    return { ok: false, error: "Centrale : modifiez vos moyens de paiement dans Réglages › Commission & encaissement." };
  }
  // Champs absents = vides (le formulaire les envoie tous ; un appel direct peut en omettre)
  const raw: Partial<SettlementPaymentInput> = input && typeof input === "object" ? input : {};
  const parsed = settlementPaymentSchema.safeParse({
    methods: raw.methods,
    link: raw.link ?? "",
    instructions: raw.instructions ?? "",
    payeeName: raw.payeeName ?? null,
    iban: raw.iban ?? null,
    bic: raw.bic ?? null,
  });
  if (!parsed.success) return { ok: false, error: describeError(parsed.error, PAYMENT_LABELS), fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  const { error } = await ctx.supabase
    .from("organization_settings")
    .update({
      settlement_methods: v.methods,
      settlement_link: v.link,
      settlement_instructions: v.instructions,
      settlement_payee_name: v.payeeName,
      settlement_iban: v.iban,
      settlement_bic: v.bic,
    })
    .eq("organization_id", ctx.org.id);
  if (error) return { ok: false, error: rpcError(error, "Enregistrement impossible.") };
  refresh(true);
  return { ok: true, message: "Moyens de paiement enregistrés." };
}

// =============================================================================================================
// Courses confiées : règlements avec les chauffeurs partenaires (owner / admin ; « Relancer » : tout membre)
// =============================================================================================================

type SettlementPayload = { ok?: boolean; code?: string; message?: string; count?: number; amount_cents?: number };

async function settlementCall(fn: string, args: Record<string, unknown>, success: string): Promise<NetworkActionResult<{ amountCents?: number }>> {
  const ctx = await context(true, { creditor: true });
  if (failed(ctx)) return ctx;
  const res = await call<SettlementPayload | null>(ctx, fn, args, "Action impossible pour le moment.");
  if (isFail(res)) return res;
  const payload = res.data ?? {};
  if (payload.ok === false) return { ok: false, error: payload.message || "Action impossible." };
  refresh(true);
  return { ok: true, message: success, amountCents: payload.amount_cents };
}

/** « Reçu » (part reversée par le chauffeur) / « Versé » (part versée au chauffeur). */
export async function confirmNetworkSettlement(id: string, method: SettlementMethod | null, note?: string | null) {
  if (!UUID.test(id)) return { ok: false, error: "Règlement introuvable." } satisfies Fail;
  if (method != null && !METHODS.has(method)) return { ok: false, error: "Moyen de paiement invalide." } satisfies Fail;
  return settlementCall("confirm_settlements", { p_ids: [id], p_method: method, p_note: note?.trim().slice(0, 500) || null }, "Règlement confirmé.");
}

/** « Pas reçu » : le chauffeur est prévenu ; seules les courses de l'organisation lui sont bloquées. */
export async function disputeNetworkSettlement(id: string, reason: string) {
  if (!UUID.test(id)) return { ok: false, error: "Règlement introuvable." } satisfies Fail;
  if (typeof reason !== "string" || reason.trim().length < 3) return { ok: false, error: "Précisez ce qui ne va pas." } satisfies Fail;
  return settlementCall("dispute_settlement", { p_id: id, p_reason: reason.trim().slice(0, 500) }, "Paiement contesté : le chauffeur est prévenu.");
}

/** « Annuler » : course payée à bord seulement (un versement au chauffeur ne s'annule que par « Contester la course »). */
export async function waiveNetworkSettlement(id: string, reason: string) {
  if (!UUID.test(id)) return { ok: false, error: "Règlement introuvable." } satisfies Fail;
  if (typeof reason !== "string" || reason.trim().length < 3) return { ok: false, error: "Indiquez le motif de l'annulation." } satisfies Fail;
  return settlementCall("waive_settlement", { p_id: id, p_reason: reason.trim().slice(0, 500) }, "Règlement annulé.");
}

/** « Rouvrir » : erreur de saisie, nouvelle échéance (au moins 48 h) et chauffeur prévenu. */
export async function reopenNetworkSettlement(id: string) {
  if (!UUID.test(id)) return { ok: false, error: "Règlement introuvable." } satisfies Fail;
  return settlementCall("reopen_settlement", { p_id: id }, "Règlement rouvert.");
}

/** RIB du chauffeur pour un versement (consultation journalisée en base et notifiée au chauffeur). */
export async function getNetworkPayoutInfo(settlementId: string): Promise<NetworkActionResult<{ info: OrgNetworkPayoutInfo }>> {
  const ctx = await context(true, { creditor: true });
  if (failed(ctx)) return ctx;
  if (!UUID.test(settlementId)) return { ok: false, error: "Règlement introuvable." };
  const res = await call<OrgNetworkPayoutInfo | null>(ctx, "org_network_payout_info", { p_settlement: settlementId }, "Coordonnées bancaires indisponibles.");
  if (isFail(res)) return res;
  if (!res.data) return { ok: false, error: "Coordonnées bancaires indisponibles." };
  return { ok: true, message: "", info: res.data };
}

/** « Valider » : course « à vérifier » contrôlée, le versement retenu devient payable. */
export async function validateNetworkRide(rideId: string): Promise<NetworkActionResult> {
  const ctx = await context(true, { creditor: true });
  if (failed(ctx)) return ctx;
  if (!UUID.test(rideId)) return { ok: false, error: "Course introuvable." };
  const res = await call<ValidateNetworkRideResult>(ctx, "validate_network_ride", { p_ride: rideId }, "Validation impossible pour le moment.");
  if (isFail(res)) return res;
  refresh(true);
  return { ok: true, message: "Course validée." };
}

/** « Contester la course » (7 jours après la fin) : versement annulé, demande de baisse des frais Rydar. */
export async function contestNetworkRide(rideId: string, reason: string): Promise<NetworkActionResult<{ feeReductionCents: number | null }>> {
  const ctx = await context(true, { creditor: true });
  if (failed(ctx)) return ctx;
  if (!UUID.test(rideId)) return { ok: false, error: "Course introuvable." };
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 5) return { ok: false, error: "Décrivez ce qui ne va pas (5 caractères au minimum)." };
  const res = await call<ContestNetworkRideResult>(ctx, "contest_network_ride", { p_ride: rideId, p_reason: why.slice(0, 300) }, "Contestation impossible pour le moment.");
  if (isFail(res)) return res;
  refresh(true);
  return {
    ok: true,
    message: res.data?.fee_reduction ? "Course contestée : la baisse des frais Rydar est soumise à Rydar." : "Course contestée.",
    feeReductionCents: res.data?.fee_reduction?.amount_cents ?? null,
  };
}

/** « Exclure ce chauffeur » : fondé sur son identité, valable même s'il change d'organisation. */
export async function excludeNetworkDriver(executionId: string, reason?: string | null): Promise<NetworkActionResult> {
  const ctx = await context(true);
  if (failed(ctx)) return ctx;
  if (!UUID.test(executionId)) return { ok: false, error: "Course introuvable." };
  const why = typeof reason === "string" ? reason.trim().slice(0, 300) : "";
  const res = await call<ExcludeNetworkDriverResult>(ctx, "exclude_network_driver", { p_execution: executionId, p_reason: why || null }, "Exclusion impossible pour le moment.");
  if (isFail(res)) return res;
  refresh();
  return { ok: true, message: "Chauffeur exclu : il ne recevra plus vos courses." };
}

/** Lever l'exclusion d'un chauffeur partenaire (Réglages › Options avancées). */
export async function liftNetworkDriverExclusion(exclusionId: string): Promise<NetworkActionResult> {
  const ctx = await context(true);
  if (failed(ctx)) return ctx;
  if (!UUID.test(exclusionId)) return { ok: false, error: "Exclusion introuvable." };
  const res = await call<{ ok: true }>(ctx, "lift_network_driver_exclusion", { p_org: ctx.org.id, p_id: exclusionId }, "Action impossible pour le moment.");
  if (isFail(res)) return res;
  refresh();
  return { ok: true, message: "Exclusion levée." };
}

/** « Relancer » (application seulement, 1 / 30 min) : tout membre, dispatcher compris. */
export async function remindNetworkDriver(settlementId: string): Promise<NetworkActionResult<{ code: RemindNetworkDriverResult["code"] }>> {
  const ctx = await context(false);
  if (failed(ctx)) return ctx;
  if (!UUID.test(settlementId)) return { ok: false, error: "Règlement introuvable." };
  const res = await call<RemindNetworkDriverResult>(ctx, "remind_network_driver", { p_org: ctx.org.id, p_settlement: settlementId }, "Relance impossible pour le moment.");
  if (isFail(res)) return res;
  const r = res.data;
  if (!r?.ok) {
    return {
      ok: false,
      error: r?.message || (r?.code === "TOO_SOON" ? "Déjà relancé il y a moins de 30 minutes." : "Rien à relancer pour ce règlement."),
    };
  }
  return { ok: true, message: r.message || "Rappel envoyé au chauffeur (application).", code: r.code };
}

// =============================================================================================================
// Fiche course : retirer la course au chauffeur partenaire, la clôturer à sa place
// =============================================================================================================

type ReassignPayload = { ok?: boolean; code?: string; message?: string };

/**
 * « Retirer » (fiche course) : le chauffeur partenaire est prévenu, la recherche repart avec vos chauffeurs d'abord ;
 * la course redevient modifiable (prix, adresses, heure). reassign_ride passe, pour une course tenue par un partenaire,
 * par unassign_network_ride (« removed_by_giver ») ; `expectedDriverId` évite de retirer la course à un autre chauffeur
 * que celui affiché (DRIVER_CHANGED). Tout membre : la base décide (org_network_ride.can.remove).
 */
export async function removeNetworkRide(rideId: string, expectedDriverId: string | null, reason?: string | null): Promise<NetworkActionResult> {
  const ctx = await context(false);
  if (failed(ctx)) return ctx;
  if (!UUID.test(rideId) || (expectedDriverId != null && !UUID.test(expectedDriverId))) return { ok: false, error: "Course introuvable." };
  const why = typeof reason === "string" ? reason.trim().slice(0, 300) : "";
  const res = await call<ReassignPayload | null>(
    ctx,
    "reassign_ride",
    { p_ride_id: rideId, p_reason: why || null, p_expected_driver: expectedDriverId },
    "Retrait impossible pour le moment.",
  );
  if (isFail(res)) return res;
  const r = res.data ?? {};
  if (!r.ok) return { ok: false, error: r.message || "La course a déjà changé : rechargez la fiche." };
  refresh(true);
  revalidatePath("/dashboard/rides");
  return {
    ok: true,
    message:
      r.code === "UNASSIGNED"
        ? "Course retirée au chauffeur partenaire : attribuez-la à l'un de vos chauffeurs."
        : "Course retirée au chauffeur partenaire : la recherche repart, vos chauffeurs d'abord.",
  };
}

/**
 * « Clôturer la course » (owner / admin) : le chauffeur partenaire ne peut plus la terminer dans l'application
 * (organisation ou chauffeur inactif, ou sans position depuis 30 min). La course passe « Terminée » et reste
 * « à vérifier » ; refus en base sinon (NETWORK_CLOSE_NOT_ALLOWED).
 */
export async function closeNetworkRide(rideId: string): Promise<NetworkActionResult> {
  const ctx = await context(true);
  if (failed(ctx)) return ctx;
  if (!UUID.test(rideId)) return { ok: false, error: "Course introuvable." };
  const res = await call<CloseNetworkRideResult>(ctx, "close_network_ride", { p_ride: rideId }, "Clôture impossible pour le moment.");
  if (isFail(res)) return res;
  refresh(true);
  revalidatePath("/dashboard/rides");
  return { ok: true, message: "Course clôturée : elle est marquée « à vérifier »." };
}
