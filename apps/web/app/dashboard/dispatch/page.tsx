import { AlertTriangle, CheckCircle2, Radar, Timer } from "lucide-react";
import type { Metadata } from "next";
import { DispatchJournal, type JournalEvent } from "@/components/dispatch/dispatch-journal";
import { PageBody, PageHeader, StatCard } from "@/components/layout/page-header";
import { requireOrg } from "@/lib/auth";

export const metadata: Metadata = { title: "Journal du dispatch" };
export const dynamic = "force-dynamic";

export default async function DispatchPage() {
  const ctx = await requireOrg();
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

  return (
    <>
      <PageHeader
        eyebrow="Opérations"
        title="Journal du dispatch"
        description="Trace technique complète : tenant, GPS de départ, rayons, chauffeurs compatibles, notifications, verrous d'attribution."
      />
      <PageBody className="space-y-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Recherches en cours" value={(k?.searching ?? 0) + (k?.offered ?? 0)} icon={<Radar />} tone="amber" />
          <StatCard label="Attribution moyenne" value={k?.avg_assign_seconds_today != null ? `${Math.round(k.avg_assign_seconds_today)} s` : "—"} sub="aujourd'hui" icon={<Timer />} />
          <StatCard label="Alertes 24 h" value={warnings} icon={<AlertTriangle />} tone={warnings ? "amber" : undefined} />
          <StatCard label="Erreurs 24 h" value={errors} sub={errors ? "courses sans chauffeur" : "aucune"} icon={<CheckCircle2 />} tone={errors ? "red" : "brand"} />
        </div>
        <DispatchJournal initial={(events ?? []) as JournalEvent[]} tenant={ctx.org.name} timeZone={ctx.org.timezone} rideNumbers={numbers} />
      </PageBody>
    </>
  );
}
