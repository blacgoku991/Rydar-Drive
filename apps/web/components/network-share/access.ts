// Accès à l'onglet « Réseau partagé » selon l'interrupteur plateforme (lib/shared-network.ts → networkAccess) :
//   • réseau ouvert : onglet complet (Courses confiées, Courses reçues, Réglages), menu, bandeaux ;
//   • réseau FERMÉ par Rydar après avoir été ouvert (organisation déjà membre) : onglet réduit à « Courses confiées » et
//     « Courses reçues », sans Réglages ni bandeau, pour régler les sommes en cours (contrat NETWORK_CLOSED_RPCS) ; le
//     menu ne le montre que tant qu'il reste des sommes ou des courses en cours ;
//   • jamais ouvert pour l'organisation (aucune adhésion) : rien du tout, comme avant le réseau.
// Choix du sous-onglet sans paramètre d'URL. Module pur (tests : access.test.ts).
import { formatPrice, type OrgNetworkSummary } from "@rydar/shared";
import type { NetworkShareTab } from "./paths";
import type { OrgReadinessView } from "./readiness";
import { hasOpenNetworkSettlements } from "./suspended";

export type NetworkAccess =
  /** Interrupteur plateforme ouvert : onglet complet (summary null : résumé illisible) */
  | { mode: "open"; summary: OrgNetworkSummary | null }
  /** Interrupteur coupé, organisation déjà membre : onglet réduit ; `pending` = sommes ou courses en cours */
  | { mode: "closed"; summary: OrgNetworkSummary | null; pending: boolean };

/** Phrase de l'onglet réduit (réseau fermé par Rydar). */
export const NETWORK_CLOSED_NOTICE = "Réseau partagé fermé par Rydar : plus aucune course n'est partagée ; réglez ici les sommes en cours.";

/** Côté organisation du chauffeur (B) : ses chauffeurs en course partenaire, ou des règlements encore ouverts. */
export function receivedPending(received: OrgNetworkSummary["received"] | null | undefined): boolean {
  return Number(received?.in_progress) > 0 || Number(received?.open_count) > 0;
}

/** Quelque chose reste à régler, à vérifier ou en cours, d'un côté (courses confiées) ou de l'autre (reçues). */
export function networkPendingWork(summary: Pick<OrgNetworkSummary, "given" | "received"> | null | undefined): boolean {
  if (!summary) return false;
  return hasOpenNetworkSettlements(summary.given) || receivedPending(summary.received);
}

/**
 * Encaissements (centrale) : renvoi vers « Réseau partagé » quand des règlements de chauffeurs partenaires sont ouverts
 * (ils n'apparaissent pas dans Encaissements) — « 12,50 € à encaisser · 37,50 € à verser · 1 paiement à confirmer ».
 * null : rien d'ouvert.
 */
export function partnerSettlementsLine(given: OrgNetworkSummary["given"] | null | undefined, currency: string): string | null {
  if (!given) return null;
  const n = (v: number, one: string, many: string) => `${v} ${v > 1 ? many : one}`;
  const parts = [
    given.to_collect_cents > 0 ? `${formatPrice(given.to_collect_cents, currency)} à encaisser` : null,
    given.to_pay_cents > 0 ? `${formatPrice(given.to_pay_cents, currency)} à verser` : null,
    given.to_confirm_count > 0 ? n(given.to_confirm_count, "paiement à confirmer", "paiements à confirmer") : null,
    given.overdue_count > 0 ? n(given.overdue_count, "règlement en retard", "règlements en retard") : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** Entrée « Réseau partagé » du menu : réseau ouvert, ou fermé avec des sommes / courses en cours. */
export function networkMenuShown(access: NetworkAccess | null | undefined): boolean {
  return access?.mode === "open" || (access?.mode === "closed" && access.pending);
}

/**
 * Sous-onglet ouvert sans paramètre `tab` (lien du menu) :
 *   • des sommes à régler sur les courses confiées : « Courses confiées » ;
 *   • réseau fermé : « Courses reçues » s'il ne reste que des courses de vos chauffeurs, sinon « Courses confiées » ;
 *   • rien de demandé (deux sens désactivés) : « Réglages » ;
 *   • seule la réception est demandée : « Courses reçues » ;
 *   • sinon « Courses confiées ».
 */
export function defaultNetworkTab(opts: {
  mode: NetworkAccess["mode"];
  summary: Pick<OrgNetworkSummary, "given" | "received"> | null;
  view: Pick<OrgReadinessView, "sides" | "idle"> | null;
  receivedVisible: boolean;
}): NetworkShareTab {
  if (hasOpenNetworkSettlements(opts.summary?.given)) return "confiees";
  if (opts.mode === "closed") return opts.receivedVisible && receivedPending(opts.summary?.received) ? "recues" : "confiees";
  if (!opts.view) return "confiees";
  if (opts.view.idle) return "reglages";
  if (opts.view.sides.out.state === "off" && opts.view.sides.in.state !== "off" && opts.receivedVisible) return "recues";
  return "confiees";
}
