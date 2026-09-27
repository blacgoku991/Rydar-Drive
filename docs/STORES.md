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
2. Renseigner l'éditeur de l'app : `sudo bash /opt/rydar/deploy/configure.sh` (questions « Société éditrice »,
   « E-mail de contact pour les données personnelles », « Adresse du siège »), puis relancer l'installation.
3. Vérifier que ces deux pages s'affichent (elles sont exigées par les deux stores) :
   - `https://VOTRE-DOMAINE/confidentialite` — politique de confidentialité ;
   - `https://VOTRE-DOMAINE/suppression-compte` — suppression du compte.

## 2. Compte de démonstration pour les vérificateurs

Apple et Google testent l'app : il leur faut un compte chauffeur qui fonctionne.

1. Dans `/admin`, créer une organisation **« Démo App Review »** (mode flotte).
2. Dans son tableau de bord : un véhicule (catégorie Berline), puis un chauffeur avec accès à l'app
   (e-mail dédié, ex. `review@VOTRE-DOMAINE`, et un mot de passe fort réservé à cet usage).
3. Se connecter une fois avec ce compte sur un téléphone pour vérifier.

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

## 5. App Store (iPhone)

1. [App Store Connect](https://appstoreconnect.apple.com) › Apps › **+** › Nouvelle app : plateforme iOS, nom
   **« Rydar Drive Chauffeur »** (doit être unique), langue principale Français, identifiant de lot
   `app.rydar.driver`, SKU `rydar-driver`.
2. Envoyer le build : `eas submit -p ios --latest` (EAS demande la connexion Apple ou une clé App Store Connect).
3. **TestFlight** : installer le build sur un iPhone, vérifier connexion, passage en ligne, sonnerie d'une offre.
4. Remplir la fiche (textes au § 7) : sous-titre, description, mots-clés, URL d'assistance
   (`https://VOTRE-DOMAINE`), URL de confidentialité (`https://VOTRE-DOMAINE/confidentialite`), catégorie
   **Économie et entreprise** (secondaire : Navigation), captures (§ 8), âge 4+.
5. **Confidentialité de l'app** (App Privacy) — aucune donnée utilisée pour le suivi publicitaire :

   | Type de données | Utilisation | Liée à l'utilisateur |
   | --- | --- | --- |
   | Coordonnées : nom, e-mail, téléphone | Fonctionnalités de l'app | Oui |
   | Localisation précise | Fonctionnalités de l'app | Oui |
   | Contenu utilisateur : photos (documents), autre contenu (messages) | Fonctionnalités de l'app | Oui |
   | Infos financières : autres (gains, commissions) | Fonctionnalités de l'app | Oui |
   | Identifiants : identifiant de l'appareil | Fonctionnalités de l'app | Oui |

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
   - Accès à l'application : « Tout ou partie de l'app est soumise à restrictions » + compte de démonstration ;
   - Annonces : non ; Classification du contenu : questionnaire (aucun contenu sensible) ; Public cible : 18 ans et plus ;
   - **Sécurité des données** :

     | Données | Collectées | Partagées | Finalité | Facultatif |
     | --- | --- | --- | --- | --- |
     | Position précise | Oui | Non | Fonctionnalités de l'app | Non |
     | Nom, adresse e-mail, numéro de téléphone | Oui | Non | Gestion du compte, fonctionnalités | Non |
     | Photos et fichiers (documents) | Oui | Non | Fonctionnalités de l'app | Oui |
     | Messages dans l'application | Oui | Non | Fonctionnalités de l'app | Oui |
     | Autres infos financières (gains, commissions) | Oui | Non | Fonctionnalités de l'app | Non |
     | Identifiants de l'appareil | Oui | Non | Fonctionnalités, prévention de la fraude | Non |

     Données chiffrées en transit : oui. Suppression possible : oui (dans l'app et
     `https://VOTRE-DOMAINE/suppression-compte`).
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
> • Guidage intégré jusqu'au client puis à destination, ou ouverture dans Waze et Plans.
> • Planning des courses réservées et rappels avant chaque course.
> • Messages avec votre centrale et signalements de la flotte (contrôles, accidents, bouchons).
> • Gains du jour et de la semaine, commissions et règlements avec votre centrale.
> • Documents (carte VTC, permis…) envoyés depuis l'app, avec rappel avant échéance.
>
> L'application est réservée aux chauffeurs inscrits par une centrale : demandez votre lien d'inscription à votre centrale.
>
> Position : quand vous êtes EN LIGNE, Rydar Drive utilise votre position, y compris en arrière-plan, pour vous proposer les courses proches. Passer hors ligne ou fermer l'application arrête la collecte.

**Note pour la vérification Apple (en anglais)** :

> Rydar Drive is the driver app of a B2B dispatch platform used by ride-hailing (VTC) companies in France. Drivers are registered by their company (or through the company's invitation link), so the app requires an account. Demo account: [e-mail] / [password], company "Démo App Review". To test: sign in, tap "Passer en ligne" (go online) and allow location. Ride offers are sent by the company's dispatcher (we can send a test ride during review on request).
> Background location (UIBackgroundModes: location): while the driver is online, the app keeps sharing the driver's location, including when the app is in the background or the screen is locked, so that nearby rides can be offered and the company can follow the ride. The iOS location indicator is shown. Location collection stops when the driver goes offline or closes the app. "When In Use" permission only.
> Account deletion: Profil (Mon compte) > Supprimer mon compte. Privacy policy: https://[domain]/confidentialite

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

Règle : une mise à jour à distance ne s'installe que sur les builds de la **même** version (`runtimeVersion` =
version). Après un changement natif, il faut donc toujours une nouvelle version et un nouveau build.
