/**
 * Lecture (SANS vérification) d'un jeton d'accès Supabase lu dans les cookies de session.
 *
 * Ne sert qu'à deux choses, jamais à accorder un droit :
 *  - savoir si la signature peut être vérifiée localement (clés asymétriques publiées dans le JWKS : en-tête `kid` et
 *    algorithme non HS*) ou seulement par un appel à Auth (secret HS256) ;
 *  - connaître le `sub` pour lancer les lectures de session en même temps que getUser(), qui reste le contrôle qui fait
 *    foi (lib/auth.ts) ; PostgREST vérifie de toute façon la signature de chaque requête.
 */
export type JwtParts = { header: { alg?: string; kid?: string }; payload: { sub?: unknown; exp?: unknown } };

function decodePart(part: string): unknown {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function decodeJwt(token: string | null | undefined): JwtParts | null {
  if (!token || token.length > 16_384) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = decodePart(parts[0]!);
    const payload = decodePart(parts[1]!);
    if (!header || typeof header !== "object" || !payload || typeof payload !== "object") return null;
    return { header: header as JwtParts["header"], payload: payload as JwtParts["payload"] };
  } catch {
    return null;
  }
}

/** `sub` du jeton (non vérifié), ou null. */
export function jwtSub(token: string | null | undefined): string | null {
  const sub = decodeJwt(token)?.payload.sub;
  return typeof sub === "string" && sub ? sub : null;
}

/**
 * Signature vérifiable sur place par auth-js getClaims() (même règle que GoTrueClient.getClaims 2.117, algorithmes de
 * helpers.getAlgorithm) : clé asymétrique ES256 / RS256 désignée par `kid`, cherchée dans le JWKS public gardé 10 min
 * par processus. Sinon (HS256 : secret partagé), getClaims() appelle Auth (GET /auth/v1/user) à chaque fois.
 */
export function verifiableLocally(header: JwtParts["header"]): boolean {
  return (header.alg === "ES256" || header.alg === "RS256") && typeof header.kid === "string" && !!header.kid;
}
