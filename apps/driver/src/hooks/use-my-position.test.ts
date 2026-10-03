// Position affichée sur la carte (use-my-position) : le flux GPS est relancé au retour dans l'app et quand il ne livre
// plus rien (iOS met en pause le suivi d'un téléphone immobile et ne le reprend jamais seul : le point restait figé
// dans la rue où la voiture était garée) ; précision dégradée publiée (cercle), points en cache anciens ignorés.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Fix = {
  coords: { latitude: number; longitude: number; accuracy: number | null; speed: number | null; heading: number | null };
  timestamp: number;
};
type Watch = {
  options: { distanceInterval?: number };
  onFix: (l: Fix) => void;
  onError?: (reason: string) => void;
  removed: boolean;
  remove: () => void;
};

const h = vi.hoisted(() => ({
  watches: [] as Watch[],
  appState: "active",
  appListeners: [] as ((s: string) => void)[],
  cleanups: [] as (() => void)[],
}));

// Hook appelé hors de React : l'effet s'exécute aussitôt (abonnement), son nettoyage est gardé pour la fin du test
vi.mock("react", () => ({
  useEffect: (fn: () => void | (() => void)) => {
    const cleanup = fn();
    if (typeof cleanup === "function") h.cleanups.push(cleanup);
  },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: {
    get currentState() {
      return h.appState;
    },
    addEventListener: (_type: string, listener: (s: string) => void) => {
      h.appListeners.push(listener);
      return { remove: () => undefined };
    },
  },
}));
vi.mock("expo-location", () => ({
  Accuracy: { BestForNavigation: 6 },
  getForegroundPermissionsAsync: async () => ({ status: "granted" }),
  getLastKnownPositionAsync: async () => null,
  watchHeadingAsync: async () => ({ remove: () => undefined }),
  watchPositionAsync: async (options: Watch["options"], onFix: Watch["onFix"], onError?: Watch["onError"]) => {
    const w: Watch = {
      options,
      onFix,
      onError,
      removed: false,
      remove: () => {
        w.removed = true;
      },
    };
    h.watches.push(w);
    return w;
  },
}));
vi.mock("@/lib/location", () => ({ onLocationPermissionGranted: () => () => undefined }));

const fix = (lat: number, lng: number, accuracy: number | null, at = Date.now()): Fix => ({
  coords: { latitude: lat, longitude: lng, accuracy, speed: 0, heading: -1 },
  timestamp: at,
});
/** Flux GPS en cours (non arrêtés) */
const live = () => h.watches.filter((w) => !w.removed);
const setAppState = async (state: string) => {
  h.appState = state;
  h.appListeners.forEach((l) => l(state));
  await vi.advanceTimersByTimeAsync(0);
};

// La rue où la voiture est garée, et la maison à ~150 m
const AVENUE = { lat: 48.9, lng: 2.29 };
const HOME = { lat: 48.9012, lng: 2.2885 };

/** Module neuf (état remis à zéro), un écran abonné (carte de l'accueil), flux démarré. */
async function setup() {
  vi.resetModules();
  h.watches.length = 0;
  h.appListeners.length = 0;
  h.appState = "active";
  const mod = await import("./use-my-position");
  mod.useMyPosition();
  await vi.advanceTimersByTimeAsync(0);
  return mod;
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-09-28T17:00:00Z") });
});

afterEach(() => {
  h.cleanups.splice(0).forEach((c) => c());
  vi.useRealTimers();
});

