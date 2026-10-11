# Audit de sécurité et de fonctionnement (septembre 2026)

Audit complet du code (web, API, base de données, app chauffeur, worker, déploiement, textes légaux), puis correction de
tout ce qui a été confirmé. Règle suivie : **aucun constat n'est corrigé sans avoir été reproduit**. Chaque correctif a
un test qui échoue sans lui et passe avec lui.

## Méthode

| Étape | Qui | Résultat |
|---|---|---|
| 1. Audit | 21 auditeurs, un par domaine (auth web, API chauffeur, API publique, actions du tableau de bord et du super admin, webhooks, RLS, fonctions SQL courses et argent, temps réel et stockage, front, app, worker et déploiement, flux course / argent / comptes / annexes, code inutile, robustesse web et app, textes) | 170 constats, chacun avec scénario et preuve |
| 2. Contre-expertise | 16 vérificateurs chargés de RÉFUTER chaque constat (exécution SQL réelle comme l'utilisateur concerné, vrai serveur d'authentification GoTrue, navigateur Chromium, scripts) | 0 réfuté ; doublons fusionnés et gravités corrigées → **129 défauts distincts : 7 hauts, 31 moyens, 91 bas** |
| 3. Correction | 11 correcteurs en copies isolées du dépôt, fonctions SQL et fichiers attribués sans chevauchement, puis deux vagues de finition | Migrations `20260924004300` à `005300`, un test par correctif |
| 4. Contre-audit | 6 relecteurs indépendants sur l'ensemble des corrections | 32 points résiduels (4 moyens, 28 bas) : 3 déjà corrigés par les finitions, 29 corrigés au tour 2 (migrations `005400` à `005600`), chacun reproduit d'abord |
| 5. Bout en bout | Pile complète locale (PostgreSQL, GoTrue, PostgREST, temps réel, web de production, worker) + Chromium | 9 parcours OK, isolation entre centrales vérifiée (354 contrôles) ; 9 défauts d'ergonomie (bandeau cookies, 404, panne de la base, aperçu du mini-site, date lointaine, e-mail d'invitation, repère `<main>` et lien d'évitement, titre de la page En direct) corrigés ; test de fumée final sur le code corrigé : OK |

La base ne laissait lire directement aucune donnée d'une autre centrale (RLS sur toutes les tables, vérifiée table par
table). Les défauts qui touchaient une autre centrale passaient par des actions (rattachement d'un compte existant,
domaine personnalisé, signalement plateforme) : ils sont corrigés ci-dessous.

## Les 7 défauts de gravité haute (tous corrigés)

1. **Compte pré-créé puis promu gérant.** L'inscription par lien créait un compte confirmé pour n'importe quelle adresse ;
   la création de centrale, l'ajout d'un membre et `create-admin.sh` réutilisaient ensuite ce compte, dont un tiers
   connaissait le mot de passe. → Un compte existant n'est plus jamais rattaché directement : adhésion « invitée »,
   activée seulement par le lien reçu par e-mail ; un jeton émis avant l'activation n'ouvre rien (004700, 005300).
2. **Compte chauffeur qui gère aussi une autre centrale.** Sa centrale de chauffeur pouvait changer son mot de passe ou le
   bannir au niveau de la connexion. → Compte partagé intouchable par la centrale du chauffeur (004700).
3. **Domaine personnalisé.** La vérification DNS n'était pas atomique : une centrale pouvait capter le sous-domaine d'une
   autre. → Vérification atomique, sous-domaine Rydar prioritaire, unicité des seuls domaines vérifiés (005000).
4. **« J'ai payé » en boucle.** Un chauffeur contesté (« Pas reçu ») pouvait redéclarer sans fin pour ne jamais être
   bloqué. → Après une contestation, seul « Reçu » ou « Annuler » débloque ; un paiement déclaré compte dans le plafond
   après 72 h (004400).
