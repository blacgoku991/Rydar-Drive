// Planning : courses attribuées affichées dans « Mes courses ». Module sans dépendance native (planning.test.ts).
import type { Ride } from "@rydar/shared";

type RideKind = Pick<Ride, "id" | "type" | "status" | "driver_id">;

/**
 * « Mes courses » : les courses du chauffeur, planifiées (à venir ou en cours) ET instantanées attribuées pas encore
 * démarrées. Une instantanée attribuée pendant une course (enchaînement : private.release_driver_ride, migration
 * 20260924004500) n'était visible nulle part avant la fin de la course en cours.
 * Filtre sur le chauffeur : un gérant qui roule aussi lit toutes les courses de sa centrale (RLS rides_select).
 */
export function myRides<R extends RideKind>(rides: R[], driverId: string): R[] {
  return rides.filter((r) => r.driver_id === driverId && (r.type === "scheduled" || r.status === "ACCEPTED"));
}

/** Instantanée qui attend la fin de la course en cours (le serveur refuse de la démarrer avant : DRIVER_BUSY). */
export function waitsForCurrentRide(ride: RideKind, currentRideId: string | null | undefined): boolean {
  return ride.type === "instant" && ride.status === "ACCEPTED" && currentRideId != null && currentRideId !== ride.id;
}
