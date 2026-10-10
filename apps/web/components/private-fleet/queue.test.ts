import { PRIVATE_FLEET_OPEN_STATUSES } from "@rydar/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  BOOKING_COLUMNS, OFFER_EMBED, bookingStateOf, countExpiringDocuments, countToTreat, driverOffers, isToTreat, loadBookingQueue, queueSince,
  sortQueue, toBooking, type Booking, type BookingOffer, type BookingRow,
} from "./queue";

// Réservations « à traiter » de la Flotte Privée (docs/FLOTTE-PRIVEE.md § 7.3) : même règle que
// private.private_fleet_unassigned (20260924007600) et privateFleetBookingState (@rydar/shared), d'après les offres du
// chauffeur-propriétaire ; « Je la prends » jusqu'à 6 h après l'heure prévue.

const DRIVER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-20T08:00:00Z");

const offer = (over: Partial<BookingOffer> = {}): BookingOffer => ({
  id: "o-1",
  driver_id: DRIVER,
  status: "pending",
  sent_at: "2026-10-20T07:00:00Z",
  expires_at: "2026-10-20T07:30:00Z",
  ...over,
});

let n = 0;
const row = (over: Partial<BookingRow> = {}): BookingRow => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  number: 1000 + n,
  type: "scheduled",
  status: "SEARCHING_DRIVER",
  source: "api",
  pickup_at: "2026-10-20T12:00:00Z",
  pickup_address: "Aéroport d'Orly, Terminal 4, 94390 Orly",
  pickup_lat: 48.7262,
  pickup_lng: 2.3652,
  dropoff_address: "12 Rue de Rivoli, 75004 Paris",
  dropoff_lat: 48.8556,
  dropoff_lng: 2.3601,
  route_polyline: null,
  estimated_distance_m: 18_500,
  customer_name: "M. Martin",
  customer_phone: "+33612345678",
  passengers: 2,
  luggage: 1,
  vehicle_category: "business",
  price_cents: 8500,
  currency: "EUR",
  payment_method: "card",
  estimated_duration_s: 2_700,
  driver_id: null,
  created_at: "2026-10-19T18:00:00Z",
  offers: [],
  ...over,
});

describe("offres du chauffeur", () => {
  it("seules les siennes ; offre en attente et dernière offre (la plus récente d'abord)", () => {
    const offers = [
      offer({ id: "autre", driver_id: OTHER, sent_at: "2026-10-20T07:50:00Z" }),
      offer({ id: "ancienne", status: "declined", sent_at: "2026-10-20T06:00:00Z" }),
      offer({ id: "recente", status: "pending", sent_at: "2026-10-20T07:00:00Z" }),
    ];
    expect(driverOffers(offers, DRIVER)).toEqual({ pending: offers[2], last: offers[2] });
    expect(driverOffers(offers, OTHER).last?.id).toBe("autre");
    // Sans fiche chauffeur dans l'organisation : aucune offre
    expect(driverOffers(offers, null)).toEqual({ pending: null, last: null });
    expect(driverOffers(null, DRIVER)).toEqual({ pending: null, last: null });
  });
});

describe("état d'une réservation sans chauffeur (même règle que la base)", () => {
  it("à confirmer, refusée, non confirmée, à vérifier ; attribuée ou close : aucun état", () => {
    const state = (r: Partial<BookingRow>) => bookingStateOf(row(r), DRIVER);
    expect(state({ status: "OFFERED", offers: [offer()] })).toBe("to_confirm");
    expect(state({ offers: [offer({ status: "declined" })] })).toBe("declined");
    // Fenêtre de réponse passée (offre expirée), ou aucun chauffeur trouvé
    expect(state({ offers: [offer({ status: "expired" })] })).toBe("not_confirmed");
    expect(state({ status: "NO_DRIVER_FOUND" })).toBe("not_confirmed");
    // En recherche sans aucune offre (véhicule incompatible) ; l'offre d'un autre chauffeur ne compte pas
    expect(state({ status: "SEARCHING_DRIVER" })).toBe("to_check");
    expect(state({ status: "CREATED", offers: [offer({ driver_id: OTHER })] })).toBe("to_check");
    // Dernière offre refusée puis nouvelle offre en attente : à confirmer
    expect(state({ offers: [offer({ id: "a", status: "declined", sent_at: "2026-10-20T06:00:00Z" }), offer({ id: "b" })] })).toBe("to_confirm");
    expect(state({ status: "ACCEPTED", driver_id: DRIVER, offers: [offer({ status: "accepted" })] })).toBeNull();
    expect(state({ status: "COMPLETED", driver_id: DRIVER })).toBeNull();
    expect(state({ status: "CANCELLED" })).toBeNull();
  });

  it("réservation lue : état, offre en attente (« Refuser », échéance), offres retirées de l'objet", () => {
    const b = toBooking(row({ status: "OFFERED", offers: [offer({ id: "o-42", expires_at: "2026-10-20T09:00:00Z" })] }), DRIVER, NOW);
    expect(b).toMatchObject({ state: "to_confirm", offerId: "o-42", offerExpiresAt: "2026-10-20T09:00:00Z", takeable: true });
    expect("offers" in b).toBe(false);
    const declined = toBooking(row({ offers: [offer({ status: "declined" })] }), DRIVER, NOW);
    expect(declined).toMatchObject({ state: "declined", offerId: null, offerExpiresAt: null });
  });

  it("« Je la prends » : sans chauffeur, prise en charge il y a moins de 6 h", () => {
    expect(toBooking(row({ pickup_at: "2026-10-20T02:00:00Z" }), DRIVER, NOW).takeable).toBe(true);
    expect(toBooking(row({ pickup_at: "2026-10-20T01:59:00Z" }), DRIVER, NOW).takeable).toBe(false);
    expect(toBooking(row({ status: "ACCEPTED", driver_id: DRIVER }), DRIVER, NOW).takeable).toBe(false);
    expect(queueSince(NOW)).toBe("2026-10-20T02:00:00.000Z");
  });
});

