import { ChevronDown } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { QUESTION_HREF } from "./contact";
import styles from "./landing.module.css";
import { fr } from "./typo";

const link = "text-fg underline decoration-white/25 underline-offset-4 transition-colors hover:decoration-brand";

type Question = { q: string; a: ReactNode };

/** Questions fréquentes, par thème (réponses reprises du produit, des CGV et du DPA). */
const FAQ_GROUPS: { id: string; title: string; items: Question[] }[] = [
  {
    id: "faq-logiciel",
    title: "Le logiciel et votre activité",
    items: [
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
        q: "Puis-je garder mon site actuel ?",
        a: fr(
          "Oui. Votre site peut être relié à l'API : chaque réservation crée la course et lance le dispatch automatiquement. Le formulaire du mini-site peut aussi s'afficher dans une page de votre site. L'accès à l'API, le mini-site et le domaine personnalisé dépendent de l'offre choisie.",
        ),
      },
    ],
  },
  {
    id: "faq-dispatch",
    title: "Dispatch et chauffeurs",
    items: [
      {
        q: "Que se passe-t-il si aucun chauffeur n'accepte ?",
        a: fr(
          "Après la dernière vague (16 km par défaut), une relance repart à 4 puis 8 km. Sans preneur, la course passe « Sans chauffeur » avec l'explication, et vous pouvez l'attribuer vous-même.",
        ),
      },
      {
        q: "Comment mes chauffeurs rejoignent-ils la centrale ?",
        a: fr(
          "Depuis le tableau de bord, vous créez le compte du chauffeur ou l'invitez par e-mail. Vous pouvez aussi partager votre lien d'inscription : le chauffeur installe l'application et dépose sa candidature avec ses documents, que vous vérifiez avant de le valider.",
        ),
      },
      {
        q: "La position des chauffeurs est-elle suivie en permanence ?",
        a: fr(
          "Non. La position n'est envoyée que lorsque le chauffeur est en ligne ou en course, y compris application en arrière-plan ou téléphone verrouillé. Passer hors ligne ou fermer l'application arrête l'envoi. Hors ligne, seul un signalement de route publié par le chauffeur (accident, bouchon…) joint sa position du moment.",
        ),
      },
      {
        q: "Comment sont gérées les prises en charge à l'aéroport ?",
        a: fr(
          "Indiquez le numéro de vol à la réservation : le vol est suivi, l'heure de prise en charge suit le retard et le chauffeur est prévenu.",
        ),
      },
    ],
  },
  {
    id: "faq-donnees",
    title: "Données et contrat",
    items: [
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
      {
        q: "Puis-je arrêter mon abonnement ?",
        a: fr(
          "Oui, à tout moment depuis le tableau de bord : l'arrêt du renouvellement prend effet à la fin de la période payée, sans remboursement de la période en cours. Exception : si vous résiliez parce que vous refusez une hausse de vos frais par course ou une modification défavorable des CGV, la résiliation se fait sans frais ni préavis avant sa date d'effet, et la part de l'abonnement payée d'avance pour la période restant à courir vous est remboursée au prorata. Vous pouvez aussi changer d'offre.",
        ),
      },
      {
        q: "Où trouver les règles de résiliation et de remboursement ?",
        a: (
          <>
            {fr(
              "Sur une page qui reprend les conditions générales de vente : arrêt du renouvellement, résiliation, remboursement au prorata en cas de refus d'une hausse, frais par course, fin du contrat et export des données.",
            )}{" "}
            <Link href="/abonnement-resiliation" className={link}>
              Abonnement, résiliation et remboursement
            </Link>
          </>
        ),
      },
      {
        q: "Puis-je récupérer mes données ?",
        a: (
          <>
            {fr(
              "Oui. Avant la fin du contrat, vous pouvez demander l'export de vos données (courses et coordonnées des clients, chauffeurs, véhicules, règlements) au format CSV. Le relevé des frais plateforme s'exporte directement depuis le tableau de bord.",
            )}{" "}
            <Link href="/cgv" className={link}>
              Lire les CGV
            </Link>
          </>
        ),
      },
    ],
  },
];

/** Invitation à poser une autre question (formulaire de contact, sujet « Question sur Rydar Drive »). */
export function FaqContactLine() {
  return (
    <>
      {fr("Une autre question ?")}{" "}
      <Link href={QUESTION_HREF} className={link}>
        Écrivez-nous
      </Link>
      {fr(" : nous répondons à chaque message.")}
    </>
  );
}

/** Questions fréquentes groupées par thème : titre du thème (h2) à gauche, questions dépliables à droite. */
export function FaqGroups() {
  return (
    <div className="relative z-10 mx-auto max-w-6xl px-4 pb-20 sm:px-6 sm:pb-28">
      <div className="space-y-14 sm:space-y-20">
        {FAQ_GROUPS.map((group, gi) => (
          <section key={group.id} aria-labelledby={group.id} className="grid gap-6 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
            <div className={styles.reveal}>
              <div className="lg:sticky lg:top-24">
                <p className="num text-[12px] font-semibold uppercase tracking-[0.18em] text-brand">{String(gi + 1).padStart(2, "0")}</p>
                <h2 id={group.id} className="mt-2 text-balance text-[24px] font-semibold leading-[1.15] tracking-[-0.02em] sm:text-[28px]">
                  {group.title}
                </h2>
              </div>
            </div>
            <div className={cn("divide-y divide-line border-y border-line", styles.reveal)}>
              {group.items.map(({ q, a }, i) => (
                <details key={q} open={gi === 0 && i === 0} className="group">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-[16px] font-medium tracking-tight transition-colors hover:text-brand [&::-webkit-details-marker]:hidden">
                    {fr(q)}
                    <ChevronDown aria-hidden className="size-4 shrink-0 text-fg-muted transition-transform duration-200 group-open:rotate-180" />
                  </summary>
                  <div className="pb-6 pr-8 text-[14.5px] leading-relaxed text-fg-muted">{a}</div>
                </details>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
