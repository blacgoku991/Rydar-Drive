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
let lastAccuracy: number | null = null;
let intervalS = 10;

/**
 * État du suivi dans CE processus : « on » après startTracking, « off » après stopTracking (hors ligne) ;
 * « unknown » au lancement — relance sans interface par le système (tâche GPS, réveil silencieux) : le
 * chauffeur était en ligne, le suivi continue. Hors ligne, plus aucune position ne part.
 */
let trackingState: "unknown" | "on" | "off" = "unknown";
/** Change à chaque démarrage / arrêt : une réponse d'une session précédente n'a plus d'effet. */
let trackingSession = 0;
/** Mode course (précision maximale) : conservé pour toute relance du suivi. */
let rideMode = false;

/** Jamais de position ancienne : un point de plus de 2 min n'est pas envoyé (le serveur le croirait frais). */
const MAX_POINT_AGE_MS = 120_000;
/** Battement : au moins une position fraîche par minute, même téléphone immobile. */
const HEARTBEAT_MS = 55_000;

function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export async function pushLocation(loc: Location.LocationObject, force = false) {
  if (trackingState === "off") return;
  if (Date.now() - loc.timestamp > MAX_POINT_AGE_MS) return;
  const point = { lat: loc.coords.latitude, lng: loc.coords.longitude };
  const accuracy = loc.coords.accuracy ?? null;
  const elapsed = (Date.now() - lastSent) / 1000;
  const moved = lastPoint ? metersBetween(lastPoint, point) : Infinity;
  if (!force && elapsed < intervalS && moved < 60) return;
  // Point bien moins précis que le dernier envoyé, peu après : on garde le bon (Wi-Fi / antenne en ville)
  if (!force && accuracy != null && lastAccuracy != null && accuracy > Math.max(100, lastAccuracy * 3) && elapsed < 30) return;
  const { data } = await supabase.auth.getSession();
  if (!data.session) return;
  const session = trackingSession;
  lastSent = Date.now();
  lastPoint = point;
  lastAccuracy = accuracy;
  const battery = await Battery.getBatteryLevelAsync().catch(() => null);
  try {
    const res = await api.location({
      lat: point.lat,
      lng: point.lng,
      heading: loc.coords.heading != null && loc.coords.heading >= 0 ? loc.coords.heading : null,
      speed: loc.coords.speed != null && loc.coords.speed >= 0 ? loc.coords.speed : null,
      accuracy,
      battery: battery != null && battery >= 0 ? battery : null,
      recordedAt: new Date(loc.timestamp).toISOString(),
    });
    intervalS = Math.max(4, Math.min(120, res.next_interval_s ?? 10));
    // Passé hors ligne ailleurs (autre appareil, centrale) : le suivi s'arrête ici aussi
    if (res.presence === "offline" && session === trackingSession) void stopTracking();
  } catch {
    lastSent = 0; // réessai au prochain point
  }
}

const isWeb = Platform.OS === "web";
let foregroundWatch: Location.LocationSubscription | null = null;

