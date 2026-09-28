import type { Metadata } from "next";
import { AudiencesPreview } from "@/components/marketing/audiences";
import { FinalCta } from "@/components/marketing/final-cta";
import { Hero } from "@/components/marketing/hero";
import { LegacyAnchorRedirect } from "@/components/marketing/legacy-anchors";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { marketingMetadata } from "@/components/marketing/seo";
import { ServicesOverview } from "@/components/marketing/services-overview";
import { fr } from "@/components/marketing/typo";
import { env } from "@/lib/env";

const TITLE = "Rydar Drive — Logiciel de dispatch VTC pour centrales et flottes";
const DESCRIPTION = fr(
  "Logiciel de dispatch VTC pour centrales et flottes : vos courses proposées à vos chauffeurs les plus proches, par vagues de 4 à 16 km. Vos clients restent les vôtres.",
);

// metadataBase : défini par le layout racine (URL de l'application)
export const metadata: Metadata = marketingMetadata({ path: "/", absoluteTitle: TITLE, description: DESCRIPTION });

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Rydar Drive",
  applicationCategory: "BusinessApplication",
  applicationSubCategory: "Logiciel de dispatch VTC",
  operatingSystem: "Web, iOS, Android",
  inLanguage: "fr-FR",
  url: env.appUrl,
  description: DESCRIPTION,
  audience: { "@type": "BusinessAudience", audienceType: "Centrales de réservation et flottes de VTC" },
};

export default function Landing() {
  return (
    <MarketingShell backdrop="hero">
      <LegacyAnchorRedirect />
      <Hero />
      <ServicesOverview />
      <AudiencesPreview />
      <FinalCta spaced />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD).replace(/</g, "\\u003c") }} />
    </MarketingShell>
  );
}
