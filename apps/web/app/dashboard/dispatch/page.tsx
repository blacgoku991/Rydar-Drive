import { formatDuration } from "@rydar/shared";
import { AlertTriangle, CircleX, Radar, Timer } from "lucide-react";
import type { Metadata } from "next";
import { DispatchJournal, type JournalEvent } from "@/components/dispatch/dispatch-journal";
import { PageBody, PageHeader, StatCard } from "@/components/layout/page-header";
import { requireOrg } from "@/lib/auth";
import { privateFleetPage } from "@/lib/private-fleet";

export const metadata: Metadata = { title: "Journal du dispatch" };
export const dynamic = "force-dynamic";

export default async function DispatchPage() {
  const ctx = await requireOrg();
  // Flotte Privée : journal technique du dispatch masqué (chronologie de chaque réservation sur sa fiche) → Accueil
  privateFleetPage(ctx, { redirect: "/dashboard" });
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const [{ data: events }, { data: counters }, { data: kpis }] = await Promise.all([
    ctx.supabase
      .from("ride_events")
      .select("id, ride_id, category, level, type, message, actor_type, data, created_at")
      .eq("organization_id", ctx.org.id)
      .order("id", { ascending: false })
      .limit(400),
    ctx.supabase.from("ride_events").select("level").eq("organization_id", ctx.org.id).gte("created_at", since).in("level", ["warning", "error"]),
    ctx.supabase.rpc("org_kpis", { p_org: ctx.org.id }),
  ]);
  const rideIds = [...new Set((events ?? []).map((e) => e.ride_id).filter(Boolean))] as string[];
  const { data: rides } = rideIds.length
    ? await ctx.supabase.from("rides").select("id, number").in("id", rideIds.slice(0, 300))
    : { data: [] as { id: string; number: number }[] };
  const numbers = Object.fromEntries((rides ?? []).map((r) => [r.id, r.number]));
  const errors = (counters ?? []).filter((c) => c.level === "error").length;
  const warnings = (counters ?? []).filter((c) => c.level === "warning").length;
  const k = kpis as any;
  const searching = (k?.searching ?? 0) + (k?.offered ?? 0);

  return (
    <>
      <PageHeader
        title="Journal du dispatch"
        description="Ce qui s'est passé pour chaque course : chauffeurs prévenus, refus, attributions, alertes."
      />
      <PageBody className="space-y-6">
        {/* Couleur réservée à ce qui demande une action : rien en couleur à zéro */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Recherches en cours" value={searching} icon={<Radar />} tone={searching > 0 ? "amber" : undefined} />
          <StatCard
            label="Attribution moyenne"
            value={k?.avg_assign_seconds_today != null ? formatDuration(k.avg_assign_seconds_today) : "—"}
            sub="aujourd'hui"
            icon={<Timer />}
          />
          <StatCard label={"Avertissements (24\u00a0h)"} value={warnings} icon={<AlertTriangle />} tone={warnings > 0 ? "amber" : undefined} />
          <StatCard
            label={"Échecs (24\u00a0h)"}
            value={errors}
            sub="courses restées sans chauffeur"
            icon={<CircleX />}
            tone={errors > 0 ? "red" : undefined}
          />
        </div>
        <DispatchJournal initial={(events ?? []) as JournalEvent[]} timeZone={ctx.org.timezone} rideNumbers={numbers} />
      </PageBody>
    </>
  );
}