5. **API v1 refusée aux centrales « sans offre ».** → Même règle que la base : sans offre = tout autorisé.
6. **Heure de réservation lue dans le fuseau du navigateur** (mini-site et « Nouvelle course »). → Heure de la centrale.
7. **Bannissement plateforme détourné.** Une centrale pouvait recopier l'identité du chauffeur d'une autre centrale dans son
   signalement. → Le super admin voit les fiches concernées et coche chacune (non cochées par défaut) (004600).

## Défauts moyens (31, tous corrigés)

- **Accès et rôles** : dispatcher qui activait ou suspendait un chauffeur par écriture directe ; invitation qui rattachait
  un autre compte (joker `_` dans la recherche d'e-mail) ; modification d'un membre sans validation ; suspension d'une
  centrale qui verrouillait les comptes de membres d'autres centrales ; bannissement plateforme qui verrouillait le compte
  de gestion d'une autre centrale ; redirection externe après connexion (`?next=/\hôte`).
- **Argent** : blocage des frais plateforme suspendu indéfiniment (retrait puis redéclaration) ; frais perdus au passage
  flotte → centrale ; dette effacée par la suppression du compte puis réinscription ; bannissement contourné par un
  téléphone écrit « +33 (0)6… ».
- **Courses** : double course instantanée pour un même chauffeur (acceptations simultanées) ; course attribuée pendant une
  autre invisible dans l'app ; chauffeur suspendu avec des courses orphelines ; vol retardé → « Aucun chauffeur » des heures
  avant la prise en charge ; course démarrée hors ligne sans suivi GPS.
- **Mini-site et API** : fausses réservations anonymes en masse ; prix calculé sur des coordonnées fournies par le client ;
  aucun budget global des fournisseurs géo payants ; clé « navigateur » qui pouvait lire les courses ; journal API
  saturable ; cache des hôtes du proxy sans limite (mémoire du serveur).
- **App chauffeur** : déconnexion hors réseau ratée ; écrans bloqués sur « Chargement… » ; accueil empilé à chaque course.
- **Robustesse web** : aucune page d'erreur, premier clic après un déploiement qui cassait la page.
- **RGPD** : journal de connexions Supabase jamais purgé ; justificatif « Visite médicale » (donnée de santé) proposé alors
  que les textes l'interdisent (retiré des dépôts).

Les 91 défauts bas (libellés, cas limites, code inutile, documentation…) sont corrigés, sauf ceux listés ci-dessous.

## Tour 2 (contre-audit) : ce qui a changé en plus

- **Jetons antérieurs** : un jeton émis avant l'activation d'une invitation (même dans la même seconde) ou avant une
  promotion Super Admin par `create-admin.sh` n'a pas les droits (`private.jwt_issued_after`, `users.super_admin_since`,
  RPC `session_is_super_admin` pour `requireSuperAdmin`).
- **Comptes** : une adhésion seulement « invitée » ne protège plus un compte (suppression, bannissement plateforme) ;
  suspendre une centrale ne ferme que les sessions de ses membres actifs ; « J'ai payé » et le relevé visent la centrale
  affichée ; seul le propriétaire annule l'invitation d'un propriétaire ; outil super admin « Débloquer la connexion ».
- **Limites** : connexion web et chauffeur, code « mot de passe oublié » et suppression de compte comptent par couple
  (adresse, IP /64) avec un plafond global plus haut : un tiers ne bloque plus le titulaire d'une adresse.
- **API et mini-site** : clé d'idempotence rejouée par une autre clé → 409, jamais la course d'une autre intégration ;
  limite par IP réservée aux requêtes non authentifiées ; budget géo payant partagé en sous-plafonds (IP, mini-site,
  centrale, utilisateur) ; domaine personnalisé soumis au droit de l'offre ; un ancien abonnement Stripe ne rétrograde
  plus un abonnement en cours ; un sous-domaine réservé déjà pris n'empêche plus d'enregistrer les autres réglages.
- **Courses** : verrou d'acceptation sans interblocage avec le dispatch ; une course sans prix n'est ni acceptée ni
  annoncée acceptable pour un nouveau chauffeur sous plafond ; le suivi des vols ne relance plus une course d'une
  centrale bloquée (frais en retard, quota).
