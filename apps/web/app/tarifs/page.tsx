import type { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { FinalCta } from "@/components/marketing/final-cta";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { PageHeader } from "@/components/marketing/page-header";
import { PlanCards, PlanCardsSkeleton, PlatformFeeNote, PricingFacts, type PublicPlan } from "@/components/marketing/pricing";
import { marketingMetadata } from "@/components/marketing/seo";
import { fr } from "@/components/marketing/typo";
import { bookingSitesEnabled } from "@/lib/booking-sites";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = marketingMetadata({
  path: "/tarifs",
  title: "Tarifs du logiciel de dispatch VTC",
  description: fr(
    "Abonnement mensuel ou annuel, prix hors taxes, renouvellement arrêté quand vous voulez depuis le tableau de bord. Selon l'offre : frais plateforme par course terminée, flotte comme centrale.",
  ),
});

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
      console.warn("Tarifs : offres indisponibles —", error.message);
      return [];
    }
    return (data ?? []) as PublicPlan[];
  } catch (e) {
    // Signaux internes de Next (rendu dynamique requis par cookies(), redirection…) : jamais interceptés
    unstable_rethrow(e);
    console.warn("Tarifs : offres indisponibles —", e instanceof Error ? e.message : e);
    return [];
  }
}

/**
 * Offres lues en base : rendues dans leur propre frontière Suspense, le reste de la page part sans les attendre.
 * Mini-sites coupés par la plateforme (super admin) : signalé sous les offres, qui peuvent l'inclure.
 */
async function Plans() {
  const plans = await loadPlans();
  const sitesOff = plans.length > 0 && !(await bookingSitesEnabled());
  return (
    <>
      <PlanCards plans={plans} />
      {sitesOff && (
        <p className="mx-auto mt-6 max-w-2xl text-center text-[13px] leading-relaxed text-amber">
          {fr("Le mini-site de réservation est momentanément indisponible, quelle que soit l'offre. Les autres services ne sont pas concernés.")}
        </p>
      )}
    </>
  );
}

export default function PricingPage() {
  return (
    <MarketingShell>
      <PageHeader
        id="tarifs-titre"
        eyebrow="Tarifs"
        title="Une offre pour chaque centrale."
        intro={fr("Abonnement mensuel ou annuel, prix hors taxes. Vous arrêtez le renouvellement quand vous voulez, depuis le tableau de bord.")}
      />
      <section aria-label="Offres" className="relative z-10">
        <div className="mx-auto max-w-6xl px-4 pb-16 sm:px-6 sm:pb-24">
          <Suspense fallback={<PlanCardsSkeleton />}>
            <Plans />
          </Suspense>
          <PlatformFeeNote className="mt-8" />
        </div>
      </section>
      <PricingFacts />
      <FinalCta spaced />
    </MarketingShell>
  );
}
