import type { PricingRule } from "@rydar/shared";
import type { Metadata } from "next";
import { CommandCenter } from "@/components/command/command-center";
import { loadPrivateHome } from "@/components/private-fleet/home-data";
import { PrivateHome } from "@/components/private-fleet/private-home";
import { requireOrg } from "@/lib/auth";
import { isPrivateFleet } from "@/lib/private-fleet";
import { getLiveSnapshot } from "@/lib/queries/live";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const ctx = await requireOrg();
  return { title: isPrivateFleet(ctx.org) ? "Accueil" : "En direct" };
}

export default async function DashboardPage() {
  const ctx = await requireOrg();
  // Flotte Privée (docs/FLOTTE-PRIVEE.md § 7.3) : Accueil du chauffeur-propriétaire à la place du centre de commande
  if (isPrivateFleet(ctx.org)) {
    const data = await loadPrivateHome(ctx);
    return <PrivateHome data={data} now={Date.now()} />;
  }
  const [snapshot, pricing, settings] = await Promise.all([
    getLiveSnapshot(ctx.supabase, ctx.org.id),
    ctx.supabase
      .from("pricing_rules")
      .select("vehicle_category, base_fare_cents, per_km_cents, per_minute_cents, minimum_fare_cents, night_surcharge_percent, night_start, night_end, fixed_fares")
      .eq("organization_id", ctx.org.id)
      .eq("is_active", true),
    ctx.supabase.from("organization_settings").select("offer_timeout_seconds, default_payment_method, location_max_age_seconds, dispatch_radii_m").eq("organization_id", ctx.org.id).maybeSingle(),
  ]);
  return (
    <>
      {/* Titre de la page pour les lecteurs d'écran (la carte plein écran n'a pas de titre visible) */}
      <h1 className="sr-only">En direct — {ctx.org.name}</h1>
      <CommandCenter
        initial={snapshot}
        orgName={ctx.org.name}
        pricing={(pricing.data ?? []) as PricingRule[]}
        offerTimeout={settings.data?.offer_timeout_seconds ?? 30}
        locationMaxAgeS={settings.data?.location_max_age_seconds ?? 180}
        firstPassWaves={(settings.data?.dispatch_radii_m as number[] | null)?.length || 4}
        defaultPayment={settings.data?.default_payment_method ?? "card"}
      />
    </>
  );
}
