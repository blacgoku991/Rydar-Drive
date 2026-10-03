"use server";
// Super admin : frais plateforme réglés à Rydar par les centrales et les flottes.
// Écritures par le service role APRÈS requireSuperAdmin() ; chaque fonction SQL (svc_platform_*) revérifie
// que l'auteur est super admin et écrit elle-même audit_logs (ne pas doubler l'audit ici).
import {
  describeError, fieldErrors, platformAdjustSchema, platformBillingSchema, platformTermsSchema, recordPlatformPaymentSchema, whatsappConfigSchema,
} from "@rydar/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth";
import { actionError } from "@/lib/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { removeWhatsApp, saveWhatsApp, testWhatsApp, type WhatsAppActionResult } from "@/lib/whatsapp";

export type PlatformActionResult =
  | { ok: true; code: string; message: string }
  | { ok: false; code?: string; error: string; fieldErrors?: Record<string, string> };

const uuid = z.string().uuid();

/** Noms des champs pour les messages d'erreur (« Montant : montant requis »). */
const PAYMENT_LABELS = { amountCents: "Montant", method: "Moyen de paiement", reference: "Référence", note: "Note", paidOn: "Date du paiement" };
const ADJUST_LABELS = { amountCents: "Montant", reason: "Motif" };
const TERMS_LABELS = { cycle: "Cycle de facturation", paymentDays: "Délai de paiement", blockAfterDays: "Blocage" };
const BILLING_LABELS = { payeeName: "Bénéficiaire", iban: "IBAN", bic: "BIC", paymentLink: "Lien de paiement", instructions: "Instructions" };

/** « Champ : message », sans répéter le champ quand le message le nomme déjà (« IBAN invalide »). */
function describe(error: z.ZodError, labels: Record<string, string>) {
  const issue = error.issues[0];
  const label = issue ? labels[String(issue.path[0] ?? "")] : undefined;
  if (issue && label && issue.message.toLowerCase().startsWith(label.toLowerCase())) return issue.message;
  return describeError(error, labels);
}

type RpcPayload = { ok?: boolean; code?: string; message?: string; field?: string };

function revalidate(orgId?: string | null) {
  revalidatePath("/admin/frais");
  if (orgId) {
    revalidatePath(`/admin/frais/${orgId}`);
    revalidatePath(`/admin/organizations/${orgId}`);
  } else {
    revalidatePath("/admin/frais/[orgId]", "page");
    revalidatePath("/admin/organizations/[id]", "page");
  }
  revalidatePath("/admin/centrales");
}

/** Appel d'une RPC svc_platform_* (service role), auteur = super admin connecté. */
async function svc(fn: string, args: Record<string, unknown>, orgId?: string | null): Promise<PlatformActionResult> {
  const session = await requireSuperAdmin();
  const { data, error } = await createAdminClient().rpc(fn, { ...args, p_actor: session.user.id });
  if (error) return { ok: false, error: actionError(error, "Action impossible pour le moment.") };
  const res = (data ?? {}) as RpcPayload;
  if (!res.ok) {
    const message = res.message ?? "Action impossible.";
    return { ok: false, code: res.code, error: message, fieldErrors: res.field ? { [res.field]: message } : undefined };
  }
  revalidate(orgId);
  return { ok: true, code: res.code ?? "OK", message: res.message ?? "" };
}

const cleanNote = (v: string | null | undefined, max = 500) => v?.trim().slice(0, max) || null;

/** « Reçu » : montant réellement reçu (partiel possible), note facultative. */
export async function confirmPlatformPayment(id: string, receivedCents: number | null, note?: string | null): Promise<PlatformActionResult> {
  if (!uuid.safeParse(id).success) return { ok: false, error: "Paiement introuvable." };
  if (receivedCents != null && (!Number.isInteger(receivedCents) || receivedCents < 1 || receivedCents > 100_000_000)) {
    return { ok: false, error: "Montant reçu invalide.", fieldErrors: { receivedCents: "Montant invalide" } };
  }
  return svc("svc_platform_confirm_payment", { p_id: id, p_received_cents: receivedCents, p_note: cleanNote(note) });
}

