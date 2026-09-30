import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_RECENTER_MS, DRAG_STALE_MS, EVAL_TIMEOUT_MS, MOVE_PX, MapGestures, SETTLE_MS, SPEED_FRESH_MS, TOUCH_STALE_MS, headingGap, isDriving,
  isNorthUp, nearCenter, normHeading, shouldAutoRecenter,
} from "./follow";

const size = { width: 440, height: 956 };

describe("nearCenter", () => {
  it("chauffeur au centre ou à peine décalé (zoom, rotation) : suivi conservé", () => {
    expect(nearCenter({ x: 220, y: 478 }, size)).toBe(true);
    expect(nearCenter({ x: 300, y: 540 }, size)).toBe(true);
  });

  it("carte glissée ailleurs (chauffeur loin du centre ou hors écran) : suivi arrêté", () => {
    expect(nearCenter({ x: 420, y: 478 }, size)).toBe(false);
    expect(nearCenter({ x: 220, y: 1400 }, size)).toBe(false);
    expect(nearCenter({ x: -80, y: 100 }, size)).toBe(false);
  });

  it("taille inconnue ou point invalide : suivi arrêté (jamais une carte qui bouge sous le doigt)", () => {
    expect(nearCenter({ x: 0, y: 0 }, { width: 0, height: 0 })).toBe(false);
    expect(nearCenter({ x: Number.NaN, y: 478 }, size)).toBe(false);
  });
});

describe("shouldAutoRecenter", () => {
  const now = 1_000_000;

  it("chauffeur qui roule et carte laissée 10 s : retour sur lui", () => {
    expect(shouldAutoRecenter({ speed: 8, at: now - 800 }, now - AUTO_RECENTER_MS, now)).toBe(true);
    expect(shouldAutoRecenter({ speed: 8, at: now - 800 }, now - AUTO_RECENTER_MS + 1, now)).toBe(false);
  });

  it("à l'arrêt (ou vitesse inconnue) : la carte reste où il l'a laissée", () => {
    expect(shouldAutoRecenter({ speed: 0.5, at: now }, now - 60_000, now)).toBe(false);
    expect(shouldAutoRecenter({ speed: null, at: now }, now - 60_000, now)).toBe(false);
  });

  it("arrêté depuis un moment : la vitesse du dernier point publié (avant l'arrêt) ne compte plus", () => {
    expect(shouldAutoRecenter({ speed: 8, at: now - SPEED_FRESH_MS - 1 }, now - 60_000, now)).toBe(false);
  });

  it("horodatage inconnu : vitesse seule", () => {
    expect(isDriving({ speed: 8 }, now)).toBe(true);
  });
});

describe("orientation", () => {
  it("caps ramenés dans [0, 360[ et écart le plus court", () => {
    expect(normHeading(-90)).toBe(270);
    expect(normHeading(725)).toBe(5);
    expect(headingGap(359, 1)).toBe(2);
    expect(headingGap(90, 270)).toBe(180);
  });

  it("nord en haut à 2° près (bouton boussole masqué)", () => {
    expect(isNorthUp(0)).toBe(true);
    expect(isNorthUp(358.5)).toBe(true);
    expect(isNorthUp(1.9)).toBe(true);
    expect(isNorthUp(15)).toBe(false);
    expect(isNorthUp(-30)).toBe(false);
  });
});

