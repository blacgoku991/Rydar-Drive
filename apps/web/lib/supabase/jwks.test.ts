import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishesAsymmetricKey, resetJwksCache } from "./jwks";

const URL_ = "https://supabase.test";
const ec = { kty: "EC", crv: "P-256", x: "x", y: "y", kid: "cle-1", alg: "ES256" };

function fetcher(body: unknown, status = 200) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    calls.push(`${input} ${new Headers(init?.headers).get("apikey") ?? ""}`);
    return status === 200 ? Response.json(body) : new Response("erreur", { status });
  });
  return { fn, calls };
}

beforeEach(() => resetJwksCache());
afterEach(() => vi.useRealTimers());

describe("publishesAsymmetricKey", () => {
  it("clé ES256 publiée : true ; JWKS vide (HS256 seul) : false", async () => {
    expect(await publishesAsymmetricKey(URL_, "cle", fetcher({ keys: [ec] }).fn)).toBe(true);
    resetJwksCache();
    expect(await publishesAsymmetricKey(URL_, "cle", fetcher({ keys: [] }).fn)).toBe(false);
    resetJwksCache();
    expect(await publishesAsymmetricKey(URL_, "cle", fetcher({ keys: [{ kty: "oct", kid: "s" }] }).fn)).toBe(false);
  });

  it("lu une seule fois (requêtes simultanées à froid, puis cache), avec la clé apikey", async () => {
    const { fn, calls } = fetcher({ keys: [ec] });
    const all = await Promise.all(Array.from({ length: 20 }, () => publishesAsymmetricKey(URL_, "cle", fn)));
    expect(all.every(Boolean)).toBe(true);
    expect(await publishesAsymmetricKey(URL_, "cle", fn)).toBe(true);
    expect(calls).toEqual([`${URL_}/auth/v1/.well-known/jwks.json cle`]);
  });

  it("relu après 10 min", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { fn } = fetcher({ keys: [] });
    await publishesAsymmetricKey(URL_, "cle", fn);
    vi.setSystemTime(Date.now() + 9 * 60_000);
    await publishesAsymmetricKey(URL_, "cle", fn);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await publishesAsymmetricKey(URL_, "cle", fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("JWKS illisible (erreur HTTP, réseau, contenu) : true (vérification par Auth), réessayé après 30 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const bad = fetcher({}, 503);
    expect(await publishesAsymmetricKey(URL_, "cle", bad.fn)).toBe(true);
    expect(await publishesAsymmetricKey(URL_, "cle", bad.fn)).toBe(true);
    expect(bad.fn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 31_000);
    const ok = fetcher({ keys: [] });
    expect(await publishesAsymmetricKey(URL_, "cle", ok.fn)).toBe(false);

    resetJwksCache();
    expect(await publishesAsymmetricKey(URL_, "cle", async () => { throw new Error("ECONNREFUSED"); })).toBe(true);
    resetJwksCache();
    expect(await publishesAsymmetricKey(URL_, "cle", fetcher({ keys: "non" }).fn)).toBe(true);
  });
});
