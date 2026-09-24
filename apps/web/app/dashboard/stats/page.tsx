import { Check } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { StatsView } from "@/components/charts/stats-view";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { requireOrg } from "@/lib/auth";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Statistiques" };
export const dynamic = "force-dynamic";

const PRESETS = [
  { key: "7d", label: "7 derniers jours", days: 7 },
  { key: "30d", label: "30 derniers jours", days: 30 },
  { key: "90d", label: "90 derniers jours", days: 90 },
  { key: "mtd", label: "Mois en cours", days: 0 },
] as const;

export default async function StatsPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const ctx = await requireOrg();
  const { range } = await searchParams;
  const preset = PRESETS.find((p) => p.key === range) ?? PRESETS[1];
  const to = new Date();
  const from =
    preset.key === "mtd"
      ? new Date(to.getFullYear(), to.getMonth(), 1)
      : new Date(new Date(to.toDateString()).getTime() - (preset.days - 1) * 86_400_000);
  const { data: stats, error } = await ctx.supabase.rpc("org_stats", {
    p_org: ctx.org.id,
    p_from: from.toISOString(),
    p_to: new Date(to.getTime() + 60_000).toISOString(),
  });

  return (
    <>
      <PageHeader eyebrow="Pilotage" title="Statistiques" description="CA, volume, rapidité d'attribution, acceptation et activité de la flotte." />
      <PageBody className="space-y-6">
        {/* Filtre de période : une seule ligne, au-dessus de tous les graphiques */}
        <div className="flex flex-wrap gap-1 rounded-xl border border-line bg-ink-850 p-1 sm:w-fit">
          {PRESETS.map((p) => (
            <Link
              key={p.key}
              href={`/dashboard/stats?range=${p.key}`}
              className={cn("flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium", p.key === preset.key ? "bg-ink-600 text-fg" : "text-fg-muted hover:bg-white/[0.03] hover:text-fg")}
            >
              {p.key === preset.key && <Check className="size-3.5 text-brand" strokeWidth={3} />}
              {p.label}
            </Link>
          ))}
        </div>
        {error || !stats ? <p className="text-sm text-red">Statistiques indisponibles.</p> : <StatsView stats={stats} />}
      </PageBody>
    </>
  );
}
