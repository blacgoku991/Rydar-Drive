# Publier l'app chauffeur sur l'App Store et Google Play

Guide pas à pas, à suivre dans l'ordre. Les commandes se lancent depuis un ordinateur avec Node.js 20 ou plus.
Un Mac n'est pas nécessaire : EAS construit l'app dans le cloud. Les mots de passe et les clés se saisissent
uniquement dans les consoles Apple / Google / Expo ou dans le terminal, jamais dans une conversation.

## 0. Prérequis

| Quoi | Coût | Remarque |
| --- | --- | --- |
| [Apple Developer Program](https://developer.apple.com/programs/) | 99 € / an | En tant que société : numéro D-U-N-S (gratuit, quelques jours). |
| [Google Play Console](https://play.google.com/console/signup) | 25 $ une fois | **Compte personnel récent : test fermé obligatoire avec 12 testeurs pendant 14 jours avant la production.** Un compte d'organisation (D-U-N-S) en est dispensé. |
| Compte [Expo](https://expo.dev) + `npm i -g eas-cli` puis `eas login` | gratuit | Les builds gratuits suffisent pour démarrer. |

Délais indicatifs : vérification Apple 1 à 3 jours, Google quelques heures à 7 jours (plus pour un premier envoi).

## 1. Serveur à jour

1. Mettre à jour le VPS : `cd /opt/rydar && bash deploy/update-production.sh`.
2. Renseigner l'éditeur de l'app : connecté en Super Admin, **`/admin/legal`** (raison sociale, forme, capital,
   siège, RCS, TVA, directeur de la publication, e-mail et e-mail « données personnelles », hébergeurs). Ces
   informations alimentent toutes les pages légales. Les valeurs `LEGAL_*` de `deploy/configure.sh` ne sont qu'un
   repli. Aucune case ne doit rester « à compléter par l'éditeur » sur `/mentions-legales`, et l'e-mail
   « données personnelles » est **obligatoire** : c'est le contact exigé par Google et le seul recours d'un
   chauffeur qui n'a plus l'app.
3. Vérifier que ces pages s'affichent (les stores exigent au moins la confidentialité et la suppression) :
   - `https://VOTRE-DOMAINE/mentions-legales` — éditeur et hébergeurs ;
   - `https://VOTRE-DOMAINE/cgu` — conditions d'utilisation (lien « Contrat de licence » facultatif chez Apple) ;
   - `https://VOTRE-DOMAINE/confidentialite` — politique de confidentialité (URL déclarée aux deux stores) ;
   - `https://VOTRE-DOMAINE/suppression-compte` — suppression du compte (URL déclarée à Google Play).

## 2. Compte de démonstration pour les vérificateurs

Apple et Google testent l'app : il leur faut un compte chauffeur qui fonctionne.

1. Dans `/admin`, créer une organisation **« Démo App Review »** (mode flotte).
2. Dans son tableau de bord : un véhicule (catégorie Berline), puis un chauffeur avec accès à l'app
   (e-mail dédié, ex. `review@VOTRE-DOMAINE`, et un mot de passe fort réservé à cet usage).
3. Se connecter une fois avec ce compte sur un téléphone pour vérifier. L'app affiche d'abord l'écran
   d'acceptation des conditions d'utilisation et de la politique de confidentialité (tous les chauffeurs, à la
   première connexion puis à chaque nouvelle version) : c'est normal.
4. **Avant chaque envoi aux stores**, créer dans « Démo App Review » **2 ou 3 courses planifiées** : catégorie
   Berline, prise en charge dans **10 à 15 jours**, 1 passager, un prix. Pourquoi : une offre instantanée ne part
   qu'aux chauffeurs situés à 4, 8, 12 puis 16 km du client, avec une position fraîche ; le vérificateur (souvent en
   Californie) n'en recevrait jamais. Une course planifiée, elle, est proposée à **tout** chauffeur actif compatible
   de la centrale, **sans condition de position ni de présence** : le vérificateur la voit dans **Planning** (icône
   calendrier) où qu'il soit, peut la prendre, puis dérouler la course (« Aller au départ », guidage, étapes,
   fin de course).
   - Les offres restent ouvertes jusqu'à la prise en charge moins le délai de bascule
     (`scheduled_dispatch_lead_minutes`, 60 min par défaut) : à 10 jours, elles tiennent toute la vérification.
   - Après la vérification, annuler les courses prises ou restantes et en recréer avant l'envoi suivant.
5. Filmer une courte vidéo (YouTube non répertoriée) avec un vrai téléphone : offre **instantanée** avec sonnerie,
   téléphone verrouillé, app EN LIGNE en arrière-plan, guidage, suppression du compte (avec un compte de test
   jetable, pas celui de démonstration). La joindre à la note Apple
   (§ 7) et à « Accès à l'application » chez Google.

## 3. Projet EAS et variables de l'app (une fois)

```bash
cd apps/driver
eas init          # crée ou relie le projet Expo et affiche son identifiant (projectId)
```

L'identifiant du projet n'est pas un secret. Il est lu dans `EAS_PROJECT_ID`. Pour les builds dans le cloud,
créer ces variables dans l'environnement **production** d'EAS (site expo.dev › projet › Environment variables,
ou `eas env:create`) :

| Variable | Valeur |
| --- | --- |
| `EAS_PROJECT_ID` | identifiant affiché par `eas init` |
| `EXPO_PUBLIC_SUPABASE_URL` | URL Supabase de production |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | clé publique (anon) Supabase |
| `EXPO_PUBLIC_API_URL` | `https://VOTRE-DOMAINE` |
| `GOOGLE_MAPS_ANDROID_KEY` | clé Google Maps SDK for Android (carte Android) |
| `APP_LINK_DOMAIN` | facultatif : domaine des liens `https://DOMAINE/rejoindre/{code}` qui ouvrent l'app (liens universels iOS, liens d'application Android) ; par défaut, celui d'`EXPO_PUBLIC_API_URL`. Réglage natif : le changer demande un nouveau build (§ 10) |

