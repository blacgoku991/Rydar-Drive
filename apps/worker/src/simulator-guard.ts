/**
 * Garde-fou du simulateur de flotte : il agit au nom de VRAIS chauffeurs (positions, offres acceptées, courses
 * terminées → frais plateforme au registre immuable, fausses courses). Refusé quand NODE_ENV=production (image du
 * worker, deploy/docker-compose.yml), sauf demande explicite SIM_ALLOW_PRODUCTION=1 (recette sur une base jetable).
 * Renvoie le motif du refus, ou null si le lancement est permis.
 */
export function simulatorRefusal(env: Record<string, string | undefined>): string | null {
  if (env.NODE_ENV !== "production") return null;
  if (env.SIM_ALLOW_PRODUCTION === "1") return null;
  return "simulateur interdit en production (NODE_ENV=production) : il agit au nom de vrais chauffeurs. Recette sur une base jetable seulement : SIM_ALLOW_PRODUCTION=1";
}
