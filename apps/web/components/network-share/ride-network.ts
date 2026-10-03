// Course du réseau partagé vue par l'organisation qui la confie (A) : fiche course, liste des courses, En direct,
// panneau du command center. Module pur (ni « use client » ni « server-only ») ; tests : ride-network.test.ts.
//
// Rien ne s'affiche pour une course qui n'a jamais touché le réseau : interrupteur plateforme coupé, aucune course n'a
// de driver_org_id étranger, de network_at ni d'événement « dispatch.network* » — rien ne change pour personne.
import {
  NETWORK_SHARE_CLOSED_LABELS, NETWORK_SUSPECT_REASON_META, formatTime,
  type NetworkDriverChecks, type NetworkGivenItem, type NetworkShareStatus, type OrgNetworkRide, type Tone,
} from "@rydar/shared";
import { givenRowActions, type GivenRowActions } from "./given";

/** Colonnes de rides lues pour décider (select('*') de la fiche, liste, instantané d'En direct). */
export type NetworkRideColumns = {
  organization_id?: string | null;
  driver_id?: string | null;
  driver_org_id?: string | null;
  network_at?: string | null;
  status: string;
};

/** Montants et adresses figés tant qu'un partenaire tient la course (garde G6, NETWORK_RIDE_LOCKED). */
export const NETWORK_LOCK_MESSAGE = "Course confiée : retirez-la au partenaire pour la modifier.";
/** Course partagée terminée : montants acceptés par le partenaire, figés (G6 vaut aussi après la fin). */
export const NETWORK_DONE_LOCK_MESSAGE = "Course faite par un chauffeur partenaire : les montants acceptés sont figés.";

/** Organisation du chauffeur quand elle n'est pas la sienne (course tenue ou faite par un partenaire), sinon null. */
export function partnerOrgOf(ride: Pick<NetworkRideColumns, "driver_id" | "driver_org_id">, orgId: string): string | null {
  return ride.driver_id && ride.driver_org_id && ride.driver_org_id !== orgId ? ride.driver_org_id : null;
}

/** Course proposée au réseau en ce moment (aucun chauffeur ne la tient encore). */
export function proposedToNetwork(ride: Pick<NetworkRideColumns, "driver_id" | "network_at" | "status">): boolean {
  return !!ride.network_at && !ride.driver_id && ["CREATED", "SEARCHING_DRIVER", "OFFERED"].includes(ride.status);
}

/**
 * La fiche course doit-elle lire org_network_ride ? Course tenue par un partenaire, proposée au réseau, ou passée par
 * le réseau (journal : partage ouvert puis clos, partenaire retiré). Sinon : aucun appel, fiche inchangée.
 */
export function rideTouchesNetwork(ride: NetworkRideColumns, orgId: string, eventTypes: Iterable<string> = []): boolean {
  if (partnerOrgOf(ride, orgId) || ride.network_at) return true;
  for (const t of eventTypes) if (typeof t === "string" && t.startsWith("dispatch.network")) return true;
  return false;
}

/** Message de verrouillage des montants (prix, paiement, commission) et des adresses, ou null si modifiable. */
export function networkLockMessage(ride: NetworkRideColumns, orgId: string): string | null {
  if (!partnerOrgOf(ride, orgId)) return null;
  if (ride.status === "COMPLETED") return NETWORK_DONE_LOCK_MESSAGE;
  if (ride.status === "CANCELLED" || ride.status === "NO_DRIVER_FOUND") return null;
  return NETWORK_LOCK_MESSAGE;
}

