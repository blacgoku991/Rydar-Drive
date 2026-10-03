/**
 * Délai maximal des appels à l'API web (connexion, mot de passe oublié, suppression du compte, inscription).
 * Android (React Native) n'impose AUCUN délai à fetch : une connexion dont le NAT de l'opérateur a perdu l'état, ou un
 * portail captif, laissait la requête pendante pour toujours (bouton bloqué en chargement, seul recours : tuer l'app).
 */
export const WEB_REQUEST_TIMEOUT_MS = 25_000;

/** Message d'une requête coupée (délai dépassé) ou impossible (réseau absent). */
export const NETWORK_ERROR_TEXT = "Réseau indisponible ou trop lent. Réessayez.";

/** fetch annulé au bout de `ms` (réponse complète comprise) ; un signal fourni par l'appelant reste respecté. */
export function fetchWithDeadline(input: string, init: RequestInit = {}, ms = WEB_REQUEST_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const outer = init.signal;
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}
