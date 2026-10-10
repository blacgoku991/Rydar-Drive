import { dateTimeFormat, formatNumber, formatPrice, type DispatchModel } from "@rydar/shared";
import { Wallet } from "lucide-react";
import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { DriverEarningsView, EarningPeriod } from "./earnings";

const NB = " ";

function Period({ title, p, commission }: { title: string; p: EarningPeriod; commission: number | null }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-white/[0.02] px-4 py-3.5">
      <p className="text-[12.5px] text-fg-muted">{title}</p>
      <p className="num mt-1 text-[24px] font-semibold leading-none tracking-tight">{formatPrice(p.revenue_cents)}</p>
      <p className="mt-1.5 text-[12px] text-fg-muted">
        <span className="num text-fg">{formatNumber(p.rides)}</span> course{p.rides > 1 ? "s" : ""}
        {p.cash_cents > 0 && (
          <>
            {" "}· dont <span className="num">{formatPrice(p.cash_cents)}</span> en espèces
          </>
        )}
      </p>
      {commission != null && p.net_cents != null && (
        <p className="mt-2.5 flex flex-wrap items-baseline justify-between gap-x-2 border-t border-line pt-2.5 text-[12.5px]">
          <span className="text-fg-muted">Net chauffeur estimé</span>
          <span className="num font-semibold text-fg">{formatPrice(p.net_cents)}</span>
        </p>
      )}
    </div>
  );
}

/**
 * Où se règle la commission : flotte → Réglages › Dispatch (carte « Commission chauffeur ») ; centrale → Réglages ›
 * Commission & encaissement. Lien vers l'onglet lui-même (jamais l'onglet par défaut des réglages).
 */
const COMMISSION_SETTINGS: Record<DispatchModel, { href: string; tab: string; text: string }> = {
  fleet: { href: "/dashboard/settings?tab=dispatch", tab: "Dispatch", text: "Réglez la commission des chauffeurs dans" },
  centrale: { href: "/dashboard/settings?tab=centrale", tab: "Commission & encaissement", text: "Réglez votre commission dans" },
};

/** Encart « Chiffre d'affaires » : semaine / mois + 14 derniers jours (courses terminées). */
export function DriverEarningsCard({
  data,
  firstName,
  model = "fleet",
  canManage = true,
}: {
  data: DriverEarningsView;
  firstName: string;
  /** Modèle de l'organisation : onglet des réglages où se règle la commission */
  model?: DispatchModel;
  /** Propriétaire ou administrateur : invitation à régler la commission (le dispatcher ne la règle pas) */
  canManage?: boolean;
}) {
  const max = Math.max(1, ...data.series.map((d) => d.revenue_cents));
  // Formateur mémorisé (dateTimeFormat) : jamais de « new Intl » au rendu
  const fmtDay = dateTimeFormat("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" });
  const total14 = data.series.reduce((n, d) => n + d.revenue_cents, 0);
  const settings = COMMISSION_SETTINGS[model] ?? COMMISSION_SETTINGS.fleet;
  return (
    <Card>
      <CardHeader
        title="Chiffre d'affaires"
        icon={<Wallet />}
        description="Courses terminées, prix client TTC."
        action={
          data.commission != null ? (
            <span className="inline-flex h-[22px] items-center whitespace-nowrap rounded-full bg-white/[0.05] px-2 text-[12px] font-medium text-fg-muted">
              Commission <span className="num ml-1 text-fg">{formatNumber(data.commission, data.commission % 1 ? 1 : 0)}{NB}%</span>
            </span>
          ) : undefined
        }
      />
      <div className="space-y-4 p-5">
        {/* Côte à côte dès le téléphone : deux chiffres, pas deux cartes empilées */}
        <div className="grid grid-cols-2 gap-3">
          <Period title="Cette semaine" p={data.week} commission={data.commission} />
          <Period title="Ce mois-ci" p={data.month} commission={data.commission} />
        </div>

        <div>
          <div className="mb-2 flex items-baseline justify-between text-[12px] text-fg-muted">
            <span>14 derniers jours</span>
            <span className="num">{formatPrice(total14)}</span>
          </div>
          <div className="flex h-[92px] items-end gap-[2px]" role="list" aria-label={`Chiffre d'affaires de ${firstName} sur 14 jours`}>
            {data.series.map((d, i) => {
              const h = d.revenue_cents ? Math.max(6, Math.round((d.revenue_cents / max) * 72)) : 2;
              // Infobulle gardée dans la carte : calée à gauche pour les premiers jours, à droite pour les derniers
              const pos = i < 3 ? "left-0" : i > data.series.length - 4 ? "right-0" : "left-1/2 -translate-x-1/2";
              const label = `${fmtDay.format(new Date(`${d.date}T12:00:00Z`))} · ${d.rides} course${d.rides > 1 ? "s" : ""} · ${formatPrice(d.revenue_cents)}`;
              return (
                <div
                  key={d.date}
                  role="listitem"
                  tabIndex={0}
                  aria-label={label}
                  className="group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5 outline-none"
                >
                  <span
                    className={cn(
                      "pointer-events-none absolute -top-1 z-10 -translate-y-full whitespace-nowrap rounded-md border border-line-strong bg-ink-600 px-2 py-1 text-[12px] text-fg opacity-0 shadow-float transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
                      pos,
                    )}
                  >
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
                  <span aria-hidden className={cn("text-[12px] leading-none", d.today ? "font-semibold text-fg" : "text-fg-muted")}>{d.label}</span>
                </div>
              );
            })}
          </div>
        </div>

        {data.commission == null && canManage && (
          <p className="text-[12.5px] text-fg-muted">
            {settings.text}{" "}
            <Link href={settings.href} prefetch={false} className="text-fg underline underline-offset-2 hover:text-brand">
              Réglages › {settings.tab}
            </Link>{" "}
            pour estimer son net.
          </p>
        )}
        {(data.week.unpriced > 0 || data.month.unpriced > 0) && (
          <p className="text-[12.5px] text-amber">
            {data.month.unpriced} course{data.month.unpriced > 1 ? "s" : ""} sans prix ce mois-ci (non comptée{data.month.unpriced > 1 ? "s" : ""}).
          </p>
        )}
      </div>
    </Card>
  );
}
