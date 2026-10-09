"use client";
// Simulateur de gains Flotte Privée : budget publicité, prix moyen, taux de réservation → visites, réservations,
// chiffre d'affaires, reste après la pub, comparaison avec les applis. Simulation indicative (hypothèses affichées).
import { simulate, SIMULATOR } from "@rydar/shared";
import { ArrowRight, ChevronRight } from "lucide-react";
import { useId, type CSSProperties } from "react";
import { fr } from "@/components/marketing/typo";
import { cn } from "@/lib/utils";
import { eur, int, pct } from "./format";
import { useSim } from "./sim-context";

const BUDGET_CHIPS = [300, 600, 900, 1500];

/** Glissière : piste remplie jusqu'à la valeur (jetons de couleur), curseur lime de 24 px. */
const rangeClass = cn(
  "h-2.5 w-full cursor-pointer appearance-none rounded-full bg-transparent",
  "[&::-webkit-slider-thumb]:size-6 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full",
  "[&::-webkit-slider-thumb]:border-4 [&::-webkit-slider-thumb]:border-ink-900 [&::-webkit-slider-thumb]:bg-brand",
  "[&::-webkit-slider-thumb]:shadow-glow [&::-webkit-slider-thumb]:transition-transform active:[&::-webkit-slider-thumb]:scale-110",
  "[&::-moz-range-thumb]:size-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-4",
  "[&::-moz-range-thumb]:border-ink-900 [&::-moz-range-thumb]:bg-brand",
);

function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  display,
  valueText,
  minLabel,
  maxLabel,
  onChange,
  children,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  valueText: string;
  minLabel: string;
  maxLabel: string;
  onChange: (value: number) => void;
  children?: React.ReactNode;
}) {
  const id = useId();
  const fill = ((value - min) / (max - min)) * 100;
  const track: CSSProperties = {
    background: `linear-gradient(to right, var(--color-brand) ${fill}%, var(--color-ink-500) ${fill}%)`,
  };
  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-4">
        <label htmlFor={id} className="text-[14px] font-medium text-fg">
          {label}
        </label>
        <output htmlFor={id} className="num text-[26px] font-semibold leading-none text-fg">
          {display}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={valueText}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(Number(e.target.value))}
        className={rangeClass}
        style={track}
      />
      <div className="flex justify-between text-[12px] text-fg-subtle" aria-hidden>
        <span className="num">{minLabel}</span>
        <span className="num">{maxLabel}</span>
      </div>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-[12.5px] leading-relaxed text-fg-muted">
          {fr(hint)}
        </p>
      )}
    </div>
  );
}

