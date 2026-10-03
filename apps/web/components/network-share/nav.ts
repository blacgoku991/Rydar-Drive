// Entrée de menu « Réseau partagé » (sous Opérations) et sa pastille : à confirmer + en retard + à vérifier
// (org_network_summary.badge). Absente tant que l'interrupteur plateforme est coupé (shared_network_enabled()) :
// rien ne change alors pour personne. Module pur (tests : nav.test.ts).
import type { OrgNetworkSummary } from "@rydar/shared";
import { NETWORK_SHARE_PATH } from "./paths";

export type NetworkNavState = { badge: number; toConfirm: number; overdue: number; toCheck: number };

export const EMPTY_NETWORK_NAV: NetworkNavState = { badge: 0, toConfirm: 0, overdue: 0, toCheck: 0 };

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Compteurs de la pastille depuis le résumé (badge SQL prioritaire, sinon somme des trois compteurs). */
export function networkNavState(summary: Pick<OrgNetworkSummary, "badge" | "given"> | null | undefined): NetworkNavState {
  if (!summary?.given) return EMPTY_NETWORK_NAV;
  const g = summary.given;
  const toConfirm = g.to_confirm_count ?? 0;
  const overdue = g.overdue_count ?? 0;
  const toCheck = g.to_check_count ?? 0;
  const badge = Number.isFinite(summary.badge) ? Math.max(0, summary.badge) : toConfirm + overdue + toCheck;
  return { badge, toConfirm, overdue, toCheck };
}

export type NetworkNavItem = {
  href: string;
  label: string;
  icon: "share";
  badge: number;
  badgeTone: "red" | "amber";
  badgeLabel: string;
};

/** Entrée du menu, ou null quand le réseau partagé est fermé (interrupteur plateforme coupé). */
export function networkNavItem(state: NetworkNavState | null | undefined): NetworkNavItem | null {
  if (!state) return null;
  const label = [
    state.toConfirm ? plural(state.toConfirm, "paiement à confirmer", "paiements à confirmer") : null,
    state.overdue ? plural(state.overdue, "règlement en retard", "règlements en retard") : null,
    state.toCheck ? plural(state.toCheck, "course à vérifier", "courses à vérifier") : null,
  ].filter(Boolean).join(" · ");
  return {
    href: NETWORK_SHARE_PATH,
    label: "Réseau partagé",
    icon: "share",
    badge: state.badge,
    badgeTone: state.overdue ? "red" : "amber",
    badgeLabel: label || "Réseau partagé",
  };
}
