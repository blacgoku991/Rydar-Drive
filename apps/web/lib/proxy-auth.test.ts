import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// apps/web/proxy.ts avec le VRAI client @supabase/ssr / auth-js (seul le réseau est simulé) : aiguillage sans appel à
// Auth pour les jetons HS256 d'une pile en HS256 seul (JWKS vide : pile locale), vérification sur place des jetons à
// clé asymétrique (production : ES256 + JWKS), jeton HS256 en production vérifié par Auth (refusé dès le proxy s'il est
// falsifié), getUser() gardé sur /login, rafraîchissement d'un jeton expiré toujours fait par le proxy.

const SUB = "11111111-1111-4111-8111-111111111111";
const h = vi.hoisted(() => ({
  calls: [] as string[],
  jwks: [] as JsonWebKey[],
  /** Statut HTTP du JWKS (500 : Auth injoignable) */
  jwksStatus: 200,
  /** /auth/v1/user : session encore valide côté Auth ? */
  userOk: true,
  /** Réponse de /auth/v1/token (rafraîchissement) */
  refreshed: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/geo/cache", async () => await import("./geo/cache"));
vi.mock("@/lib/hostname", async () => await import("./hostname"));
vi.mock("@/lib/supabase/jwt", async () => await import("./supabase/jwt"));
vi.mock("@/lib/supabase/jwks", async () => await import("./supabase/jwks"));
vi.mock("@/lib/server-fetch", () => ({
  serverFetch: async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    h.calls.push(url.pathname);
    if (url.pathname === "/auth/v1/.well-known/jwks.json") {
      return h.jwksStatus === 200 ? Response.json({ keys: h.jwks }) : new Response("indisponible", { status: h.jwksStatus });
    }
    if (url.pathname === "/auth/v1/user") {
      return h.userOk
        ? Response.json({ id: SUB, aud: "authenticated", role: "authenticated", email: "gerant@rydar.test" })
        : Response.json({ code: 403, error_code: "session_not_found", msg: "Session from session_id claim in JWT does not exist" }, { status: 403 });
    }
    if (url.pathname === "/auth/v1/token" && h.refreshed) return Response.json(h.refreshed);
    return new Response("{}", { status: 404 });
  },
}));

vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.test");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.rydar.app");
vi.stubEnv("NEXT_PUBLIC_ROOT_DOMAIN", "rydar.app");

const { proxy } = await import("../proxy");
const { resetJwksCache } = await import("./supabase/jwks");

const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

const es = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", es.publicKey)), kid: "cle-1", alg: "ES256", use: "sig" };

async function esToken(payload: Record<string, unknown>, key: CryptoKey = es.privateKey) {
  const input = `${b64({ alg: "ES256", typ: "JWT", kid: "cle-1" })}.${b64(payload)}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(sig).toString("base64url")}`;
}
/** HS256 : signature quelconque, le proxy ne peut pas la vérifier sans appeler Auth. */
const hsToken = (payload: Record<string, unknown>) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.${b64("signature")}`;
const claims = (exp = now() + 3600) => ({ sub: SUB, role: "authenticated", aud: "authenticated", exp, session_id: "s1" });

/** Cookie de session au format @supabase/ssr (sb-<hôte>-auth-token, base64url). */
function sessionCookie(accessToken: string, exp: number) {
  const session = { access_token: accessToken, refresh_token: "rt-1", expires_at: exp, expires_in: 3600, token_type: "bearer", user: { id: SUB } };
  return `sb-supabase-auth-token=base64-${b64(session)}`;
}

const visit = (path: string, cookie?: string) =>
  proxy(new NextRequest(`https://app.rydar.app${path}`, { headers: { host: "app.rydar.app", ...(cookie ? { cookie } : {}) } }));
const location = (res: Response) => (res.headers.get("location") ? new URL(res.headers.get("location")!).pathname : null);
const nextParam = (res: Response) => (res.headers.get("location") ? new URL(res.headers.get("location")!).searchParams.get("next") : null);
const authCalls = (path: string) => h.calls.filter((c) => c === path).length;

beforeEach(() => {
  h.calls.length = 0;
  h.jwks = [publicJwk];
  h.jwksStatus = 200;
  h.userOk = true;
  h.refreshed = null;
  resetJwksCache();
});

describe("proxy : pile en HS256 seul (JWKS vide, pile locale)", () => {
  beforeEach(() => {
    h.jwks = [];
  });

  it("pages protégées et préchargements : aucun appel à /auth/v1/user, JWKS lu une fois, pas de redirection", async () => {
    const exp = now() + 3600;
    const cookie = sessionCookie(hsToken(claims(exp)), exp);
    for (let i = 0; i < 25; i++) expect(location(await visit("/dashboard/rides", cookie))).toBeNull();
    expect(authCalls("/auth/v1/user")).toBe(0);
    expect(authCalls("/auth/v1/.well-known/jwks.json")).toBe(1);
    expect(h.calls.length).toBe(1);
  });

  it("/login connecté : UN appel à Auth (getUser qui fait foi), puis /dashboard", async () => {
    const exp = now() + 3600;
    const res = await visit("/login", sessionCookie(hsToken(claims(exp)), exp));
    expect(location(res)).toBe("/dashboard");
    expect(authCalls("/auth/v1/user")).toBe(1);
  });

  it("/login avec une session révoquée : la page de connexion s'affiche, cookies effacés (pas de boucle)", async () => {
    h.userOk = false;
    const exp = now() + 3600;
    const res = await visit("/login", sessionCookie(hsToken(claims(exp)), exp));
    expect(location(res)).toBeNull();
    expect(res.headers.get("set-cookie") ?? "").toMatch(/sb-supabase-auth-token=;/);
  });

  it("jeton expiré : rafraîchi par le proxy (cookies réécrits), comme avant", async () => {
    const old = now() - 60;
    const exp = now() + 3600;
    h.refreshed = { access_token: hsToken(claims(exp)), refresh_token: "rt-2", expires_at: exp, expires_in: 3600, token_type: "bearer", user: { id: SUB } };
    const res = await visit("/dashboard", sessionCookie(hsToken(claims(old)), old));
    expect(location(res)).toBeNull();
    expect(authCalls("/auth/v1/token")).toBe(1);
    expect(res.headers.get("set-cookie") ?? "").toMatch(/sb-supabase-auth-token=base64-/);
  });
});

describe("proxy : jeton HS256 alors que le JWKS publie une clé ES256 (production)", () => {
  it("jeton HS256 falsifié : refusé dès le proxy (Auth consulté), /login?next= gardé", async () => {
    h.userOk = false;
    const exp = now() + 3600;
    const res = await visit("/dashboard/rides", sessionCookie(hsToken(claims(exp)), exp));
    expect(location(res)).toBe("/login");
    expect(nextParam(res)).toBe("/dashboard/rides");
    expect(authCalls("/auth/v1/user")).toBe(1);
  });

  it("jeton sans algorithme (alg none) : refusé dès le proxy", async () => {
    h.userOk = false;
    const exp = now() + 3600;
    const token = `${b64({ alg: "none", typ: "JWT" })}.${b64(claims(exp))}.`;
    const res = await visit("/admin", sessionCookie(token, exp));
    expect(location(res)).toBe("/login");
    expect(nextParam(res)).toBe("/admin");
  });

  it("jeton HS256 légitime (émis avant une rotation des clés) : confirmé par Auth, pas de redirection", async () => {
    const exp = now() + 3600;
    const cookie = sessionCookie(hsToken(claims(exp)), exp);
    for (let i = 0; i < 3; i++) expect(location(await visit("/dashboard", cookie))).toBeNull();
    expect(authCalls("/auth/v1/user")).toBe(3);
    expect(authCalls("/auth/v1/.well-known/jwks.json")).toBe(1);
  });

  it("JWKS illisible : prudence, le jeton HS256 est vérifié par Auth", async () => {
    h.jwksStatus = 500;
    h.userOk = false;
    const exp = now() + 3600;
    const res = await visit("/dashboard", sessionCookie(hsToken(claims(exp)), exp));
    expect(location(res)).toBe("/login");
    expect(authCalls("/auth/v1/user")).toBe(1);
  });
});

describe("proxy : jeton ES256 + JWKS (production)", () => {
  it("signature vérifiée sur place : JWKS lu une fois pour le processus, jamais /auth/v1/user", async () => {
    const exp = now() + 3600;
    const cookie = sessionCookie(await esToken(claims(exp)), exp);
    for (let i = 0; i < 25; i++) expect(location(await visit("/dashboard", cookie))).toBeNull();
    expect(authCalls("/auth/v1/.well-known/jwks.json")).toBeLessThanOrEqual(1);
    expect(authCalls("/auth/v1/user")).toBe(0);
  });

  it("signature falsifiée (autre clé, même kid) : redirection vers /login, sans appel à /auth/v1/user", async () => {
    const exp = now() + 3600;
    const res = await visit("/admin/organizations", sessionCookie(await esToken(claims(exp), other.privateKey), exp));
    expect(location(res)).toBe("/login");
    expect(authCalls("/auth/v1/user")).toBe(0);
  });

  it("/login connecté : getUser confirme toujours la session", async () => {
    const exp = now() + 3600;
    const res = await visit("/login", sessionCookie(await esToken(claims(exp)), exp));
    expect(location(res)).toBe("/dashboard");
    expect(authCalls("/auth/v1/user")).toBe(1);
  });
});

describe("proxy : sans session", () => {
  it("/dashboard → /login, sans aucun appel réseau", async () => {
    const res = await visit("/dashboard/rides");
    expect(location(res)).toBe("/login");
    expect(h.calls).toEqual([]);
  });

  it("cookie illisible : traité comme sans session", async () => {
    const res = await visit("/dashboard", "sb-supabase-auth-token=base64-bm9uLWpzb24");
    expect(location(res)).toBe("/login");
  });
});
