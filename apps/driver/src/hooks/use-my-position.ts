import * as Location from "expo-location";
import { useEffect, useState } from "react";

export type MyPosition = { lat: number; lng: number; heading: number | null; speed: number | null };

/** Position du chauffeur au premier plan (affichage carte). */
export function useMyPosition(active = true) {
  const [pos, setPos] = useState<MyPosition | null>(null);
  useEffect(() => {
    if (!active) return;
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    (async () => {
      const perm = await Location.requestForegroundPermissionsAsync().catch(() => null);
      if (!perm || perm.status !== "granted" || cancelled) return;
      const first = await Location.getLastKnownPositionAsync().catch(() => null) ?? await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null);
      if (first && !cancelled) setPos({ lat: first.coords.latitude, lng: first.coords.longitude, heading: first.coords.heading ?? null, speed: first.coords.speed ?? null });
      sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.High, distanceInterval: 10 }, (l) =>
        setPos({ lat: l.coords.latitude, lng: l.coords.longitude, heading: l.coords.heading != null && l.coords.heading >= 0 ? l.coords.heading : null, speed: l.coords.speed ?? null }),
      ).catch(() => null);
    })();
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [active]);
  return pos;
}
