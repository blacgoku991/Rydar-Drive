// Offre payable en ligne par /api/billing/checkout — module pur (testé : lib/private-fleet.test.ts), importé par chemin
// relatif : la route est chargée telle quelle par les tests unitaires (alias « @/ » simulés un à un).

/**
 * Flotte Privée → seulement l'offre attribuée par le super admin (même non publique), jamais une offre publique (ses
 * limites sont fixées par son contrat, docs/FLOTTE-PRIVEE.md § 7.6) ; organisation standard → offre publique, ou l'offre
 * négociée attribuée à cette organisation.
 */
export function checkoutPlanAllowed(input: {
  privateFleet: boolean;
  plan: { id: string; is_public: boolean | null } | null | undefined;
  orgPlanId: string | null | undefined;
}): boolean {
  const { plan, orgPlanId } = input;
  if (!plan) return false;
  const assigned = !!orgPlanId && plan.id === orgPlanId;
  if (input.privateFleet) return assigned;
  return plan.is_public === true || assigned;
}
