// Grille tarifaire (Réglages › Tarifs, docs/REFONTE-PANELS.md § 5.6, lot R10) : une ligne saisie par catégorie, lignes
// modifiées, contrôle avant envoi et exemple de prix — module pur, testé (pricing-rows.test.ts). L'enregistrement reste
// celui de savePricingRule (une règle par catégorie, mêmes bornes, même conversion en centimes).
import { estimatePrice, formatPrice, type VehicleCategory } from "@rydar/shared";

export const PRICE_FIELDS = ["base", "km", "min", "minimum", "night"] as const;
export type PriceField = (typeof PRICE_FIELDS)[number];
/** Valeurs telles que saisies (« 1,8 ») ; vide = non renseigné. */
export type PriceRow = Record<PriceField, string>;

export const EMPTY_ROW: PriceRow = { base: "", km: "", min: "", minimum: "", night: "" };

/**
 * « Utiliser des valeurs de départ » : les valeurs que la grille préremplissait avant R10 pour une catégorie sans tarif
 * (10 € de prise en charge, 2 €/km, 0,50 €/min, 30 € minimum, nuit 15 %), désormais proposées et jamais affichées comme
 * un tarif existant.
 */
export const STARTER_ROW: PriceRow = { base: "10", km: "2", min: "0,5", minimum: "30", night: "15" };

/** Règle enregistrée (pricing_rules), colonnes lues par la grille. */
export type StoredRule = {
  vehicle_category: VehicleCategory;
  base_fare_cents: number;
  per_km_cents: number;
  per_minute_cents: number;
  minimum_fare_cents: number;
  night_surcharge_percent: number;
  night_start?: string | null;
  night_end?: string | null;
  fixed_fares?: { label: string; price_cents: number }[] | null;
};

/** Champs envoyés à savePricingRule (en plus de la catégorie, du nom et des forfaits). */
export type PricingValues = {
  base_fare_cents: number;
  per_km_cents: number;
  per_minute_cents: number;
  minimum_fare_cents: number;
  night_surcharge_percent: number;
};

/** Bornes de savePricingRule (app/dashboard/settings/actions.ts, pricingSchema), en centimes ou en %. */
const MAX: Record<PriceField, number> = { base: 1_000_000, km: 100_000, min: 100_000, minimum: 1_000_000, night: 200 };

/** Nombre → « 1,8 » (virgule décimale, deux décimales au plus, sans zéro inutile). */
function decimalField(n: number): string {
  return String(Number(n.toFixed(2))).replace(".", ",");
}

/** Centimes → « 1,8 » ; absent → vide. */
export function centsToField(cents: number | null | undefined): string {
  return cents == null || !Number.isFinite(cents) ? "" : decimalField(cents / 100);
}

/** Règle enregistrée → ligne ; catégorie sans règle → ligne vide (jamais de valeurs inventées). */
export function rowFromRule(rule: StoredRule | null | undefined): PriceRow {
  if (!rule) return { ...EMPTY_ROW };
  return {
    base: centsToField(rule.base_fare_cents),
    km: centsToField(rule.per_km_cents),
    min: centsToField(rule.per_minute_cents),
    minimum: centsToField(rule.minimum_fare_cents),
    night: rule.night_surcharge_percent == null ? "" : decimalField(Number(rule.night_surcharge_percent)),
  };
}

const norm = (v: string) => v.trim().replace(/\s/g, "").replace(".", ",");

/** Ligne modifiée : au moins une valeur diffère de la valeur enregistrée (espaces et « . » / « , » ignorés). */
export function rowChanged(initial: PriceRow, current: PriceRow): boolean {
  return PRICE_FIELDS.some((f) => norm(initial[f]) !== norm(current[f]));
}