describe("MapGestures", () => {
  let now = 0;
  let settled: number[] = [];
  let g: MapGestures;
  const wait = (ms: number) => {
    now += ms;
    vi.advanceTimersByTime(ms);
  };
  const at = (id: string, x = 100, y = 100) => ({ id, x, y });
  /** Glisser d'un doigt : posé, déplacé au-delà du seuil. */
  const drag = (id = "1") => {
    g.touchStart([at(id)]);
    g.touchMove([at(id, 100 + MOVE_PX + 5, 100)]);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000;
    settled = [];
    g = new MapGestures((_g, gen) => settled.push(gen), () => now);
  });
  afterEach(() => {
    g.dispose();
    vi.useRealTimers();
  });

  it("simple appui (signalement, point), même avec un léger tremblement : aucun bilan", () => {
    g.touchStart([at("1")]);
    expect(g.busy).toBe(true);
    g.touchMove([at("1", 104, 103)]);
    wait(120);
    g.touchEnd(["1"]);
    expect(g.busy).toBe(false);
    wait(2_000);
    expect(settled).toEqual([]);
  });

  it("carte glissée : suivi suspendu pendant le geste, bilan une fois la carte immobile, compté jusqu'à sa réponse", () => {
    drag();
    wait(300);
    g.touchEnd(["1"]);
    expect(g.busy).toBe(true);
    wait(SETTLE_MS - 1);
    expect(settled).toEqual([]);
    wait(1);
    expect(settled).toHaveLength(1);
    // Réponse de la carte (position du chauffeur à l'écran) pas encore rendue : toujours occupé
    expect(g.busy).toBe(true);
    expect(g.finish(settled[0]!)).toBe(true);
    expect(g.busy).toBe(false);
    expect(g.finish(settled[0]!)).toBe(false);
  });

  it("élan après le geste : bilan à l'arrêt de la carte, pas avant", () => {
    drag();
    g.touchEnd(["1"]);
    wait(300);
    g.regionChange(false);
    wait(300);
    g.regionChange(false);
    wait(SETTLE_MS - 1);
    expect(settled).toEqual([]);
    g.regionChangeComplete();
    expect(settled).toHaveLength(1);
    wait(1_000);
    expect(settled).toHaveLength(1);
  });

  it("pincer ou tourner à deux doigts : repéré par le déplacement des doigts, fin au dernier doigt levé", () => {
    g.touchStart([at("1", 100, 100)]);
    g.touchStart([at("2", 200, 200)]);
    g.touchMove([at("1", 90, 90), at("2", 215, 215)]);
    g.touchEnd(["1"]);
    expect(g.busy).toBe(true);
    wait(1_000);
    expect(settled).toEqual([]);
    g.touchEnd(["2"]);
    wait(SETTLE_MS);
    expect(settled).toHaveLength(1);
  });

  it("pouce posé ailleurs sur l'écran : ne retient pas la fin du geste sur la carte", () => {
    drag("1");
    // La fin ne cite que le doigt de la carte ; un autre contact actif (panneau, glissière) n'est pas compté
    g.touchEnd(["1"]);
    wait(SETTLE_MS);
    expect(settled).toHaveLength(1);
  });

  it("deuxième doigt posé après un glissement : le glissement reste compté", () => {
    drag("1");
    g.touchStart([at("2", 300, 300)]);
    g.touchEnd(["1", "2"]);
    wait(SETTLE_MS);
    expect(settled).toHaveLength(1);
  });

  it("animation de l'app pendant un appui (iOS : simple indice) : pas un geste", () => {
    g.touchStart([at("1")]);
    g.regionChange(false);
    g.touchEnd(["1"]);
    wait(1_000);
    expect(settled).toEqual([]);
  });

  it("Android : mouvement dû à un geste (isGesture), même sans contact signalé ou après le lever", () => {
    g.regionChange(true);
    expect(g.busy).toBe(true);
    wait(200);
    g.regionChange(true);
    g.regionChangeComplete();
    expect(settled).toHaveLength(1);
  });

  it("double appui (zoom) : geste, bilan après le zoom", () => {
    g.touchStart([at("1")]);
    g.touchEnd(["1"]);
    g.doublePress();
    expect(g.busy).toBe(true);
    g.regionChange(false);
    g.regionChangeComplete();
    expect(settled).toHaveLength(1);
  });

  it("nouveau geste pendant l'élan du précédent : un seul bilan, à la fin", () => {
    drag("1");
    g.touchEnd(["1"]);
    wait(200);
    g.touchStart([at("2")]);
    wait(SETTLE_MS * 2);
    expect(settled).toEqual([]);
    g.touchEnd(["2"]);
    wait(SETTLE_MS);
    expect(settled).toHaveLength(1);
  });

  it("nouveau geste pendant le bilan : bilan périmé, repris à la fin du nouveau geste", () => {
    drag("1");
    g.touchEnd(["1"]);
    wait(SETTLE_MS);
    const first = settled[0]!;
    g.touchStart([at("2")]);
    expect(g.finish(first)).toBe(false);
    g.touchEnd(["2"]);
    wait(SETTLE_MS);
    expect(settled).toHaveLength(2);
    expect(g.finish(settled[1]!)).toBe(true);
  });

  it("fin de contact jamais reçue : geste tenu pour terminé, puis doigt de nouveau suivi s'il bouge", () => {
    drag("1");
    wait(TOUCH_STALE_MS);
    g.tick();
    expect(g.touching).toBe(true);
    wait(1);
    g.tick();
    expect(g.touching).toBe(false);
    // Le doigt était toujours posé : il glisse de nouveau, le geste reprend (pas de suivi sous le doigt)
    g.touchMove([at("1", 300, 300)]);
    expect(g.touching).toBe(true);
    expect(settled).toEqual([]);
    g.touchEnd(["1"]);
    wait(SETTLE_MS);
    expect(settled).toHaveLength(1);
  });

  it("contacts non signalés par la carte : les glissements seuls suspendent puis rendent le suivi", () => {
    g.panDrag();
    expect(g.busy).toBe(true);
    wait(DRAG_STALE_MS + 1);
    g.tick();
    wait(SETTLE_MS);
    expect(settled).toHaveLength(1);
    g.finish(settled[0]!);
    expect(g.busy).toBe(false);
  });

  it("bilan sans réponse de la carte : abandonné, jamais une carte bloquée", () => {
    drag();
    g.touchEnd(["1"]);
    wait(SETTLE_MS);
    expect(g.busy).toBe(true);
    wait(EVAL_TIMEOUT_MS + 1);
    g.tick();
    expect(g.busy).toBe(false);
    expect(g.finish(settled[0]!)).toBe(false);
  });

  it("carte recadrée par l'app : bilan en attente ou en cours abandonné", () => {
    drag();
    g.touchEnd(["1"]);
    g.drop();
    expect(g.busy).toBe(false);
    wait(1_000);
    expect(settled).toEqual([]);
    drag();
    g.touchEnd(["1"]);
    wait(SETTLE_MS);
    g.drop();
    expect(g.finish(settled[0]!)).toBe(false);
  });

  it("mouvement hors geste (animation de l'app) : ignoré, dernier contact inchangé", () => {
    g.regionChange(false);
    g.regionChangeComplete();
    expect(g.busy).toBe(false);
    expect(g.lastTouchAt).toBe(0);
    expect(settled).toEqual([]);
  });

  it("dernier contact daté à la fin du geste (délai du retour automatique)", () => {
    drag();
    wait(700);
    g.touchEnd(["1"]);
    wait(SETTLE_MS);
    expect(g.lastTouchAt).toBe(now);
  });
});
