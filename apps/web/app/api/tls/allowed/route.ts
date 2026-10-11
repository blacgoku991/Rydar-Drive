// Caddy (certificats HTTPS « à la demande ») : un certificat n'est émis que pour un domaine connu —
// la plateforme, ou le sous-domaine / domaine personnalisé d'un mini-site actif. Évite qu'un domaine
// quelconque pointé vers le serveur ne déclenche des émissions de certificats. Mini-sites coupés par la plateforme
// (super admin) : plus aucun nouveau certificat pour leurs hôtes (resolve_booking_host le refuse aussi).
//
// Caddy appelle cette route à CHAQUE poignée de main TLS dont le SNI n'a pas de certificat, sans garder les refus :
// n'importe qui peut ouvrir des connexions avec des SNI aléatoires. Coût borné par processus (audit p5 web-2) :
// décisions gardées (accord 5 min, refus 60 s, cache LRU borné), interrupteur des mini-sites relu au plus toutes les
// 30 s, et budget global des résolutions en base (au-delà : refus sans requête ; Caddy redemandera à la poignée
// suivante).
import { NextResponse } from "next/server";
import { bookingSitesEnabled } from "@/lib/booking-sites";
import { env } from "@/lib/env";
import { lruCache } from "@/lib/geo/cache";
import { isValidHostname } from "@/lib/hostname";
import { rateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const ALLOWED_TTL_MS = 5 * 60_000;
const DENIED_TTL_MS = 60_000;
const SWITCH_TTL_MS = 30_000;
/** Résolutions en base (hors cache) par minute, tous hôtes confondus. */
const LOOKUP_BUDGET = 300;

const decisions = lruCache<{ status: 200 | 404; expires: number }>(2_000, ALLOWED_TTL_MS);
let sitesSwitch = { enabled: false, expires: 0 };

async function sitesEnabled(): Promise<boolean> {
  if (sitesSwitch.expires > Date.now()) return sitesSwitch.enabled;
  // Erreur de lecture = coupé (bookingSitesEnabled) : refus gardé 30 s au plus
  const enabled = await bookingSitesEnabled();
  sitesSwitch = { enabled, expires: Date.now() + SWITCH_TTL_MS };
  return enabled;
}

export async function GET(req: Request) {
  const domain = (new URL(req.url).searchParams.get("domain") ?? "").trim().toLowerCase();
  // Même validation que proxy.ts ; un domaine personnalisé sous le domaine racine n'est jamais accepté (resolve_booking_host)
  if (!isValidHostname(domain)) return new NextResponse(null, { status: 400 });

  const appHost = new URL(env.appUrl).hostname;
  // Plateforme, et page du test d'éligibilité Flotte Privée (proxy.ts)
  if (domain === appHost || domain === env.rootDomain || domain === `www.${env.rootDomain}` || domain === `eligibilite.${env.rootDomain}`) {
    return new NextResponse(null, { status: 200 });
  }
  // Interrupteur d'abord : mini-sites coupés, aucun accord gardé n'est utilisé
  if (!(await sitesEnabled())) return new NextResponse(null, { status: 404 });
  const cached = decisions.get(domain);
  if (cached && cached.expires > Date.now()) return new NextResponse(null, { status: cached.status });
  if (!(await rateLimit("tls-ask:lookup", LOOKUP_BUDGET, 60)).ok) return new NextResponse(null, { status: 404 });

  const { data, error } = await createAdminClient().rpc("resolve_booking_host", { p_host: domain, p_root_domain: env.rootDomain });
  // Panne de la base : jamais gardée
  if (error) return new NextResponse(null, { status: 503 });
  const status = data ? 200 : 404;
  decisions.set(domain, { status, expires: Date.now() + (data ? ALLOWED_TTL_MS : DENIED_TTL_MS) });
  return new NextResponse(null, { status });
}
