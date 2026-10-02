import { beforeEach, describe, expect, it, vi } from "vitest";

// Appels des RPC svc_webhook_* (lib/webhooks.ts) : statut HTTP de chaque code, texte illisible par PostgreSQL (NUL)
// → 422 et non 500, tests et renvois plafonnés par centrale AVANT la base (compteur partagé dashboard / API).

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  counts: new Map<string, number>(),
  calls: [] as { fn: string; args: Row }[],
  rpcResult: { data: { ok: true }, error: null } as { data: Row | null; error: { code?: string; message: string } | null },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async (key: string, limit: number) => {
    const n = (h.counts.get(key) ?? 0) + 1;
    h.counts.set(key, n);
    return { ok: n <= limit, remaining: Math.max(0, limit - n), resetAt: Date.now() + 30_000, limit };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    async rpc(fn: string, args: Row) {
      h.calls.push({ fn, args });
      return h.rpcResult;
    },
  }),
}));

const { webhookRpc, webhookTestRpc, WEBHOOK_TESTS_PER_MINUTE } = await import("./webhooks");

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const actor = { type: "api" as const, id: "33333333-3333-4333-8333-333333333333" };

beforeEach(() => {
  h.counts.clear();
  h.calls.length = 0;
  h.rpcResult = { data: { ok: true, delivery_id: "d1" }, error: null };
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("webhookRpc", () => {
  it("codes métier : 409 test en attente, 429 plafond SQL (avec Retry-After), 404, 422", async () => {
    const cases: [string, number][] = [
      ["WEBHOOK_TEST_PENDING", 409],
      ["WEBHOOK_TEST_RATE_LIMITED", 429],
      ["WEBHOOK_DISABLED", 409],
      ["WEBHOOK_NOT_FOUND", 404],
      ["WEBHOOK_INVALID_URL", 422],
      ["VALIDATION_ERROR", 422],
    ];
    for (const [code, status] of cases) {
      h.rpcResult = { data: { ok: false, code }, error: null };
      const res = await webhookRpc("svc_webhook_ping", ORG, actor, { p_id: "x" });
      expect(res, code).toMatchObject({ ok: false, code, status });
      if (!res.ok) expect(res.message, code).toBeTruthy();
      if (!res.ok) expect(res.retryAfter, code).toBe(code === "WEBHOOK_TEST_RATE_LIMITED" ? 60 : undefined);
    }
  });

  it("caractère NUL refusé par PostgreSQL (22P05) : 422, jamais 500 ni journal d'erreur", async () => {
    h.rpcResult = { data: null, error: { code: "22P05", message: "unsupported Unicode escape sequence" } };
    const res = await webhookRpc("svc_webhook_upsert", ORG, actor, { p_description: "a\u0000b" });
    expect(res).toMatchObject({ ok: false, code: "VALIDATION_ERROR", status: 422 });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("panne inattendue : 500 WEBHOOK_OPERATION_FAILED, accès refusé : 403", async () => {
    h.rpcResult = { data: null, error: { code: "XX000", message: "boom" } };
    expect(await webhookRpc("svc_webhook_delete", ORG, actor, {})).toMatchObject({ code: "WEBHOOK_OPERATION_FAILED", status: 500 });
    h.rpcResult = { data: null, error: { code: "42501", message: "denied" } };
    expect(await webhookRpc("svc_webhook_delete", ORG, actor, {})).toMatchObject({ code: "FORBIDDEN_TENANT", status: 403 });
  });
});

describe("webhookTestRpc (tests et renvois)", () => {
  it(`${WEBHOOK_TESTS_PER_MINUTE} par minute et par centrale, tests et renvois confondus, puis 429 sans appel à la base`, async () => {
    for (let i = 0; i < WEBHOOK_TESTS_PER_MINUTE; i++) {
      const fn = i % 2 ? "svc_webhook_redeliver" : "svc_webhook_ping";
      expect((await webhookTestRpc(fn, ORG, actor, {})).ok).toBe(true);
    }
    expect(h.calls).toHaveLength(WEBHOOK_TESTS_PER_MINUTE);
    const refused = await webhookTestRpc("svc_webhook_ping", ORG, actor, { p_id: "x" });
    expect(refused).toMatchObject({ ok: false, code: "WEBHOOK_TEST_RATE_LIMITED", status: 429 });
    if (!refused.ok) expect(refused.retryAfter).toBeGreaterThan(0);
    expect(await webhookTestRpc("svc_webhook_redeliver", ORG, actor, {})).toMatchObject({ status: 429 });
    expect(h.calls).toHaveLength(WEBHOOK_TESTS_PER_MINUTE);
    // Une autre centrale n'est pas touchée
    expect((await webhookTestRpc("svc_webhook_ping", OTHER, actor, {})).ok).toBe(true);
  });
});
