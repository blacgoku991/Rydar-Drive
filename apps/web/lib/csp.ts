/**
 * Content-Security-Policy des pages, posée par le proxy (proxy.ts) avec un nonce NEUF à chaque requête : Next.js le lit
 * dans l'en-tête de la requête et l'ajoute à ses propres scripts (runtime, morceaux de page, données RSC en ligne) ; nos
 * scripts en ligne le reçoivent par `x-nonce` (app/layout.tsx). Plus de 'unsafe-inline' pour les scripts : un script
 * injecté sans le nonce du jour ne s'exécute pas. 'strict-dynamic' : les morceaux chargés ensuite par un script
 * autorisé le sont aussi. Le nonce impose le rendu à la demande de chaque page (layout racine : headers()).
 * Styles : 'unsafe-inline' gardé (attributs style de React et de MapLibre), sans effet sur l'exécution de code.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseOrigin = supabaseUrl ? new URL(supabaseUrl).origin : "";
const supabaseWs = supabaseOrigin.replace(/^http/, "ws");
// Origine de Supabase connue au build : elle seule ; le joker *.supabase.co (repli sans adresse) laisserait un script
// injecté envoyer des données vers n'importe quel autre projet Supabase (audit p5 web-4)
const supabaseConnect = supabaseOrigin ? `${supabaseOrigin} ${supabaseWs}` : "https://*.supabase.co wss://*.supabase.co";
const mapOrigins = (
  process.env.NEXT_PUBLIC_MAP_CONNECT_ORIGINS ||
  "https://*.basemaps.cartocdn.com https://basemaps.cartocdn.com https://tiles.openfreemap.org https://api.maptiler.com https://api.mapbox.com"
)
  .split(/\s+/)
  .filter(Boolean);

/** Nonce de 128 bits aléatoires, en base64 (jamais réutilisé d'une requête à l'autre). */
export function cspNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/** Seuls le mini-site et le module à intégrer s'affichent dans un cadre (site du rattacheur), comme X-Frame-Options. */
export const frameableOnAnySite = (pathname: string) => /^\/(book|embed)(\/|$)/.test(pathname);

export function contentSecurityPolicy({ nonce, frameAncestors }: { nonce: string; frameAncestors: string }): string {
  return [
    "default-src 'self'",
    // Développement seulement : React reconstruit les piles d'erreur du serveur avec eval
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'` + (process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${supabaseConnect} ${mapOrigins.join(" ")}`,
    "worker-src 'self' blob:",
    "child-src blob:",
    "frame-src 'self' https://checkout.stripe.com https://billing.stripe.com",
    `frame-ancestors ${frameAncestors}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://checkout.stripe.com",
  ].join("; ");
}
