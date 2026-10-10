// Agenda (docs/FLOTTE-PRIVEE.md § 10.5) : driver_agenda sur la fenêtre de la vue ; serveur antérieur (PGRST202) : repli
// sur driver_rides_upcoming (à venir seulement, sans réservations à traiter), puis plus d'appel pendant 10 min ;
// « La prendre » (driver_take_ride) et « Annuler la réservation » (cancel_ride). Client supabase-js réel ; PostgREST
// simulé.
import { fetchWindow } from "@rydar/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const s = {
    handle: (_req: { url: URL; method: string; body: any }): { status?: number; body?: unknown } => ({ status: 404 }),
    requests: [] as { url: URL; method: string; body: any }[],
  };
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const raw = typeof init.body === "string" && init.body ? init.body : null;
    const req = { url, method: (init.method ?? "GET").toUpperCase(), body: raw ? JSON.parse(raw) : null };
    s.requests.push(req);
    const r = s.handle(req);
    return new Response(JSON.stringify(r.body ?? null), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
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
    auth: { storage, storageKey: "rydar-test-agenda", autoRefreshToken: false, persistSession: true, detectSessionInUrl: false },
    global: { fetch: h.fetch as typeof fetch },
  });
  return { supabase };
});

const { api, resetRpcFallbacks } = await import("./api");

const ME = "22222222-2222-4222-8222-222222222222";
const RPC = "/rest/v1/rpc/";
const missing = (fn: string) => ({ status: 404, body: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` } });
const ride = (id: string, status = "ACCEPTED") => ({ id, number: 1042, type: "scheduled", status, pickup_at: "2026-10-14T06:30:00Z", network: null });
const booking = { ...ride("b1", "OFFERED"), offer_id: "o1", offer_expires_at: "2026-10-14T05:30:00Z", state: "to_confirm" };
const span = fetchWindow("month", "2026-10-13");

beforeEach(() => {
  h.s.requests.length = 0;
  resetRpcFallbacks();
  vi.stubGlobal("fetch", h.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api.agenda", () => {
  it("driver_agenda sur la fenêtre de la vue (44 jours au plus, sous la borne SQL de 62) : courses, fuseau, réservations à traiter", async () => {
    h.s.handle = (req) =>
      req.url.pathname === `${RPC}driver_agenda`
        ? { body: { timezone: "Europe/Paris", private_fleet: true, from: req.body.p_from, to: req.body.p_to, rides: [ride("r1")], unassigned: [booking] } }
        : { status: 404 };
    const read = await api.agenda(span.from, span.to, ME);
    expect(read).toEqual({ timezone: "Europe/Paris", privateFleet: true, rides: [ride("r1")], unassigned: [booking], legacy: false });
    const [req] = h.s.requests;
    expect(req!.body).toEqual({ p_from: "2026-09-27T00:00:00.000Z", p_to: "2026-11-10T00:00:00.000Z" });
    expect((Date.parse(span.to) - Date.parse(span.from)) / 86_400_000).toBe(44);
  });

  it("chauffeur standard : réservations à traiter absentes (null) ; clés manquantes : listes vides", async () => {
    h.s.handle = () => ({ body: { timezone: "Europe/Paris", private_fleet: false, from: span.from, to: span.to, rides: null, unassigned: null } });
    expect(await api.agenda(span.from, span.to, ME)).toEqual({ timezone: "Europe/Paris", privateFleet: false, rides: [], unassigned: null, legacy: false });
  });

  it("serveur sans driver_agenda : repli sur driver_rides_upcoming (à venir seulement), puis plus d'appel pendant 10 min", async () => {
    h.s.handle = (req) =>
      req.url.pathname === `${RPC}driver_agenda` ? missing("driver_agenda")
      : req.url.pathname === `${RPC}driver_rides_upcoming` ? { body: [ride("r2")] }
      : { status: 404 };
    expect(await api.agenda(span.from, span.to, ME)).toEqual({ timezone: null, privateFleet: false, rides: [ride("r2")], unassigned: null, legacy: true });
    expect(await api.agenda(span.from, span.to, ME)).toMatchObject({ legacy: true });
    expect(h.s.requests.map((r) => r.url.pathname)).toEqual([`${RPC}driver_agenda`, `${RPC}driver_rides_upcoming`, `${RPC}driver_rides_upcoming`]);
  });

  it("autre erreur (réseau, période refusée) : jamais de repli, l'écran garde sa dernière vue", async () => {
    h.s.handle = () => ({ status: 400, body: { code: "22023", message: "AGENDA_RANGE_INVALID: période d'agenda invalide (62 jours au plus, fin après le début)" } });
    await expect(api.agenda(span.from, span.to, ME)).rejects.toMatchObject({ code: "AGENDA_RANGE_INVALID", message: "Période d'agenda invalide (62 jours au plus)." });
    expect(h.s.requests.map((r) => r.url.pathname)).toEqual([`${RPC}driver_agenda`]);
  });
});

describe("actions sur une réservation (Flotte Privée)", () => {
  it("« La prendre » : driver_take_ride, réponse transmise telle quelle (enchaînée, refus)", async () => {
    h.s.handle = (req) =>
      req.url.pathname === `${RPC}driver_take_ride`
        ? { body: req.body.p_ride_id === "b1" ? { ok: true, code: "ACCEPTED", ride_id: "b1", chained: true } : { ok: false, code: "RIDE_TOO_LATE", message: "Trop tard." } }
        : { status: 404 };
    expect(await api.takeRide("b1")).toEqual({ ok: true, code: "ACCEPTED", ride_id: "b1", chained: true });
    expect(await api.takeRide("b2")).toEqual({ ok: false, code: "RIDE_TOO_LATE", message: "Trop tard." });
    expect(h.s.requests.map((r) => r.body)).toEqual([{ p_ride_id: "b1" }, { p_ride_id: "b2" }]);
  });

  it("« Annuler la réservation » : cancel_ride avec le motif (espaces retirés)", async () => {
    h.s.handle = (req) => (req.url.pathname === `${RPC}cancel_ride` ? { body: { ok: true, code: "CANCELLED", status: "CANCELLED" } } : { status: 404 });
    expect(await api.cancelRide("b1", "  Client injoignable ")).toEqual({ ok: true, code: "CANCELLED", status: "CANCELLED" });
    expect(h.s.requests[0]!.body).toEqual({ p_ride_id: "b1", p_reason: "Client injoignable" });
  });
});
