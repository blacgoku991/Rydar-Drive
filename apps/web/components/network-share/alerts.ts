// Alertes du rattacheur (components/alerts/dispatch-alerts.tsx) liées au réseau partagé : course proposée au réseau
// (information), aucun chauffeur après le réseau, acceptation par un chauffeur partenaire, règlement d'une course
// confiée. Module pur (tests : alerts.test.ts). Les événements ne contiennent jamais d'identifiant de partenaire.
import { networkPartnersFromNoDriver, type NetworkNoDriverEventData } from "@rydar/shared";
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

/** « dispatch.network » (information) : course proposée au réseau après les vagues de vos chauffeurs. */
export function networkProposedAlert(
  e: { data?: { partners_nearby?: number } | null },
  ride: { label: string; route: string },
): { title: string; body: string } {
  const n = e.data?.partners_nearby;
  return {
    title: `Course ${ride.label} proposée au réseau partagé`.replace("  ", " "),
    body: [
      "Aucun de vos chauffeurs n'a accepté",
      typeof n === "number" && n > 0 ? plural(n, "chauffeur partenaire à proximité", "chauffeurs partenaires à proximité") : null,
      ride.route || null,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

/** « dispatch.no_driver » passé par le réseau : « Réseau partagé : 3 chauffeurs partenaires sollicités », sinon null. */
export function noDriverNetworkLine(e: { message?: string | null; data?: NetworkNoDriverEventData | null }): string | null {
  const n = networkPartnersFromNoDriver(e.message, e.data);
  if (n == null) return null;
  return n > 0 ? `Réseau partagé : ${plural(n, "chauffeur partenaire sollicité", "chauffeurs partenaires sollicités")}` : "Réseau partagé : aucun chauffeur partenaire disponible";
}

/** Règlement d'une course confiée (bloc network de settlement_json) : page et libellé du bouton. */
export function networkSettlementLink(action: "created" | "declared", direction: "driver_owes" | "centrale_owes"): { href: string; cta: string } {
  const filter = action === "declared" ? "to_confirm" : direction === "centrale_owes" ? "to_pay" : null;
  return { href: networkShareHref({ tab: "confiees", filter }), cta: "Réseau partagé" };
}
