import { RadarMark } from "@/components/brand/logo";
import { cn } from "@/lib/utils";
import styles from "./landing.module.css";
import { Section, SectionHeading } from "./section";
import { fr } from "./typo";

const STEPS = [
  {
    title: "La réservation arrive",
    text: "Depuis votre tableau de bord (téléphone, hôtel, conciergerie), votre mini-site ou votre site relié à l'API. Course immédiate ou planifiée.",
  },
  {
    title: "Les vagues partent",
    text: "4 km, puis 8, 12 et 16 km : l'offre sonne chez vos chauffeurs les plus proches. Une course planifiée est d'abord proposée à toute votre flotte.",
  },
  {
    title: "Un seul chauffeur l'obtient",
    text: "Le premier qui accepte a la course. Les autres offres se ferment aussitôt : « Course déjà attribuée ».",
  },
  {
    title: "Vous suivez jusqu'au bout",
    text: "Carte en direct, alertes de retard, fin de course, puis règlement de la commission en mode centrale.",
  },
];

/** Journal d'une course (illustration). */
const TIMELINE = [
  ["14:32:02", "Course #1928 créée depuis le mini-site", "text-fg-muted"],
  ["14:32:03", "Vague 1 : rayon 4 km", "text-fg-muted"],
  ["14:32:03", "3 chauffeurs notifiés", "text-fg"],
  ["14:32:33", "Vague 2 : rayon 8 km", "text-fg-muted"],
  ["14:32:34", "5 chauffeurs notifiés", "text-fg"],
  ["14:32:41", "Mohamed accepte", "text-brand"],
  ["14:32:41", "Course verrouillée · offres fermées", "text-fg"],
  ["14:32:42", "Chauffeur en route · arrivée 14:40", "text-fg-muted"],
] as const;

const SUMMARY = [
  { label: "Vague", value: "2 sur 4" },
  { label: "Rayon", value: "8 km" },
  { label: "Attribution", value: "1 seule" },
];

export function HowItWorks() {
  return (
    <Section id="fonctionnement" labelledBy="fonctionnement-titre">
      <div className="grid gap-12 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
        <div>
          <SectionHeading
            id="fonctionnement-titre"
            eyebrow="Fonctionnement"
            title={fr("De la réservation au règlement, en quatre temps.")}
          />
          <ol className="mt-10 space-y-2">
            {STEPS.map((s, i) => (
              <li key={s.title} className={cn("group relative flex gap-5 rounded-2xl p-4 transition-colors hover:bg-white/[0.02]", styles.reveal)}>
                <div className="flex flex-col items-center">
                  <span className="num grid size-9 shrink-0 place-items-center rounded-full border border-brand/40 bg-brand/10 text-[14px] font-semibold text-brand">
                    {i + 1}
                  </span>
                  {i < STEPS.length - 1 && <span aria-hidden className="mt-2 w-px flex-1 bg-gradient-to-b from-brand/30 to-transparent" />}
                </div>
                <div className="pb-2">
                  <h3 className="text-[17px] font-semibold tracking-tight">{s.title}</h3>
                  <p className="mt-1.5 text-[14.5px] leading-relaxed text-fg-muted">{fr(s.text)}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <div className={cn("lg:self-center", styles.reveal)}>
          <figure className="glass relative overflow-hidden rounded-2xl p-6">
            <div aria-hidden className="grid-bg pointer-events-none absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_at_top_right,black,transparent_70%)]" />
            <figcaption className="relative flex items-center justify-between gap-3">
              <span className="flex items-center gap-2.5">
                <RadarMark size={22} />
                <span className="text-[14px] font-semibold">Journal d&apos;une course</span>
              </span>
              <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-fg-muted">Exemple</span>
            </figcaption>
            <ul className="relative mt-5 space-y-2">
              {TIMELINE.map(([t, m, c]) => (
                <li key={t + m} className="flex gap-3.5 text-[13px]">
                  <span className="mono shrink-0 text-fg-muted">{t}</span>
                  <span className={c}>{fr(m)}</span>
                </li>
              ))}
            </ul>
            <div className="relative mt-6 grid grid-cols-3 gap-2 border-t border-line pt-5 text-center">
              {SUMMARY.map(({ label, value }) => (
                <div key={label}>
                  <p className="text-[11px] uppercase tracking-[0.14em] text-fg-muted">{label}</p>
                  <p className="num mt-1 text-[16px] font-semibold">{fr(value)}</p>
                </div>
              ))}
            </div>
          </figure>
        </div>
      </div>
    </Section>
  );
}
