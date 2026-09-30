// Planning : courses attribuées affichées dans « Mes courses ». Module sans dépendance native (planning.test.ts).
import { UNSTARTED_RIDE_EXPIRY_HOURS, formatRideDate, type Ride } from "@rydar/shared";

type RideKind = Pick<Ride, "id" | "type" | "status" | "driver_id">;

/**
 * « Mes courses » : les courses du chauffeur, planifiées (à venir ou en cours) ET instantanées attribuées pas encore
 * démarrées. Une instantanée attribuée pendant une course (enchaînement : private.release_driver_ride, migration
 * 20260924004500) n'était visible nulle part avant la fin de la course en cours.
 * Filtre sur le chauffeur : un gérant qui roule aussi lit toutes les courses de sa centrale (RLS rides_select) — déjà
 * appliqué par la requête (api.upcoming, avant sa limite), gardé ici.
 */
export function myRides<R extends RideKind>(rides: R[], driverId: string): R[] {
  return rides.filter((r) => r.driver_id === driverId && (r.type === "scheduled" || r.status === "ACCEPTED"));
}

/** Instantanée qui attend la fin de la course en cours (le serveur refuse de la démarrer avant : DRIVER_BUSY). */
export function waitsForCurrentRide(ride: RideKind, currentRideId: string | null | undefined): boolean {
  return ride.type === "instant" && ride.status === "ACCEPTED" && currentRideId != null && currentRideId !== ride.id;
}

/** Planifiée en retard : heure de clôture automatique, et si elle est déjà passée (clôture imminente). */
export type Overdue = { expiresAt: Date; expired: boolean };

/**
 * Planifiée acceptée dont l'heure de prise en charge est passée sans démarrage : en retard. Encore démarrable (chauffeur
 * en retard) jusqu'à sa clôture par le serveur (annulée, « Non effectuée »), UNSTARTED_RIDE_EXPIRY_HOURS après l'heure
 * prévue (migration 20260924005900). null : à venir, démarrée, instantanée ou close.
 */
export function overdue(r: Pick<Ride, "type" | "status" | "pickup_at">, now = Date.now()): Overdue | null {
  if (r.type !== "scheduled" || r.status !== "ACCEPTED") return null;
  const at = new Date(r.pickup_at).getTime();
  if (!Number.isFinite(at) || at > now) return null;
  const expiresAt = new Date(at + UNSTARTED_RIDE_EXPIRY_HOURS * 3_600_000);
  return { expiresAt, expired: expiresAt.getTime() <= now };
}

/** « Sans démarrage, clôture automatique aujourd'hui 12:30. » (heure du fuseau de la centrale) */
export function overdueHint(o: Overdue, tz?: string, now = new Date()): string {
  if (o.expired) return "Course non démarrée\u00A0: clôture automatique en cours.";
  const when = formatRideDate(o.expiresAt, tz, now);
  return `Sans démarrage, clôture automatique ${when.charAt(0).toLowerCase()}${when.slice(1)}.`;
}
