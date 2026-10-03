// Onglet « Réseau partagé » du tableau de bord (/dashboard/reseau-partage) : sous-onglets, paramètres d'URL, mois.
// Module pur (ni « use client » ni « server-only ») : page serveur, composants client, route d'export et tests.
//
// Contrat d'URL :
//   ?tab=confiees|recues|reglages                       (absent : choisi selon l'état, access.ts → defaultNetworkTab ;
//                                                        les liens internes le donnent toujours)
//   &filtre=<clé>        Courses confiées : NETWORK_GIVEN_FILTERS ; Courses reçues : NETWORK_RECEIVED_FILTERS (défaut : all)
//   &partenaire=<uuid>   organisation partenaire (network_partner_names)
//   &mois=AAAA-MM        mois (relevé, export CSV)
//   &n=<50..500>         taille de la liste (« Afficher plus »)
import {
  NETWORK_GIVEN_FILTERS, NETWORK_RECEIVED_FILTERS, dateTimeFormat, type NetworkGivenFilter, type NetworkReceivedFilter,
} from "@rydar/shared";

export const NETWORK_SHARE_PATH = "/dashboard/reseau-partage";
export const NETWORK_EXPORT_PATH = `${NETWORK_SHARE_PATH}/export`;

export const NETWORK_SHARE_TABS = [
  { key: "confiees", label: "Courses confiées" },
  { key: "recues", label: "Courses reçues" },
  { key: "reglages", label: "Réglages" },
] as const;
export type NetworkShareTab = (typeof NETWORK_SHARE_TABS)[number]["key"];

/** Liste : 50 lignes, « Afficher plus » par 50 jusqu'à 500. */
export const NETWORK_LIST_PAGE = 50;
export const NETWORK_LIST_MAX = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** « 2026-09 » valide (mois 01 à 12), sinon null. */
export function parseMonth(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : null;
}

export type NetworkShareSearchParams = { tab?: string | string[]; filtre?: string | string[]; partenaire?: string | string[]; mois?: string | string[]; n?: string | string[] };

export type NetworkShareParams = {
  /** null : absent ou inconnu (sous-onglet choisi selon l'état de l'organisation) */
  tab: NetworkShareTab | null;
  given: NetworkGivenFilter;
  received: NetworkReceivedFilter;
  partner: string | null;
  month: string | null;
  limit: number;
};

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const GIVEN_KEYS = new Set<string>(NETWORK_GIVEN_FILTERS.map((f) => f.key));
const RECEIVED_KEYS = new Set<string>(NETWORK_RECEIVED_FILTERS.map((f) => f.key));

/** Paramètres d'URL lus sans confiance : toute valeur inconnue retombe sur le défaut. */
export function parseNetworkShareParams(sp: NetworkShareSearchParams): NetworkShareParams {
  const tab = first(sp.tab);
  const filter = first(sp.filtre) ?? "";
  const n = Math.round(Number(first(sp.n)) || NETWORK_LIST_PAGE);
  return {
    tab: NETWORK_SHARE_TABS.some((t) => t.key === tab) ? (tab as NetworkShareTab) : null,
    given: GIVEN_KEYS.has(filter) ? (filter as NetworkGivenFilter) : "all",
    received: RECEIVED_KEYS.has(filter) ? (filter as NetworkReceivedFilter) : "all",
    partner: isUuid(first(sp.partenaire)) ? first(sp.partenaire)! : null,
    month: parseMonth(first(sp.mois)),
    limit: Math.min(NETWORK_LIST_MAX, Math.max(NETWORK_LIST_PAGE, n)),
  };
}

/**
 * Organisation SUSPENDUE (C12) : ses règlements réseau ouverts, hors du tableau de bord (owner / admin). Même contrat
 * d'URL que « Courses confiées » (filtre, partenaire, mois, n).
 */
export const NETWORK_SUSPENDED_PATH = "/suspended/reseau-partage";

/**
 * Lien vers un sous-onglet, avec ancre facultative. Le sous-onglet est TOUJOURS écrit (sans lui, la page choisit selon
 * l'état de l'organisation) ; filtres par défaut omis. `base` : page de l'organisation suspendue (« Courses confiées »
 * seulement, sans sous-onglets).
 */
export function networkShareHref(
  p: { tab: NetworkShareTab; filter?: string | null; partner?: string | null; month?: string | null; n?: number | null },
  hash?: string,
  base: string = NETWORK_SHARE_PATH,
): string {
  const q = new URLSearchParams();
  if (base === NETWORK_SHARE_PATH) q.set("tab", p.tab);
  if (p.filter && p.filter !== "all") q.set("filtre", p.filter);
  if (p.partner) q.set("partenaire", p.partner);
  if (p.month) q.set("mois", p.month);
  if (p.n && p.n > NETWORK_LIST_PAGE) q.set("n", String(Math.min(NETWORK_LIST_MAX, p.n)));
  const s = q.toString();
  return `${base}${s ? `?${s}` : ""}${hash ? `#${hash}` : ""}`;
}

/** Export CSV / relevé mensuel : vue (confiees | recues), mois (obligatoire), partenaire facultatif. */
export function networkExportHref(p: { view: "confiees" | "recues"; month: string; partner?: string | null }): string {
  const q = new URLSearchParams({ vue: p.view, mois: p.month });
  if (p.partner) q.set("partenaire", p.partner);
  return `${NETWORK_EXPORT_PATH}?${q.toString()}`;
}

/** Mois courant (« AAAA-MM ») dans le fuseau de l'organisation (formateur mémorisé ; fuseau invalide → UTC). */
export function monthInZone(now: Date, timeZone: string): string {
  try {
    const parts = dateTimeFormat("en-CA", { year: "numeric", month: "2-digit", timeZone }).formatToParts(now);
    const v = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${v("year")}-${v("month")}`;
  } catch {
    return now.toISOString().slice(0, 7);
  }
}

/** Mois précédents de `month` (« 2026-01 » − 1 = « 2025-12 »). */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** « septembre 2026 » (sans dépendre du fuseau : milieu du mois en UTC). */
export function monthLabel(month: string): string {
  return dateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-15T12:00:00Z`));
}

/** Les `count` derniers mois (le mois courant d'abord), au fuseau de l'organisation. */
export function recentMonths(now: Date, timeZone: string, count = 12): { value: string; label: string }[] {
  const current = monthInZone(now, timeZone);
  return Array.from({ length: count }, (_, i) => {
    const value = shiftMonth(current, -i);
    return { value, label: monthLabel(value) };
  });
}
