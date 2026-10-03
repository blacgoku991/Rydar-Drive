import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { lruCache } from "@/lib/geo/cache";
import { bookingHostKey } from "@/lib/hostname";
import { serverFetch } from "@/lib/server-fetch";
import { publishesAsymmetricKey } from "@/lib/supabase/jwks";
import { decodeJwt, verifiableLocally } from "@/lib/supabase/jwt";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "";
const APP_HOST = new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").hostname;
const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN || "rydar.app";

/** Mini-site trouvé : 5 min ; aucun mini-site : 30 s (un site tout juste activé ou vérifié apparaît vite). */
const HOST_TTL_MS = 5 * 60_000;
const HOST_MISS_TTL_MS = 30_000;
/** Cache borné (LRU) : l'en-tête Host est choisi par le client, jamais de croissance illimitée. */
const hostCache = lruCache<{ slug: string | null; expires: number }>(2_000, HOST_TTL_MS);

/** Sous-domaine (elite.rydar.app) ou domaine personnalisé → slug du mini-site ; host déjà normalisé et validé. */
async function resolveBookingSlug(host: string): Promise<string | null> {
  const cached = hostCache.get(host);
  if (cached && cached.expires > Date.now()) return cached.slug;
  try {
    const res = await serverFetch(`${SUPABASE_URL}/rest/v1/rpc/resolve_booking_host`, {
      method: "POST",
      // apikey seul : rôle anon pour une ancienne clé JWT comme pour une clé publishable (sb_publishable_…, pas un JWT)
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ p_host: host, p_root_domain: ROOT_DOMAIN }),
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
    });
    // Échec transitoire (Supabase indisponible, délai dépassé) : jamais mis en cache
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const slug = typeof data === "string" && data ? data : null;
    hostCache.set(host, { slug, expires: Date.now() + (slug ? HOST_TTL_MS : HOST_MISS_TTL_MS) });
    return slug;
  } catch {
    return null;
  }
}

/**
 * Aiguillage seulement (redirection vers /login) : le contrôle qui fait foi est getUser() au rendu de chaque layout et
 * page protégés (lib/auth.ts : requireUser / requireOrg / requireSuperAdmin ; routes d'export : getSession) et sur
 * /login ci-dessous. PostgREST vérifie aussi la signature de chaque requête, sous RLS.
 *
 * getSession() lit les cookies et ne contacte Auth que pour rafraîchir un jeton expiré (cookies réécrits par setAll) :
 * c'est le rôle du proxy, sur toutes les requêtes (préchargements compris), et il est gardé.
 *  - Jeton à clé asymétrique (ES256 / RS256 + kid, cas de la production) : signature vérifiée sur place par getClaims()
 *    (JWKS public gardé 10 min par processus), sans appel réseau.
 *  - Autre jeton (HS256, sans kid…) alors qu'Auth publie une clé asymétrique (production) : jeton émis avant une
 *    rotation des clés, ou falsifié → getClaims() le fait vérifier par Auth (/auth/v1/user), comme avant ; refusé →
 *    /login?next=… dès le proxy (lib/supabase/jwks.ts, JWKS lu une fois par processus et gardé 10 min).
 *  - Pile en HS256 seul (JWKS vide : pile locale) : seule une requête à Auth pourrait vérifier la signature. Elle n'est
 *    pas faite ici à chaque requête : un jeton illisible ou falsifié passe l'aiguillage mais est refusé au rendu
 *    (getUser → /login), sans aucune donnée lue (PostgREST le refuse aussi).
 */
async function hasSession(supabase: ReturnType<typeof createServerClient>): Promise<boolean> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  const jwt = decodeJwt(token);
  if (!token || !jwt) return false;
  if (verifiableLocally(jwt.header) || (await publishesAsymmetricKey(SUPABASE_URL, SUPABASE_KEY, serverFetch))) {
    const { data } = await supabase.auth.getClaims(token);
    return !!data?.claims?.sub;
  }
  return typeof jwt.payload.sub === "string" && !!jwt.payload.sub;
}

