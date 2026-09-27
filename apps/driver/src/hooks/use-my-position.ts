import * as Location from "expo-location";
import { useEffect, useSyncExternalStore } from "react";
import { AppState, Platform, type NativeEventSubscription } from "react-native";
import { onLocationPermissionGranted } from "@/lib/location";

/** Origine du cap : « course » (GPS, sens de la marche en roulant), « compass » (boussole du téléphone, à l'arrêt). */
export type HeadingSource = "course" | "compass";

export type MyPosition = {
  lat: number;
  lng: number;
  /**
   * Cap en degrés (0 = nord, sens horaire) : sens de la marche en roulant, boussole à l'arrêt (si elle est fiable,
   * relevée au dernier point GPS ; en continu : useStillHeading), sinon dernier cap connu ; null tant qu'aucun cap n'est connu.
   */
  heading: number | null;
  /** Origine du cap publié (null : aucun cap connu) */
  headingSource: HeadingSource | null;
  speed: number | null;
  /** Précision horizontale en mètres (rayon), null si inconnue */
  accuracy: number | null;
  /** Horodatage du point (ms) */
  at: number;
};

// Un seul abonnement GPS pour toute l'application (accueil, offre, course, messagerie) : premier point
// instantané en changeant d'écran, moins de batterie. Il ne DEMANDE jamais l'autorisation : la seule porte
// d'entrée est requestLocationPermissions() (lib/location.ts), qui affiche l'information préalable avant la
// fenêtre du système. Sans autorisation, la carte attend et le suivi repart dès qu'elle est accordée.
let current: MyPosition | null = null;
const listeners = new Set<() => void>();
let users = 0;
let sub: Location.LocationSubscription | null = null;
let starting: Promise<void> | null = null;
/** Démarrage redemandé pendant qu'un autre était en cours (autorisation accordée entre-temps) */
let restartWanted = false;

/** Au-delà de cette vitesse (m/s), le cap GPS est fiable ; en dessous : boussole, sinon dernier cap. */
const HEADING_MIN_SPEED = 1.5;

// --- Boussole (iOS / Android) : sens du véhicule à l'arrêt ------------------------------------------
// Même cycle de vie que le GPS (abonnée tant qu'un écran affiche la position, coupée en arrière-plan).
let compassSub: Location.LocationSubscription | null = null;
let compassStarting = false;
/** Flux boussole clos par une erreur (plus aucun cap) : à relancer */
let compassBroken = false;
/** Dernier cap boussole fiable (null : boussole absente, non calibrée ou coupée) */
let compass: number | null = null;
/** Dernier point GPS avec un cap de marche (ms) */
let courseAt = 0;
let compassPublishedAt = 0;
let compassTimer: ReturnType<typeof setTimeout> | null = null;
let appStateSub: NativeEventSubscription | null = null;
/**
 * Cap boussole affiché à l'arrêt, publié À PART de la position (useStillHeading) : seul le marqueur se redessine.
 * Publié dans la position, il redessinait tous les écrans abonnés jusqu'à 4 fois par seconde (messagerie comprise)
 * et le guidage le comptait comme un nouveau point GPS (sortie d'itinéraire, recalculs répétés à l'arrêt).
 * null : en marche (cap GPS), boussole coupée ou peu fiable.
 */
let still: number | null = null;
const stillListeners = new Set<() => void>();

function publishStill(h: number | null) {
  if (still === h) return;
  still = h;
  stillListeners.forEach((l) => l());
}

/**
 * Après le dernier cap de marche, la boussole attend ce délai avant de reprendre la main : sans nouveau point GPS
 * (arrêt), le cap de marche n'est plus rafraîchi, et la boussole suit le téléphone plutôt que la voiture.
 */
const COURSE_HOLD_MS = 4000;
/** Écart minimal (°) pour publier un nouveau cap boussole, et intervalle minimal (ms) : 4 rendus par seconde au plus. */
const COMPASS_MIN_DELTA = 5;
const COMPASS_MIN_INTERVAL_MS = 250;

const angleDelta = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/**
 * Calibration suffisante. expo-location renvoie la calibration sur l'échelle Android 0-3 sur les deux plateformes
 * (iOS : incertitude convertie, 3 < 20°, 2 < 35°) : 2 au moins. Valeur en degrés (> 3, anciennes versions iOS) :
 * incertitude de 45° au plus. Négative : inconnue.
 */
function compassReliable(accuracy: number) {
  if (!Number.isFinite(accuracy) || accuracy < 0) return false;
  return accuracy > 3 ? accuracy <= 45 : accuracy >= 2;
}

