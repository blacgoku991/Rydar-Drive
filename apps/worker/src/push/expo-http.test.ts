import type { ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import { describe, expect, it, vi } from "vitest";
import { expoHttpClient } from "./expo-http";

// API Expo muette : avec le SDK, 6 requêtes sans réponse bloquaient toutes les notifications (~5 min, audit worker-perf-1).
// Ici chaque requête est annulée à l'échéance, et les messages d'un même lot partent par 100 (worker-perf-2).

const msg = (to: string): ExpoPushMessage => ({ to, title: "t", body: "b" });
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Faux fetch : jetons « mute » → ne répond jamais (seulement l'abandon par le signal) ; sinon un ticket par message. */
function fakeFetch() {
  const bodies: ExpoPushMessage[][] = [];
  const fn = vi.fn((_url: string, init?: RequestInit) => {
    const messages = JSON.parse(String(init?.body)) as ExpoPushMessage[];
    bodies.push(messages);
    if (messages.some((m) => String(m.to).includes("mute"))) {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    }
    const data: ExpoPushTicket[] = messages.map((m) => ({ status: "ok", id: `ticket-${String(m.to)}` }));
    return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 }));
  });
  return { fn, bodies };
}

describe("client HTTP Expo", () => {
  it("API muette : requêtes annulées à l'échéance (erreur), les envois suivants partent aussitôt", async () => {
    const f = fakeFetch();
    const expo = expoHttpClient({ fetch: f.fn as unknown as typeof fetch, timeoutMs: 100, baseUrl: "http://expo.test" });
    const started = Date.now();
    // Issue lue tout de suite (aucun rejet non géré pendant l'attente)
    const muted = Array.from({ length: 7 }, (_, i) =>
      expo.sendPushNotificationsAsync([msg(`mute-${i}`)]).then(
        () => "envoyé",
        (error: Error) => error.message,
      ),
    );
    await tick();
    const ok = await expo.sendPushNotificationsAsync([msg("good")]);
    expect(ok).toEqual([{ status: "ok", id: "ticket-good" }]);
    expect(Date.now() - started).toBeLessThan(1_000);
    for (const outcome of await Promise.all(muted)) expect(outcome).toMatch(/EXPO_TIMEOUT/);
    for (const call of f.fn.mock.calls) expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("messages d'un même tour regroupés : 150 envois → 2 requêtes (100 + 50), chacun reçoit son ticket", async () => {
    const f = fakeFetch();
    const expo = expoHttpClient({ fetch: f.fn as unknown as typeof fetch, baseUrl: "http://expo.test" });
    const sends = Array.from({ length: 150 }, (_, i) => expo.sendPushNotificationsAsync([msg(`tok-${i}`)]));
    const tickets = await Promise.all(sends);
    expect(f.bodies.map((b) => b.length)).toEqual([100, 50]);
    tickets.forEach((t, i) => expect(t).toEqual([{ status: "ok", id: `ticket-tok-${i}` }]));
  });

  it("réponse en erreur (HTTP 429) : chaque envoi du groupe échoue, sans ticket mélangé", async () => {
    const fetch429 = vi.fn(async () => new Response(JSON.stringify({ errors: [{ code: "TOO_MANY_REQUESTS", message: "slow down" }] }), { status: 429 }));
    const expo = expoHttpClient({ fetch: fetch429 as unknown as typeof fetch, baseUrl: "http://expo.test" });
    await expect(expo.sendPushNotificationsAsync([msg("a")])).rejects.toThrow(/EXPO_HTTP_429/);
  });
});
