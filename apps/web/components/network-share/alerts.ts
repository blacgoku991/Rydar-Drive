// Alertes du rattacheur (components/alerts/dispatch-alerts.tsx) liées au réseau partagé : course proposée au réseau
// (information), aucun chauffeur après le réseau, acceptation par un chauffeur partenaire, règlement d'une course
// confiée. Module pur (tests : alerts.test.ts). Les événements ne contiennent jamais d'identifiant de partenaire.
import {
  NETWORK_PARTNERS_NEARBY_MAX, networkPartnersFromNoDriver, type NetworkNoDriverEventData, type NetworkShareStage,
} from "@rydar/shared";
import { networkShareHref } from "./paths";

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/**
 * « offer.accepted » : « Karim accepte » (chauffeur propre) ou « Karim B. (Flotte B) accepte — chauffeur du réseau
 * partagé » (spec §9.5) → qui, et s'il s'agit d'un chauffeur partenaire.
 */
export function acceptedBy(message: string | null | undefined, data?: { network?: boolean } | null): { who: string; network: boolean } {
  const text = String(message ?? "").trim();
  const network = data?.network === true || /réseau partagé/i.test(text);
  const who = text.replace(/\s+accepte(\s+—.*)?$/u, "").trim();
  return { who: who || (network ? "Un chauffeur partenaire" : "Un chauffeur"), network };
}

/**
 * « dispatch.network » (information) : course proposée au réseau après les vagues de vos chauffeurs (immédiate), ou
 * planifiée toujours sans chauffeur dans la fenêtre réseau (`stage: "scheduled_window"`, proposée en plus à la flotte).
 */
export function networkProposedAlert(
  e: { data?: { partners_nearby?: number; stage?: NetworkShareStage } | null },
  ride: { label: string; route: string },
): { title: string; body: string } {
  const n = e.data?.partners_nearby;
  const scheduled = e.data?.stage === "scheduled_window";
  return {
    title: (scheduled ? `Planifiée ${ride.label} proposée aussi au réseau partagé` : `Course ${ride.label} proposée au réseau partagé`).replace("  ", " "),
    body: [
      scheduled ? "Toujours sans chauffeur" : "Aucun de vos chauffeurs n'a accepté",
      typeof n === "number" && n > 0
        ? n >= NETWORK_PARTNERS_NEARBY_MAX
          ? `${NETWORK_PARTNERS_NEARBY_MAX} chauffeurs partenaires ou plus à proximité` // compteur plafonné (20260924007200)
          : plural(n, "chauffeur partenaire à proximité", "chauffeurs partenaires à proximité")
        : null,
      ride.route || null,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

/**
 * « dispatch.no_driver » passé par le réseau : « Réseau partagé : 3 chauffeurs partenaires sollicités » (compteur
 * `partners_offered`, sinon le message complété par le SQL), « Réseau partagé interrompu » (`network: true` sans
 * compteur : partage arrêté après des erreurs, sans détail technique), sinon null.
 */
export function noDriverNetworkLine(e: { message?: string | null; data?: NetworkNoDriverEventData | null }): string | null {
  const n = networkPartnersFromNoDriver(e.message, e.data);
  if (n == null) return e.data?.network === true ? "Réseau partagé interrompu" : null;
  return n > 0 ? `Réseau partagé : ${plural(n, "chauffeur partenaire sollicité", "chauffeurs partenaires sollicités")}` : "Réseau partagé : aucun chauffeur partenaire disponible";
}

/**
 * Règlement d'une course confiée (bloc network de settlement_json) : « Courses confiées » filtrée — à confirmer
 * (paiement signalé), à verser (course déjà payée) ou à encaisser (payée à bord) — et libellé du bouton. Le
 * sous-onglet est toujours explicite (la page ouvre sinon celui qui convient à l'état de l'organisation).
 */
export function networkSettlementLink(action: "created" | "declared", direction: "driver_owes" | "centrale_owes"): { href: string; cta: string } {
  const filter = action === "declared" ? "to_confirm" : direction === "centrale_owes" ? "to_pay" : "to_collect";
  return { href: networkShareHref({ tab: "confiees", filter }), cta: "Réseau partagé" };
}
