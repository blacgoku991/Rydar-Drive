import { afterEach, describe, expect, it } from "vitest";
import { describeNetworkError, postWebhook, resultFromStatus } from "./http";
import { resolveWebhookTarget, type Resolver } from "./ssrf";
import { startServer } from "./test-server";

const OPTS = { timeoutMs: 2_000, maxResponseBytes: 2048 };
const HEADERS = { "Content-Type": "application/json; charset=utf-8", "X-Rydar-Event": "ping" };
const BODY = '{"id":"d1","type":"ping","data":{}}';
const lax = { allowPrivate: true };

const servers: { close: () => Promise<void> }[] = [];
async function server(handler: Parameters<typeof startServer>[0]) {
  const s = await startServer(handler);
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("webhooks — envoi HTTP", () => {
  it("2xx : succès ; corps et en-têtes reçus tels quels", async () => {
    const s = await server((_req, res) => {
      res.writeHead(204).end();
    });
    const r = await postWebhook(await resolveWebhookTarget(s.url("/hook?x=1"), lax), BODY, HEADERS, OPTS);
    expect(r).toEqual({ ok: true, statusCode: 204, error: null });
    expect(s.received).toHaveLength(1);
    expect(s.received[0]).toMatchObject({ method: "POST", url: "/hook?x=1", body: BODY });
    expect(s.received[0]!.headers["x-rydar-event"]).toBe("ping");
    expect(s.received[0]!.headers["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("non 2xx : échec avec le code HTTP", async () => {
    for (const code of [400, 404, 410, 500, 503]) {
      const s = await server((_req, res) => {
        res.writeHead(code).end("erreur");
      });
      expect(await postWebhook(await resolveWebhookTarget(s.url(), lax), BODY, HEADERS, OPTS)).toEqual({ ok: false, statusCode: code, error: `HTTP ${code}` });
    }
  });

  it("redirection : jamais suivie, échec (3xx)", async () => {
    const target = await server((_req, res) => {
      res.writeHead(200).end();
    });
    for (const code of [301, 302, 307, 308]) {
      const s = await server((_req, res) => {
        res.writeHead(code, { Location: target.url("/ailleurs") }).end();
      });
      const r = await postWebhook(await resolveWebhookTarget(s.url(), lax), BODY, HEADERS, OPTS);
      expect(r).toEqual({ ok: false, statusCode: code, error: `Redirection non suivie (HTTP ${code})` });
    }
    expect(target.received).toHaveLength(0);
  });

  it("aucune réponse dans le délai : échec « Délai dépassé »", async () => {
    const s = await server(() => undefined); // ne répond jamais
    const started = Date.now();
    const r = await postWebhook(await resolveWebhookTarget(s.url(), lax), BODY, HEADERS, { ...OPTS, timeoutMs: 300 });
    expect(r).toEqual({ ok: false, statusCode: null, error: "Délai dépassé (0,3 s)" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("2xx reçu puis corps qui traîne : succès au délai (le code fait foi)", async () => {
    const s = await server((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("ok"); // jamais terminé
    });
    expect(await postWebhook(await resolveWebhookTarget(s.url(), lax), BODY, HEADERS, { ...OPTS, timeoutMs: 300 })).toEqual({ ok: true, statusCode: 200, error: null });
  });

  it("réponse volumineuse : 2 Ko lus au plus, connexion fermée sans attendre la fin", async () => {
    const s = await server((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      const chunk = "x".repeat(64 * 1024);
      let n = 0;
      const pump = () => {
        while (n < 1000 && res.write(chunk)) n++;
        if (n < 1000 && !res.destroyed) res.once("drain", pump);
      };
      pump();
    });
    const started = Date.now();
    expect(await postWebhook(await resolveWebhookTarget(s.url(), lax), BODY, HEADERS, { ...OPTS, timeoutMs: 5_000 })).toEqual({ ok: true, statusCode: 200, error: null });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("connexion refusée : échec réseau sans adresse dans le message", async () => {
    const s = await server(() => undefined);
    const url = s.url();
    await s.close();
    const r = await postWebhook(await resolveWebhookTarget(url, lax), BODY, HEADERS, OPTS);
    expect(r).toEqual({ ok: false, statusCode: null, error: "Connexion refusée" });
  });

  it("connexion épinglée sur l'adresse validée : un nom résolu par le garde, jamais par le système", async () => {
    const s = await server((_req, res) => {
      res.writeHead(200).end();
    });
    const resolve: Resolver = async (host) => (host === "hooks.rydar.test" ? [{ address: "127.0.0.1", family: 4 }] : []);
    const target = await resolveWebhookTarget(`http://hooks.rydar.test:${s.port}/hook`, { allowPrivate: true, resolve });
    expect(await postWebhook(target, BODY, HEADERS, OPTS)).toEqual({ ok: true, statusCode: 200, error: null });
    expect(s.received[0]!.headers.host).toBe(`hooks.rydar.test:${s.port}`);
  });
});

describe("webhooks — verdicts et messages", () => {
  it("codes HTTP", () => {
    expect(resultFromStatus(200).ok).toBe(true);
    expect(resultFromStatus(299).ok).toBe(true);
    expect(resultFromStatus(199).ok).toBe(false);
    expect(resultFromStatus(300)).toEqual({ ok: false, statusCode: 300, error: "Redirection non suivie (HTTP 300)" });
    expect(resultFromStatus(429)).toEqual({ ok: false, statusCode: 429, error: "HTTP 429" });
  });

  it("erreurs réseau : message court en français, code technique seulement", () => {
    expect(describeNetworkError(Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), { code: "ECONNREFUSED" }))).toBe("Connexion refusée");
    expect(describeNetworkError(Object.assign(new Error("x"), { code: "CERT_HAS_EXPIRED" }))).toBe("Certificat ou connexion TLS invalide (CERT_HAS_EXPIRED)");
    expect(describeNetworkError(Object.assign(new Error("x"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }))).toContain("TLS");
    expect(describeNetworkError(Object.assign(new Error("x"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }))).toContain("TLS");
    expect(describeNetworkError(new Error("socket hang up"))).toBe("Connexion interrompue");
    expect(describeNetworkError(Object.assign(new Error("connect EHOSTUNREACH 1.2.3.4"), { code: "EHOSTUNREACH" }))).toBe("Hôte injoignable");
    expect(describeNetworkError(Object.assign(new Error("secret 1.2.3.4"), { code: "EWHATEVER" }))).toBe("Erreur réseau (EWHATEVER)");
    expect(describeNetworkError(new Error("détail interne 10.0.0.1"))).toBe("Erreur réseau");
  });
});
