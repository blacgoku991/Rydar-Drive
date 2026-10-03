// Alertes du rattacheur (components/alerts/dispatch-alerts.tsx) liées au réseau partagé : course proposée au réseau
// (information), aucun chauffeur après le réseau, acceptation par un chauffeur partenaire, règlement d'une course
// confiée. Module pur (tests : alerts.test.ts). Les événements ne contiennent jamais d'identifiant de partenaire.
import {
  NETWORK_CLOSE_CAUSE_LABELS, NETWORK_PARTNERS_NEARBY_MAX, NETWORK_RIDE_ALERT_TITLES, NETWORK_UNASSIGN_REASON_LABELS,
  NETWORK_WATCH_CAUSE_LABELS, networkPartnersFromNoDriver, type NetworkCloseCause, type NetworkNoDriverEventData,
  type NetworkShareStage, type NetworkUnassignReason, type NetworkWatchCause,
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

export type NetworkRideAlert = { title: string; body: string; level: "warning" | "info"; /** « Clôturer la course » */ close: boolean };

/**
 * Événements réseau d'une course confiée (journal, `ride.event`) affichés en alerte :
 *  - « network.executor_unavailable » : partenaire devenu indisponible, client à bord — il peut terminer, sinon A
 *    clôture la course (bouton « Clôturer la course », owner / admin) ;
 *  - « ride.network_unassigned » : course rendue (organisation du chauffeur, chauffeur indisponible) et relancée chez A,
 *    ses chauffeurs d'abord — rien quand A l'a retirée elle-même (« removed_by_giver » : déjà sous les yeux de l'auteur) ;
 *  - « ride.network_closed » : course clôturée par A, marquée « à vérifier ».
 * null : autre événement. Jamais l'identifiant du partenaire (les données n'en contiennent pas).
 */
export function networkRideAlert(
  e: { type?: string | null; data?: { reason?: string; cause?: string; auto?: boolean } | null },
  ride: { label: string; route: string },
): NetworkRideAlert | null {
  const label = ride.label ? ` ${ride.label}` : "";
  const join = (parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ");
  const d = e.data ?? {};
  switch (e.type) {
    case "network.executor_unavailable": {
      const cause = NETWORK_WATCH_CAUSE_LABELS[d.cause as NetworkWatchCause];
      return {
        title: `${NETWORK_RIDE_ALERT_TITLES["network.executor_unavailable"]}${label ? ` ·${label}` : ""}`,
        body: join([cause ? `Client à bord (${cause})` : "Client à bord", "il peut terminer la course ; sinon, clôturez-la", ride.route]),
        level: "warning",
        close: true,
      };
    }
    case "ride.network_unassigned": {
      if (d.reason === "removed_by_giver") return null;
      const reason = NETWORK_UNASSIGN_REASON_LABELS[d.reason as NetworkUnassignReason];
      return {
        title: `Course${label} retirée au chauffeur partenaire`,
        body: join([
          reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : null,
          d.auto === false ? "à attribuer à l'un de vos chauffeurs" : "recherche relancée, vos chauffeurs d'abord",
          ride.route,
        ]),
        level: "warning",
        close: false,
      };
    }
    case "ride.network_closed": {
      const cause = NETWORK_CLOSE_CAUSE_LABELS[d.cause as NetworkCloseCause];
      return {
        title: `Course${label} clôturée`,
        body: join(["Course partenaire marquée « à vérifier »", cause, ride.route]),
        level: "info",
        close: false,
      };
    }
    default:
      return null;
  }
}
