// Cible de l'étape en cours d'une course (prise en charge, puis destination) et liens vers Waze / Maps / Plans.
// Module sans dépendance native (testé sous Node : ride-target.test.ts).
import type { Ride } from "@rydar/shared";

export type NavApp = "waze" | "google" | "apple";

/** Coordonnées absentes : destination enregistrée sans géocodage (adresse seule). */
export type RideTarget = { lat: number | null; lng: number | null; label: string };

type RidePlaces = Pick<Ride, "pickup_lat" | "pickup_lng" | "pickup_address" | "dropoff_lat" | "dropoff_lng" | "dropoff_address">;

/**
 * Jusqu'au client : la prise en charge ; client à bord : la destination — jamais la prise en charge à sa place quand
 * la destination n'a pas de coordonnées (adresse seule : pas de guidage intégré, lien par adresse).
 */
export function rideTarget(ride: RidePlaces, toPickup: boolean): RideTarget {
  if (toPickup) return { lat: ride.pickup_lat, lng: ride.pickup_lng, label: ride.pickup_address };
  const located = ride.dropoff_lat != null && ride.dropoff_lng != null;
  return { lat: located ? ride.dropoff_lat : null, lng: located ? ride.dropoff_lng : null, label: ride.dropoff_address };
}

/** Itinéraire dans l'application de navigation : par coordonnées, sinon par adresse. */
export function navUrl(app: NavApp, t: RideTarget): string {
  const q = encodeURIComponent(t.label);
  if (t.lat == null || t.lng == null) {
    if (app === "waze") return `https://waze.com/ul?q=${q}&navigate=yes`;
    if (app === "google") return `https://www.google.com/maps/dir/?api=1&destination=${q}&travelmode=driving`;
    return `http://maps.apple.com/?daddr=${q}`;
  }
  if (app === "waze") return `https://waze.com/ul?ll=${t.lat},${t.lng}&navigate=yes`;
  if (app === "google") return `https://www.google.com/maps/dir/?api=1&destination=${t.lat},${t.lng}&travelmode=driving`;
  return `http://maps.apple.com/?daddr=${t.lat},${t.lng}&q=${q}`;
}
