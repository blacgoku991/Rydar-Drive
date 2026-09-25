// Lieux fréquents VTC (aéroports, gares) — suggestions instantanées, sans appel réseau.
import { haversine } from "@rydar/shared";

export type Place = {
  label: string;
  address: string;
  lat: number;
  lng: number;
  kind: "airport" | "station" | "poi" | "address" | "city";
  /** Confiance du géocodeur (0–1, formats BAN / Géoplateforme). */
  score?: number;
  postcode?: string;
};

export const FAVORITE_PLACES: Place[] = [
  { label: "Aéroport CDG — Terminal 1", address: "Aéroport Paris-Charles de Gaulle, Terminal 1, 95700 Roissy-en-France", lat: 49.0097, lng: 2.5479, kind: "airport" },
  { label: "Aéroport CDG — Terminal 2A/2C", address: "Aéroport Paris-Charles de Gaulle, Terminal 2A, 95700 Roissy-en-France", lat: 49.0033, lng: 2.5617, kind: "airport" },
  { label: "Aéroport CDG — Terminal 2E", address: "Aéroport Paris-Charles de Gaulle, Terminal 2E, 95700 Roissy-en-France", lat: 49.0047, lng: 2.571, kind: "airport" },
  { label: "Aéroport CDG — Terminal 2F", address: "Aéroport Paris-Charles de Gaulle, Terminal 2F, 95700 Roissy-en-France", lat: 49.0059, lng: 2.5664, kind: "airport" },
  { label: "Aéroport CDG — Terminal 3", address: "Aéroport Paris-Charles de Gaulle, Terminal 3, 95700 Roissy-en-France", lat: 49.0131, lng: 2.5413, kind: "airport" },
  { label: "Aéroport d'Orly — Terminal 1", address: "Aéroport de Paris-Orly, Terminal 1, 94390 Orly", lat: 48.7307, lng: 2.3591, kind: "airport" },
  { label: "Aéroport d'Orly — Terminal 4", address: "Aéroport de Paris-Orly, Terminal 4, 94390 Orly", lat: 48.7262, lng: 2.3652, kind: "airport" },
  { label: "Aéroport Paris-Le Bourget", address: "Aéroport Paris-Le Bourget, 93350 Le Bourget", lat: 48.9614, lng: 2.4376, kind: "airport" },
  { label: "Aéroport de Beauvais-Tillé", address: "Aéroport de Beauvais-Tillé, 60000 Tillé", lat: 49.4544, lng: 2.1128, kind: "airport" },
  { label: "Gare de Lyon", address: "Gare de Lyon, Place Louis-Armand, 75012 Paris", lat: 48.8443, lng: 2.3743, kind: "station" },
  { label: "Gare du Nord", address: "Gare du Nord, 18 Rue de Dunkerque, 75010 Paris", lat: 48.8809, lng: 2.3553, kind: "station" },
  { label: "Gare de l'Est", address: "Gare de l'Est, Place du 11 Novembre 1918, 75010 Paris", lat: 48.8768, lng: 2.3592, kind: "station" },
  { label: "Gare Montparnasse", address: "Gare Montparnasse, 17 Boulevard de Vaugirard, 75015 Paris", lat: 48.8414, lng: 2.3209, kind: "station" },
  { label: "Gare Saint-Lazare", address: "Gare Saint-Lazare, 13 Rue d'Amsterdam, 75008 Paris", lat: 48.8763, lng: 2.3253, kind: "station" },
  { label: "Gare d'Austerlitz", address: "Gare d'Austerlitz, 85 Quai d'Austerlitz, 75013 Paris", lat: 48.8425, lng: 2.3656, kind: "station" },
  { label: "Gare de Marne-la-Vallée Chessy", address: "Gare de Marne-la-Vallée Chessy, 77700 Chessy", lat: 48.8702, lng: 2.7826, kind: "station" },
  { label: "Disneyland Paris", address: "Disneyland Paris, Boulevard de Parc, 77700 Coupvray", lat: 48.8722, lng: 2.7758, kind: "poi" },
  { label: "La Défense — Parvis", address: "La Défense, Parvis de la Défense, 92400 Courbevoie", lat: 48.8924, lng: 2.236, kind: "poi" },
  { label: "Château de Versailles", address: "Château de Versailles, Place d'Armes, 78000 Versailles", lat: 48.8049, lng: 2.1204, kind: "poi" },
  { label: "Palais des Congrès — Porte Maillot", address: "Palais des Congrès, 2 Place de la Porte Maillot, 75017 Paris", lat: 48.8785, lng: 2.283, kind: "poi" },
  { label: "Tour Eiffel", address: "Tour Eiffel, 5 Avenue Anatole France, 75007 Paris", lat: 48.8584, lng: 2.2945, kind: "poi" },
  { label: "Opéra Garnier", address: "Opéra Garnier, Place de l'Opéra, 75009 Paris", lat: 48.872, lng: 2.3316, kind: "poi" },
  { label: "Champs-Élysées", address: "12 Avenue des Champs-Élysées, 75008 Paris", lat: 48.8698, lng: 2.3075, kind: "address" },
  { label: "Aéroport Nice Côte d'Azur — T1", address: "Aéroport Nice Côte d'Azur, Terminal 1, 06200 Nice", lat: 43.6653, lng: 7.2150, kind: "airport" },
  { label: "Aéroport Nice Côte d'Azur — T2", address: "Aéroport Nice Côte d'Azur, Terminal 2, 06200 Nice", lat: 43.6584, lng: 7.2159, kind: "airport" },
  { label: "Monaco — Place du Casino", address: "Place du Casino, 98000 Monaco", lat: 43.7392, lng: 7.4277, kind: "poi" },
];

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Lieux favoris correspondant à la saisie ; avec `near`, seulement ceux à moins de 80 km, du plus proche au plus loin. */
export function matchFavorites(q: string, limit = 4, near?: { lat: number; lng: number }): Place[] {
  const terms = norm(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  let found = FAVORITE_PLACES.filter((p) => {
    const hay = norm(`${p.label} ${p.address}`);
    return terms.every((t) => hay.includes(t) || (t === "cdg" && hay.includes("charles de gaulle")));
  });
  if (near) {
    found = found
      .map((p) => ({ p, d: haversine(near, p) }))
      .filter((x) => x.d <= 80_000)
      .sort((a, b) => a.d - b.d)
      .map((x) => x.p);
  }
  return found.slice(0, limit);
}

/** Favori dont le libellé ou l'adresse correspond exactement à la saisie (ex. « Gare de Lyon »). */
export function exactFavorite(q: string): Place | null {
  const n = norm(q).replace(/\s+/g, " ").trim();
  return FAVORITE_PLACES.find((p) => norm(p.label) === n || norm(p.address) === n) ?? null;
}
