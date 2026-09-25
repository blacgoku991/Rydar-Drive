import * as Battery from "expo-battery";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { api } from "./api";
import { supabase } from "./supabase";

export const LOCATION_TASK = "rydar-location";
/** Au-delà, le serveur ignore la position (dispatch par rayons de 4 km, 8 km…). */
export const MAX_ACCURACY_M = 1500;

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

const isWeb = Platform.OS === "web";
let foregroundWatch: Location.LocationSubscription | null = null;

// Tâche d'arrière-plan : définie au chargement du module, importé en tête de index.ts
// (avant le routeur) pour exister aussi lors d'une relance sans interface.
if (!isWeb) {
  TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
    if (error) return;
    const { locations } = (data ?? {}) as { locations?: Location.LocationObject[] };
    const last = locations?.[locations.length - 1];
    if (last) await pushLocation(last);
  });
}

/**
 * Options de la tâche. iOS n'a pas d'intervalle de temps (distance seulement) : précision élevée
 * pour garder un flux régulier même à l'arrêt ; Android garde Balanced + timeInterval.
 */
function taskOptions(ride: boolean): Location.LocationTaskOptions {
  return {
    // GPS précis dès qu'on est en ligne : une position à ±1,5 km est ignorée par le dispatch (4 km d'abord)
    accuracy: Location.Accuracy.High,
    timeInterval: ride ? 3000 : 5000,
    distanceInterval: 0,
    deferredUpdatesInterval: ride ? 0 : 5000,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.AutomotiveNavigation,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: ride ? "Rydar Drive — course en cours" : "Rydar Drive — EN LIGNE",
      notificationBody: "Votre position est partagée avec votre centrale.",
      notificationColor: "#C8F03C",
      killServiceOnDestroy: false,
    },
  };
}

export type PermissionState = "granted" | "foreground-only" | "coarse" | "denied";

/**
 * Autorisations avant de passer EN LIGNE. « Pendant l'utilisation » suffit (service de premier plan
 * Android, indicateur iOS) ; « Toujours » est demandé mais facultatif. Position exacte obligatoire.
 */
export async function requestLocationPermissions(): Promise<PermissionState> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== "granted") return "denied";
  // Position approximative (Android) / « Position exacte » désactivée (iOS) : inexploitable pour le dispatch
  if (fg.android?.accuracy === "coarse" || fg.ios?.accuracy === "reduced") return "coarse";
  if (isWeb) return "foreground-only";
  const bg = await Location.requestBackgroundPermissionsAsync().catch(() => ({ status: "denied" as const }));
  return bg.status === "granted" ? "granted" : "foreground-only";
}

async function startForegroundWatch() {
  foregroundWatch?.remove();
  foregroundWatch = await Location.watchPositionAsync({ accuracy: Location.Accuracy.High, distanceInterval: 20 }, (l) => void pushLocation(l));
}

export type TrackingResult = {
  /** Précision (m) du premier point, null si aucun point. */
  accuracyM: number | null;
  /** false : suivi limité à l'application au premier plan (tâche indisponible). */
  background: boolean;
};

/**
 * Démarre le partage de position — à appeler une fois le chauffeur EN LIGNE côté serveur :
 * le premier point (forcé) reçoit alors l'intervalle « disponible » et non celui « hors ligne ».
 */
export async function startTracking(): Promise<TrackingResult> {
  const fg = await Location.requestForegroundPermissionsAsync().catch(() => null);
  if (fg?.status !== "granted") throw new Error("Autorisez la localisation pour passer en ligne.");
  const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null);
  if (current) await pushLocation(current, true);
  const accuracyM = current?.coords.accuracy ?? null;
  if (isWeb) {
    // Navigateur : suivi au premier plan uniquement
    await startForegroundWatch().catch(() => null);
    return { accuracyM, background: false };
  }
  try {
    if (!(await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false))) {
      await Location.startLocationUpdatesAsync(LOCATION_TASK, taskOptions(false));
    }
    foregroundWatch?.remove();
    foregroundWatch = null;
    return { accuracyM, background: true };
  } catch (e) {
    // Tâche refusée (services de localisation, configuration native) : repli premier plan
    try {
      await startForegroundWatch();
    } catch {
      throw e;
    }
    return { accuracyM, background: false };
  }
}

export async function stopTracking() {
  foregroundWatch?.remove();
  foregroundWatch = null;
  if (isWeb) return;
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
}

/**
 * Mode course : précision élevée (arrivée au client, guidage). Relancer la tâche met simplement
 * ses options à jour (pas d'arrêt : un redémarrage depuis l'arrière-plan est refusé sur Android).
 */
export async function setHighAccuracy(enabled: boolean) {
  if (isWeb) return;
  if (!(await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false))) return;
  await Location.startLocationUpdatesAsync(LOCATION_TASK, taskOptions(enabled));
}
