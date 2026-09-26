import * as Location from "expo-location";
import { useEffect, useSyncExternalStore } from "react";

export type MyPosition = {
  lat: number;
  lng: number;
  /** Cap en degrés (sens de la marche) ; null à l'arrêt ou inconnu */
  heading: number | null;
  speed: number | null;
  /** Précision horizontale en mètres (rayon), null si inconnue */
  accuracy: number | null;
  /** Horodatage du point (ms) */
  at: number;
};

// Un seul abonnement GPS pour toute l'application (accueil, offre, course, messagerie) : premier point
// instantané en changeant d'écran, une seule demande d'autorisation, moins de batterie.
let current: MyPosition | null = null;
const listeners = new Set<() => void>();
let users = 0;
let sub: Location.LocationSubscription | null = null;
let starting: Promise<void> | null = null;

/** Au-delà de cette vitesse (m/s), le cap GPS est fiable ; en dessous on garde le dernier cap. */
const HEADING_MIN_SPEED = 1.5;

function publish(next: MyPosition) {
  current = next;
  listeners.forEach((l) => l());
}

function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function accept(l: Location.LocationObject) {
  const c = l.coords;
  const accuracy = c.accuracy != null && c.accuracy > 0 ? c.accuracy : null;
  const point = { lat: c.latitude, lng: c.longitude };
  const prev = current;
  // Point nettement moins précis juste après un bon point (Wi-Fi / antenne en ville) : ignoré
  if (prev && accuracy != null && prev.accuracy != null && accuracy > Math.max(50, prev.accuracy * 2) && l.timestamp - prev.at < 15_000) return;
  const moving = c.speed != null && c.speed >= HEADING_MIN_SPEED;
  const heading = moving && c.heading != null && c.heading >= 0 ? c.heading : (prev?.heading ?? null);
  // Rendu limité : déplacement ≥ 3 m, précision nettement meilleure, ou cap qui tourne
  if (prev) {
    const moved = metersBetween(prev, point);
    const better = accuracy != null && prev.accuracy != null && accuracy < prev.accuracy * 0.7;
    const turned = heading != null && prev.heading != null && Math.abs(((heading - prev.heading + 540) % 360) - 180) >= 10;
    if (moved < 3 && !better && !turned) return;
  }
  publish({ ...point, heading, speed: c.speed != null && c.speed >= 0 ? c.speed : null, accuracy, at: l.timestamp || Date.now() });
}

async function start() {
  let perm = await Location.getForegroundPermissionsAsync().catch(() => null);
  if (perm?.status !== "granted") perm = await Location.requestForegroundPermissionsAsync().catch(() => null);
  if (perm?.status !== "granted" || users === 0) return;
  // Dernier point connu seulement s'il est récent et précis (le cache iOS peut dater et être à ±100 m)
  const cached = await Location.getLastKnownPositionAsync({ maxAge: 60_000, requiredAccuracy: 100 }).catch(() => null);
  if (cached && !current) accept(cached);
  if (users === 0) return;
  sub = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 3, timeInterval: 1000 },
    accept,
  ).catch(() => null);
  if (users === 0) {
    sub?.remove();
    sub = null;
  }
}

function acquire() {
  users += 1;
  if (!sub && !starting) starting = start().finally(() => (starting = null));
}

function release() {
  users = Math.max(0, users - 1);
  if (users === 0) {
    sub?.remove();
    sub = null;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => current;

/** Dernière position connue (même source que la carte), sans abonnement. */
export function lastPosition(): MyPosition | null {
  return current;
}

/** Position du chauffeur au premier plan (carte, distances) — flux GPS partagé entre les écrans. */
export function useMyPosition(active = true) {
  useEffect(() => {
    if (!active) return;
    acquire();
    return release;
  }, [active]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