export function Simulator() {
  const sim = useSim();
  const r = simulate({ budget: sim.budget, fare: sim.fare, conversion: sim.conversion });
  const perAppRide = SIMULATOR.app.fare * (1 - SIMULATOR.app.commission);
  const appShare = Math.max(6, Math.round((perAppRide / sim.fare) * 100));

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
      {/* Réglages */}
      <div className="surface rounded-2xl p-5 sm:p-7">
        <div className="space-y-8">
          <Slider
            label="Ton budget pub par mois"
            value={sim.budget}
            min={SIMULATOR.budget.min}
            max={SIMULATOR.budget.max}
            step={SIMULATOR.budget.step}
            display={eur(sim.budget)}
            valueText={`${int(sim.budget)} euros par mois`}
            minLabel={eur(SIMULATOR.budget.min)}
            maxLabel={eur(SIMULATOR.budget.max)}
            onChange={(budget) => sim.set({ budget })}
            hint="C'est toi qui choisis : nos experts répartissent ce budget entre Google Ads et Facebook pour faire venir des clients sur ton site."
          >
            <div className="flex flex-wrap gap-2" role="group" aria-label="Budgets fréquents">
              {BUDGET_CHIPS.map((b) => (
                <button
                  key={b}
                  type="button"
                  aria-pressed={sim.budget === b}
                  onClick={() => sim.set({ budget: b })}
                  className={cn(
                    "num min-h-10 rounded-full border px-4 text-[13.5px] font-medium transition-colors",
                    sim.budget === b
                      ? "border-brand/60 bg-brand/[0.12] text-fg"
                      : "border-line-strong text-fg-muted hover:border-fg-subtle hover:text-fg",
                  )}
                >
                  {eur(b)}
                </button>
              ))}
            </div>
          </Slider>
          <Slider
            label="Prix moyen d'une course"
            value={sim.fare}
            min={SIMULATOR.fare.min}
            max={SIMULATOR.fare.max}
            step={SIMULATOR.fare.step}
            display={eur(sim.fare)}
            valueText={`${int(sim.fare)} euros`}
            minLabel={eur(SIMULATOR.fare.min)}
            maxLabel={eur(SIMULATOR.fare.max)}
            onChange={(fare) => sim.set({ fare })}
            hint={`Sur nos centrales, une course rapporte ${SIMULATOR.fare.rangeLabel} en moyenne : transferts aéroport et gare, mises à disposition, clients pros.`}
          />
          <Slider
            label="Visiteurs qui réservent"
            value={Math.round(sim.conversion * 100)}
            min={Math.round(SIMULATOR.conversion.min * 100)}
            max={Math.round(SIMULATOR.conversion.max * 100)}
            step={1}
            display={pct(sim.conversion)}
            valueText={`${Math.round(sim.conversion * 100)} pour cent`}
            minLabel={pct(SIMULATOR.conversion.min)}
            maxLabel={pct(SIMULATOR.conversion.max)}
            onChange={(v) => sim.set({ conversion: v / 100 })}
            hint="Part des personnes arrivées sur ton site par une pub qui réservent une course : environ 25 % sur une recherche ciblée (« VTC aéroport », « chauffeur privé »)."
          />
        </div>
      </div>

      {/* Résultats */}
      <div className="relative overflow-hidden rounded-2xl border border-brand/25 bg-ink-850 p-5 sm:p-7">
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-brand/[0.09] blur-3xl" />
        <div aria-hidden className="grid-bg pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_80%_0%,black,transparent_70%)]" />
        <div className="relative">
          <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-brand">{fr(`Chaque mois, avec ${eur(sim.budget)} de pub`)}</p>
          <p className="mt-3 flex flex-wrap items-baseline gap-x-3">
            <span className="num text-brand-gradient text-[clamp(44px,8vw,68px)] font-semibold leading-none">{eur(r.revenue)}</span>
            <span className="text-[15px] text-fg-muted">{fr("de chiffre d'affaires estimé")}</span>
          </p>

          {/* Entonnoir : budget → visites → réservations */}
          <ol className="mt-7 grid grid-cols-3 gap-2" aria-label="Du budget aux réservations">
            {[
              { v: eur(sim.budget), l: "de pub" },
              { v: int(r.clicks), l: "visites sur ton site" },
              { v: int(r.bookings), l: "réservations" },
            ].map((s, i) => (
              <li key={s.l} className="relative rounded-xl border border-line-strong bg-ink-900/70 px-3 py-3 sm:px-4">
                <span className="num block text-[clamp(18px,3.2vw,24px)] font-semibold text-fg">{s.v}</span>
                <span className="mt-1 block text-[12px] leading-snug text-fg-muted">{s.l}</span>
                {i < 2 && (
                  <ChevronRight aria-hidden className="absolute -right-[13px] top-1/2 z-10 size-4 -translate-y-1/2 rounded-full bg-ink-850 text-brand" />
                )}
              </li>
            ))}
          </ol>

          <dl className="mt-3 grid grid-cols-2 gap-2">
            {[
              { l: "Reste après la pub", v: eur(r.net), strong: true },
              { l: "Pour 1 € de pub", v: eur(r.roi, 2), strong: false },
              { l: "Sur 12 mois", v: eur(r.revenue * 12), strong: false },
              { l: "Réservations par semaine", v: `≈ ${int(Math.round(r.bookings / 4.33))}`, strong: false },
            ].map((s) => (
              <div key={s.l} className="rounded-xl border border-line bg-white/[0.02] px-3 py-3 sm:px-4">
                <dt className="text-[12px] text-fg-muted">{fr(s.l)}</dt>
                <dd className={cn("num mt-1 text-[20px] font-semibold", s.strong ? "text-brand" : "text-fg")}>{s.v}</dd>
              </div>
            ))}
          </dl>

          {/* Ce qu'il reste par course */}
          <div className="mt-7">
            <p className="text-[13px] font-medium text-fg">{fr("Ce qu'il te reste par course")}</p>
            <div className="mt-3 space-y-3">
              <div>
                <div className="flex justify-between text-[12.5px]">
                  <span className="text-fg">Ta centrale Flotte Privée</span>
                  <span className="num font-semibold text-brand">{eur(sim.fare)}</span>
                </div>
                <div className="mt-1.5 h-3 rounded-full bg-ink-600">
                  <div className="h-3 rounded-full bg-brand transition-[width] duration-300" style={{ width: "100%" }} />
                </div>
              </div>
              <div>
                <div className="flex justify-between text-[12.5px]">
                  <span className="text-fg-muted">{fr(`Applis de VTC (course de ${SIMULATOR.app.rangeLabel}, commission jusqu'à ${pct(SIMULATOR.app.commission)})`)}</span>
                  <span className="num font-semibold text-fg-muted">{eur(perAppRide, 2)}</span>
                </div>
                <div className="mt-1.5 h-3 rounded-full bg-ink-600">
                  <div className="h-3 rounded-full bg-fg-subtle transition-[width] duration-300" style={{ width: `${appShare}%` }} />
                </div>
              </div>
            </div>
            {r.net > 0 && (
              <p className="mt-4 text-[14px] leading-relaxed text-fg-muted">
                {fr(`Pour garder ${eur(r.net)} sur les applis, il te faudrait environ `)}
                <strong className="font-semibold text-fg">{fr(`${int(r.appRides)} courses`)}</strong>
                {fr(". Avec ta centrale : ")}
                <strong className="font-semibold text-brand">{fr(`${int(r.bookings)} courses`)}</strong>.
              </p>
            )}
          </div>

          <a
            href="#test"
            className="mt-7 inline-flex min-h-12 items-center gap-2 rounded-xl bg-brand px-5 text-[15px] font-semibold text-brand-fg transition-colors hover:bg-brand-strong"
          >
            Tester mon éligibilité <ArrowRight className="size-4" aria-hidden />
          </a>
        </div>
      </div>

      <p className="text-[12px] leading-relaxed text-fg-muted lg:col-span-2">
        {fr(
          `Simulation indicative, sans engagement : coût moyen d'un clic estimé à ${eur(SIMULATOR.cpc, 2)}, prix moyen et part des visiteurs qui réservent réglables ci-dessus ; applis : course moyenne de ${eur(SIMULATOR.app.fare, 2)} et commission de ${pct(SIMULATOR.app.commission)}. Les résultats réels dépendent de ta zone, de la concurrence, de la saison et de ton service : aucun résultat n'est garanti.`,
        )}
      </p>
    </div>
  );
}