/** Position fraîche demandée au système, bornée dans le temps (null : pas de point, rien n'est envoyé). */
async function freshFix(accuracy: Location.Accuracy, timeoutMs: number): Promise<Location.LocationObject | null> {
  return Promise.race([
    Location.getCurrentPositionAsync({ accuracy }).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

/**
 * Battement par minuterie : utile sur iPhone (les minuteries JS tournent en arrière-plan tant que la session de
 * localisation garde l'app en vie) et au premier plan. Sur Android les minuteries JS sont suspendues en
 * arrière-plan : le battement y part de la tâche GPS (voir plus bas), le service de premier plan livrant un
 * point toutes les 5 s. Toujours une position FRAÎCHE, jamais la dernière connue.
 */
let heartbeat: ReturnType<typeof setInterval> | null = null;

async function beat() {
  if (trackingState === "off") return stopHeartbeat();
  if (Date.now() - lastSent < HEARTBEAT_MS) return;
  const fresh = await freshFix(Location.Accuracy.High, 15_000);
  if (fresh) await pushLocation(fresh, true);
}

function startHeartbeat() {
  if (heartbeat || isWeb || trackingState === "off") return;
  heartbeat = setInterval(() => void beat(), HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

// Tâche d'arrière-plan : définie au chargement du module, importé en tête de index.ts
// (avant le routeur) pour exister aussi lors d'une relance sans interface.
if (!isWeb) {
  TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
    if (error || trackingState === "off") return;
    const { locations } = (data ?? {}) as { locations?: Location.LocationObject[] };
    const last = locations?.[locations.length - 1];
    if (!last) return;
    // Relance sans interface (système) : le chauffeur est toujours en ligne, le suivi continue
    if (trackingState === "unknown") trackingState = "on";
    startHeartbeat();
    // Battement porté par le flux GPS : au moins une position par minute, même immobile
    await pushLocation(last, Date.now() - lastSent >= HEARTBEAT_MS);
  });
}

/**
 * Options de la tâche : flux CONTINU. Précision maximale (en ligne comme en course), aucun filtre de distance,
 * jamais de pause automatique (la valeur native par défaut est « pause »), pas de regroupement des points
 * (deferredUpdatesInterval 0 : un lot bloqué ne part plus si iOS cesse de livrer). Android : service de
 * premier plan « EN LIGNE » qui livre un point toutes les 5 s (3 s en course).
 */
function taskOptions(ride: boolean): Location.LocationTaskOptions {
  return {
    accuracy: ride ? Location.Accuracy.BestForNavigation : Location.Accuracy.Highest,
    timeInterval: ride ? 3000 : 5000,
    distanceInterval: 0,
    deferredUpdatesInterval: 0,
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

/** État actuel, sans rien demander (redémarrage de l'app alors que le chauffeur est déjà en ligne). */
export async function locationPermissionState(): Promise<"ok" | "coarse" | "denied"> {
  const fg = await Location.getForegroundPermissionsAsync().catch(() => null);
  if (!fg || fg.status !== "granted") return "denied";
  if (fg.android?.accuracy === "coarse" || fg.ios?.accuracy === "reduced") return "coarse";
  return "ok";
}

/** Position « Toujours » (iOS) / « Toujours autoriser » (Android) accordée. */
export async function backgroundLocationGranted() {
  const bg = await Location.getBackgroundPermissionsAsync().catch(() => null);
  return bg?.status === "granted";
}

/** Premier point GPS précis, borné dans le temps ; repli sur un point réseau/Wi-Fi. Jamais attendu par l'interface. */
async function firstFix(): Promise<Location.LocationObject | null> {
  const high = await Promise.race([
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest }).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000)),
  ]);
  return high ?? Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null);
}

/** « Toujours » demandé une fois par lancement : iOS fait patienter 1,5 s quand la fenêtre n'est plus proposée. */
let backgroundAsked = false;

/**
 * Autorisations avant de passer EN LIGNE. Position exacte obligatoire ; « Toujours » demandé (une fenêtre par
 * lancement) : sur iPhone il est exigé pour passer en ligne (driver-context), seul moyen pour que le système
 * relance l'app et son GPS s'il l'a fermée. Android : le service de premier plan suffit, « Toujours » aide.
 * Lecture d'abord (instantanée, sans fenêtre) : la demande n'a lieu que si l'autorisation manque.
 */
export async function requestLocationPermissions(): Promise<PermissionState> {
  let fg = await Location.getForegroundPermissionsAsync().catch(() => null);
  if (fg?.status !== "granted") fg = await Location.requestForegroundPermissionsAsync().catch(() => null);
  if (!fg || fg.status !== "granted") return "denied";
  // Position approximative (Android) / « Position exacte » désactivée (iOS) : inexploitable pour le dispatch
  if (fg.android?.accuracy === "coarse" || fg.ios?.accuracy === "reduced") return "coarse";
  if (isWeb) return "foreground-only";
  const bgNow = await Location.getBackgroundPermissionsAsync().catch(() => null);
  if (bgNow?.status === "granted") return "granted";
  if (backgroundAsked) return "foreground-only";
  backgroundAsked = true;
  const bg = await Location.requestBackgroundPermissionsAsync().catch(() => ({ status: "denied" as const }));
  return bg.status === "granted" ? "granted" : "foreground-only";
}

async function startForegroundWatch() {
  foregroundWatch?.remove();
  foregroundWatch = await Location.watchPositionAsync({ accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 10 }, (l) => void pushLocation(l));
}

