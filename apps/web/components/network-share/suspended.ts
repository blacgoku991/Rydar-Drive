// Organisation SUSPENDUE qui a confié des courses à des chauffeurs partenaires (C12) : ses règlements réseau restent
// dus et attendus. Lien depuis /suspended vers /suspended/reseau-partage (owner / admin). Module pur (tests).
import { formatPrice, type OrgNetworkSummary } from "@rydar/shared";

/** Quelque chose reste à régler, à vérifier ou en cours chez un partenaire. */
export function hasOpenNetworkSettlements(given: OrgNetworkSummary["given"] | null | undefined): boolean {
  if (!given) return false;
  return [given.to_collect_cents, given.to_pay_cents, given.to_confirm_count, given.overdue_count, given.disputed_count, given.to_check_count, given.in_progress].some(
    (v) => Number(v) > 0,
  );
}

/** « 12,50 € à encaisser · 37,50 € à verser » (montants non nuls seulement). */
export function openNetworkSummaryText(given: OrgNetworkSummary["given"], currency: string): string {
  const parts = [
    given.to_collect_cents > 0 ? `${formatPrice(given.to_collect_cents, currency)} à encaisser` : null,
    given.to_pay_cents > 0 ? `${formatPrice(given.to_pay_cents, currency)} à verser` : null,
    given.to_check_count > 0 ? `${given.to_check_count} à vérifier` : null,
    given.in_progress > 0 ? `${given.in_progress} en cours chez un partenaire` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Règlements à suivre avec les chauffeurs partenaires";
}