- **Bannissements** : les empreintes de téléphone calculées avec l'ancienne écriture restent effectives.
- **App chauffeur** : planning d'un gérant qui roule, montant dû affiché avant la suppression même compte suspendu,
  mise hors ligne retentée tant que les CGU ne sont pas acceptées.
- **Web** : page 404 en français, bandeau cookies qui ne masque plus « Se déconnecter ».

## Non corrigés dans le code (décision ou réglage)

- **Existence d'un compte révélée par l'inscription par lien** (« adresse déjà liée à un compte ») : la supprimer demande
  de vérifier l'adresse par un code e-mail avant de créer le compte (changement du parcours d'inscription). Piste notée.
- **Devinage des codes e-mail** : Supabase Auth ne compte pas les essais par code ; la parade est un réglage : **code à
  8 chiffres** (docs/DEPLOYMENT.md § 1).
- **Fichiers de justificatifs remplacés** : la ligne est supprimée mais le fichier reste dans le stockage ; une purge par
  le worker est à ajouter.
- **Carte VTC obligatoire à l'inscription** : décision produit (renforcerait l'anti-fraude).

## À vérifier en production après la mise à jour

1. Supabase › Authentication : *Email OTP Length* = 8 (validité laissée à 3600 s).
2. Connexion à la base en `verify-full` : `migrate.sh` s'arrête avec un message clair si le certificat n'est pas reconnu ;
   repli `DATABASE_SSLMODE=no-verify` proposé par `configure.sh`.