export type TrackingResult = {
  /** Précision (m) du premier point précis, quand il arrive (null si aucun point) — jamais attendu par l'interface. */
  firstAccuracy: Promise<number | null>;
  /** false : suivi limité à l'application au premier plan (tâche indisponible). */
  background: boolean;
};

/**
 * Démarre le partage de position — à appeler une fois le chauffeur EN LIGNE côté serveur (le premier
 * point forcé reçoit alors l'intervalle « disponible »). Rend la main tout de suite : un point récent en
 * cache part immédiatement, la tâche de fond livre les suivants et le point précis est cherché en parallèle.
 * La tâche est (ré)enregistrée à chaque appel : c'est aussi la relance d'un suivi qui ne livre plus rien.
 */
export async function startTracking(): Promise<TrackingResult> {
  const fg = await Location.getForegroundPermissionsAsync().catch(() => null);
  if (fg?.status !== "granted") throw new Error("Autorisez la localisation pour passer en ligne.");
  trackingState = "on";
  trackingSession++;
  const cached = await Location.getLastKnownPositionAsync({ maxAge: 30_000, requiredAccuracy: 100 }).catch(() => null);
  if (cached) void pushLocation(cached, true);
  const firstAccuracy = firstFix().then(async (p) => {
    if (!p) return null;
    await pushLocation(p, true);
    return p.coords.accuracy ?? null;
  });
  if (isWeb) {
    // Navigateur : suivi au premier plan uniquement
    await startForegroundWatch().catch(() => null);
    return { firstAccuracy, background: false };
  }
  try {
    await Location.startLocationUpdatesAsync(LOCATION_TASK, taskOptions(rideMode));
    foregroundWatch?.remove();
    foregroundWatch = null;
    startHeartbeat();
    return { firstAccuracy, background: true };
  } catch (e) {
    // Tâche refusée (services de localisation, configuration native) : repli premier plan
    try {
      await startForegroundWatch();
    } catch {
      throw e;
    }
    return { firstAccuracy, background: false };
  }
}

export async function stopTracking() {
  trackingState = "off";
  trackingSession++;
  stopHeartbeat();
  foregroundWatch?.remove();
  foregroundWatch = null;
  if (isWeb) return;
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
}

/**
 * Chauffeur EN LIGNE qui revient dans l'app (ou alerte « position non reçue ») : suivi relancé s'il est arrêté
 * OU s'il ne livre plus de position depuis 90 s (tâche enregistrée ne veut pas dire points reçus).
 */
export async function ensureTracking() {
  if (isWeb || trackingState === "off") return;
  const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => true);
  if (!started || Date.now() - lastSent > 90_000) {
    await startTracking().catch(() => null);
    return;
  }
  startHeartbeat();
}

/**
 * Réveil silencieux envoyé par le serveur (position non reçue depuis 90 s) — app en arrière-plan ou relancée
 * sans interface : tâche GPS réenregistrée si elle ne tourne plus (iPhone : exige « Toujours »), puis une
 * position fraîche est envoyée tout de suite. Rien si le chauffeur s'est mis hors ligne sur ce téléphone.
 */
export async function wakeTracking() {
  if (isWeb || trackingState === "off") return;
  const fg = await Location.getForegroundPermissionsAsync().catch(() => null);
  if (fg?.status !== "granted") return;
  if (trackingState === "unknown") trackingState = "on";
  const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
  if (!started || Date.now() - lastSent > 90_000) {
    await Location.startLocationUpdatesAsync(LOCATION_TASK, taskOptions(rideMode)).catch(() => null);
  }
  const fresh = await freshFix(Location.Accuracy.High, 20_000);
  if (fresh) await pushLocation(fresh, true);
}

/**
 * Mode course : précision élevée (arrivée au client, guidage). Relancer la tâche met simplement
 * ses options à jour (pas d'arrêt : un redémarrage depuis l'arrière-plan est refusé sur Android).
 */
export async function setHighAccuracy(enabled: boolean) {
  rideMode = enabled;
  if (isWeb) return;
  if (!(await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false))) return;
  await Location.startLocationUpdatesAsync(LOCATION_TASK, taskOptions(enabled));
}
