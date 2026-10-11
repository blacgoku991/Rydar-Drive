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

  // Audit p5 (worker-infra-1) : un chauffeur enregistre le jeton d'une AUTRE app Expo ; Expo refuse alors toute requête
  // qui mélange deux projets (PUSH_TOO_MANY_EXPERIENCE_IDS, details = projet → jetons) — les notifications des autres
  // centrales du même lot ne doivent pas échouer avec lui.
  function projectsFetch() {
    const bodies: string[][] = [];
    const fn = vi.fn(async (_url: string, init?: RequestInit) => {
      const messages = JSON.parse(String(init?.body)) as ExpoPushMessage[];
      const tokens = messages.map((m) => String(m.to));
      bodies.push(tokens);
      const projects: Record<string, string[]> = {};
      for (const t of tokens) (projects[t.includes("pirate") ? "@pirate/autre-app" : "@rydar/driver"] ??= []).push(t);
      if (Object.keys(projects).length > 1) {
        const errors = [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS", message: "All push notification messages in the same request must be for the same project", details: projects, isTransient: false }];
        return new Response(JSON.stringify({ errors }), { status: 400 });
      }
      if (tokens.some((t) => t.includes("invalide"))) {
        return new Response(JSON.stringify({ errors: [{ code: "VALIDATION_ERROR", message: '"[0].to" is invalid' }] }), { status: 400 });
      }
      if (tokens.some((t) => t.includes("panne"))) return new Response("bad gateway", { status: 502 });
      return new Response(JSON.stringify({ data: tokens.map((t) => ({ status: "ok", id: `ticket-${t}` })) }), { status: 200 });
    });
    return { fn, bodies };
  }
  const outcome = (p: Promise<ExpoPushTicket[]>) => p.then((t) => t.map((x) => (x.status === "ok" ? x.id : "erreur")), (e: Error) => `rejet: ${e.message}`);

  it("projets mélangés dans un lot : un envoi par projet, les notifications des autres centrales partent", async () => {
    const f = projectsFetch();
    const expo = expoHttpClient({ fetch: f.fn as unknown as typeof fetch, baseUrl: "http://expo.test" });
    const [a, b, c] = await Promise.all([
      outcome(expo.sendPushNotificationsAsync([msg("rydar-A")])),
      outcome(expo.sendPushNotificationsAsync([msg("rydar-B")])),
      // Chauffeur C : son jeton Rydar ET le jeton d'une autre app, dans le même envoi
      outcome(expo.sendPushNotificationsAsync([msg("rydar-C"), msg("pirate-C")])),
    ]);
    expect(a).toEqual(["ticket-rydar-A"]);
    expect(b).toEqual(["ticket-rydar-B"]);
    expect(c).toEqual(["ticket-rydar-C", "ticket-pirate-C"]); // ordre de ses messages conservé
    expect(f.bodies).toEqual([["rydar-A", "rydar-B", "rydar-C", "pirate-C"], ["rydar-A", "rydar-B", "rydar-C"], ["pirate-C"]]);
  });

  it("autre refus de la requête (400) : un envoi par expéditeur, seul l'envoi fautif échoue ; panne (502) : tout le groupe, une requête", async () => {
    const f = projectsFetch();
    const expo = expoHttpClient({ fetch: f.fn as unknown as typeof fetch, baseUrl: "http://expo.test" });
    const results = await Promise.all([
      outcome(expo.sendPushNotificationsAsync([msg("rydar-A")])),
      outcome(expo.sendPushNotificationsAsync([msg("rydar-invalide")])),
      outcome(expo.sendPushNotificationsAsync([msg("rydar-B")])),
    ]);
    expect(results[0]).toEqual(["ticket-rydar-A"]);
    expect(results[1]).toMatch(/rejet: EXPO_HTTP_400: VALIDATION_ERROR/);
    expect(results[2]).toEqual(["ticket-rydar-B"]);
    expect(f.bodies).toHaveLength(4);

    f.bodies.length = 0;
    const down = await Promise.all([outcome(expo.sendPushNotificationsAsync([msg("rydar-panne")])), outcome(expo.sendPushNotificationsAsync([msg("rydar-B")]))]);
    for (const r of down) expect(r).toMatch(/rejet: EXPO_HTTP_502/);
    expect(f.bodies).toHaveLength(1); // aucune requête supplémentaire pendant une panne d'Expo
  });
});
