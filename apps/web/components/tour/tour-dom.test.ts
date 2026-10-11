import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAYER_SETTLE_MS, layerOpen, whenNoLayer } from "./tour-dom";

// Visite guidée (docs/TUTORIEL.md § 5.3, § 6.8) : jamais ouverte d'office ni affichée par-dessus une fenêtre, une alerte
// ou un menu déjà ouverts — attente de leur fermeture (whenNoLayer). DOM simulé : sélecteur des calques, observateur des
// changements du DOM, minuteries.

type Watcher = { callback: () => void; connected: boolean; target?: unknown; options?: unknown };

const BODY = { nodeName: "BODY" };
let layer = false;
const queries: string[] = [];
const watchers: Watcher[] = [];

class FakeMutationObserver {
  private readonly watcher: Watcher;
  constructor(callback: () => void) {
    this.watcher = { callback, connected: false };
    watchers.push(this.watcher);
  }
  observe(target: unknown, options: unknown) {
    Object.assign(this.watcher, { connected: true, target, options });
  }
  disconnect() {
    this.watcher.connected = false;
  }
}

/** Un changement du DOM (un calque qui s'ouvre ou se ferme, une ligne d'En direct…). */
const mutate = () => {
  for (const w of watchers) if (w.connected) w.callback();
};
const connected = () => watchers.filter((w) => w.connected).length;

beforeEach(() => {
  vi.useFakeTimers();
  layer = false;
  queries.length = 0;
  watchers.length = 0;
  vi.stubGlobal("document", {
    body: BODY,
    querySelector: (selector: string) => (queries.push(selector), layer ? {} : null),
  });
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  });
  vi.stubGlobal("MutationObserver", FakeMutationObserver);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("calques qui passent avant la visite (layerOpen)", () => {
  it("fenêtres et tiroirs (sauf la fenêtre de visite), fenêtres d'alerte, menus", () => {
    expect(layerOpen()).toBe(false);
    layer = true;
    expect(layerOpen()).toBe(true);
    expect(queries[0]).toBe('[role="dialog"]:not([data-tour-card]), [role="alertdialog"], [role="menu"]');
  });
});

describe("attente de la fermeture des calques (whenNoLayer)", () => {
  it("aucun calque ouvert : tout de suite, sans rien observer", () => {
    const ready = vi.fn();
    whenNoLayer(ready);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(watchers).toHaveLength(0);
  });

  it("fenêtre ouverte : rien tant qu'elle l'est, puis une fois, LAYER_SETTLE_MS après sa fermeture (focus rendu d'abord)", () => {
    layer = true;
    const ready = vi.fn();
    whenNoLayer(ready);
    expect(watchers[0]).toMatchObject({ connected: true, target: BODY, options: { childList: true, subtree: true } });
    mutate();
    vi.advanceTimersByTime(10_000);
    expect(ready).not.toHaveBeenCalled();
    layer = false;
    mutate();
    vi.advanceTimersByTime(LAYER_SETTLE_MS - 1);
    expect(ready).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(connected()).toBe(0);
    mutate();
    vi.advanceTimersByTime(10_000);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("les autres changements de la page (En direct) ne repoussent pas l'attente", () => {
    layer = true;
    const ready = vi.fn();
    whenNoLayer(ready, 400);
    layer = false;
    mutate();
    for (let i = 0; i < 7; i++) {
      vi.advanceTimersByTime(50);
      mutate();
    }
    expect(ready).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("calque rouvert pendant l'attente : attente reprise à sa fermeture, même rouvert sans changement observé", () => {
    layer = true;
    const ready = vi.fn();
    whenNoLayer(ready, 400);
    layer = false;
    mutate();
    vi.advanceTimersByTime(300);
    layer = true;
    mutate();
    vi.advanceTimersByTime(1000);
    expect(ready).not.toHaveBeenCalled();
    layer = false;
    mutate();
    vi.advanceTimersByTime(399);
    // Rouvert sans changement observé avant l'échéance : vérifié à l'échéance, on attend encore
    layer = true;
    vi.advanceTimersByTime(1);
    expect(ready).not.toHaveBeenCalled();
    expect(connected()).toBe(1);
    layer = false;
    mutate();
    vi.advanceTimersByTime(400);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("annulée (démontage, urgence ou acceptation revenues) : jamais appelée, observateur détaché", () => {
    layer = true;
    const ready = vi.fn();
    const cancel = whenNoLayer(ready);
    layer = false;
    mutate();
    cancel();
    vi.advanceTimersByTime(10_000);
    expect(ready).not.toHaveBeenCalled();
    expect(connected()).toBe(0);
  });
});
