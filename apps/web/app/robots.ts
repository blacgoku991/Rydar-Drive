import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { isPlatformHost } from "@/components/marketing/seo";
import { env } from "@/lib/env";

/**
 * Robots : site vitrine et pages légales indexables ; espaces connectés, API et authentification exclus.
 * Sur le mini-site d'une centrale (sous-domaine ou domaine personnalisé, en marque blanche), où robots.txt répond
 * aussi (le proxy ne réécrit pas les .txt) : version neutre, sans plan du site ni chemins de la plateforme.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  if (!isPlatformHost((await headers()).get("host"))) {
    return { rules: { userAgent: "*", allow: "/", disallow: "/api/" } };
  }
  const base = env.appUrl.replace(/\/+$/, "");
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/dashboard", "/admin", "/api", "/auth"] },
    sitemap: `${base}/sitemap.xml`,
  };
}
