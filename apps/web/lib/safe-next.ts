// Destination après connexion (paramètre « next » de /login et /auth/callback) : chemin INTERNE seulement.
// Fonction pure (sans import serveur), testée dans safe-next.test.ts.

/** Pages vers lesquelles une connexion peut renvoyer (proxy.ts protège /dashboard et /admin). */
const ALLOWED = ["/dashboard", "/admin", "/auth/set-password"];
const FALLBACK = "/dashboard";

/**
 * Chemin relatif du même site, sous /dashboard, /admin ou /auth/set-password ; sinon /dashboard.
 * Refusés : « //hôte », barre oblique inverse (« /\hôte » : le navigateur la lit comme « / »), caractères de contrôle
 * (« /<TAB>/hôte » : retirés par le navigateur), URL absolue, préfixe voisin (« /dashboardx »).
 */
export function safeNext(next: unknown): string {
  if (typeof next !== "string" || !next || next.length > 2048) return FALLBACK;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return FALLBACK;
  if (!next.startsWith("/") || next.startsWith("//")) return FALLBACK;
  let url: URL;
  try {
    url = new URL(next, "http://rydar.invalid");
  } catch {
    return FALLBACK;
  }
  if (url.origin !== "http://rydar.invalid") return FALLBACK;
  if (!ALLOWED.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) return FALLBACK;
  return `${url.pathname}${url.search}`;
}
