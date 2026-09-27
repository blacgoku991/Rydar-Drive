import * as Battery from "expo-battery";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Alert, AppState, Platform } from "react-native";
import { api, ApiError } from "./api";
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
 * « unknown » au lancement. Règle : app OUVERTE (premier plan, arrière-plan, téléphone verrouillé) = position en
 * direct ; app FERMÉE = hors ligne. Une relance par le système sans l'interface (app fermée) ne reprend donc pas
 * le suivi : il est arrêté, et le serveur passe le chauffeur hors ligne (private.watch_driver_gps, 3 min).
 */
let trackingState: "unknown" | "on" | "off" = "unknown";
/** Change à chaque démarrage / arrêt : une réponse d'une session précédente n'a plus d'effet. */
let trackingSession = 0;
/** Mode course (précision maximale) : conservé pour toute relance du suivi. */
let rideMode = false;
/** Mode réellement appliqué à la tâche (Android refuse de la réenregistrer depuis l'arrière-plan). */
let appliedRideMode = false;

/** Jamais de position ancienne : un point de plus de 2 min n'est pas envoyé (le serveur le croirait frais). */
const MAX_POINT_AGE_MS = 120_000;
/** Battement : une position fraîche dès 45 s sans envoi (≈ une par minute au pire), même téléphone immobile. */
const HEARTBEAT_MS = 45_000;
/** Contrôle du battement par minuterie (plus fréquent que HEARTBEAT_MS, sinon l'écart réel doublerait). */
const HEARTBEAT_TICK_MS = 15_000;

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
  // Stockage illisible (téléphone pas encore déverrouillé depuis le démarrage) : réessai au point suivant
  const auth = await supabase.auth.getSession().catch(() => null);
  if (!auth?.data.session) return;
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
  } catch (e) {
    // Compte suspendu / banni, centrale suspendue : le serveur refuse toute position, le suivi s'arrête
    if (e instanceof ApiError && e.code === "FORBIDDEN") {
      if (session === trackingSession) void stopTracking();
      return;
    }
    // Réseau : nouvel essai dans 5 s au plus tôt (pas à chaque point, jusqu'à un par seconde sur iPhone)
    lastSent = Date.now() - Math.max(0, intervalS - 5) * 1000;
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
let beating = false;

async function beat() {
  if (trackingState === "off") return stopHeartbeat();
  if (beating || Date.now() - lastSent < HEARTBEAT_MS) return;
  beating = true;
  try {
    const fresh = await freshFix(Location.Accuracy.High, 12_000);
    if (fresh) return await pushLocation(fresh, true);
    // Pas de point GPS (sous-sol, parking) : l'app est ouverte, signe de vie pour rester en ligne (sans position)
    const res = await api.heartbeat().catch((e: unknown) => (e instanceof ApiError && e.code === "FORBIDDEN" ? { presence: "offline" } : null));
    if (res?.presence === "offline") void stopTracking();
  } finally {
    beating = false;
  }
}

function startHeartbeat() {
  if (heartbeat || isWeb || trackingState === "off") return;
  heartbeat = setInterval(() => void beat(), HEARTBEAT_TICK_MS);
}

function stopHeartbeat() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

// Session perdue (déconnexion, jeton révoqué) : plus aucune position ne peut partir, le suivi s'arrête
if (!isWeb) {
  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT" && trackingState !== "off") void stopTracking();
  });
}

// Tâche d'arrière-plan : définie au chargement du module, importé en tête de index.ts
// (avant le routeur) pour exister aussi lors d'une relance sans interface.
if (!isWeb) {
  TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
    if (error || trackingState === "off") return;
    const { locations } = (data ?? {}) as { locations?: Location.LocationObject[] };
    const last = locations?.[locations.length - 1];
    if (!last) return;
    if (trackingState === "unknown") {
      // Processus relancé par le système sans l'interface : l'app a été fermée → pas de reprise du suivi
      // (au lancement normal, l'interface le redémarre elle-même si le chauffeur est encore en ligne)
      if (AppState.currentState !== "active") {
        void stopTracking();
        return;
      }
      trackingState = "on";
    }
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
      notificationBody: "Position partagée avec votre centrale. Fermer l'application vous met hors ligne.",
      notificationColor: "#C8F03C",
      // App fermée (balayée des récentes) = hors ligne : le service s'arrête avec elle
      killServiceOnDestroy: true,
    },
  };
}

