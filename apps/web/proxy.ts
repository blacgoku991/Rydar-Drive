import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "";
const APP_HOST = new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").hostname;
const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN || "rydar.app";

const hostCache = new Map<string, { slug: string | null; expires: number }>();

/** Sous-domaine (elite.rydar.app) ou domaine personnalisé → slug du mini-site. */
async function resolveBookingSlug(host: string): Promise<string | null> {
  const cached = hostCache.get(host);
  if (cached && cached.expires > Date.now()) return cached.slug;
  let slug: string | null = null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/resolve_booking_host`, {
      method: "POST",
      // apikey seul : rôle anon pour une ancienne clé JWT comme pour une clé publishable (sb_publishable_…, pas un JWT)
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ p_host: host, p_root_domain: ROOT_DOMAIN }),
      cache: "no-store",
    });
    if (res.ok) slug = (await res.json()) as string | null;
  } catch {
    slug = null;
  }
  hostCache.set(host, { slug, expires: Date.now() + 5 * 60_000 });
  return slug;
}

const PROTECTED = ["/dashboard", "/admin"];

export async function proxy(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").split(":")[0]!.toLowerCase();
  const { pathname } = request.nextUrl;

  // 1) Mini-sites de réservation sur sous-domaine / domaine personnalisé
  //    (/rejoindre/{code} : inscription chauffeur publique, jamais réécrite vers le mini-site)
  const isPlatformHost = host === APP_HOST || host === ROOT_DOMAIN || host === `www.${ROOT_DOMAIN}` || host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host);
  if (!isPlatformHost && host && !pathname.startsWith("/api/") && !pathname.startsWith("/book/") && !pathname.startsWith("/rejoindre/")) {
    const slug = await resolveBookingSlug(host);
    if (slug) {
      const url = request.nextUrl.clone();
      url.pathname = `/book/${slug}${pathname === "/" ? "" : pathname}`;
      return NextResponse.rewrite(url);
    }
  }

  // 2) Session Supabase (rafraîchissement des cookies) + protection des espaces
  let response = NextResponse.next({ request });
  if (!SUPABASE_URL || !SUPABASE_KEY) return response;

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_KEY, {
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

  const { data } = await supabase.auth.getClaims();
  const authed = !!data?.claims?.sub;

  if (!authed && PROTECTED.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }
  if (authed && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|api/v1|api/stripe|vendor/|dev-map/|favicon.ico|icon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|woff2?|mjs|pbf)$).*)"],
};
