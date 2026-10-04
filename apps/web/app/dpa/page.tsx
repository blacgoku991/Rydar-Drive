import type { Metadata } from "next";
import Link from "next/link";
import { legalContact } from "@/components/legal/legal-contact";
import { LegalList, LegalPage, LegalSection } from "@/components/legal/legal-page";
import { DPA_UPDATED_AT, ORG_LEGAL_VERSION, getLegalInfo } from "@/lib/legal";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Accord de traitement des données — Rydar Drive" },
  description:
    "Accord de sous-traitance (article 28 du RGPD) entre les centrales et l'éditeur de Rydar Drive : rôles, sécurité, sous-traitants ultérieurs, durées de conservation.",
};

type Processor = { name: string; service: string; data: string; place: string; safeguards: string };

/**
 * Sous-traitants ultérieurs : tableau défilant horizontalement sur petit écran ; la zone défilante est atteignable au
 * clavier (flèches) et nommée.
 */
function ProcessorTable({ rows }: { rows: Processor[] }) {
  return (
    <div className="overflow-x-auto rounded-md" tabIndex={0} role="region" aria-label="Sous-traitants ultérieurs">
      <table className="w-full min-w-[720px] border-collapse text-left text-[13px]">
        <caption className="sr-only">Sous-traitants ultérieurs de l&apos;éditeur</caption>
        <thead>
          <tr className="border-b border-line-strong text-fg">
            <th scope="col" className="py-2 pr-4 font-medium">Sous-traitant</th>
            <th scope="col" className="py-2 pr-4 font-medium">Service</th>
            <th scope="col" className="py-2 pr-4 font-medium">Données concernées</th>
            <th scope="col" className="py-2 pr-4 font-medium">Localisation</th>
            <th scope="col" className="py-2 font-medium">Garanties</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-b border-line align-top">
              <td className="py-2 pr-4 text-fg">{r.name}</td>
              <td className="py-2 pr-4">{r.service}</td>
              <td className="py-2 pr-4">{r.data}</td>
              <td className="py-2 pr-4">{r.place}</td>
              <td className="py-2">{r.safeguards}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function DataProcessingPage() {
  const legal = await getLegalInfo();
  const contact = legalContact(legal.privacyEmail);
  const link = "text-fg underline underline-offset-2";
  const processors: Processor[] = [
    {
      name: legal.hostName || "Hébergeur du serveur (voir les mentions légales)",
      service:
        "Location du serveur de l'éditeur, qui héberge le site, l'API, la base de données et les comptes de connexion (logiciel Supabase installé et administré par l'éditeur), les fichiers (justificatifs, photos), le temps réel, les sauvegardes, les traitements automatiques (dispatch, notifications, relances) et le serveur d'envoi des e-mails ; stockage objet de la copie chiffrée des sauvegardes",
      data: "Toutes les données du service",
      place: legal.dataHost || "Union européenne",
      safeguards: "Hébergement dans l'Union européenne ; contrat de l'hébergeur (article 28 du RGPD)",
    },
    {
      name: "650 Industries, Inc. (Expo)",
      service: "Relais des notifications et téléchargement des mises à jour de l'application chauffeur",
      data: "Jeton et contenu des notifications (offre, message) ; pour les mises à jour : adresse IP, identifiant d'installation EAS, plateforme et version de l'application",
      place: "États-Unis",
      safeguards: "Clauses contractuelles types, Data Privacy Framework",
    },
    {
      name: "Apple (APNs) et Google (FCM)",
      service: "Remise des notifications sur iPhone et Android",
      data: "Jeton de notification, contenu de la notification",
      place: "États-Unis",
      safeguards: "Data Privacy Framework",
    },
    {
      name: "Google (Maps SDK for Android) et Apple (Plans)",
      service: "Affichage de la carte dans l'application chauffeur",
      data: "Données techniques de l'appareil, zone affichée",
      place: "États-Unis",
      safeguards: "Data Privacy Framework",
    },
    {
      name: "Meta Platforms Ireland Ltd (WhatsApp Business)",
      service: "Relances de commission par WhatsApp, seulement si la centrale les active : messages envoyés depuis le compte WhatsApp Business de la centrale, sous son propre contrat avec Meta (l'éditeur transmet les messages qu'elle a programmés). Relances de frais plateforme au propriétaire : compte de l'éditeur",
      data: "Numéro de téléphone du destinataire, prénom, montant, nom de la centrale, nombre de courses ou échéance",
      place: "Union européenne et États-Unis",
      safeguards: "Clauses contractuelles types, Data Privacy Framework",
    },
    {
      name: "Mapbox, Inc. ou Google (Maps Platform)",
      service: "Adresses et itinéraires, seulement si l'éditeur choisit ce fournisseur",
      data: "Adresses et points de trajet, sans identité",
      place: "États-Unis",
      safeguards: "Clauses contractuelles types, Data Privacy Framework",
    },
    {
      name: "AeroDataBox (via RapidAPI ou API.market), aviationstack ou FlightAware",
      service: "Suivi des vols, seulement si activé",
      data: "Numéro de vol et date uniquement",
      place: "Hors Union européenne selon le fournisseur",
      safeguards: "Clauses contractuelles types",
    },
  ];
  return (
    <LegalPage title="Accord de traitement des données" updatedAt={DPA_UPDATED_AT}>
      <p>
        Le présent accord (article 28 du règlement (UE) 2016/679, « RGPD ») fait partie intégrante des{" "}
        <Link href="/cgv" className={link}>conditions générales de vente</Link>. Il s&apos;applique entre chaque
        centrale cliente et{" "}
        {legal.nameSet ? (
          <span className="text-fg">{legal.name}</span>
        ) : (
          <>
            la société identifiée dans les{" "}
            <Link href="/mentions-legales" className={link}>
              mentions légales
            </Link>
          </>
        )}{" "}
        (l&apos;« éditeur ») et prévaut sur toute
        autre stipulation relative aux données personnelles. Version {ORG_LEGAL_VERSION}, commune aux CGV et au présent
        accord, acceptée par le propriétaire ou un administrateur de la centrale dans le tableau de bord. Le 3 octobre
        2026, la description de l&apos;hébergement, des sauvegardes et des sous-traitants (articles 5, 6, 7 et 11) a été
        corrigée pour correspondre à l&apos;installation réelle, sans nouvelle obligation pour la centrale : la base de
        données et les fichiers sont sur le serveur de l&apos;éditeur, chez l&apos;hébergeur du site, leurs sauvegardes chez ce
        même hébergeur, et la société Supabase, Inc. ne reçoit aucune donnée. Le texte accepté avant cette
        correction reste consultable :{" "}
        <Link href="/dpa/2026-10-02" className={link}>
          texte du 27 septembre 2026
        </Link>
        . Une centrale qui s&apos;oppose à cette correction peut l&apos;écrire à l&apos;éditeur et, à défaut de solution,
        résilier sans frais (article 6).
      </p>

      <LegalSection title="1. Rôles">
        <LegalList
          items={[
            <><span className="text-fg">La centrale est responsable de traitement</span> des données de ses chauffeurs et candidats, de ses clients et passagers, et des membres de son équipe. Elle décide des finalités (organiser et suivre ses courses, gérer ses chauffeurs, ses règlements et sa relation client) et des moyens essentiels (paramétrage du dispatch, des commissions, des blocages, des documents demandés).</>,
            <><span className="text-fg">L&apos;éditeur est sous-traitant</span> : il héberge ces données et les traite de façon automatisée pour le compte de la centrale, uniquement pour fournir le service.</>,
            <>L&apos;éditeur est <span className="text-fg">responsable de traitement distinct</span> pour la sécurité de la plateforme (journaux, limitation des abus, journal d&apos;audit), la lutte contre la fraude à l&apos;échelle de la plateforme (signalements et interdictions entre centrales), la gestion des comptes et la facturation de ses clients (abonnements, frais plateforme et leurs relances) et son site vitrine. Ces traitements sont décrits dans la <Link href="/confidentialite" className={link}>politique de confidentialité</Link>.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="2. Description du traitement">
        <LegalList
          items={[
            <><span className="text-fg">Objet</span> : fourniture du logiciel de dispatch Rydar Drive (tableau de bord, application chauffeur, mini-site de réservation lorsque l&apos;éditeur le propose, API).</>,
            <><span className="text-fg">Durée</span> : celle du contrat, puis le temps de la restitution et de la suppression (article 11).</>,
            <><span className="text-fg">Nature</span> : collecte, enregistrement, hébergement, consultation, calcul (distances, itinéraires, répartition des montants), transmission (notifications, relances, accusés de réception des réservations, API et webhooks), rapprochement, suppression.</>,
            <><span className="text-fg">Finalités</span> : réception des réservations, proposition des courses aux chauffeurs selon leur position, suivi des courses, guidage, messagerie et signalements, gains, commissions et règlements, documents des chauffeurs, alertes, statistiques, candidatures par lien d&apos;inscription.</>,
            <><span className="text-fg">Personnes concernées</span> : chauffeurs et candidats, clients et passagers, membres de l&apos;équipe de la centrale.</>,
            <><span className="text-fg">Données</span> : identité et coordonnées ; carte professionnelle VTC, véhicule et plaque ; justificatifs (permis, pièce d&apos;identité, assurance…) ; positions GPS avec cap, vitesse, précision et niveau de batterie ; informations de l&apos;appareil (identifiant, modèle, système, version de l&apos;application, jeton de notification) ; adresse IP et navigateur du journal de sécurité ; historique des connexions (date, e-mail, adresse IP) ; courses (adresses, horaires, passagers, prix, numéro de vol, commentaires) ; messages et signalements ; gains, commissions et règlements ; empreintes (hachages) des identifiants d&apos;un chauffeur banni ou parti en devant des commissions ; journal des actions de l&apos;équipe. Aucune donnée sensible au sens de l&apos;article 9 du RGPD, notamment de santé, ne doit être saisie : aucun justificatif médical n&apos;est prévu.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="3. Instructions">
        <p>
          L&apos;éditeur ne traite les données que sur instruction documentée de la centrale : les CGV, le présent
          accord et le paramétrage qu&apos;elle fait dans le tableau de bord, y compris les transmissions vers les systèmes
          qu&apos;elle désigne (API, webhooks). Il informe immédiatement la centrale si une
          instruction lui paraît contraire au RGPD. Il ne vend pas les données et ne les utilise pas pour son propre
          compte, hors traitements dont il est responsable (article 1) et statistiques anonymes et agrégées.
        </p>
      </LegalSection>

      <LegalSection title="4. Confidentialité">
        <p>
          Les personnes autorisées à traiter les données chez l&apos;éditeur sont soumises à une obligation de
          confidentialité et n&apos;y accèdent que dans la mesure nécessaire à leur mission (support, maintenance,
          sécurité).
        </p>
        <p>
          Pour la supervision technique du service (pannes du dispatch, positions qui n&apos;arrivent plus, courses sans
          chauffeur), l&apos;éditeur affiche dans son espace d&apos;administration un état en direct des centrales et une carte
          des chauffeurs en ligne, sans nom ni coordonnées des chauffeurs ni des clients, ainsi que le journal des alertes
          et des erreurs du dispatch des 7 derniers jours, dont les messages peuvent nommer un chauffeur et indiquer les
          adresses d&apos;une course restée sans chauffeur. Pour le reste, son accès nominatif aux données d&apos;une centrale
          est limité au support qu&apos;elle demande, à la sécurité et au traitement des signalements.
        </p>
      </LegalSection>

      <LegalSection title="5. Sécurité (article 32 du RGPD)">
        <LegalList
          items={[
            <>Échanges chiffrés (HTTPS / TLS) entre les navigateurs, l&apos;application et le serveur ; la base de données, sur ce même serveur, n&apos;est joignable qu&apos;en local (aucun port public).</>,
            <>Cloisonnement par centrale : chaque ligne de la base est rattachée à une centrale et protégée par un contrôle d&apos;accès par ligne ; les opérations sensibles passent par des fonctions qui vérifient les droits.</>,
            <>Rôles distincts (propriétaire, administrateur, dispatcher, chauffeur, super admin) ; comptes chauffeurs suspendus ou bannis coupés immédiatement.</>,
            <>Clés d&apos;API stockées uniquement sous forme d&apos;empreinte (hachage avec un secret du serveur) ; limitation du nombre de requêtes et des tentatives de connexion.</>,
            <>Jetons d&apos;accès WhatsApp Business stockés côté serveur, jamais lisibles par les utilisateurs ni renvoyés au navigateur.</>,
            <>Journal d&apos;audit des actions sensibles ; journaux d&apos;appels de l&apos;API.</>,
            <>Session chiffrée sur le téléphone du chauffeur, avec une clé gardée dans le trousseau sécurisé du système.</>,
            <>Sauvegarde de la base de données et des fichiers chaque nuit, par l&apos;éditeur : une copie sur son serveur et une copie chiffrée avant son envoi, dont la clé est gardée hors du stockage, dans l&apos;espace de stockage objet de l&apos;hébergeur du serveur, dans l&apos;Union européenne ; chaque sauvegarde est gardée 14 jours puis effacée ; restauration testée ; mises à jour de sécurité régulières.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="6. Sous-traitants ultérieurs">
        <p>
          La centrale donne une autorisation générale au recours aux sous-traitants ci-dessous. L&apos;éditeur
          l&apos;informe au moins 30 jours à l&apos;avance de tout ajout ou remplacement (message dans le tableau de bord
          ou e-mail au propriétaire, et mise à jour de cette page). La centrale peut s&apos;y opposer pour un motif
          légitime lié à la protection des données ; à défaut de solution, elle peut résilier le service concerné sans
          frais. L&apos;éditeur conclut avec chaque sous-traitant ultérieur un contrat conforme à l&apos;article 28.4 du RGPD ;
          pour les fournisseurs qui n&apos;acceptent que leurs conditions standard (Apple, Google, Meta, Expo), ce contrat
          est constitué de leurs conditions de traitement des données en vigueur, que la centrale déclare accepter.
          L&apos;éditeur reste responsable envers la centrale dans les limites de l&apos;article 28.4 du RGPD et des CGV. Le
          paiement des abonnements (Stripe) relève des traitements dont l&apos;éditeur est responsable (article 1) : il est
          décrit dans la politique de confidentialité.
        </p>
        <ProcessorTable rows={processors} />
        <p>
          Services publics tiers, utilisés selon leurs propres conditions : ils ne sont pas des sous-traitants de
          l&apos;éditeur (aucun contrat de sous-traitance n&apos;est conclu avec eux) et ne reçoivent aucune identité.
        </p>
        <LegalList
          items={[
            <>Images des cartes du tableau de bord et des mini-sites : OpenFreeMap, exploité par Hyperknot Software Kft. (Hongrie), qui reçoit l&apos;adresse IP du navigateur qui affiche la carte (journaux contenant l&apos;adresse IP gardés 30 jours au plus selon sa politique, aucun cookie) ; <a href="https://openfreemap.org/privacy/" className={link}>politique d&apos;OpenFreeMap</a>.</>,
            <>Recherche d&apos;adresses : Géoplateforme de l&apos;IGN ou Base Adresse Nationale (France), interrogées par le serveur de l&apos;éditeur avec les adresses saisies ou les points à convertir en adresse, sans identité.</>,
            <>Itinéraires, tant que l&apos;éditeur n&apos;utilise pas son propre serveur de calcul : serveur public du projet OSRM, exploité par FOSSGIS e.V. (Allemagne), interrogé par le serveur de l&apos;éditeur avec des points de départ et d&apos;arrivée et la position du chauffeur, sans identité ; <a href="https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/" className={link}>conditions de FOSSGIS</a>.</>,
          ]}
        />
        <p>
          La base de données (Supabase) est un logiciel installé et administré par l&apos;éditeur sur son serveur : la
          société Supabase, Inc. ne reçoit aucune donnée du service. Les e-mails (invitation, mot de passe oublié,
          accusés de réception, annonces) partent du serveur d&apos;envoi installé sur ce même serveur, directement vers
          la messagerie du destinataire, sans prestataire d&apos;envoi. Les services marqués « si activé » ne reçoivent
          aucune donnée tant qu&apos;ils ne sont pas utilisés.
        </p>
      </LegalSection>

      <LegalSection title="7. Transferts hors de l'Union européenne">
        <p>
          Les données sont hébergées dans l&apos;Union européenne, sur le serveur de l&apos;éditeur (hébergeur et lieu :
          voir les <Link href="/mentions-legales" className={link}>mentions légales</Link>). Les transferts vers un pays tiers, limités aux services
          indiqués dans le tableau, sont encadrés par une décision d&apos;adéquation (notamment le Data Privacy Framework
          UE–États-Unis pour les entreprises certifiées) ou par les clauses contractuelles types de la Commission
          européenne, complétées si besoin de mesures supplémentaires.
        </p>
      </LegalSection>

      <LegalSection title="8. Droits des personnes">
        <p>
          La centrale répond aux demandes de ses chauffeurs, clients et membres (accès, rectification, effacement,
          limitation, opposition, portabilité). L&apos;éditeur l&apos;y aide : consultation et correction des fiches dans
          le tableau de bord, suppression du compte chauffeur dans l&apos;application ou par l&apos;outil de
          l&apos;éditeur, export sur demande. Une demande reçue directement par l&apos;éditeur pour des données dont la
          centrale est responsable lui est transmise sans délai.
        </p>
      </LegalSection>

      <LegalSection title="9. Violations de données">
        <p>
          L&apos;éditeur notifie à la centrale toute violation de données personnelles la concernant dans les meilleurs
          délais et au plus tard 48 heures après en avoir pris connaissance, avec les informations prévues à
          l&apos;article 33.3 du RGPD disponibles à ce moment (nature, catégories et nombre approximatif de personnes et
          d&apos;enregistrements, conséquences probables, mesures prises ou proposées, contact). Il l&apos;aide à
          notifier la CNIL et, si nécessaire, à informer les personnes.
        </p>
      </LegalSection>

      <LegalSection title="10. Analyse d'impact et registre">
        <p>
          L&apos;éditeur tient à la disposition de la centrale, sur demande écrite, une description technique de la
          géolocalisation des chauffeurs (données collectées, fréquence, conditions d&apos;activation, durées de
          conservation, destinataires, mesures de sécurité) et des risques identifiés, qu&apos;elle peut reprendre dans sa
          propre analyse d&apos;impact (AIPD) ; il l&apos;aide pour une éventuelle consultation préalable de la CNIL. L&apos;éditeur a
          analysé l&apos;impact des traitements dont il est responsable (lutte contre la fraude entre centrales) et tient
          cette analyse à jour. Chaque partie tient son registre des traitements ; celui que l&apos;éditeur tient en qualité
          de sous-traitant est communiqué à la centrale sur demande.
        </p>
      </LegalSection>

      <LegalSection title="11. Durées de conservation et fin du contrat">
        <LegalList
          items={[
            <>Historique des positions GPS, y compris la position relevée lors d&apos;une alerte de course (chauffeur immobile, GPS muet) : 30 jours, ou jusqu&apos;à la clôture de l&apos;alerte si elle reste ouverte plus longtemps ; la dernière position connue est remplacée à chaque envoi.</>,
            <>Messages, signalements de la flotte (y compris leur copie dans le journal de la centrale) et signalements de messages : 180 jours ; un message retiré par la centrale disparaît aussitôt de l&apos;application, du tableau de bord et des alertes enregistrées (une notification déjà affichée sur un téléphone y reste jusqu&apos;à ce que son destinataire l&apos;efface) et il est effacé à la même échéance. Auteurs masqués par un chauffeur : tant que les deux comptes existent.</>,
            <>Notifications, y compris les relances WhatsApp : 90 jours après leur envoi prévu, quel que soit leur résultat. Journaux d&apos;appels de l&apos;API : 90 jours.</>,
            <>Journal des actions sensibles : pendant le contrat. Les adresses IP et navigateurs qu&apos;il contient (inscription par lien, actions sensibles) et l&apos;historique des connexions tenu par le service d&apos;authentification : 1 an ; ceux d&apos;un chauffeur qui supprime son compte sont effacés dès la suppression.</>,
            <>Courses : téléphone et e-mail du client et précisions effacés 3 ans après la fin de l&apos;année de la course ; le reste de la course, les gains, commissions et règlements, 10 ans après la fin de l&apos;année de la course (obligations comptables), puis supprimés, y compris une course jamais terminée ; sans l&apos;identité d&apos;un chauffeur qui a supprimé son compte.</>,
            <>Justificatifs des chauffeurs, y compris les versions remplacées : tant que le compte du chauffeur existe ; supprimés avec leurs fichiers dès la suppression du compte.</>,
            <>Bannissement (par la centrale, ou interdiction sur toute la plateforme pour fraude) : empreintes des identifiants, motif et signalement effacés 3 ans après le bannissement, même si le compte du chauffeur existe toujours ; si le compte est supprimé, son nom et les indices partiels des empreintes sont effacés aussitôt.</>,
            <>Chauffeur qui supprime son compte en devant encore des commissions à la centrale : empreintes (hachages, sans indice en clair) de son téléphone, de ses adresses e-mail et de son numéro de carte VTC, gardées pour le compte de la centrale (intérêt légitime de la centrale au recouvrement de sa créance) tant qu&apos;une somme reste due, puis effacées ; elles empêchent seulement la validation automatique d&apos;une nouvelle candidature par lien avec ces identifiants et signalent à la centrale le montant restant dû.</>,
          ]}
        />
        <p>
          À la fin du contrat, le compte de la centrale est archivé : plus aucun accès au service. Sur demande écrite de
          la centrale avant la fin du contrat, l&apos;éditeur lui restitue ses données (export au format CSV, transmis
          par un moyen sécurisé). Il supprime ensuite, dans les 30 jours, les
          données personnelles traitées pour son compte (comptes des chauffeurs et candidats, avec leurs justificatifs et
          leurs fichiers ; courses et coordonnées des clients ; messages ; positions ; comptes de l&apos;équipe et journal
          de leurs actions ; mini-site), copies comprises, sauf obligation légale de conservation ; les sauvegardes, copie
          hors du serveur comprise, gardées 14 jours, en disparaissent à l&apos;expiration de ce cycle. Il conserve, comme responsable de traitement distinct, la fiche
          archivée de la centrale, le registre des frais plateforme et les paiements, avec le journal des actions qui s&apos;y
          rapportent (obligations comptables, 10 ans au moins) et la preuve d&apos;acceptation des CGV et du présent accord, avec l&apos;e-mail de la personne qui les a
          acceptés (preuve du contrat).
        </p>
      </LegalSection>

      <LegalSection title="12. Audits">
        <p>
          L&apos;éditeur met à disposition la documentation nécessaire pour démontrer le respect du présent accord. La
          centrale peut, une fois par an, faire réaliser un audit, avec un préavis de 30 jours, à ses frais, par un
          auditeur indépendant tenu au secret et non concurrent de l&apos;éditeur, sans accès aux données des autres
          centrales ni perturbation du service : d&apos;abord sur pièces (questionnaire, documentation, attestations de
          l&apos;hébergeur), puis, si ces pièces ne suffisent pas, dans les locaux de l&apos;éditeur. Les centres de données de
          l&apos;hébergeur sont couverts par ses propres certifications et rapports d&apos;audit.
        </p>
      </LegalSection>

      <LegalSection title="13. Obligations de la centrale">
        <p>
          La centrale s&apos;assure que ses traitements reposent sur une base légale et informe les personnes concernées :
          ses chauffeurs (géolocalisation, notifications, relances WhatsApp et leur droit de s&apos;y opposer, règles de
          commission et de blocage, transmission possible d&apos;un signalement de fraude à l&apos;éditeur, qui le traite comme
          responsable distinct), ses clients (identité de l&apos;exploitant, usage de leurs coordonnées) et son équipe. Elle
          réalise l&apos;analyse d&apos;impact de ses traitements lorsqu&apos;elle est requise, notamment pour la géolocalisation de
          ses chauffeurs. Elle ne saisit que des données nécessaires et aucune donnée sensible (santé notamment).
        </p>
      </LegalSection>

      <LegalSection title="14. Contact">
        <p>Contact « données personnelles » de l&apos;éditeur : {contact.noun}.</p>
      </LegalSection>
    </LegalPage>
  );
}