/**
 * Résultat de la demande d'autorisation (passage EN LIGNE) :
 *  - « granted » / « foreground-only » (navigateur : premier plan seulement) : position exacte accordée ;
 *  - « coarse »    : position approximative (Android) ou « Position exacte » désactivée (iOS) ;
 *  - « denied »    : refusée, le système pourra redemander au prochain essai ;
 *  - « blocked »   : refusée DÉFINITIVEMENT (iOS après un refus, Android après deux) : seul le réglage du
 *                    téléphone peut la rétablir, aucune fenêtre ne s'ouvrira plus ;
 *  - « cancelled » : le chauffeur a refermé l'information préalable (rien n'a été demandé au système).
 */
export type PermissionState = "granted" | "foreground-only" | "coarse" | "denied" | "blocked" | "cancelled";

/** État actuel, sans rien demander (redémarrage de l'app alors que le chauffeur est déjà en ligne). */
export async function locationPermissionState(): Promise<"ok" | "coarse" | "denied"> {
  const fg = await Location.getForegroundPermissionsAsync().catch(() => null);
  if (!fg || fg.status !== "granted") return "denied";
  if (fg.android?.accuracy === "coarse" || fg.ios?.accuracy === "reduced") return "coarse";
  return "ok";
}

/**
 * Autorisation refusée définitivement (plus aucune fenêtre possible : réglages du téléphone seulement).
 * Lecture seule, instantanée ; toujours false dans le navigateur (aperçu web).
 */
export async function locationPermissionBlocked(): Promise<boolean> {
  if (isWeb) return false;
  const fg = await Location.getForegroundPermissionsAsync().catch(() => null);
  return !!fg && fg.status !== "granted" && fg.canAskAgain === false;
}

// Autorisation accordée : les écrans qui attendent la position (carte de l'accueil) reprennent aussitôt.
const grantedListeners = new Set<() => void>();

/** Abonnement à l'accord de l'autorisation de position (renvoie la fonction de désabonnement). */
export function onLocationPermissionGranted(listener: () => void) {
  grantedListeners.add(listener);
  return () => void grantedListeners.delete(listener);
}

function notifyGranted() {
  for (const listener of grantedListeners) {
    try {
      listener();
    } catch {
      /* un écran ne doit pas bloquer les autres */
    }
  }
}

/** Espace insécable (typographie française : avant « : ; ! ? », dans les guillemets). */
const NBSP = "\u00A0";

/**
 * Information préalable (règles App Store 5.1.1 / Google Play « divulgation visible ») : à quoi sert la position,
 * quand elle est collectée, comment l'arrêter. Affichée JUSTE AVANT la fenêtre du système, et seulement quand
 * celle-ci va vraiment s'ouvrir (jamais si l'autorisation est déjà accordée ou refusée définitivement).
 * Résout false si le chauffeur annule : rien n'est alors demandé au système.
 */
function confirmLocationDisclosure() {
  const indicator =
    Platform.OS === "android" ? `La notification «${NBSP}Rydar Drive — EN LIGNE${NBSP}»` : "L'indicateur de localisation";
  return new Promise<boolean>((resolve) =>
    Alert.alert(
      "Utilisation de votre position",
      `Rydar Drive collecte votre position quand vous êtes EN LIGNE, y compris application en arrière-plan ou écran éteint, pour vous proposer les courses proches et permettre à votre centrale de suivre vos courses. ${indicator} l'indique. Passer hors ligne ou fermer l'application arrête cette collecte${NBSP}; hors ligne, votre position n'est envoyée qu'avec un signalement que vous publiez.`,
      [
        { text: "Annuler", style: "cancel", onPress: () => resolve(false) },
        { text: "Continuer", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    ),
  );
}

/** Premier point GPS précis, borné dans le temps ; repli sur un point réseau/Wi-Fi. Jamais attendu par l'interface. */
async function firstFix(): Promise<Location.LocationObject | null> {
  const high = await Promise.race([
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest }).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000)),
  ]);
  return high ?? Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null);
}

