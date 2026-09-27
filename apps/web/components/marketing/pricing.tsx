import { formatPrice } from "@rydar/shared";
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { mailto } from "./contact";
import styles from "./landing.module.css";
import { Section, SectionHeading } from "./section";
import { fr } from "./typo";

export type PublicPlan = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price_monthly_cents: number;
  features: string[] | null;
  highlighted: boolean;
};

/**
 * Section Tarifs : titre et mentions envoyés tout de suite ; les offres (`children`), lues en base, arrivent
 * ensuite en streaming sans retarder le reste de la page.
 */
export function Pricing({ children }: { children: ReactNode }) {
  return (
    <Section id="tarifs" labelledBy="tarifs-titre">
      <SectionHeading
        id="tarifs-titre"
        center
        eyebrow="Tarifs"
        title="Une offre pour chaque centrale"
        intro={fr("Abonnement mensuel ou annuel, prix hors taxes. Vous arrêtez le renouvellement quand vous voulez, depuis le tableau de bord.")}
      />
      {children}
      <p className="mx-auto mt-8 max-w-2xl text-center text-[13px] leading-relaxed text-fg-muted">
        {fr(
          "Mode centrale à commission : frais plateforme par course terminée, en plus ou à la place de l'abonnement selon les conditions convenues. Rydar n'encaisse pas le prix des courses.",
        )}
      </p>
    </Section>
  );
}

/** Offres publiques de la base (/admin/plans) ; aucune (ou base injoignable) : « Tarif sur mesure ». */
export function PlanCards({ plans }: { plans: PublicPlan[] }) {
  if (plans.length === 0) {
    return (
      <div className={cn("surface mx-auto mt-12 flex max-w-xl flex-col items-center rounded-2xl p-8 text-center", styles.reveal)}>
        <p className="text-[18px] font-semibold">Tarif sur mesure</p>
        <p className="mt-2 text-[14px] leading-relaxed text-fg-muted">
          {fr("Selon la taille de votre flotte ou de votre réseau de chauffeurs : écrivez-nous, nous vous proposons une formule adaptée.")}
        </p>
        <Button asChild variant="primary" className="mt-6">
          <a href={mailto("Tarifs Rydar Drive")}>Demander un tarif</a>
        </Button>
      </div>
    );
  }
  return (
    <div className={cn("mx-auto mt-12 grid gap-4", plans.length >= 3 ? "lg:grid-cols-3" : plans.length === 2 ? "max-w-4xl md:grid-cols-2" : "max-w-md")}>
      {plans.map((p) => (
        <article
          key={p.id}
          className={cn(
            "surface relative flex flex-col rounded-2xl p-7",
            styles.reveal,
            p.highlighted && "border-brand/40 shadow-[0_0_0_1px_rgb(200_240_60/0.25),0_40px_100px_-50px_rgb(200_240_60/0.6)]",
          )}
        >
          {p.highlighted && (
            <span className="absolute -top-3 left-7 rounded-full bg-brand px-3 py-1 text-[11px] font-bold text-brand-fg">Recommandé</span>
          )}
          <h3 className="text-[17px] font-semibold">{p.name}</h3>
          {p.description && <p className="mt-1 text-[13.5px] text-fg-muted">{fr(p.description)}</p>}
          <p className="mt-6">
            <span className="num text-[40px] font-semibold tracking-tight">{formatPrice(p.price_monthly_cents)}</span>
            <span className="text-[13px] text-fg-muted"> HT / mois</span>
          </p>
          <ul className="mt-6 flex-1 space-y-2.5">
            {(p.features ?? []).map((f) => (
              <li key={f} className="flex gap-2.5 text-[13.5px] text-fg-muted">
                <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden /> {fr(f)}
              </li>
            ))}
          </ul>
          <Button asChild variant={p.highlighted ? "primary" : "secondary"} className="mt-8 w-full">
            <a href={mailto(`Offre ${p.name}`)}>Démarrer avec {p.name}</a>
          </Button>
        </article>
      ))}
    </div>
  );
}

/** Pendant le chargement des offres : même gabarit, sans contenu (jamais de faux « Tarif sur mesure »). */
export function PlanCardsSkeleton() {
  const bar = "skeleton rounded-md motion-reduce:animate-none";
  return (
    <div className="mx-auto mt-12 grid gap-4 lg:grid-cols-3">
      <p role="status" className="sr-only">
        Chargement des offres…
      </p>
      {[0, 1, 2].map((i) => (
        <div key={i} aria-hidden className="surface flex flex-col rounded-2xl p-7">
          <div className={cn(bar, "h-5 w-24")} />
          <div className={cn(bar, "mt-3 h-4 w-3/4")} />
          <div className={cn(bar, "mt-7 h-10 w-36")} />
          <div className="mt-7 space-y-3.5">
            {[0, 1, 2, 3, 4].map((j) => (
              <div key={j} className={cn(bar, "h-3.5", j % 2 ? "w-2/3" : "w-5/6")} />
            ))}
          </div>
          <div className={cn(bar, "mt-9 h-10 w-full rounded-xl")} />
        </div>
      ))}
    </div>
  );
}
