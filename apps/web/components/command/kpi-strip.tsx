"use client";
import { formatCompactPrice, formatDuration, formatNumber, type OrgKpis } from "@rydar/shared";
import { cn } from "@/lib/utils";

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "brand" | "amber" | "red" }) {
  return (
    <div className="flex min-w-0 flex-col justify-center px-4 py-2">
      <span className="truncate text-[11.5px] text-fg-subtle">{label}</span>
      <span className={cn("text-[17px] font-semibold leading-tight tracking-tight", tone === "brand" ? "text-brand" : tone === "amber" ? "text-amber" : tone === "red" ? "text-red" : "text-fg")}>
        {value}
        {sub != null && <span className="ml-1.5 text-[12px] font-normal text-fg-subtle">{sub}</span>}
      </span>
    </div>
  );
}

/** Indicateurs clés du jour — une seule ligne, lisible d'un coup d'œil. */
export function KpiStrip({ kpis: k, className }: { kpis: OrgKpis | null; className?: string }) {
  const searching = (k?.searching ?? 0) + (k?.offered ?? 0);
  return (
    <div className={cn("glass flex items-stretch overflow-x-auto rounded-2xl [&>*+*]:border-l [&>*+*]:border-white/[0.05]", className)}>
      <Stat label="Courses aujourd'hui" value={formatNumber(k?.rides_today)} sub={`${formatNumber(k?.completed_today)} terminées`} />
      <Stat label="Chiffre d'affaires" value={formatCompactPrice(k?.revenue_today_cents)} sub={`/ ${formatCompactPrice(k?.expected_revenue_today_cents)} prévus`} tone="brand" />
      <Stat label="Chauffeurs en ligne" value={<>{formatNumber(k?.drivers_online)}<span className="text-fg-subtle">/{formatNumber(k?.drivers_total)}</span></>} sub={`${formatNumber(k?.drivers_available)} libres`} />
      <Stat label="En recherche" value={formatNumber(searching)} tone={searching > 0 ? "amber" : undefined} sub={k?.no_driver_today ? `${k.no_driver_today} sans chauffeur` : undefined} />
      <Stat label="Attribution moyenne" value={k?.avg_assign_seconds_today != null ? formatDuration(k.avg_assign_seconds_today) : "—"} />
    </div>
  );
}
