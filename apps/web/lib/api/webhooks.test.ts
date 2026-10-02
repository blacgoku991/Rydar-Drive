import { beforeEach, describe, expect, it, vi } from "vitest";

// API publique v1 — gestion des webhooks (permission webhooks:manage) : vraie enveloppe handle()/authenticate(),
// vraies routes, Supabase service role simulé (tables et RPC svc_webhook_*).

const PEPPER = "test-pepper-0123456789abcdef";
const ORG = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "22222222-2222-4222-8222-222222222222";
const HOOK_ID = "55555555-5555-4555-8555-555555555555";

type Row = Record<string, any>;
type Call = { table: string; op: "select" | "insert" | "update"; payload?: Row; filters: [string, unknown][] };

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  rpcs: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResult: null as unknown,
  rpcError: null as { code: string; message: string } | null,
  endpoints: [] as Record<string, unknown>[],
  keyRow: null as Record<string, any> | null,
  keyHash: null as string | null,
  counts: new Map<string, number>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({
  env: { appUrl: "https://app.test" },
  serverEnv: () => ({ apiKeyPepper: "test-pepper-0123456789abcdef" }),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async (key: string, limit: number, windowSec: number) => {
    const n = (h.counts.get(key) ?? 0) + 1;
    h.counts.set(key, n);
    return { ok: n <= limit, remaining: Math.max(0, limit - n), resetAt: Date.now() + windowSec * 1000, limit };
  },
}));
vi.mock("@/lib/api-keys", async () => await import("../api-keys"));
vi.mock("@/lib/api/v1", async () => await import("./v1"));
vi.mock("@/lib/request", async () => await import("../request"));
vi.mock("@/lib/webhooks", async () => await import("../webhooks"));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpcs.push({ fn, args });
      return h.rpcError ? { data: null, error: h.rpcError } : { data: h.rpcResult, error: null };
    },
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      const result = () => {
        if (call.op === "select") h.calls.push(call);
        if (table === "api_keys" && call.op === "select") return { data: h.keyRow, error: null };
        if (table === "api_key_secrets") return { data: h.keyHash ? { key_hash: h.keyHash } : null, error: null };
        if (table === "webhook_endpoints") return { data: h.endpoints, error: null };
        return { data: null, error: null };
      };
      const b: any = {
        select: () => b,
        insert: (p: Row) => ((call.op = "insert"), (call.payload = p), h.calls.push(call), b),
        update: (p: Row) => ((call.op = "update"), (call.payload = p), h.calls.push(call), b),
        eq: (c: string, v: unknown) => (call.filters.push([c, v]), b),
        order: () => b,
        maybeSingle: async () => result(),
        single: async () => result(),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej),
      };
      return b;
    },
  }),
}));

const { generateApiKey, hashApiKey } = await import("../api-keys");
const collection = await import("../../app/api/v1/webhooks/route");
const single = await import("../../app/api/v1/webhooks/[id]/route");
const test = await import("../../app/api/v1/webhooks/[id]/test/route");

let apiKey = "";
function setKey(opts: { scopes?: string[]; origins?: string[] } = {}) {
  const k = generateApiKey("live");
  apiKey = k.key;
  h.keyHash = hashApiKey(k.key, PEPPER);
  h.keyRow = {
    id: KEY_ID,
    organization_id: ORG,
    scopes: opts.scopes ?? ["rides:create", "rides:read", "webhooks:manage"],
    rate_limit_per_minute: 60,
    allowed_origins: opts.origins ?? [],
    expires_at: null,
    revoked_at: null,
    organization: { status: "active", timezone: "Europe/Paris", plan_id: null, limits_override: {}, plan: null },
  };
}