Dans le terminal, avant chaque commande `eas`, exporter aussi l'identifiant pour que la configuration locale le
voie : `export EAS_PROJECT_ID=…` (ou le placer dans `apps/driver/.env`, ignoré par git).

Identifiants de l'app : `app.rydar.driver` sur les deux plateformes (modifiables avant le premier envoi avec
`APNS_BUNDLE_ID` / `ANDROID_PACKAGE`, plus jamais ensuite).

## 4. Construire

```bash
cd apps/driver
eas build -p ios --profile production       # .ipa signé (EAS crée certificats et profils)
eas build -p android --profile production   # .aab signé (EAS crée la clé d'envoi)
```

Le numéro de build s'incrémente tout seul. La version affichée est `version` dans `apps/driver/app.config.ts`
(1.1.0 aujourd'hui).

Avant le premier envoi, puis après tout changement natif, contrôler l'Info.plist et le manifeste générés :
`cd apps/driver && npx expo config --type introspect`. Attendu : `UIBackgroundModes` = `location` uniquement,
textes d'autorisation iOS (localisation, mouvement) en français, pas de `NSFaceIDUsageDescription` ; côté Android,
ni `ACCESS_BACKGROUND_LOCATION` ni exemption d'optimisation de la batterie.

## 5. App Store (iPhone)

1. [App Store Connect](https://appstoreconnect.apple.com) › Apps › **+** › Nouvelle app : plateforme iOS, nom
   **« Rydar Drive Chauffeur »** (doit être unique), langue principale Français, identifiant de lot
   `app.rydar.driver`, SKU `rydar-driver`.
2. Envoyer le build : `eas submit -p ios --latest` (EAS demande la connexion Apple ou une clé App Store Connect).
3. **TestFlight** : installer le build sur un iPhone, vérifier connexion, passage en ligne, sonnerie d'une offre.
4. Remplir la fiche (textes au § 7) : sous-titre, description, mots-clés, URL d'assistance
   (`https://VOTRE-DOMAINE`), URL de confidentialité (`https://VOTRE-DOMAINE/confidentialite`), catégorie
   **Économie et entreprise** (secondaire : Navigation), captures (§ 8), âge 4+.
5. **Confidentialité de l'app** (App Privacy). Réponse générale : « Oui, nous collectons des données ». Pour
   **chaque** type ci-dessous : utilisation « Fonctionnalités de l'app » (qui couvre aussi la sécurité et la
   prévention de la fraude), **liée à l'utilisateur : oui**, **suivi (tracking) : non**. Aucune donnée n'est
   utilisée pour la publicité ni pour l'analyse. Le tableau reprend exactement `/confidentialite` :

   | Catégorie Apple › type | Ce que l'app envoie |
   | --- | --- |
   | Coordonnées › Nom, Adresse e-mail, Numéro de téléphone | prénom, nom, e-mail, téléphone (compte, candidature) |
   | Localisation › Localisation précise | position GPS EN LIGNE et en course, **y compris en arrière-plan** ; position jointe à un signalement, même hors ligne |
   | Contenu utilisateur › Photos ou vidéos | photos des justificatifs (carte VTC, permis, pièce d'identité, assurance…) |
   | Contenu utilisateur › Autre contenu de l'utilisateur | messages (centrale, fil « Chauffeurs »), signalements de la flotte et votes, signalements de messages |
   | Infos financières › Autres infos financières | gains, commissions, règlements, paiements déclarés |
   | Identifiants › Identifiant de l'utilisateur | identifiant du compte chauffeur |
   | Identifiants › Identifiant de l'appareil | identifiant de l'appareil (iPhone : identifiant aléatoire gardé dans le trousseau, conservé après réinstallation), jeton de notification, identifiant d'installation envoyé à Expo pour les mises à jour de l'app |
   | Diagnostics › Autres données de diagnostic | niveau de batterie (envoyé avec chaque position), nom et modèle de l'appareil, version du système et de l'app |
   | Autres données › Autres types de données | n° de carte VTC, véhicule (marque, modèle, couleur, plaque), numéros et échéances des justificatifs, offres acceptées ou refusées |

   Sur iPhone, la carte est celle d'Apple (Plans) : aucun SDK tiers de cartographie ni de mesure d'audience.

6. **Informations pour la vérification** : compte de démonstration (§ 2) et la note du § 7.
7. Chiffrement : déjà déclaré (aucun chiffrement non exempté), rien à fournir.
8. Soumettre pour vérification, publication manuelle ou automatique.

## 6. Google Play (Android)

1. [Play Console](https://play.google.com/console) › Créer une application : nom **« Rydar Drive Chauffeur »**,
   langue Français, Application, Gratuite.
2. **Premier envoi manuel** (exigé par Google) : Tests › Tests internes › Créer une version › importer le `.aab`
   téléchargé depuis expo.dev. Ensuite, les envois se font avec `eas submit -p android --latest`, qui nécessite
   un compte de service Google : Play Console › Configuration › Accès API, puis clé JSON enregistrée dans
   `apps/driver/secrets/google-play-service-account.json` (dossier ignoré par git, ne jamais le partager).
3. **Contenu de l'application** (menu Règles) :
   - Règles de confidentialité : `https://VOTRE-DOMAINE/confidentialite` ;
   - Accès à l'application : « Tout ou partie de l'app est soumise à restrictions » + compte de démonstration,
     avec les mêmes instructions que la note Apple (§ 7 : Planning, courses planifiées) et le lien de la vidéo (§ 2) ;
   - Annonces : non ; Classification du contenu : questionnaire (aucun contenu sensible) ; Public cible : 18 ans et plus ;
   - **Sécurité des données** (cohérent avec `/confidentialite` ; Google compare le formulaire, la politique et
     les SDK de l'app) :

     | Catégorie Google › type | Ce que l'app envoie | Collectées | Partagées | Finalités | Facultatif |
     | --- | --- | --- | --- | --- | --- |
     | Position › Position exacte | GPS EN LIGNE et en course, y compris en arrière-plan (service de premier plan) ; position d'un signalement, même hors ligne | Oui | Non | Fonctionnalités de l'appli | Non |
     | Infos personnelles › Nom, Adresse e-mail, Numéro de téléphone | compte et candidature | Oui | Non | Fonctionnalités de l'appli, Gestion des comptes, Prévention des fraudes, sécurité et conformité | Non |
     | Infos personnelles › ID utilisateur | identifiant du compte chauffeur | Oui | Non | Fonctionnalités de l'appli, Gestion des comptes | Non |
     | Infos personnelles › Autres infos | n° de carte VTC, véhicule et plaque, numéros et échéances des justificatifs | Oui | Non | Fonctionnalités de l'appli, Prévention des fraudes, sécurité et conformité | Non |
     | Infos financières › Autres informations financières | gains, commissions, règlements | Oui | Non | Fonctionnalités de l'appli | Non |
     | Messages › Autres messages dans l'appli | messages, fil « Chauffeurs », signalements | Oui | Non | Fonctionnalités de l'appli | Oui |
     | Photos et vidéos › Photos | photos des justificatifs | Oui | Non | Fonctionnalités de l'appli | Oui |
     | Activité dans les applis › Autres actions | offres acceptées, refusées ou manquées, étapes des courses | Oui | Non | Fonctionnalités de l'appli | Non |
     | Infos et performances de l'appli › Diagnostics | niveau de batterie, nom et modèle de l'appareil, versions du système et de l'app | Oui | Non | Fonctionnalités de l'appli | Non |
     | Identifiants de l'appareil ou autres › Identifiants de l'appareil ou autres | ANDROID_ID (conservé après réinstallation), jeton de notification, identifiant d'installation envoyé à Expo pour les mises à jour de l'appli | Oui | Non | Fonctionnalités de l'appli, Prévention des fraudes, sécurité et conformité | Non |

     - « Partagées : non » : les données vont à la centrale pour laquelle l'app fonctionne et aux prestataires de
       l'éditeur (hébergement, notifications), ce que Google ne compte pas comme un partage ; un signalement
       montré aux autres chauffeurs est une action du chauffeur lui-même.
     - Ajouter les données que Google déclare pour le **Maps SDK for Android** (carte de l'app sur Android) :
       Google Maps Platform › « Google Play data disclosure » du Maps SDK for Android, à reporter tel quel.
     - Données chiffrées en transit : oui. Suppression possible : oui (dans l'app et
       `https://VOTRE-DOMAINE/suppression-compte`, aussi à déclarer comme URL de suppression du compte). Cette page
       dit ce qui est supprimé, ce qui est anonymisé ou conservé (courses et règlements : 10 ans, obligations
       comptables ; empreintes d'un compte banni pour fraude : 3 ans ; empreintes d'un chauffeur qui doit encore des
       commissions à sa centrale : tant que la dette reste ouverte) et pendant combien de temps, comme l'exige
       Google.
   - **Autorisations de service de premier plan** : type « Localisation » ; description (§ 7) et lien vers une
     courte vidéo (YouTube non répertoriée) : passer EN LIGNE, notification « Rydar Drive — EN LIGNE », app en
     arrière-plan, passer hors ligne. L'app ne demande **pas** la position en arrière-plan
     (`ACCESS_BACKGROUND_LOCATION`) : pas de déclaration supplémentaire.
4. **Fiche Play Store** : description courte et longue (§ 7), icône 512 × 512, image de présentation
   1024 × 500, captures (§ 8).
5. Compte personnel : **Tests › Test fermé** avec au moins 12 testeurs (adresses Gmail) pendant 14 jours, puis
   demande d'accès à la production. Compte d'organisation : passer directement à **Production**.

## 7. Textes prêts à copier

**Nom** : Rydar Drive Chauffeur
**Sous-titre (iOS, 30 caractères)** : Courses VTC de votre centrale
**Description courte (Google, 80 caractères)** : L'app des chauffeurs VTC : courses proches, guidage, gains et messages.
**Mots-clés (iOS, 100 caractères)** : vtc,chauffeur,taxi,courses,dispatch,centrale,flotte,chauffeur privé,navigation,planning

**Description** :

> Rydar Drive est l'application des chauffeurs VTC dont la centrale ou la flotte travaille avec Rydar Drive.
>
> • Passez EN LIGNE : les courses proches vous sont proposées automatiquement, avec sonnerie, même téléphone verrouillé ou dans une autre application.
> • Acceptez d'un geste : départ, destination, distance et prix (ou votre part) affichés avant d'accepter.
> • Guidage intégré jusqu'au client puis à destination, ou ouverture dans Waze ou dans l'application de cartes du téléphone.
> • Planning des courses réservées et rappels avant chaque course.
> • Messages avec votre centrale et signalements de la flotte (contrôles, accidents, bouchons).
> • Gains du jour et de la semaine, commissions et règlements avec votre centrale.
> • Documents (carte VTC, permis…) envoyés depuis l'app, avec rappel avant échéance.
>
> L'application est réservée aux chauffeurs inscrits par une centrale : demandez votre lien d'inscription à votre centrale.
>
> Position : quand vous êtes EN LIGNE, Rydar Drive utilise votre position, y compris en arrière-plan, pour vous proposer les courses proches. Passer hors ligne ou fermer l'application arrête ce suivi ; seul un signalement que vous publiez envoie ensuite votre position.
>
> Rydar Drive est un logiciel de dispatch : les courses sont organisées par votre centrale, qui fixe les prix et les conditions.

**Note pour la vérification Apple (en anglais)** :

> Rydar Drive is the driver app of a B2B dispatch software used by ride-hailing (VTC) companies in France. Drivers are registered by their company (or through the company's invitation link), so the app requires an account. Demo account: [e-mail] / [password], company "Démo App Review".
> How to test (works from any location):
> 1. Sign in. If the Terms screen appears, tap "J'accepte" (see "Terms" below). Tap "Passer en ligne" (go online) and allow location "While Using the App".
> 2. Tap the calendar icon at the top (Planning): scheduled rides are offered to the demo account. Tap "Prendre cette course" (take this ride).
> 3. Under "Mes courses planifiées", open the ride and slide "Aller au départ" (go to pickup): in-app turn-by-turn navigation starts. Keep sliding through each step until the ride is completed.
> Instant ride offers (with a ringtone, even when the phone is locked) are only sent to drivers within 4 to 16 km of the pickup point, so the scheduled rides above are provided for the review; the attached video shows an instant offer.
> Background location (UIBackgroundModes: location): while the driver is online, the app keeps sharing the driver's location, including when the app is in the background or the screen is locked, so that nearby rides can be offered and the company can follow the ride. The iOS location indicator is shown. Continuous location sharing stops when the driver goes offline or closes the app. "When In Use" permission only, requested after an in-app explanation.
> Terms: every driver must accept our Terms of Use and Privacy Policy in the app, on a full-screen acceptance page shown at first sign-in and again for each new version; the sign-in screen also states that signing in means accepting them. The Terms (section 8) set the rules of the drivers' channel, with zero tolerance for objectionable content or abusive users.
> Drivers' channel (chat bubble > "Chauffeurs"), the only place where drivers share content with each other: visible only to the company's drivers and staff (owner, admins, dispatchers). Before a driver's first post (message or road report), the channel rules are displayed and must be accepted: they are summarized on the Terms page, and a "Règles du fil" sheet with a link to the full Terms and a "J'accepte" button appears if the current Terms have not been accepted yet; posting is not possible without accepting. With a long press on any message, a driver can report it to the company (it disappears from their feed at once) or hide all messages from its author. Reports reach the company's staff immediately in their dashboard (alert and badge); they moderate the channel: they delete the message for everyone or dismiss the report, and can suspend or exclude the author. When the reported message comes from the company itself, the report sheet shows our contact e-mail. Illegal content can also be reported to us: [contact e-mail].
> Account deletion: Profil (Mon compte) > Supprimer mon compte, also offered when sign-in is refused (suspended or banned account). Privacy policy: https://[domain]/confidentialite · Terms: https://[domain]/cgu · Account deletion page: https://[domain]/suppression-compte

**Description du service de premier plan (Google Play)** :

> Quand le chauffeur passe EN LIGNE, un service de premier plan de type localisation partage sa position avec sa centrale, y compris écran éteint ou dans une autre application, pour lui proposer les courses les plus proches et suivre la course en cours. Une notification permanente « Rydar Drive — EN LIGNE » est affichée. Le service s'arrête quand le chauffeur passe hors ligne ou ferme l'application.

## 8. Captures d'écran

- iPhone : 6,9 pouces obligatoires (1320 × 2868, ex. iPhone 16 Pro Max), 3 à 10 captures.
- Android : téléphone, au moins 2 captures (1080 × 1920 ou plus).
- Écrans conseillés : accueil EN LIGNE sur la carte, offre de course, guidage, planning, gains, messages.
- Les prendre sur un vrai téléphone avec le compte de démonstration (bouton latéral + volume haut).

## 9. Après la publication

Renseigner les liens sur le serveur (`sudo bash /opt/rydar/deploy/configure.sh`, partie « Application chauffeur
publiée ») puis relancer l'installation :

- `IOS_APP_URL` : lien App Store ; `ANDROID_APP_URL` : lien Google Play — boutons d'installation de la page
  d'inscription `/rejoindre/{code}` ;
- `APPLE_APP_IDS` : `TEAMID.app.rydar.driver` (Team ID visible sur developer.apple.com) — les liens
  `/rejoindre/{code}` ouvrent directement l'app sur iPhone ;
- `ANDROID_CERT_SHA256` : Play Console › Intégrité de l'application › Signature d'application › empreinte
  SHA-256 — mêmes liens sur Android (`/.well-known/assetlinks.json`).

## 10. Mises à jour

Deux façons de mettre à jour l'app, toutes deux depuis `apps/driver` :

1. **Mise à jour à distance (EAS Update)** — pour une correction ou une évolution de l'app **sans** changement
   natif (écrans, textes, logique) : `eas update --channel production --environment production --message "…"`.
   Les téléphones la téléchargent en arrière-plan et l'appliquent au lancement suivant. Pas de vérification Apple
   ou Google.
2. **Nouvelle version sur les stores** — obligatoire dès qu'un module natif, une permission, l'icône ou la
   configuration native change : augmenter `version` dans `app.config.ts` (ex. 1.1.0 → 1.2.0), puis
   `eas build -p all --profile production` et `eas submit -p ios --latest` / `eas submit -p android --latest`.
   **`eas submit` ne publie rien** : il téléverse seulement le build. Pour que les chauffeurs reçoivent la version :
   - **Android** : le `.aab` arrive en **brouillon** dans **Tests › Tests internes** (`eas.json` : `track: internal`,
     `releaseStatus: draft`). Play Console › Tests internes › ouvrir la version brouillon › **Vérifier et déployer**,
     puis **Promouvoir la version › Production** (notes de version en français) › Envoyer pour examen. La
     publication suit l'examen de Google (heures à quelques jours), en déploiement progressif si vous le choisissez.
   - **iOS** : le build arrive dans App Store Connect (TestFlight). App Store Connect › l'app › **+ Version**
     (même numéro que `version`, ex. 1.2.0) › choisir le build › remplir « Nouveautés de cette version » ›
     **Ajouter pour vérification** puis **Soumettre**. Publication manuelle ou automatique après acceptation.
   - Mettre à jour les réponses App Privacy / Sécurité des données (§ 5 et § 6) si l'app collecte une donnée de
     plus, **avant** l'envoi.

Nouvelle version des CGU ou de la politique de confidentialité (`LEGAL_VERSION`, `packages/shared/src/features.ts`) :
l'app embarque cette valeur, donc une mise à jour à distance est nécessaire pour que les chauffeurs voient l'écran
d'acceptation de la nouvelle version. Les CGV et l'accord de traitement (`ORG_LEGAL_VERSION`) ne concernent que les
organisations (tableau de bord) : aucune mise à jour de l'app pour eux.

Règle : une mise à jour à distance ne s'installe que sur les builds de la **même** version (`runtimeVersion` =
version). Après un changement natif, il faut donc toujours une nouvelle version et un nouveau build. Une mise à jour
à distance est téléchargée au lancement de l'app et appliquée au lancement **suivant** : un chauffeur qui ne ferme
jamais complètement l'app la reçoit plus tard.

## 11. Demandes de suppression par e-mail

La page `/suppression-compte` (déclarée à Google Play) promet une suppression sous 30 jours à qui écrit depuis
l'adresse de son compte, y compris un chauffeur qui n'a plus l'app ou dont le compte est bloqué :

1. Vérifier que la demande vient bien de l'adresse e-mail du compte. Sinon (adresse perdue), la page permet
   d'écrire d'une autre adresse avec le téléphone enregistré et le nom de la centrale : vérifier alors l'identité
   par un autre moyen, par exemple en la faisant confirmer par la centrale. Ne jamais supprimer un compte sur la
   seule demande d'une adresse inconnue.
2. Super Admin, **`/admin/suppressions`** : rechercher le compte chauffeur par e-mail ou téléphone, puis le
   supprimer (confirmation en tapant SUPPRIMER). **Jamais en SQL** : seul l'outil applique exactement la
   suppression faite depuis l'app (données effacées ou anonymisées, dossier des justificatifs, compte de
   connexion) et l'inscrit au journal d'audit. La même page montre les suppressions en attente (compte de connexion
   ou fichiers non encore supprimés, retentés automatiquement par le worker) et permet de les relancer. Si une
   course est attribuée, demander d'abord à la centrale de la terminer ou de la réattribuer. Centrale suspendue ou
   archivée : l'outil retire lui-même au chauffeur une course acceptée pas encore commencée (elle reste « à
   attribuer ») ; une course commencée bloque toujours : réactiver la centrale le temps qu'elle la termine ou
   l'annule, puis la suspendre ou l'archiver de nouveau.
3. Confirmer la suppression par e-mail au chauffeur, dans le délai de 30 jours.
