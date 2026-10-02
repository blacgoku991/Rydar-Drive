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

  it("connexions gardées ouvertes 60 s (4 s par défaut)", () => {
    expect(KEEP_ALIVE_MS).toBeGreaterThanOrEqual(60_000);
  });
});