/** « Pas reçu » : motif obligatoire, la centrale est prévenue. */
export async function rejectPlatformPayment(id: string, reason: string): Promise<PlatformActionResult> {
  if (!uuid.safeParse(id).success) return { ok: false, error: "Paiement introuvable." };
  const r = cleanNote(reason);
  if (!r || r.length < 3) return { ok: false, error: "Motif : précisez ce qui ne va pas.", fieldErrors: { reason: "Motif requis" } };
  return svc("svc_platform_reject_payment", { p_id: id, p_reason: r });
}

/** Erreur de saisie : un paiement reçu / pas reçu redevient « à confirmer » (motif obligatoire). */
export async function reopenPlatformPayment(id: string, reason: string): Promise<PlatformActionResult> {
  if (!uuid.safeParse(id).success) return { ok: false, error: "Paiement introuvable." };
  const r = cleanNote(reason);
  if (!r || r.length < 3) return { ok: false, error: "Motif : indiquez pourquoi vous rouvrez ce paiement.", fieldErrors: { reason: "Motif requis" } };
  return svc("svc_platform_reopen_payment", { p_id: id, p_reason: r });
}

/** Paiement reçu directement par Rydar (virement non déclaré, espèces…). */
export async function recordPlatformPayment(orgId: string, input: z.input<typeof recordPlatformPaymentSchema>): Promise<PlatformActionResult> {
  if (!uuid.safeParse(orgId).success) return { ok: false, error: "Organisation introuvable." };
  const parsed = recordPlatformPaymentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: describe(parsed.error, PAYMENT_LABELS), fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  return svc(
    "svc_platform_record_payment",
    { p_org: orgId, p_amount: v.amountCents, p_method: v.method, p_reference: v.reference, p_note: v.note, p_paid_on: v.paidOn },
    orgId,
  );
}

/** Avoir (montant négatif) ou frais ajoutés (positif), motif obligatoire. */
export async function adjustPlatformFees(orgId: string, input: z.input<typeof platformAdjustSchema>): Promise<PlatformActionResult> {
  if (!uuid.safeParse(orgId).success) return { ok: false, error: "Organisation introuvable." };
  const parsed = platformAdjustSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: describe(parsed.error, ADJUST_LABELS), fieldErrors: fieldErrors(parsed.error) };
  return svc("svc_platform_adjust", { p_org: orgId, p_amount: parsed.data.amountCents, p_reason: parsed.data.reason }, orgId);
}

/** Baisse de frais (prix corrigé après la course) : acceptée → comptée ; refusée (motif obligatoire) → ignorée. */
export async function reviewPlatformReduction(entryId: string, approve: boolean, note?: string | null): Promise<PlatformActionResult> {
  if (!uuid.safeParse(entryId).success) return { ok: false, error: "Écriture introuvable." };
  const n = cleanNote(note);
  if (!approve && (!n || n.length < 3)) return { ok: false, error: "Motif : indiquez pourquoi vous refusez la baisse.", fieldErrors: { note: "Motif requis" } };
  return svc("svc_platform_review_entry", { p_id: entryId, p_approve: approve, p_note: n });
}

/** Relance affichée dans le tableau de bord de la centrale (au plus une par heure), et par WhatsApp au propriétaire si demandé. */
export async function remindPlatformCentrale(orgId: string, note?: string | null, whatsapp = false): Promise<PlatformActionResult> {
  if (!uuid.safeParse(orgId).success) return { ok: false, error: "Organisation introuvable." };
  return svc("svc_platform_remind", { p_org: orgId, p_note: cleanNote(note, 300), p_whatsapp: whatsapp === true }, orgId);
}