describe("flux GPS de la carte : jamais figé", () => {
  it("aucun filtre de distance : un téléphone immobile reçoit aussi ses points", async () => {
    await setup();
    expect(live()).toHaveLength(1);
    expect(live()[0].options.distanceInterval).toBe(0);
  });

  it("flux en pause (plus aucun point) au premier plan : relancé, le point rejoint la position réelle", async () => {
    const m = await setup();
    const first = live()[0];
    first.onFix(fix(AVENUE.lat, AVENUE.lng, 5));
    expect(m.lastPosition()).toMatchObject(AVENUE);

    await vi.advanceTimersByTimeAsync(m.WATCH_STALL_MS - 1000);
    expect(first.removed).toBe(false);
    // Contrôle toutes les 10 s : relance au plus tard 10 s après le délai
    await vi.advanceTimersByTimeAsync(11_000);
    expect(first.removed).toBe(true);
    expect(live()).toHaveLength(1);

    live()[0].onFix(fix(HOME.lat, HOME.lng, 12));
    expect(m.lastPosition()).toMatchObject(HOME);
  });

  it("des points réguliers, même immobile : jamais de relance", async () => {
    await setup();
    const w = live()[0];
    for (let i = 0; i < 120; i++) {
      w.onFix(fix(AVENUE.lat, AVENUE.lng, 5));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(h.watches).toHaveLength(1);
    expect(w.removed).toBe(false);
  });

  it("retour dans l'app après l'arrière-plan : nouveau flux aussitôt ; simple état « inactif » : rien", async () => {
    await setup();
    const w = live()[0];
    w.onFix(fix(AVENUE.lat, AVENUE.lng, 5));
    await setAppState("inactive");
    await setAppState("active");
    expect(h.watches).toHaveLength(1);

    await setAppState("background");
    await setAppState("active");
    expect(w.removed).toBe(true);
    expect(live()).toHaveLength(1);
    expect(h.watches).toHaveLength(2);
  });

  it("flux clos par une erreur : relancé", async () => {
    await setup();
    const w = live()[0];
    w.onFix(fix(AVENUE.lat, AVENUE.lng, 5));
    w.onError?.("kCLErrorDomain");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.removed).toBe(true);
    expect(live()).toHaveLength(1);
  });

  it("en arrière-plan : flux de l'interface coupé (plus aucun point publié aux écrans), aucune relance avant le retour", async () => {
    await setup();
    const w = live()[0];
    w.onFix(fix(AVENUE.lat, AVENUE.lng, 5));
    await setAppState("background");
    expect(w.removed).toBe(true);
    // Chien de garde : rien en arrière-plan (iOS refuserait un flux « pendant l'utilisation »)
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.watches).toHaveLength(1);
    expect(live()).toHaveLength(0);
    // Retour dans l'app : nouveau flux aussitôt
    await setAppState("active");
    expect(live()).toHaveLength(1);
    expect(h.watches).toHaveLength(2);
  });

  it("plus aucun écran abonné : flux et chien de garde arrêtés", async () => {
    await setup();
    const w = live()[0];
    h.cleanups.splice(0).forEach((c) => c());
    expect(w.removed).toBe(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.watches).toHaveLength(1);
  });
});

describe("points retenus", () => {
  it("précision dégradée sur place (entrée dans un bâtiment) : publiée après 15 s, jamais juste après un point précis", async () => {
    const m = await setup();
    const w = live()[0];
    w.onFix(fix(AVENUE.lat, AVENUE.lng, 5));

    // Point Wi-Fi à ±65 m, 5 s après un point précis : aberrant, ignoré
    await vi.advanceTimersByTimeAsync(5000);
    w.onFix(fix(AVENUE.lat + 0.00002, AVENUE.lng + 0.00002, 65));
    expect(m.lastPosition()?.accuracy).toBe(5);

    // Plus aucun point précis depuis 15 s : la précision dégradée est publiée, même sans déplacement (cercle)
    await vi.advanceTimersByTimeAsync(15_000);
    w.onFix(fix(AVENUE.lat + 0.00002, AVENUE.lng + 0.00002, 65));
    expect(m.lastPosition()?.accuracy).toBe(65);
  });

  it("petites variations de précision sur place : pas de nouveau rendu", async () => {
    const m = await setup();
    const w = live()[0];
    w.onFix(fix(AVENUE.lat, AVENUE.lng, 8));
    const shown = m.lastPosition();
    await vi.advanceTimersByTimeAsync(1000);
    w.onFix(fix(AVENUE.lat, AVENUE.lng, 11));
    await vi.advanceTimersByTimeAsync(1000);
    w.onFix(fix(AVENUE.lat, AVENUE.lng, 16));
    expect(m.lastPosition()).toBe(shown);
  });

  it("vieux point en cache livré à la relance : ignoré, le point affiché reste à la maison", async () => {
    const m = await setup();
    live()[0].onFix(fix(HOME.lat, HOME.lng, 10));
    await vi.advanceTimersByTimeAsync(1000);
    await setAppState("background");
    await setAppState("active");
    live()[0].onFix(fix(AVENUE.lat, AVENUE.lng, 5, Date.now() - 20 * 60_000));
    expect(m.lastPosition()).toMatchObject(HOME);
  });

  it("heure du téléphone reculée : un point frais passe toujours", async () => {
    const m = await setup();
    const w = live()[0];
    w.onFix(fix(AVENUE.lat, AVENUE.lng, 5));
    vi.setSystemTime(Date.now() - 3_600_000);
    w.onFix(fix(HOME.lat, HOME.lng, 8));
    expect(m.lastPosition()).toMatchObject(HOME);
  });
});
