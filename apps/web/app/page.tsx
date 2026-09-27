import type { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { Audiences } from "@/components/marketing/audiences";
import { DEMO_HREF } from "@/components/marketing/contact";
import { Faq } from "@/components/marketing/faq";
import { FinalCta } from "@/components/marketing/final-cta";
import { Hero } from "@/components/marketing/hero";
import { HowItWorks } from "@/components/marketing/how-it-works";
import { Ownership } from "@/components/marketing/ownership";
import { PlanCards, PlanCardsSkeleton, Pricing, type PublicPlan } from "@/components/marketing/pricing";
import { Services } from "@/components/marketing/services";
import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";
import { fr } from "@/components/marketing/typo";
import { env } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

const TITLE = "Rydar Drive — Logiciel de dispatch VTC pour centrales et flottes";
const DESCRIPTION = fr(
  "Logiciel de dispatch VTC pour centrales et flottes : vos courses proposées à vos chauffeurs les plus proches, par vagues de 4 à 16 km. Vos clients restent les vôtres.",
);
const OG_IMAGE = {
  url: "/og-rydar-drive.jpg",
  width: 1200,
  height: 630,
  alt: "Rydar Drive, logiciel de dispatch VTC : radar de dispatch sur un globe centré sur la France",
};

// metadataBase : défini par le layout racine (URL de l'application)
export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "fr_FR",
    url: "/",
    siteName: "Rydar Drive",
    title: TITLE,
    description: DESCRIPTION,
    images: [OG_IMAGE],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: [OG_IMAGE.url] },
};

/** Offres publiques (/admin/plans). Base injoignable ou lente (4 s au plus) : « Tarif sur mesure ». */
async function loadPlans(): Promise<PublicPlan[]> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("plans")
      .select("id, code, name, description, price_monthly_cents, features, highlighted")
      .eq("is_active", true)
      .eq("is_public", true)
      .order("sort_order")
      .abortSignal(AbortSignal.timeout(4000));
    if (error) {
      console.warn("Accueil : offres indisponibles —", error.message);
      return [];
    }
    return (data ?? []) as PublicPlan[];
  } catch (e) {
    // Signaux internes de Next (rendu dynamique requis par cookies(), redirection…) : jamais interceptés
    unstable_rethrow(e);
    console.warn("Accueil : offres indisponibles —", e instanceof Error ? e.message : e);
    return [];
  }
}

/** Offres lues en base : rendues dans leur propre frontière Suspense, le reste de la page part sans les attendre. */
async function Plans() {
  return <PlanCards plans={await loadPlans()} />;
}

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
    <>
      <a
        href="#contenu"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-brand focus:px-4 focus:py-2 focus:text-[14px] focus:font-semibold focus:text-brand-fg"
      >
        Aller au contenu
      </a>
      <SiteHeader demoHref={DEMO_HREF} />
      <main id="contenu" className="relative overflow-x-clip">
        {/* Fond du héro : grille radar et lueur lime */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[1100px]">
          <div className="grid-bg absolute inset-0 [mask-image:radial-gradient(ellipse_at_70%_20%,black_15%,transparent_65%)]" />
          <div className="absolute right-[-12%] top-[-14%] size-[980px] rounded-full bg-brand/[0.06] blur-[170px]" />
        </div>
        <Hero demoHref={DEMO_HREF} />
        <Services />
        <Audiences />
        <HowItWorks />
        <Ownership />
        <Pricing>
          <Suspense fallback={<PlanCardsSkeleton />}>
            <Plans />
          </Suspense>
        </Pricing>
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD).replace(/</g, "\\u003c") }} />
    </>
  );
}
