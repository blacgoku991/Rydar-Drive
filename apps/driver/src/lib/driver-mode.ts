// Flotte Privée et fiche du gérant vues par l'app (docs/FLOTTE-PRIVEE.md § 10.2 et 10.4) : module pur, sans dépendance
// native (driver-mode.test.ts). Clé absente (serveur antérieur à 20260924007600) : organisation standard.
import type { DispatchModel, DriverAccountState, DriverHome } from "@rydar/shared";

export type DriverMode = {
  /** Organisation Flotte Privée : agenda, réservations « à confirmer », ni messagerie, ni commissions, ni réseau */
  privateFleet: boolean;
  /** Fiche du gérant (même compte que le propriétaire), gardée après une bascule : le prix, jamais « votre part » */
  ownerDriver: boolean;
};

/**
 * Flotte Privée : lue sur l'accueil (driver_home, relu à chaque rafraîchissement, dont « driver.updated » diffusé par la
 * bascule), sinon sur l'état du compte (driver_account_state, relu toutes les minutes ; seul lisible pour un compte en
 * attente, suspendu ou dont la fiche est inactive). L'accueil prime : à la sortie de la Flotte Privée, il est relu tout
 * de suite, l'état du compte jusqu'à une minute plus tard.
 */
export function driverMode(
  home: { organization: Pick<DriverHome["organization"], "private_fleet">; driver: Pick<DriverHome["driver"], "owner_driver"> } | null | undefined,
  account: { organization?: Pick<NonNullable<DriverAccountState["organization"]>, "private_fleet"> } | null | undefined,
): DriverMode {
  return {
    privateFleet: home ? home.organization.private_fleet === true : account?.organization?.private_fleet === true,
    ownerDriver: home?.driver.owner_driver === true,
  };
}

/**
 * Modèle qui décide de l'argent affiché (gains du jour, commissions, part de la course) : la fiche du gérant ne se doit
 * jamais de commission (aucun règlement, 20260924007700) et voit ses courses comme en flotte — le prix, jamais « votre
 * part » ; les courses partenaires (réseau partagé) gardent leur propre affichage.
 */
export function moneyModel(model: DispatchModel | null | undefined, ownerDriver: boolean): DispatchModel | null | undefined {
  return ownerDriver ? "fleet" : model;
}

/** Argent de l'écran « Mes gains » (driver_earnings). */
export type EarningsMoney = {
  /** Mode centrale : « votre part », commission de la centrale et statut des règlements */
  centrale: boolean;
  /** « Net estimé — Après commission de X % » (flotte avec un taux de commission chauffeur) ; null : rien */
  commissionPercent: number | null;
  /** « net … » sous chacune de ses courses (net_cents renvoyé par le serveur) */
  rideNet: boolean;
};

/**
 * driver_earnings renvoie le taux de commission chauffeur de l'organisation et un net par course dès que ce taux est
 * posé ou que l'organisation est une centrale. La fiche du gérant n'en doit aucun (aucun règlement, 20260924007700),
 * même si un taux reste posé ou après une bascule en centrale : ni « votre part », ni commission, ni net — le prix. Ses
 * courses partenaires (réseau partagé) gardent leur part, affichée à part (earningsPartner).
 */
export function earningsMoney(
  e: { model?: DispatchModel | null; commission_percent?: number | null } | null | undefined,
  ownerDriver: boolean,
): EarningsMoney {
  return {
    centrale: moneyModel(e?.model, ownerDriver) === "centrale",
    commissionPercent: ownerDriver ? null : e?.commission_percent ?? null,
    rideNet: !ownerDriver,
  };
}

/**
 * Notification « ride_unconfirmed » (réservation non confirmée, ou à vérifier : véhicule incompatible) : réservation à
 * mettre en avant dans le bloc « À traiter » de l'agenda. Jamais de ride_id dans ces données (l'app 1.1.0 ouvrirait
 * une course qui n'est pas la sienne) : booking_id seulement.
 */
export function unconfirmedBookingId(data: Record<string, unknown>): string | null {
  if (data.type !== "ride_unconfirmed") return null;
  const id = data.booking_id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}
