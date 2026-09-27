import { AuthApiError } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Connexion de l'application chauffeur (/api/auth/driver-login), code « mot de passe oublié »
// (/api/auth/driver-password-reset/confirm) et contrôle du compte (lib/driver-session.ts), Supabase simulé.

const h = vi.hoisted(() => ({
  /** Client anonyme simulé (signInWithPassword, verifyOtp, signOut) */
  anon: null as unknown,
  /** Fiche chauffeur lue en service role, RPC svc_driver_password_check */
  driverRow: null as Record<string, unknown> | null,
  passwordCheck: null as string | null,
  rpc: [] as { fn: string; args: unknown }[],
  limits: [] as { key: string; limit: number; windowSec: number }[],
  resets: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: { supabaseUrl: "https://supabase.test", supabaseAnonKey: "anon-key" } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: h.driverRow, error: null }) };
      return b;
    },
    rpc: async (fn: string, args: unknown) => {
      h.rpc.push({ fn, args });
      return { data: h.passwordCheck, error: null };
    },
  }),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimitAll: async (checks: { key: string; limit: number; windowSec: number }[]) => {
    h.limits.push(...checks);
    return { ok: true, remaining: 1, resetAt: 0, limit: 1 };
  },
  resetRateLimit: async (key: string) => void h.resets.push(key),
}));
vi.mock("@/lib/driver-session", async () => await import("./driver-session"));
vi.mock("@/lib/driver-app-cors", async () => await import("./driver-app-cors"));
vi.mock("@/lib/request", () => ({
  ipFromHeaders: (hd: Headers) => hd.get("x-forwarded-for"),
  clientIp: async () => "198.51.100.7",
}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: () => undefined }));
vi.mock("@supabase/supabase-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@supabase/supabase-js")>()),
  createClient: () => h.anon,
}));

const { checkDriverAccount } = await import("./driver-session");
const { POST: login } = await import("../app/api/auth/driver-login/route");
const { POST: confirm } = await import("../app/api/auth/driver-password-reset/confirm/route");

const USER = "33333333-3333-4333-8333-333333333333";
const EMAIL = "kevin@test.dev";
const IP = "203.0.113.9";
type Row = Record<string, any>;

const banned = () => new AuthApiError("User is banned", 400, "user_banned");
function fakeAnon(signIn: () => { user: { id: string } | null; error: unknown }) {
  const calls = { signOut: [] as unknown[] };
  h.anon = {
    auth: {
      signInWithPassword: async () => {
        const r = signIn();
        return { data: { user: r.user, session: r.user ? { access_token: "a", refresh_token: "r", expires_at: 1 } : null }, error: r.error };
      },
      verifyOtp: async () => ({ data: { user: null, session: null }, error: banned() }),
      signOut: async (o: unknown) => void calls.signOut.push(o),
    },
  };
  return calls;
}
const call = async (route: (req: Request) => Promise<Response>, path: string, body: Row) => {
  const res = await route(
    new Request(`https://rydar.test${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": IP }, body: JSON.stringify(body) }),
  );
  return { status: res.status, body: (await res.json()) as Row };
};
const post = (password = "Secret-2026") => call(login, "/api/auth/driver-login", { email: EMAIL, password });
const row = (over: Row = {}) => ({ id: "d1", status: "active", application_status: null, banned_at: null, deleted_at: null, organization: { status: "active" }, ...over });

beforeEach(() => {
  h.driverRow = null;
  h.passwordCheck = null;
  h.rpc.length = 0;
  h.limits.length = 0;
  h.resets.length = 0;
});

describe("connexion chauffeur : compte Auth banni", () => {
  it("mauvais mot de passe : même réponse qu'un compte non sanctionné (401), aucun oracle", async () => {
    fakeAnon(() => ({ user: null, error: banned() }));
    h.passwordCheck = null;
    expect(await post("mauvais")).toMatchObject({ status: 401, body: { code: "INVALID_CREDENTIALS" } });
    expect(h.rpc).toEqual([{ fn: "svc_driver_password_check", args: { p_email: EMAIL, p_password: "mauvais" } }]);
  });

  it("bon mot de passe : vrai motif de la fiche (inactif, centrale suspendue), BANNED seulement si banni", async () => {
    fakeAnon(() => ({ user: null, error: banned() }));
    h.passwordCheck = USER;
    h.driverRow = row({ status: "suspended" });
    expect(await post()).toMatchObject({ status: 403, body: { code: "INACTIVE" } });
    h.driverRow = row({ organization: { status: "suspended" } });
    expect(await post()).toMatchObject({ status: 403, body: { code: "ORGANIZATION_SUSPENDED" } });
    h.driverRow = row({ banned_at: "2026-09-01T00:00:00Z", status: "suspended" });
    expect(await post()).toMatchObject({ status: 403, body: { code: "BANNED" } });
    // Fiche en règle mais compte bloqué au niveau Auth (bannissement plateforme) : BANNED
    h.driverRow = row();
    expect(await post()).toMatchObject({ status: 403, body: { code: "BANNED" } });
  });
});

describe("connexion chauffeur : limites et sessions", () => {
  it("compteur strict par (adresse, IP) + plafond global de l'adresse, remis à zéro par une connexion réussie", async () => {
    fakeAnon(() => ({ user: { id: USER }, error: null }));
    h.driverRow = row();
    expect(await post()).toMatchObject({ status: 200, body: { state: "active" } });
    expect(h.limits).toEqual([
      { key: `dlogin:ip:${IP}`, limit: 30, windowSec: 900 },
      { key: `dloginip:${IP}:${EMAIL}`, limit: 6, windowSec: 900 },
      { key: `dlogin:email:${EMAIL}`, limit: 50, windowSec: 900 },
    ]);
    expect(h.resets).toEqual([`dloginip:${IP}:${EMAIL}`, `dlogin:email:${EMAIL}`]);
  });

  it("refus (compte de gestion, fiche inactive) : seule la session de vérification est fermée (scope local)", async () => {
    const anon = fakeAnon(() => ({ user: { id: USER }, error: null }));
    h.driverRow = null;
    expect(await post()).toMatchObject({ status: 403, body: { code: "NOT_DRIVER" } });
    expect(anon.signOut).toEqual([{ scope: "local" }]);
    const again = fakeAnon(() => ({ user: { id: USER }, error: null }));
    h.driverRow = row({ status: "inactive" });
    expect(await checkDriverAccount(h.anon as never, USER)).toMatchObject({ ok: false, code: "INACTIVE" });
    expect(again.signOut).toEqual([{ scope: "local" }]);
  });
});

describe("code « mot de passe oublié » : compte Auth banni", () => {
  it("même réponse qu'un code faux (400 OTP_INVALID), jamais BANNED", async () => {
    fakeAnon(() => ({ user: null, error: null }));
    const res = await call(confirm, "/api/auth/driver-password-reset/confirm", { email: EMAIL, code: "123456", password: "Nouveau-Secret-2026" });
    expect(res).toMatchObject({ status: 400, body: { code: "OTP_INVALID" } });
    expect(h.limits.map((l) => [l.key, l.limit])).toEqual([
      ["dresetc:ip:198.51.100.7", 20],
      ["dresetcip:198.51.100.7:" + EMAIL, 8],
      [`dresetc:email:${EMAIL}`, 30],
    ]);
  });
});
