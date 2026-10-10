"use client";
import { formatCompactPrice, formatDuration, formatNumber, type OrgKpis } from "@rydar/shared";
import { cn } from "@/lib/utils";
import { plural } from "@/lib/wording";

// Chiffre en couleur neutre ; couleur réservée à ce qui demande une action (courses en recherche, sans chauffeur).
// Sous 1600 px, la bande reste compacte (sans détails ni délai d'attribution) pour ne pas passer sous le panneau des courses.
function Stat({ label, value, sub, tone, className }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "amber" | "red"; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col justify-center px-4 py-2", className)}>
      <span className="truncate text-[12px] text-fg-subtle">{label}</span>
      <span className={cn("whitespace-nowrap text-[17px] font-semibold leading-tight tracking-tight", tone === "amber" ? "text-amber" : tone === "red" ? "text-red" : "text-fg")}>
        {value}
        {sub != null && <span className="ml-1.5 hidden text-[12px] font-normal text-fg-subtle min-[1600px]:inline">{sub}</span>}
      </span>
    </div>
  );
}

/** Indicateurs clés du jour — une seule ligne, lisible d'un coup d'œil (à partir de 1400 px). */
export function KpiStrip({ kpis: k, className }: { kpis: OrgKpis | null; className?: string }) {
  const searching = (k?.searching ?? 0) + (k?.offered ?? 0);
  return (
    <div className={cn("glass flex items-stretch overflow-x-auto rounded-2xl [&>*+*]:border-l [&>*+*]:border-white/[0.05]", className)}>
      <Stat label="Courses aujourd'hui" value={formatNumber(k?.rides_today)} sub={`${formatNumber(k?.completed_today)} terminées`} />
      <Stat label="Chiffre d'affaires" value={formatCompactPrice(k?.revenue_today_cents)} sub={`/ ${formatCompactPrice(k?.expected_revenue_today_cents)} prévus`} />
      <Stat label="Chauffeurs en ligne" value={<>{formatNumber(k?.drivers_online)}<span className="text-fg-subtle">/{formatNumber(k?.drivers_total)}</span></>} sub={`${formatNumber(k?.drivers_available)} libres`} />
      <Stat label="En recherche" value={formatNumber(searching)} tone={searching > 0 ? "amber" : undefined} sub={k?.no_driver_today ? `${k.no_driver_today} sans chauffeur` : undefined} />
      <Stat label="Attribution moyenne" value={k?.avg_assign_seconds_today != null ? formatDuration(k.avg_assign_seconds_today) : "—"} className="hidden min-[1600px]:flex" />
    </div>
  );
}

/**
 * Mêmes chiffres en une ligne, dans l'en-tête du panneau des courses (sous 1400 px, où la bande ne tient pas) :
 * « 17 courses · 964 € · 10 / 14 en ligne · 2 en recherche ». Rien tant que les indicateurs ne sont pas lus.
 */
export function KpiLine({ kpis: k, className }: { kpis: OrgKpis | null; className?: string }) {
  if (!k) return null;
  const searching = (k.searching ?? 0) + (k.offered ?? 0);
  const noDriver = k.no_driver_today ?? 0;
  const dot = <span aria-hidden className="text-fg-subtle">·</span>;
  return (
    <p className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-5 text-[12px] text-fg-muted", className)}>
      <span className="sr-only">Aujourd&apos;hui&nbsp;: </span>
      <span className="whitespace-nowrap">
        <span className="font-semibold text-fg tabular-nums">{formatNumber(k.rides_today ?? 0)}</span> {(k.rides_today ?? 0) >= 2 ? "courses" : "course"}
      </span>
      {dot}
      <span className="whitespace-nowrap" title="Chiffre d'affaires du jour">
        <span className="font-semibold text-fg tabular-nums">{formatCompactPrice(k.revenue_today_cents)}</span>
        <span className="sr-only"> de chiffre d&apos;affaires</span>
      </span>
      {dot}
      <span className="whitespace-nowrap">
        <span className="font-semibold text-fg tabular-nums">
          {formatNumber(k.drivers_online)}&nbsp;/&nbsp;{formatNumber(k.drivers_total)}
        </span>{" "}
        en ligne
      </span>
      {dot}
      <span className={cn("whitespace-nowrap", searching > 0 && "text-amber")}>
        <span className="font-semibold tabular-nums">{formatNumber(searching)}</span> en recherche
      </span>
      {noDriver > 0 && (
        <>
          {dot}
          <span className="whitespace-nowrap text-red">{plural(noDriver, "sans chauffeur", "sans chauffeur")}</span>
        </>
      )}
    </p>
  );
}
