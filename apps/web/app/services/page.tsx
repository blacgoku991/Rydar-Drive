import type { Metadata } from "next";
import { FinalCta } from "@/components/marketing/final-cta";
import { HowItWorks } from "@/components/marketing/how-it-works";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { PageHeader } from "@/components/marketing/page-header";
import { marketingMetadata } from "@/components/marketing/seo";
import { ServicesNav, ServiceThemes, ThemeEyebrow } from "@/components/marketing/services";
import { fr } from "@/components/marketing/typo";
import { bookingSitesEnabled } from "@/lib/booking-sites";

export const metadata: Metadata = marketingMetadata({
  path: "/services",
  title: "Services du logiciel de dispatch VTC",
  description: fr(
    "Dispatch par vagues de 4 à 16 km, carte en temps réel, app chauffeur iOS et Android, réservations par API ou au tableau de bord, commissions suivies et relancées : tous les services de Rydar Drive.",
  ),
});

export default async function ServicesPage() {
  const bookingSites = await bookingSitesEnabled();
  return (
    <MarketingShell>
      <PageHeader
        id="services-titre"
        eyebrow="Services"
        title={fr("Tout pour faire tourner votre centrale, de la réservation au règlement.")}
        intro={fr(
          "Un seul outil pour recevoir vos courses, les dispatcher, suivre vos chauffeurs et le règlement de vos commissions. Vos clients, vos prix et vos chauffeurs restent les vôtres.",
        )}
      >
        <ServicesNav />
      </PageHeader>
      <ServiceThemes bookingSites={bookingSites} />
      <HowItWorks
        className="border-y border-line bg-ink-950/40"
        eyebrow={<ThemeEyebrow index={6} label="Fonctionnement" />}
        bookingSites={bookingSites}
      />
      <FinalCta spaced />
    </MarketingShell>
  );
}
