import type { Metadata } from "next";

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
