import { formatNumber, formatPrice } from "@rydar/shared";
import { Wallet } from "lucide-react";
import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { DriverEarningsView, EarningPeriod } from "./earnings";

function Period({ title, p, commission }: { title: string; p: EarningPeriod; commission: number | null }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-white/[0.02] px-4 py-3.5">
      <p className="text-[12.5px] text-fg-subtle">{title}</p>
      <p className="num mt-1 text-[24px] font-semibold leading-none tracking-tight">{formatPrice(p.revenue_cents)}</p>
      <p className="mt-1.5 text-[12px] text-fg-subtle">
        <span className="num text-fg-muted">{formatNumber(p.rides)}</span> course{p.rides > 1 ? "s" : ""}
        {p.cash_cents > 0 && (
          <>
            {" "}· dont <span className="num">{formatPrice(p.cash_cents)}</span> en espèces
          </>
        )}
      </p>
      {commission != null && p.net_cents != null && (
        <p className="mt-2.5 flex items-baseline justify-between gap-2 border-t border-line pt-2.5 text-[12.5px]">
          <span className="text-fg-subtle">Net chauffeur estimé</span>
          <span className="num font-semibold text-brand">{formatPrice(p.net_cents)}</span>
        </p>
      )}
    </div>
  );
}

/** Encart « Chiffre d'affaires » : semaine / mois + 14 derniers jours (courses terminées). */
export function DriverEarningsCard({ data, firstName }: { data: DriverEarningsView; firstName: string }) {
  const max = Math.max(1, ...data.series.map((d) => d.revenue_cents));
  const fmtDay = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" });
  const total14 = data.series.reduce((n, d) => n + d.revenue_cents, 0);
  return (
    <Card>
      <CardHeader
        title="Chiffre d'affaires"
        icon={<Wallet />}
        description="Courses terminées, prix client TTC."
        action={
          data.commission != null ? (
            <span className="inline-flex h-[22px] items-center rounded-full bg-white/[0.05] px-2 text-[11.5px] font-medium text-fg-muted">
              Commission <span className="num ml-1 text-fg">{formatNumber(data.commission, data.commission % 1 ? 1 : 0)} %</span>
            </span>
          ) : undefined
        }
      />
      <div className="space-y-4 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Period title="Cette semaine" p={data.week} commission={data.commission} />
          <Period title="Ce mois-ci" p={data.month} commission={data.commission} />
        </div>

        <div>
          <div className="mb-2 flex items-baseline justify-between text-[12px] text-fg-subtle">
            <span>14 derniers jours</span>
            <span className="num">{formatPrice(total14)}</span>
          </div>
          <div className="flex h-[92px] items-end gap-[2px]" role="list" aria-label={`Chiffre d'affaires de ${firstName} sur 14 jours`}>
            {data.series.map((d) => {
              const h = d.revenue_cents ? Math.max(6, Math.round((d.revenue_cents / max) * 72)) : 2;
              const label = `${fmtDay.format(new Date(`${d.date}T12:00:00Z`))} · ${d.rides} course${d.rides > 1 ? "s" : ""} · ${formatPrice(d.revenue_cents)}`;
              return (
                <div
                  key={d.date}
                  role="listitem"
                  tabIndex={0}
                  aria-label={label}
                  className="group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5 outline-none"
                >
                  <span className="pointer-events-none absolute -top-1 left-1/2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-line-strong bg-ink-600 px-2 py-1 text-[11px] text-fg opacity-0 shadow-float transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                    {label}
                  </span>
                  <span
                    className={cn(
                      "w-full max-w-[22px] rounded-t-[4px] transition-opacity",
                      d.revenue_cents ? "earn-bar" : "bg-white/[0.08]",
                      d.revenue_cents && !d.today && "opacity-60 group-hover:opacity-100",
                    )}
                    style={{ height: h }}
                  />
                  <span className={cn("text-[10px] leading-none", d.today ? "font-semibold text-fg" : "text-fg-subtle")}>{d.label}</span>
                </div>
              );
            })}
          </div>
        </div>

        {data.commission == null && (
          <p className="text-[12px] text-fg-subtle">
            Réglez la commission de la centrale dans{" "}
            <Link href="/dashboard/settings" className="text-fg-muted underline underline-offset-2 hover:text-fg">
              Réglages
            </Link>{" "}
            pour estimer le net du chauffeur.
          </p>
        )}
        {(data.week.unpriced > 0 || data.month.unpriced > 0) && (
          <p className="text-[12px] text-amber">
            {data.month.unpriced} course{data.month.unpriced > 1 ? "s" : ""} sans prix ce mois-ci (non comptée{data.month.unpriced > 1 ? "s" : ""}).
          </p>
        )}
      </div>
    </Card>
  );
}
