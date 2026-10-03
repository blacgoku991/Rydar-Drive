import type { Metadata } from "next";
import Link from "next/link";
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
  const contact = legal.privacyEmail ? (
    <a href={`mailto:${legal.privacyEmail}`} className="text-fg underline underline-offset-2">{legal.privacyEmail}</a>
  ) : (
    "l'adresse indiquée dans les mentions légales"
  );
  const link = "text-fg underline underline-offset-2";
  const processors: Processor[] = [
    {
      name: legal.hostName || "Hébergeur du serveur (voir les mentions légales)",
      service:
        "Location du serveur de l'éditeur, qui héberge le site, l'API, la base de données et les comptes de connexion (logiciel Supabase installé et administré par l'éditeur), les fichiers (justificatifs, photos), le temps réel, les sauvegardes, les traitements automatiques (dispatch, notifications, relances) et le serveur d'envoi des e-mails",
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
      name: "Stripe Payments Europe, Ltd",
      service: "Paiement des abonnements des centrales",
      data: "Coordonnées de facturation de la centrale (aucune donnée des chauffeurs ni des clients)",
      place: "Irlande (Union européenne) ; États-Unis pour sa maison mère Stripe, Inc.",
      safeguards: "RGPD ; Data Privacy Framework et clauses contractuelles types pour les États-Unis",
    },
    {
      name: "Meta Platforms Ireland Ltd (WhatsApp Business)",
      service: "Relances par WhatsApp, seulement si activées : commissions (depuis le compte WhatsApp Business de la centrale), frais plateforme (depuis celui de l'éditeur)",
      data: "Numéro de téléphone du destinataire, prénom, montant, nom de la centrale, nombre de courses ou échéance",
      place: "Union européenne et États-Unis",
      safeguards: "Clauses contractuelles types, Data Privacy Framework",
    },
    {
      name: "IGN — Géoplateforme (ou Base Adresse Nationale)",
      service: "Recherche d'adresses et coordonnées GPS",
      data: "Adresses saisies ou points à convertir en adresse, sans identité",
      place: "France",
      safeguards: "Service public",
    },
    {
      name: "OpenFreeMap (serveur de tuiles)",
      service: "Images de la carte du tableau de bord et des mini-sites",
      data: "Adresse IP technique du navigateur",
      place: "Union européenne",
      safeguards: "RGPD",
    },
    {
      name: "OSRM (serveur de l'éditeur ou serveur public du projet OSRM)",
      service: "Calcul des itinéraires et du guidage",
      data: "Points de départ, d'arrivée et position du chauffeur, sans identité",
      place: "Union européenne",
      safeguards: "RGPD",
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
        accord, acceptée par le propriétaire ou un administrateur de la centrale dans le tableau de bord. Le{" "}
        {DPA_UPDATED_AT}, la description de l&apos;hébergement, des sauvegardes et des sous-traitants (articles 5, 6, 7 et
        11) a été corrigée pour correspondre à l&apos;installation réelle, sans nouvelle obligation pour la centrale.
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
            <><span className="text-fg">Objet</span> : fourniture du logiciel de dispatch Rydar Drive (tableau de bord, application chauffeur, mini-site de réservation, API).</>,
            <><span className="text-fg">Durée</span> : celle du contrat, puis le temps de la restitution et de la suppression (article 11).</>,
            <><span className="text-fg">Nature</span> : collecte, enregistrement, hébergement, consultation, calcul (distances, itinéraires, répartition des montants), transmission (notifications, relances), rapprochement, suppression.</>,
            <><span className="text-fg">Finalités</span> : réception des réservations, proposition des courses aux chauffeurs selon leur position, suivi des courses, guidage, messagerie et signalements, gains, commissions et règlements, documents des chauffeurs, alertes, statistiques, candidatures par lien d&apos;inscription.</>,
            <><span className="text-fg">Personnes concernées</span> : chauffeurs et candidats, clients et passagers, membres de l&apos;équipe de la centrale.</>,
            <><span className="text-fg">Données</span> : identité et coordonnées ; carte professionnelle VTC, véhicule et plaque ; justificatifs (permis, pièce d&apos;identité, assurance…) ; positions GPS avec cap, vitesse, précision et niveau de batterie ; informations de l&apos;appareil (identifiant, modèle, système, version de l&apos;application, jeton de notification) ; adresse IP et navigateur du journal de sécurité ; historique des connexions (date, e-mail, adresse IP) ; courses (adresses, horaires, passagers, prix, numéro de vol, commentaires) ; messages et signalements ; gains, commissions et règlements ; empreintes (hachages) des identifiants d&apos;un chauffeur banni ou parti en devant des commissions ; journal des actions de l&apos;équipe. Aucune donnée sensible au sens de l&apos;article 9 du RGPD, notamment de santé, ne doit être saisie : aucun justificatif médical n&apos;est prévu.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="3. Instructions">
        <p>
          L&apos;éditeur ne traite les données que sur instruction documentée de la centrale : les CGV, le présent
          accord et le paramétrage qu&apos;elle fait dans le tableau de bord. Il informe immédiatement la centrale si une
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
      </LegalSection>

      <LegalSection title="5. Sécurité (article 32 du RGPD)">
        <LegalList
          items={[
            <>Échanges chiffrés (HTTPS / TLS) entre les navigateurs, l&apos;application, le serveur et la base de données.</>,
            <>Cloisonnement par centrale : chaque ligne de la base est rattachée à une centrale et protégée par un contrôle d&apos;accès par ligne ; les opérations sensibles passent par des fonctions qui vérifient les droits.</>,
            <>Rôles distincts (propriétaire, administrateur, dispatcher, chauffeur, super admin) ; comptes chauffeurs suspendus ou bannis coupés immédiatement.</>,
            <>Clés d&apos;API stockées uniquement sous forme d&apos;empreinte (hachage avec un secret du serveur) ; limitation du nombre de requêtes et des tentatives de connexion.</>,
            <>Jetons d&apos;accès WhatsApp Business stockés côté serveur, jamais lisibles par les utilisateurs ni renvoyés au navigateur.</>,
            <>Journal d&apos;audit des actions sensibles ; journaux d&apos;appels de l&apos;API.</>,
            <>Session chiffrée sur le téléphone du chauffeur, avec une clé gardée dans le trousseau sécurisé du système.</>,
            <>Sauvegarde de la base de données et des fichiers chaque nuit, par l&apos;éditeur, sur son serveur ; chaque sauvegarde est gardée 14 jours puis effacée ; mises à jour de sécurité régulières.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="6. Sous-traitants ultérieurs">
        <p>
          La centrale donne une autorisation générale au recours aux sous-traitants ci-dessous. L&apos;éditeur
          l&apos;informe au moins 30 jours à l&apos;avance de tout ajout ou remplacement (message dans le tableau de bord
          ou e-mail au propriétaire, et mise à jour de cette page). La centrale peut s&apos;y opposer pour un motif
          légitime lié à la protection des données ; à défaut de solution, elle peut résilier le service concerné sans
          frais. L&apos;éditeur impose à chaque sous-traitant les mêmes obligations de protection et reste responsable de
          leur respect.
        </p>
        <ProcessorTable rows={processors} />
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
          L&apos;éditeur fournit à la centrale la documentation utile à son analyse d&apos;impact (AIPD), notamment pour
          la géolocalisation des chauffeurs, et à une éventuelle consultation préalable de la CNIL. Chaque partie tient
          son registre des traitements ; celui de l&apos;éditeur, en tant que sous-traitant, est communiqué sur demande.
        </p>
      </LegalSection>

      <LegalSection title="11. Durées de conservation et fin du contrat">
        <LegalList
          items={[
            <>Historique des positions GPS, y compris la position relevée lors d&apos;une alerte de course (chauffeur immobile, GPS muet) : 30 jours, ou jusqu&apos;à la clôture de l&apos;alerte si elle reste ouverte plus longtemps ; la dernière position connue est remplacée à chaque envoi.</>,
            <>Messages, signalements de la flotte (y compris leur copie dans le journal de la centrale) et signalements de messages : 180 jours ; un message retiré par la centrale disparaît aussitôt de l&apos;application, du tableau de bord et des alertes enregistrées (une notification déjà affichée sur un téléphone y reste jusqu&apos;à ce que son destinataire l&apos;efface) et il est effacé à la même échéance. Auteurs masqués par un chauffeur : tant que les deux comptes existent.</>,
            <>Notifications, y compris les relances WhatsApp : 90 jours après leur envoi prévu, quel que soit leur résultat. Journaux d&apos;appels de l&apos;API : 90 jours.</>,
            <>Journal des actions sensibles : pendant le contrat. Les adresses IP et navigateurs qu&apos;il contient (inscription par lien, actions sensibles) et l&apos;historique des connexions tenu par le service d&apos;authentification : 1 an ; ceux d&apos;un chauffeur qui supprime son compte sont effacés dès la suppression.</>,
            <>Courses, gains, commissions et règlements : 10 ans après la fin de l&apos;année de la course (obligations comptables), puis supprimés, y compris une course jamais terminée ; sans l&apos;identité d&apos;un chauffeur qui a supprimé son compte.</>,
            <>Justificatifs des chauffeurs, y compris les versions remplacées : tant que le compte du chauffeur existe ; supprimés avec leurs fichiers dès la suppression du compte.</>,
            <>Bannissement pour fraude : empreintes des identifiants, motif et signalement effacés 3 ans après le bannissement, même si le compte du chauffeur existe toujours ; si le compte est supprimé, son nom et les indices partiels des empreintes sont effacés aussitôt.</>,
            <>Chauffeur qui supprime son compte en devant encore des commissions à la centrale : empreintes (hachages, sans indice en clair) de son téléphone, de ses adresses e-mail et de son numéro de carte VTC, gardées pour le compte de la centrale (constatation, exercice ou défense de ses droits en justice) tant qu&apos;une somme reste due, puis effacées ; elles empêchent seulement la validation automatique d&apos;une nouvelle candidature par lien avec ces identifiants et signalent à la centrale le montant restant dû.</>,
          ]}
        />
        <p>
          À la fin du contrat, le compte de la centrale est archivé : plus aucun accès au service. Sur demande écrite de
          la centrale avant la fin du contrat, l&apos;éditeur lui restitue ses données (export au format CSV, transmis
          par un moyen sécurisé). Il supprime ensuite, dans les 30 jours et selon sa procédure interne documentée, les
          données personnelles traitées pour son compte (comptes des chauffeurs et candidats, avec leurs justificatifs et
          leurs fichiers ; courses et coordonnées des clients ; messages ; positions ; comptes de l&apos;équipe et journal
          de leurs actions ; mini-site), copies comprises, sauf obligation légale de conservation ; les sauvegardes, gardées
          14 jours, en disparaissent à l&apos;expiration de ce cycle. Il conserve, comme responsable de traitement distinct, la fiche
          archivée de la centrale, le registre des frais plateforme et les paiements, avec le journal des actions qui s&apos;y
          rapportent (obligations comptables, 10 ans au moins) et la preuve d&apos;acceptation des CGV et du présent accord, avec l&apos;e-mail de la personne qui les a
          acceptés (preuve du contrat).
        </p>
      </LegalSection>

      <LegalSection title="12. Audits">
        <p>
          L&apos;éditeur met à disposition la documentation nécessaire pour démontrer le respect du présent accord. La
          centrale peut, une fois par an, faire réaliser un audit sur site, avec un préavis de 30 jours, à ses frais, par
          un auditeur indépendant tenu au secret et non concurrent de l&apos;éditeur, sans accès aux données des autres
          centrales ni perturbation du service.
        </p>
      </LegalSection>

      <LegalSection title="13. Obligations de la centrale">
        <p>
          La centrale s&apos;assure que ses traitements reposent sur une base légale et informe les personnes concernées :
          ses chauffeurs (géolocalisation, notifications, relances WhatsApp auxquelles ils ont consenti, règles de
          commission et de blocage), ses clients (identité de l&apos;exploitant, usage de leurs coordonnées) et son équipe.
          Elle ne saisit que des données nécessaires et aucune donnée sensible (santé notamment).
        </p>
      </LegalSection>

      <LegalSection title="14. Contact">
        <p>Contact « données personnelles » de l&apos;éditeur : {contact}.</p>
      </LegalSection>
    </LegalPage>
  );
}
