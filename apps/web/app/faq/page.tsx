import type { Metadata } from "next";
import { FaqContactLine, FaqGroups } from "@/components/marketing/faq";
import { FinalCta } from "@/components/marketing/final-cta";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { PageHeader } from "@/components/marketing/page-header";
import { marketingMetadata } from "@/components/marketing/seo";
import { fr } from "@/components/marketing/typo";

export const metadata: Metadata = marketingMetadata({
  path: "/faq",
  title: "Questions fréquentes sur le dispatch VTC",
  description: fr(
    "Rydar est-il un transporteur ? Qui encaisse le prix des courses ? Que se passe-t-il si aucun chauffeur n'accepte ? Où sont hébergées les données ? Les réponses.",
  ),
});

export default function FaqPage() {
  return (
    <MarketingShell>
      <PageHeader id="faq-titre" eyebrow="Questions fréquentes" title="Vos questions, nos réponses." intro={<FaqContactLine />} />
      <FaqGroups />
      <FinalCta />
    </MarketingShell>
  );
}