function req(path: string, init: { method?: string; origin?: string; body?: unknown; raw?: string } = {}) {
  const headers = new Headers({ "x-forwarded-for": "203.0.113.10", "content-type": "application/json", authorization: `Bearer ${apiKey}` });
  if (init.origin) headers.set("origin", init.origin);
  const body = init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  return new Request(`https://app.test/api/v1${path}`, { method: init.method ?? "GET", headers, body });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const endpoint = {
  id: HOOK_ID,
  url: "https://www.rydar-prive.fr/api/drive/webhook",
  description: "RYDAR Privé",
  events: [],
  enabled: true,
  disabled_reason: null,
  created_at: "2026-10-01T10:00:00Z",
  last_success_at: null,
  last_failure_at: null,
  last_error: null,
};

beforeEach(() => {
  h.calls = [];
  h.rpcs = [];
  h.rpcResult = null;
  h.rpcError = null;
  h.endpoints = [];
  h.counts.clear();
  setKey();
});

describe("accès", () => {
  it("permission webhooks:manage obligatoire", async () => {
    setKey({ scopes: ["rides:create", "rides:read", "rides:cancel"] });
    const res = await collection.GET(req("/webhooks"));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("INSUFFICIENT_SCOPE");
  });

  it("clé « navigateur » refusée même avec la permission, et aucune route n'expose CORS", async () => {
    const origin = "https://www.centrale.test";
    setKey({ origins: [origin], scopes: ["rides:create", "webhooks:manage"] });
    const res = await collection.POST(req("/webhooks", { method: "POST", origin, body: { url: endpoint.url } }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("INSUFFICIENT_SCOPE");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(h.rpcs).toHaveLength(0);
    expect("OPTIONS" in collection).toBe(false);
    expect("OPTIONS" in single).toBe(false);
    expect("OPTIONS" in test).toBe(false);
  });
});

describe("GET /webhooks", () => {
  it("liste de l'organisation de la clé", async () => {
    h.endpoints = [endpoint];
    const res = await collection.GET(req("/webhooks"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [endpoint] });
    const read = h.calls.find((c) => c.table === "webhook_endpoints")!;
    expect(read.filters).toContainEqual(["organization_id", ORG]);
  });
});

describe("POST /webhooks", () => {
  it("création : 201, secret généré renvoyé une fois, acteur = la clé API", async () => {
    h.rpcResult = { ok: true, created: true, endpoint, secret: `whsec_${"a".repeat(48)}` };
    const res = await collection.POST(req("/webhooks", { method: "POST", body: { url: endpoint.url, description: "RYDAR Privé" } }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: endpoint, secret: `whsec_${"a".repeat(48)}`, created: true });
    expect(h.rpcs).toEqual([
      {
        fn: "svc_webhook_upsert",
        args: {
          p_org: ORG, p_url: endpoint.url, p_description: "RYDAR Privé", p_events: [], p_secret: null,
          p_actor_type: "api", p_actor_id: KEY_ID,
        },
      },
    ]);
    // Le secret n'apparaît jamais dans le journal des requêtes
    const log = h.calls.find((c) => c.table === "api_logs" && c.op === "insert")!.payload!;
    expect(JSON.stringify(log)).not.toContain("whsec_");
  });

  it("adresse déjà enregistrée : 200, created false, secret null", async () => {
    h.rpcResult = { ok: true, created: false, endpoint, secret: null };
    const secret = "s".repeat(40);
    const res = await collection.POST(req("/webhooks", { method: "POST", body: { url: endpoint.url, secret, events: ["ride.completed"] } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: endpoint, secret: null, created: false });
    expect(h.rpcs[0]!.args).toMatchObject({ p_secret: secret, p_events: ["ride.completed"] });
  });

  it("validation : champ inconnu → VALIDATION_ERROR, adresse privée → WEBHOOK_INVALID_URL, sans appel SQL", async () => {
    const extra = await collection.POST(req("/webhooks", { method: "POST", body: { url: endpoint.url, foo: 1 } }));
    expect(extra.status).toBe(422);
    expect((await extra.json()).error.code).toBe("VALIDATION_ERROR");

    const priv = await collection.POST(req("/webhooks", { method: "POST", body: { url: "https://169.254.169.254/latest" } }));
    expect(priv.status).toBe(422);
    const err = (await priv.json()).error;
    expect(err.code).toBe("WEBHOOK_INVALID_URL");
    expect(err.details.url).toBeTruthy();

    const events = await collection.POST(req("/webhooks", { method: "POST", body: { url: endpoint.url, events: ["ride.flying"] } }));
    expect((await events.json()).error.code).toBe("WEBHOOK_INVALID_EVENTS");
    const secret = await collection.POST(req("/webhooks", { method: "POST", body: { url: endpoint.url, secret: "court" } }));
    expect((await secret.json()).error.code).toBe("WEBHOOK_INVALID_SECRET");
    const json = await collection.POST(req("/webhooks", { method: "POST", raw: "{" }));
    expect(json.status).toBe(400);
    expect(h.rpcs).toHaveLength(0);
  });

  it("organization_id dans le corps : 403 audité", async () => {
    const res = await collection.POST(req("/webhooks", { method: "POST", body: { url: endpoint.url, organization_id: ORG } }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN_TENANT_FIELD");
    expect(h.calls.some((c) => c.table === "audit_logs" && c.payload?.action === "security.tenant_field_rejected")).toBe(true);
    expect(h.rpcs).toHaveLength(0);
  });

  it("codes de la base : WEBHOOK_LIMIT → 409, WEBHOOK_INVALID_URL → 422, erreur SQL → 500", async () => {
    h.rpcResult = { ok: false, code: "WEBHOOK_LIMIT", message: "10 webhooks au plus." };
    const limit = await collection.POST(req("/webhooks", { method: "POST", body: { url: endpoint.url } }));
    expect(limit.status).toBe(409);
    expect((await limit.json()).error).toMatchObject({ code: "WEBHOOK_LIMIT", message: "10 webhooks au plus." });

    h.rpcResult = { ok: false, code: "WEBHOOK_INVALID_URL", message: "Adresse refusée." };
    expect((await collection.POST(req("/webhooks", { method: "POST", body: { url: endpoint.url } }))).status).toBe(422);

    h.rpcError = { code: "XX000", message: "boom" };
    const failed = await collection.POST(req("/webhooks", { method: "POST", body: { url: endpoint.url } }));
    expect(failed.status).toBe(500);
  });
});

describe("DELETE /webhooks/{id} et POST /webhooks/{id}/test", () => {
  it("suppression : 204 sans corps ; introuvable : 404", async () => {
    h.rpcResult = { ok: true };
    const res = await single.DELETE(req(`/webhooks/${HOOK_ID}`, { method: "DELETE" }), params(HOOK_ID));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(h.rpcs[0]).toEqual({ fn: "svc_webhook_delete", args: { p_org: ORG, p_id: HOOK_ID, p_actor_type: "api", p_actor_id: KEY_ID } });

    h.rpcResult = { ok: false, code: "WEBHOOK_NOT_FOUND" };
    const missing = await single.DELETE(req(`/webhooks/${HOOK_ID}`, { method: "DELETE" }), params(HOOK_ID));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toMatchObject({ code: "WEBHOOK_NOT_FOUND", message: "Webhook introuvable." });

    const bad = await single.DELETE(req("/webhooks/pas-un-uuid", { method: "DELETE" }), params("pas-un-uuid"));
    expect(bad.status).toBe(404);
    expect(h.rpcs).toHaveLength(2);
  });

  it("test : 202 + delivery_id ; webhook désactivé : 409", async () => {
    h.rpcResult = { ok: true, delivery_id: "66666666-6666-4666-8666-666666666666" };
    const res = await test.POST(req(`/webhooks/${HOOK_ID}/test`, { method: "POST" }), params(HOOK_ID));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ data: { delivery_id: "66666666-6666-4666-8666-666666666666" } });
    expect(h.rpcs[0]!.fn).toBe("svc_webhook_ping");

    h.rpcResult = { ok: false, code: "WEBHOOK_DISABLED" };
    const off = await test.POST(req(`/webhooks/${HOOK_ID}/test`, { method: "POST", body: {} }), params(HOOK_ID));
    expect(off.status).toBe(409);
    expect((await off.json()).error.code).toBe("WEBHOOK_DISABLED");

    const extra = await test.POST(req(`/webhooks/${HOOK_ID}/test`, { method: "POST", body: { force: true } }), params(HOOK_ID));
    expect(extra.status).toBe(422);
  });
});
