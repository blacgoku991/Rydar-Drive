import type { Metadata } from "next";
import { env } from "@/lib/env";

/**
 * En-tête Host de la plateforme (même règle que proxy.ts : hôte de l'URL de l'application, domaine racine, www,
 * localhost, adresse IPv4) ; tout autre hôte est le mini-site d'une centrale (sous-domaine ou domaine personnalisé,
 * en marque blanche). Les fichiers .txt et .xml ne passent pas par le proxy : robots.txt et sitemap.xml s'y fient
 * pour ne jamais présenter la plateforme sur le domaine d'une centrale.
 */
export function isPlatformHost(rawHost: string | null | undefined, platform: { appUrl: string; rootDomain: string } = env): boolean {
  const host = (rawHost ?? "").split(":")[0]!.toLowerCase().replace(/\.$/, "");
  // Sans en-tête Host, le proxy ne réécrit rien : ce sont les pages de la plateforme qui répondent
  if (!host) return true;
  let appHost = "";
  try {
    appHost = new URL(platform.appUrl).hostname;
  } catch {
    // URL de l'application invalide : restent le domaine racine, localhost et les adresses IP
  }
  const root = platform.rootDomain.toLowerCase();
  return host === appHost || host === root || host === `www.${root}` || host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host);
}

/** Image de partage des pages du site vitrine (le layout racine n'en déclare pas : les mini-sites en hériteraient). */
const OG_IMAGE = {
  url: "/og-rydar-drive.jpg",
  width: 1200,
  height: 630,
  alt: "Rydar Drive, logiciel de dispatch VTC : radar de dispatch sur un globe centré sur la France",
};

/**
 * Métadonnées d'une page du site vitrine : titre, description, adresse canonique, Open Graph et carte de partage.
 * `title` suit le modèle du layout (« … · Rydar Drive ») ; `absoluteTitle` le remplace tel quel (accueil).
 * URL relatives : résolues sur metadataBase (URL de l'application, layout racine).
 */
export function marketingMetadata({
  path,
  title,
  absoluteTitle,
  description,
}: {
  path: string;
  title?: string;
  absoluteTitle?: string;
  description: string;
}): Metadata {
  const shareTitle = absoluteTitle ?? `${title} · Rydar Drive`;
  return {
    title: absoluteTitle ? { absolute: absoluteTitle } : title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      locale: "fr_FR",
      url: path,
      siteName: "Rydar Drive",
      title: shareTitle,
      description,
      images: [OG_IMAGE],
    },
    twitter: { card: "summary_large_image", title: shareTitle, description, images: [OG_IMAGE.url] },
  };
}