3. Purge du journal Auth : la réponse du ménage contient `auth_audit_purged` (0 en permanence alors que la table a des
   lignes de plus d'un an = droit manquant, voir DEPLOYMENT.md).
4. Données héritées : sous-domaines réservés déjà pris, domaine personnalisé sous le domaine racine, fiches suspendues
   « vérification requise » par le recalcul des empreintes de téléphone (requêtes dans DEPLOYMENT.md, section « Après la
   mise à jour de l'audit »).
5. `EXPO_ACCESS_TOKEN` renseigné (sécurité des notifications push).

## Audit de sécurité phase 5 (10/2026)

Demande du propriétaire : « vérification de sécurité complète de tous les onglets, toutes les fonctionnalités, toute
l'app et le site ». Branche `claude/confident-clarke-rpfwmo`, à partir de `8021fe9`. Même règle qu'en septembre : un
constat n'est retenu que reproduit (ou démontré par le code), chaque correctif a son test ; ce qui était déjà prouvé
corrigé (sections précédentes) n'a pas été refait. Preuves et journaux hors dépôt (`scratchpad/audit-p5/`).

### Périmètre

| Domaine | Vérifié |
|---|---|
| Base de données | 165 fonctions `public` (`search_path`, droits d'exécution, contrôle d'accès DANS chaque RPC par sondes croisées : owner d'une autre centrale, dispatcher, chauffeur), politiques RLS, droits par colonne (`organizations`, `ride_offers`), temps réel ; nouveautés depuis septembre : réseau partagé (006700 à 007100), éligibilité (007500), Flotte Privée (007600, 007700), visite guidée (007800) |
| Onglets du tableau de bord | Chaque page parcourue par 7 profils (owner, admin, dispatcher de flotte et de centrale, Flotte Privée), matrice d'accès entre centrales, actions serveur rejouées avec un rôle insuffisant, panneaux refondus, réseau partagé, « J'ai payé », Équipe |
| Super admin et public | `requireSuperAdmin` et audit sur chaque page et action, RPC `svc_*` / `admin_*`, mini-sites `/book`, `/eligibilite`, `/contact`, Supabase Auth exposé à Internet |
| App chauffeur | Session (AES + SecureStore), RPC forgées, liens profonds et de paiement, permissions Android effectives, déclarations des stores, jetons push, positions |
| Worker, infra, dépendances | Notifications push, suppression de comptes, Caddy (Caddy 2.10 compilé pour les essais), `pnpm audit` |

Vérifié sain (rien à corriger) : `search_path = ''` partout ; `anon` n'exécute que `public_legal_info` et
`resolve_booking_host` ; `svc_*` réservées au service role ; toutes les sondes croisées refusées ; temps réel
(`platform.updated` = identifiants, offres réseau et chauffeur partenaire masqués) ; recherche d'e-mail par égalité ;
app : aucun journal sensible.

### Constats : 21 (1 critique, 4 majeurs, 16 mineurs)

**Critique (corrigé)**

- **base-1 — Réseau partagé : position d'un chauffeur en course partenaire.** Sa propre organisation (qui ne lit pas
  sa position, RLS) la retrouvait par des distances calculées sur SES courses : offre planifiée proposée à toute la
  flotte (`ride_offers.distance_m`, lisible par tout membre et diffusée sur `org:`), journal de fin de recherche
  (« Karim T. (2,3 km) : déjà en course », point choisi par elle), alerte de retard d'une course enchaînée.
  → 007900 (`aa03ae9`) : règle unique `private.driver_on_foreign_ride` ; distance NULL, « déjà en course » sans
  distance, alertes de retard / immobilité / GPS de ses propres courses non calculées pendant la course partenaire
  (pas d'alerte plutôt qu'une fuite).

**Majeurs (corrigés)**

- **onglets-1 — Dispatcher et course réglée.** « Annuler » un règlement lui était refusé, mais « Modifier » la course
  terminée ramenait la commission à 0 ou passait le paiement « en ligne » (sens du règlement renversé : la centrale
  devait la part chauffeur). → 007900 : owner / admin seulement (`FORBIDDEN_ROLE`) dès qu'un règlement existe ; web :
  refus clair dans `updateRidePricing`, « Modifier » masqué (`70a17ce`, `565b0ef`).
- **app-chauffeur-1 — Notifications après révocation.** Mot de passe changé ou « Déconnecter » : le téléphone perdu
  recevait encore les notifications (messages de la centrale avec données client). → 007900 : `push_tokens.session_id`,
  jeton plus servi quand sa session est révoquée ou expirée (transition sans coupure pour les jetons antérieurs).
- **admin-public-1 — Bannissement révélé par Supabase Auth.** `/token?grant_type=password` répond `user_banned` avant
  de vérifier le mot de passe : n'importe qui savait si une adresse avait été bannie par une centrale (motif
  « impayé » compris). → app chauffeur sans connexion directe à Supabase (`12f88ea`, JS seul) ; bloc Caddy
  `api.DOMAINE` (`4880c66`, DEPLOYMENT § 3 point 2) : **à poser sur le VPS**, sans quoi l'oracle reste ouvert.
- **worker-infra-1 — Jeton Expo d'un autre projet.** Un chauffeur qui enregistre un jeton d'une autre app Expo faisait
  refuser en bloc (`PUSH_TOO_MANY_EXPERIENCE_IDS`) les notifications des autres centrales du même envoi. → `edc0e00` :
  un envoi par projet (ou par expéditeur) si Expo refuse la requête entière.

**Mineurs (16)**

| Constat | Statut |
|---|---|
| base-2 limites (chauffeurs, accès) dépassées par requêtes simultanées | corrigé (007900 : verrou de l'organisation) |
| admin-public-4 accusés de réception « 1 par adresse » contournés par alias (`+x`, points Gmail) | corrigé : par boîte, `private.mailbox_key` / `mailboxKey` (`aa03ae9`, `47b6834`, `7bae4f9` ; aussi les accusés du mini-site) |
| app-chauffeur-2 position « téléportée » acceptée | corrigé côté base (`LOCATION_IMPLAUSIBLE`) ; refus des positions simulées dans l'app reporté |
| worker-infra-3 « compte conservé » figé à la demande de suppression | corrigé (recalculé à chaque reprise) |
| onglets-2 « J'ai payé » / décisions réseau sur une autre centrale que celle affichée | corrigé (`cf191bf`) |
| onglets-3 « Inviter un membre » : sondage de l'existence des comptes, e-mails en masse | plafonds 10 / h par administrateur, 20 / h par centrale (`b39be0a`) ; réponse identique reportée (refonte du flux d'invitation) |
| admin-public-2 existence d'un compte par « Mot de passe oublié » (`/recover`, `/otp`) | corrigé : action serveur à réponse identique (`12f88ea`) + routes fermées par le bloc Caddy (VPS) |
| admin-public-3 nom de la centrale dans les métadonnées de la 404 de `/book` | corrigé (`0949115`) |
| app-chauffeur-3 permission Android `SYSTEM_ALERT_WINDOW` (gabarit Expo) | bloquée (`cf5a9d4`) — **natif : effectif au build stores 1.2.0** |
| app-chauffeur-4 IBAN absent des déclarations des stores | documenté (STORES § 10) |
| app-chauffeur-5 mises à jour EAS non signées | reporté (clé privée du propriétaire + natif : STORES § 10) |
| app-chauffeur-6 clé Google Maps Android non restreinte | documenté (STORES § 3, DEPLOYMENT) — à régler dans la console Google |
| worker-infra-2 corps de requête sans plafond, `/api/tls/allowed` public | corrigé dans `deploy/Caddyfile` (`4880c66`) ; à reporter dans `Caddyfile.local` s'il le remplace |
| worker-infra-4 next 16.3.6, sharp 0.35.4 (avis de sécurité) | corrigé : next 16.3.8, sharp 0.35.5 (`af3327a`) ; Next 16.4 à planifier |
| worker-infra-5 nodemailer 9.1.1 | reporté (correctifs en 10.x seulement ; non exploitable ici) |
| worker-infra-6 outils de build | en partie : shell-quote, source-map-js (`af3327a`) ; node-forge, braces, uuid, decode-uri-component, esbuild : sans correctif publié ou hors production (suivre Expo et tsup) |

### Contrôle final (indépendant)

- `pnpm typecheck` OK ; `pnpm test` 176 fichiers, 1 958 tests ; `test:db` 53 fichiers, 899 tests ; `pnpm build`
  (paquet partagé, worker avec `dist/mailer.js`, web Next 16.3.8) ; `export:check` de l'app OK ; base neuve comme la
  CI : 81 migrations + seed, 29 chauffeurs, 3 organisations, 1 signalement ouvert, commissions dues.
- Recette de non-régression (`run-all.sh` + `s10`, build de production, visite guidée en pause) : **112 contrôles OK,
  0 échec**, mêmes erreurs navigateur connues qu'avant l'audit ; base locale « rydar » remise à l'identique.
- **Preuves d'exploitation rejouées sur le code corrigé : toutes échouent maintenant.**
  1. base-1 : les 3 preuves d'origine (journal, offre planifiée, alerte) — distance NULL, message sans distance, aucune
     alerte (avant : 2 335 m, 4 303 m, 28 384 m).
  2. onglets-1 : dispatcher sur une course terminée réglée — « Modifier » absent, action serveur refusée, écriture
     directe PostgREST refusée (403 `FORBIDDEN_ROLE`), règlement inchangé.
  3. app-chauffeur-1 : jeton enregistré par une vraie session, puis session révoquée — plus aucun jeton servi (témoin
     session ouverte : servi).
  4. worker-infra-1 : jeton d'un autre projet mêlé à l'envoi — notifications des autres centrales « envoyées ».
  5. admin-public-1 et 2 : à travers Caddy configuré avec le bloc de DEPLOYMENT § 3 tel qu'écrit, depuis Internet :
     `/token` (mot de passe), `/otp`, `/recover` en 404 ; depuis le serveur web : transmis ; `refresh_token` transmis.
     Sans le bloc (production actuelle) : `user_banned` toujours visible.

### Serveur web — revue complémentaire (après le contrôle final)

Relecture de chaque point d'entrée serveur du web : 26 fichiers « use server » (≈ 150 actions) et 34 routes, `proxy.ts`,
en-têtes, variables publiques, contenus fournis par les centrales, URL appelées par le serveur.

Vérifié sain : contrôle d'accès avant toute écriture dans chaque action (`requireSuperAdmin`, `getOrgContext` + rôle,
`getPayerContext`, `requireUser` ; rôle revérifié en base par les RPC) ; routes par session, clé API (portées, origines,
débit), jeton chauffeur, signature Stripe ou publiques ; entrées validées (zod, bornes ; JSON v1 ≤ 32 Ko) ;
`ipFromHeaders` + `rateLimitAll` sur toutes les entrées publiques et tous les envois ; redirections par `safeNext` ou
littérales ; erreurs du catalogue seulement ; 4 exports CSV protégés ; aucune valeur privée dans `.next/static` ni
`NEXT_PUBLIC_*` ; `dangerouslySetInnerHTML` pour des constantes seulement ; aucune URL saisie par une centrale récupérée
par le web (webhooks envoyés par le worker avec contrôle SSRF).

