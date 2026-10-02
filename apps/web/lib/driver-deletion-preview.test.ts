import { AuthApiError, AuthSessionMissingError } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Aperçu de la suppression du compte chauffeur (/api/driver/delete-account, { preview: true }) : commissions encore
// dues rappelées avant la confirmation, compte suspendu, banni ou sans session compris (contre-audit app_worker#2).
// Supabase simulé (RPC service role, client anonyme de la route), comme driver-deletion.test.ts.

const h = vi.hoisted(() => ({
  admin: null as unknown,
  anon: null as unknown,
  limits: [] as { key: string; limit: number; windowSec: number }[],
  resets: [] as string[],
  blocked: new Set<string>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server-fetch", () => ({ serverFetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.admin }));
vi.mock("@/lib/env", () => ({ env: { supabaseUrl: "https://supabase.test", supabaseAnonKey: "anon-key" } }));
vi.mock("@/lib/rate-limit", () => {
  const check = (c: { key: string; limit: number; windowSec: number }) => {
    h.limits.push(c);
    return { ok: !h.blocked.has(c.key), remaining: 0, resetAt: 0, limit: c.limit };
  };
  return {
    rateLimit: async (key: string, limit: number, windowSec: number) => check({ key, limit, windowSec }),
    rateLimitAll: async (checks: { key: string; limit: number; windowSec: number }[]) => {
      for (const c of checks) if (!check(c).ok) return { ok: false, remaining: 0, resetAt: 0, limit: c.limit };
      return { ok: true, remaining: 0, resetAt: 0, limit: 0 };
    },
    resetRateLimit: async (key: string) => void h.resets.push(key),
  };
});
vi.mock("@/lib/driver-deletion", async () => await import("./driver-deletion"));
vi.mock("@/lib/driver-session", async () => await import("./driver-session"));
vi.mock("@/lib/driver-app-cors", async () => await import("./driver-app-cors"));
vi.mock("@/lib/request", async () => await import("./request"));
vi.mock("@supabase/supabase-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@supabase/supabase-js")>()),
  createClient: () => h.anon,
}));

const { POST } = await import("../app/api/driver/delete-account/route");

type Row = Record<string, unknown>;
const USER = "33333333-3333-4333-8333-333333333333";
const EMAIL = "chauffeur@test.dev";
const IP = "203.0.113.9";
const DEBT = { owed_cents: 3000, declared_cents: 1200, currency: "EUR", organization: "Taxi Bleu" };

/** Client service role : seules les RPC listées répondent ; appels relevés. */
function fakeAdmin(rpc: Record<string, (args: Row) => { data?: unknown; error?: { message: string } }>) {
  const calls: { fn: string; args: Row }[] = [];
  h.admin = {
    rpc: async (fn: string, args: Row) => {
      calls.push({ fn, args });
      const r = rpc[fn]?.(args) ?? { error: { message: `RPC inattendue : ${fn}` } };
      return { data: r.data ?? null, error: r.error ?? null };
    },
  };
  return calls;
}

/** Client anonyme de la route : jeton (getUser) et mot de passe (signInWithPassword). */
function fakeAnon(opts: { token?: boolean; password?: "ok" | "wrong" | "banned" }) {
  const signIn: Row[] = [];
  h.anon = {
    auth: {
      getUser: async () =>
        opts.token ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: new AuthSessionMissingError() },
      signInWithPassword: async (credentials: Row) => {
        signIn.push(credentials);
        if (opts.password === "ok") return { data: { user: { id: USER }, session: { access_token: "t" } }, error: null };
        const error =
          opts.password === "banned"
            ? new AuthApiError("User is banned", 400, "user_banned")
            : new AuthApiError("Invalid login credentials", 400, "invalid_credentials");
        return { data: { user: null, session: null }, error };
      },
      signOut: async () => ({ error: null }),
    },
  };
  return { signIn };
}

