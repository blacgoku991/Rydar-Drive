// Contre-audit « app » : « Mes courses » d'un gérant qui roule aussi (app_worker#1) ; commissions dues rappelées avant
// la suppression du compte, compte suspendu ou sans session (app_worker#2). Client supabase-js réel ; serveur simulé
// (PostgREST, Supabase Auth, route web de suppression).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const s = {
    handle: (_req: { url: URL; method: string; body: any; auth: string | null }): { status?: number; body?: unknown } => ({ status: 404 }),
    requests: [] as { url: URL; method: string; body: any; auth: string | null }[],
  };
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const raw = typeof init.body === "string" && init.body ? init.body : null;
    const req = {
      url,
      method: (init.method ?? "GET").toUpperCase(),
      body: raw ? JSON.parse(raw) : null,
      auth: new Headers(init.headers).get("authorization"),
    };
    s.requests.push(req);
    const r = s.handle(req);
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? null), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { s, fetch };
});

vi.mock("./config", () => ({
  appConfig: { supabaseUrl: "https://abcdefghijklmnop.supabase.co", supabaseAnonKey: "anon", apiUrl: "https://app.rydar.test" },
}));
vi.mock("./supabase", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const mem = new Map<string, string>();
  const storage = {
    getItem: async (k: string) => mem.get(k) ?? null,
    setItem: async (k: string, v: string) => void mem.set(k, v),
    removeItem: async (k: string) => void mem.delete(k),
  };
  const supabase = createClient("https://abcdefghijklmnop.supabase.co", "anon", {
    auth: { storage, storageKey: "rydar-test-auth", autoRefreshToken: false, persistSession: true, detectSessionInUrl: false },
    global: { fetch: h.fetch as typeof fetch },
  });
  return { supabase };
});

const { api, deletionDebt, previewAccountDeletion } = await import("./api");
const { supabase } = await import("./supabase");
const { myRides } = await import("./planning");

const USER = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const ROUTE = "/api/driver/delete-account";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

/** Session ouverte dans l'app (jeton encore accepté par PostgREST : compte suspendu depuis moins d'une heure…). */
async function signedIn() {
  const user = { id: USER, aud: "authenticated", role: "authenticated", email: "karim@test.dev", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  h.s.handle = (req) => (req.url.pathname === "/auth/v1/user" ? { body: user } : { status: 404 });
  const { error } = await supabase.auth.setSession({ access_token: TOKEN, refresh_token: "rt-1" });
  expect(error).toBeNull();
}

/** PostgREST simulé : filtres eq / in, tri, puis limite — dans cet ordre, comme le serveur. */
function postgrest(url: URL, rows: Record<string, unknown>[]) {
  let out = rows;
  for (const [key, value] of url.searchParams) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    if (value.startsWith("eq.")) out = out.filter((r) => String(r[key]) === value.slice(3));
    else if (value.startsWith("in.(") && value.endsWith(")")) {
      const set = new Set(value.slice(4, -1).split(",").map((v) => v.replace(/^"|"$/g, "")));
      out = out.filter((r) => set.has(String(r[key])));
    } else throw new Error(`filtre non simulé : ${key}=${value}`);
  }
  const [column, dir] = (url.searchParams.get("order") ?? "").split(".");
  if (column) out = [...out].sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (dir === "desc" ? -1 : 1));
  const limit = url.searchParams.get("limit");
  return limit ? out.slice(0, Number(limit)) : out;
}

const at = (hours: number) => new Date(Date.UTC(2026, 9, 1, 6) + hours * 3_600_000).toISOString();
const ride = (id: string, driverId: string, hours: number) => ({ id, driver_id: driverId, type: "scheduled", status: "ACCEPTED", pickup_at: at(hours) });

beforeEach(() => {
  h.s.requests.length = 0;
  vi.stubGlobal("fetch", h.fetch);
});

afterEach(async () => {
  h.s.handle = (req) => (req.url.pathname === "/auth/v1/logout" ? { status: 204 } : { status: 404 });
  await supabase.auth.signOut({ scope: "local" });
  vi.unstubAllGlobals();
});

describe("« Mes courses » (app_worker#1)", () => {
  it("gérant qui roule aussi : ses courses lues malgré 50 courses plus tôt d'autres chauffeurs de sa centrale", async () => {
    // RLS rides_select : un membre de la centrale lit toutes ses courses actives, pas seulement les siennes
    const rows = [...Array.from({ length: 50 }, (_, i) => ride(`autre-${i}`, OTHER, i + 1)), ride("mienne", ME, 100)];
    h.s.handle = (req) => (req.url.pathname === "/rest/v1/rides" ? { body: postgrest(req.url, rows) } : { status: 404 });

    const list = await api.upcoming(ME);
    expect(myRides(list, ME).map((r) => r.id)).toEqual(["mienne"]);
    const [read] = h.s.requests;
    expect(read.url.searchParams.get("driver_id")).toBe(`eq.${ME}`);
    expect(read.url.searchParams.get("limit")).toBe("50");
  });
});

