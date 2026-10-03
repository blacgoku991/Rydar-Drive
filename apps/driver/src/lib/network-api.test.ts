// Réseau partagé, appels de l'app (src/lib/api.ts) : noms et paramètres du contrat (@rydar/shared NetworkRpcs),
// nouvelles fonctions (driver_offers_v2, driver_ride, driver_rides_upcoming) et repli sur les anciennes d'un serveur
// antérieur (PGRST202, une seule fois), refus métier. Client supabase-js réel ; PostgREST simulé.
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
    auth: { storage, storageKey: "rydar-test-network", autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: h.fetch as typeof fetch },
  });
  return { supabase };
});

const { api, ApiError, isMissingRpc, networkTermsUrl, refusalText, resetRpcFallbacks } = await import("./api");

const RPC = "/rest/v1/rpc/";
const missing = (fn: string) => ({ status: 404, body: { code: "PGRST202", message: `Could not find the function public.${fn} without parameters in the schema cache` } });
/** Exception levée par une fonction SQL (« CODE: texte »). */
const raised = (message: string, code = "P0001") => ({ status: 400, body: { code, message, details: null, hint: null } });
const paths = () => h.s.requests.map((r) => r.url.pathname);

const partnerOffer = {
  offer_id: "o1", ride_id: "r1", number: 1783, mode: "geo", status: "pending", ride_type: "instant", pickup_address: "75011 Paris",
  dropoff_address: "Versailles", price_cents: 5000, currency: "EUR", payment_method: "cash", sent_at: "2026-11-10T09:00:00Z",
  expires_at: "2026-11-10T09:00:30Z", blocked: null,
  network: { giver: { name: "Taxi Alpha", legal_name: null, vtc_registration: null }, pickup_area: "75011 Paris", dropoff_area: "Versailles", money: {} },
};
const ownOffer = { ...partnerOffer, offer_id: "o2", network: undefined };

