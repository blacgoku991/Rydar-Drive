import { estimatePrice, formatPrice, VEHICLE_CATEGORIES } from "@rydar/shared";
import { describe, expect, it } from "vitest";
import {
  EMPTY_ROW, STARTER_ROW, centsToField, changedCategories, dayExampleCents, hourLabel, nightRangeLabel, parseDecimal, parseRow, rowChanged, rowFromRule,
  type PriceRow, type StoredRule,
} from "./pricing-rows";

// Réglages › Tarifs (docs/REFONTE-PANELS.md § 5.6, R10) : une catégorie sans tarif n'affiche plus de valeurs ;
// un seul « Enregistrer » envoie chaque ligne modifiée (savePricingRule, inchangée), l'une après l'autre.

const RULE: StoredRule = {
  vehicle_category: "business",
  base_fare_cents: 1200,
  per_km_cents: 180,
  per_minute_cents: 50,
  minimum_fare_cents: 4500,
  night_surcharge_percent: 15,
  night_start: "21:00:00",
  night_end: "06:00:00",
  fixed_fares: [],
};

describe("lignes de la grille", () => {
  it("règle enregistrée → valeurs en euros avec la virgule décimale (« 1,8 »)", () => {
    expect(rowFromRule(RULE)).toEqual({ base: "12", km: "1,8", min: "0,5", minimum: "45", night: "15" });
    expect(centsToField(1999)).toBe("19,99");
    expect(centsToField(null)).toBe("");
  });

  it("catégorie sans règle : ligne vide (plus de 10 / 2 / 0,5 / 30 / 15 affichés comme un tarif)", () => {
    expect(rowFromRule(undefined)).toEqual(EMPTY_ROW);
    expect(rowFromRule(null)).toEqual({ base: "", km: "", min: "", minimum: "", night: "" });
  });

  it("valeurs de départ : proposées, complètes et valides", () => {
    expect(parseRow(STARTER_ROW)).toEqual({
      ok: true,
      value: { base_fare_cents: 1000, per_km_cents: 200, per_minute_cents: 50, minimum_fare_cents: 3000, night_surcharge_percent: 15 },
    });
  });
});

describe("lignes modifiées", () => {
  const initial: Partial<Record<(typeof VEHICLE_CATEGORIES)[number], PriceRow>> = {
    standard: { base: "8", km: "1,6", min: "0,4", minimum: "25", night: "15" },
    business: rowFromRule(RULE),
    first: { ...EMPTY_ROW },
  };

  it("même valeur écrite autrement (« 1.8 », espaces) : pas une modification", () => {
    expect(rowChanged(initial.business!, { ...initial.business!, km: " 1.8 " })).toBe(false);
    expect(rowChanged(initial.business!, { ...initial.business!, km: "1,9" })).toBe(true);
  });

  it("deux lignes modifiées → deux enregistrements, dans l'ordre d'affichage ; ligne vide restée vide : rien", () => {
    const current = {
      ...initial,
      business: { ...initial.business!, base: "13" },
      standard: { ...initial.standard!, night: "20" },
      first: { ...EMPTY_ROW },
    };
    expect(changedCategories(VEHICLE_CATEGORIES, initial, current)).toEqual(["standard", "business"]);
    expect(changedCategories(["business", "standard"], initial, current)).toEqual(["business", "standard"]);
  });

  it("catégorie sans règle remplie : modifiée ; aucune saisie : aucune ligne", () => {
    expect(changedCategories(VEHICLE_CATEGORIES, initial, { ...initial, first: STARTER_ROW })).toEqual(["first"]);
    expect(changedCategories(VEHICLE_CATEGORIES, initial, initial)).toEqual([]);
    // Catégorie absente des deux côtés : traitée comme une ligne vide
    expect(changedCategories(["van"], {}, {})).toEqual([]);
  });
});

describe("contrôle avant envoi", () => {
  it("même conversion qu'avant : euros → centimes arrondis, nuit en %", () => {
    expect(parseDecimal("1,8")).toBe(1.8);
    expect(parseDecimal("1.25")).toBe(1.25);
    expect(parseDecimal("")).toBeNaN();
    expect(parseDecimal("abc")).toBeNaN();
    expect(parseRow({ base: "12,345", km: "2", min: "0,5", minimum: "45", night: "15,5" })).toEqual({
      ok: true,
      value: { base_fare_cents: 1235, per_km_cents: 200, per_minute_cents: 50, minimum_fare_cents: 4500, night_surcharge_percent: 15.5 },
    });
  });

  it("ligne incomplète ou hors bornes : une erreur sous chaque champ concerné", () => {
    const res = parseRow({ base: "", km: "2", min: "x", minimum: "20000", night: "250" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.base).toBe("Indiquez une valeur (0 si aucune)");
    expect(res.errors.km).toBeUndefined();
    expect(res.errors.min).toBe("Nombre attendu (ex. : 1,8)");
    expect(res.errors.minimum).toBe(`${formatPrice(1_000_000)} au maximum`);
    expect(res.errors.night).toBe("200 % au maximum");
  });

  it("0 est une valeur (aucune majoration de nuit)", () => {
    expect(parseRow({ base: "0", km: "2", min: "0", minimum: "0", night: "0" }).ok).toBe(true);
  });
});

describe("exemple et heures de nuit", () => {
  it("« Ex. 20 km, 30 min, de jour » : prix d'estimatePrice, sans majoration", () => {
    const row = rowFromRule(RULE);
    const expected = estimatePrice({ ...RULE, fixed_fares: [], night_start: "21:00", night_end: "06:00" }, 20_000, 1_800, new Date("2026-01-15T11:00:00Z"), "Europe/Paris");
    expect(dayExampleCents(row, "business")).toBe(expected);
    // 12 + 20 × 1,8 + 30 × 0,5 = 63 € (au-dessus du minimum de 45 €)
    expect(dayExampleCents(row, "business")).toBe(6300);
    // Minimum appliqué
    expect(dayExampleCents({ ...row, minimum: "90" }, "business")).toBe(9000);
    expect(dayExampleCents({ ...row, km: "" }, "business")).toBeNull();
  });

  it("plage de la majoration de nuit lue dans la règle, heures par défaut sinon", () => {
    expect(nightRangeLabel(RULE)).toBe("de 21 h à 6 h");
    expect(nightRangeLabel({ night_start: "22:30:00", night_end: "05:00:00" })).toBe("de 22 h 30 à 5 h");
    expect(nightRangeLabel(null)).toBe("de 21 h à 6 h");
    expect(hourLabel("25:00")).toBeNull();
  });
});
