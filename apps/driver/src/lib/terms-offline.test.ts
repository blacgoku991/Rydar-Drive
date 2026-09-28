// Conditions d'utilisation à accepter (contre-audit app_worker#3) : un échec de la mise hors ligne (réseau) ne laisse
// plus le chauffeur disponible — donc destinataire d'offres — sans nouvel essai.
import { afterEach, describe, expect, it, vi } from "vitest";
import { OFFLINE_RETRY_MS, offlineEnforcer } from "./terms-offline";

type Outcome = "ok" | "fail" | "ignored";

/**
 * Écran des conditions simulé : présence du chauffeur et effet [mustGoOffline] (terms-gate.tsx), setOnline(false) de
 * driver-context — présence « hors ligne » affichée tout de suite, puis confirmée, ou rétablie si l'appel échoue ;
 * « ignored » : garde « double appui » (autre passage en ligne / hors ligne en cours), { ok: true } sans rien faire.
 * `deferred` : effet exécuté après coup (rendu React) plutôt qu'aussitôt.
 */
function screen(outcomes: Outcome[], deferred: boolean) {
  let presence = "available";
  const attempts: number[] = [];
  const effect = () => enforcer.set(presence === "available");
  const setPresence = (p: string) => {
    presence = p;
    if (deferred) setTimeout(effect, 0);
    else effect();
  };
  const enforcer = offlineEnforcer(async () => {
    attempts.push(Date.now());
    const outcome = outcomes.shift() ?? "ok";
    if (outcome === "ignored") return { ok: true };
    setPresence("offline");
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (outcome === "fail") {
      setPresence("available");
      return { ok: false, message: "Réseau indisponible." };
    }
    return { ok: true, presence: "offline" };
  });
  effect();
  return { enforcer, attempts, presence: () => presence, setPresence };
}

afterEach(() => {
  vi.useRealTimers();
});

describe.each([false, true])("mise hors ligne tant que les conditions ne sont pas acceptées (effet différé : %s)", (deferred) => {
  it("échec réseau : nouvel essai au bout du délai, jusqu'à la mise hors ligne confirmée", async () => {
    vi.useFakeTimers({ now: 0 });
    const s = screen(["fail", "fail", "ok"], deferred);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.attempts).toEqual([0]);
    expect(s.presence()).toBe("available");

    await vi.advanceTimersByTimeAsync(OFFLINE_RETRY_MS - 1000 - 1);
    expect(s.attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.attempts).toEqual([0, OFFLINE_RETRY_MS]);

    await vi.advanceTimersByTimeAsync(OFFLINE_RETRY_MS);
    expect(s.attempts).toEqual([0, OFFLINE_RETRY_MS, 2 * OFFLINE_RETRY_MS]);
    // Pas « passé hors ligne » avant la réponse du serveur (présence seulement affichée)
    expect(s.enforcer.takeWentOffline()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.presence()).toBe("offline");
    expect(s.enforcer.takeWentOffline()).toBe(true);
    expect(s.enforcer.takeWentOffline()).toBe(false);

    // Hors ligne : plus aucun appel
    await vi.advanceTimersByTimeAsync(10 * OFFLINE_RETRY_MS);
    expect(s.attempts).toHaveLength(3);
  });

  it("appel sans effet (autre passage en ligne / hors ligne en cours) : pas compté hors ligne, nouvel essai", async () => {
    vi.useFakeTimers({ now: 0 });
    const s = screen(["ignored", "ok"], deferred);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.attempts).toEqual([0]);
    expect(s.enforcer.takeWentOffline()).toBe(false);

    await vi.advanceTimersByTimeAsync(OFFLINE_RETRY_MS);
    expect(s.attempts).toEqual([0, OFFLINE_RETRY_MS]);
    expect(s.presence()).toBe("offline");
    expect(s.enforcer.takeWentOffline()).toBe(true);
  });

  it("conditions acceptées entre deux essais, ou changement de compte : plus aucun essai", async () => {
    vi.useFakeTimers({ now: 0 });
    const s = screen(["fail", "ok"], deferred);
    await vi.advanceTimersByTimeAsync(1000);
    s.enforcer.set(false);
    await vi.advanceTimersByTimeAsync(5 * OFFLINE_RETRY_MS);
    expect(s.attempts).toHaveLength(1);

    // De nouveau à mettre hors ligne (nouvelle version des conditions) : dernier essai assez ancien, tout de suite
    s.enforcer.set(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(s.attempts).toHaveLength(2);

    // Compte changé pendant l'appel : réponse ignorée, rien de reprogrammé
    s.enforcer.dispose();
    await vi.advanceTimersByTimeAsync(5 * OFFLINE_RETRY_MS);
    expect(s.attempts).toHaveLength(2);
    expect(s.enforcer.takeWentOffline()).toBe(false);
  });
});