const post = async (body: Row, token?: string) => {
  const res = await POST(
    new Request("https://rydar.test/api/driver/delete-account", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": IP, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Row, headers: res.headers };
};

beforeEach(() => {
  h.limits.length = 0;
  h.resets.length = 0;
  h.blocked.clear();
});

describe("aperçu de la suppression — /api/driver/delete-account { preview: true }", () => {
  it("sans session (écran de connexion) : mot de passe vérifié avec les compteurs de la connexion, montant dû, rien supprimé", async () => {
    const anon = fakeAnon({ password: "ok" });
    const calls = fakeAdmin({ svc_driver_deletion_debt: () => ({ data: DEBT }) });
    const res = await post({ preview: true, email: EMAIL, password: "Secret-2026" });
    expect(res).toMatchObject({ status: 200, body: { ok: true, code: "PREVIEW", debt: DEBT } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(anon.signIn).toEqual([{ email: EMAIL, password: "Secret-2026" }]);
    expect(calls).toEqual([{ fn: "svc_driver_deletion_debt", args: { p_user_id: USER } }]);
    // Mêmes limites que la suppression (IP, couple adresse + IP, adresse) ; budget de suppressions du compte intact
    expect(h.limits.map((l) => l.key)).toEqual([`ddelete:ip:${IP}`, `dloginip:${IP}:${EMAIL}`, `dlogin:email:${EMAIL}`]);
    expect(h.resets).toEqual([`dloginip:${IP}:${EMAIL}`, `dlogin:email:${EMAIL}`]);
  });

  it("compte Auth banni (suspension, bannissement, centrale suspendue) : empreinte vérifiée par la base, montant dû", async () => {
    fakeAnon({ password: "banned" });
    const calls = fakeAdmin({ svc_driver_password_check: () => ({ data: USER }), svc_driver_deletion_debt: () => ({ data: DEBT }) });
    expect(await post({ preview: true, email: EMAIL, password: "Secret-2026" })).toMatchObject({ status: 200, body: { debt: DEBT } });
    expect(calls.map((c) => c.fn)).toEqual(["svc_driver_password_check", "svc_driver_deletion_debt"]);
  });

  it("jeton de l'app : montant dû ; aucune fiche chauffeur : debt null", async () => {
    fakeAnon({ token: true });
    fakeAdmin({ svc_driver_deletion_debt: () => ({ data: DEBT }) });
    expect(await post({ preview: true }, "jeton-app")).toMatchObject({ status: 200, body: { code: "PREVIEW", debt: DEBT } });
    fakeAdmin({ svc_driver_deletion_debt: () => ({ data: null }) });
    expect(await post({ preview: true }, "jeton-app")).toMatchObject({ status: 200, body: { code: "PREVIEW", debt: null } });
  });

  it("jamais de suppression, même accompagné de la confirmation", async () => {
    fakeAnon({ token: true });
    const calls = fakeAdmin({ svc_driver_deletion_debt: () => ({ data: DEBT }) });
    expect(await post({ preview: true, confirm: "SUPPRIMER" }, "jeton-app")).toMatchObject({ status: 200, body: { code: "PREVIEW" } });
    expect(calls.map((c) => c.fn)).toEqual(["svc_driver_deletion_debt"]);
  });

  it("refus : mot de passe faux (401, rien lu), sans session ni mot de passe (401), trop d'essais (429), base en panne (500)", async () => {
    fakeAnon({ password: "wrong" });
    let calls = fakeAdmin({ svc_driver_deletion_debt: () => ({ data: DEBT }) });
    expect(await post({ preview: true, email: EMAIL, password: "mauvais" })).toMatchObject({ status: 401, body: { code: "INVALID_CREDENTIALS" } });
    expect(calls).toEqual([]);
    expect(h.resets).toEqual([]);

    fakeAnon({});
    expect(await post({ preview: true }, "jeton-revoque")).toMatchObject({ status: 401, body: { code: "UNAUTHORIZED" } });
    expect(calls).toEqual([]);

    const anon = fakeAnon({ password: "ok" });
    h.blocked.add(`dloginip:${IP}:${EMAIL}`);
    expect(await post({ preview: true, email: EMAIL, password: "Secret-2026" })).toMatchObject({ status: 429, body: { code: "RATE_LIMITED" } });
    expect(anon.signIn).toEqual([]);
    h.blocked.clear();

    fakeAnon({ token: true });
    calls = fakeAdmin({ svc_driver_deletion_debt: () => ({ error: { message: "connexion perdue" } }) });
    expect(await post({ preview: true }, "jeton-app")).toMatchObject({ status: 500, body: { ok: false, code: "SERVER_ERROR" } });
  });

  it("ni aperçu ni confirmation : 422 inchangé", async () => {
    fakeAnon({ token: true });
    fakeAdmin({});
    expect(await post({ preview: "oui" }, "jeton-app")).toMatchObject({ status: 422, body: { code: "CONFIRMATION_REQUIRED" } });
  });
});