/** « Réseau · Flotte B » (nom validé de l'organisation partenaire). */
export function partnerTag(name: string | null | undefined): string {
  return name ? `Réseau · ${name}` : "Réseau partagé";
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** État du partage en une ligne (fiche course) : titre, ton, détail. */
export function shareSummary(
  share: NonNullable<OrgNetworkRide["share"]>,
  timeZone: string,
): { label: string; tone: Tone; detail: string } {
  const since = formatTime(share.opened_at, timeZone);
  const asked = share.partners_offered > 0 ? plural(share.partners_offered, "chauffeur partenaire sollicité", "chauffeurs partenaires sollicités") : null;
  const status: NetworkShareStatus = share.status;
  if (status === "open") {
    return {
      label: "Proposée au réseau partagé",
      tone: "violet",
      detail: [`depuis ${since}`, asked ?? "recherche d'un chauffeur partenaire à proximité", "vos chauffeurs restent prioritaires"].join(" · "),
    };
  }
  if (status === "accepted") return { label: "Confiée à un chauffeur partenaire", tone: "violet", detail: [`proposée à ${since}`, asked].filter(Boolean).join(" · ") };
  if (status === "completed") return { label: "Course partagée terminée", tone: "green", detail: `proposée au réseau à ${since}` };
  const reason = share.closed_reason ? NETWORK_SHARE_CLOSED_LABELS[share.closed_reason] : "Partage clos";
  return {
    label: "Partage terminé",
    tone: "neutral",
    detail: [reason, share.closed_at ? `à ${formatTime(share.closed_at, timeZone)}` : null, asked].filter(Boolean).join(" · "),
  };
}

/** « 2027-03-31 » → « 31/03/2027 » (dates sans heure : aucun fuseau). */
export function dayLabel(value: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

/** Contrôles figés à l'acceptation (preuve de diligence, sans les pièces) : libellé + valeur, échéance passée signalée. */
export function checkLines(checks: NetworkDriverChecks, at: string | null | undefined): { label: string; value: string; expired: boolean }[] {
  const day = (at ?? "").slice(0, 10);
  const line = (label: string, v: string | null) => ({
    label,
    value: dayLabel(v) ? `valable jusqu'au ${dayLabel(v)}` : "sans échéance",
    expired: !!v && !!day && v.slice(0, 10) < day,
  });
  return [
    { label: "N° de carte VTC", value: checks.vtc_card_number || "—", expired: false },
    line("Carte VTC", checks.vtc_card_expires_on),
    line("Assurance", checks.insurance_expires_on),
    line("Carte grise", checks.vehicle_registration_expires_on),
    line("Permis de conduire", checks.driving_license_expires_on),
  ];
}

/** « Position absente pendant la course · Clôturée par l'organisation » */
export function suspectLabels(reasons: readonly string[]): string[] {
  return reasons.map((r) => NETWORK_SUSPECT_REASON_META[r as keyof typeof NETWORK_SUSPECT_REASON_META]?.label ?? r);
}

/** Lectures des coordonnées du client par le chauffeur partenaire (enregistrées pour A). */
export function clientReadsText(reads: { reads: number; first_read_at: string | null; last_read_at: string | null }, timeZone: string): string {
  if (!reads.reads) return "Coordonnées du client pas encore consultées par le chauffeur.";
  const times = [reads.first_read_at ? `première à ${formatTime(reads.first_read_at, timeZone)}` : null, reads.last_read_at && reads.reads > 1 ? `dernière à ${formatTime(reads.last_read_at, timeZone)}` : null]
    .filter(Boolean)
    .join(", ");
  return `Coordonnées du client consultées ${reads.reads} fois par le chauffeur${times ? ` (${times})` : ""}.`;
}

/** Ligne de course minimale (fiche) pour reconstruire l'élément « Courses confiées » des actions d'argent. */
export type GivenRideFields = NetworkGivenItem["ride"];

/** Élément « Courses confiées » de la course (actions Reçu, Versé, Valider… réutilisées), null sans exécution. */
export function givenItemOf(ride: GivenRideFields, data: OrgNetworkRide): NetworkGivenItem | null {
  if (!data.execution) return null;
  const { checks: _c, driver_phone: _p, driver_phone_until: _u, client_data: _d, ...execution } = data.execution;
  return { ride, execution, settlement: data.settlement };
}

export type RideNetworkActions = GivenRowActions & {
  /** « Retirer » : la course est retirée au partenaire, la recherche repart (vos chauffeurs d'abord) */
  remove: boolean;
  /** « Clôturer la course » : partenaire empêché de la terminer (owner / admin) */
  close: boolean;
};

/**
 * Actions de la fiche : celles de l'argent suivent « Courses confiées » (givenRowActions) ; la base, qui connaît le
 * rôle, les délais et l'état réel, a le dernier mot (data.can) pour Retirer, Clôturer, Valider, Contester et les
 * exclusions. Sans exécution : Retirer / Clôturer seulement.
 */
export function rideNetworkActions(item: NetworkGivenItem | null, data: OrgNetworkRide, opts: { canManage: boolean; now: number }): RideNetworkActions {
  const can = data.can ?? { remove: false, close: false, validate: false, contest: false, exclude_driver: false, exclude_partner: false };
  const none: GivenRowActions = {
    confirm: false, dispute: false, waive: false, payout: false, validate: false, contest: false, reopen: false, remind: false,
    excludeDriver: false, excludePartner: false,
  };
  const money = item ? givenRowActions(item, { canManage: opts.canManage, now: opts.now, partnerExcluded: !can.exclude_partner }) : none;
  return {
    ...money,
    validate: opts.canManage && can.validate,
    contest: opts.canManage && can.contest,
    excludeDriver: opts.canManage && can.exclude_driver,
    excludePartner: opts.canManage && can.exclude_partner,
    remove: !!can.remove,
    close: opts.canManage && !!can.close,
  };
}

// -----------------------------------------------------------------------------------------------------------------
// En direct (command center)
// -----------------------------------------------------------------------------------------------------------------

/** Course d'En direct : instantané (driver_org_id) ou diffusion (network: true, chauffeur masqué). */
export type LiveNetworkRide = NetworkRideColumns & { network?: boolean };

/** Course tenue (ou faite) par un chauffeur partenaire, vue par A, et l'organisation de ce chauffeur si connue. */
export function livePartner(ride: LiveNetworkRide, orgId: string | null | undefined): { held: boolean; orgId: string | null } {
  const other = ride.driver_org_id && orgId && ride.driver_org_id !== orgId ? ride.driver_org_id : null;
  if (ride.network === true) return { held: true, orgId: other };
  return other && ride.driver_id ? { held: true, orgId: other } : { held: false, orgId: null };
}

/** Étiquette de la ligne de course : « Réseau · Flotte B », « proposée au réseau partagé », sinon null. */
export function liveNetworkLabel(ride: LiveNetworkRide, orgId: string | null | undefined, partners: Record<string, string> | null | undefined): string | null {
  const p = livePartner(ride, orgId);
  if (p.held) return partnerTag(p.orgId ? partners?.[p.orgId] : null);
  return proposedToNetwork(ride) ? "proposée au réseau partagé" : null;
}

/** Verrouillage des montants dans le panneau (même règle que la fiche, prédicat d'En direct). */
export function liveNetworkLock(ride: LiveNetworkRide, orgId: string | null | undefined): string | null {
  if (!livePartner(ride, orgId).held) return null;
  if (ride.status === "COMPLETED") return NETWORK_DONE_LOCK_MESSAGE;
  if (ride.status === "CANCELLED" || ride.status === "NO_DRIVER_FOUND") return null;
  return NETWORK_LOCK_MESSAGE;
}

// -----------------------------------------------------------------------------------------------------------------
// Liste des courses
// -----------------------------------------------------------------------------------------------------------------

/** Filtre « Réseau partagé » de la liste des courses (présent seulement quand la plateforme a ouvert le réseau). */
export const NETWORK_RIDES_FILTER = { key: "reseau", label: "Réseau partagé" } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Condition PostgREST (or) du filtre : proposée au réseau (network_at posé) OU tenue / faite par le chauffeur d'une
 * autre organisation (driver_org_id ≠ la sienne ; NULL exclu par la comparaison). null si l'identifiant est invalide.
 */
export function networkRidesOrFilter(orgId: string): string | null {
  return UUID.test(orgId) ? `network_at.not.is.null,driver_org_id.neq.${orgId}` : null;
}

/**
 * Colonne « Chauffeur » de la liste (colonne étroite, deux lignes) : organisation du chauffeur partenaire + « Réseau
 * partagé », « Proposée au réseau » pendant la recherche, sinon null (course propre : cellule habituelle).
 */
export function rideListNetworkCell(
  ride: NetworkRideColumns,
  orgId: string,
  partners: Record<string, string> | null | undefined,
): { title: string; sub: string | null } | null {
  const other = partnerOrgOf(ride, orgId);
  if (other) return { title: partners?.[other] || "Chauffeur partenaire", sub: "Réseau partagé" };
  return proposedToNetwork(ride) ? { title: "Proposée au réseau", sub: null } : null;
}
