import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_RECENTER_MS, DRAG_STALE_MS, MapGestures, SETTLE_MS, SPEED_FRESH_MS, TOUCH_STALE_MS, headingGap, isDriving, isNorthUp, nearCenter,
  normHeading, shouldAutoRecenter,
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
  let settled = 0;
  let g: MapGestures;
  const wait = (ms: number) => {
    now += ms;
    vi.advanceTimersByTime(ms);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000;
    settled = 0;
    g = new MapGestures(() => (settled += 1), () => now);
  });
  afterEach(() => {
    g.dispose();
    vi.useRealTimers();
  });

  it("simple appui (signalement, point) : aucun bilan, la carte continue de suivre", () => {
    g.touchStart();
    expect(g.busy).toBe(true);
    wait(120);
    g.touchEnd(0);
    expect(g.busy).toBe(false);
    wait(2_000);
    expect(settled).toBe(0);
  });

  it("carte glissée : suivi suspendu pendant le geste, bilan une fois la carte immobile", () => {
    g.touchStart();
    g.panDrag();
    wait(300);
    g.touchEnd(0);
    expect(g.busy).toBe(true);
    wait(SETTLE_MS - 1);
    expect(settled).toBe(0);
    wait(1);
    expect(settled).toBe(1);
    expect(g.busy).toBe(false);
  });

  it("élan après le geste : bilan à l'arrêt de la carte, pas avant", () => {
    g.touchStart();
    g.panDrag();
    g.touchEnd(0);
    wait(300);
    g.regionChange(true);
    wait(300);
    g.regionChange(true);
    wait(SETTLE_MS - 1);
    expect(settled).toBe(0);
    g.regionChangeComplete();
    expect(settled).toBe(1);
    wait(1_000);
    expect(settled).toBe(1);
  });

  it("zoom ou rotation à deux doigts sans glissement : repéré par le mouvement de la carte", () => {
    g.touchStart();
    g.regionChange(true);
    g.touchEnd(1);
    expect(g.busy).toBe(true);
    wait(1_000);
    expect(settled).toBe(0);
    g.touchEnd(0);
    wait(SETTLE_MS);
    expect(settled).toBe(1);
  });

  it("animation de l'app pendant un appui (Android, isGesture faux) : pas un geste", () => {
    g.touchStart();
    g.regionChange(false);
    g.touchEnd(0);
    wait(1_000);
    expect(settled).toBe(0);
  });

  it("nouveau geste pendant l'élan du précédent : un seul bilan, à la fin", () => {
    g.touchStart();
    g.panDrag();
    g.touchEnd(0);
    wait(200);
    g.touchStart();
    wait(SETTLE_MS * 2);
    expect(settled).toBe(0);
    g.touchEnd(0);
    wait(SETTLE_MS);
    expect(settled).toBe(1);
  });

  it("fin de contact jamais reçue : geste tenu pour terminé (jamais de suivi bloqué)", () => {
    g.touchStart();
    g.panDrag();
    wait(TOUCH_STALE_MS);
    g.tick();
    expect(g.touching).toBe(true);
    wait(1);
    g.tick();
    expect(g.touching).toBe(false);
    wait(SETTLE_MS);
    expect(settled).toBe(1);
  });

  it("contacts non signalés par la carte : les glissements seuls suspendent puis rendent le suivi", () => {
    g.panDrag();
    expect(g.busy).toBe(true);
    wait(DRAG_STALE_MS + 1);
    g.tick();
    wait(SETTLE_MS);
    expect(settled).toBe(1);
    expect(g.busy).toBe(false);
  });

  it("carte recadrée par l'app : bilan en attente abandonné", () => {
    g.touchStart();
    g.panDrag();
    g.touchEnd(0);
    g.drop();
    expect(g.busy).toBe(false);
    wait(1_000);
    expect(settled).toBe(0);
  });

  it("mouvement hors geste (animation, double appui) : ignoré, dernier contact inchangé", () => {
    g.regionChange(true);
    g.regionChangeComplete();
    expect(g.busy).toBe(false);
    expect(g.lastTouchAt).toBe(0);
    expect(settled).toBe(0);
  });

  it("dernier contact daté à la fin du geste (délai du retour automatique)", () => {
    g.touchStart();
    g.panDrag();
    wait(700);
    g.touchEnd(0);
    wait(SETTLE_MS);
    expect(g.lastTouchAt).toBe(now);
  });
});
