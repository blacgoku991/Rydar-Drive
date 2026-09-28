import type { MetadataRoute } from "next";
import { env } from "@/lib/env";

/** Robots : site vitrine et pages légales indexables ; espaces connectés, API et authentification exclus. */
export default function robots(): MetadataRoute.Robots {
  const base = env.appUrl.replace(/\/+$/, "");
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/dashboard", "/admin", "/api", "/auth"] },
    sitemap: `${base}/sitemap.xml`,
  };
}