describe("Commissions dues avant la suppression du compte (app_worker#2)", () => {
  const DEBT = { owed_cents: 3000, declared_cents: 1200, currency: "EUR", organization: "Taxi Bleu" };
  const FORBIDDEN = { status: 403, body: { code: "42501", message: "FORBIDDEN: compte chauffeur inactif ou inconnu" } };

  it("compte suspendu (session encore ouverte) : relevé des commissions refusé, montant dû lu quand même", async () => {
    await signedIn();
    h.s.handle = (req) =>
      req.url.pathname === "/rest/v1/rpc/driver_deletion_debt" ? { body: DEBT }
      : req.url.pathname === "/rest/v1/rpc/driver_settlements" ? FORBIDDEN
      : { status: 404 };
    expect(await deletionDebt()).toEqual(DEBT);
    expect(h.s.requests.at(-1)?.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("serveur antérieur sans driver_deletion_debt : relevé des commissions (chauffeur actif)", async () => {
    await signedIn();
    const settlements = {
      currency: "EUR", organization: { name: "Taxi Bleu", phone: null },
      summary: { owed_cents: 3000, overdue_cents: 0, declared_cents: 1200, to_receive_cents: 0, paid_month_cents: 0, received_month_cents: 0, next_due_at: null },
    };
    h.s.handle = (req) =>
      req.url.pathname === "/rest/v1/rpc/driver_deletion_debt"
        ? { status: 404, body: { code: "PGRST202", message: "Could not find the function public.driver_deletion_debt without parameters in the schema cache" } }
        : req.url.pathname === "/rest/v1/rpc/driver_settlements" ? { body: settlements } : { status: 404 };
    expect(await deletionDebt()).toEqual(DEBT);
    // Rien de lisible (réseau, compte inactif sur un serveur antérieur) : aucun avertissement, jamais d'erreur
    h.s.handle = (req) => (req.url.pathname.startsWith("/rest/v1/rpc/") ? FORBIDDEN : { status: 404 });
    expect(await deletionDebt()).toBeNull();
  });

  it("sans session (écran de connexion) : aperçu vérifié par le mot de passe, jamais de confirmation envoyée", async () => {
    h.s.handle = (req) => (req.url.pathname === ROUTE ? { body: { ok: true, code: "PREVIEW", debt: DEBT } } : { status: 404 });
    expect(await previewAccountDeletion("Secret-2026", " Karim@Test.dev ")).toEqual({ debt: DEBT });
    const [req] = h.s.requests;
    expect(req.url.href).toBe(`https://app.rydar.test${ROUTE}`);
    expect(req.body).toEqual({ preview: true, email: "karim@test.dev", password: "Secret-2026" });
    expect(req.auth).toBeNull();

    // Aucune fiche chauffeur : rien à rappeler
    h.s.handle = () => ({ body: { ok: true, code: "PREVIEW", debt: null } });
    expect(await previewAccountDeletion("Secret-2026", "karim@test.dev")).toEqual({ debt: null });
  });

  it("aperçu : erreurs de la suppression (mot de passe faux, trop d'essais) ; serveur antérieur sans aperçu : null", async () => {
    h.s.handle = () => ({ status: 401, body: { ok: false, code: "INVALID_CREDENTIALS", error: "E-mail ou mot de passe incorrect." } });
    await expect(previewAccountDeletion("mauvais", "karim@test.dev")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", message: "E-mail ou mot de passe incorrect." });
    h.s.handle = () => ({ status: 429, body: {} });
    await expect(previewAccountDeletion("Secret-2026", "karim@test.dev")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(previewAccountDeletion()).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    // Route antérieure : elle réclame la confirmation sans rien vérifier ni supprimer — la suppression reste possible
    h.s.handle = () => ({ status: 422, body: { ok: false, code: "CONFIRMATION_REQUIRED", error: "Confirmez la suppression." } });
    expect(await previewAccountDeletion("Secret-2026", "karim@test.dev")).toBeNull();
    expect(h.s.requests.every((r) => r.body?.confirm === undefined)).toBe(true);
  });

  it("session ouverte : aperçu par le jeton de l'app ; la suppression envoie toujours sa confirmation", async () => {
    await signedIn();
    h.s.handle = (req) =>
      req.url.pathname !== ROUTE ? { status: 404 }
      : req.body?.preview ? { body: { ok: true, code: "PREVIEW", debt: DEBT } }
      : { body: { ok: true, code: "DELETED", pending: false, message: "Supprimé." } };
    expect(await previewAccountDeletion()).toEqual({ debt: DEBT });
    const { deleteAccount } = await import("./api");
    expect(await deleteAccount()).toEqual({ code: "DELETED", pending: false, message: "Supprimé." });
    const [preview, deletion] = h.s.requests.filter((r) => r.url.pathname === ROUTE);
    expect(preview).toMatchObject({ body: { preview: true }, auth: `Bearer ${TOKEN}` });
    expect(deletion).toMatchObject({ body: { confirm: "SUPPRIMER" }, auth: `Bearer ${TOKEN}` });
  });
});
