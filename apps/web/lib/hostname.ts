// Noms d'hôte des mini-sites (proxy.ts, /api/tls/allowed) : même validation partout, avant tout appel à Supabase.

/** Nom de domaine DNS en minuscules : 3 à 253 caractères, au moins deux labels de 1 à 63 caractères [a-z0-9-]. */
export const HOSTNAME_RE = /^(?=.{3,253}$)(?!-)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/;

export function isValidHostname(host: string): boolean {
  return HOSTNAME_RE.test(host);
}

/**
 * En-tête Host → nom d'hôte normalisé (minuscules, sans port ni point final), ou null s'il n'est pas un nom de
 * domaine plausible (IP, IPv6, caractères interdits, trop long…).
 */
export function bookingHostKey(rawHost: string | null | undefined): string | null {
  if (!rawHost || rawHost.length > 260) return null;
  const host = rawHost.split(":")[0]!.toLowerCase().replace(/\.$/, "");
  return isValidHostname(host) ? host : null;
}
