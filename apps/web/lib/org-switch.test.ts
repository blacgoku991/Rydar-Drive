import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Un « onglet » = une instance neuve du module (son propre canal). */
async function tab() {
  vi.resetModules();
  return import("./org-switch");
}

describe("changement de centrale entre onglets (auth-web#6)", () => {
  beforeEach(() => {
    // Canal Node détaché de la boucle d'événements : le processus de test peut se terminer
    class TestChannel extends BroadcastChannel {
      constructor(name: string) {
        super(name);
        (this as unknown as { unref?: () => void }).unref?.();
      }
    }
    vi.stubGlobal("BroadcastChannel", TestChannel);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prévient les autres onglets, pas celui qui a changé de centrale", async () => {
    const a = await tab();
    const b = await tab();
    const c = await tab();
    const seen: Record<string, string[]> = { a: [], b: [], c: [] };
    const offs = [a.onOrgSwitch((id) => seen.a!.push(id)), b.onOrgSwitch((id) => seen.b!.push(id)), c.onOrgSwitch((id) => seen.c!.push(id))];

    a.announceOrgSwitch("org-2");
    await vi.waitFor(() => {
      expect(seen.b).toEqual(["org-2"]);
      expect(seen.c).toEqual(["org-2"]);
    });
    expect(seen.a).toEqual([]);

    // Désabonné : plus rien reçu
    offs[1]!();
    c.announceOrgSwitch("org-1");
    await vi.waitFor(() => expect(seen.a).toEqual(["org-1"]));
    expect(seen.b).toEqual(["org-2"]);
    for (const off of offs) off();
  });
});
