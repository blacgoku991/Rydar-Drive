import { ChevronDown } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { mailto } from "./contact";
import styles from "./landing.module.css";
import { Section, SectionHeading } from "./section";
import { fr } from "./typo";

const link = "text-fg underline decoration-white/25 underline-offset-4 transition-colors hover:decoration-brand";

const FAQ: { q: string; a: ReactNode }[] = [
  {
    q: "Rydar est-il un transporteur ?",
    a: fr(
      "Non. Rydar Drive est un logiciel de dispatch. Les courses, les clients, les prix, les contrats de transport et les chauffeurs appartiennent à votre centrale, qui assume les obligations VTC. Rydar n'est ni exploitant VTC, ni centrale de réservation, ni intermédiaire de paiement, ni employeur.",
    ),
  },
  {
    q: "Qui encaisse le prix des courses ?",
    a: fr(
      "Votre centrale ou vos chauffeurs, comme aujourd'hui : Rydar n'encaisse pas le prix des courses et ne détient aucun fonds pour votre compte. En mode centrale à commission, le logiciel calcule la commission de chaque course et suit son règlement entre vous et vos chauffeurs.",
    ),
  },
  {
    q: "Mes clients doivent-ils créer un compte ?",
    a: fr(
      "Non. Ils réservent sur votre mini-site ou sur votre site relié à l'API, sans inscription. Votre équipe peut aussi saisir une course en quelques secondes depuis le tableau de bord.",
    ),
  },
  {
    q: "Que se passe-t-il si aucun chauffeur n'accepte ?",
    a: fr(
      "Après la dernière vague (16 km par défaut), une relance repart à 4 puis 8 km. Sans preneur, la course passe « Sans chauffeur » avec l'explication, et vous pouvez l'attribuer vous-même.",
    ),
  },
  {
    q: "Comment mes chauffeurs rejoignent-ils la centrale ?",
    a: fr(
      "Depuis le tableau de bord, vous créez le compte du chauffeur ou l'invitez par e-mail. En mode centrale, vous pouvez aussi partager votre lien d'inscription : le chauffeur installe l'application et dépose sa candidature avec ses documents, que vous vérifiez avant de le valider.",
    ),
  },
  {
    q: "La position des chauffeurs est-elle suivie en permanence ?",
    a: fr(
      "Non. La position n'est envoyée que lorsque le chauffeur est en ligne ou en course, y compris application en arrière-plan ou téléphone verrouillé. Passer hors ligne ou fermer l'application arrête l'envoi. Hors ligne, seul un signalement de route publié par le chauffeur (accident, bouchon…) joint sa position du moment.",
    ),
  },
  {
    q: "Où sont hébergées les données ?",
    a: (
      <>
        {fr(
          "Dans l'Union européenne. Chaque centrale est isolée des autres en base de données, et un accord de traitement des données encadre la sous-traitance au sens du RGPD :",
        )}{" "}
        <Link href="/dpa" className={link}>
          lire le DPA
        </Link>
        .
      </>
    ),
  },
];

export function Faq() {
  return (
    <Section id="faq" labelledBy="faq-titre" className="border-t border-line">
      <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
        <SectionHeading
          id="faq-titre"
          eyebrow="Questions fréquentes"
          title="Vos questions, nos réponses."
          intro={
            <>
              {fr("Une autre question ?")}{" "}
              <a href={mailto("Question sur Rydar Drive")} className={link}>
                Écrivez-nous
              </a>
              {fr(" : nous répondons à chaque message.")}
            </>
          }
        />
        <div className={cn("divide-y divide-line border-y border-line", styles.reveal)}>
          {FAQ.map(({ q, a }, i) => (
            <details key={q} name="faq" open={i === 0} className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-[16px] font-medium tracking-tight transition-colors hover:text-brand [&::-webkit-details-marker]:hidden">
                {fr(q)}
                <ChevronDown aria-hidden className="size-4 shrink-0 text-fg-muted transition-transform duration-200 group-open:rotate-180" />
              </summary>
              <div className="pb-6 pr-8 text-[14.5px] leading-relaxed text-fg-muted">{a}</div>
            </details>
          ))}
        </div>
      </div>
    </Section>
  );
}
