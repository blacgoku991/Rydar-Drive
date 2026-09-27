import type { Metadata } from "next";
import Link from "next/link";
import { LegalList, LegalPage, LegalSection } from "@/components/legal/legal-page";
import { LEGAL_UPDATED_AT, LEGAL_VERSION, getLegalInfo } from "@/lib/legal";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Conditions générales de vente — Rydar Drive" },
  description:
    "Conditions de vente du logiciel Rydar Drive aux centrales et flottes de VTC : offres, abonnement, frais plateforme, paiement, résiliation et responsabilités.",
};

export default async function TermsOfSalePage() {
  const legal = await getLegalInfo();
  const contact = legal.email ? (
    <a href={`mailto:${legal.email}`} className="text-fg underline underline-offset-2">{legal.email}</a>
  ) : (
    "l'adresse indiquée dans les mentions légales"
  );
  const link = "text-fg underline underline-offset-2";
  return (
    <LegalPage title="Conditions générales de vente" updatedAt={LEGAL_UPDATED_AT}>
      <p>
        Les présentes conditions générales de vente (CGV) s&apos;appliquent entre <span className="text-fg">{legal.name}</span>{" "}
        (l&apos;« éditeur ») et toute entreprise cliente qui utilise Rydar Drive pour organiser ses courses : centrale de
        réservation, exploitant de VTC ou flotte (la « centrale »). Elles sont réservées aux professionnels. Version{" "}
        {LEGAL_VERSION}.
      </p>

      <LegalSection title="1. Rôle de Rydar Drive">
        <p className="text-fg">
          Rydar Drive est un logiciel de dispatch fourni en ligne. Les courses ne lui appartiennent pas : elles
          appartiennent à la centrale.
        </p>
        <LegalList
          items={[
            <>L&apos;éditeur est un éditeur de logiciel. Il n&apos;est ni transporteur, ni exploitant de VTC, ni centrale de réservation, ni intermédiaire, ni mandataire de la centrale, de ses chauffeurs ou de ses clients.</>,
            <>Les courses, les clients, les prix, les contrats de transport, les conditions de réservation et d&apos;annulation et les chauffeurs appartiennent à la centrale, qui les organise sous sa seule responsabilité.</>,
            <>L&apos;éditeur n&apos;encaisse pas le prix des courses et ne détient aucun fonds pour le compte de la centrale ou des chauffeurs. Le suivi des règlements chauffeurs dans le logiciel est un outil de gestion, pas un service de paiement.</>,
            <>L&apos;éditeur n&apos;emploie pas les chauffeurs, ne les sélectionne pas et ne les dirige pas. La centrale paramètre seule le logiciel : chauffeurs acceptés, rayons de recherche, prix, commissions, règles d&apos;attribution et de blocage.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="2. Objet et acceptation">
        <p>
          Les CGV fixent les conditions de fourniture du service : tableau de bord et centre de commande, dispatch
          automatique et manuel, application chauffeur, mini-site de réservation, API, alertes, messagerie, statistiques
          et suivi des encaissements. Elles sont acceptées par le propriétaire ou un administrateur de la centrale dans le
          tableau de bord, avec les <Link href="/cgu" className={link}>CGU</Link> et l&apos;
          <Link href="/dpa" className={link}>accord de traitement des données</Link> ; les membres de son équipe et ses
          chauffeurs acceptent eux-mêmes les CGU et la politique de confidentialité, dans le tableau de bord ou dans
          l&apos;application. Elles prévalent sur les conditions d&apos;achat de la centrale, sauf accord écrit contraire.
        </p>
      </LegalSection>

      <LegalSection title="3. Offres">
        <LegalList
          items={[
            <>Les offres (formules) sont facultatives et créées par l&apos;éditeur. Chacune précise son prix et ses limites (nombre de chauffeurs, de courses, accès à l&apos;API, mini-site, domaine personnalisé…).</>,
            <>Une centrale sans offre n&apos;est soumise à aucune limite ni restriction de fonctionnalité, dans les conditions convenues avec l&apos;éditeur.</>,
            <>Le modèle « centrale à commission » est activé par l&apos;éditeur. Il donne lieu à des frais plateforme par course (article 5), en plus ou à la place d&apos;un abonnement selon les conditions convenues.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="4. Prix et abonnement">
        <LegalList
          items={[
            <>Les prix sont exprimés hors taxes ; la TVA au taux en vigueur s&apos;y ajoute.</>,
            <>L&apos;abonnement est mensuel ou annuel, payable d&apos;avance par les moyens proposés par Stripe, notre prestataire de paiement. Il se renouvelle automatiquement pour la même durée. Les factures sont émises par Stripe et accessibles depuis le tableau de bord.</>,
            <>La centrale peut changer d&apos;offre ou arrêter le renouvellement à tout moment depuis le tableau de bord ; l&apos;arrêt prend effet à la fin de la période payée, sans remboursement de la période en cours.</>,
            <>Un changement de prix est annoncé au moins 30 jours à l&apos;avance et s&apos;applique au renouvellement suivant ; la centrale peut résilier avant.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="5. Frais plateforme (modèle centrale)">
        <LegalList
          items={[
            <>Chaque course <span className="text-fg">terminée</span> porte des frais plateforme : un pourcentage du prix de la course et/ou un montant fixe, fixés par l&apos;éditeur et affichés à la centrale, dans la limite du prix de la course.</>,
            <>Les frais sont dus par la centrale dès la fin de la course, même si elle n&apos;encaisse pas le chauffeur ou le client, et même si elle annule ou conteste la commission due par le chauffeur. Ils sont inscrits dans un relevé qui ne se modifie pas : un changement ultérieur fait l&apos;objet d&apos;une écriture de correction.</>,
            <>Une hausse de frais (prix corrigé à la hausse) s&apos;applique immédiatement. Une baisse (prix corrigé à la baisse après la course) reste en attente et ne s&apos;applique qu&apos;après accord de l&apos;éditeur.</>,
            <>Les frais sont regroupés par cycle, mensuel ou hebdomadaire, dans le fuseau horaire de la centrale. L&apos;échéance est la fin du cycle augmentée du délai de paiement, de 5 jours par défaut.</>,
            <>La centrale paie par les moyens affichés par l&apos;éditeur (virement sur son IBAN, lien de paiement), avec la référence indiquée. Elle déclare son paiement avec « J&apos;ai payé » ; il n&apos;est pris en compte qu&apos;une fois confirmé par l&apos;éditeur, pour le montant réellement reçu. Les paiements soldent d&apos;abord les échéances les plus anciennes.</>,
            <>Le tableau de bord (Encaissements) affiche le solde, les échéances et le relevé détaillé, exportable en CSV.</>,
            <>En cas de retard, l&apos;éditeur relance la centrale dans le tableau de bord et, si ce canal est activé, par WhatsApp au téléphone du propriétaire. Après le nombre de jours de retard convenu, la création de nouvelles courses peut être bloquée jusqu&apos;au paiement ; un paiement déclaré en attente de confirmation suspend ce blocage pendant 7 jours au plus.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="6. Retard de paiement">
        <p>
          Toute somme impayée à l&apos;échéance porte de plein droit, sans rappel préalable, des pénalités de retard au
          taux d&apos;intérêt appliqué par la Banque centrale européenne à sa plus récente opération de refinancement,
          majoré de 10 points, ainsi qu&apos;une indemnité forfaitaire pour frais de recouvrement de 40 € (article L441-10
          du Code de commerce). Si les frais de recouvrement exposés sont supérieurs, une indemnité complémentaire peut
          être demandée sur justificatif.
        </p>
      </LegalSection>

      <LegalSection title="7. Durée, résiliation et suspension">
        <LegalList
          items={[
            <>Le contrat court à compter de l&apos;ouverture du compte, pour une durée indéterminée ou pour la durée de l&apos;abonnement renouvelé.</>,
            <>Chaque partie peut y mettre fin par écrit ; sans abonnement en cours, avec un préavis de 30 jours.</>,
            <>En cas de manquement grave (impayé persistant, fraude, usage illicite, atteinte à la sécurité du service), l&apos;éditeur peut suspendre le compte après une mise en demeure restée sans effet pendant 8 jours, ou immédiatement en cas d&apos;urgence, puis résilier le contrat.</>,
            <>Une centrale suspendue garde l&apos;accès à ses informations de paiement et peut déclarer un paiement.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="8. Fin du contrat et réversibilité">
        <LegalList
          items={[
            <>Export sur demande : avant la fin du contrat, la centrale peut demander par écrit à l&apos;éditeur un export de ses données (courses et coordonnées des clients, chauffeurs, véhicules, règlements) au format CSV. L&apos;éditeur le prépare et le lui transmet par un moyen sécurisé. Le relevé des frais plateforme s&apos;exporte directement depuis le tableau de bord.</>,
            <>À la fin du contrat, le compte de la centrale est fermé (archivé) : plus aucun accès au tableau de bord, à l&apos;application chauffeur, au mini-site ni à l&apos;API.</>,
            <>Dans les 30 jours qui suivent, l&apos;éditeur supprime les données qu&apos;il traitait pour le compte de la centrale, selon sa procédure interne documentée : comptes des chauffeurs et candidats (avec leurs justificatifs et leurs fichiers), courses et coordonnées des clients, messages et signalements, positions, mini-site, comptes de l&apos;équipe et journal de leurs actions, sauf obligation légale de conservation.</>,
            <>L&apos;éditeur conserve ses propres données, sans donnée des chauffeurs ni des clients : la fiche de la centrale, son abonnement et ses factures, le registre des frais plateforme et les paiements (obligations comptables, 10 ans au moins), et la preuve d&apos;acceptation des présentes conditions avec l&apos;e-mail de la personne qui les a acceptées (preuve du contrat). La fiche de la centrale n&apos;est donc pas supprimée : elle reste archivée.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="9. Niveau de service">
        <p>
          L&apos;éditeur s&apos;efforce d&apos;assurer la disponibilité du service 24 h / 24 et 7 j / 7, hors
          maintenances, annoncées dans la mesure du possible et réalisées de préférence aux heures creuses. Il corrige
          les anomalies bloquantes dans les meilleurs délais. Le support est assuré par e-mail ({contact}) aux jours et
          heures ouvrés. Il s&apos;agit d&apos;une obligation de moyens.
        </p>
      </LegalSection>

      <LegalSection title="10. Obligations de la centrale">
        <LegalList
          items={[
            <>respecter la réglementation du transport de personnes : inscription au registre des exploitants de VTC, cartes professionnelles, véhicules et assurances de ses chauffeurs, réservation préalable, et, lorsqu&apos;elle met en relation clients et chauffeurs, la déclaration et les obligations des centrales de réservation (Code des transports, articles L3120-1 et suivants, L3122-1 et suivants, L3142-1 et suivants) ;</>,
            <>informer ses clients (identité de l&apos;exploitant, prix, conditions, traitement de leurs données) et ses chauffeurs (géolocalisation, notifications, conditions de travail, règles de commission et de blocage qu&apos;elle paramètre) ;</>,
            <>informer son équipe et ses chauffeurs des <Link href="/cgu" className={link}>CGU</Link> et de la <Link href="/confidentialite" className={link}>politique de confidentialité</Link>, que le service leur présente pour acceptation (tableau de bord, application), et de leurs mises à jour ;</>,
            <>recueillir l&apos;accord de ses chauffeurs avant de leur envoyer des relances par WhatsApp et utiliser pour cela son propre compte WhatsApp Business ;</>,
            <>fixer et appliquer seule ses prix, commissions et conditions, et vérifier les documents de ses chauffeurs ;</>,
            <>garder confidentiels ses accès et clés d&apos;API, et n&apos;enregistrer que des données nécessaires (aucune donnée de santé ou sensible dans les commentaires) ;</>,
            <>payer le prix et les frais plateforme aux échéances.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="11. Garantie de la centrale">
        <p>
          La centrale garantit l&apos;éditeur contre toute réclamation, action ou sanction d&apos;un client, d&apos;un
          chauffeur, d&apos;un tiers ou d&apos;une autorité liée aux courses qu&apos;elle organise, à ses relations avec
          ses chauffeurs et ses clients, au non-respect de la réglementation du transport ou à un contenu qu&apos;elle
          publie. Elle prend en charge les condamnations, indemnités et frais de défense raisonnables qui en résultent.
        </p>
      </LegalSection>

      <LegalSection title="12. Responsabilité">
        <p>
          L&apos;éditeur répond des dommages directs causés par un manquement prouvé à ses obligations. Il ne répond pas
          des dommages indirects (perte de chiffre d&apos;affaires, de clientèle ou de données due à la centrale), ni de
          l&apos;exécution des courses. Sa responsabilité totale, tous faits confondus, est limitée aux sommes payées par
          la centrale au titre du contrat pendant les 12 mois précédant le fait générateur. Ces limites ne
          s&apos;appliquent pas en cas de faute lourde ou dolosive, ni aux dommages corporels.
        </p>
      </LegalSection>

      <LegalSection title="13. Données personnelles et confidentialité">
        <p>
          L&apos;<Link href="/dpa" className={link}>accord de traitement des données</Link> (article 28 du RGPD) fait
          partie intégrante des présentes CGV. Chaque partie garde confidentielles les informations non publiques de
          l&apos;autre (données, prix convenus, sécurité) pendant le contrat et 5 ans après.
        </p>
      </LegalSection>

      <LegalSection title="14. Propriété intellectuelle">
        <p>
          L&apos;éditeur concède à la centrale, pour la durée du contrat, un droit d&apos;utilisation non exclusif et
          non transférable du service pour ses besoins propres. Le logiciel reste sa propriété. Les données de la centrale
          restent les siennes ; l&apos;éditeur peut utiliser des statistiques anonymes et agrégées pour améliorer le
          service.
        </p>
      </LegalSection>

      <LegalSection title="15. Force majeure">
        <p>
          Aucune partie n&apos;est responsable d&apos;un manquement dû à un cas de force majeure au sens de l&apos;article
          1218 du Code civil (notamment panne généralisée d&apos;un hébergeur, des réseaux ou des services de
          notification). Si l&apos;empêchement dure plus de 30 jours, chaque partie peut résilier le contrat par écrit.
        </p>
      </LegalSection>

      <LegalSection title="16. Modification des CGV">
        <p>
          L&apos;éditeur peut modifier les CGV. La nouvelle version est présentée dans le tableau de bord au
          propriétaire et aux administrateurs, qui l&apos;acceptent ; une modification défavorable est annoncée au moins
          30 jours à l&apos;avance et la centrale peut résilier avant son entrée en vigueur.
        </p>
      </LegalSection>

      <LegalSection title="17. Droit applicable et juridiction">
        <p>
          Les CGV sont soumises au droit français. Les parties recherchent d&apos;abord une solution amiable (écrire à{" "}
          {contact}). À défaut, tout litige relève de la compétence exclusive du tribunal de commerce du ressort du siège
          de l&apos;éditeur, y compris en cas de référé ou de pluralité de défendeurs.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
