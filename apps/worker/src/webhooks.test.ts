import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWebhookDispatcher,
  deliverWebhook,
  deliveryLanes,
  runWebhookCycle,
  WEBHOOK_CLAIM_BATCH,
  WEBHOOK_CONCURRENCY,
  type QueryFn,
} from "./webhooks";
import type { ClaimedWebhook } from "./webhooks/sign";
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

    // Lot incomplet (1 < 20) : une seule réservation
    expect(db.claims).toEqual([[20]]);
    expect(WEBHOOK_CLAIM_BATCH).toBe(20);
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

  it(`envois en parallèle, ${WEBHOOK_CONCURRENCY} au plus ; lot plein → lot suivant réservé`, async () => {
    let current = 0;
    let max = 0;
    const s = await server(async (_req, res) => {
      current++;
      max = Math.max(max, current);
      await new Promise((r) => setTimeout(r, 60));
      current--;
      res.writeHead(200).end();
    });
    const first = Array.from({ length: WEBHOOK_CLAIM_BATCH }, () => delivery(s.url()));
    const second = Array.from({ length: 3 }, () => delivery(s.url()));
    const db = fakeDb([first, second]);
    const r = await runWebhookCycle({ query: db.query, appUrl: APP, allowPrivate: true });
    expect(r).toEqual({ claimed: 23, delivered: 23, failed: 0 });
    expect(db.claims).toHaveLength(2); // second lot incomplet : pas de troisième réservation
    expect(max).toBeLessThanOrEqual(WEBHOOK_CONCURRENCY);
    expect(max).toBeGreaterThan(1);
    expect(new Set(db.completes.map((c) => c[0])).size).toBe(23);
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
    const lanes = deliveryLanes([accepted, enRoute, delivery(s.url(), { endpoint_id: "ep-2", ride: accepted.ride })]);
    expect(lanes.map((l) => l.length)).toEqual([2, 1]);
    const db = fakeDb([[accepted, enRoute]]);
    await runWebhookCycle({ query: db.query, appUrl: APP, allowPrivate: true });
    expect(order).toEqual(["ride.accepted", "ride.driver_en_route"]);
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
