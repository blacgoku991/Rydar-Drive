import { AppWindow, ArrowRight, HandCoins, Radar, Smartphone, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import styles from "./landing.module.css";
import { Section, SectionHeading } from "./section";
import { fr } from "./typo";

/** Points forts de l'accueil, chacun relié à son thème de la page Services. */
const HIGHLIGHTS: { href: string; icon: LucideIcon; title: string; text: string }[] = [
  {
    href: "/services#dispatch",
    icon: Radar,
    title: "Dispatch par vagues",
    text: "Chaque course part d'abord à vos chauffeurs à moins de 4 km, puis à 8, 12 et 16 km. Un seul l'obtient.",
  },
  {
    href: "/services#chauffeurs",
    icon: Smartphone,
    title: "App chauffeur iOS & Android",
    text: "L'offre sonne même téléphone verrouillé, avec départ, destination et prix avant d'accepter. Guidage inclus.",
  },
  {
    href: "/services#reservations",
    icon: AppWindow,
    title: "Mini-site de réservation",
    text: "À vos couleurs, sur votre sous-domaine ou votre domaine, avec devis instantané. Sans compte client.",
  },
  {
    href: "/services#commissions",
    icon: HandCoins,
    title: "Centrale à commission",
    text: "Commission calculée à chaque course, règlement suivi jusqu'à l'encaissement, relances automatiques.",
  },
];

/** Accueil : aperçu court des services. */
export function ServicesOverview() {
  return (
    <Section id="apercu-services" labelledBy="apercu-services-titre">
      <div className="grid gap-12 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
        <div className="flex flex-col items-start">
          <SectionHeading
            id="apercu-services-titre"
            eyebrow="Services"
            title={fr("Tout pour faire tourner votre centrale.")}
            intro={fr("Un seul outil, de la réservation au règlement : recevoir vos courses, les dispatcher, suivre vos chauffeurs et vos commissions.")}
          />
          <Button asChild variant="outline" size="lg" className={cn("mt-8", styles.reveal)}>
            <Link href="/services">
              Voir tous les services <ArrowRight aria-hidden />
            </Link>
          </Button>
        </div>
        <ul className="grid gap-4 sm:grid-cols-2">
          {HIGHLIGHTS.map(({ href, icon: Icon, title, text }) => (
            <li
              key={href}
              className={cn(
                "surface group relative flex flex-col rounded-2xl p-5 transition-colors duration-300 hover:border-white/[0.12] has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-brand/70 sm:p-6",
                styles.reveal,
              )}
            >
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-brand/50 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100"
              />
              <div className="flex items-center gap-3 sm:flex-col sm:items-start sm:gap-5">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.03]">
                  <Icon aria-hidden className="size-[18px] text-brand" />
                </span>
                <h3 className="text-[16.5px] font-semibold tracking-tight">
                  {/* Toute la carte est cliquable ; le nom du lien reste le titre */}
                  <Link href={href} className="after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none">
                    {title}
                  </Link>
                </h3>
              </div>
              <p className="mt-3 flex-1 text-[14px] leading-relaxed text-fg-muted sm:mt-2">{fr(text)}</p>
              <span aria-hidden className="mt-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-fg-muted transition-colors group-hover:text-brand">
                En savoir plus <ArrowRight className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
