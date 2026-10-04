import { formatPrice } from "@rydar/shared";
import { Check, Database, FileText, Receipt, RefreshCw, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { contactHref, PRICING_HREF } from "./contact";
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

/** Offres publiques de la base (/admin/plans) ; aucune (ou base injoignable) : « Tarif sur mesure ». */
export function PlanCards({ plans }: { plans: PublicPlan[] }) {
  if (plans.length === 0) {
    return (
      <div className={cn("surface mx-auto flex max-w-xl flex-col items-center rounded-2xl p-8 text-center", styles.reveal)}>
        <h2 className="text-[18px] font-semibold">Tarif sur mesure</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-fg-muted">
          {fr("Selon la taille de votre flotte ou de votre réseau de chauffeurs : écrivez-nous, nous vous proposons une formule adaptée.")}
        </p>
        <Button asChild variant="primary" className="mt-6">
          <Link href={PRICING_HREF}>Demander un tarif</Link>
        </Button>
      </div>
    );
  }
  return (
    <div className={cn("mx-auto grid gap-4", plans.length >= 3 ? "lg:grid-cols-3" : plans.length === 2 ? "max-w-4xl md:grid-cols-2" : "max-w-md")}>
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
          <h2 className="text-[17px] font-semibold">{p.name}</h2>
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
          {/* Formulaire de contact, sujet « Demande de tarif », offre préremplie */}
          <Button
            asChild
            variant={p.highlighted ? "primary" : "secondary"}
            className="mt-8 h-auto min-h-10 w-full whitespace-normal py-2 text-center"
          >
            <Link href={contactHref("pricing", p.code)}>Choisir l&apos;offre {p.name}</Link>
          </Button>
        </article>
      ))}
    </div>
  );
}

/** Mention sous les offres : frais plateforme par course, flotte comme centrale (CGV, articles 3 à 5). */
export function PlatformFeeNote({ className }: { className?: string }) {
  return (
    <p className={cn("mx-auto max-w-2xl text-center text-[13px] leading-relaxed text-fg-muted", className)}>
      {fr(
        "Flotte ou centrale à commission : des frais plateforme par course terminée, toutes taxes comprises, peuvent s'ajouter à l'abonnement ou le remplacer, selon les conditions convenues avec Rydar. Rydar n'encaisse pas le prix des courses.",
      )}
    </p>
  );
}

const link = "text-fg underline decoration-white/25 underline-offset-4 transition-colors hover:decoration-brand";

/** Conditions utiles avant de choisir (reprises des CGV). */
const FACTS: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: RefreshCw,
    title: "Vous gardez la main",
    text: "Changer d'offre ou arrêter le renouvellement se fait à tout moment depuis le tableau de bord ; l'arrêt prend effet à la fin de la période payée (remboursement au prorata si vous résiliez parce que vous refusez une hausse de vos frais ou une modification défavorable des CGV).",
  },
  {
    icon: Receipt,
    title: "Changements de prix annoncés",
    text: "Abonnement hors taxes, TVA en sus : un changement de son prix est annoncé au moins 30 jours à l'avance et ne s'applique qu'au renouvellement suivant. Frais par course : toute hausse est annoncée par e-mail au moins 30 jours avant de s'appliquer, sauf accord écrit de votre part ; vous pouvez résilier sans frais avant, avec remboursement au prorata de l'abonnement payé d'avance.",
  },
  {
    icon: FileText,
    title: "Frais plateforme lisibles",
    text: "Un pourcentage du prix, un montant fixe par course terminée, ou les deux, toutes taxes comprises, selon les conditions convenues avec Rydar. Affichés dans votre tableau de bord, avec un relevé exportable en CSV.",
  },
  {
    icon: Database,
    title: "Vos données vous suivent",
    text: "Avant la fin du contrat, vous pouvez demander l'export de vos courses, clients, chauffeurs, véhicules et règlements au format CSV.",
  },
];

/** « Bon à savoir » de la page Tarifs. */
export function PricingFacts() {
  return (
    <Section labelledBy="tarifs-conditions-titre" className="border-y border-line bg-ink-950/40" inner="py-16 sm:py-24">
      <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
        <SectionHeading
          id="tarifs-conditions-titre"
          eyebrow="Bon à savoir"
          title="Des conditions simples, écrites noir sur blanc."
          intro={
            <>
              {fr("Tout est détaillé dans les conditions générales de vente.")}{" "}
              <Link href="/cgv" className={link}>
                Lire les CGV
              </Link>
              {" · "}
              <Link href="/abonnement-resiliation" className={link}>
                {fr("Résiliation et remboursement")}
              </Link>
            </>
          }
        />
        <ul className="grid gap-3 sm:grid-cols-2">
          {FACTS.map(({ icon: Icon, title, text }) => (
            <li key={title} className={cn("surface rounded-2xl p-5", styles.reveal)}>
              <h3 className="flex items-center gap-2.5 text-[15.5px] font-semibold tracking-tight">
                <Icon className="size-[18px] shrink-0 text-brand" aria-hidden />
                {fr(title)}
              </h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-fg-muted">{fr(text)}</p>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
