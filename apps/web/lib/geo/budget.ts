import "server-only";
import { rateLimitAll } from "@/lib/rate-limit";

// -----------------------------------------------------------------------------
// Budget quotidien des fournisseurs géo payants (Google, Mapbox) : GEO_DAILY_BUDGET (défaut 20 000 / jour),
// compté à part pour les adresses et pour les itinéraires, avec des sous-plafonds pour qu'un seul consommateur
// (une IP, un mini-site, une centrale, un utilisateur) ne puisse pas l'épuiser pour tous :
//   visiteur anonyme (mini-site, clé API « navigateur ») : 2 % par IP (/64), 10 % par mini-site,
//                                                          30 % pour tous les anonymes réunis ;
//   centrale (tableau de bord, clé API serveur)           : 30 % par centrale ;
//   utilisateur connecté (autocomplétion)                 : 30 % par utilisateur.
// Au-delà : repli gratuit (Géoplateforme / BAN pour les adresses, OSRM auto-hébergé ou estimation pour les
// itinéraires). Fenêtre alignée sur le jour UTC (compteurs Redis).
// -----------------------------------------------------------------------------

export type GeoConsumer =
  /** Visiteur anonyme : IP groupée (ipBucket) et, s'il est connu, le mini-site (centrale) consulté */
  | { kind: "visitor"; ip: string; org?: string | null }
  /** Centrale : tableau de bord, devis, clé API serveur */
  | { kind: "org"; org: string }
  /** Utilisateur connecté (autocomplétion des adresses, sans centrale connue) */
  | { kind: "user"; user: string };

export const GEO_BUDGET_SHARES = { ip: 0.02, site: 0.1, anonymous: 0.3, org: 0.3, user: 0.3 } as const;

const DAY = 86_400;

export function geoDailyBudget(): number {
  return Number(process.env.GEO_DAILY_BUDGET) || 20_000;
}

/**
 * Une requête payante est-elle permise ? Sous-plafonds du consommateur puis budget global, dans cet ordre : un
 * consommateur au-delà de sa part ne consomme plus le budget commun. Sans consommateur : budget global seul.
 */
export async function paidGeoAllowed(kind: "route" | "geocode", provider: string, consumer?: GeoConsumer | null): Promise<boolean> {
  const budget = geoDailyBudget();
  const share = (s: number) => Math.max(1, Math.floor(budget * s));
  const base = `geobudget:${kind}:${provider}`;
  const checks: { key: string; limit: number; windowSec: number }[] = [];
  if (consumer?.kind === "visitor") {
    checks.push({ key: `${base}:ip:${consumer.ip}`, limit: share(GEO_BUDGET_SHARES.ip), windowSec: DAY });
    if (consumer.org) checks.push({ key: `${base}:site:${consumer.org}`, limit: share(GEO_BUDGET_SHARES.site), windowSec: DAY });
    checks.push({ key: `${base}:anon`, limit: share(GEO_BUDGET_SHARES.anonymous), windowSec: DAY });
  } else if (consumer?.kind === "org") {
    checks.push({ key: `${base}:org:${consumer.org}`, limit: share(GEO_BUDGET_SHARES.org), windowSec: DAY });
  } else if (consumer?.kind === "user") {
    checks.push({ key: `${base}:user:${consumer.user}`, limit: share(GEO_BUDGET_SHARES.user), windowSec: DAY });
  }
  checks.push({ key: base, limit: budget, windowSec: DAY });
  return (await rateLimitAll(checks)).ok;
}
