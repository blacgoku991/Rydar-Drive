// Flotte Privée : réservations sans chauffeur « à traiter » (même règle que private.private_fleet_unassigned,
// 20260924007600, et que privateFleetBookingState de @rydar/shared) — prise en charge il y a moins de 6 h, statut
// encore ouvert ; état calculé d'après les offres du chauffeur (son offre en attente, sa dernière offre). Lectures RLS
// de membre (le propriétaire lit toutes les courses et offres de son organisation). Module neutre : layout (pastilles
// du menu), pages serveur (Accueil, Réservations, fiche, Agenda) et barre latérale (relecture dans le navigateur).
import {
  PRIVATE_FLEET_OPEN_STATUSES, PRIVATE_FLEET_TAKE_MAX_AGE_HOURS, privateFleetBookingState, privateFleetTakeable,
  type OfferStatus, type PaymentMethod, type PrivateFleetBookingState, type RideStatus, type RideType, type VehicleCategory,
} from "@rydar/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Offre d'une course, colonnes accordées au client (grant par colonne de 20260924006700 : jamais select('*')). */
export type BookingOffer = { id: string; driver_id: string; status: OfferStatus; sent_at: string; expires_at: string | null };

/** Offres embarquées dans une lecture de rides (clé étrangère unique ride_offers → rides). */
export const OFFER_EMBED = "offers:ride_offers(id, driver_id, status, sent_at, expires_at)";

/** Colonnes d'une réservation affichée (Accueil, Réservations, Agenda). */
export const BOOKING_COLUMNS =
  "id, number, type, status, source, pickup_at, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, route_polyline, estimated_distance_m, customer_name, customer_phone, passengers, luggage, vehicle_category, price_cents, currency, payment_method, estimated_duration_s, driver_id, created_at";

export type BookingRow = {
  id: string;
  number: number;
  type: RideType;
  status: RideStatus;
  source: string;
  pickup_at: string;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_address: string;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  route_polyline: string | null;
  estimated_distance_m: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  passengers: number;
  luggage: number;
  vehicle_category: VehicleCategory;
  price_cents: number | null;
  currency: string | null;
  payment_method: PaymentMethod;
  estimated_duration_s: number | null;
  driver_id: string | null;
  created_at: string;
  offers?: BookingOffer[] | null;
};

/** Réservation avec son état (null : attribuée ou close) et l'offre en attente du chauffeur. */
export type Booking = Omit<BookingRow, "offers"> & {
  state: PrivateFleetBookingState | null;
  /** Offre en attente du chauffeur (« Refuser ») et son échéance (« Réponse avant HH:MM ») */
  offerId: string | null;
  offerExpiresAt: string | null;
  /** « Je la prends » possible (sans chauffeur, prise en charge il y a moins de 6 h) */
  takeable: boolean;
};

const byNewest = (a: BookingOffer, b: BookingOffer) => Date.parse(b.sent_at) - Date.parse(a.sent_at) || b.id.localeCompare(a.id);

/** Offre en attente et dernière offre du chauffeur pour cette course (sans fiche : aucune). */
export function driverOffers(offers: readonly BookingOffer[] | null | undefined, driverId: string | null) {
  const own = driverId ? (offers ?? []).filter((o) => o.driver_id === driverId).sort(byNewest) : [];
  return { pending: own.find((o) => o.status === "pending") ?? null, last: own[0] ?? null };
}

/** État d'une course sans chauffeur d'après les offres du chauffeur (null : attribuée ou close). */
export function bookingStateOf(
  ride: { status: RideStatus; driver_id: string | null; offers?: readonly BookingOffer[] | null },
  driverId: string | null,
): PrivateFleetBookingState | null {
  const { pending, last } = driverOffers(ride.offers, driverId);
  return privateFleetBookingState({ status: ride.status, driver_id: ride.driver_id, pending_offer: !!pending, last_offer_status: last?.status ?? null });
}

/** Réservation lue → état à traiter (même règle que la base) ; `now` : contrôle des 6 h de « Je la prends ». */
export function toBooking(row: BookingRow, driverId: string | null, now = Date.now()): Booking {
  const { offers, ...ride } = row;
  const { pending } = driverOffers(offers, driverId);
  return {
    ...ride,
    state: bookingStateOf(row, driverId),
    offerId: pending?.id ?? null,
    offerExpiresAt: pending?.expires_at ?? null,
    takeable: privateFleetTakeable(ride, now),
  };
}

/** À traiter : à confirmer, à vérifier, non confirmées (une réservation refusée par le chauffeur est déjà décidée). */
export const isToTreat = (b: { state: PrivateFleetBookingState | null }) => !!b.state && b.state !== "declined";

