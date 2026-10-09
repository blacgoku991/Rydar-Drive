// Visuel du haut de page : réservations qui arrivent dans l'appli Rydar Drive, campagne et mois en cours. Données
// d'EXEMPLE (affichées comme telles), aucune image ni script tiers.
import { CalendarClock, Globe, Plane, TrainFront, TrendingUp } from "lucide-react";
import { fr } from "@/components/marketing/typo";
import { cn } from "@/lib/utils";

const RIDES = [
  { time: "06:40", from: "Paris 16e", to: "Aéroport CDG", price: "74 €", icon: Plane, delay: "0.15s" },
  { time: "09:15", from: "Gare de Lyon", to: "La Défense", price: "58 €", icon: TrainFront, delay: "0.35s" },
  { time: "14:30", from: "Orly", to: "Paris 8e", price: "62 €", icon: Plane, delay: "0.55s" },
];

const BARS = [38, 52, 44, 61, 57, 72, 66, 81, 77, 90, 84, 100];

export function HeroVisual() {
  return (
    <div
      role="img"
      aria-label={fr("Exemple : des réservations faites sur ton site arrivent dans ton application Rydar Drive, avec le chiffre d'affaires du mois.")}
      className="relative mx-auto w-full max-w-[460px] select-none pb-16 sm:pb-20"
    >
      <div aria-hidden className="absolute left-1/2 top-1/2 size-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-brand/10" />
      <div aria-hidden className="absolute left-1/2 top-1/2 size-[380px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-brand/15" />
      <div aria-hidden className="absolute left-1/2 top-1/2 size-[300px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand/[0.07] blur-3xl" />

      {/* Téléphone : agenda du jour */}
      <div className="relative mx-auto w-[290px] rounded-[2.4rem] border border-ink-400 bg-ink-950 p-2.5 shadow-float">
        <div className="rounded-[2rem] border border-line bg-ink-900 px-4 pb-5 pt-4">
          <div className="mx-auto mb-4 h-5 w-24 rounded-full bg-ink-950" />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-muted">Agenda</p>
              <p className="text-[17px] font-semibold text-fg">{fr("Aujourd'hui")}</p>
            </div>
            <span className="grid size-9 place-items-center rounded-xl border border-line-strong">
              <CalendarClock className="size-4 text-brand" />
            </span>
          </div>

          <div className="animate-rise mt-4 rounded-2xl border border-brand/40 bg-brand/[0.1] p-3" style={{ animationDelay: "0.9s" }}>
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-brand">
              <Globe className="size-3.5" /> Nouvelle réservation
            </p>
            <p className="mt-1 text-[13px] text-fg">{fr("Réservée sur ton site · 17:45")}</p>
            <p className="mt-0.5 flex items-center justify-between text-[13px] text-fg-muted">
              {fr("Paris 15e → Orly")} <span className="num font-semibold text-fg">66 €</span>
            </p>
          </div>

          <ul className="mt-3 space-y-2">
            {RIDES.map((r) => (
              <li key={r.time} className="animate-rise flex items-center gap-3 rounded-xl border border-line bg-ink-800 px-3 py-2.5" style={{ animationDelay: r.delay }}>
                <span className="num text-[12px] text-fg-muted">{r.time}</span>
                <r.icon className="size-4 shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">
                  {r.from} → {r.to}
                </span>
                <span className="num text-[12.5px] font-semibold text-fg">{r.price}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Mois en cours */}
      <div className="glass animate-rise absolute -bottom-2 left-0 w-[214px] rounded-2xl p-4 sm:-left-16 sm:bottom-0" style={{ animationDelay: "1.2s" }}>
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-fg-muted">Ce mois-ci</p>
          <span className="rounded-full border border-amber/40 px-1.5 py-0.5 text-[9.5px] font-semibold tracking-[0.1em] text-amber">EXEMPLE</span>
        </div>
        <p className="num mt-1.5 text-[24px] font-semibold leading-none text-fg">6 949,50 €</p>
        <p className="mt-1 text-[12px] text-fg-muted">129 courses</p>
        <div className="mt-3 flex h-10 items-end gap-1">
          {BARS.map((h, i) => (
            <span key={i} className={cn("flex-1 rounded-sm", i === BARS.length - 1 ? "bg-brand" : "bg-brand/35")} style={{ height: `${h}%` }} />
          ))}
        </div>
      </div>

      {/* Campagne */}
      <div className="glass animate-rise absolute -right-2 -top-6 w-[188px] rounded-2xl p-3.5 sm:-right-10" style={{ animationDelay: "1.5s" }}>
        <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-fg-muted">
          <TrendingUp className="size-3.5 text-brand" /> Tes pubs
        </p>
        <p className="mt-1.5 text-[12.5px] text-fg">Google Ads · Facebook</p>
        <p className="mt-1 flex items-center gap-1.5 text-[12px] text-brand">
          <span className="size-1.5 rounded-full bg-brand" /> Campagnes actives
        </p>
      </div>
    </div>
  );
}
