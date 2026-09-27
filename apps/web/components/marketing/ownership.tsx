import { BadgeEuro, CarFront, ClipboardList, UsersRound, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import styles from "./landing.module.css";
import { Section, SectionHeading } from "./section";
import { fr } from "./typo";

const OWNED: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: ClipboardList, title: "Vos courses", text: "Réservées chez vous, à votre nom : sur votre site, votre mini-site ou par votre équipe." },
  { icon: UsersRound, title: "Vos clients", text: "Aucun compte client chez Rydar, aucune application client : la relation reste la vôtre." },
  { icon: BadgeEuro, title: "Vos prix", text: "Grilles, forfaits et commissions sont fixés par votre centrale." },
  { icon: CarFront, title: "Vos chauffeurs", text: "Rattachés à votre centrale : vous les ajoutez ou validez leur inscription, et vous contrôlez leurs documents." },
];

/** Positionnement : Rydar Drive est un logiciel, la centrale reste maîtresse de son activité. */
export function Ownership() {
  return (
    <Section labelledBy="positionnement-titre" className="border-y border-line bg-ink-950/40">
      <div className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:items-center lg:gap-16">
        <div>
          <SectionHeading
            id="positionnement-titre"
            eyebrow="Positionnement"
            title={fr("Un logiciel. Vos courses.")}
            intro={fr("Rydar Drive est un logiciel de dispatch : votre centrale reste maîtresse de son activité, de ses clients et de ses tarifs.")}
          />
          <p className={cn("mt-6 max-w-xl text-[13.5px] leading-relaxed text-fg-muted", styles.reveal)}>
            {fr(
              "Rydar n'est ni transporteur, ni exploitant VTC, ni centrale de réservation, ni intermédiaire de paiement, ni employeur : les contrats de transport et les obligations VTC restent ceux de la centrale.",
            )}{" "}
            <Link href="/cgv" className="text-fg underline decoration-white/25 underline-offset-4 transition-colors hover:decoration-brand">
              Lire les CGV
            </Link>
          </p>
        </div>
        <ul className="grid gap-3 sm:grid-cols-2">
          {OWNED.map(({ icon: Icon, title, text }) => (
            <li key={title} className={cn("surface rounded-2xl p-5", styles.reveal)}>
              <p className="flex items-center gap-2.5 text-[16px] font-semibold tracking-tight">
                <Icon className="size-[18px] text-brand" aria-hidden />
                {title}
              </p>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-fg-muted">{fr(text)}</p>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