/**
 * SEULE porte d'entrée de la demande d'autorisation de position (aucun autre code n'appelle
 * requestForegroundPermissionsAsync) : lecture d'abord (instantanée, sans fenêtre) ; si l'autorisation manque et
 * que le système peut encore la demander, information préalable PUIS fenêtre du système.
 * Position « Pendant l'utilisation », exacte. Elle suffit : le suivi, démarré app ouverte, continue en
 * arrière-plan et téléphone verrouillé (indicateur iOS, service de premier plan Android) ; fermer l'app met
 * hors ligne. « Toujours » (arrière-plan) n'est donc jamais demandé.
 */
export async function requestLocationPermissions(): Promise<PermissionState> {
  let fg = await Location.getForegroundPermissionsAsync().catch(() => null);
  if (fg?.status !== "granted") {
    // Refus définitif : aucune fenêtre ne s'ouvrirait, l'information préalable ne servirait à rien
    if (!isWeb && fg?.canAskAgain === false) return "blocked";
    if (!isWeb && !(await confirmLocationDisclosure())) return "cancelled";
    fg = await Location.requestForegroundPermissionsAsync().catch(() => null);
    if (fg?.status === "granted") notifyGranted();
  }
  if (!fg || fg.status !== "granted") return !isWeb && fg?.canAskAgain === false ? "blocked" : "denied";
  // Position approximative (Android) / « Position exacte » désactivée (iOS) : inexploitable pour le dispatch
  if (fg.android?.accuracy === "coarse" || fg.ios?.accuracy === "reduced") return "coarse";
  return isWeb ? "foreground-only" : "granted";
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
    appliedRideMode = rideMode;
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
  const session = ++trackingSession;
  stopHeartbeat();
  foregroundWatch?.remove();
  foregroundWatch = null;
  if (isWeb) return;
  const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
  // Suivi redémarré entre-temps (passage en ligne, lancement de l'app) : on ne l'arrête pas
  if (started && session === trackingSession) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
}

/**
 * Chauffeur EN LIGNE qui revient dans l'app : suivi relancé s'il est arrêté OU s'il ne livre plus de position
 * depuis 90 s (tâche enregistrée ne veut pas dire points reçus ; Android : service de premier plan recréé).
 * `ride` : présence de course (en route, sur place, client à bord) — suivi relancé même s'il a été arrêté dans ce
 * processus (passage hors ligne plus tôt) : jamais de course sans position. L'appelant a vérifié l'autorisation
 * (locationPermissionState), rien n'est demandé ici.
 */
export async function ensureTracking(ride = false) {
  if (isWeb) return;
  if (trackingState === "off") {
    if (ride) await startTracking();
    return;
  }
  const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => true);
  // (Android : un changement de mode course pendant l'arrière-plan n'a pas pu être appliqué → maintenant)
  if (!started || Date.now() - lastSent > 90_000 || appliedRideMode !== rideMode) {
    await startTracking();
    return;
  }
  startHeartbeat();
}

/**
 * Mode course : précision élevée (arrivée au client, guidage). Relancer la tâche met simplement
 * ses options à jour (pas d'arrêt : un redémarrage depuis l'arrière-plan est refusé sur Android).
 */
export async function setHighAccuracy(enabled: boolean) {
  rideMode = enabled;
  if (isWeb) return;
  // Android : service de premier plan non modifiable depuis l'arrière-plan — appliqué au retour (ensureTracking)
  if (Platform.OS === "android" && AppState.currentState !== "active") return;
  if (!(await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false))) return;
  await Location.startLocationUpdatesAsync(LOCATION_TASK, taskOptions(enabled));
  appliedRideMode = enabled;
}
