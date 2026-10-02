/**
 * Le JWKS public d'Auth publie-t-il une clé asymétrique (ES256 / RS256…) ? Cas de la production : tout jeton légitime y
 * est signé par une telle clé (en-tête `kid`), et un jeton HS256 n'est alors qu'un jeton émis avant une rotation des
 * clés ou un jeton falsifié : le proxy le fait vérifier par Auth (getClaims → /auth/v1/user), comme avant.
 * Pile en HS256 seul (secret partagé, JWKS vide : pile locale) : aiguillage sans appel à Auth.
 *
 * Lu une fois par processus et gardé 10 min (comme le cache JWKS d'auth-js) ; seuls les jetons non asymétriques
 * déclenchent cette lecture. JWKS illisible : réponse prudente (true = vérification par Auth), gardée 30 s.
 */
const TTL_MS = 10 * 60_000;
const FAILURE_TTL_MS = 30_000;

let cache: { url: string; asymmetric: boolean; expires: number } | null = null;
let inflight: { url: string; promise: Promise<boolean> } | null = null;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

async function readJwks(url: string, apiKey: string, fetchImpl: Fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(url, {
      headers: apiKey ? { apikey: apiKey } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) throw new Error(`JWKS ${res.status}`);
    const body: unknown = await res.json();
    const keys = body && typeof body === "object" ? (body as { keys?: unknown }).keys : undefined;
    if (!Array.isArray(keys)) throw new Error("JWKS sans liste de clés");
    // Toute clé autre que symétrique (« oct », jamais publiée en principe) compte : une forme inconnue → prudence
    const asymmetric = keys.some((k) => !k || typeof k !== "object" || (k as { kty?: unknown }).kty !== "oct");
    cache = { url, asymmetric, expires: Date.now() + TTL_MS };
    return asymmetric;
  } catch {
    cache = { url, asymmetric: true, expires: Date.now() + FAILURE_TTL_MS };
    return true;
  }
}

export async function publishesAsymmetricKey(supabaseUrl: string, apiKey: string, fetchImpl: Fetch): Promise<boolean> {
  const url = `${supabaseUrl}/auth/v1/.well-known/jwks.json`;
  if (cache && cache.url === url && cache.expires > Date.now()) return cache.asymmetric;
  // Une seule lecture à la fois (requêtes simultanées à froid)
  if (inflight && inflight.url === url) return inflight.promise;
  const promise = readJwks(url, apiKey, fetchImpl).finally(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  inflight = { url, promise };
  return promise;
}

/** Tests : oublie le JWKS mémorisé. */
export function resetJwksCache(): void {
  cache = null;
  inflight = null;
}
