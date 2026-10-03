import { describe, expect, it, vi } from "vitest";
import { readJson } from "./v1";

// readJson (API v1) : corps borné AVANT d'être mis en mémoire (clé navigateur publique → corps géants possibles).
vi.mock("server-only", () => ({}));
vi.mock("@/lib/api-keys", () => ({ extractApiKey: () => null, hashApiKey: () => "", parseApiKey: () => null, safeEqualHex: () => false }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true, remaining: 1, resetAt: 0 }) }));
vi.mock("@/lib/request", () => ({ ipBucket: (ip: string) => ip, ipFromHeaders: () => null }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const post = (body: BodyInit) => new Request("https://app.test/api/v1/rides", { method: "POST", body, duplex: "half" } as RequestInit);

describe("readJson", () => {
  it("corps trop volumineux : lecture coupée au premier dépassement, 413 (jamais tout le corps en mémoire)", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(16_384).fill(97);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
        if (pulled >= 10_000) controller.close();
      },
    });
    await expect(readJson(post(body), 32_768)).rejects.toMatchObject({ status: 413, code: "PAYLOAD_TOO_LARGE" });
    expect(pulled).toBeLessThan(10);
  });

  it("corps valide (accents compris) lu tel quel ; corps vide → objet vide ; JSON invalide → 400", async () => {
    await expect(readJson(post(JSON.stringify({ client: "Hélène" })))).resolves.toEqual({ client: "Hélène" });
    await expect(readJson(post(""))).resolves.toEqual({});
    await expect(readJson(post("{"))).rejects.toMatchObject({ status: 400, code: "INVALID_JSON" });
  });
});
