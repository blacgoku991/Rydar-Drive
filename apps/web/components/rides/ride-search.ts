// Recherche de l'écran Courses / Réservations (« #1678 », client, téléphone, adresse) — module pur, testé
// (ride-search.test.ts). Même règle pour la requête PostgREST (liste paginée) et pour un filtre en mémoire (réservations
// à traiter de la Flotte Privée, déjà lues).
import { normalizePhone } from "@rydar/shared";

/** Filtre PostgREST : numéro exact (« #1678 ») ou un seul or() sur le client, le téléphone et les adresses. */
export type RideSearch = { number: number } | { or: string };

/**
 * Un seul or() : un numéro court reste aussi cherché dans les adresses (code postal « 75012 ») et un téléphone saisi
 * comme on le lit (« 06 12 34 56 78 », « 0612… », « +33… ») est comparé au format enregistré (E.164 « +33612345678 ») ;
 * « #1678 » : numéro de course seul (recherche explicite).
 */
export function rideSearch(q: string): RideSearch {
  const safe = q.replace(/[%,()]/g, " ");
  const terms = [
    `customer_name.ilike.%${safe}%`,
    `customer_phone.ilike.%${safe}%`,
    `pickup_address.ilike.%${safe}%`,
    `dropoff_address.ilike.%${safe}%`,
  ];
  const numText = q.replace(/^#\s*/, "");
  if (/^\d{1,7}$/.test(numText)) terms.push(`number.eq.${Number(numText)}`);
  const phone = normalizePhone(q);
  if (phone) terms.push(`customer_phone.eq.${phone}`);
  const compact = q.replace(/[\s.\-]/g, "");
  if (/^\+?\d{4,15}$/.test(compact)) terms.push(`customer_phone.ilike.%${compact.replace(/^\+/, "").replace(/^0/, "")}%`);
  return /^#\s*\d{1,7}$/.test(q) ? { number: Number(numText) } : { or: terms.join(",") };
}

type Searchable = {
  number: number;
  customer_name?: string | null;
  customer_phone?: string | null;
  pickup_address?: string | null;
  dropoff_address?: string | null;
};

/** Même recherche sur une course déjà lue (sans tenir compte de la casse). */
export function rideMatches(r: Searchable, q: string): boolean {
  const query = q.trim();
  if (!query) return true;
  const numText = query.replace(/^#\s*/, "");
  if (/^#\s*\d{1,7}$/.test(query)) return r.number === Number(numText);
  const needle = query.toLowerCase();
  const fields = [r.customer_name, r.customer_phone, r.pickup_address, r.dropoff_address].map((v) => (v ?? "").toLowerCase());
  if (fields.some((f) => f.includes(needle))) return true;
  if (/^\d{1,7}$/.test(numText) && r.number === Number(numText)) return true;
  const phone = normalizePhone(query);
  if (phone && r.customer_phone === phone) return true;
  const compact = query.replace(/[\s.\-]/g, "");
  return /^\+?\d{4,15}$/.test(compact) && (r.customer_phone ?? "").includes(compact.replace(/^\+/, "").replace(/^0/, ""));
}
