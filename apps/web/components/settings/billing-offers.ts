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
