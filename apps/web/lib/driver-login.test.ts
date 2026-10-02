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
  /** Compteurs réels (fenêtre fixe) : null = aucune limite n'est atteinte */
  counts: null as Map<string, number> | null,
  /** IP lue par clientIp() (demande de code, confirmation) */
  ip: "198.51.100.7",
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server-fetch", () => ({ serverFetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) }));
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
  // Comme lib/rate-limit.ts : limites vérifiées dans l'ordre, arrêt à la première dépassée (les suivantes ne comptent pas)
  rateLimitAll: async (checks: { key: string; limit: number; windowSec: number }[]) => {
    let last = { ok: true, remaining: 1, resetAt: Date.now() + 60_000, limit: 1 };
    for (const c of checks) {
      h.limits.push(c);
      const n = (h.counts?.get(c.key) ?? 0) + 1;
      h.counts?.set(c.key, n);
      last = { ok: !h.counts || n <= c.limit, remaining: 0, resetAt: Date.now() + 60_000, limit: c.limit };
      if (!last.ok) return last;
    }
    return last;
  },
  resetRateLimit: async (key: string) => {
    h.resets.push(key);
    h.counts?.delete(key);
  },
}));
vi.mock("@/lib/driver-session", async () => await import("./driver-session"));
vi.mock("@/lib/driver-app-cors", async () => await import("./driver-app-cors"));
vi.mock("@/lib/request", async () => ({
  ...(await import("./request")),
  ipFromHeaders: (hd: Headers) => hd.get("x-forwarded-for"),
  clientIp: async () => h.ip,
}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: () => undefined }));
vi.mock("@supabase/supabase-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@supabase/supabase-js")>()),
  createClient: () => h.anon,
}));

const { checkDriverAccount } = await import("./driver-session");
const { POST: login } = await import("../app/api/auth/driver-login/route");
const { POST: confirm } = await import("../app/api/auth/driver-password-reset/confirm/route");
const { POST: requestReset } = await import("../app/api/auth/driver-password-reset/route");

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
const call = async (route: (req: Request) => Promise<Response>, path: string, body: Row, ip = IP) => {
  const res = await route(
    new Request(`https://rydar.test${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) }),
  );
  return { status: res.status, body: (await res.json()) as Row };
};
const post = (password = "Secret-2026", ip = IP) => call(login, "/api/auth/driver-login", { email: EMAIL, password }, ip);
const row = (over: Row = {}) => ({ id: "d1", status: "active", application_status: null, banned_at: null, deleted_at: null, organization: { status: "active" }, ...over });

beforeEach(() => {
  h.driverRow = null;
  h.passwordCheck = null;
  h.rpc.length = 0;
  h.limits.length = 0;
  h.resets.length = 0;
  h.counts = null;
  h.ip = "198.51.100.7";
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
      [`dresetc:email:${EMAIL}`, 60],
    ]);
  });
});

// Un tiers qui connaît l'adresse d'un chauffeur ne doit pas pouvoir le bloquer : IP regroupée (IPv6 par /64, ipBucket)
// dans les clés IP et (adresse, IP), plafond global de l'adresse hors de portée de quelques IP (contre-audit
// web_comptes#4).
describe("limites : IP regroupée et plafonds globaux par adresse", () => {
  /** Adresses IPv6 toutes différentes, dans le même /64 */
  const v6 = (n: number) => `2001:db8:66:1:${n.toString(16)}:0:0:1`;
  const BUCKET = "2001:0db8:0066:0001::/64";
  const wrongPassword = () => ({ user: null, error: new AuthApiError("Invalid login credentials", 400, "invalid_credentials") });
  const statuses = async (n: number, attempt: (i: number) => Promise<{ status: number }>) => {
    const out: number[] = [];
    for (let i = 1; i <= n; i++) out.push((await attempt(i)).status);
    return out;
  };

  it("connexion : un tiers qui change d'adresse dans son /64 est arrêté au 7e essai ; le chauffeur se connecte", async () => {
    h.counts = new Map();
    fakeAnon(wrongPassword);
    const tries = await statuses(60, (i) => post("mauvais", v6(i)));
    expect(tries.slice(0, 6)).toEqual(Array(6).fill(401));
    expect(new Set(tries.slice(6))).toEqual(new Set([429]));
    expect(new Set(h.limits.filter((l) => !l.key.startsWith("dlogin:email:")).map((l) => l.key))).toEqual(
      new Set([`dlogin:ip:${BUCKET}`, `dloginip:${BUCKET}:${EMAIL}`]),
    );
    // Le chauffeur, depuis son téléphone : le plafond global de l'adresse n'a compté que 6 essais
    fakeAnon(() => ({ user: { id: USER }, error: null }));
    h.driverRow = row();
    expect(await post()).toMatchObject({ status: 200, body: { state: "active" } });
    expect(h.resets).toEqual([`dloginip:${IP}:${EMAIL}`, `dlogin:email:${EMAIL}`]);
  });

  it("demande de code : ni une rotation IPv6 ni deux IP du tiers ne bloquent la demande du chauffeur", async () => {
    h.counts = new Map();
    const ask = () => call(requestReset, "/api/auth/driver-password-reset", { email: EMAIL });
    const rotated = await statuses(12, (i) => ((h.ip = v6(i)), ask()));
    expect(rotated.slice(0, 3)).toEqual([200, 200, 200]);
    expect(new Set(rotated.slice(3))).toEqual(new Set([429]));
    expect(new Set(h.limits.filter((l) => !l.key.startsWith("dreset:email:")).map((l) => l.key))).toEqual(
      new Set([`dreset:ip:${BUCKET}`, `dresetip:${BUCKET}:${EMAIL}`]),
    );
    for (const ip of ["198.51.100.66", "198.51.100.67"]) {
      h.ip = ip;
      expect(await statuses(4, ask)).toEqual([200, 200, 200, 429]);
    }
    h.ip = "203.0.113.9";
    expect(await ask()).toMatchObject({ status: 200, body: { ok: true } });
    expect(h.limits.find((l) => l.key === `dreset:email:${EMAIL}`)).toMatchObject({ limit: 20, windowSec: 3600 });
  });

  it("code reçu : quatre IP du tiers ne bloquent pas la saisie du chauffeur ; compteurs par /64", async () => {
    h.counts = new Map();
    fakeAnon(() => ({ user: null, error: null }));
    const enter = () => call(confirm, "/api/auth/driver-password-reset/confirm", { email: EMAIL, code: "12345678", password: "Nouveau-Secret-2026" });
    const rotated = await statuses(12, (i) => ((h.ip = v6(i)), enter()));
    expect(rotated.slice(0, 8)).toEqual(Array(8).fill(400));
    expect(new Set(rotated.slice(8))).toEqual(new Set([429]));
    expect(new Set(h.limits.filter((l) => !l.key.startsWith("dresetc:email:")).map((l) => l.key))).toEqual(
      new Set([`dresetc:ip:${BUCKET}`, `dresetcip:${BUCKET}:${EMAIL}`]),
    );
    for (const ip of ["198.51.100.66", "198.51.100.67", "198.51.100.68", "198.51.100.69"]) {
      h.ip = ip;
      expect((await statuses(9, enter)).at(-1)).toBe(429);
    }
    h.ip = "203.0.113.9";
    expect(await enter()).toMatchObject({ status: 400, body: { code: "OTP_INVALID" } });
  });
});
