import type { Metadata } from "next";
import { StatsView } from "@/components/charts/stats-view";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Callout } from "@/components/ui/callout";
import { FilterTabs } from "@/components/ui/filter-tabs";
import { isAdminRole, requireOrg } from "@/lib/auth";
import { isPrivateFleet } from "@/lib/private-fleet";
import { statsPeriodStart } from "@/lib/stats-period";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const ctx = await requireOrg();
  return { title: isPrivateFleet(ctx.org) ? "Activité" : "Statistiques" };
}

const PRESETS = [
  { key: "7d", label: "7 derniers jours", days: 7 },
  { key: "30d", label: "30 derniers jours", days: 30 },
  { key: "90d", label: "90 derniers jours", days: 90 },
  { key: "mtd", label: "Mois en cours", days: 0 },
] as const;

export default async function StatsPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const ctx = await requireOrg();
  const privateFleet = isPrivateFleet(ctx.org);
  const { range } = await searchParams;
  const preset = PRESETS.find((p) => p.key === range) ?? PRESETS[1];
  const to = new Date();
  // Bornes à minuit dans le fuseau de la centrale (le serveur tourne en UTC)
  const from = statsPeriodStart(to, preset.key === "mtd" ? "mtd" : preset.days, ctx.org.timezone || "Europe/Paris");
  const { data: stats, error } = await ctx.supabase.rpc("org_stats", {
    p_org: ctx.org.id,
    p_from: from.toISOString(),
    p_to: new Date(to.getTime() + 60_000).toISOString(),
  });

  return (
    <>
      <PageHeader
        title={privateFleet ? "Activité" : "Statistiques"}
        description={
          privateFleet
            ? "Chiffre d'affaires, réservations et rapidité de confirmation sur la période."
            : "Chiffre d'affaires, nombre de courses et rapidité d'attribution sur la période."
        }
      />
      <PageBody className="space-y-6">
        {/* Filtre de période : une seule ligne, au-dessus de tous les graphiques (mêmes clés ?range=) */}
        <FilterTabs
          label="Période"
          items={PRESETS.map((p) => ({ href: `/dashboard/stats?range=${p.key}`, label: p.label, active: p.key === preset.key }))}
        />
        {error || !stats ? (
          <Callout tone="danger" title="Statistiques illisibles pour le moment.">
            Lecture impossible, réessayez dans un instant.
          </Callout>
        ) : (
          <StatsView
            stats={stats}
            privateFleet={privateFleet}
            // Abonnement : réservé au propriétaire et aux administrateurs (le dispatcher n'y a rien à faire)
            offersHref={isAdminRole(ctx.role) ? "/dashboard/settings?tab=billing" : null}
            longerHref={preset.key === "90d" ? null : "/dashboard/stats?range=90d"}
          />
        )}
      </PageBody>
    </>
  );
}