/** reason « FLEET_UNSUPPORTED » (20260924006600) : flotte — le modèle approuvé par Meta renvoie à « Encaissements ». */
export type PlatformWhatsAppTarget = {
  ready: boolean;
  to_display: string | null;
  source: "owner" | "organization" | null;
  name: string | null;
  reason: "NOT_CONFIGURED" | "NO_PHONE" | "FLEET_UNSUPPORTED" | null;
};

/** Relance WhatsApp possible pour cette centrale ? (numéro de Rydar relié, téléphone du propriétaire ou de la centrale) */
export async function platformWhatsAppTarget(orgId: string): Promise<PlatformWhatsAppTarget | null> {
  if (!uuid.safeParse(orgId).success) return null;
  const session = await requireSuperAdmin();
  const { data, error } = await session.supabase.rpc("admin_platform_whatsapp", { p_org: orgId });
  if (error) return null;
  return data as PlatformWhatsAppTarget;
}

export async function savePlatformWhatsApp(input: z.input<typeof whatsappConfigSchema>): Promise<WhatsAppActionResult> {
  const session = await requireSuperAdmin();
  const res = await saveWhatsApp(null, session.user.id, input);
  if (res.ok) revalidatePath("/admin/frais");
  return res;
}

export async function removePlatformWhatsApp(): Promise<WhatsAppActionResult> {
  const session = await requireSuperAdmin();
  const res = await removeWhatsApp(null, session.user.id);
  if (res.ok) revalidatePath("/admin/frais");
  return res;
}

export async function testPlatformWhatsApp(to: string): Promise<WhatsAppActionResult> {
  const session = await requireSuperAdmin();
  const res = await testWhatsApp(null, "Centrale exemple", to);
  // Message envoyé depuis le numéro WhatsApp de Rydar : tracé (numéro masqué, résultat)
  const digits = String(to ?? "").replace(/\D/g, "");
  await audit({
    actorUserId: session.user.id,
    actorType: "super_admin",
    action: "whatsapp.test_sent",
    severity: res.ok ? "info" : "warning",
    metadata: { to: digits ? `…${digits.slice(-2)}` : null, ok: res.ok },
  });
  revalidatePath("/admin/frais");
  return res;
}

/** Conditions de la centrale : cycle, délai de paiement, blocage après N jours de retard (ou jamais). */
export async function updatePlatformTerms(orgId: string, input: z.input<typeof platformTermsSchema>): Promise<PlatformActionResult> {
  if (!uuid.safeParse(orgId).success) return { ok: false, error: "Organisation introuvable." };
  const parsed = platformTermsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: describe(parsed.error, TERMS_LABELS), fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  return svc("svc_platform_terms", { p_org: orgId, p_cycle: v.cycle, p_payment_days: v.paymentDays, p_block_after_days: v.blockAfterDays }, orgId);
}

/** Coordonnées de paiement de Rydar affichées aux centrales (IBAN, BIC, lien, instructions). */
export async function updatePlatformBilling(input: z.input<typeof platformBillingSchema>): Promise<PlatformActionResult> {
  const parsed = platformBillingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: describe(parsed.error, BILLING_LABELS), fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  const res = await svc("svc_platform_billing_update", {
    p_payee_name: v.payeeName,
    p_iban: v.iban,
    p_bic: v.bic,
    p_payment_link: v.paymentLink,
    p_instructions: v.instructions,
  });
  // Erreur de la RPC rattachée à un champ : « IBAN : IBAN invalide. »
  if (!res.ok && res.fieldErrors) {
    const [field] = Object.keys(res.fieldErrors);
    const label = field ? BILLING_LABELS[field as keyof typeof BILLING_LABELS] : undefined;
    if (label && !res.error.startsWith(label)) return { ...res, error: `${label} : ${res.error.charAt(0).toLowerCase()}${res.error.slice(1)}` };
  }
  return res;
}
