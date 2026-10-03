import type { Metadata } from "next";
import Link from "next/link";
import { legalContact } from "@/components/legal/legal-contact";
import { LegalList, LegalPage, LegalSection } from "@/components/legal/legal-page";
import { LEGAL_VERSION, PRIVACY_UPDATED_AT, getLegalInfo } from "@/lib/legal";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Politique de confidentialité — Rydar Drive" },
  description:
    "Données traitées par Rydar Drive pour les chauffeurs, les candidats, les clients des centrales, les équipes et les visiteurs : finalités, bases légales, destinataires, durées et droits.",
};

export default async function PrivacyPage() {
  const legal = await getLegalInfo();
  const contact = legalContact(legal.privacyEmail);
  const link = "text-fg underline underline-offset-2";
  return (
    <LegalPage title="Politique de confidentialité" updatedAt={PRIVACY_UPDATED_AT}>
      <p>
        Rydar Drive est un logiciel de dispatch pour les centrales et flottes de VTC, édité par{" "}
        {legal.nameSet ? (
          <span className="text-fg">{legal.name}</span>
        ) : (
          <>
            la société identifiée dans les{" "}
            <Link href="/mentions-legales" className={link}>
              mentions légales
            </Link>
          </>
        )}
        {legal.address ? <>, {legal.address}</> : null} (l&apos;« éditeur »). Cette politique explique quelles données
        sont traitées, pourquoi, avec qui elles sont partagées, combien de temps elles sont gardées et comment exercer
        vos droits. Elle concerne :
      </p>
      <LegalList
        items={[
          <>les chauffeurs qui utilisent l&apos;application « Rydar Drive Chauffeur », et les candidats inscrits par le lien d&apos;une centrale ;</>,
          <>les clients et passagers dont la course est réservée sur le mini-site d&apos;une centrale, par son API ou saisie par la centrale ;</>,
          <>les utilisateurs du tableau de bord des centrales (propriétaires, administrateurs, dispatchers) ;</>,
          <>les visiteurs du site.</>,
        ]}
      />

      <LegalSection title="1. Qui est responsable">
        <LegalList
          items={[
            <><span className="text-fg">La centrale</span> (ou la flotte) avec laquelle vous travaillez ou auprès de laquelle vous réservez est responsable des données liées à son activité : ses chauffeurs et candidats, ses clients, son équipe, ses courses. Ses coordonnées figurent dans l&apos;application (Profil), en bas de son mini-site ou dans votre contrat avec elle.</>,
            <><span className="text-fg">L&apos;éditeur</span> traite ces données pour le compte de la centrale, comme sous-traitant (voir l&apos;<Link href="/dpa" className={link}>accord de traitement des données</Link>).</>,
            <>L&apos;éditeur est lui-même responsable de la sécurité de la plateforme, de la lutte contre la fraude entre centrales, des comptes et de la facturation des centrales, et de son site vitrine.</>,
          ]}
        />
        <p>Contact « données personnelles » de l&apos;éditeur : {contact.noun}.</p>
      </LegalSection>

      <LegalSection title="2. Chauffeurs et candidats : données traitées">
        <LegalList
          items={[
            <>Identité et contact : prénom, nom, téléphone, e-mail, photo éventuelle ajoutée par la centrale. Le mot de passe est conservé sous forme hachée par le service d&apos;authentification.</>,
            <>Activité professionnelle : numéro de carte professionnelle VTC, véhicule (marque, modèle, couleur, plaque, catégorie, nombre de places), message joint à une candidature.</>,
            <>Justificatifs envoyés depuis l&apos;application : carte VTC, permis, pièce d&apos;identité, assurance, carte grise…, avec leur numéro et leur date d&apos;échéance. Aucun justificatif médical ni aucune autre donnée de santé n&apos;est demandé.</>,
            <>
              Position GPS, avec cap, vitesse, précision et <span className="text-fg">niveau de batterie</span> du téléphone : en continu
              lorsque vous êtes <span className="text-fg">EN LIGNE</span> ou en course, y compris application en arrière-plan ou
              téléphone verrouillé. Le niveau de batterie n&apos;est gardé qu&apos;avec la dernière position connue : il aide la
              centrale à comprendre une position qui n&apos;arrive plus (téléphone presque déchargé). Ponctuellement, lorsque vous publiez un signalement pour la flotte (contrôle, accident,
              bouchon…), sa position est enregistrée et montrée aux chauffeurs de votre flotte, <span className="text-fg">même hors ligne</span>.
            </>,
            <>
              Appareil : identifiant de l&apos;appareil (Android : identifiant ANDROID_ID, qui reste le même après une
              réinstallation ; iPhone : identifiant aléatoire gardé dans le trousseau, conservé après une réinstallation), utilisé
              pour les notifications et pour prévenir la fraude ; nom et modèle de l&apos;appareil, système et version,
              version de l&apos;application, jeton de notification.
            </>,
            <>Activité : offres reçues, acceptées, refusées ou manquées, courses et trajets, horaires, alertes (retard, position non reçue), gains, commissions, règlements et paiements déclarés.</>,
            <>Messages avec la centrale et dans le fil « Chauffeurs », signalements pour la flotte et votes, signalements de messages, et auteurs que vous avez masqués (visibles de vous seul).</>,
            <>Journal de sécurité : adresse IP et navigateur utilisés pour l&apos;inscription par lien, y compris une inscription refusée, et e-mail de la candidature ; historique des connexions au compte (date, e-mail, nom, adresse IP), tenu par le service d&apos;authentification.</>,
            <>Preuve d&apos;acceptation des CGU et de cette politique (document, version, date), enregistrée à l&apos;inscription par lien ou dans l&apos;application, avant son utilisation puis à chaque nouvelle version.</>,
          ]}
        />
        <p>
          Votre téléphone, votre e-mail, vos numéros de carte VTC, de permis et de pièce d&apos;identité et la plaque de
          votre véhicule (à l&apos;inscription, puis à chaque modification ou envoi de justificatif), ainsi que
          l&apos;identifiant de votre appareil (à la première connexion de l&apos;application sur ce téléphone), sont
          comparés aux empreintes des identités bannies pour fraude (voir l&apos;article 9). En cas de correspondance,
          l&apos;inscription, l&apos;enregistrement de la fiche ou du justificatif est refusé ; pour un appareil, la
          candidature est refusée ou le compte suspendu automatiquement, et la centrale est alertée. Vous pouvez demander
          qu&apos;une personne réexamine cette décision (article 5).
        </p>
        <p>
          À l&apos;inscription par lien, votre téléphone, votre e-mail et votre numéro de carte VTC sont aussi comparés aux
          empreintes des anciens comptes de la centrale supprimés alors qu&apos;ils lui devaient encore des commissions
          (article 9) : en cas de correspondance, la candidature n&apos;est jamais validée automatiquement ; la centrale
          l&apos;examine et voit le montant restant dû.
        </p>
      </LegalSection>

      <LegalSection title="3. Clients et passagers : données traitées">
        <p>
          Nom, téléphone, e-mail (facultatif), adresses de départ et d&apos;arrivée, date et heure, nombre de passagers
          et de bagages, numéro de vol éventuel, précisions, prix et mode de paiement. Vous les saisissez sur le mini-site
          de la centrale, ou la centrale les enregistre (téléphone, son propre site par l&apos;API). Aucun compte client
          n&apos;est créé. Ces données sont transmises à la centrale nommée sur le mini-site, qui organise la course : aucune case à
          cocher ne vous est demandée pour cela. L&apos;adresse IP de l&apos;appareil qui envoie une réservation sert, sous
          forme d&apos;empreinte, à limiter les abus du formulaire (compteurs effacés au bout de 24 heures au plus).
        </p>
      </LegalSection>

      <LegalSection title="4. Équipes des centrales et visiteurs">
        <LegalList
          items={[
            <>Utilisateurs du tableau de bord : nom, e-mail, téléphone, rôle, centrales gérées, journal des actions sensibles (qui, quoi, quand, adresse IP et navigateur), historique des connexions (date, e-mail, adresse IP), preuve d&apos;acceptation des CGU et de cette politique (document, version, date). Pour la centrale cliente : coordonnées de facturation et paiements.</>,
            <>Acceptation des CGV et de l&apos;accord de traitement au nom d&apos;une centrale : date, version et e-mail de la personne qui a accepté, gardés comme preuve du contrat même si son compte est supprimé.</>,
            <>Moyens de paiement que la centrale propose à ses chauffeurs (lien de paiement, bénéficiaire, IBAN et BIC, consignes) : visibles de son équipe et des chauffeurs à qui ils sont proposés, modifiables par le propriétaire et les administrateurs seulement.</>,
            <>Visiteurs : aucune mesure d&apos;audience ni publicité. Le serveur reçoit, comme tout site, l&apos;adresse IP et le navigateur : aucun journal des pages consultées n&apos;est tenu ; les limites anti-abus (connexion, formulaires) comptent les demandes par empreinte de l&apos;adresse IP, effacée au bout de 24 heures au plus ; les journaux techniques du serveur (erreurs, fonctionnement) servent à la sécurité et au diagnostic (article 9). Voir la <Link href="/cookies" className={link}>politique cookies</Link>.</>,
            <>Formulaire de contact (demande de tarif, question, partenariat) : nom, adresse e-mail et message, et si vous les indiquez société, téléphone, taille de flotte et offre visée ; une empreinte (hachage) de l&apos;adresse IP, pour prévenir les envois abusifs ; les e-mails échangés à propos de la demande (accusé de réception, réponses).</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="5. Pourquoi, et sur quelle base légale">
        <LegalList
          items={[
            <>Proposer automatiquement les courses aux chauffeurs les plus proches (4 km, puis 8 km, 12 km…), suivre l&apos;approche et la course, guider le chauffeur : exécution du contrat entre le chauffeur et la centrale, et entre le client et la centrale.</>,
            <>Examiner une candidature, vérifier les justificatifs et rappeler leurs échéances : mesures précontractuelles et obligations légales de la centrale (Code des transports).</>,
            <>Calculer gains, commissions et règlements, tenir la comptabilité : exécution du contrat et obligation légale.</>,
            <>Envoyer les offres, messages, rappels et relances de commission par notification dans l&apos;application : exécution du contrat.</>,
            <>Envoyer les relances de commission par WhatsApp, si la centrale les active : exécution du contrat qui vous lie à la centrale (somme due), avec votre accord préalable, que la centrale s&apos;engage à recueillir (<Link href="/cgv#article-10" className={link}>conditions générales de vente, article 10</Link>). Pour ne plus les recevoir par WhatsApp, prévenez la centrale : elle peut faire partir ses relances par l&apos;application seule (réglage commun à tous ses chauffeurs).</>,
            <>Relancer par WhatsApp le propriétaire d&apos;une centrale à commission pour les frais plateforme : exécution du contrat entre la centrale et l&apos;éditeur (conditions générales de vente).</>,
            <>Assurer la sécurité, prévenir la fraude, bannir un auteur de fraude : intérêt légitime de la centrale et de l&apos;éditeur.</>,
            <>Garder, après la suppression d&apos;un compte, les empreintes d&apos;un chauffeur qui doit encore des commissions à la centrale : constatation, exercice ou défense des droits de la centrale en justice (article 17.3.e du RGPD), l&apos;éditeur agissant pour son compte.</>,
            <>Gérer les comptes des centrales, les abonnements et les frais plateforme : exécution du contrat entre la centrale et l&apos;éditeur, et obligations comptables.</>,
            <>Répondre à une demande envoyée par le formulaire de contact et en accuser réception : mesures précontractuelles prises à votre demande, et intérêt légitime de l&apos;éditeur à répondre aux personnes qui le contactent.</>,
            <>Traiter les signalements de contenus illicites et répondre aux autorités : obligation légale.</>,
            <>Établir des statistiques anonymes pour améliorer le service : intérêt légitime de l&apos;éditeur.</>,
          ]}
        />
        <p>
          Certaines décisions sont prises automatiquement, sans intervention humaine. Elles reposent sur
          l&apos;article 22.2.a du RGPD : elles sont nécessaires à la conclusion et à l&apos;exécution du contrat qui vous lie
          à la centrale, et au respect des CGU (prévention de la fraude entre centrales) :
        </p>
        <LegalList
          items={[
            <>l&apos;attribution des offres, selon la distance au point de départ, la catégorie du véhicule et les règles fixées par la centrale (par exemple un blocage en cas de commission impayée) : vous recevez ou non une offre ;</>,
            <>le refus d&apos;une inscription ou d&apos;une candidature, ou la suspension d&apos;un compte, lorsqu&apos;une identité ou un appareil correspond à une personne bannie pour fraude (article 2) : la logique est une comparaison exacte d&apos;empreintes (hachages) de vos identifiants (téléphone, e-mail, numéros de carte VTC, de permis et de pièce d&apos;identité, plaque, identifiant d&apos;appareil) avec celles d&apos;une personne bannie ; la conséquence est le refus de l&apos;inscription, de la fiche ou du justificatif, ou la suspension du compte, et une alerte à la centrale.</>,
          ]}
        />
        <p>
          Vous pouvez présenter vos observations, contester la décision et demander qu&apos;une personne la réexamine :
          adressez-vous à la centrale, ou {contact.to} pour un bannissement décidé par l&apos;éditeur. Aucune donnée
          n&apos;est vendue, utilisée pour de la publicité ou pour vous suivre sur d&apos;autres applications.
        </p>
        <p>
          Données obligatoires ou facultatives : dans chaque formulaire, les champs facultatifs sont marqués
          « optionnel » ; les autres sont nécessaires au service demandé, et sans eux l&apos;inscription, la réservation ou
          la demande ne peut pas être envoyée. La position est nécessaire pour recevoir des courses : sans elle,
          l&apos;application ne passe pas en ligne. Les justificatifs demandés par la centrale lui servent à respecter la
          réglementation du transport : sans eux, elle peut refuser de vous proposer des courses.
        </p>
      </LegalSection>

      <LegalSection title="6. Localisation en arrière-plan">
        <p>
          Quand vous êtes EN LIGNE, l&apos;application continue de partager votre position si vous changez
          d&apos;application ou verrouillez votre téléphone, pour que les courses proches continuent de vous être
          proposées. Seule l&apos;autorisation « Pendant l&apos;utilisation » est demandée, après une information
          préalable. Sur Android, une notification « Rydar Drive — EN LIGNE » l&apos;indique en permanence ; sur iPhone,
          l&apos;indicateur de localisation s&apos;affiche. Passer hors ligne ou fermer l&apos;application arrête le
          suivi continu (application fermée, vous passez hors ligne au bout de quelques minutes, jamais pendant une
          course) ; seul un signalement que vous publiez envoie ensuite votre position.
        </p>
      </LegalSection>

      <LegalSection title="7. Destinataires">
        <LegalList
          items={[
            <>Votre centrale (propriétaire, administrateurs, dispatchers) : toutes les données de ses chauffeurs, candidats, clients et courses, dont le fil « Chauffeurs » et les signalements, sauf les auteurs qu&apos;un chauffeur a masqués.</>,
            <>Les autres chauffeurs de votre flotte : votre prénom et l&apos;initiale de votre nom avec vos messages du fil « Chauffeurs » et vos signalements (avec leur position).</>,
            <>Les chauffeurs à qui une course est proposée (les plus proches pour une course immédiate, tous les chauffeurs compatibles de la centrale pour une course planifiée) : adresses de départ et d&apos;arrivée, date et heure, nombre de passagers et de bagages, numéro et provenance du vol, précisions et prix, sans le nom ni le téléphone du client. Le chauffeur attribué reçoit en plus le nom et le téléphone du client.</>,
            <>Le client : seulement ce que la centrale lui communique, par exemple le prénom du chauffeur et le modèle, la couleur et la plaque du véhicule (que l&apos;API remet à la centrale). Le logiciel ne montre pas la position du chauffeur au client.</>,
            <>L&apos;éditeur (support, sécurité, traitement des signalements, facturation) : il peut consulter les données des centrales, y compris le fil « Chauffeurs » et la carte des chauffeurs en ligne, dans la limite de ces missions.</>,
            <>Demandes du formulaire de contact : l&apos;éditeur seul, dans son espace d&apos;administration. L&apos;e-mail qui l&apos;avertit d&apos;une nouvelle demande ne contient aucune donnée de la demande (seulement son sujet et un lien) ; l&apos;accusé de réception et les réponses partent du serveur de messagerie de l&apos;éditeur, hébergé avec le site. Si vous répondez par e-mail, votre message arrive dans la boîte de messagerie de contact de l&apos;éditeur, chez son prestataire de messagerie.</>,
            <>Les prestataires techniques de l&apos;éditeur, dans la limite de leur mission : l&apos;hébergeur du serveur de l&apos;éditeur (site, base de données, fichiers, sauvegardes et e-mails, voir les <Link href="/mentions-legales" className={link}>mentions légales</Link>), notifications et mises à jour de l&apos;application (Expo, Apple, Google), cartes, adresses et itinéraires, WhatsApp si activé, paiement des abonnements des centrales. Liste complète, avec les services publics tiers utilisés pour les cartes, les adresses et les itinéraires (OpenFreeMap, IGN, OSRM), dans l&apos;<Link href="/dpa" className={link}>accord de traitement des données</Link>.</>,
            <>Les autorités, lorsque la loi l&apos;exige.</>,
          ]}
        />
        <p className="text-fg">
          Ces prestataires sont tenus d&apos;assurer à vos données une protection équivalente à celle décrite dans cette
          politique.
        </p>
      </LegalSection>

      <LegalSection title="8. Transferts hors de l'Union européenne">
        <p>
          Les données sont hébergées dans l&apos;Union européenne, sur le serveur de l&apos;éditeur, qui porte le site, la
          base de données, les fichiers, les sauvegardes et le serveur d&apos;envoi des e-mails (hébergeur et lieu : voir
          les <Link href="/mentions-legales" className={link}>mentions légales</Link>). Certains prestataires sont situés aux États-Unis
          ou y transfèrent des données (notifications et mises à jour de l&apos;application, cartes de l&apos;application,
          WhatsApp, paiement des abonnements des centrales, et selon la configuration adresses, itinéraires et suivi des
          vols) : ces transferts sont encadrés par le Data Privacy
          Framework UE–États-Unis ou par les clauses contractuelles types de la Commission européenne.
        </p>
      </LegalSection>

      <LegalSection title="9. Durées de conservation">
        <LegalList
          items={[
            <>Compte, véhicule et justificatifs, y compris les versions remplacées par un nouvel envoi : tant que le compte existe (sa suppression est décrite à l&apos;article 10).</>,
            <>Historique des positions, y compris la position relevée lors d&apos;une alerte de course (chauffeur immobile, GPS muet) : 30 jours, ou jusqu&apos;à la clôture de l&apos;alerte si elle reste ouverte plus longtemps. La dernière position connue est remplacée à chaque envoi.</>,
            <>Messages, signalements pour la flotte (y compris leur copie dans le journal de la centrale) et signalements de messages : 180 jours. Un message retiré par la centrale disparaît aussitôt de l&apos;application, du tableau de bord et des alertes enregistrées ; une notification déjà affichée sur un téléphone y reste jusqu&apos;à ce que son destinataire l&apos;efface. Il est effacé à la même échéance. Auteurs masqués : tant que les deux comptes existent.</>,
            <>Notifications, y compris les relances WhatsApp : 90 jours après leur envoi prévu, qu&apos;elles aient abouti ou non. Journaux d&apos;appels de l&apos;API, et dernière adresse IP d&apos;utilisation d&apos;une clé d&apos;API : 90 jours.</>,
            <>Demandes du formulaire de contact : 3 ans après leur envoi, puis supprimées avec les e-mails qui s&apos;y rapportent, y compris ceux reçus dans la boîte de messagerie de contact de l&apos;éditeur ; une demande classée indésirable, 30 jours après ce classement. L&apos;empreinte de l&apos;adresse IP est effacée au bout d&apos;un an. Vous pouvez demander l&apos;effacement plus tôt (article 11).</>,
            <>Adresse IP et navigateur enregistrés dans le journal de sécurité (inscription par lien, actions sensibles de l&apos;équipe) et historique des connexions du service d&apos;authentification : 1 an ; ceux d&apos;un chauffeur qui supprime son compte sont effacés dès la suppression.</>,
            <>Sessions de connexion ouvertes (adresse IP et navigateur de l&apos;appareil, tenus par le service d&apos;authentification) : jusqu&apos;à la déconnexion ou à la suppression du compte, et 400 jours au plus sans utilisation.</>,
            <>Journaux techniques du serveur (fonctionnement et erreurs des services, requêtes reçues par la base de données et le service d&apos;authentification, avec l&apos;adresse IP) : 1 an au plus. Compteurs anti-abus (empreinte de l&apos;adresse IP) : 24 heures au plus.</>,
            <>Sauvegardes de la base de données et des fichiers : faites chaque nuit, chacune gardée 14 jours puis effacée ; une donnée supprimée du service disparaît des sauvegardes au plus tard 14 jours après.</>,
            <>Copies des e-mails envoyés par le service : celles d&apos;une demande de contact, avec la demande (3 ans) ; annonces de frais plateforme et de nouvelles conditions adressées aux centrales, 10 ans (preuve de l&apos;annonce) ; autres e-mails (tests, notifications), 1 an.</>,
            <>Courses (y compris les coordonnées du client), gains, commissions et règlements : 10 ans après la fin de l&apos;année de la course, pour les obligations comptables de la centrale, puis supprimés, y compris une course jamais terminée.</>,
            <>Comptes et journal des actions de l&apos;équipe d&apos;une centrale : tant qu&apos;elle utilise le service, puis supprimés dans les 30 jours qui suivent la fin du contrat, sauf les actions sur les frais plateforme et leurs paiements, gardées avec ce registre comptable.</>,
            <>Preuves d&apos;acceptation : celle des CGU et de cette politique reste, détachée du compte s&apos;il est supprimé (document, version, date) ; celle des CGV et de l&apos;accord de traitement, avec l&apos;e-mail de la personne qui les a acceptés, est gardée comme preuve du contrat, y compris après sa fin (la fiche de la centrale est alors archivée, jamais supprimée).</>,
            <>
              Bannissement pour fraude : la centrale conserve des empreintes de vos identifiants (téléphone, e-mail, numéros
              de carte VTC, de permis et de pièce d&apos;identité, identifiant d&apos;appareil, plaque si le véhicule est
              banni) et le motif ; si elle le signale à l&apos;éditeur, celui-ci conserve aussi le signalement (nom, motif,
              date). Les empreintes sont des hachages sha256 : elles ne sont pas chiffrées, mais ne font pas apparaître la
              valeur en clair ; un indice partiel les accompagne (par exemple +33••••••78). Seuls les administrateurs de la
              centrale concernée et l&apos;éditeur ont accès aux empreintes, à leurs indices et au signalement ; le motif du
              bannissement est visible de toute l&apos;équipe de la centrale, dispatchers compris. Les empreintes servent
              uniquement à empêcher une nouvelle inscription.
              Empreintes, signalement et motif sont effacés 3 ans après le bannissement, même si le compte existe toujours ;
              une levée du bannissement met fin au blocage, l&apos;historique restant jusqu&apos;à cette échéance. Si le
              compte est supprimé, votre nom et les indices partiels sont effacés aussitôt, le reste à la même échéance.
            </>,
            <>
              Commissions dues : si vous supprimez votre compte alors que vous devez encore des commissions à la centrale, les
              empreintes (hachages sha256, sans indice en clair) de votre téléphone, de vos adresses e-mail et de votre numéro
              de carte VTC sont conservées pour le compte de la centrale, rattachées à la fiche anonyme, tant qu&apos;une somme
              reste due, puis effacées automatiquement. Elles servent uniquement à signaler à la centrale une nouvelle
              candidature avec ces identifiants (article 2) ; aucun utilisateur du service n&apos;y a accès.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection title="10. Supprimer son compte chauffeur">
        <p>
          Dans l&apos;application : <span className="text-fg">Profil › Supprimer mon compte</span>. C&apos;est possible
          aussi pour un compte en attente, refusé, suspendu, banni, ou si la centrale est suspendue, y compris depuis
          l&apos;écran de connexion lorsque la connexion est refusée : l&apos;application vous demande alors l&apos;e-mail et le mot de
          passe du compte. Sans l&apos;application, écrivez {contact.to} en indiquant l&apos;adresse e-mail du compte (l&apos;éditeur vérifie votre identité avant d&apos;agir) : la demande
          est traitée par l&apos;éditeur sous 30 jours au plus. Détails sur la page{" "}
          <Link href="/suppression-compte" className={link}>Supprimer son compte</Link>.
        </p>
        <p>
          La suppression est refusée tant qu&apos;une course vous est attribuée : terminez-la ou demandez à la centrale de
          la réattribuer. Si la centrale est suspendue ou a quitté le service, une course acceptée mais pas encore
          commencée vous est retirée automatiquement et la suppression se poursuit.
        </p>
        <LegalList
          items={[
            <><span className="text-fg">Supprimé</span> : compte de connexion et historique de ses connexions (s&apos;il sert aussi à gérer une centrale, seul le profil chauffeur est supprimé) ; nom, téléphone, e-mail, photo, numéro de carte VTC, message de candidature et notes de la centrale ; justificatifs et tous leurs fichiers ; positions et historique GPS ; appareils et jetons de notification ; notifications ; messages avec la centrale et dans le fil « Chauffeurs », signalements pour la flotte (leur copie dans le journal de la centrale et les alertes envoyées aux autres chauffeurs comprises), votes, signalements de messages, auteurs masqués et accusés de lecture ; véhicule créé à l&apos;inscription par lien s&apos;il n&apos;a servi à aucune course (sinon sa plaque, sa marque, son modèle, sa couleur et son année sont effacés).</>,
            <><span className="text-fg">Anonymisé</span>, conservé sans nom ni coordonnées pour les obligations comptables, jusqu&apos;à 10 ans après la fin de l&apos;année de chaque course : la fiche devient « Chauffeur supprimé (#N) » ; courses, règlements, gains et commissions y restent rattachés ; votre nom est retiré du journal des courses, des alertes (avec leur position) et des règlements ; le journal d&apos;audit est caviardé et l&apos;adresse IP et le navigateur de votre inscription en sont effacés ; dans le commentaire et le motif d&apos;annulation d&apos;une course, données de la centrale, seul votre nom complet est remplacé ; la preuve d&apos;acceptation des CGU et de cette politique reste, détachée de votre compte.</>,
            <><span className="text-fg">Conservé</span> en cas de bannissement pour fraude : empreintes (hachages) de vos identifiants, motif et signalement de fraude, jusqu&apos;à 3 ans après le bannissement, pour empêcher une réinscription ; votre nom et les indices partiels en sont retirés dès la suppression.</>,
            <><span className="text-fg">Conservé</span> si des commissions restent dues à la centrale : empreintes (hachages) de votre téléphone, de vos adresses e-mail et de votre numéro de carte VTC, tant qu&apos;une somme reste due (article 9). Supprimer son compte n&apos;efface pas la dette.</>,
          ]}
        />
        <p>
          Les messages écrits par d&apos;autres personnes ne sont pas modifiés : ils sont effacés au bout de 180 jours, comme
          tous les messages. Si la suppression des fichiers ou du compte de connexion ne peut pas se terminer tout de
          suite, le serveur la reprend automatiquement ; l&apos;application n&apos;annonce « compte supprimé » qu&apos;une
          fois tout terminé.
        </p>
      </LegalSection>

      <LegalSection title="11. Vos droits">
        <p>
          Vous pouvez accéder à vos données, les faire rectifier ou effacer, en demander la limitation ou la portabilité,
          vous opposer à un traitement fondé sur l&apos;intérêt légitime, retirer un accord donné, demander qu&apos;une
          personne réexamine une décision automatique, et définir des directives sur le sort de vos données après votre
          décès. Adressez-vous à la centrale concernée ou {contact.to} : l&apos;éditeur répond pour ses propres
          traitements et transmet sans délai les autres demandes à la centrale. Une réponse vous est apportée dans un
          délai d&apos;un mois. Vous pouvez aussi introduire une réclamation auprès de la CNIL (cnil.fr, 3 place de
          Fontenoy, TSA 80715, 75334 Paris Cedex 07).
        </p>
      </LegalSection>

      <LegalSection title="12. Sécurité">
        <p>
          Les échanges sont chiffrés (HTTPS). Chaque centrale n&apos;accède qu&apos;à ses propres données, grâce à un
          contrôle d&apos;accès appliqué à chaque ligne de la base. Sur le téléphone, la session est chiffrée et sa clé
          gardée dans le trousseau sécurisé du système. Les actions sensibles sont journalisées. Un compte suspendu ou
          banni est déconnecté immédiatement.
        </p>
      </LegalSection>

      <LegalSection title="13. Mineurs et modifications">
        <p>
          Le service est réservé aux personnes majeures. Cette politique peut évoluer (version {LEGAL_VERSION}) : la date
          de mise à jour figure en haut de la page. Une nouvelle version importante est présentée pour acceptation :
          dans l&apos;application aux chauffeurs, et dans le tableau de bord à chaque membre de l&apos;équipe des centrales.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
