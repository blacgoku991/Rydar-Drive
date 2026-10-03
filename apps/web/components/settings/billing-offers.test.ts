import { describe, expect, it } from "vitest";
import { annualFreeMonths } from "./billing-offers";

// Revue de conformité : l'avantage de l'abonnement annuel est calculé sur les prix réels (saisis librement par le super
// admin), jamais écrit en dur ni arrondi à la hausse (pratique commerciale trompeuse, C. conso. L121-2 et L121-5).
describe("annualFreeMonths", () => {
  it("annuel = 10 mois pour toutes les offres payantes : 2 mois offerts ; les offres gratuites sont ignorées", () => {
    expect(annualFreeMonths([
      { price_monthly_cents: 4900, price_yearly_cents: 49000 },
      { price_monthly_cents: 9900, price_yearly_cents: 99000 },
      { price_monthly_cents: 0, price_yearly_cents: 0 },
    ])).toBe(2);
  });

  it("économie non entière : arrondie vers le bas (jamais exagérée)", () => {
    expect(annualFreeMonths([{ price_monthly_cents: 4900, price_yearly_cents: 50000 }])).toBe(1);
  });

  it("avantage différent selon les offres, nul ou absent : rien n'est annoncé", () => {
    expect(annualFreeMonths([
      { price_monthly_cents: 4900, price_yearly_cents: 49000 },
      { price_monthly_cents: 9900, price_yearly_cents: 108900 },
    ])).toBeNull();
    expect(annualFreeMonths([{ price_monthly_cents: 4900, price_yearly_cents: 58800 }])).toBeNull();
    expect(annualFreeMonths([{ price_monthly_cents: 4900, price_yearly_cents: null }])).toBeNull();
    expect(annualFreeMonths([])).toBeNull();
  });
});
