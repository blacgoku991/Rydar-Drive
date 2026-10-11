// Imports relatifs : module pur, testé sans alias (billing-offers.test.ts)
import { plural } from "../../lib/wording";
import { limitEnabled } from "../admin/private-fleet-state";

const NB = "\u00a0";

/**
 * Mois offerts par l'abonnement annuel, calculés sur les prix réels des offres payantes affichées (le super admin
 * saisit librement le prix annuel) : nombre entier de mois économisés, arrondi vers le bas (jamais un avantage
 * exagéré : pratique commerciale trompeuse, C. conso. L121-2 et L121-5), et le même pour toutes les offres ; sinon
 * null (aucun avantage annoncé).
 */
export function annualFreeMonths(plans: { price_monthly_cents?: number | null; price_yearly_cents?: number | null }[]): number | null {
  const paid = plans.filter((p) => (p.price_monthly_cents ?? 0) > 0 && (p.price_yearly_cents ?? 0) > 0);
  if (!paid.length) return null;
  const months = paid.map((p) => Math.floor(12 - p.price_yearly_cents! / p.price_monthly_cents! + 1e-9));
  const n = months[0]!;
  return n >= 1 && months.every((m) => m === n) ? n : null;
}

/**
 * Points forts de l'offre d'une Flotte Privée (docs/FLOTTE-PRIVEE.md § 7.6) : ce que son offre lui donne VRAIMENT, lu
 * dans ses limites effectives (org_usage → private.org_limits : offre, ajustements, puis 1 chauffeur et 1 accès
 * imposés), jamais les points forts saisis pour les offres publiques (« Mini-site de réservation », « Jusqu'à
 * 40 chauffeurs », « Tout Starter »…) : son site réserve par l'API, l'espace n'a ni mini-site ni domaine. `limits` null
 * (lecture impossible) : seulement ce que la base impose. Affichage seulement : les limites restent celles de la base.
 */
export function privateFleetPlanFeatures(limits: Record<string, unknown> | null | undefined): string[] {
  const features = [`Un seul chauffeur${NB}: vous`];
  if (!limits) return features;
  const rides = limits.max_rides_per_month;
  features.push(typeof rides === "number" && Number.isFinite(rides) && rides >= 0 ? `${plural(rides, "réservation")} par mois` : "Réservations illimitées");
  if (limitEnabled(limits.api_access)) features.push("API de réservation (votre site)");
  if (limitEnabled(limits.advanced_stats)) features.push("Statistiques avancées");
  return features;
}
