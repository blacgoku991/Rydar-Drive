import { describe, expect, it } from "vitest";
import { annualFreeMonths, privateFleetPlanFeatures } from "./billing-offers";

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

// Flotte Privée (revue de la refonte, RV-02) : l'offre affichée dit ce que la base lui donne (1 chauffeur imposé, API,
// statistiques), jamais les points forts des offres publiques (mini-site, « Jusqu'à 40 chauffeurs », « Tout Starter »).
describe("privateFleetPlanFeatures", () => {
  const nb = (t: string) => t.replace(/[  ]/g, " ");
  it("limites effectives de l'offre Pro en Flotte Privée : un chauffeur, réservations du mois, API, statistiques", () => {
    const pro = { max_drivers: 1, max_rides_per_month: 3000, max_admins: 1, api_access: true, booking_site: true, custom_domain: false, advanced_stats: true };
    expect(privateFleetPlanFeatures(pro).map(nb)).toEqual([
      "Un seul chauffeur : vous",
      "3 000 réservations par mois",
      "API de réservation (votre site)",
      "Statistiques avancées",
    ]);
    const text = privateFleetPlanFeatures(pro).join(" ");
    expect(text).not.toMatch(/mini-site|domaine|Jusqu|Tout /i);
  });

  it("illimité, options absentes ou fausses, lecture impossible", () => {
    expect(privateFleetPlanFeatures({ max_rides_per_month: null, api_access: "t", advanced_stats: false }).map(nb)).toEqual([
      "Un seul chauffeur : vous",
      "Réservations illimitées",
      "API de réservation (votre site)",
    ]);
    expect(privateFleetPlanFeatures({ max_rides_per_month: 1 }).map(nb)).toEqual(["Un seul chauffeur : vous", "1 réservation par mois"]);
    expect(privateFleetPlanFeatures(null).map(nb)).toEqual(["Un seul chauffeur : vous"]);
  });
});
