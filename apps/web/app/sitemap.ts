import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { LEGAL_LINKS } from "@/components/legal/legal-links";
import { isPlatformHost } from "@/components/marketing/seo";
import { env } from "@/lib/env";

/** Pages du site vitrine, dans l'ordre de la navigation. */
const MARKETING_PATHS = ["/", "/services", "/avantages", "/tarifs", "/faq", "/contact"];

/**
 * Plan du site : pages vitrine et documents légaux (URL absolues sur l'URL de l'application). Sur le mini-site d'une
 * centrale (marque blanche, le proxy ne réécrit pas les .xml) : plan vide, aucune page de la plateforme.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!isPlatformHost((await headers()).get("host"))) return [];
  const base = env.appUrl.replace(/\/+$/, "");
  return [
    ...MARKETING_PATHS.map((path) => ({ url: `${base}${path}`, changeFrequency: "monthly" as const, priority: path === "/" ? 1 : 0.8 })),
    ...LEGAL_LINKS.map(({ href }) => ({ url: `${base}${href}`, changeFrequency: "yearly" as const, priority: 0.3 })),
  ];
}