/** Ordre de traitement : à confirmer (échéance la plus proche d'abord), puis à vérifier, puis non confirmées. */
const STATE_ORDER: Record<PrivateFleetBookingState, number> = { to_confirm: 0, to_check: 1, not_confirmed: 2, declined: 3 };
export function sortQueue<T extends Booking>(items: readonly T[]): T[] {
  const due = (b: Booking) => Date.parse(b.offerExpiresAt ?? b.pickup_at);
  return [...items].sort((a, b) => STATE_ORDER[a.state ?? "declined"] - STATE_ORDER[b.state ?? "declined"] || due(a) - due(b) || a.number - b.number);
}

/** Début de la fenêtre « à traiter » (prise en charge il y a moins de 6 h). */
export const queueSince = (now = Date.now()) => new Date(now - PRIVATE_FLEET_TAKE_MAX_AGE_HOURS * 3_600_000).toISOString();

/**
 * Réservations sans chauffeur des 6 dernières heures et à venir (refusées comprises, pour la page Réservations), 100 au
 * plus, triées par prise en charge. null si la lecture échoue.
 */
export async function loadBookingQueue(
  supabase: SupabaseClient,
  orgId: string,
  driverId: string | null,
  opts: { limit?: number; now?: number } = {},
): Promise<Booking[] | null> {
  const now = opts.now ?? Date.now();
  const { data, error } = await supabase
    .from("rides")
    .select(`${BOOKING_COLUMNS}, ${OFFER_EMBED}`)
    .eq("organization_id", orgId)
    .is("driver_id", null)
    .in("status", [...PRIVATE_FLEET_OPEN_STATUSES])
    .gt("pickup_at", queueSince(now))
    .order("pickup_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(opts.limit ?? 100);
  if (error) return null;
  return ((data ?? []) as unknown as BookingRow[]).map((r) => toBooking(r, driverId, now));
}

/** Pastilles du menu de la Flotte Privée tirées de la file des réservations sans chauffeur. */
export type QueueCounts = {
  /** « Accueil » (ambre) : à confirmer, à vérifier, non confirmées */
  toTreat: number;
  /**
   * « Réservations » (rouge) : non confirmées — sans chauffeur à l'échéance (NO_DRIVER_FOUND), sans refus du chauffeur.
   * Une réservation qu'il a refusée lui-même (« Refusée », aussi NO_DRIVER_FOUND) est déjà décidée : jamais d'alerte.
   */
  notConfirmed: number;
};

/** Comptes des pastilles d'après les réservations sans chauffeur lues (même règle que la file et que la base). */
export function queueCounts(rows: readonly Pick<BookingRow, "status" | "driver_id" | "offers">[], driverId: string | null): QueueCounts {
  let toTreat = 0;
  let notConfirmed = 0;
  for (const r of rows) {
    const state = bookingStateOf(r, driverId);
    if (isToTreat({ state })) toTreat += 1;
    if (r.status === "NO_DRIVER_FOUND" && state === "not_confirmed") notConfirmed += 1;
  }
  return { toTreat, notConfirmed };
}

/**
 * Pastilles « à traiter » et « non confirmées » du menu (layout, barre latérale) : une seule lecture légère (statut et
 * offres des réservations sans chauffeur des 6 dernières heures et à venir). null si la lecture échoue (pastilles
 * inchangées).
 */
export async function countQueue(supabase: SupabaseClient, orgId: string, driverId: string | null, now = Date.now()): Promise<QueueCounts | null> {
  const { data, error } = await supabase
    .from("rides")
    .select(`id, status, driver_id, pickup_at, ${OFFER_EMBED}`)
    .eq("organization_id", orgId)
    .is("driver_id", null)
    .in("status", [...PRIVATE_FLEET_OPEN_STATUSES])
    .gt("pickup_at", queueSince(now))
    .limit(100);
  if (error) return null;
  return queueCounts((data ?? []) as unknown as Pick<BookingRow, "status" | "driver_id" | "offers">[], driverId);
}

/**
 * Pastille « Mon profil chauffeur » : documents expirés ou qui expirent sous 30 jours (org_document_alerts, mêmes
 * règles que la page Chauffeurs : pièce remplacée par une plus récente exclue). null si la lecture échoue.
 */
export async function countExpiringDocuments(supabase: SupabaseClient, orgId: string): Promise<number | null> {
  const { data, error } = await supabase.rpc("org_document_alerts", { p_org: orgId });
  if (error || !data) return null;
  const counts = (data as { counts?: { expired?: number; expiring?: number } }).counts ?? {};
  return (counts.expired ?? 0) + (counts.expiring ?? 0);
}
