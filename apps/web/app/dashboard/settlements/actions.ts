"use server";
// Encaissements (mode centrale) : « Reçu » / « Versé », « Pas reçu », annulation, réouverture, relance.
// Chaque RPC vérifie l'appartenance et le rôle en base (owner / admin pour annuler et rouvrir).
// Règlements PROPRES seulement : une ligne du réseau partagé (chauffeur partenaire) se traite dans l'onglet « Réseau
// partagé » (argent réseau : owner / admin, assert_network_creditor en base) — refusée ici avant tout appel, même
// glissée dans un lot.
import type { SettlementMethod } from "@rydar/shared";
import { revalidatePath } from "next/cache";
import { isAdminRole } from "@/lib/auth";
import { actionError } from "@/lib/errors";
import { getOrgContext } from "@/lib/org-context";

export type SettlementActionResult =
  | { ok: true; code: string; message: string; count?: number; amount_cents?: number; received_cents?: number; paid_out_cents?: number }
  | { ok: false; code: string; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = new Set<string>(["link", "cash", "transfer", "other"]);

async function centraleCtx() {
  const ctx = await getOrgContext();
  return ctx && ctx.org.dispatch_model === "centrale" ? ctx : null;
}

type RpcPayload = {
  ok?: boolean; code?: string; message?: string; count?: number; amount_cents?: number;
  /** confirm_settlements : commissions encaissées / parts versées, jamais additionnées (20260924004400) */
  received_cents?: number; paid_out_cents?: number;
};

type Ctx = NonNullable<Awaited<ReturnType<typeof centraleCtx>>>;

/** Lignes du réseau partagé lues par paquets (URL bornée) ; lecture impossible = refus (jamais d'action à l'aveugle). */
const NETWORK_LINE_ERROR = "Règlement du réseau partagé : à traiter dans l'onglet Réseau partagé.";
const GUARD_CHUNK = 100;

/**
 * Refuse tout identifiant qui désigne une ligne du réseau partagé (network_driver_org_id non NULL), dans TOUTES les
 * organisations du membre (RLS), et pas seulement l'organisation affichée : un membre de plusieurs organisations ne
 * peut pas viser la ligne réseau d'une autre par ce chemin. null : uniquement des règlements propres (ou introuvables,
 * que la base refuse elle-même).
 */
async function refuseNetworkLines(ctx: Ctx, ids: string[]): Promise<SettlementActionResult | null> {
  for (let i = 0; i < ids.length; i += GUARD_CHUNK) {
    const { data, error } = await ctx.supabase
      .from("ride_settlements")
      .select("id")
      .in("id", ids.slice(i, i + GUARD_CHUNK))
      .not("network_driver_org_id", "is", null)
      .limit(1);
    if (error) return { ok: false, code: "ERROR", error: "Action impossible pour le moment." };
    if ((data ?? []).length > 0) return { ok: false, code: "NETWORK_SETTLEMENT", error: NETWORK_LINE_ERROR };
  }
  return null;
}

async function call(fn: string, args: Record<string, unknown>, opts: { adminOnly?: boolean; ids?: string[] } = {}): Promise<SettlementActionResult> {
  const ctx = await centraleCtx();
  if (!ctx) return { ok: false, code: "FORBIDDEN", error: "Réservé au mode centrale." };
  if (opts.adminOnly && !isAdminRole(ctx.role)) return { ok: false, code: "FORBIDDEN", error: "Réservé aux administrateurs de la centrale." };
  if (opts.ids?.length) {
    const refused = await refuseNetworkLines(ctx, opts.ids);
    if (refused) return refused;
  }
  const { data, error } = await ctx.supabase.rpc(fn, args);
  if (error) return { ok: false, code: "ERROR", error: actionError(error, "Action impossible pour le moment.") };
  const res = (data ?? {}) as RpcPayload;
  if (!res.ok) return { ok: false, code: res.code ?? "ERROR", error: res.message ?? "Action impossible." };
  revalidatePath("/dashboard/settlements");
  return {
    ok: true, code: res.code ?? "OK", message: res.message ?? "", count: res.count, amount_cents: res.amount_cents,
    received_cents: res.received_cents, paid_out_cents: res.paid_out_cents,
  };
}

/** « Reçu » (commission encaissée) / « Versé » (part chauffeur payée) — un ou plusieurs règlements. */
export async function confirmSettlements(ids: string[], method: SettlementMethod | "other" | null, note?: string | null) {
  const list = [...new Set(ids)].filter((id) => UUID.test(id));
  if (!list.length || list.length > 500) return { ok: false, code: "NOTHING_TO_CONFIRM", error: "Aucun règlement sélectionné." } satisfies SettlementActionResult;
  if (method != null && !METHODS.has(method)) return { ok: false, code: "INVALID_METHOD", error: "Moyen de paiement invalide." } satisfies SettlementActionResult;
  return call("confirm_settlements", { p_ids: list, p_method: method, p_note: note?.trim() || null }, { ids: list });
}

/** « Pas reçu » : le chauffeur est prévenu (et bloqué si la centrale bloque les retardataires). */
export async function disputeSettlement(id: string, reason: string) {
  if (!UUID.test(id)) return { ok: false, code: "NOT_FOUND", error: "Règlement introuvable." } satisfies SettlementActionResult;
  if (reason.trim().length < 3) return { ok: false, code: "REASON_REQUIRED", error: "Précisez ce qui ne va pas." } satisfies SettlementActionResult;
  return call("dispute_settlement", { p_id: id, p_reason: reason.trim().slice(0, 500) }, { ids: [id] });
}

/** Annuler une dette (geste commercial, course litigieuse…) — owner / admin. */
export async function waiveSettlement(id: string, reason: string) {
  if (!UUID.test(id)) return { ok: false, code: "NOT_FOUND", error: "Règlement introuvable." } satisfies SettlementActionResult;
  if (reason.trim().length < 3) return { ok: false, code: "REASON_REQUIRED", error: "Indiquez le motif de l'annulation." } satisfies SettlementActionResult;
  return call("waive_settlement", { p_id: id, p_reason: reason.trim().slice(0, 500) }, { adminOnly: true, ids: [id] });
}

/** Erreur de saisie : un règlement encaissé / annulé redevient « à régler » — owner / admin. */
export async function reopenSettlement(id: string) {
  if (!UUID.test(id)) return { ok: false, code: "NOT_FOUND", error: "Règlement introuvable." } satisfies SettlementActionResult;
  return call("reopen_settlement", { p_id: id }, { adminOnly: true, ids: [id] });
}

/** Relance push du chauffeur (une toutes les 30 min au plus). */
export async function remindDriverSettlements(driverId: string) {
  if (!UUID.test(driverId)) return { ok: false, code: "NOT_FOUND", error: "Chauffeur introuvable." } satisfies SettlementActionResult;
  return call("remind_driver_settlements", { p_driver_id: driverId });
}
