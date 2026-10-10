// Chauffeurs proposés dans « Attribuer » / « Réattribuer » (fiche course et panneau d'En direct) — module pur, testé
// (assignable.test.ts). Même liste aux deux endroits : chauffeurs ACTIFS de l'organisation sauf celui de la course,
// en trois groupes (disponibles, occupés, hors ligne), chacun du plus proche au plus loin du départ. Aucun chauffeur
// actif n'est retiré : un chauffeur hors ligne reste attribuable (le groupe est seulement replié). Le serveur
// (assign_ride) garde ses propres contrôles.
import { VEHICLE_CATEGORY_META, haversine, type DriverPresence, type VehicleCategory } from "@rydar/shared";

export type AssignableDriver = {
  id: string;
  name: string;
  number: number;
  presence: DriverPresence;
  /** « Classe E · GH-482-KT · Business », ou « Sans véhicule » */
  vehicle: string;
  /** Plaque seule (recherche « GH-482 ») */
  plate: string | null;
  /** Distance à vol d'oiseau jusqu'au départ (mètres, arrondie) ; null sans position */
  distance_m: number | null;
};

/** Chauffeur tel que lu par la fiche course ou par l'instantané d'En direct. */
export type AssignableSource = {
  id: string;
  number: number;
  first_name: string;
  last_name: string;
  status: string;
  presence: string;
  vehicle?: { model: string; plate: string; category?: string | null } | null;
  location?: { lat: number; lng: number } | null;
};

export type AssignableRide = { driver_id?: string | null; pickup_lat: number; pickup_lng: number };

/** À partir de ce nombre de chauffeurs, un champ « Nom, plaque » filtre la liste. */
export const ASSIGN_SEARCH_MIN = 8;

const BUSY = new Set<DriverPresence>(["offered", "en_route", "arrived", "on_trip"]);
const PRESENCES = new Set<string>(["offline", "available", "offered", "en_route", "arrived", "on_trip"]);

export type AssignGroup = "available" | "busy" | "offline";

/** Groupe d'un chauffeur : disponible, occupé (proposition en cours, en route, arrivé, en course) ou hors ligne. */
export function assignGroup(presence: DriverPresence): AssignGroup {
  if (presence === "available") return "available";
  return BUSY.has(presence) ? "busy" : "offline";
}

const GROUP_RANK: Record<AssignGroup, number> = { available: 0, busy: 1, offline: 2 };

function vehicleLabel(v: AssignableSource["vehicle"]): string {
  if (!v) return "Sans véhicule";
  const category = v.category ? VEHICLE_CATEGORY_META[v.category as VehicleCategory]?.label : undefined;
  return [v.model, v.plate, category].filter(Boolean).join(" · ");
}

/** Comparaison de deux chauffeurs d'un même groupe : le plus proche d'abord, sans position à la fin, puis par nom. */
function byDistance(a: AssignableDriver, b: AssignableDriver): number {
  const da = a.distance_m ?? Number.POSITIVE_INFINITY;
  const db = b.distance_m ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da < db ? -1 : 1;
  return a.name.localeCompare(b.name, "fr");
}

/**
 * Liste des chauffeurs à qui la course peut être confiée : actifs, autres que celui de la course, avec leur distance
 * au départ ; rangés disponibles → occupés → hors ligne, puis du plus proche au plus loin.
 */
export function assignableDrivers(drivers: readonly AssignableSource[], ride: AssignableRide): AssignableDriver[] {
  const pickup = { lat: ride.pickup_lat, lng: ride.pickup_lng };
  return drivers
    .filter((d) => d.status === "active" && d.id !== ride.driver_id)
    .map((d) => ({
      id: d.id,
      name: `${d.first_name} ${d.last_name}`.trim(),
      number: d.number,
      // Présence inconnue (donnée incomplète) : traitée comme hors ligne, jamais retirée
      presence: (PRESENCES.has(d.presence) ? d.presence : "offline") as DriverPresence,
      vehicle: vehicleLabel(d.vehicle),
      plate: d.vehicle?.plate ?? null,
      distance_m: d.location ? Math.round(haversine({ lat: d.location.lat, lng: d.location.lng }, pickup)) : null,
    }))
    .sort((a, b) => GROUP_RANK[assignGroup(a.presence)] - GROUP_RANK[assignGroup(b.presence)] || byDistance(a, b));
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const compact = (s: string) => fold(s).replace(/[\s.\-]/g, "");

/** Recherche « Nom, plaque » : nom ou prénom (casse et accents ignorés), plaque (tirets et espaces ignorés), « #12 ». */
export function matchesAssignable(d: AssignableDriver, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const number = /^#?\s*(\d{1,6})$/.exec(q);
  if (number && d.number === Number(number[1])) return true;
  if (fold(d.name).includes(fold(q))) return true;
  const plate = compact(q);
  return plate.length >= 2 && !!d.plate && compact(d.plate).includes(plate);
}

export type AssignableGroups = Record<AssignGroup, AssignableDriver[]>;

/** Les trois groupes de la fenêtre (filtrés par la recherche), dans l'ordre de `assignableDrivers`. */
export function groupAssignable(list: readonly AssignableDriver[], query = ""): AssignableGroups {
  const groups: AssignableGroups = { available: [], busy: [], offline: [] };
  for (const d of list) if (matchesAssignable(d, query)) groups[assignGroup(d.presence)].push(d);
  return groups;
}
