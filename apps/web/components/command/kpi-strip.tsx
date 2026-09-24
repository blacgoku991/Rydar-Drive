"use client";
import { formatCompactPrice, formatDuration, formatNumber, type OrgKpis } from "@rydar/shared";
import { cn } from "@/lib/utils";

function Kpi({ label, value, sub, tone, emphasis }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "brand" | "amber" | "red" | "cyan"; emphasis?: boolean }) {
  const color = tone === "brand" ? "text-brand" : tone === "amber" ? "text-amber" : tone === "red" ? "text-red" : tone === "cyan" ? "text-cyan" : "text-fg";
  return (
    <div className={cn("flex min-w-[112px] flex-col justify-center px-4 py-2.5", emphasis && "min-w-[132px]")}>
      <span className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-fg-subtle">{label}</span>
      <span className={cn("mt-1 text-[21px] font-semibold leading-none tracking-tight", color)}>{value}</span>
      {sub && <span className="mt-1 text-[11px] text-fg-subtle">{sub}</span>}
    </div>
  );
}

export function KpiStrip({ kpis }: { kpis: OrgKpis | null }) {
  const k = kpis;
  return (
    <div className="glass flex items-stretch overflow-x-auto rounded-2xl [&>*+*]:border-l [&>*+*]:border-white/[0.06]">
      <Kpi label="Courses aujourd'hui" value={formatNumber(k?.rides_today)} sub={`${formatNumber(k?.completed_today)} terminées`} emphasis />
      <Kpi label="CA aujourd'hui" value={formatCompactPrice(k?.revenue_today_cents)} sub={`prévu ${formatCompactPrice(k?.expected_revenue_today_cents)}`} tone="brand" emphasis />
      <Kpi label="Cette semaine" value={formatNumber(k?.rides_week)} sub={formatCompactPrice(k?.revenue_week_cents)} />
      <Kpi label="En ligne" value={<>{formatNumber(k?.drivers_online)}<span className="text-fg-subtle">/{formatNumber(k?.drivers_total)}</span></>} sub={`${formatNumber(k?.drivers_available)} disponibles`} />
      <Kpi label="En recherche" value={formatNumber((k?.searching ?? 0) + (k?.offered ?? 0))} tone={(k?.searching ?? 0) + (k?.offered ?? 0) > 0 ? "amber" : undefined} sub={`${formatNumber(k?.offered)} proposées`} />
      <Kpi label="En cours" value={formatNumber(k?.in_progress)} tone="cyan" sub={`${formatNumber(k?.assigned)} attribuées`} />
      <Kpi label="Planifiées" value={formatNumber(k?.scheduled_upcoming)} sub={k?.scheduled_unassigned ? `${k.scheduled_unassigned} sans chauffeur` : "toutes couvertes"} />
      <Kpi label="Sans chauffeur" value={formatNumber(k?.no_driver_today)} tone={(k?.no_driver_today ?? 0) > 0 ? "red" : undefined} sub="aujourd'hui" />
      <Kpi label="Attribution" value={k?.avg_assign_seconds_today != null ? formatDuration(k.avg_assign_seconds_today) : "—"} sub="temps moyen" />
    </div>
  );
}
