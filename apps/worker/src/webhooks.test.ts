import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWebhookDispatcher,
  deliverWebhook,
  runWebhookCycle,
  WEBHOOK_CONCURRENCY,
  WEBHOOK_DRAIN_MS,
  WEBHOOK_TIMEOUT_MS,
  WebhookSignal,
  type QueryFn,
} from "./webhooks";
import type { ClaimedWebhook } from "./webhooks/sign";
import type { Resolver } from "./webhooks/ssrf";
import { startServer } from "./webhooks/test-server";

const SECRET = "whsec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const APP = "https://rydar.example";
const CLAIM_SQL = "select * from private.claim_webhook_deliveries($1::integer)";
const COMPLETE_SQL = "select private.complete_webhook_delivery($1::uuid, $2::boolean, $3::integer, $4::text)";
const PURGE_SQL = "select private.purge_webhook_deliveries() as n";

let seq = 0;
function delivery(url: string, over: Partial<ClaimedWebhook> = {}): ClaimedWebhook {
  seq++;
  const rideId = `8d0c0000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  return {
    id: `5b1e0c4a-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    organization_id: "org-1",
    endpoint_id: "ep-1",
    url,
    secret: SECRET,
    event_type: "ride.accepted",
    event_status: "ACCEPTED",
    previous_status: "OFFERED",
    occurred_at: new Date("2026-10-02T10:00:00Z"),
    attempts: 0,
    ride: {
      id: rideId,
      number: seq,
      status: "ACCEPTED",
      external_reference: "RP-AB12C",
      created_at: "2026-10-02T09:59:00+00:00",
      updated_at: "2026-10-02T10:00:00.5+00:00",
      driver: null,
    },
    ...over,
  };
}

/** Base factice : réserve les lots donnés dans l'ordre, puis plus rien ; enregistre les fins d'envoi. */
function fakeDb(batches: ClaimedWebhook[][], opts: { completeError?: Error } = {}) {
  const completes: unknown[][] = [];
  const claims: unknown[][] = [];
  const queue = [...batches];
  const query: QueryFn = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql === CLAIM_SQL) {
      claims.push(params ?? []);
      return { rows: queue.shift() ?? [] };
    }
    if (sql === COMPLETE_SQL) {
      if (opts.completeError) throw opts.completeError;
      completes.push(params ?? []);
      return { rows: [{}] };
    }
    if (sql === PURGE_SQL) return { rows: [{ n: 3 }] };
    throw new Error(`requête inattendue : ${sql}`);
  });
  return { query, completes, claims };
}

/**
 * Base factice plus fidèle : une file de lignes dues, chaque réservation en prend au plus p_limit (comme
 * private.claim_webhook_deliveries) ; heure de chaque réservation et de chaque fin d'envoi.
 */
function queueDb(rows: ClaimedWebhook[]) {
  const t0 = Date.now();
  const queue = [...rows];
  const claims: { limit: number; got: number; at: number }[] = [];
  const completes: { id: string; ok: boolean; at: number }[] = [];
  const query: QueryFn = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql === CLAIM_SQL) {
      const limit = Number(params?.[0]);
      const got = queue.splice(0, limit);
      claims.push({ limit, got: got.length, at: Date.now() - t0 });
      return { rows: got };
    }
    if (sql === COMPLETE_SQL) {
      completes.push({ id: String(params?.[0]), ok: params?.[1] === true, at: Date.now() - t0 });
      return { rows: [{}] };
    }
    throw new Error(`requête inattendue : ${sql}`);
  });
  return { query, claims, completes, queue };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Lignes JSON écrites par log() (info / warn → console.log, error → console.error). */
let logs: Record<string, any>[] = [];
beforeEach(() => {
  logs = [];
  const push = (line: unknown) => void logs.push(JSON.parse(String(line)));
  vi.spyOn(console, "log").mockImplementation(push);
  vi.spyOn(console, "error").mockImplementation(push);
});

