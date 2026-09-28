import { DISPATCH_MODEL_META } from "@rydar/shared";
import { ArrowRight, Building2, CarFront, Check, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import styles from "./landing.module.css";
import { Section, SectionHeading } from "./section";
import { fr } from "./typo";

const link = "text-fg underline decoration-white/25 underline-offset-4 transition-colors hover:decoration-brand";

type Audience = { id: string; icon: LucideIcon; title: string; lead: string; points: string[] };

/** Ce que chacun y gagne (les trois premiers points sont repris par l'aperçu de l'accueil). */
const AUDIENCES: Audience[] = [
  {
    id: "centrales",
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
    id: "chauffeurs",
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

function AudienceCard({ audience, as: Heading, limit, className }: { audience: Audience; as: "h2" | "h3"; limit?: number; className?: string }) {
  const { id, icon: Icon, title, lead, points } = audience;
  return (
    <article aria-labelledby={`public-${id}`} className={cn("surface relative overflow-hidden rounded-2xl p-6 sm:p-8", styles.reveal, className)}>
      <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 size-64 rounded-full bg-brand/[0.05] blur-3xl" />
      <div className="relative flex items-center gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.03]">
          <Icon className="size-5 text-brand" aria-hidden />
        </span>
        <div>
          <Heading id={`public-${id}`} className="text-[19px] font-semibold tracking-tight">
            {title}
          </Heading>
          <p className="text-[13.5px] text-fg-muted">{fr(lead)}</p>
        </div>
      </div>
      <ul className="relative mt-7 space-y-3.5">
        {points.slice(0, limit).map((p) => (
          <li key={p} className="flex gap-3 text-[14.5px] leading-relaxed text-fg">
            <span aria-hidden className="mt-[3px] grid size-5 shrink-0 place-items-center rounded-full bg-brand/12">
              <Check className="size-3 text-brand" />
            </span>
            {fr(p)}
          </li>
        ))}
      </ul>
    </article>
  );
}

/** Page Avantages : ce que chacun y gagne (titres h2, sous le titre de la page). */
export function Audiences() {
  return (
    <section aria-label="Ce que chacun y gagne" className="relative z-10">
      <div className="mx-auto grid max-w-6xl gap-4 px-4 pb-20 sm:px-6 sm:pb-28 lg:grid-cols-2">
        {AUDIENCES.map((a) => (
          <AudienceCard key={a.id} audience={a} as="h2" />
        ))}
      </div>
    </section>
  );
}

/** Deux modes d'exploitation (libellés partagés avec le tableau de bord). */
export function OperatingModes() {
  const more = {
    fleet: { href: "/services#dispatch", label: "Voir le dispatch" },
    centrale: { href: "/services#commissions", label: "Voir le suivi des commissions" },
  } as const;
  return (
    <Section labelledBy="modes-titre" className="border-y border-line bg-ink-950/40">
      <SectionHeading
        id="modes-titre"
        eyebrow="Deux modes"
        title={fr("Votre flotte ou votre réseau de chauffeurs.")}
        intro={fr("Rydar Drive suit votre façon de travailler : chauffeurs et véhicules de votre flotte, ou réseau de chauffeurs indépendants à la commission.")}
      />
      <div className="mt-12 grid gap-4 md:grid-cols-2">
        {(["fleet", "centrale"] as const).map((model, i) => (
          <article key={model} className={cn("flex flex-col rounded-2xl border border-dashed border-line-strong p-6 sm:p-7", styles.reveal)}>
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-fg-muted">Mode {i + 1}</p>
            <h3 className="mt-2 text-[18px] font-semibold tracking-tight">{DISPATCH_MODEL_META[model].label}</h3>
            <p className="mt-2 flex-1 text-[14.5px] leading-relaxed text-fg-muted">{fr(DISPATCH_MODEL_META[model].description)}</p>
            <Link href={more[model].href} className={cn(link, "mt-5 inline-flex w-fit items-center gap-1.5 text-[14px]")}>
              {more[model].label} <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          </article>
        ))}
      </div>
    </Section>
  );
}

/** Accueil : aperçu « Pour qui », relié à la page Avantages. */
export function AudiencesPreview() {
  return (
    <Section id="pour-qui" labelledBy="pour-qui-titre" className="border-y border-line bg-ink-950/40">
      <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <SectionHeading
          id="pour-qui-titre"
          eyebrow="Pour qui"
          title={fr("Pensé pour ceux qui font rouler les courses.")}
          intro={fr("La centrale garde la main sur son activité ; les chauffeurs gagnent du temps à chaque course.")}
        />
        <Button asChild variant="outline" size="lg" className={cn("w-fit shrink-0", styles.reveal)}>
          <Link href="/avantages">
            Tous les avantages <ArrowRight aria-hidden />
          </Link>
        </Button>
      </div>
      <div className="mt-12 grid gap-4 lg:grid-cols-2">
        {AUDIENCES.map((a) => (
          <AudienceCard key={a.id} audience={a} as="h3" limit={3} />
        ))}
      </div>
    </Section>
  );
}
