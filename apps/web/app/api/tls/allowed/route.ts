// Caddy (certificats HTTPS « à la demande ») : un certificat n'est émis que pour un domaine connu —
// la plateforme, ou le sous-domaine / domaine personnalisé d'un mini-site actif. Évite qu'un domaine
// quelconque pointé vers le serveur ne déclenche des émissions de certificats.
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const DOMAIN_RE = /^(?=.{3,253}$)(?!-)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/;

export async function GET(req: Request) {
  const domain = (new URL(req.url).searchParams.get("domain") ?? "").trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) return new NextResponse(null, { status: 400 });

  const appHost = new URL(env.appUrl).hostname;
  if (domain === appHost || domain === env.rootDomain || domain === `www.${env.rootDomain}`) {
    return new NextResponse(null, { status: 200 });
  }
  const { data, error } = await createAdminClient().rpc("resolve_booking_host", { p_host: domain, p_root_domain: env.rootDomain });
  if (error) return new NextResponse(null, { status: 503 });
  return new NextResponse(null, { status: data ? 200 : 404 });
}
