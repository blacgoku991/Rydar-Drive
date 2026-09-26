// Carte en direct du super admin : types de l'instantané (/api/admin/live) et petits utilitaires
// partagés entre le serveur (lecture) et le client (carte, panneau, effectifs).
import type { DispatchModel, DriverPresence, OrgStatus, RideStatus } from "@rydar/shared";

export type AdminLiveOrg = {
  id: string;
  name: string;
  slug: string;
  city: string | null;
  status: OrgStatus;
  dispatch_model: DispatchModel;
  /** Couleur stable de l'organisation : brand_color si renseignée, sinon palette dérivée de l'id. */
  color: string;
  /** Sigle (1–2 lettres) affiché sur les marqueurs. */
  code: string;
};

export type AdminLiveDriver = {
  id: string;
  organization_id: string;
  number: number;
  first_name: string;
  last_name: string;
  phone: string;
  presence: DriverPresence;
  current_ride_id: string | null;
  online_since: string | null;
  vehicle: { brand: string | null; model: string; plate: string; color: string | null; category: string } | null;
  location: {
    lat: number;
    lng: number;
    heading: number | null;
    speed_mps: number | null;
    accuracy_m: number | null;
    updated_at: string;
  } | null;
};

export type AdminLiveRide = {
  id: string;
  organization_id: string;
  number: number;
  status: RideStatus;
  type: "instant" | "scheduled";
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_address: string;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  pickup_at: string;
  vehicle_category: string;
  passengers: number;
  driver_id: string | null;
  dispatch_wave: number;
};

/** Offre en attente de réponse (chauffeur sollicité pour une course). */
export type AdminLiveOffer = { driver_id: string; ride_id: string; expires_at: string | null };

export type AdminLiveSnapshot = {
  orgs: AdminLiveOrg[];
  /** Chauffeurs actifs en ligne (presence ≠ offline), toutes organisations. */
  drivers: AdminLiveDriver[];
  /** Courses en cours des chauffeurs en ligne, courses proposées et courses en attente de chauffeur (départ < 2 h). */
  rides: AdminLiveRide[];
  /** Offres en attente des chauffeurs affichés. */
  offers: AdminLiveOffer[];
  serverTime: string;
};

/** Au-delà : position « ancienne » (marqueur grisé ou masqué). */
export const STALE_MS = 10 * 60_000;

export const ONLINE_PRESENCES = ["available", "offered", "en_route", "arrived", "on_trip"] as const satisfies readonly DriverPresence[];
/** Chauffeur « occupé » : course acceptée (en route, sur place ou client à bord). */
export const BUSY_PRESENCES: ReadonlySet<DriverPresence> = new Set(["en_route", "arrived", "on_trip"]);
export const WAITING_STATUSES: ReadonlySet<string> = new Set(["SEARCHING_DRIVER", "OFFERED"]);

/** Libellés courts des statuts de présence (filtres, légende). */
export const PRESENCE_SHORT: Record<DriverPresence, string> = {
  available: "Disponible",
  offered: "Offre",
  en_route: "En route",
  arrived: "Sur place",
  on_trip: "En course",
  offline: "Hors ligne",
};

// Palette de repli : teintes éloignées des couleurs de statut (lime, ambre, bleu, violet, cyan).
const ORG_PALETTE = ["#F472B6", "#FB923C", "#2DD4BF", "#818CF8", "#FB7185", "#FACC15", "#34D399", "#E879F9", "#F9A8D4", "#D6D3D1"];

export function orgColor(id: string, brand: string | null | undefined): string {
  if (brand && /^#[0-9a-f]{6}$/i.test(brand)) return brand.toUpperCase();
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return ORG_PALETTE[h % ORG_PALETTE.length]!;
}

const MINOR_WORDS = new Set(["de", "du", "des", "la", "le", "les", "et", "d", "l", "vtc", "sas", "sarl", "sasu", "eurl"]);

/** « Élite Chauffeurs Paris » → « ÉC », « Riviera Prestige VTC » → « RP ». */
export function orgCode(name: string): string {
  const words = name.split(/[\s'’\-–&.]+/).filter((w) => w && !MINOR_WORDS.has(w.toLowerCase()));
  const code = `${words[0]?.charAt(0) ?? ""}${words[1]?.charAt(0) ?? ""}`.toUpperCase();
  return code || name.trim().charAt(0).toUpperCase() || "?";
}

/** Texte lisible sur une couleur de fond (#RRGGBB). */
export function textOn(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return "#0b0d10";
  const [r, g, b] = [m[1], m[2], m[3]].map((c) => {
    const v = parseInt(c!, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  // meilleur contraste : noir au-delà de ~0,18 de luminance relative
  return lum > 0.179 ? "#0b0d10" : "#ffffff";
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
/** Cap en degrés → point cardinal (« NE »). */
export function compassPoint(heading: number): string {
  const h = ((heading % 360) + 360) % 360;
  return COMPASS[Math.round(h / 45) % 8]!;
}

/** « 12 s », « 4 min », « 2 h », « 3 j » (âge d'une position). */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} j`;
}
