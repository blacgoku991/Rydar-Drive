import type { Settlement } from "@rydar/shared";

/** Ligne ride_settlements (lecture directe) → règlement avec les indicateurs calculés comme private.settlement_json. */
export type SettlementRow = Omit<Settlement, "overdue" | "blocking"> & { overdue?: boolean; blocking?: boolean; disputed_at?: string | null };

/**
 * Indicateurs de private.settlement_json (20260924004400), recalculés à l'heure affichée :
 * - overdue : commission à régler dont l'échéance est passée ;
 * - blocking : règle « unpaid » de private.centrale_blocker (offres bloquées) — montant > 0 et commission contestée,
 *   « à régler » échue, ou redéclarée après un « Pas reçu » (disputed_at).
 */
export function withFlags(row: SettlementRow, now = Date.now()): Settlement {
  const owes = row.direction === "driver_owes";
  const late = owes && row.status === "due" && Date.parse(row.due_at) <= now;
  const blocking =
    owes && row.amount_cents > 0 && (row.status === "disputed" || late || (row.status === "declared" && row.disputed_at != null));
  return { ...row, overdue: late, blocking };
}
