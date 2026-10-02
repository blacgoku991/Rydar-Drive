import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fetch as undiciFetch } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServerDispatcher, DNS_CACHE_MS, KEEP_ALIVE_MS } from "./server-fetch";

let server: Server;
let port = 0;
let connections = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, host: req.headers.host }));
  });
  server.keepAliveTimeout = 30_000;
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe("appels sortants du serveur web (Supabase)", () => {
  it("une seule recherche DNS et des connexions réutilisées pour des appels successifs ; en-tête Host d'origine conservé", async () => {
    let lookups = 0;
    const dispatcher = createServerDispatcher({
      lookup: (_origin, _options, callback) => {
        lookups += 1;
        callback(null, [{ address: "127.0.0.1", family: 4, ttl: DNS_CACHE_MS }]);
      },
    });
    connections = 0;
    for (let i = 0; i < 8; i++) {
      const res = await undiciFetch(`http://supabase.rydar.test:${port}/auth/v1/health`, { dispatcher });
      const body = (await res.json()) as { ok: boolean; host: string };
      expect(body).toEqual({ ok: true, host: `supabase.rydar.test:${port}` });
    }
    expect(lookups).toBe(1);
    // undici ouvre au plus une seconde connexion au démarrage du cache DNS, puis les réutilise
    expect(connections).toBeLessThanOrEqual(2);
    await dispatcher.close();
  });

  it("nom avec adresses IPv4 et IPv6 : toujours IPv4 (conteneur sans IPv6 : plus d'échec une requête sur deux)", async () => {
    const dispatcher = createServerDispatcher({
      // 2001:db8::/32 : plage de documentation, jamais joignable (ici : pas d'IPv6 du tout, EAFNOSUPPORT / ENETUNREACH)
      lookup: (_origin, _options, callback) =>
        callback(null, [
          { address: "127.0.0.1", family: 4, ttl: DNS_CACHE_MS },
          { address: "2001:db8::1", family: 6, ttl: DNS_CACHE_MS },
        ]),
    });
    const results: string[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await undiciFetch(`http://supabase.rydar.test:${port}/rest/v1/`, { dispatcher }).then(
        (r) => `ok ${r.status}`,
        (e: Error & { cause?: { code?: string } }) => `erreur ${e.cause?.code ?? e.message}`,
      );
      results.push(res);
    }
    expect(results).toEqual(Array(6).fill("ok 200"));
    await dispatcher.close();
  });

  it("nom sans adresse IPv4 (AAAA seul) : l'IPv6 reste utilisée", async () => {
    let picked = "";
    const dispatcher = createServerDispatcher({
      lookup: (_origin, _options, callback) => callback(null, [{ address: "::1", family: 6, ttl: DNS_CACHE_MS }]),
    });
    // Pas de serveur IPv6 ici : seule l'adresse tentée compte (jamais « aucune adresse »)
    await undiciFetch(`http://supabase.rydar.test:${port}/`, { dispatcher }).catch((e: Error & { cause?: { address?: string; code?: string } }) => {
      picked = e.cause?.address ?? e.cause?.code ?? e.message;
    });
    expect(picked).not.toMatch(/No DNS entries|ENOTFOUND/);
    await dispatcher.close();
  });

  it("connexions gardées ouvertes 60 s (4 s par défaut)", () => {
    expect(KEEP_ALIVE_MS).toBeGreaterThanOrEqual(60_000);
  });
});