describe("file à traiter", () => {
  it("à traiter : à confirmer, à vérifier, non confirmées ; une réservation refusée est déjà décidée", () => {
    expect(isToTreat({ state: "to_confirm" })).toBe(true);
    expect(isToTreat({ state: "to_check" })).toBe(true);
    expect(isToTreat({ state: "not_confirmed" })).toBe(true);
    expect(isToTreat({ state: "declined" })).toBe(false);
    expect(isToTreat({ state: null })).toBe(false);
  });

  it("ordre : à confirmer (échéance la plus proche d'abord), à vérifier, non confirmées ; liste d'origine intacte", () => {
    const b = (number: number, state: Booking["state"], pickup_at: string, offerExpiresAt: string | null = null): Booking => ({
      ...toBooking(row({ number, pickup_at }), DRIVER, NOW),
      state,
      offerExpiresAt,
    });
    const items = [
      b(1, "not_confirmed", "2026-10-20T09:00:00Z"),
      b(2, "to_check", "2026-10-21T09:00:00Z"),
      b(3, "to_confirm", "2026-10-20T10:00:00Z", "2026-10-20T09:45:00Z"),
      b(4, "to_check", "2026-10-20T11:00:00Z"),
      b(5, "to_confirm", "2026-10-22T10:00:00Z", "2026-10-20T08:30:00Z"),
      b(6, "to_confirm", "2026-10-22T10:00:00Z", "2026-10-20T08:30:00Z"),
    ];
    expect(sortQueue(items).map((i) => i.number)).toEqual([5, 6, 3, 4, 2, 1]);
    expect(items.map((i) => i.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

/** Client Supabase simulé : enregistre chaque appel de la chaîne, répond `result`. */
function fakeClient(result: { data: unknown; error: unknown }) {
  const calls: unknown[][] = [];
  const builder: object = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === "then") return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(result).then(ok, ko);
        return (...args: unknown[]) => (calls.push([prop, ...args]), builder);
      },
    },
  );
  const client = {
    from: (table: string) => (calls.push(["from", table]), builder),
    rpc: async (fn: string, args: unknown) => (calls.push(["rpc", fn, args]), result),
  };
  return { calls, client: client as unknown as SupabaseClient };
}

describe("lectures (RLS de membre, colonnes accordées)", () => {
  it("file des réservations : sans chauffeur, statuts ouverts, 6 dernières heures et à venir, offres par colonnes nommées", async () => {
    const rows = [row({ status: "OFFERED", offers: [offer()] }), row({ offers: [offer({ status: "declined" })] })];
    const { calls, client } = fakeClient({ data: rows, error: null });
    const list = await loadBookingQueue(client, "org-1", DRIVER, { now: NOW });
    expect(list?.map((b) => b.state)).toEqual(["to_confirm", "declined"]);
    expect(calls).toEqual([
      ["from", "rides"],
      ["select", `${BOOKING_COLUMNS}, ${OFFER_EMBED}`],
      ["eq", "organization_id", "org-1"],
      ["is", "driver_id", null],
      ["in", "status", [...PRIVATE_FLEET_OPEN_STATUSES]],
      ["gt", "pickup_at", "2026-10-20T02:00:00.000Z"],
      ["order", "pickup_at", { ascending: true }],
      ["order", "id", { ascending: true }],
      ["limit", 100],
    ]);
    // Jamais select('*') sur ride_offers (grant par colonne, 20260924006700) : network_terms jamais lu
    expect(OFFER_EMBED).toBe("offers:ride_offers(id, driver_id, status, sent_at, expires_at)");
    expect(`${BOOKING_COLUMNS}, ${OFFER_EMBED}`).not.toMatch(/\*|network_terms/);
    expect(await loadBookingQueue(fakeClient({ data: null, error: { message: "x" } }).client, "org-1", DRIVER)).toBeNull();
  });

  it("pastille « à traiter » : refusées exclues ; lecture en échec : null (pastille inchangée)", async () => {
    const rows = [
      row({ status: "OFFERED", offers: [offer()] }),
      row({ status: "SEARCHING_DRIVER" }),
      row({ status: "NO_DRIVER_FOUND", offers: [offer({ status: "expired" })] }),
      row({ offers: [offer({ status: "declined" })] }),
    ];
    const { calls, client } = fakeClient({ data: rows, error: null });
    expect(await countToTreat(client, "org-1", DRIVER, NOW)).toBe(3);
    expect(calls[1]).toEqual(["select", `id, status, driver_id, pickup_at, ${OFFER_EMBED}`]);
    expect(calls).toContainEqual(["gt", "pickup_at", "2026-10-20T02:00:00.000Z"]);
    expect(await countToTreat(fakeClient({ data: null, error: { message: "x" } }).client, "org-1", DRIVER, NOW)).toBeNull();
  });

  it("pastille « documents à renouveler » : expirés + bientôt expirés (org_document_alerts)", async () => {
    const { calls, client } = fakeClient({ data: { counts: { expired: 1, expiring: 2, pending: 5 } }, error: null });
    expect(await countExpiringDocuments(client, "org-1")).toBe(3);
    expect(calls).toEqual([["rpc", "org_document_alerts", { p_org: "org-1" }]]);
    expect(await countExpiringDocuments(fakeClient({ data: {}, error: null }).client, "org-1")).toBe(0);
    expect(await countExpiringDocuments(fakeClient({ data: null, error: { message: "x" } }).client, "org-1")).toBeNull();
  });
});
