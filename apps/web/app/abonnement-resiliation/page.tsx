import type { Metadata } from "next";
import Link from "next/link";
import { legalContact } from "@/components/legal/legal-contact";
import { LegalList, LegalPage, LegalSection } from "@/components/legal/legal-page";
import { ORG_LEGAL_VERSION, SUBSCRIPTION_TERMS_UPDATED_AT, getLegalInfo } from "@/lib/legal";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Abonnement, résiliation et remboursement — Rydar Drive" },
  description:
    "Arrêt du renouvellement, résiliation, remboursement au prorata, frais par course, fin du contrat et export des données : les règles des CGV de Rydar Drive, en clair.",
};

// Résumé des CGV (articles 4 à 8, 16), SANS rien y ajouter : chaque phrase reprend une règle des CGV en vigueur
// (version ORG_LEGAL_VERSION). Changer les CGV = relire cette page (test components/legal/legal-pages.test.ts).
// Les CGV ne fixent ni le délai ni le moyen du remboursement au prorata : cette page n'en promet pas.
export default async function SubscriptionTermsPage() {
  const legal = await getLegalInfo();
  const contact = legalContact(legal.email);
  const link = "text-fg underline underline-offset-2";
  // Renvois cliquables : article des CGV (ancres /cgv#article-N) et section de cette page
  const art = (n: number) => (
    <Link href={`/cgv#article-${n}`} className={link}>
      article {n}
    </Link>
  );
  const sec = (n: number) => (
    <a href={`#article-${n}`} className={link}>
      section {n}
    </a>
  );
  return (
    <LegalPage title="Abonnement, résiliation et remboursement" updatedAt={SUBSCRIPTION_TERMS_UPDATED_AT}>
      <p>
        Cette page résume les règles d&apos;abonnement, de résiliation et de remboursement des{" "}
        <Link href="/cgv" className={link}>conditions générales de vente</Link> (CGV, version {ORG_LEGAL_VERSION}), qui
        s&apos;appliquent entre l&apos;éditeur de Rydar Drive et chaque centrale ou flotte cliente. Elle n&apos;ajoute ni
        ne retire rien aux CGV : en cas de doute, leur texte prévaut. Les numéros d&apos;articles renvoient aux CGV.
      </p>

      <LegalSection title="1. Des contrats entre professionnels">
        <LegalList
          items={[
            <>Rydar Drive est vendu uniquement à des professionnels (centrales de réservation, exploitants de VTC, flottes) : les CGV leur sont réservées.</>,
            <>Le droit de rétractation de 14 jours du Code de la consommation est réservé aux consommateurs (article L221-18) : il ne s&apos;applique pas à ces contrats, sauf dans le cas prévu par la loi d&apos;un contrat conclu hors établissement avec une entreprise de cinq salariés au plus, lorsque son objet n&apos;entre pas dans le champ de son activité principale (article L221-3).</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="2. Abonnement">
        <LegalList
          items={[
            <>Prix exprimé hors taxes : la TVA au taux en vigueur s&apos;y ajoute. Son montant hors taxes est celui affiché dans l&apos;offre au moment de la souscription ({art(4)}).</>,
            <>Abonnement mensuel ou annuel, payable d&apos;avance par les moyens proposés par Stripe, le prestataire de paiement de l&apos;éditeur, et renouvelé automatiquement pour la même durée. Les factures sont émises par Stripe et accessibles depuis le tableau de bord (Réglages › Abonnement).</>,
            <>Changer d&apos;offre ou arrêter le renouvellement : à tout moment, depuis le tableau de bord. L&apos;arrêt prend effet à la fin de la période payée, sans remboursement de la période en cours, sauf dans le cas de la {sec(3)} ({art(4)}).</>,
            <>Un changement du prix de l&apos;abonnement est annoncé au moins 30 jours à l&apos;avance et ne s&apos;applique qu&apos;au renouvellement suivant : vous pouvez arrêter le renouvellement ou résilier avant ({art(4)}).</>,
            <>L&apos;abonnement peut se cumuler avec des frais plateforme par course terminée, qui se règlent à part ({sec(4)}).</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="3. Remboursement">
        <p>
          En dehors du cas ci-dessous, l&apos;arrêt du renouvellement prend effet à la fin de la période payée, sans
          remboursement de la période en cours ({art(4)}).
        </p>
        <h3 className="text-[15px] font-semibold text-fg">Refus d&apos;une hausse des frais ou d&apos;une modification défavorable des CGV</h3>
        <LegalList
          items={[
            <>La centrale qui refuse une hausse de ses frais par course ({art(5)}) ou une modification défavorable des CGV ({art(16)}) peut résilier le contrat par écrit, sans frais et sans préavis, avant sa date d&apos;effet ou son entrée en vigueur.</>,
            <>La résiliation prend effet à la date qu&apos;elle choisit, au plus tard la veille de cette date, et la part de l&apos;abonnement payée d&apos;avance pour la période restant à courir lui est remboursée au prorata ({art(7)}).</>,
            <>Les frais des courses terminées avant la résiliation restent dus ({art(5)}).</>,
            <>Pour résilier dans ce cas, écrivez {contact.to}, en indiquant la date d&apos;effet choisie.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="4. Frais par course">
        <LegalList
          items={[
            <>Une course annulée ne porte aucuns frais ({art(5)}).</>,
            <>Les frais d&apos;une course terminée sont dus dès sa fin, que la centrale ait encaissé ou non le client ou le chauffeur, et même si elle annule ou conteste la commission due par le chauffeur. Ils sont exprimés toutes taxes comprises.</>,
            <>Le relevé ne se modifie pas : tout changement fait l&apos;objet d&apos;une écriture de correction. Une correction à la hausse compte immédiatement ; une correction à la baisse attend la décision de l&apos;éditeur, qui ne peut la refuser que si elle ne correspond pas à la course réellement effectuée et payée, par une décision motivée affichée dans le tableau de bord ; sans décision dans les 30 jours, elle est acceptée. L&apos;éditeur peut aussi y inscrire, avec son motif, un avoir ou la correction d&apos;une erreur de calcul des frais.</>,
            <>Une hausse des taux est annoncée au propriétaire par e-mail et dans le tableau de bord au moins 30 jours avant sa date d&apos;effet, sauf accord écrit de la centrale ; la centrale qui la refuse peut résilier sans frais ({sec(3)}).</>,
            <>Un paiement déclaré avec « J&apos;ai payé » n&apos;est pris en compte qu&apos;une fois confirmé par l&apos;éditeur, pour le montant réellement reçu.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="5. Résilier le contrat">
        <LegalList
          items={[
            <>Chaque partie peut mettre fin au contrat par écrit ; sans abonnement en cours, avec un préavis de 30 jours ({art(7)}).</>,
            <>Avec un abonnement en cours, arrêtez son renouvellement depuis le tableau de bord : il prend fin à la fin de la période payée ({art(4)}).</>,
            <>Refus d&apos;une hausse des frais ou d&apos;une modification défavorable des CGV : résiliation sans frais ni préavis, avec remboursement au prorata ({sec(3)}).</>,
            <>Manquement grave (impayé persistant, fraude, usage illicite, atteinte à la sécurité du service) : l&apos;éditeur peut suspendre le compte après une mise en demeure restée sans effet pendant 8 jours, ou immédiatement en cas d&apos;urgence, puis résilier le contrat. Une centrale suspendue garde l&apos;accès à ses informations de paiement et peut déclarer un paiement ({art(7)}).</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="6. Fin du contrat et données">
        <LegalList
          items={[
            <>Avant la fin du contrat, la centrale peut demander par écrit l&apos;export de ses données (courses et coordonnées des clients, chauffeurs, véhicules, règlements) au format CSV ; le relevé des frais plateforme s&apos;exporte directement depuis le tableau de bord ({art(8)}).</>,
            <>À la fin du contrat, le compte est fermé (archivé) : plus aucun accès au tableau de bord, à l&apos;application chauffeur, au mini-site ni à l&apos;API.</>,
            <>Dans les 30 jours qui suivent, l&apos;éditeur supprime les données qu&apos;il traitait pour le compte de la centrale, sauf obligation légale de conservation. Il garde ses propres données, sans donnée des chauffeurs ni des clients : la fiche archivée de la centrale, son abonnement et ses factures, le registre des frais plateforme et les paiements, et la preuve d&apos;acceptation des conditions ({art(8)}).</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="7. Retard de paiement">
        <p>
          Toute somme impayée à l&apos;échéance porte de plein droit des pénalités de retard au taux de la Banque centrale
          européenne majoré de 10 points, ainsi qu&apos;une indemnité forfaitaire pour frais de recouvrement de 40 €
          ({art(6)} ; article L441-10 du Code de commerce).
        </p>
      </LegalSection>

      <LegalSection title="8. Courses des clients des centrales">
        <p>
          Rydar Drive n&apos;encaisse pas le prix des courses. L&apos;annulation d&apos;une course et son éventuel
          remboursement relèvent de la centrale qui l&apos;organise, selon ses propres conditions : le client
          s&apos;adresse à elle (<Link href="/cgu#article-5" className={link}>CGU, article 5</Link>).
        </p>
      </LegalSection>

      <LegalSection title="9. Contact">
        <p>
          Questions sur l&apos;abonnement, demande de résiliation ou de remboursement : {contact.noun}. Voir aussi les{" "}
          <Link href="/cgv" className={link}>conditions générales de vente</Link> et l&apos;
          <Link href="/dpa" className={link}>accord de traitement des données</Link>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
