import { ORG_LEGAL_CHANGES, legalDateLabel } from "@rydar/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { LegalList, LegalPage, LegalSection } from "@/components/legal/legal-page";
import { fr } from "@/components/marketing/typo";
import { CGV_UPDATED_AT, ORG_LEGAL_EFFECTIVE_AT, ORG_LEGAL_VERSION, getLegalInfo } from "@/lib/legal";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Conditions générales de vente — Rydar Drive" },
  description:
    "Conditions de vente du logiciel Rydar Drive aux centrales et flottes de VTC : offres, abonnement, frais plateforme par course, paiement, résiliation et responsabilités.",
};

/** Version précédente des CGV, gardée consultable (page figée app/cgv/2026-09-27, servie aussi sur les mini-sites). */
const PREVIOUS_VERSION = { href: "/cgv/2026-09-27", label: "27 septembre 2026" };

// L'article 5 décrit exactement le code (le modifier avec lui) : registre, paiements et blocage (migrations
// 20260924003000, 20260924004400 private.platform_position), frais des flottes et taux figés à la fin de course
// (20260924006400), hausse annoncée 30 jours à l'avance par un e-mail parti à temps ou sur accord écrit, e-mails, délai
// de 45 jours au plus, baisse acceptée sans décision sous 30 jours (20260924006600). « Principaux changements » :
// ORG_LEGAL_CHANGES (@rydar/shared), même liste que le bandeau et l'e-mail d'annonce.
export default async function TermsOfSalePage() {
  const legal = await getLegalInfo();
  const contact = legal.email ? (
    <a href={`mailto:${legal.email}`} className="text-fg underline underline-offset-2">{legal.email}</a>
  ) : (
    "l'adresse indiquée dans les mentions légales"
  );
  const link = "text-fg underline underline-offset-2";
  const effectiveAt = legalDateLabel(ORG_LEGAL_EFFECTIVE_AT);
  return (
    <LegalPage title="Conditions générales de vente" updatedAt={CGV_UPDATED_AT}>
      <p>
        Les présentes conditions générales de vente (CGV) s&apos;appliquent entre {legal.nameSet ? (
          <span className="text-fg">{legal.name}</span>
        ) : (
          // Raison sociale pas encore renseignée : jamais le nom commercial comme partie au contrat
          <>
            la société identifiée dans les <Link href="/mentions-legales" className={link}>mentions légales</Link>
          </>
        )}{" "}
        (l&apos;« éditeur ») et toute entreprise cliente qui utilise Rydar Drive pour organiser ses courses : centrale de
        réservation, exploitant de VTC ou flotte (la « centrale »), quel que soit son modèle d&apos;exploitation (article 3).
        Elles sont réservées aux professionnels. Version {ORG_LEGAL_VERSION}.
      </p>
      <div id="changements" className="space-y-2">
        <p className="text-fg">Principaux changements par rapport à la version du {PREVIOUS_VERSION.label} :</p>
        <LegalList items={ORG_LEGAL_CHANGES.map((c) => fr(c))} />
        <p>
          Pour une centrale déjà cliente avant la mise en ligne de la présente version, celle-ci s&apos;applique dès son
          acceptation dans le tableau de bord, et au plus tard le {effectiveAt} ; tant qu&apos;elle ne l&apos;a pas acceptée,
          aucune hausse de frais par course ne lui est appliquée avant cette date sans son accord écrit, et elle peut résilier
          le contrat sans frais ni préavis avant cette date, avec remboursement au prorata de l&apos;abonnement payé
          d&apos;avance (article 7).{" "}
          <Link href={PREVIOUS_VERSION.href} className={link}>
            Version précédente ({PREVIOUS_VERSION.label})
          </Link>
        </p>
      </div>

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
            <>L&apos;éditeur n&apos;emploie pas les chauffeurs et ne les dirige pas. Il n&apos;intervient dans l&apos;accès d&apos;un chauffeur au service que pour la sécurité de la plateforme et la lutte contre la fraude : interdiction sur toute la plateforme après une fraude constatée, sur signalement d&apos;une centrale (article 10 bis).</>,
            <>La centrale paramètre seule le logiciel : chauffeurs acceptés, rayons et délais de recherche, prix, commissions, règles d&apos;attribution et de blocage. Les réglages proposés à l&apos;ouverture du compte, dont le blocage d&apos;un chauffeur en retard de règlement, sont des valeurs de départ qu&apos;elle peut modifier à tout moment ; en les conservant, elle les fait siens. Rien dans le logiciel n&apos;oblige un chauffeur à accepter une course, et le logiciel n&apos;applique aucune sanction automatique à un refus ou à une absence de réponse ; les obligations éventuelles du chauffeur envers la centrale relèvent de leur seul contrat.</>,
            <>Pour les contenus que la centrale, son équipe ou ses chauffeurs saisissent ou publient (mini-site, conditions, images, messages, documents), l&apos;éditeur agit comme hébergeur au sens de l&apos;article 6 de la loi n° 2004-575 du 21 juin 2004 et du règlement (UE) 2022/2065 sur les services numériques : il ne les contrôle pas a priori et peut retirer ou rendre inaccessible un contenu manifestement illicite ou qui lui est signalé comme tel, en indiquant ses motifs à la centrale.</>,
            <>Sur le mini-site de réservation, la centrale est le professionnel qui vend le transport : elle fournit ses conditions de vente et d&apos;annulation, ses mentions légales, les coordonnées de son médiateur de la consommation et les informations précontractuelles, dont elle est seule responsable.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="2. Objet et acceptation">
        <p>
          Les CGV fixent les conditions de fourniture du service : tableau de bord et centre de commande, dispatch
          automatique et manuel, application chauffeur, mini-site de réservation (lorsque l&apos;éditeur le propose), API, alertes, messagerie, statistiques
          et suivi des encaissements. Elles sont acceptées par le propriétaire ou un administrateur de la centrale dans le
          tableau de bord, avec les <Link href="/cgu" className={link}>CGU</Link> et l&apos;
          <Link href="/dpa" className={link}>accord de traitement des données</Link> ; les membres de son équipe et ses
          chauffeurs acceptent eux-mêmes les CGU et la politique de confidentialité, dans le tableau de bord ou dans
          l&apos;application. Elles prévalent sur les conditions d&apos;achat de la centrale, sauf accord écrit contraire.
        </p>
      </LegalSection>

      <LegalSection title="3. Offres et modèles d'exploitation">
        <LegalList
          items={[
            <>Les offres (formules) sont facultatives et créées par l&apos;éditeur. Chacune précise son prix et ses limites (nombre de chauffeurs, de courses, accès à l&apos;API, mini-site, domaine personnalisé…).</>,
            <>Une centrale sans offre n&apos;est soumise à aucune limite ni restriction de fonctionnalité, dans les conditions convenues avec l&apos;éditeur.</>,
            <>L&apos;éditeur active pour chaque centrale, selon ce qui est convenu avec elle, l&apos;un des deux modèles d&apos;exploitation : « flotte » (la centrale organise avec le logiciel ses courses et ses chauffeurs, sans répartition du prix) ou « centrale à commission » (le logiciel calcule en plus, pour chaque course, la part du chauffeur et la commission de la centrale, et suit leur règlement). Il ne change de modèle qu&apos;à la demande de la centrale ou avec son accord écrit.</>,
            <>Les deux modèles peuvent donner lieu à des frais plateforme par course terminée (article 5), en plus ou à la place d&apos;un abonnement, selon les conditions convenues avec l&apos;éditeur.</>,
            <>Le réseau partagé est une option du logiciel, régie par une convention distincte acceptée par les seules organisations qui l&apos;activent.</>,
            <>Le mini-site de réservation est fourni dans l&apos;état décrit par sa déclaration d&apos;accessibilité (page Accessibilité). La centrale soumise aux obligations d&apos;accessibilité des services de commerce électronique en reste responsable envers ses clients ; l&apos;éditeur lui communique, sur demande, l&apos;état de conformité du mini-site.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="4. Prix et abonnement">
        <LegalList
          items={[
            <>Le prix de l&apos;abonnement est exprimé hors taxes ; la TVA au taux en vigueur s&apos;y ajoute.</>,
            <>L&apos;abonnement est mensuel ou annuel, payable d&apos;avance par les moyens proposés par Stripe, le prestataire de paiement de l&apos;éditeur. Son montant hors taxes est celui affiché dans l&apos;offre au moment de la souscription ; la TVA y est ajoutée au paiement. Il se renouvelle automatiquement pour la même durée. Les factures sont émises par Stripe et accessibles depuis le tableau de bord.</>,
            <>L&apos;abonnement peut se cumuler avec des frais plateforme par course terminée, qui se règlent à part, selon l&apos;article 5.</>,
            <>La centrale peut changer d&apos;offre ou arrêter le renouvellement à tout moment depuis le tableau de bord ; l&apos;arrêt prend effet à la fin de la période payée, sans remboursement de la période en cours, sauf résiliation pour refus d&apos;une hausse des frais ou d&apos;une modification défavorable des CGV (article 7).</>,
            <>Un changement du prix de l&apos;abonnement est annoncé au moins 30 jours à l&apos;avance et ne s&apos;applique qu&apos;au renouvellement suivant ; la centrale peut arrêter le renouvellement ou résilier avant.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="5. Frais plateforme">
        <LegalList
          items={[
            <>Les frais plateforme rémunèrent l&apos;usage du logiciel par la centrale. Leur calcul en pourcentage du prix d&apos;une course n&apos;est qu&apos;une façon de les mesurer : l&apos;éditeur ne fixe pas ce prix, ne l&apos;encaisse pas, n&apos;est pas payé par le client et n&apos;est pas partie au contrat de transport. Ils sont dus à l&apos;éditeur par la centrale seule : ni ses chauffeurs ni ses clients ne sont débiteurs de l&apos;éditeur.</>,
            <>Dans les deux modèles d&apos;exploitation, chaque course <span className="text-fg">terminée</span> peut porter des frais plateforme dus à l&apos;éditeur : un pourcentage du prix de la course, un montant fixe par course, ou les deux. Les taux de chaque centrale sont ceux convenus avec elle et affichés dans son tableau de bord ; ils ne changent ensuite que selon le présent article. Une course annulée ne porte aucuns frais.</>,
            <>Les frais sont exprimés toutes taxes comprises : les montants calculés et affichés (frais de chaque course, solde, échéances) sont ceux à payer, TVA éventuelle incluse ; aucune taxe ne s&apos;y ajoute (en cas de retard, les pénalités et l&apos;indemnité de l&apos;article 6 restent dues).</>,
            <>Modèle flotte : les frais sont le pourcentage du prix de la course plus le montant fixe, sans plafond. Une course sans prix porte le seul montant fixe ; la part en pourcentage s&apos;y ajoute si un prix est saisi ensuite.</>,
            <>Modèle centrale à commission : les frais sont calculés sur le prix de la course et déduits, dans la répartition faite par le logiciel, avant la part du chauffeur et la commission ; ils ne dépassent jamais ce prix. Une course sans prix ne porte aucuns frais tant que son prix n&apos;est pas saisi. L&apos;éditeur ne retient rien sur le prix payé par le client : la centrale lui règle les frais selon le présent article. La centrale fixe sa commission en connaissant cette déduction et informe ses chauffeurs de la façon dont leur part est calculée.</>,
            <>Taux appliqués à une course : en modèle flotte, ceux en vigueur à la fin de la course, qui restent les siens même si son prix est corrigé ensuite ; en modèle centrale à commission, ceux en vigueur au moment où la répartition du prix est calculée, c&apos;est-à-dire à la création de la course si son prix est connu, puis à chaque saisie ou modification de son prix, de la commission ou du mode de paiement, y compris après la course (la différence est alors inscrite en correction), et, pour les courses en cours, au passage au modèle centrale à commission.</>,
            <>Le modèle retenu pour une course est celui de la centrale à la fin de la course. Si le modèle change ensuite : une course terminée en modèle flotte suit encore la règle de ce modèle, sauf si, corrigée après le passage au modèle centrale à commission, elle reçoit un règlement chauffeur (elle suit alors la règle de ce modèle, par correction) ; une course terminée en modèle centrale à commission garde ses frais, même si elle est corrigée après le retour au modèle flotte.</>,
            <>Changement des taux : les taux fixés à l&apos;ouverture du compte s&apos;appliquent dès l&apos;ouverture et sont communiqués par e-mail au propriétaire ; ensuite, une baisse s&apos;applique dès son enregistrement. Une hausse (augmentation du pourcentage ou du montant fixe, même si l&apos;autre baisse, ou mise en place de frais pour une centrale qui n&apos;en avait pas) est annoncée au propriétaire par e-mail (à défaut, à l&apos;adresse de la centrale) et dans le tableau de bord au moins 30 jours avant sa date d&apos;effet, ou s&apos;applique dès son enregistrement si la centrale en a donné son accord écrit. Une hausse dont l&apos;e-mail d&apos;annonce n&apos;est pas parti au moins 30 jours avant sa date d&apos;effet ne s&apos;applique pas. Une hausse annoncée peut être annulée, réduite ou reportée sans nouveau délai ; toute autre modification est une nouvelle hausse.</>,
            <>La centrale qui refuse une hausse annoncée peut résilier le contrat par écrit avant sa date d&apos;effet, sans frais et sans préavis, dans les conditions de l&apos;article 7 (remboursement au prorata de l&apos;abonnement payé d&apos;avance) ; les frais des courses terminées avant la résiliation restent dus.</>,
            <>Les frais sont dus par la centrale à qui appartient la course, y compris lorsque l&apos;option réseau partagé est activée, dès la fin de la course : qu&apos;elle ait encaissé ou non le client ou le chauffeur, et même si elle annule ou conteste la commission due par le chauffeur.</>,
            <>Les frais sont inscrits dans un relevé qui ne se modifie pas et ne se supprime pas : tout changement ultérieur fait l&apos;objet d&apos;une écriture de correction. Une correction à la hausse (prix corrigé à la hausse après la course, par exemple) compte immédiatement ; une correction à la baisse reste en attente de la décision de l&apos;éditeur, qui ne peut la refuser que si elle ne correspond pas à la course réellement effectuée et payée (prix, commission ou mode de paiement), par une décision motivée affichée dans le tableau de bord ; sans décision dans les 30 jours, elle est acceptée. L&apos;éditeur peut aussi y inscrire, avec son motif, un avoir ou la correction d&apos;une erreur de calcul des frais ; aucun autre montant n&apos;y est ajouté sans l&apos;accord écrit de la centrale.</>,
            <>Les frais sont regroupés par cycle, mensuel (par défaut) ou hebdomadaire, dans le fuseau horaire de la centrale. L&apos;échéance est la fin du cycle augmentée du délai de paiement, de 5 jours par défaut et de 45 jours au plus. Une écriture enregistrée après la fin de la course (prix saisi ou corrigé ensuite) suit l&apos;échéance du cycle de son enregistrement. Le cycle, le délai de paiement et, le cas échéant, le seuil de blocage sont affichés dans le tableau de bord ; l&apos;éditeur ne les modifie en défaveur de la centrale qu&apos;avec son accord écrit, et un changement ne modifie pas l&apos;échéance des frais déjà inscrits.</>,
            <>À la fin de chaque cycle, l&apos;éditeur adresse à la centrale une facture récapitulative des frais du cycle, c&apos;est-à-dire des frais pris en compte pendant celui-ci (écritures enregistrées pendant le cycle, baisses acceptées pendant le cycle), qui en indique l&apos;échéance. Le relevé du tableau de bord sert au suivi : ce n&apos;est pas une facture.</>,
            <>La centrale paie par les moyens affichés par l&apos;éditeur (virement sur l&apos;IBAN de l&apos;éditeur, lien de paiement), avec la référence indiquée. Elle déclare son paiement avec « J&apos;ai payé » ; il n&apos;est pris en compte qu&apos;une fois confirmé par l&apos;éditeur, pour le montant réellement reçu. Les paiements soldent d&apos;abord les échéances les plus anciennes.</>,
            <>Le tableau de bord (menu « Encaissements » en modèle centrale à commission, « Frais Rydar » en modèle flotte) affiche les taux, une hausse annoncée et sa date d&apos;effet, le solde, les échéances et le relevé détaillé, exportable en CSV.</>,
            <>En cas de retard, l&apos;éditeur peut relancer la centrale dans son tableau de bord et, en modèle centrale à commission, par WhatsApp au téléphone du propriétaire ou, à défaut, de la centrale, sauf si le propriétaire a refusé ce canal (article 10).</>,
            <>Si un seuil de blocage est fixé pour la centrale (nombre de jours de retard), la création de nouvelles courses, ainsi que la relance ou l&apos;attribution d&apos;une course sans chauffeur, est suspendue lorsqu&apos;une somme échue reste impayée au-delà de ce délai, jusqu&apos;à son paiement, confirmé par l&apos;éditeur. Un paiement déclaré qui couvre la somme échue suspend ce blocage pendant 7 jours au plus, comptés depuis la première déclaration de paiement des 30 derniers jours, sauf dans les 7 jours qui suivent un paiement déclaré que l&apos;éditeur a marqué « non reçu ».</>,
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
            <>Chaque partie peut y mettre fin par écrit, sans motif ; sans abonnement en cours, avec un préavis de 30 jours. Pour l&apos;éditeur, ce préavis est porté à 3 mois lorsque la relation dure depuis plus de 2 ans ; s&apos;il met fin au contrat sans faute de la centrale alors qu&apos;un abonnement est en cours, la part payée d&apos;avance pour la période restant à courir est remboursée au prorata. Les frais des courses terminées restent dus.</>,
            <>La centrale qui refuse une hausse des frais (article 5) ou une modification défavorable des CGV (article 16) peut résilier le contrat sans frais et sans préavis avant sa date d&apos;effet ou son entrée en vigueur : la résiliation prend effet à la date qu&apos;elle choisit, au plus tard la veille de cette date, et la part de l&apos;abonnement payée d&apos;avance pour la période restant à courir lui est remboursée au prorata.</>,
            <>En cas de manquement grave (impayé persistant, fraude, usage illicite, atteinte à la sécurité du service), l&apos;éditeur peut suspendre le compte après une mise en demeure restée sans effet pendant 8 jours, ou immédiatement en cas d&apos;urgence, puis résilier le contrat. Il peut aussi le suspendre à la demande écrite de la centrale. Le fondement et le motif de la suspension sont affichés au propriétaire et aux administrateurs.</>,
            <>Pendant une suspension, les offres en cours sont fermées, les chauffeurs passent hors ligne et aucune course ne peut être créée ni attribuée. Les courses à venir déjà attribuées ne peuvent pas être servies : la centrale en informe ses clients et reste seule responsable envers eux. L&apos;éditeur ne suspend pas un compte pendant qu&apos;un chauffeur est en route ou qu&apos;un client est à bord.</>,
            <>Une centrale suspendue garde l&apos;accès à ses informations de paiement et peut déclarer un paiement.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="8. Fin du contrat et réversibilité">
        <LegalList
          items={[
            <>Export sur demande : avant la fin du contrat, la centrale peut demander par écrit à l&apos;éditeur un export de ses données (courses et coordonnées des clients, chauffeurs, véhicules, règlements) au format CSV. L&apos;éditeur le prépare et le lui transmet par un moyen sécurisé. Le relevé des frais plateforme s&apos;exporte directement depuis le tableau de bord.</>,
            <>À la fin du contrat, le compte de la centrale est fermé (archivé) : plus aucun accès au tableau de bord, à l&apos;application chauffeur, au mini-site ni à l&apos;API.</>,
            <>Dans les 30 jours qui suivent, l&apos;éditeur supprime les données qu&apos;il traitait pour le compte de la centrale : comptes des chauffeurs et candidats (avec leurs justificatifs et leurs fichiers), courses et coordonnées des clients, messages et signalements, positions, mini-site, comptes de l&apos;équipe et journal de leurs actions, sauf obligation légale de conservation.</>,
            <>L&apos;éditeur conserve ses propres données, sans donnée des chauffeurs ni des clients : la fiche de la centrale, son abonnement et ses factures, le registre des frais plateforme et les paiements, avec le journal des actions qui s&apos;y rapportent (obligations comptables, 10 ans au moins), et la preuve d&apos;acceptation des présentes conditions avec l&apos;e-mail de la personne qui les a acceptées (preuve du contrat). La fiche de la centrale n&apos;est donc pas supprimée : elle reste archivée.</>,
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

      <LegalSection title="9 bis. Évolution du service">
        <LegalList
          items={[
            <>L&apos;éditeur fait évoluer le service. Il peut modifier ou remplacer une fonctionnalité sans réduire de façon importante les fonctions essentielles : dispatch, application chauffeur, suivi des courses.</>,
            <>Il peut suspendre pour toutes les centrales une fonctionnalité facultative (mini-site de réservation, domaine personnalisé, réseau partagé, relances WhatsApp, API, suivi des vols, fournisseur de cartes, d&apos;adresses ou d&apos;itinéraires) pour un motif de sécurité, de conformité légale ou de dépendance à un service tiers ; il l&apos;indique sur la page Tarifs ou dans le tableau de bord. Il peut limiter raisonnablement l&apos;usage des services de cartes et de l&apos;API pour préserver le service.</>,
            <>Si une fonctionnalité comprise dans l&apos;offre souscrite est suspendue ou supprimée, la centrale peut, pendant la suspension, changer d&apos;offre ou résilier sans frais ; la part de l&apos;abonnement payée d&apos;avance pour la période restant à courir lui est alors remboursée au prorata. Aucune autre indemnité n&apos;est due.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="10. Obligations de la centrale">
        <LegalList
          items={[
            <>respecter la réglementation du transport de personnes : inscription au registre des exploitants de VTC, cartes professionnelles, véhicules et assurances de ses chauffeurs, réservation préalable, et, lorsqu&apos;elle met en relation clients et chauffeurs, la déclaration et les obligations des centrales de réservation (Code des transports, articles L3120-1 et suivants, L3122-1 et suivants, L3142-1 et suivants) ;</>,
            <>informer ses clients (identité de l&apos;exploitant, prix, conditions, traitement de leurs données) et ses chauffeurs (géolocalisation, notifications, conditions de travail, règles de commission et de blocage qu&apos;elle paramètre, transmission possible d&apos;un signalement de fraude à l&apos;éditeur) ;</>,
            <>lorsque ses chauffeurs sont salariés, informer et consulter le comité social et économique avant d&apos;utiliser la géolocalisation, ne pas l&apos;utiliser en dehors du temps de travail ni pour contrôler la vitesse, et laisser le chauffeur la couper pendant ses pauses (passage hors ligne ou fermeture de l&apos;application) ; dans tous les cas, réaliser l&apos;analyse d&apos;impact de ses traitements lorsqu&apos;elle est requise, notamment pour la géolocalisation de ses chauffeurs ;</>,
            <>informer son équipe et ses chauffeurs des <Link href="/cgu" className={link}>CGU</Link> et de la <Link href="/confidentialite" className={link}>politique de confidentialité</Link>, que le service leur présente pour acceptation (tableau de bord, application), et de leurs mises à jour ;</>,
            <>recueillir l&apos;accord de ses chauffeurs exigé par les règles de WhatsApp avant de leur envoyer des relances par ce canal, respecter leur opposition (en faisant alors partir ses relances par l&apos;application seule) et utiliser pour cela son propre compte WhatsApp Business ;</>,
            <>fixer et appliquer seule ses prix, commissions et conditions, et vérifier les documents de ses chauffeurs ;</>,
            <>garder confidentiels ses accès et clés d&apos;API, et n&apos;enregistrer que des données nécessaires (aucune donnée de santé ou sensible dans les commentaires) ;</>,
            <>utiliser l&apos;API et les webhooks sous sa responsabilité : les données de course qu&apos;elle fait envoyer aux adresses qu&apos;elle déclare (notamment adresses, horaires, prix, numéro de vol, prénom et véhicule du chauffeur) sont transmises sur son instruction et sont, dès leur réception par son système, sous sa seule responsabilité ; l&apos;éditeur peut limiter le nombre de requêtes et suspendre une clé ou un webhook utilisé de façon abusive ou compromise ;</>,
            <>tenir à jour l&apos;adresse e-mail et le téléphone de son propriétaire et de la centrale, auxquels l&apos;éditeur adresse ses annonces et ses relances ;</>,
            <>en renseignant le téléphone de son propriétaire et de la centrale, accepter que l&apos;éditeur y envoie par WhatsApp des messages de service sur ses frais plateforme (échéances, relances), à l&apos;exclusion de toute prospection ; le propriétaire peut s&apos;y opposer à tout moment en écrivant à l&apos;éditeur, qui le note : les relances restent alors affichées dans le tableau de bord ;</>,
            <>payer l&apos;abonnement et les frais plateforme aux échéances.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="10 bis. Signalements et interdiction sur la plateforme">
        <LegalList
          items={[
            <>La centrale peut bannir un chauffeur de son propre compte, pour le motif qu&apos;elle consigne. Elle peut signaler à l&apos;éditeur une fraude constatée ou un document faux ou falsifié ; une dette, un comportement ou un différend reste propre à la centrale et n&apos;est jamais communiqué aux autres centrales.</>,
            <>La centrale garantit que son signalement est exact, fondé sur des faits vérifiables et proportionné, qu&apos;elle a informé la personne concernée de la transmission de ses données à l&apos;éditeur et qu&apos;elle conserve les justificatifs, qu&apos;elle communique à l&apos;éditeur sur demande.</>,
            <>L&apos;éditeur examine le signalement au vu des éléments transmis, sans être tenu d&apos;enquêter, et décide seul d&apos;une interdiction sur toute la plateforme. Il en informe la personne concernée par e-mail, avec ses motifs et ses voies de recours.</>,
            <>L&apos;interdiction ne s&apos;étend à la fiche d&apos;une autre centrale qui partage un identifiant que si l&apos;éditeur l&apos;a confirmée pour cette fiche. Le motif « Banni de la plateforme Rydar » apparaît alors sur la fiche, et les courses à venir de ce chauffeur sont remises à attribuer.</>,
            <>Une interdiction décidée de bonne foi n&apos;ouvre droit à aucune indemnité. La centrale qui signale garantit l&apos;éditeur (article 11) contre les conséquences d&apos;un signalement inexact ou abusif.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="11. Garantie de la centrale">
        <p>
          La centrale garantit l&apos;éditeur contre toute réclamation, action, contrôle, redressement ou sanction
          d&apos;un client, d&apos;un passager, d&apos;un chauffeur ou candidat, d&apos;un membre de son équipe, d&apos;une autre centrale,
          d&apos;un tiers ou d&apos;une autorité (notamment administration des transports, URSSAF, administration fiscale,
          inspection du travail, CNIL) lorsqu&apos;ils sont liés :
        </p>
        <LegalList
          items={[
            <>aux courses qu&apos;elle organise et à leurs prix ;</>,
            <>à ses relations avec ses chauffeurs, y compris une demande de requalification en contrat de travail ou de reconnaissance d&apos;une responsabilité de plateforme (articles L7341-1 et suivants du Code du travail) dirigée contre l&apos;éditeur ;</>,
            <>au non-respect de la réglementation des transports, fiscale ou sociale qui lui incombe ;</>,
            <>au non-respect de ses obligations de responsable de traitement (base légale, information et droits des personnes, données saisies par son équipe, instructions données à l&apos;éditeur), sauf si le dommage résulte d&apos;un manquement de l&apos;éditeur à l&apos;accord de traitement des données ;</>,
            <>aux messages qu&apos;elle fait envoyer (WhatsApp, notifications, e-mails, webhooks, API) ;</>,
            <>à un signalement qu&apos;elle adresse à l&apos;éditeur ou à un contenu qu&apos;elle publie.</>,
          ]}
        />
        <p>
          Elle prend en charge les condamnations civiles, les indemnités, les sanctions administratives dans la mesure où
          la loi le permet, les transactions qu&apos;elle a acceptées et les frais de défense raisonnables, honoraires
          d&apos;avocat compris. L&apos;éditeur l&apos;informe de la réclamation dans un délai raisonnable et lui permet de présenter
          ses observations. La garantie ne couvre pas la part du dommage qui résulte d&apos;un manquement de l&apos;éditeur à ses
          propres obligations.
        </p>
      </LegalSection>

      <LegalSection title="12. Responsabilité">
        <p>
          L&apos;éditeur est tenu d&apos;une obligation de moyens. Il ne répond que des dommages directs et prévisibles causés
          par un manquement prouvé à ses obligations. Il ne répond pas :
        </p>
        <LegalList
          items={[
            <>de l&apos;exécution des courses et de leurs suites (retard, absence de chauffeur, accident, litige avec un client ou un chauffeur) ;</>,
            <>d&apos;une course non attribuée ou attribuée tardivement ;</>,
            <>des décisions et du paramétrage de la centrale (prix, commissions, blocages, attributions, bannissements) ;</>,
            <>de l&apos;exactitude des données saisies par la centrale, ses chauffeurs ou ses clients ;</>,
            <>de l&apos;exactitude ou de la disponibilité des informations issues de services tiers ou de calculs automatiques (positions, distances, durées, itinéraires, adresses, suivi des vols, estimations de prix selon la grille de la centrale), fournies à titre indicatif : la centrale et ses chauffeurs les vérifient ;</>,
            <>d&apos;un retard ou d&apos;une absence de notification, de message WhatsApp ou d&apos;e-mail ;</>,
            <>d&apos;une interruption due aux réseaux, aux magasins d&apos;applications, aux systèmes des téléphones ou à un service tiers ;</>,
            <>des conséquences d&apos;un blocage, d&apos;une suspension ou d&apos;une résiliation appliqués conformément aux présentes CGV.</>,
          ]}
        />
        <p>
          Les alertes du logiciel (chauffeur immobile, GPS muet, retard) sont une aide à l&apos;exploitation, pas un dispositif
          de sécurité ou d&apos;urgence. L&apos;éditeur ne répond pas des dommages indirects, notamment la perte de chiffre
          d&apos;affaires, de bénéfice, de clientèle ou d&apos;image, ni de la perte de données imputable à la centrale. Sa
          responsabilité totale, tous faits générateurs confondus, est limitée au plus élevé des deux montants suivants :
          les sommes hors taxes payées par la centrale au titre du contrat pendant les 12 mois précédant le premier fait
          générateur, ou 1 000 €. Toute action contre l&apos;éditeur se prescrit par un an à compter du jour où la centrale a
          connu ou aurait dû connaître le fait qui la fonde. Ces limites ne s&apos;appliquent pas en cas de faute lourde ou
          dolosive, aux dommages corporels, ni lorsque la loi l&apos;interdit.
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
          30 jours à l&apos;avance et la centrale peut résilier sans frais avant son entrée en vigueur (article 7). À défaut
          d&apos;acceptation dans le tableau de bord, la nouvelle version s&apos;applique à la date d&apos;entrée en vigueur annoncée
          par e-mail au propriétaire et dans le tableau de bord ; poursuivre l&apos;utilisation du service après cette date
          vaut acceptation. Tant qu&apos;une centrale n&apos;a accepté aucune version des CGV, son propriétaire et ses
          administrateurs doivent accepter la version en vigueur avant d&apos;utiliser le tableau de bord. La version
          précédente reste consultable sur le site (lien en tête des présentes).
        </p>
      </LegalSection>

      <LegalSection title="17. Droit applicable et juridiction">
        <p>
          Les CGV sont soumises au droit français. Les parties recherchent d&apos;abord une solution amiable (écrire à{" "}
          {contact}). À défaut, lorsque les deux parties ont la qualité de commerçant, tout litige relève de la
          compétence exclusive de la juridiction commerciale (tribunal de commerce ou tribunal des activités
          économiques) du ressort du siège de l&apos;éditeur, y compris en cas de référé ou de pluralité de défendeurs ;
          sinon, de la juridiction compétente selon le droit commun.
        </p>
      </LegalSection>

      <LegalSection title="18. Dispositions générales">
        <LegalList
          items={[
            <>Les enregistrements du service (acceptations, journaux, relevés, horodatages) font foi entre les parties jusqu&apos;à preuve contraire.</>,
            <>Un e-mail envoyé à l&apos;adresse de l&apos;autre partie (pour la centrale, celle de son propriétaire ou de la centrale ; pour l&apos;éditeur, celle des mentions légales) vaut écrit.</>,
            <>Une clause déclarée nulle est réputée non écrite, sans effet sur les autres.</>,
            <>La centrale accepte dès maintenant que l&apos;éditeur cède le contrat à la société qui reprend le service ; elle en est informée et peut alors résilier sans frais.</>,
            <>Ne pas exercer un droit ne vaut pas renonciation à ce droit.</>,
          ]}
        />
      </LegalSection>
    </LegalPage>
  );
}
