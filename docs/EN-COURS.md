# Travail en cours (27/09/2026) — à relire en reprenant une session

Branche `claude/confident-clarke-rpfwmo`. Dernier commit poussé : relances WhatsApp + moyens de paiement (M15).
**Non commité** : tout le lot « conformité légale » ci-dessous (typecheck web OK).

## 1. Conformité légale (#43) — en cours
Déjà fait, non commité :
- **Migration `003900_legal_compliance`** :
  - `platform_legal` (éditeur, hébergeur) : lecture `public_legal_info()`, écriture `svc_platform_legal_update` ;
  - `legal_acceptances` + `accept_legal_documents(docs, version, org, source)` ;
  - `organizations.vtc_registration`.
- **Web — informations légales et identité** :
  - `lib/legal.ts` : `getLegalInfo()` lit la base, repli sur `LEGAL_*` ; `LEGAL_VERSION` = « 2026-09-27 ». Page `/admin/legal` : formulaire, et liste des centrales qui n'ont pas encore accepté.
  - Réglages › Organisation : nouveau champ « Inscription VTC ».
  - Mini-site : bloc de pied de page « organisé par {centrale} (SIRET, VTC) — Rydar = logiciel ».
- **Web — liens et affichage** :
  - `components/legal/{legal-links,cookie-notice,terms-banner}`. Le bandeau cookies est d'information seulement, car seuls des cookies nécessaires sont utilisés.
  - `proxy.ts` ne réécrit pas les pages légales sur les mini-sites.
  - Liens légaux en pied de page de l'accueil, de la connexion, du mini-site et de `/rejoindre`.
- **Acceptation des conditions** :
  - Bandeau CGV, CGU et DPA pour les owner / admin (`acceptOrgTerms` dans `app/dashboard/actions.ts`).
  - Inscription chauffeur : preuve enregistrée (`lib/join.ts`), liens CGU et confidentialité dans le formulaire web et dans l'app (`legalUrl('cgu')`).

Reste à faire :
- **Pages `/mentions-legales`, `/cgu`, `/cgv`, `/cookies`, `/dpa`**. Un agent les rédigeait ; vérifier qu'elles existent, sinon les écrire. Consigne de l'utilisateur : **Rydar = simple outil de dispatch**. Les courses, les clients, les prix et les chauffeurs appartiennent à la centrale. Rydar n'est ni transporteur, ni centrale de réservation, ni intermédiaire de paiement. La centrale porte les obligations VTC et garantit Rydar. Le DPA contient le tableau des sous-traitants.
- **Tests à écrire** : DB pour 003900 (acceptations, droits, `public_legal_info` pour anon), puis `pnpm test:db`, `typecheck`, `test`. Ensuite commit et push.
- **Documentation** : `configure.sh` doit renvoyer vers `/admin/legal`. Mettre à jour STORES / DEPLOYMENT.

## 2. Constats de la revue « stores » (#44) — tous confirmés
Le détail (scénario et correctif) est dans le scratchpad `store-findings.json` et `store-verdicts.json`. Il est aussi résumé ici.

**Suppression de compte** (nouvelle migration `004000`, route `/api/driver/delete-account`, `app/delete-account.tsx`, `account.tsx`) :
- **Identité encore visible après suppression.** Anonymiser :
  - `ride_settlements.driver_label` ;
  - `ride_events` : message et `data` (name, driver_name, author_name, `excluded[]`) ; supprimer les événements `fleet.report` du chauffeur ;
  - `ride_alerts` : message, `driver_name`, lat/lng ;
  - `fraud_reports.driver_label`, ou bien le dire dans la politique ;
  - véhicule venu du lien d'inscription : le supprimer ou l'anonymiser, et caviarder son audit.
- **Fiche supprimée.** À corriger :
  - mettre `application_status` à null ;
  - bloquer par déclencheur la réactivation d'une fiche dont `deleted_at` est renseigné ;
  - refuser approve et reject sur une fiche supprimée ;
  - l'exclure des listes ;
  - `checkDriverAccount` : répondre INACTIVE si `deleted_at` est renseigné.
- **Fichiers du stockage.** Lister et supprimer tout le dossier `{org}/{driver}/` (pagination), tester `{ error }` ; en cas d'échec, ne pas répondre DELETED.
- **Compte suspendu ou banni.** Le jeton est refusé par `getUser`. Accepter aussi e-mail + mot de passe (`signInWithPassword`) dans la route, et le proposer dans l'app.
- **Échec de `deleteUser`.** Ne pas annoncer « supprimé ». Mettre la suppression dans une file (table `private.account_deletions`), que le worker rejoue. Effacer `users.full_name` et `users.phone`.
- **Membre de centrale ou super admin.** Mettre `user_id = null` et afficher le message « profil chauffeur supprimé, compte de gestion conservé ».
- **Demande sans l'app.** Rendre le contact obligatoire, et créer un outil super admin qui supprime un chauffeur à partir de son e-mail.

**Pages** :
- `/confidentialite` : un bannissement conserve plus que des empreintes (`fraud_reports`) ; la position peut être envoyée hors ligne (signalements) ; l'identifiant d'appareil est persistant ; « sans identité » ne sera vrai qu'une fois la migration 004000 appliquée.
- `/suppression-compte` : nommer l'app et l'éditeur.

**App chauffeur** (confié à un agent : vérifier son résultat, sinon le faire) :
- **Information préalable GPS jamais affichée.** `use-my-position.ts` `start()` ne doit plus demander d'autorisation : la seule porte d'entrée est `requestLocationPermissions()`, qui affiche l'information avant la demande.
- **Autorisation refusée pour de bon** (`canAskAgain = false`) : proposer « Ouvrir les réglages ».
- **iOS** : retirer `fetch` de UIBackgroundModes (plugin local, vérifier avec `npx expo config --type introspect`).
- **Messagerie « Chauffeurs »** (règle App Store 1.2) :
  - base de données : migration `004100_chat_moderation` (signaler, bloquer, supprimer un message, classer un signalement) et `tests/db/chat-moderation.test.ts` ;
  - app : appui long sur un message ;
  - tableau de bord : modération dans `/dashboard/messages`.

**`docs/STORES.md`** :
- **Compte démo** : créer des courses PLANIFIÉES dans 10 à 15 jours (proposées sans condition de position) au lieu de « on request ».
- **Formulaires Sécurité des données / App Privacy** : les compléter (identifiant d'appareil, messages, documents, position hors ligne pour les signalements…).
- **Mises à jour** : `eas submit` ne publie pas ; décrire la mise en production (Play : production, iOS : soumettre la version).
- **iOS** : UIBackgroundModes réel.

## 3. Page d'accueil (#45) — à faire
Demande de l'utilisateur : améliorer au maximum la page d'accueil, mettre en avant les services et les avantages, avec un peu de 3D (radar ou planète « stylée »).
- **Services à présenter** : dispatch par vagues, carte temps réel, app chauffeur, mode centrale à commission, relances WhatsApp, encaissements, mini-site et API, vols, alertes, messagerie, sécurité et RGPD.
- **Contraintes techniques** :
  - 3D chargée à la demande, avec un repli si WebGL est absent ;
  - respecter `prefers-reduced-motion` ;
  - mobile ;
  - pas de ressource externe (CSP) ;
  - garder les liens légaux du pied de page.
- **Message à respecter** : Rydar = logiciel de dispatch.

## Prochaines étapes déjà demandées (plus tard)
- Code e-mail à l'inscription par lien : OTP GoTrue, `drivers.email_verified_at`.
- Frais plateforme : minimum de frais, relances par e-mail.
- Webhook WhatsApp (statut de remise des messages).
