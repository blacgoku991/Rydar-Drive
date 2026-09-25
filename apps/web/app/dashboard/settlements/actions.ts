"use server";
// Encaissements (mode centrale) : « Reçu » / « Versé », « Pas reçu », annulation, réouverture, relance.
// Chaque RPC vérifie l'appartenance et le rôle en base (owner / admin pour annuler et rouvrir).
import type { SettlementMethod } from "@rydar/shared";
import { revalidatePath } from "next/cache";
import { isAdminRole } from "@/lib/auth";
import { actionError } from "@/lib/errors";
import { getOrgContext } from "@/lib/org-context";

export type SettlementActionResult =
  | { ok: true; code: string; message: string; count?: number; amount_cents?: number }
  | { ok: false; code: string; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = new Set<string>(["link", "cash", "transfer", "other"]);

async function centraleCtx() {
  const ctx = await getOrgContext();
  return ctx && ctx.org.dispatch_model === "centrale" ? ctx : null;
}

type RpcPayload = { ok?: boolean; code?: string; message?: string; count?: number; amount_cents?: number };

async function call(fn: string, args: Record<string, unknown>, opts: { adminOnly?: boolean } = {}): Promise<SettlementActionResult> {
  const ctx = await centraleCtx();
  if (!ctx) return { ok: false, code: "FORBIDDEN", error: "Réservé au mode centrale." };
  if (opts.adminOnly && !isAdminRole(ctx.role)) return { ok: false, code: "FORBIDDEN", error: "Réservé aux administrateurs de la centrale." };
  const { data, error } = await ctx.supabase.rpc(fn, args);
  if (error) return { ok: false, code: "ERROR", error: actionError(error, "Action impossible pour le moment.") };
  const res = (data ?? {}) as RpcPayload;
  if (!res.ok) return { ok: false, code: res.code ?? "ERROR", error: res.message ?? "Action impossible." };
  revalidatePath("/dashboard/settlements");
  return { ok: true, code: res.code ?? "OK", message: res.message ?? "", count: res.count, amount_cents: res.amount_cents };
}

/** « Reçu » (commission encaissée) / « Versé » (part chauffeur payée) — un ou plusieurs règlements. */
export async function confirmSettlements(ids: string[], method: SettlementMethod | "other" | null, note?: string | null) {
  const list = [...new Set(ids)].filter((id) => UUID.test(id));
  if (!list.length || list.length > 500) return { ok: false, code: "NOTHING_TO_CONFIRM", error: "Aucun règlement sélectionné." } satisfies SettlementActionResult;
  if (method != null && !METHODS.has(method)) return { ok: false, code: "INVALID_METHOD", error: "Moyen de paiement invalide." } satisfies SettlementActionResult;
  return call("confirm_settlements", { p_ids: list, p_method: method, p_note: note?.trim() || null });
}

/** « Pas reçu » : le chauffeur est prévenu (et bloqué si la centrale bloque les retardataires). */
export async function disputeSettlement(id: string, reason: string) {
  if (!UUID.test(id)) return { ok: false, code: "NOT_FOUND", error: "Règlement introuvable." } satisfies SettlementActionResult;
  if (reason.trim().length < 3) return { ok: false, code: "REASON_REQUIRED", error: "Précisez ce qui ne va pas." } satisfies SettlementActionResult;
  return call("dispute_settlement", { p_id: id, p_reason: reason.trim().slice(0, 500) });
}

/** Annuler une dette (geste commercial, course litigieuse…) — owner / admin. */
export async function waiveSettlement(id: string, reason: string) {
  if (!UUID.test(id)) return { ok: false, code: "NOT_FOUND", error: "Règlement introuvable." } satisfies SettlementActionResult;
  if (reason.trim().length < 3) return { ok: false, code: "REASON_REQUIRED", error: "Indiquez le motif de l'annulation." } satisfies SettlementActionResult;
  return call("waive_settlement", { p_id: id, p_reason: reason.trim().slice(0, 500) }, { adminOnly: true });
}

/** Erreur de saisie : un règlement encaissé / annulé redevient « à régler » — owner / admin. */
export async function reopenSettlement(id: string) {
  if (!UUID.test(id)) return { ok: false, code: "NOT_FOUND", error: "Règlement introuvable." } satisfies SettlementActionResult;
  return call("reopen_settlement", { p_id: id }, { adminOnly: true });
}

/** Relance push du chauffeur (une toutes les 30 min au plus). */
export async function remindDriverSettlements(driverId: string) {
  if (!UUID.test(driverId)) return { ok: false, code: "NOT_FOUND", error: "Chauffeur introuvable." } satisfies SettlementActionResult;
  return call("remind_driver_settlements", { p_driver_id: driverId });
}
