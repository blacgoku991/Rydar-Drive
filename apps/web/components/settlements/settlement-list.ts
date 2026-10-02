// Règles de la liste « Encaissements », partagées par la page serveur et la vue client (module sans « use client »).
import type { OrgSettlementItem } from "@rydar/shared";

/** Taille de la liste affichée par défaut ; « Afficher plus » ajoute 100 lignes jusqu'à 500. */
export const SETTLEMENT_PAGE = 100;
export const SETTLEMENT_MAX = 500;

/**
 * Règlement ouvert réduit à ce que demandent les compteurs des onglets et les réclamations WhatsApp : seules les lignes
 * affichées sont envoyées complètes au navigateur.
 */
export type OpenSettlement = Pick<OrgSettlementItem, "id" | "driver_id" | "direction" | "status" | "due_at" | "amount_cents" | "reference"> & {
  ride_number: number | null;
};

type Ranked = Pick<OrgSettlementItem, "direction" | "status" | "due_at" | "created_at">;

export const lateNow = (s: Pick<OrgSettlementItem, "direction" | "status" | "due_at">, now: number) =>
  s.direction === "driver_owes" && (s.status === "disputed" || (s.status === "due" && Date.parse(s.due_at) <= now));

/** « À traiter » : d'abord ce qui attend une décision (déclaré), puis les retards, le reste, les versements. */
export function openRank(s: Ranked, now: number) {
  if (s.status === "declared") return 0;
  if (s.status === "disputed") return 1;
  if (lateNow(s, now)) return 2;
  return s.direction === "driver_owes" ? 3 : 4;
}

export function sortOpen<T extends Ranked>(items: T[], now: number): T[] {
  return [...items].sort((a, b) => openRank(a, now) - openRank(b, now) || b.created_at.localeCompare(a.created_at));
}

export function compactOpen(s: OrgSettlementItem): OpenSettlement {
  // Même règle que rideNumberOf (settlement-ui) : numéro de la course, sinon celui de la référence « C1783 »
  const fromReference = /^C(\d+)$/.exec(s.reference);
  return {
    id: s.id,
    driver_id: s.driver_id,
    direction: s.direction,
    status: s.status,
    due_at: s.due_at,
    amount_cents: s.amount_cents,
    reference: s.reference,
    ride_number: s.ride?.number || (fromReference ? Number(fromReference[1]) : null),
  };
}
