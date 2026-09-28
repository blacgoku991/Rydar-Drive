import type { MetadataRoute } from "next";
import { LEGAL_LINKS } from "@/components/legal/legal-links";
import { env } from "@/lib/env";

/** Pages du site vitrine, dans l'ordre de la navigation. */
const MARKETING_PATHS = ["/", "/services", "/avantages", "/tarifs", "/faq", "/contact"];

/** Plan du site : pages vitrine et documents légaux (URL absolues sur l'URL de l'application). */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = env.appUrl.replace(/\/+$/, "");
  return [
    ...MARKETING_PATHS.map((path) => ({ url: `${base}${path}`, changeFrequency: "monthly" as const, priority: path === "/" ? 1 : 0.8 })),
    ...LEGAL_LINKS.map(({ href }) => ({ url: `${base}${href}`, changeFrequency: "yearly" as const, priority: 0.3 })),
  ];
}