/** Catégories modifiées, dans l'ordre d'affichage : chacune sera enregistrée, l'une après l'autre. */
export function changedCategories(
  order: readonly VehicleCategory[],
  initial: Partial<Record<VehicleCategory, PriceRow>>,
  current: Partial<Record<VehicleCategory, PriceRow>>,
): VehicleCategory[] {
  return order.filter((cat) => rowChanged(initial[cat] ?? EMPTY_ROW, current[cat] ?? EMPTY_ROW));
}

/** « 1,8 » ou « 1.8 » → 1.8 ; vide ou illisible → NaN. */
export function parseDecimal(v: string): number {
  const s = v.trim().replace(/\s/g, "").replace(",", ".");
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : Number.NaN;
}

/**
 * Contrôle d'une ligne avant envoi : valeurs converties comme avant (montants en centimes arrondis, nuit en %), ou une
 * erreur par champ. Une ligne enregistrée doit être complète (0 est une valeur : « 0 » pour aucune majoration).
 */
export function parseRow(row: PriceRow): { ok: true; value: PricingValues } | { ok: false; errors: Partial<Record<PriceField, string>> } {
  const errors: Partial<Record<PriceField, string>> = {};
  const read = (f: PriceField) => {
    const raw = row[f];
    if (!raw.trim()) {
      errors[f] = "Indiquez une valeur (0 si aucune)";
      return 0;
    }
    const n = parseDecimal(raw);
    if (Number.isNaN(n)) {
      errors[f] = "Nombre attendu (ex. : 1,8)";
      return 0;
    }
    const v = f === "night" ? n : Math.round(n * 100);
    if (v > MAX[f]) errors[f] = f === "night" ? "200 % au maximum" : `${formatPrice(MAX[f])} au maximum`;
    return v;
  };
  const value: PricingValues = {
    base_fare_cents: read("base"),
    per_km_cents: read("km"),
    per_minute_cents: read("min"),
    minimum_fare_cents: read("minimum"),
    night_surcharge_percent: read("night"),
  };
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

/** Champ d'erreur renvoyé par savePricingRule (fieldErrors) → champ de la ligne. */
export const SERVER_FIELD: Record<string, PriceField> = {
  base_fare_cents: "base",
  per_km_cents: "km",
  per_minute_cents: "min",
  minimum_fare_cents: "minimum",
  night_surcharge_percent: "night",
};

/** Exemple affiché sous une ligne complète : 20 km et 30 min. */
export const EXAMPLE_TRIP = { distanceM: 20_000, durationS: 1_800 } as const;

/**
 * Prix de l'exemple « 20 km, 30 min, de jour » calculé par estimatePrice (même calcul que la saisie d'une course et
 * le devis de l'API) ; de jour : majoration de nuit neutralisée. Ligne incomplète ou invalide : null.
 */
export function dayExampleCents(row: PriceRow, category: VehicleCategory, timeZone = "Europe/Paris"): number | null {
  const parsed = parseRow(row);
  if (!parsed.ok) return null;
  return estimatePrice(
    { vehicle_category: category, ...parsed.value, night_surcharge_percent: 0, night_start: "21:00", night_end: "06:00" },
    EXAMPLE_TRIP.distanceM,
    EXAMPLE_TRIP.durationS,
    // Midi en hiver à Paris : instant fixe (rendu identique au serveur et au navigateur)
    new Date("2026-01-15T11:00:00Z"),
    timeZone,
  );
}

/** « 21:00:00 » → « 21 h » ; « 06:30 » → « 6 h 30 » ; illisible → null. */
export function hourLabel(time: string | null | undefined): string | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(time ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return min ? `${h} h ${String(min).padStart(2, "0")}` : `${h} h`;
}

/** Plage de la majoration de nuit d'une règle (« de 21 h à 6 h ») ; sans règle : heures par défaut de la base. */
export function nightRangeLabel(rule: Pick<StoredRule, "night_start" | "night_end"> | null | undefined): string {
  const start = hourLabel(rule?.night_start ?? "21:00") ?? "21 h";
  const end = hourLabel(rule?.night_end ?? "06:00") ?? "6 h";
  return `de ${start} à ${end}`;
}