function compassHeading(h: Location.LocationHeadingObject): number | null {
  if (!compassReliable(h.accuracy)) return null;
  // Nord géographique (déclinaison connue grâce à la position), sinon nord magnétique
  const deg = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
  return Number.isFinite(deg) && deg >= 0 ? Math.round(deg) % 360 : null;
}

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
  const course = moving && c.heading != null && c.heading >= 0 ? c.heading : null;
  if (course != null) {
    courseAt = Date.now();
    // En marche : le cap GPS reprend la main sur la boussole
    publishStill(null);
  }
  // Cap : sens de la marche en roulant ; à l'arrêt, boussole fiable ; sinon dernier cap connu
  let heading: number | null = prev?.heading ?? null;
  let headingSource: HeadingSource | null = prev?.headingSource ?? null;
  if (course != null) {
    heading = course;
    headingSource = "course";
  } else if (compass != null && Date.now() - courseAt >= COURSE_HOLD_MS) {
    heading = compass;
    headingSource = "compass";
  }
  // Rendu limité : déplacement ≥ 3 m, précision nettement meilleure, ou cap qui tourne
  if (prev) {
    const moved = metersBetween(prev, point);
    const better = accuracy != null && prev.accuracy != null && accuracy < prev.accuracy * 0.7;
    const turned = heading != null && (prev.heading == null || angleDelta(heading, prev.heading) >= 10);
    if (moved < 3 && !better && !turned) return;
  }
  publish({ ...point, heading, headingSource, speed: c.speed != null && c.speed >= 0 ? c.speed : null, accuracy, at: l.timestamp || Date.now() });
}

/** Publie le dernier cap boussole à part (au plus 4 fois par seconde, écart de 5° au moins, jamais pendant la marche). */
function flushCompass() {
  compassTimer = null;
  const prev = current;
  if (compass == null || !prev || users === 0) return;
  // Encore en marche (ou arrêt tout récent) : le cap GPS prime ; nouvel essai à la fin du délai
  const hold = courseAt + COURSE_HOLD_MS - Date.now();
  if (hold > 0) {
    compassTimer = setTimeout(flushCompass, hold);
    return;
  }
  const shown = still ?? prev.heading;
  if (shown != null && angleDelta(compass, shown) < COMPASS_MIN_DELTA) return;
  compassPublishedAt = Date.now();
  publishStill(compass);
}

function onCompass(h: Location.LocationHeadingObject) {
  compass = compassHeading(h);
  // Boussole non fiable (perturbée, à calibrer) : le dernier cap publié reste affiché
  if (compass == null || compassTimer) return;
  const wait = COMPASS_MIN_INTERVAL_MS - (Date.now() - compassPublishedAt);
  if (wait <= 0) flushCompass();
  else compassTimer = setTimeout(flushCompass, wait);
}

async function startCompass() {
  if (Platform.OS === "web" || compassStarting || (compassSub && !compassBroken)) return;
  // Flux interrompu par une erreur : libéré puis relancé (au prochain écran ou au retour dans l'application)
  compassSub?.remove();
  compassSub = null;
  compassBroken = false;
  compassStarting = true;
  const s = await Location.watchHeadingAsync(onCompass, () => {
    // iOS : après une erreur (perturbation magnétique, autorisation retirée), expo-location clôt le flux pour de bon
    compass = null;
    compassBroken = true;
  }).catch(() => null);
  compassStarting = false;
  if (users === 0 || AppState.currentState === "background") s?.remove();
  else compassSub = s;
}

function stopCompass() {
  compassSub?.remove();
  compassSub = null;
  compass = null;
  if (compassTimer) clearTimeout(compassTimer);
  compassTimer = null;
  publishStill(null);
}

async function start() {
  // Lecture seule : aucune fenêtre du système ici (voir plus haut)
  const perm = await Location.getForegroundPermissionsAsync().catch(() => null);
  if (perm?.status !== "granted" || users === 0) return;
  void startCompass();
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

/** Démarre le suivi s'il est attendu et arrêté (un seul démarrage à la fois ; relancé s'il a été redemandé). */
function launch() {
  if (users === 0 || sub) return;
  if (starting) {
    restartWanted = true;
    return;
  }
  starting = start().finally(() => {
    starting = null;
    if (restartWanted) {
      restartWanted = false;
      launch();
    }
  });
}

// Autorisation accordée (passage en ligne) : la carte affichée reprend sans attendre un changement d'écran
onLocationPermissionGranted(launch);

function acquire() {
  users += 1;
  // Boussole coupée en arrière-plan (batterie), reprise au retour dans l'application. Au retour, le suivi
  // repart aussi s'il attendait l'autorisation (accordée entre-temps dans les réglages du téléphone).
  if (Platform.OS !== "web" && !appStateSub) {
    appStateSub = AppState.addEventListener("change", (state) => {
      if (state === "background") stopCompass();
      else if (state === "active" && users > 0) {
        if (sub) void startCompass();
        else launch();
      }
    });
  }
  if (sub) void startCompass();
  else launch();
}

function release() {
  users = Math.max(0, users - 1);
  if (users === 0) {
    sub?.remove();
    sub = null;
    stopCompass();
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

const subscribeStill = (listener: () => void) => {
  stillListeners.add(listener);
  return () => void stillListeners.delete(listener);
};
const noSubscribe = () => () => undefined;
const stillSnapshot = () => still;
const noStill = () => null;

/**
 * Sens du véhicule à l'arrêt donné par la boussole (null : en marche, boussole absente, coupée ou peu fiable).
 * Réservé au marqueur de la carte (enabled=false, ex. guidage : aucun abonnement, aucun rendu).
 */
export function useStillHeading(enabled = true): number | null {
  return useSyncExternalStore(enabled ? subscribeStill : noSubscribe, enabled ? stillSnapshot : noStill, enabled ? stillSnapshot : noStill);
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