beforeEach(() => {
  h.s.requests.length = 0;
  resetRpcFallbacks();
  vi.stubGlobal("fetch", h.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("offres : driver_offers_v2, repli driver_offers sur un serveur antérieur", () => {
  it("serveur à jour : offres propres et partenaires, une seule requête", async () => {
    h.s.handle = (req) => (req.url.pathname === `${RPC}driver_offers_v2` ? { body: [partnerOffer, { ...ownOffer, network: null }] } : { status: 404 });
    const offers = await api.offers();
    expect(offers.map((o) => [o.offer_id, o.network?.giver.name ?? null])).toEqual([["o1", "Taxi Alpha"], ["o2", null]]);
    expect(paths()).toEqual([`${RPC}driver_offers_v2`]);
  });

  it("serveur antérieur : driver_offers (jamais partenaire), puis directement l'ancienne fonction", async () => {
    h.s.handle = (req) =>
      req.url.pathname === `${RPC}driver_offers_v2` ? missing("driver_offers_v2")
      : req.url.pathname === `${RPC}driver_offers` ? { body: [ownOffer] }
      : { status: 404 };
    expect((await api.offers()).map((o) => [o.offer_id, o.network])).toEqual([["o2", null]]);
    expect(paths()).toEqual([`${RPC}driver_offers_v2`, `${RPC}driver_offers`]);
    h.s.requests.length = 0;
    await api.offers();
    expect(paths()).toEqual([`${RPC}driver_offers`]);
  });

  it("autre erreur (réseau, serveur) : jamais de repli silencieux", async () => {
    h.s.handle = () => raised("FORBIDDEN: compte chauffeur inactif ou inconnu", "42501");
    await expect(api.offers()).rejects.toBeInstanceOf(ApiError);
    expect(paths()).toEqual([`${RPC}driver_offers_v2`]);
  });
});

describe("course : driver_ride (liste blanche), repli rides sur un serveur antérieur", () => {
  it("course tenue : réponse de driver_ride ; course retirée (RIDE_NOT_FOUND) : null", async () => {
    const served = { id: "r1", number: 1783, money: { driver_part_cents: 3750 }, network: { execution_id: "e1", giver: { name: "Taxi Alpha" } }, voucher: { receipt_by: "Taxi Alpha" } };
    h.s.handle = (req) => (req.url.pathname === `${RPC}driver_ride` ? { body: served } : { status: 404 });
    expect(await api.ride("r1")).toMatchObject({ id: "r1", network: { giver: { name: "Taxi Alpha" } } });
    expect(h.s.requests[0]!.body).toEqual({ p_ride: "r1" });
    h.s.handle = () => raised("RIDE_NOT_FOUND: course introuvable");
    expect(await api.ride("r1")).toBeNull();
    h.s.handle = () => raised("FORBIDDEN: compte chauffeur inactif ou inconnu", "42501");
    await expect(api.ride("r1")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("serveur antérieur : ligne rides (RLS), argent déduit du modèle de l'organisation", async () => {
    const row = {
      id: "r1", number: 12, type: "instant", status: "ACCEPTED", payment_method: "cash", price_cents: 5000, currency: "EUR",
      driver_payout_cents: 4000, commission_cents: 900, platform_fee_cents: 100, customer_name: "M. Martin", driver_id: "d1",
    };
    h.s.handle = (req) =>
      req.url.pathname === `${RPC}driver_ride` ? missing("driver_ride")
      : req.url.pathname === "/rest/v1/rides" ? { body: row }
      : { status: 404 };
    const centrale = await api.ride("r1", { model: "centrale", organization: "Taxi Bleu" });
    expect(centrale).toMatchObject({ network: null, voucher: null, money: { driver_part_cents: 4000, giver_part_cents: 1000, creditor_name: "Taxi Bleu" } });
    const fleet = await api.ride("r1", { model: "fleet" });
    expect(fleet?.money).toMatchObject({ driver_part_cents: null, giver_part_cents: null });
    expect(paths().filter((p) => p === `${RPC}driver_ride`)).toHaveLength(1);
  });
});

describe("RPC réseau : noms et paramètres du contrat", () => {
  it("réglage, ping, coordonnées bancaires (IBAN et BIC normalisés), règlements partenaires", async () => {
    h.s.handle = () => ({ body: { ok: true } });
    await api.networkState();
    await api.networkPing();
    await api.setNetwork(true, "2026-11-01");
    await api.setNetwork(false, null);
    await api.payoutInfo();
    await api.setPayoutDetails({ payee: "  Karim Benali ", iban: "fr76 3000 6000 0112 3456 7890 189", bic: " bnpa frpp " });
    await api.setPayoutDetails({ payee: "Karim Benali", iban: "FR7630006000011234567890189", bic: "" });
    await api.deletePayoutDetails();
    await api.networkSettlements();
    await api.declareNetworkPayment("org-a", ["s1", "s2"], "transfer", "  ");
    await api.declareNetworkPayment("org-a", ["s1"], "cash", " remis à Mehdi ");
    await api.disputeNetworkSettlement("s1", "  J'ai payé le 10/11 par virement ");
    expect(h.s.requests.map((r) => [r.url.pathname.slice(RPC.length), r.body])).toEqual([
      ["driver_network_state", {}],
      ["driver_network_ping", {}],
      ["driver_set_network", { p_enabled: true, p_version: "2026-11-01" }],
      ["driver_set_network", { p_enabled: false, p_version: null }],
      ["driver_payout_info", {}],
      ["driver_set_payout_details", { p_payee: "Karim Benali", p_iban: "FR7630006000011234567890189", p_bic: "BNPAFRPP" }],
      ["driver_set_payout_details", { p_payee: "Karim Benali", p_iban: "FR7630006000011234567890189", p_bic: null }],
      ["driver_delete_payout_details", {}],
      ["driver_network_settlements", {}],
      ["driver_declare_network_payment", { p_org: "org-a", p_ids: ["s1", "s2"], p_method: "transfer", p_note: null }],
      ["driver_declare_network_payment", { p_org: "org-a", p_ids: ["s1"], p_method: "cash", p_note: "remis à Mehdi" }],
      ["driver_dispute_network_settlement", { p_id: "s1", p_reason: "J'ai payé le 10/11 par virement" }],
    ]);
  });

  it("serveur sans réseau partagé : fonction absente reconnue (aucun écran réseau)", async () => {
    h.s.handle = () => missing("driver_network_state");
    const e = await api.networkState().catch((x: unknown) => x);
    expect(isMissingRpc(e)).toBe(true);
    h.s.handle = () => raised("NETWORK_DISABLED: réseau partagé fermé");
    const off = await api.networkState().catch((x: unknown) => x);
    expect(isMissingRpc(off)).toBe(false);
    expect(off).toMatchObject({ code: "NETWORK_DISABLED", message: "Le réseau partagé est momentanément désactivé par Rydar." });
  });

  it("refus métier : libellés de @rydar/shared, reformulés pour le chauffeur quand ils visent l'organisation", async () => {
    h.s.handle = () => raised("PAYOUT_DETAILS_IN_USE: versement ouvert");
    await expect(api.deletePayoutDetails()).rejects.toMatchObject({
      code: "PAYOUT_DETAILS_IN_USE", message: "Un versement vous est encore dû : modifiez vos coordonnées bancaires au lieu de les supprimer.",
    });
    h.s.handle = () => raised("DRIVER_BUSY_AT_TIME: chevauchement");
    await expect(api.accept("o1")).rejects.toMatchObject({ code: "DRIVER_BUSY_AT_TIME", message: "Créneau déjà pris : vous avez une autre course à cette heure-là." });
    expect(refusalText({ code: "OFFER_CHANGED" })).toBe("La course a été modifiée : elle vous sera reproposée si elle est encore disponible.");
    expect(refusalText({ code: "DRIVER_BUSY_AT_TIME" })).toBe("Créneau déjà pris : vous avez une autre course à cette heure-là.");
  });

  it("conditions complètes : page publique du serveur web", () => {
    expect(networkTermsUrl()).toBe("https://app.rydar.test/reseau-partage/chauffeur");
  });
});
