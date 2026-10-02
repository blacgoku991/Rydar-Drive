import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// apps/web/proxy.ts : résolution des hôtes de mini-site (validation du Host, cache borné, échecs non mis en cache)
// et redirection /login → /dashboard confirmée auprès d'Auth (session révoquée : pas de boucle).

const h = vi.hoisted(() => ({
  claims: null as null | { sub: string },
  user: null as null | { id: string },
}));

vi.mock("@/lib/geo/cache", async () => await import("./geo/cache"));
vi.mock("@/lib/hostname", async () => await import("./hostname"));
// Appels sortants : fetch global (simulé par le test)
vi.mock("@/lib/server-fetch", () => ({ serverFetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, opts: { cookies: { setAll: (c: unknown[]) => void } }) => ({
    auth: {
      // Clés asymétriques : le jeton est vérifié localement, sans interroger Auth
      getClaims: async () => ({ data: h.claims ? { claims: h.claims } : null, error: null }),
      getUser: async () => {
        if (h.user) return { data: { user: h.user }, error: null };
        // Session révoquée (session_not_found) : auth-js efface les cookies de session
        opts.cookies.setAll([{ name: "sb-test-auth-token", value: "", options: { maxAge: 0, path: "/" } }]);
        return { data: { user: null }, error: { name: "AuthSessionMissingError", message: "Auth session missing!" } };
      },
    },
  }),
}));

vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.test");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.rydar.app");
vi.stubEnv("NEXT_PUBLIC_ROOT_DOMAIN", "rydar.app");

/** Hôte → réponse de /rest/v1/rpc/resolve_booking_host */
const rpc = new Map<string, () => Promise<Response>>();
const calls: { host: string; signal: unknown }[] = [];
const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
  const host = JSON.parse(String(init.body)).p_host as string;
  calls.push({ host, signal: init.signal });
  const handler = rpc.get(host);
  return handler ? handler() : Response.json(null);
});
vi.stubGlobal("fetch", fetchMock);

const { proxy } = await import("../proxy");

const visit = (host: string, path = "/") => proxy(new NextRequest(`http://web:3000${path}`, { headers: { host } }));
const rpcCalls = (host: string) => calls.filter((c) => c.host === host).length;
const rewrittenTo = (res: Response) => res.headers.get("x-middleware-rewrite");

beforeEach(() => {
  h.claims = null;
  h.user = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("proxy.ts : hôtes des mini-sites", () => {
  it("sous-domaine connu → réécrit vers /book/{slug}, avec délai d'expiration sur l'appel", async () => {
    rpc.set("elite.rydar.app", async () => Response.json("elite"));
    const res = await visit("Elite.rydar.app:443", "/reserver");
    expect(new URL(rewrittenTo(res)!).pathname).toBe("/book/elite/reserver");
    expect(calls.at(-1)).toMatchObject({ host: "elite.rydar.app" });
    expect(calls.at(-1)!.signal).toBeInstanceOf(AbortSignal);
  });

  it("Host invalide (géant, caractères interdits, IPv6) : ni appel à Supabase ni cache", async () => {
    const before = calls.length;
    for (const host of [`${"x".repeat(8_000)}.example`, "a_b.example.fr", "[::1]:3000", `${"a".repeat(70)}.fr`]) {
      const res = await visit(host);
      expect(rewrittenTo(res)).toBeNull();
    }
    expect(calls.length).toBe(before);
  });

  it("cache borné : au-delà de 2 000 hôtes, les plus anciens sont évincés (plus de croissance illimitée)", async () => {
    rpc.set("premier.exemple-vtc.fr", async () => Response.json("premier"));
    await visit("premier.exemple-vtc.fr");
    await visit("premier.exemple-vtc.fr");
    expect(rpcCalls("premier.exemple-vtc.fr")).toBe(1); // en cache
    for (let i = 0; i < 2_000; i += 1) await visit(`h${i}.aleatoire.test`);
    const res = await visit("premier.exemple-vtc.fr");
    expect(rpcCalls("premier.exemple-vtc.fr")).toBe(2); // évincé puis résolu à nouveau
    expect(new URL(rewrittenTo(res)!).pathname).toBe("/book/premier");
  });

  it("échec transitoire (Supabase indisponible, erreur réseau) : jamais mis en cache", async () => {
    rpc.set("panne.exemple-vtc.fr", async () => new Response("indisponible", { status: 503 }));
    expect(rewrittenTo(await visit("panne.exemple-vtc.fr"))).toBeNull();
    rpc.set("panne.exemple-vtc.fr", async () => {
      throw new TypeError("fetch failed");
    });
    expect(rewrittenTo(await visit("panne.exemple-vtc.fr"))).toBeNull();
    rpc.set("panne.exemple-vtc.fr", async () => Response.json("revenu"));
    const res = await visit("panne.exemple-vtc.fr");
    expect(rpcCalls("panne.exemple-vtc.fr")).toBe(3);
    expect(new URL(rewrittenTo(res)!).pathname).toBe("/book/revenu");
  });

  it("aucun mini-site : réponse gardée 30 s seulement (site tout juste activé visible rapidement)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T10:00:00Z"));
    await visit("bientot.exemple-vtc.fr");
    vi.setSystemTime(new Date("2026-09-27T10:00:20Z"));
    await visit("bientot.exemple-vtc.fr");
    expect(rpcCalls("bientot.exemple-vtc.fr")).toBe(1);
    rpc.set("bientot.exemple-vtc.fr", async () => Response.json("bientot"));
    vi.setSystemTime(new Date("2026-09-27T10:00:31Z"));
    const res = await visit("bientot.exemple-vtc.fr");
    expect(rpcCalls("bientot.exemple-vtc.fr")).toBe(2);
    expect(new URL(rewrittenTo(res)!).pathname).toBe("/book/bientot");
  });
});

describe("proxy.ts : /login avec une session révoquée", () => {
  it("jeton encore valide mais session révoquée : pas de redirection vers /dashboard (plus de boucle), cookies effacés", async () => {
    h.claims = { sub: "11111111-1111-4111-8111-111111111111" };
    const res = await visit("app.rydar.app", "/login");
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie") ?? "").toMatch(/sb-test-auth-token=;/);
  });

  it("session valide : /login redirige toujours vers /dashboard", async () => {
    h.claims = { sub: "11111111-1111-4111-8111-111111111111" };
    h.user = { id: "11111111-1111-4111-8111-111111111111" };
    const res = await visit("app.rydar.app", "/login");
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/dashboard");
  });

  it("non connecté sur /dashboard : redirection vers /login (inchangé)", async () => {
    const res = await visit("app.rydar.app", "/dashboard/rides");
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });
});