Quatre mineurs, tous reproduits sur le build de production puis rejoués après correction (aucun SQL) :

| Constat | Statut |
|---|---|
| web-1 hôte de mini-site : `/book/{autre slug}`, `/rejoindre/…` et pages légales servis sans résolution (hôte coupé compris) | corrigé (`038c9af`) : hôte résolu d'abord ; son `/book` et pages légales seulement s'il sert un mini-site ; `/book/{autre}`, `/rejoindre/…` → 404 neutre |
| web-2 `/api/tls/allowed` : 2 RPC service role par poignée de main TLS (SNI aléatoires) | corrigé (`d1c3304`) : décisions gardées (5 min / 60 s), interrupteur relu toutes les 30 s, 300 résolutions par minute au plus |
| web-3 HSTS `includeSubDomains; preload` sur les domaines personnalisés des centrales | corrigé (`f269db7`) : plateforme seule ; ailleurs `max-age=31536000` |
| web-4 CSP `'unsafe-inline'` annoncée « stricte », cookies de session lisibles par JS | en partie (`f269db7`) : `connect-src` sans joker `*.supabase.co`, SECURITY.md corrigé ; CSP à nonce reportée |

Tests ajoutés (échouaient avant correction) : `domaine-proxy.test.ts`, `tls-allowed.test.ts`, `security-headers.test.ts`.
Contrôle indépendant (arbre `a74a039` et suivants, non poussé) : `pnpm typecheck` OK ; `pnpm test` 177 fichiers,
1 968 tests ; `test:db` 53 fichiers, 899 tests ; `pnpm build` OK ; aucune migration (base neuve inutile). Rejoué sur
ce build : hôte d'Élite → son mini-site et `/cgu` en 200, `/rejoindre/<code d'Express>` et `/book/<autre>` en 404 ;
hôte non résolu et domaine tiers → `/book/elite-paris` et `/cgu` en 404 ; HSTS complet en `.rydar.app`, `max-age` seul
sur le domaine tiers ; plateforme (`localhost`) inchangée.

### Reporté ou à faire hors du code

- **VPS (obligatoire)** : bloc `api.DOMAINE` dans `Caddyfile.local` après le contrôle IPv6 (DEPLOYMENT § 3, point 2) ;
  plafond de 2 Mo et `/api/tls/allowed` si `Caddyfile.local` remplace le Caddyfile du kit (point 1) ;
  `GOTRUE_RATE_LIMIT_HEADER` et `DISABLE_SIGNUP` (point 2).
- **App** : build stores 1.2.0 (`SYSTEM_ALERT_WINDOW`) ; signature des mises à jour EAS (décision du propriétaire) ;
  refus des positions simulées et compteur anti-fraude (fonctionnalité).
- **Console Google** : clé Maps Android restreinte au package et à l'empreinte SHA-1.
- **Plus tard** : réponse identique à « Inviter un membre » ; nodemailer 10 ; Next 16.4 ; plafond d'accusés par domaine
  (facultatif) ; CSP à nonce (`proxy.ts`, guide Next « content-security-policy » : pages statiques rendues dynamiques,
  à mesurer) ; cookies de session non lisibles par JS (exige de retirer le client Supabase du navigateur).