const PROTECTED = ["/dashboard", "/admin"];
/**
 * Pages légales de la plateforme : servies telles quelles sur les mini-sites (liens du mini-site et du bandeau cookies),
 * réseau partagé compris (convention et conditions des chauffeurs).
 */
const LEGAL_PATHS = new Set([
  "/mentions-legales", "/cgu", "/cgv", "/confidentialite", "/cookies", "/dpa", "/suppression-compte", "/abonnement-resiliation",
  "/accessibilite", "/reseau-partage/conditions", "/reseau-partage/chauffeur",
]);
/**
 * Pages légales, textes précédents compris (/cgv/AAAA-MM-JJ et /dpa/AAAA-MM-JJ : pages figées, liens « Version
 * précédente » / « Texte accepté avant la correction »).
 */
const isLegalPath = (pathname: string) => LEGAL_PATHS.has(pathname) || /^\/(cgv|dpa)\/\d{4}-\d{2}-\d{2}$/.test(pathname);
/**
 * Hôte de mini-site sans mini-site servi (désactivé par sa centrale, centrale suspendue, mini-sites coupés par la
 * plateforme, Supabase injoignable) : chemin qu'aucune route ne sert (dossier « _ » privé de l'App Router) → page 404
 * neutre (app/not-found.tsx), jamais le site de la plateforme ni /login sous le domaine d'une centrale.
 */
const UNSERVED_HOST_PATH = "/_mini-site-indisponible";

export async function proxy(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").split(":")[0]!.toLowerCase();
  const { pathname } = request.nextUrl;

  // 1) Mini-sites de réservation sur sous-domaine / domaine personnalisé
  //    (/rejoindre/{code} : inscription chauffeur publique, jamais réécrite vers le mini-site)
  const isPlatformHost = host === APP_HOST || host === ROOT_DOMAIN || host === `www.${ROOT_DOMAIN}` || host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host);
  // Host invalide (trop long, caractères interdits, IPv6…) : aucune résolution, ni appel à Supabase ni cache
  const bookingHost = isPlatformHost ? null : bookingHostKey(request.headers.get("host"));
  if (
    bookingHost && !pathname.startsWith("/api/") && !pathname.startsWith("/book/") && !pathname.startsWith("/rejoindre/") &&
    !isLegalPath(pathname)
  ) {
    const slug = await resolveBookingSlug(bookingHost);
    const url = request.nextUrl.clone();
    url.pathname = slug ? `/book/${slug}${pathname === "/" ? "" : pathname}` : UNSERVED_HOST_PATH;
    // Aucun mini-site servi : 404 neutre, sans session ni cookie posé sur ce domaine
    if (!slug) url.search = "";
    return NextResponse.rewrite(url);
  }

  // 2) Session Supabase (rafraîchissement des cookies) + protection des espaces
  let response = NextResponse.next({ request });
  if (!SUPABASE_URL || !SUPABASE_KEY) return response;

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_KEY, {
    // Connexions gardées ouvertes et DNS mémorisé : le proxy passe à chaque page (lib/server-fetch.ts)
    global: { fetch: serverFetch },
    // Session jamais envoyée en clair sur http:// en production (attribut Secure)
    cookieOptions: { secure: process.env.NODE_ENV === "production" },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
      },
    },
  });

  const authed = await hasSession(supabase);

  if (!authed && PROTECTED.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }
  if (authed && pathname === "/login") {
    // hasSession() ne demande pas toujours à Auth si la session existe encore : une session révoquée ailleurs
    // (déconnexion globale, membre désactivé…) passerait pour valide jusqu'à l'expiration du jeton → boucle
    // /login ↔ /dashboard. Auth confirme ici la session ; si elle n'existe plus, auth-js efface les cookies (setAll) et
    // la page de connexion s'affiche.
    const { data: current } = await supabase.auth.getUser();
    if (current?.user) {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|api/v1|api/stripe|vendor/|dev-map/|favicon.ico|icon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|woff2?|mjs|pbf)$).*)"],
};
