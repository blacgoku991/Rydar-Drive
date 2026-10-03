// « Courses reçues » (B) : lecture seule (contrepartie = le chauffeur, décision Q2). Libellés du règlement vus par
// l'organisation du chauffeur — jamais le client, l'adresse exacte ni le détail de la part de l'organisation qui confie.
// Module pur (tests : received.test.ts).
import {
  NETWORK_EXECUTION_END_LABELS, RIDE_STATUS_META, formatPrice, type NetworkReceivedItem, type Tone,
} from "@rydar/shared";

/** État du règlement entre le chauffeur et l'organisation qui confie (ou de la course tant qu'il n'existe pas). */
export function receivedState(item: NetworkReceivedItem): { label: string; tone: Tone } {
  const s = item.settlement;
  const giver = item.giver.name;
  if (!s) {
    if (!item.ended_at && item.ride.status !== "COMPLETED") {
      const meta = RIDE_STATUS_META[item.ride.status];
      return { label: meta?.short ?? item.ride.status, tone: meta?.tone ?? "neutral" };
    }
    if (item.end_reason && item.end_reason !== "completed") return { label: NETWORK_EXECUTION_END_LABELS[item.end_reason], tone: "neutral" };
    return { label: "Terminée", tone: "green" };
  }
  const owes = item.money.direction === "driver_owes";
  switch (s.status) {
    case "declared":
      return { label: `Payé, à confirmer par ${giver}`, tone: "blue" };
    case "paid":
      return owes ? { label: `Reversé à ${giver}`, tone: "green" } : { label: `Versé par ${giver}`, tone: "green" };
    case "disputed":
      return { label: `Non reçu par ${giver}`, tone: "red" };
    case "waived":
      return { label: "Annulé", tone: "neutral" };
    default:
      if (!owes && s.on_hold) return { label: "Retenu : course à vérifier", tone: "amber" };
      if (s.overdue) return { label: owes ? "Reversement en retard" : "Versement en retard", tone: "red" };
      return owes ? { label: `À reverser à ${giver}`, tone: "amber" } : { label: `À verser par ${giver}`, tone: "violet" };
  }
}

/** Une seule ligne d'argent : « Payée à bord · le chauffeur reverse 12,50 € à Taxi Sud ». */
export function receivedMoneyLine(item: NetworkReceivedItem): string {
  const m = item.money;
  const amount = formatPrice(m.amount_cents, m.currency);
  return m.direction === "driver_owes"
    ? `Payée à bord · le chauffeur reverse ${amount} à ${item.giver.name}`
    : `Déjà payée · ${item.giver.name} verse ${amount} au chauffeur`;
}

/** « 75011 Paris → Orly » (communes seulement). */
export function receivedRoute(item: NetworkReceivedItem): string {
  return `${item.ride.pickup_area ?? "Départ non précisé"} → ${item.ride.dropoff_area ?? "Arrivée non précisée"}`;
}

/** Libellé court du chauffeur, identique à celui que voit l'organisation qui confie (« Karim B. »). */
export function driverShortLabel(d: { first_name: string; last_name: string } | null): string {
  if (!d) return "Chauffeur supprimé";
  const initial = d.last_name.trim().charAt(0).toUpperCase();
  return initial ? `${d.first_name.trim()} ${initial}.` : d.first_name.trim();
}

/** Onglet « Courses reçues » : visible si la réception est demandée, ou s'il existe un historique. */
export function showReceivedTab(opts: { shareIn: boolean; inProgress: number; monthRides: number; totalRides: number | null }): boolean {
  return opts.shareIn || opts.inProgress > 0 || opts.monthRides > 0 || (opts.totalRides ?? 0) > 0;
}
