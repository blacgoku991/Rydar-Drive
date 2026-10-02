"use server";
// Frais plateforme (côté centrale ou flotte) : « J'ai payé » et retrait d'une déclaration non traitée.
// Seul le super admin confirme la réception ; la base vérifie owner / admin (centrale active ou suspendue).
import { declarePlatformPaymentSchema, describeError, fieldErrors } from "@rydar/shared";
import { revalidatePath } from "next/cache";
import { getPayerContext } from "@/components/platform-fees/org-payer-context";
import { actionError } from "@/lib/errors";

export type PlatformActionResult =
  | { ok: true; code: string; message: string; id?: string }
  | { ok: false; code: string; error: string; fieldErrors?: Record<string, string> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DECLARE_LABELS: Record<string, string> = {
  amountCents: "Montant",
  method: "Moyen de paiement",
  reference: "Référence",
  note: "Note",
  paidOn: "Date du paiement",
};

/** Codes métier renvoyés par declare_platform_payment → champ du formulaire concerné. */
const CODE_FIELD: Record<string, string> = { INVALID_AMOUNT: "amountCents", INVALID_METHOD: "method", INVALID_DATE: "paidOn" };

type RpcPayload = { ok?: boolean; code?: string; message?: string; id?: string };

function refresh() {
  // Centrale : Encaissements + relevé ; flotte : « Frais Rydar » + relevé (org-platform-paths)
  revalidatePath("/dashboard/settlements");
  revalidatePath("/dashboard/settlements/rydar");
  revalidatePath("/dashboard/rydar");
  revalidatePath("/dashboard/rydar/releve");
  revalidatePath("/suspended");
}

/** Centrale : « J'ai payé » — montant en centimes, moyen, référence, note, date du paiement. */
export async function declarePlatformPayment(input: {
  amountCents: number | string;
  method: string;
  reference?: string | null;
  note?: string | null;
  paidOn?: string | null;
}): Promise<PlatformActionResult> {
  const ctx = await getPayerContext();
  if (!ctx) return { ok: false, code: "FORBIDDEN", error: "Accès refusé." };
  if (!ctx.canPay) return { ok: false, code: "FORBIDDEN", error: "Réservé au propriétaire ou à un administrateur de la centrale." };
  const parsed = declarePlatformPaymentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "INVALID", error: describeError(parsed.error, DECLARE_LABELS), fieldErrors: fieldErrors(parsed.error) };
  }
  const v = parsed.data;
  const { data, error } = await ctx.supabase.rpc("declare_platform_payment", {
    p_org: ctx.org.id,
    p_amount: v.amountCents,
    p_method: v.method,
    p_reference: v.reference,
    p_note: v.note,
    p_paid_on: v.paidOn,
  });
  if (error) return { ok: false, code: "ERROR", error: actionError(error, "Déclaration impossible pour le moment. Réessayez dans un instant.") };
  const res = (data ?? {}) as RpcPayload;
  if (!res.ok) {
    const code = res.code ?? "ERROR";
    const message = res.message ?? "Déclaration impossible.";
    const field = CODE_FIELD[code];
    return { ok: false, code, error: field ? `${DECLARE_LABELS[field]} : ${message.charAt(0).toLowerCase()}${message.slice(1)}` : message, fieldErrors: field ? { [field]: message } : undefined };
  }
  refresh();
  return { ok: true, code: res.code ?? "DECLARED", message: res.message ?? "Paiement signalé : Rydar va le confirmer.", id: res.id };
}

/** Centrale : retire sa déclaration tant que Rydar ne l'a pas traitée (erreur de saisie). */
export async function cancelPlatformPayment(id: string): Promise<PlatformActionResult> {
  if (!UUID.test(id)) return { ok: false, code: "NOT_FOUND", error: "Paiement introuvable." };
  const ctx = await getPayerContext();
  if (!ctx) return { ok: false, code: "FORBIDDEN", error: "Accès refusé." };
  if (!ctx.canPay) return { ok: false, code: "FORBIDDEN", error: "Réservé au propriétaire ou à un administrateur de la centrale." };
  const { data, error } = await ctx.supabase.rpc("cancel_platform_payment", { p_id: id });
  if (error) return { ok: false, code: "ERROR", error: actionError(error, "Retrait impossible pour le moment.") };
  const res = (data ?? {}) as RpcPayload;
  if (!res.ok) return { ok: false, code: res.code ?? "ERROR", error: res.message ?? "Retrait impossible." };
  refresh();
  return { ok: true, code: res.code ?? "CANCELLED", message: res.message ?? "Déclaration retirée." };
}
