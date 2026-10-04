import type { Metadata } from "next";
import Link from "next/link";
import { legalContact } from "@/components/legal/legal-contact";
import { LegalList, LegalPage, LegalSection } from "@/components/legal/legal-page";
import { LEGAL_UPDATED_AT, LEGAL_VERSION, getLegalInfo } from "@/lib/legal";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Conditions générales d'utilisation — Rydar Drive" },
  description:
    "Conditions d'utilisation du logiciel de dispatch Rydar Drive : tableau de bord des centrales, application chauffeur, mini-sites de réservation et API.",
};

export default async function TermsOfUsePage() {
  const legal = await getLegalInfo();
  const contact = legalContact(legal.email);
  const link = "text-fg underline underline-offset-2";
  return (
    <LegalPage title="Conditions générales d'utilisation" updatedAt={LEGAL_UPDATED_AT}>
      <p>
        Les présentes conditions générales d&apos;utilisation (CGU) encadrent l&apos;utilisation des services Rydar
        Drive, édités par{" "}
        {legal.nameSet ? (
          <span className="text-fg">{legal.name}</span>
        ) : (
          // Raison sociale pas encore renseignée : jamais le nom commercial comme partie au contrat
          <>
            la société identifiée dans les{" "}
            <Link href="/mentions-legales" className={link}>
              mentions légales
            </Link>
          </>
        )}{" "}
        (l&apos;« éditeur ») : le tableau de bord des
        centrales, l&apos;application mobile « Rydar Drive Chauffeur », les mini-sites de réservation et l&apos;API.
        Elles s&apos;appliquent à toute personne qui les utilise. Le chauffeur les accepte dans l&apos;application, avec la
        politique de confidentialité, avant de l&apos;utiliser (à l&apos;inscription par le lien d&apos;une centrale ou à sa
        première connexion) puis à chaque nouvelle version.
        Chaque membre de l&apos;équipe d&apos;une centrale les accepte dans le tableau de bord ; le propriétaire ou un
        administrateur les accepte en outre au nom de la centrale. Version {LEGAL_VERSION}.
      </p>

      <LegalSection title="1. Rôle de Rydar Drive">
        <p className="text-fg">
          Rydar Drive est un logiciel de dispatch. Les courses ne lui appartiennent pas : elles appartiennent à la
          centrale ou à la flotte qui les organise.
        </p>
        <LegalList
          items={[
            <>L&apos;éditeur fournit un outil informatique aux centrales et flottes de VTC : réception des réservations, proposition des courses aux chauffeurs, suivi, statistiques, messagerie.</>,
            <>Il n&apos;est ni transporteur, ni exploitant de VTC, ni centrale de réservation, ni intermédiaire, ni mandataire de la centrale, des chauffeurs ou des clients. Il ne conclut aucun contrat de transport.</>,
            <>Les courses, les clients, les prix, les conditions de réservation et d&apos;annulation, les contrats de transport et les chauffeurs appartiennent à la centrale, qui en est seule responsable.</>,
            <>L&apos;éditeur n&apos;encaisse pas le prix des courses et n&apos;intervient pas dans les paiements entre clients, chauffeurs et centrale. Les montants affichés (prix, commissions, règlements) sont ceux que la centrale a saisis ou paramétrés.</>,
            <>L&apos;éditeur n&apos;emploie pas les chauffeurs, ne les dirige pas et ne fixe ni leurs horaires ni leurs tarifs. Il n&apos;intervient dans l&apos;accès d&apos;un chauffeur au service que pour la sécurité de la plateforme et la lutte contre la fraude (article 11). La centrale paramètre le logiciel : chauffeurs acceptés, zones et rayons de recherche, prix, commissions, règles d&apos;attribution et de blocage.</>,
            <>Le chauffeur exerce son activité pour le compte de sa centrale ou en partenariat avec elle, selon le contrat qu&apos;il a conclu avec elle, auquel l&apos;éditeur n&apos;est pas partie. Ce contrat, et non les présentes CGU, fixe son statut, sa rémunération, les commissions, ses éventuelles obligations de disponibilité et les sanctions. Les présentes CGU se limitent à l&apos;utilisation de l&apos;application, mise gratuitement à la disposition du chauffeur par l&apos;éditeur ; elles ne créent entre l&apos;éditeur et le chauffeur ni contrat de travail, ni lien de subordination, ni mandat, ni société.</>,
            <>L&apos;éditeur ne garantit aucun nombre de courses ni aucun revenu. Les offres sont proposées selon les réglages de la centrale (zones, rayons et délais de recherche, catégories de véhicules, niveaux de confiance, plafonds), à partir de valeurs par défaut qu&apos;elle peut modifier. L&apos;application ne note pas les chauffeurs : un refus ou une offre manquée n&apos;entraîne aucune conséquence décidée par le logiciel, la centrale voyant seulement des statistiques d&apos;activité (taux d&apos;acceptation notamment).</>,
            <>Les informations dues au chauffeur avant l&apos;acceptation d&apos;une course (distance, prix) et son droit de la refuser relèvent de la centrale, qui renseigne ces informations dans le logiciel.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="2. Définitions">
        <LegalList
          items={[
            <><span className="text-fg">Centrale</span> : entreprise (centrale de réservation, exploitant de VTC ou flotte) cliente de l&apos;éditeur, qui utilise Rydar Drive pour organiser ses courses.</>,
            <><span className="text-fg">Utilisateur de la centrale</span> : propriétaire, administrateur ou dispatcher qui accède au tableau de bord.</>,
            <><span className="text-fg">Chauffeur</span> : conducteur inscrit par une centrale (ou candidat via son lien d&apos;inscription) qui utilise l&apos;application.</>,
            <><span className="text-fg">Client</span> : personne qui réserve une course auprès d&apos;une centrale, par son mini-site, par téléphone ou par tout autre moyen.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="3. Accès et comptes">
        <LegalList
          items={[
            <>Les comptes sont créés par la centrale (invitation) ou à partir de son lien d&apos;inscription. Une candidature ouvre l&apos;accès aux courses une fois validée par la centrale, ou dès l&apos;inscription si la centrale a choisi la validation automatique. Il n&apos;existe pas de compte client.</>,
            <>Vous devez être majeur, fournir des informations exactes et les tenir à jour.</>,
            <>Vos identifiants sont personnels et confidentiels. Toute action faite avec votre compte est réputée faite par vous. Prévenez sans délai votre centrale et l&apos;éditeur en cas d&apos;usage frauduleux.</>,
            <>Les clés d&apos;API sont confidentielles : la centrale répond de tout appel fait avec ses clés et les révoque dans son tableau de bord en cas de fuite.</>,
            <>Un compte peut être rattaché à une seule centrale en tant que chauffeur.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="4. Obligations réglementaires des centrales et des chauffeurs">
        <p>
          Le respect de la réglementation du transport public particulier de personnes (Code des transports, articles
          L3120-1 et suivants, et pour les VTC articles L3122-1 et suivants) incombe exclusivement aux centrales et aux
          chauffeurs, notamment :
        </p>
        <LegalList
          items={[
            <>l&apos;inscription de l&apos;exploitant au registre des exploitants de voitures de transport avec chauffeur ;</>,
            <>la carte professionnelle de conducteur de VTC en cours de validité et le permis de conduire ;</>,
            <>des véhicules conformes aux exigences réglementaires, entretenus et correctement immatriculés ;</>,
            <>une assurance de responsabilité civile circulation couvrant le transport de personnes à titre onéreux et une assurance de responsabilité civile professionnelle ;</>,
            <>la réservation préalable obligatoire : un chauffeur de VTC ne peut ni prendre en charge un client sans réservation préalable, ni stationner ou circuler sur la voie publique en quête de clients (maraude) ;</>,
            <>pour une centrale qui met en relation des clients et des chauffeurs, les obligations des centrales de réservation (articles L3142-1 et suivants), dont la déclaration de son activité à l&apos;autorité administrative ;</>,
            <>le droit du travail, le droit fiscal et social, le droit de la consommation (information du client sur le prix et les conditions) et la tenue de la comptabilité des courses.</>,
          ]}
        />
        <p>
          Les documents que la centrale demande dans l&apos;application (carte VTC, permis, assurance…) lui permettent de
          vérifier ces conditions. Leur contrôle relève d&apos;elle seule : l&apos;éditeur ne les vérifie pas. Les dates
          d&apos;échéance, alertes de renouvellement et refus automatiques affichés par l&apos;application sont des aides
          techniques, calculées à partir des informations saisies : ils ne constituent ni une vérification de
          l&apos;authenticité ou de la validité des documents, ni une autorisation d&apos;exercer, qui restent de la
          responsabilité de la centrale et du chauffeur.
        </p>
      </LegalSection>

      <LegalSection title="5. Réservations">
        <p>
          Une réservation faite sur un mini-site, par l&apos;API ou saisie par la centrale est une demande adressée à la
          centrale nommée sur le mini-site. Le contrat de transport est conclu entre le client et cette centrale (ou le
          chauffeur qu&apos;elle désigne), aux prix et conditions qu&apos;elle fixe. L&apos;éditeur n&apos;y est pas
          partie. Pour toute question sur une course (prix, retard, annulation, objet perdu, réclamation), le client
          s&apos;adresse à la centrale.
        </p>
      </LegalSection>

      <LegalSection title="6. Géolocalisation de l'application chauffeur">
        <LegalList
          items={[
            <>Quand vous êtes <span className="text-fg">EN LIGNE</span> ou en course, l&apos;application envoie votre position, avec votre direction (cap), votre vitesse, la précision du point et le niveau de batterie du téléphone, y compris lorsqu&apos;elle est en arrière-plan ou que le téléphone est verrouillé : toutes les quelques secondes pendant une offre ou une course, au moins une fois par minute en ligne. Elle sert à vous proposer les courses proches et à suivre la course en cours.</>,
            <>Qui la voit : votre centrale (propriétaire, administrateurs, dispatchers) ; l&apos;éditeur, pour le support, la sécurité et le bon fonctionnement du service (sa carte de supervision ne montre ni votre nom ni vos coordonnées). Le client et les autres chauffeurs ne la voient pas, sauf la position d&apos;un signalement que vous publiez.</>,
            <>Un historique de vos positions est conservé 30 jours, puis effacé. La vitesse sert seulement à savoir si le véhicule roule (affichage de la carte) : elle n&apos;est pas conservée dans l&apos;historique et n&apos;est jamais utilisée pour contrôler le respect des limitations de vitesse.</>,
            <>Passer hors ligne arrête l&apos;envoi, sauf pendant une course : la position reste partagée jusqu&apos;à la fin de la course. Fermer complètement l&apos;application l&apos;arrête aussi : vous passez hors ligne au bout de quelques minutes (jamais pendant une course) et ne recevez plus d&apos;offres. Après une coupure de réseau, l&apos;application vous remet en ligne si vous étiez en ligne et qu&apos;elle est restée ouverte.</>,
            <>Quand vous publiez un signalement pour la flotte (contrôle, accident, bouchon…), sa position est envoyée, même hors ligne.</>,
            <>Seule l&apos;autorisation « Pendant l&apos;utilisation » est demandée. Sur Android, une notification permanente « Rydar Drive — EN LIGNE » indique le suivi ; sur iPhone, l&apos;indicateur de localisation s&apos;affiche.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="7. Sécurité au volant">
        <LegalList
          items={[
            <>Le chauffeur respecte le Code de la route en toutes circonstances. Il est interdit de tenir le téléphone en main en conduisant et d&apos;utiliser l&apos;application d&apos;une manière qui détourne l&apos;attention de la conduite.</>,
            <>Le téléphone est fixé sur un support, hors de la zone de déploiement des airbags ; en roulant, l&apos;écran ne se regarde que brièvement, pour le guidage.</>,
            <>Lire, accepter ou refuser une offre, écrire un message ou publier un signalement se fait véhicule à l&apos;arrêt, dans un endroit sûr et autorisé : une offre manquée n&apos;est jamais une raison de manipuler le téléphone en roulant.</>,
            <>Les signalements publiés par d&apos;autres chauffeurs (contrôle, accident, bouchon) sont indicatifs et ne dispensent pas de respecter la signalisation et les règles de circulation.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="8. Notifications">
        <p>
          L&apos;application reçoit des notifications : offres de course (avec sonnerie, même téléphone verrouillé),
          courses attribuées, retirées ou annulées, rappels avant une course planifiée, messages de votre centrale,
          signalements de la flotte près de vous, commissions et règlements, justificatifs à renouveler, validation de
          votre candidature. Les refuser dans les réglages du téléphone vous fait manquer des offres.
        </p>
        <p>
          Si votre centrale le choisit, les relances de commission partent par WhatsApp, en plus ou à la place de
          l&apos;application, depuis le numéro WhatsApp Business de la centrale ; si WhatsApp échoue, elles passent par
          l&apos;application. Vous pouvez vous y opposer auprès de votre centrale, qui fait alors partir ses relances par
          l&apos;application seule.
        </p>
      </LegalSection>

      <LegalSection title="9. Messagerie et signalements entre chauffeurs">
        <LegalList
          items={[
            <>Le fil « Chauffeurs » et les signalements sont visibles par les chauffeurs de votre centrale et par son équipe (propriétaire, administrateurs, dispatchers). L&apos;éditeur peut y accéder pour le support, la sécurité et le traitement des signalements (voir la <Link href="/confidentialite" className={link}>politique de confidentialité</Link>).</>,
            <>Restez courtois et limitez-vous à l&apos;activité : trafic, contrôles, entraide. <span className="text-fg">Aucune tolérance pour les contenus choquants ni pour les comportements abusifs</span> : sont interdits les propos injurieux, discriminatoires, menaçants ou à caractère sexuel, le harcèlement, les données personnelles de tiers (clients notamment), la publicité et les faux signalements.</>,
            <>Par un appui long sur un message, vous pouvez le signaler à la centrale (il disparaît aussitôt de votre fil) ou masquer les messages de son auteur : vous ne les voyez plus, et il n&apos;en est pas informé.</>,
            <>La centrale modère le fil : elle traite les signalements, peut supprimer un message pour tous, suspendre ou exclure l&apos;auteur. Pour un contenu illicite, ou si la centrale ne traite pas un abus, écrivez à l&apos;éditeur : {contact.noun} (voir les <Link href="/mentions-legales" className={link}>mentions légales</Link>).</>,
            <>Ces règles sont affichées et doivent être acceptées dans l&apos;application avant votre première publication dans le fil (message ou signalement).</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="10. Comportements interdits">
        <LegalList
          items={[
            <>utiliser le service pour une activité illicite, notamment du transport sans réservation préalable ou sans les autorisations requises ;</>,
            <>manipuler l&apos;application en conduisant (article 7) ;</>,
            <>se faire passer pour une autre personne, déposer un document faux, falsifié ou appartenant à un autre, créer plusieurs comptes ou contourner une suspension ou un bannissement ;</>,
            <>fausser les courses : fausse position, fausse arrivée, course terminée sans avoir été réalisée, prix ou commissions manipulés ;</>,
            <>tenter d&apos;accéder aux données d&apos;une autre centrale, extraire les données en masse, tester la sécurité sans autorisation écrite, surcharger ou perturber le service ;</>,
            <>copier, décompiler ou revendre le logiciel.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="11. Suspension, bannissement et recours">
        <LegalList
          items={[
            <><span className="text-fg">Décisions de la centrale.</span> La centrale peut refuser une candidature, suspendre, désactiver ou bannir un chauffeur de son réseau, retirer un message de son fil ou exclure son auteur, selon ses propres règles et pour le motif qu&apos;elle consigne ; ces décisions sont les siennes et se contestent auprès d&apos;elle. Un impayé ou un différend avec une centrale ne concerne qu&apos;elle : il n&apos;est jamais communiqué aux autres centrales.</>,
            <><span className="text-fg">Décisions de l&apos;éditeur.</span> Seule une fraude constatée (usurpation d&apos;identité, document faux ou falsifié, fausse déclaration) peut conduire l&apos;éditeur à interdire une personne sur toute la plateforme. Il en décide seul, après l&apos;examen par une personne du signalement d&apos;une centrale ; les fiches du même chauffeur dans d&apos;autres centrales ne sont touchées qu&apos;après sa vérification. En cas de risque pour la sécurité du service, il peut aussi retirer un contenu ou suspendre un compte.</>,
            <><span className="text-fg">Contrôles automatiques.</span> À l&apos;inscription, à l&apos;enregistrement de la fiche ou d&apos;un justificatif et à la première connexion d&apos;un appareil, des empreintes de vos identifiants (téléphone, e-mail, numéros de carte VTC, de permis et de pièce d&apos;identité, plaque, identifiant de l&apos;appareil) sont comparées à celles des personnes bannies par la centrale ou interdites sur toute la plateforme. En cas de correspondance exacte, l&apos;inscription, la fiche ou le justificatif est refusé, ou le compte suspendu, et la centrale est prévenue ; vous pouvez demander qu&apos;une personne réexamine cette décision.</>,
            <><span className="text-fg">Information et recours.</span> Une interdiction sur toute la plateforme vous est notifiée par e-mail, à l&apos;adresse de votre compte, avec ses motifs (faits retenus, articles des CGU appliqués), ses conséquences et vos voies de recours. Vous pouvez la contester dans les 6 mois en répondant à cet e-mail ou en écrivant {contact.to} : un nouvel examen humain est fait, et la réponse est motivée. Vous gardez le droit de saisir le juge et, pour vos données, la CNIL.</>,
          ]}
        />
        <p>
          Un bannissement peut empêcher une nouvelle inscription (voir la{" "}
          <Link href="/confidentialite" className={link}>politique de confidentialité</Link>).
        </p>
      </LegalSection>

      <LegalSection title="12. Disponibilité">
        <p>
          L&apos;éditeur met en œuvre les moyens raisonnables pour que le service soit disponible et fiable (obligation de
          moyens). Des interruptions peuvent survenir pour maintenance, mise à jour, panne d&apos;un prestataire
          (hébergement, notifications, cartographie, réseau mobile) ou cas de force majeure. Les positions, délais et
          itinéraires affichés sont indicatifs : le chauffeur reste seul maître de sa conduite et respecte le Code de la
          route.
        </p>
      </LegalSection>

      <LegalSection title="13. Responsabilité">
        <p>
          L&apos;application est mise gratuitement à la disposition du chauffeur. L&apos;éditeur répond des dommages directs
          causés par un manquement prouvé à ses obligations. Il ne répond pas :
        </p>
        <LegalList
          items={[
            <>de l&apos;exécution des courses, des accidents, retards ou litiges entre clients, chauffeurs et centrales, ni du paiement des courses et des commissions ;</>,
            <>des décisions de la centrale (attribution, prix, commissions, suspension, bannissement) ;</>,
            <>des offres non reçues ou manquées, et de la perte de chiffre d&apos;affaires ou de clientèle liées à une interruption du service, du réseau mobile, du GPS ou des notifications ;</>,
            <>de l&apos;exactitude des adresses, distances, durées et itinéraires fournis par des services cartographiques tiers, qui sont indicatifs ;</>,
            <>du contenu publié par les utilisateurs.</>,
          ]}
        />
        <p>
          Le chauffeur conserve les originaux de ses justificatifs. Ces limites ne s&apos;appliquent ni en cas de faute
          lourde ou dolosive de l&apos;éditeur, ni aux dommages corporels, ni lorsqu&apos;une règle impérative l&apos;interdit. Entre
          l&apos;éditeur et une centrale, la responsabilité est régie par les{" "}
          <Link href="/cgv" className={link}>conditions générales de vente</Link>.
        </p>
      </LegalSection>

      <LegalSection title="14. Données personnelles">
        <p>
          Voir la <Link href="/confidentialite" className={link}>politique de confidentialité</Link> et, pour les
          centrales, l&apos;<Link href="/dpa" className={link}>accord de traitement des données</Link>.
        </p>
      </LegalSection>

      <LegalSection title="15. Propriété intellectuelle">
        <p>
          L&apos;éditeur accorde un droit d&apos;utilisation personnel, non exclusif et non transférable du service,
          pour la durée de votre accès. Le logiciel, la marque et les contenus de l&apos;éditeur restent sa propriété.
          Les données saisies par la centrale restent les siennes.
        </p>
        <p>
          Vous restez titulaire des contenus que vous publiez (messages, signalements, photos, documents). Vous
          autorisez l&apos;éditeur, gratuitement et pour la seule durée nécessaire au service, à les stocker, les reproduire
          et les afficher aux personnes prévues par les présentes CGU et la politique de confidentialité. Vous
          garantissez avoir le droit de les publier et qu&apos;ils ne portent atteinte aux droits de personne.
        </p>
      </LegalSection>

      <LegalSection title="16. Suppression du compte chauffeur">
        <p>
          Vous pouvez supprimer votre compte dans l&apos;application (Profil › Supprimer mon compte) ou par e-mail : voir{" "}
          <Link href="/suppression-compte" className={link}>Supprimer son compte</Link>. La suppression est refusée
          tant qu&apos;une course vous est attribuée : terminez-la ou demandez à la centrale de la réattribuer (si la
          centrale est suspendue ou a quitté le service, une course acceptée mais pas encore commencée vous est retirée
          automatiquement). Elle n&apos;efface pas les commissions encore dues à la centrale. Les utilisateurs d&apos;une centrale s&apos;adressent
          au propriétaire de celle-ci.
        </p>
      </LegalSection>

      <LegalSection title="17. Modification des CGU">
        <p>
          L&apos;éditeur peut faire évoluer les CGU, notamment pour suivre la loi, la sécurité ou les fonctions du service. La
          version en vigueur est datée en haut de cette page. Une nouvelle version est présentée pour acceptation : aux
          chauffeurs dans l&apos;application, à chaque membre de l&apos;équipe des centrales dans le tableau de bord, le
          propriétaire ou un administrateur l&apos;acceptant aussi au nom de la centrale. Tant qu&apos;un chauffeur ne l&apos;a pas
          acceptée, l&apos;application le met hors ligne et ne lui propose plus d&apos;offres, jamais pendant une course. Si vous
          la refusez, vous pouvez cesser d&apos;utiliser le service et supprimer votre compte à tout moment.
        </p>
      </LegalSection>

      <LegalSection title="18. Droit applicable">
        <p>
          Les présentes CGU sont soumises au droit français. En cas de litige, une solution amiable est recherchée en
          priorité en écrivant {contact.to}. À défaut, les tribunaux français sont compétents ; entre commerçants, la
          juridiction commerciale (tribunal de commerce ou tribunal des activités économiques) du ressort du siège de
          l&apos;éditeur. Un consommateur conserve la protection des règles impératives de son pays de résidence et peut
          saisir le tribunal de son domicile.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
