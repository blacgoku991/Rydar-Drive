import * as Battery from "expo-battery";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { api } from "./api";
import { supabase } from "./supabase";

export const LOCATION_TASK = "rydar-location";

// Envoi adaptatif : le serveur suggère l'intervalle (5 s en course / offre, 15 s disponible).
let lastSent = 0;
let lastPoint: { lat: number; lng: number } | null = null;
let intervalS = 10;

function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export async function pushLocation(loc: Location.LocationObject, force = false) {
  const point = { lat: loc.coords.latitude, lng: loc.coords.longitude };
  const elapsed = (Date.now() - lastSent) / 1000;
  const moved = lastPoint ? metersBetween(lastPoint, point) : Infinity;
  if (!force && elapsed < intervalS && moved < 60) return;
  const { data } = await supabase.auth.getSession();
  if (!data.session) return;
  lastSent = Date.now();
  lastPoint = point;
  const battery = await Battery.getBatteryLevelAsync().catch(() => null);
  try {
    const res = await api.location({
      lat: point.lat,
      lng: point.lng,
      heading: loc.coords.heading != null && loc.coords.heading >= 0 ? loc.coords.heading : null,
      speed: loc.coords.speed != null && loc.coords.speed >= 0 ? loc.coords.speed : null,
      accuracy: loc.coords.accuracy ?? null,
      battery: battery != null && battery >= 0 ? battery : null,
      recordedAt: new Date(loc.timestamp).toISOString(),
    });
    intervalS = Math.max(4, Math.min(120, res.next_interval_s ?? 10));
  } catch {
    lastSent = 0; // réessai au prochain point
  }
}

// Tâche d'arrière-plan : définie au chargement du module (import dans le layout racine).
TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const { locations } = (data ?? {}) as { locations?: Location.LocationObject[] };
  const last = locations?.[locations.length - 1];
  if (last) await pushLocation(last);
});

export type PermissionState = "granted" | "foreground-only" | "denied";

export async function requestLocationPermissions(): Promise<PermissionState> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== "granted") return "denied";
  const bg = await Location.requestBackgroundPermissionsAsync().catch(() => ({ status: "denied" as const }));
  return bg.status === "granted" ? "granted" : "foreground-only";
}

/** Démarre le partage de position (EN LIGNE). Économe : précision équilibrée, envoi adaptatif. */
export async function startTracking() {
  const perm = await requestLocationPermissions();
  if (perm === "denied") throw new Error("Autorisez la localisation pour passer en ligne.");
  const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null);
  if (current) await pushLocation(current, true);
  if (perm === "granted" && !(await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false))) {
    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: 5000,
      distanceInterval: 0,
      deferredUpdatesInterval: 5000,
      pausesUpdatesAutomatically: false,
      activityType: Location.ActivityType.AutomotiveNavigation,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: "Rydar Drive — EN LIGNE",
        notificationBody: "Votre position est partagée avec votre centrale.",
        notificationColor: "#C8F03C",
        killServiceOnDestroy: false,
      },
    });
  }
  return perm;
}

export async function stopTracking() {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
}

/** Mode course : précision élevée (arrivée au client, guidage). */
export async function setHighAccuracy(enabled: boolean) {
  if (!(await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false))) return;
  await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: enabled ? Location.Accuracy.High : Location.Accuracy.Balanced,
    timeInterval: enabled ? 3000 : 5000,
    distanceInterval: 0,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.AutomotiveNavigation,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: enabled ? "Rydar Drive — course en cours" : "Rydar Drive — EN LIGNE",
      notificationBody: "Votre position est partagée avec votre centrale.",
      notificationColor: "#C8F03C",
      killServiceOnDestroy: false,
    },
  });
}
