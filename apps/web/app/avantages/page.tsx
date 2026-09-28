import type { Metadata } from "next";
import { Audiences, OperatingModes } from "@/components/marketing/audiences";
import { FinalCta } from "@/components/marketing/final-cta";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { Ownership } from "@/components/marketing/ownership";
import { PageHeader } from "@/components/marketing/page-header";
import { marketingMetadata } from "@/components/marketing/seo";
import { fr } from "@/components/marketing/typo";

export const metadata: Metadata = marketingMetadata({
  path: "/avantages",
  title: "Avantages pour les centrales, flottes et chauffeurs VTC",
  description: fr(
    "Moins de téléphone et plus de courses servies pour la centrale, des courses proches et un guidage intégré pour les chauffeurs. Vos courses, vos clients et vos prix restent les vôtres.",
  ),
});

export default function AdvantagesPage() {
  return (
    <MarketingShell>
      <PageHeader
        id="avantages-titre"
        eyebrow="Avantages"
        title={fr("Pensé pour ceux qui font rouler les courses.")}
        intro={fr("La centrale garde la main sur son activité ; les chauffeurs gagnent du temps à chaque course.")}
      />
      <Audiences />
      <OperatingModes />
      <Ownership />
      <FinalCta />
    </MarketingShell>
  );
}
