import { DISPATCH_MODEL_META } from "@rydar/shared";
import { Building2, CarFront, Check, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import styles from "./landing.module.css";
import { Section, SectionHeading } from "./section";
import { fr } from "./typo";

const AUDIENCES: { icon: LucideIcon; title: string; lead: string; points: string[] }[] = [
  {
    icon: Building2,
    title: "Centrales et flottes",
    lead: "Moins de téléphone, plus de courses servies.",
    points: [
      "Fini les courses copiées dans cinq groupes : le dispatch tourne seul, jour et nuit.",
      "Un seul chauffeur par course, sans dispute ni doublon.",
      "Toute la flotte en direct : qui est libre, en route, en retard.",
      "En mode centrale : commissions calculées, suivies et relancées automatiquement.",
      "Vos clients réservent chez vous, sans compte à créer.",
      "Chauffeurs ajoutés depuis le tableau de bord ou, en mode centrale, inscrits par votre lien ; vous contrôlez leurs documents.",
    ],
  },
  {
    icon: CarFront,
    title: "Chauffeurs",
    lead: "Des courses proches, sans rester collé aux groupes.",
    points: [
      "Les courses de votre centrale arrivent toutes seules quand vous êtes à proximité, avec sonnerie, même téléphone verrouillé.",
      "Départ, destination et prix (ou votre part) affichés avant d'accepter.",
      "Guidage jusqu'au client puis à destination, ou dans Waze, Google Maps ou Plans selon le téléphone.",
      "Planning des réservations et rappels avant chaque course.",
      "Gains du jour et de la semaine, commissions claires, règlement en un geste.",
      "Position envoyée seulement en ligne ou en course ; hors ligne, uniquement avec un signalement que vous publiez.",
    ],
  },
];

export function Audiences() {
  return (
    <Section id="avantages" labelledBy="avantages-titre" className="border-y border-line bg-ink-950/40">
      <SectionHeading
        id="avantages-titre"
        eyebrow="Avantages"
        title={fr("Pensé pour ceux qui font rouler les courses.")}
        intro={fr("La centrale garde la main sur son activité ; les chauffeurs gagnent du temps à chaque course.")}
      />
      <div className="mt-12 grid gap-4 lg:grid-cols-2">
        {AUDIENCES.map(({ icon: Icon, title, lead, points }) => (
          <article key={title} className={cn("surface relative overflow-hidden rounded-2xl p-6 sm:p-8", styles.reveal)}>
            <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 size-64 rounded-full bg-brand/[0.05] blur-3xl" />
            <div className="relative flex items-center gap-3">
              <span className="grid size-11 place-items-center rounded-xl border border-line bg-white/[0.03]">
                <Icon className="size-5 text-brand" aria-hidden />
              </span>
              <div>
                <h3 className="text-[19px] font-semibold tracking-tight">{title}</h3>
                <p className="text-[13.5px] text-fg-muted">{fr(lead)}</p>
              </div>
            </div>
            <ul className="relative mt-7 space-y-3.5">
              {points.map((p) => (
                <li key={p} className="flex gap-3 text-[14.5px] leading-relaxed text-fg">
                  <span className="mt-[3px] grid size-5 shrink-0 place-items-center rounded-full bg-brand/12">
                    <Check className="size-3 text-brand" aria-hidden />
                  </span>
                  {fr(p)}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>

      {/* Deux modes d'exploitation (libellés partagés avec le tableau de bord) */}
      <div className={cn("mt-4 grid gap-4 md:grid-cols-2", styles.reveal)}>
        {(["fleet", "centrale"] as const).map((model, i) => (
          <div key={model} className="rounded-2xl border border-dashed border-line-strong p-6">
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-fg-muted">Mode {i + 1}</p>
            <p className="mt-2 text-[16px] font-semibold">{DISPATCH_MODEL_META[model].label}</p>
            <p className="mt-2 text-[14px] leading-relaxed text-fg-muted">{fr(DISPATCH_MODEL_META[model].description)}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}