const servers: { close: () => Promise<void> }[] = [];
async function server(handler: Parameters<typeof startServer>[0]) {
  const s = await startServer(handler);
  servers.push(s);
  return s;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("worker — webhooks sortants (boucle)", () => {
  it("réservation → envoi signé au serveur local → complete_webhook_delivery(id, true, 200, null)", async () => {
    const s = await server((_req, res) => {
      res.writeHead(200).end("merci");
    });
    const d = delivery(s.url("/rydar/hook?token=abc"), { attempts: 3 });
    const db = fakeDb([[d]]);
    const dispatcher = createWebhookDispatcher({ query: db.query, appUrl: APP, allowPrivate: true });
    expect(await dispatcher.process()).toBe(1);

    // Autant de lignes que de places libres (5) ; l'envoi terminé, nouvelle réservation (vide : fin du passage)
    expect(db.claims).toEqual([[WEBHOOK_CONCURRENCY], [WEBHOOK_CONCURRENCY]]);
    expect(WEBHOOK_CONCURRENCY).toBe(5);
    expect(db.completes).toEqual([[d.id, true, 200, null]]);
    expect(dispatcher.stats).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });

    // Requête reçue : en-têtes du contrat, signature vérifiable, corps conforme
    const got = s.received[0]!;
    expect(got.url).toBe("/rydar/hook?token=abc");
    expect(got.headers).toMatchObject({
      "content-type": "application/json; charset=utf-8",
      "user-agent": "RydarDrive-Webhooks/1.0",
      "x-rydar-event": "ride.accepted",
      "x-rydar-delivery": d.id,
    });
    const ts = got.headers["x-rydar-timestamp"] as string;
    expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(5);
    const expected = createHmac("sha256", SECRET).update(`${ts}.${got.body}`).digest("hex");
    expect(got.headers["x-rydar-signature"]).toBe(`v1=${expected}`);
    const body = JSON.parse(got.body);
    expect(body).toMatchObject({
      id: d.id,
      type: "ride.accepted",
      created_at: "2026-10-02T10:00:00.000Z",
      api_version: "2026-10-01",
      data: { status: "ACCEPTED", previous_status: "OFFERED", ride: { id: d.ride!.id, external_reference: "RP-AB12C", updated_at: "2026-10-02T10:00:00.5+00:00" } },
    });
    expect(body.data.ride.links.self).toBe(`${APP}/api/v1/rides/${d.ride!.id}`);

    // Journal : jamais le secret, le corps ni le chemin de l'URL (jeton possible)
    const text = JSON.stringify(logs);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("token=abc");
    expect(text).not.toContain("RP-AB12C");
    expect(logs).toContainEqual(expect.objectContaining({ level: "info", msg: "webhooks processed", claimed: 1, delivered: 1, failed: 0 }));
  });

  it("échecs (HTTP 500, redirection) : complete(id, false, code, message) ; journal warn sans secret", async () => {
    const s500 = await server((_req, res) => {
      res.writeHead(500).end("boom");
    });
    const s302 = await server((_req, res) => {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" }).end();
    });
    const a = delivery(s500.url());
    const b = delivery(s302.url(), { endpoint_id: "ep-2" });
    const db = fakeDb([[a, b]]);
    const r = await runWebhookCycle({ query: db.query, appUrl: APP, allowPrivate: true });
    expect(r).toEqual({ claimed: 2, delivered: 0, failed: 2 });
    expect(db.completes).toContainEqual([a.id, false, 500, "HTTP 500"]);
    expect(db.completes).toContainEqual([b.id, false, 302, "Redirection non suivie (HTTP 302)"]);
    const warn = logs.find((l) => l.level === "warn" && l.id === a.id);
    expect(warn).toMatchObject({ type: "ride.accepted", endpoint: "ep-1", host: `127.0.0.1:${s500.port}`, attempt: 1, status: 500, error: "HTTP 500" });
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it("délai dépassé : échec sans code HTTP", async () => {
    const s = await server(() => undefined);
    const d = delivery(s.url());
    const db = fakeDb([]);
    const r = await deliverWebhook(d, { query: db.query, appUrl: APP, allowPrivate: true, timeoutMs: 200 });
    expect(r.ok).toBe(false);
    expect(db.completes).toEqual([[d.id, false, null, "Délai dépassé (0,2 s)"]]);
  });

  it("URL privée refusée sans WEBHOOK_ALLOW_PRIVATE_URLS=1 : aucune requête, échec enregistré", async () => {
    const s = await server((_req, res) => {
      res.writeHead(200).end();
    });
    const plain = delivery(s.url());
    const tls = delivery(`https://127.0.0.1:${s.port}/hook`);
    const db = fakeDb([[plain, tls]]);
    await runWebhookCycle({ query: db.query, appUrl: APP, allowPrivate: false });
    expect(s.received).toHaveLength(0);
    expect(db.completes).toContainEqual([plain.id, false, null, "Seules les URL https:// sont acceptées"]);
    expect(db.completes).toContainEqual([tls.id, false, null, "Adresse refusée : boucle locale (seules les adresses publiques sont acceptées)"]);
  });

  it("ping : data = {}, sans course", async () => {
    const s = await server((_req, res) => {
      res.writeHead(202).end();
    });
    const d = delivery(s.url(), { event_type: "ping", event_status: null, previous_status: null, ride: null });
    const db = fakeDb([[d]]);
    await runWebhookCycle({ query: db.query, appUrl: APP, allowPrivate: true });
    expect(JSON.parse(s.received[0]!.body)).toEqual({ id: d.id, type: "ping", created_at: "2026-10-02T10:00:00.000Z", api_version: "2026-10-01", data: {} });
    expect(s.received[0]!.headers["x-rydar-event"]).toBe("ping");
    expect(db.completes).toEqual([[d.id, true, 202, null]]);
  });

  it(`file continue : ${WEBHOOK_CONCURRENCY} envois au plus, toutes les places occupées, chaque place libérée aussitôt réservée`, async () => {
    let current = 0;
    let max = 0;
    const s = await server(async (req, res) => {
      current++;
      max = Math.max(max, current);
      await sleep(req.url === "/slow" ? 1_500 : 40);
      current--;
      res.writeHead(200).end();
    });
    const slow = delivery(s.url("/slow"), { endpoint_id: "ep-lent" });
    const fast = Array.from({ length: 12 }, () => delivery(s.url("/fast")));
    const db = queueDb([slow, ...fast]);
    const r = await runWebhookCycle({ query: db.query, appUrl: APP, allowPrivate: true });
    expect(r).toEqual({ claimed: 13, delivered: 13, failed: 0 });
    expect(max).toBe(WEBHOOK_CONCURRENCY); // toutes les places servies, jamais plus
    // Première réservation : 5 lignes ; ensuite, une par place libérée pendant que les autres envois continuent
    expect(db.claims[0]).toMatchObject({ limit: WEBHOOK_CONCURRENCY, got: WEBHOOK_CONCURRENCY });
    expect(db.claims.some((c) => c.limit < WEBHOOK_CONCURRENCY && c.got > 0)).toBe(true);
    // Le point de terminaison lent n'a occupé que sa place : les 12 autres envois sont finis avant lui
    const slowDone = db.completes.find((c) => c.id === slow.id)!.at;
    expect(slowDone).toBeGreaterThanOrEqual(1_400);
    expect(db.completes.filter((c) => c.id !== slow.id).every((c) => c.at < slowDone)).toBe(true);
    expect(new Set(db.completes.map((c) => c.id)).size).toBe(13);
  });

  it("réveil pendant un envoi lent : nouvelle réservation dès qu'une place est libre, sans attendre l'envoi lent", async () => {
    const s = await server(async (req, res) => {
      await sleep(req.url === "/slow" ? 1_500 : 20);
      res.writeHead(200).end();
    });
    const slow = delivery(s.url("/slow"), { endpoint_id: "ep-lent", organization_id: "org-lente" });
    const db = queueDb([slow]);
    const dispatcher = createWebhookDispatcher({ query: db.query, appUrl: APP, allowPrivate: true, concurrency: 2 });
    const running = dispatcher.process();
    await sleep(100);
    // Événements d'une autre centrale arrivés pendant l'envoi lent (NOTIFY rydar_webhooks → process())
    const fresh = Array.from({ length: 3 }, () => delivery(s.url("/fast"), { endpoint_id: "ep-sain", organization_id: "org-saine" }));
    db.queue.push(...fresh);
    expect(await dispatcher.process()).toBe(0); // passage en cours : simple réveil
    expect(await running).toBe(4);
    const slowDone = db.completes.find((c) => c.id === slow.id)!.at;
    for (const d of fresh) expect(db.completes.find((c) => c.id === d.id)!.at).toBeLessThan(slowDone - 500);
    // Jamais plus de lignes réservées que de places libres
    expect(db.claims.every((c) => c.limit >= 1 && c.limit <= 2)).toBe(true);
    expect(dispatcher.stats).toMatchObject({ claimed: 4, delivered: 4, failed: 0 });
  });

  it("DNS lent : coupé par le délai de l'essai (un seul délai : DNS, connexion, réponse), la place se libère", async () => {
    const s = await server(async (_req, res) => {
      res.on("error", () => undefined); // client parti au délai : réponse tardive ignorée
      await sleep(250);
      if (!res.destroyed) res.writeHead(200).end();
    });
    const resolve: Resolver = async (host) => {
      if (host === "never.rydar.test") return new Promise<never>(() => undefined); // le résolveur ne répond jamais
      if (host === "slow.rydar.test") await sleep(200);
      return [{ address: "127.0.0.1", family: 4 }];
    };
    const deps = { appUrl: APP, allowPrivate: true, resolve, timeoutMs: 400 };

    const stuck = delivery(`http://never.rydar.test:${s.port}/hook`);
    let db = fakeDb([]);
    const started = Date.now();
    expect(await deliverWebhook(stuck, { ...deps, query: db.query })).toMatchObject({ ok: false, statusCode: null });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(db.completes).toEqual([[stuck.id, false, null, "Délai dépassé (0,4 s) pendant la résolution DNS"]]);
    expect(s.received).toHaveLength(0);

    // DNS 200 ms + réponse 250 ms > 400 ms : échec au délai TOTAL (avant : DNS hors délai, envoi réussi)
    const late = delivery(`http://slow.rydar.test:${s.port}/hook`);
    db = fakeDb([]);
    expect(await deliverWebhook(late, { ...deps, query: db.query })).toMatchObject({ ok: false, statusCode: null, error: "Délai dépassé (0,4 s)" });

    // Dans la file (1 place) : la ligne suivante part dès l'échéance du DNS bloqué
    const next = delivery(`http://fast.rydar.test:${s.port}/hook`);
    const q = queueDb([delivery(`http://never.rydar.test:${s.port}/hook`), next]);
    const t0 = Date.now();
    expect(await runWebhookCycle({ ...deps, query: q.query, concurrency: 1 })).toEqual({ claimed: 2, delivered: 1, failed: 1 });
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(q.completes.find((c) => c.id === next.id)).toMatchObject({ ok: true });
  });

  it("arrêt : plus aucune réservation ni aucun nouvel envoi ; les envois en cours se terminent et sont enregistrés", async () => {
    expect(WEBHOOK_DRAIN_MS).toBeGreaterThan(WEBHOOK_TIMEOUT_MS);
    const s = await server(async (_req, res) => {
      await sleep(400);
      res.writeHead(200).end();
    });
    const a1 = delivery(s.url());
    const a2 = { ...delivery(s.url(), { event_type: "ride.driver_en_route" }), ride: a1.ride }; // même course : après a1
    const b1 = delivery(s.url(), { endpoint_id: "ep-2" });
    const rest = Array.from({ length: 4 }, () => delivery(s.url()));
    const db = queueDb([a1, a2, b1, ...rest]);
    const dispatcher = createWebhookDispatcher({ query: db.query, appUrl: APP, allowPrivate: true, concurrency: 3 });
    const running = dispatcher.process();
    await sleep(150);
    expect(s.received).toHaveLength(2); // a1 et b1 en cours, a2 attend a1
    dispatcher.stop();
    expect(await running).toBe(3);
    expect(db.claims).toHaveLength(1); // aucune réservation après l'arrêt
    // Envois partis : terminés et enregistrés (rien ne repartira en double après le redémarrage)
    expect(db.completes.map((c) => c.id).sort()).toEqual([a1.id, b1.id].sort());
    expect(db.completes.every((c) => c.ok)).toBe(true);
    // a2 jamais parti : reste « sending » jusqu'à la fin de son bail, puis repart (une seule fois)
    expect(s.received).toHaveLength(2);
    expect(db.queue).toHaveLength(4);
    expect(logs).toContainEqual(expect.objectContaining({ level: "info", msg: expect.stringContaining("not started before shutdown"), count: 1 }));
    expect(await dispatcher.process()).toBe(0);
    expect(db.claims).toHaveLength(1);
  });

  it("arrêt pendant une réservation en vol : les lignes rendues partent quand même (pas bloquées 2 min)", async () => {
    const s = await server((_req, res) => {
      res.writeHead(200).end();
    });
    const rows = [delivery(s.url()), delivery(s.url(), { endpoint_id: "ep-2" })];
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const claims: unknown[] = [];
    const completes: unknown[][] = [];
    const query: QueryFn = async (sql, params) => {
      if (sql === CLAIM_SQL) {
        claims.push(params?.[0]);
        await gate;
        return { rows: claims.length === 1 ? rows : [] };
      }
      completes.push(params ?? []);
      return { rows: [{}] };
    };
    const dispatcher = createWebhookDispatcher({ query, appUrl: APP, allowPrivate: true });
    const running = dispatcher.process();
    await sleep(20);
    dispatcher.stop(); // réservation en cours
    open();
    expect(await running).toBe(2);
    expect(claims).toHaveLength(1); // aucune autre réservation
    expect(s.received).toHaveLength(2);
    expect(completes.map((c) => c[0]).sort()).toEqual(rows.map((d) => d.id).sort());
    expect(logs.some((l) => String(l.msg).includes("not started before shutdown"))).toBe(false);
  });

  it("attente d'arrêt : la grâce de docker stop du worker couvre un essai entier et son enregistrement", () => {
    const compose = readFileSync(new URL("../../../deploy/docker-compose.yml", import.meta.url), "utf8");
    // Bloc du service worker : jusqu'au service suivant (deux espaces d'indentation)
    const start = compose.indexOf("\n  worker:\n");
    expect(start).toBeGreaterThan(0);
    const next = compose.slice(start + 1).search(/\n  [a-z][\w-]*:\n/);
    const block = compose.slice(start, next > 0 ? start + 1 + next : undefined);
    const grace = /stop_grace_period:\s*(\d+)s/.exec(block);
    expect(grace).not.toBeNull();
    // index.ts : 1 s (LISTEN) + max(8 s, WEBHOOK_DRAIN_MS) + 1 s (pool), sous la grâce de docker stop
    expect(Number(grace![1]) * 1_000).toBeGreaterThan(1_000 + Math.max(8_000, WEBHOOK_DRAIN_MS) + 1_000);
  });

  it("réservation en erreur pendant un envoi : l'envoi se termine et s'enregistre, puis l'erreur remonte", async () => {
    const s = await server(async (_req, res) => {
      await sleep(300);
      res.writeHead(200).end();
    });
    const d = delivery(s.url());
    const completes: unknown[][] = [];
    let claims = 0;
    const query: QueryFn = async (sql, params) => {
      if (sql === CLAIM_SQL) {
        if (++claims === 1) return { rows: [d] };
        throw new Error("connexion perdue");
      }
      completes.push(params ?? []);
      return { rows: [{}] };
    };
    const signal = new WebhookSignal();
    const cycle = runWebhookCycle({ query, appUrl: APP, allowPrivate: true, signal });
    await sleep(60);
    signal.notify(); // réveil : réservation pendant l'envoi, qui échoue
    await expect(cycle).rejects.toThrow("connexion perdue");
    expect(claims).toBe(2);
    expect(completes).toEqual([[d.id, true, 200, null]]);
  });

  it("même course, même point de terminaison : envois l'un après l'autre, dans l'ordre", async () => {
    const order: string[] = [];
    const s = await server(async (req, res, body) => {
      const type = JSON.parse(body).type as string;
      // Le premier répond lentement : s'il partait en parallèle, le second arriverait avant
      await new Promise((r) => setTimeout(r, type === "ride.accepted" ? 80 : 0));
      order.push(type);
      res.writeHead(200).end();
    });
    const accepted = delivery(s.url());
    const enRoute = { ...delivery(s.url(), { event_type: "ride.driver_en_route" }), ride: accepted.ride };
    const db = fakeDb([[accepted, enRoute]]);
    await runWebhookCycle({ query: db.query, appUrl: APP, allowPrivate: true });
    expect(order).toEqual(["ride.accepted", "ride.driver_en_route"]);
  });

  it("même course réservée en deux fois (réveil pendant l'envoi) : ajoutée à sa file, envoyée après la première", async () => {
    const order: string[] = [];
    const s = await server(async (_req, res, body) => {
      const type = JSON.parse(body).type as string;
      await sleep(type === "ride.accepted" ? 300 : 0);
      order.push(type);
      res.writeHead(200).end();
    });
    const accepted = delivery(s.url());
    const enRoute = { ...delivery(s.url(), { event_type: "ride.driver_en_route" }), ride: accepted.ride };
    const other = delivery(s.url(), { endpoint_id: "ep-2", ride: accepted.ride, event_type: "ride.driver_arrived" });
    const db = fakeDb([[accepted], [enRoute, other]]);
    const signal = new WebhookSignal();
    const cycle = runWebhookCycle({ query: db.query, appUrl: APP, allowPrivate: true, signal });
    await sleep(80);
    signal.notify(); // seconde réservation pendant l'envoi de « accepted »
    expect(await cycle).toEqual({ claimed: 3, delivered: 3, failed: 0 });
    // Autre point de terminaison : en parallèle ; même point de terminaison et même course : après « accepted »
    expect(order).toEqual(["ride.driver_arrived", "ride.accepted", "ride.driver_en_route"]);
    expect(db.completes.map((c) => c[0])).toEqual([other.id, accepted.id, enRoute.id]);
  });

  it("passage long (trafic continu) : bilan journalisé pendant le passage", async () => {
    const s = await server(async (_req, res) => {
      await sleep(60);
      res.writeHead(200).end();
    });
    const db = queueDb(Array.from({ length: 3 }, () => delivery(s.url())));
    const r = await runWebhookCycle({ query: db.query, appUrl: APP, allowPrivate: true, concurrency: 1, progressLogMs: 40 });
    expect(r).toEqual({ claimed: 3, delivered: 3, failed: 0 });
    expect(logs).toContainEqual(expect.objectContaining({ level: "info", msg: "webhooks pass in progress", inFlight: expect.any(Number) }));
  });

  it("recharges regroupées : les places libérées ensemble sont rechargées par une seule réservation", async () => {
    const s = await server(async (_req, res) => {
      await sleep(5);
      res.writeHead(200).end();
    });
    const db = queueDb(Array.from({ length: 30 }, () => delivery(s.url())));
    const r = await runWebhookCycle({ query: db.query, appUrl: APP, allowPrivate: true, refillMs: 50 });
    expect(r).toEqual({ claimed: 30, delivered: 30, failed: 0 });
    // 30 envois de ~5 ms : bien moins d'une réservation par envoi
    expect(db.claims.length).toBeLessThan(20);
  });

  it("résultat non enregistré (base) : erreur journalisée, les autres envois continuent", async () => {
    const s = await server((_req, res) => {
      res.writeHead(200).end();
    });
    const db = fakeDb([[delivery(s.url()), delivery(s.url())]], { completeError: new Error("connexion perdue") });
    const r = await runWebhookCycle({ query: db.query, appUrl: APP, allowPrivate: true });
    expect(r).toEqual({ claimed: 2, delivered: 0, failed: 2 });
    expect(s.received).toHaveLength(2);
    expect(logs.filter((l) => l.level === "error" && l.msg.includes("not saved"))).toHaveLength(2);
  });

  it("fonctions absentes (migration pas appliquée) : un seul avertissement, nouvel essai ensuite", async () => {
    const missing = Object.assign(new Error("function private.claim_webhook_deliveries(integer) does not exist"), { code: "42883" });
    const query = vi.fn(async () => {
      throw missing;
    }) as unknown as QueryFn;
    const dispatcher = createWebhookDispatcher({ query, appUrl: APP, allowPrivate: false });
    expect(await dispatcher.process()).toBe(0);
    expect(await dispatcher.process()).toBe(0);
    expect(await dispatcher.purge()).toBeNull();
    expect(await dispatcher.purge()).toBeNull();
    expect(logs.map((l) => l.level)).toEqual(["warn", "warn"]);
    expect(logs[0]!.msg).toContain("claim_webhook_deliveries() missing");
    expect(logs[1]!.msg).toContain("purge_webhook_deliveries() missing");
    expect(query).toHaveBeenCalledTimes(4);

    const schema = Object.assign(new Error('schema "private" does not exist'), { code: "3F000" });
    const other = createWebhookDispatcher({ query: (async () => Promise.reject(schema)) as QueryFn, appUrl: APP, allowPrivate: false });
    await other.process();
    expect(logs.at(-1)).toMatchObject({ level: "warn" });

    // Autre erreur : journal error à chaque fois
    const broken = createWebhookDispatcher({ query: (async () => Promise.reject(new Error("deadlock detected"))) as QueryFn, appUrl: APP, allowPrivate: false });
    await broken.process();
    expect(logs.at(-1)).toMatchObject({ level: "error", msg: "webhooks failed", error: "deadlock detected" });
    expect(broken.stats.lastError).toBe("deadlock detected");
  });

  it("purge : nombre supprimé journalisé ; réveil pendant un passage → second passage aussitôt ; arrêt", async () => {
    const s = await server((_req, res) => {
      res.writeHead(200).end();
    });
    const db = fakeDb([[delivery(s.url())], [delivery(s.url())]]);
    const dispatcher = createWebhookDispatcher({ query: db.query, appUrl: APP, allowPrivate: true });
    expect(await dispatcher.purge()).toBe(3);
    expect(logs).toContainEqual(expect.objectContaining({ level: "info", msg: "webhook deliveries purged", count: 3 }));

    const running = dispatcher.process();
    expect(await dispatcher.process()).toBe(0); // déjà en cours : relance demandée
    expect(await running).toBe(2);
    expect(db.completes).toHaveLength(2);

    dispatcher.stop();
    expect(await dispatcher.process()).toBe(0);
    expect(await dispatcher.purge()).toBeNull();
  });
});
