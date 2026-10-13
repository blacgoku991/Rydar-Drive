# Travail en cours (11/10/2026)

## Phase 6 : tout mettre à jour, puis envoi aux stores (en cours, 11/10/2026)

- **Contrôle natif** (`npx expo config --type introspect`, version 1.1.0) : iOS `UIBackgroundModes` = `location` seul,
  textes d'autorisation en français ; Android : `ACCESS_BACKGROUND_LOCATION`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`,
  `SYSTEM_ALERT_WINDOW` et `RECORD_AUDIO` retirées (`tools:node="remove"`).
- **Ordre** : (1) VPS par son Claude : `update-production.sh` (migration `007900`), `Caddyfile.local` aligné sur
  `deploy/Caddyfile` (2 Mo, `@tls_ask`, `read_header`), bloc d'Auth de `api.DOMAINE` après contrôle IPv6 (DEPLOYMENT
  § 3), contrôle extérieur au téléphone ; (2) `eas update` sur le runtime 1.1.0 ; (3) SEULEMENT ENSUITE `version`
  1.2.0 poussée (une mise à jour à distance ne vise que le runtime = version), build, `eas submit`, consoles (STORES
  § 10, nouveautés au § 7).
- **VPS (13/10, Claude du VPS)** : `91388db` déployé (migrations jusqu'à `007900`), `Caddyfile.local` aligné (copie
  `Caddyfile.local.avant-20261013-1034`), contrôles du point 1 OK, `GOTRUE_*` en place. Bloc d'Auth NON appliqué : le
  VPS a une IPv6 publique et Caddy écoutait sur `[::]:80/443` (joignable sans AAAA). Correction du kit : Caddy publié
  en IPv4 seul (`0.0.0.0:…`, `docker-compose.yml`), alerte d'`install.sh` si 80 / 443 écoutent en IPv6, DEPLOYMENT § 3
  et CLAUDE-VPS. Puis (`3874a60`) : rien en IPv6 sur 80 / 443 (`curl -6` → 7), bloc d'Auth posé DANS `handle @api`
  avant `reverse_proxy` (copie `Caddyfile.local.avant-auth-20261013-1048`), connexions tableau de bord et app, « Mot de
  passe oublié » (app et web) OK ; extérieur : `/auth/v1/otp`, mot de passe et réinitialisation → 404, `refresh_token`
  transmis. `eas update` runtime 1.1.0 publié (iOS + Android, groupe `7395b387-c6b8-4ec3-b9b7-b655827c3110`).
- **Version 1.2.0** : `version` passée à 1.2.0 APRÈS la mise à jour à distance ; reste build, `eas submit`, consoles.
- **Signature des mises à jour EAS** : non activée (clé privée à garder hors d'Expo ; perdue = plus de mise à jour à
  distance) ; à reprendre si le propriétaire peut garder la clé.

## Audit de sécurité phase 5 : audit, corrections et contrôle final faits (11/10/2026)

Détail, preuves rejouées et reports : `docs/AUDIT.md`, section « Audit de sécurité phase 5 (10/2026) ». Audit et
contrôle final poussés (`597a8b9`, migration `007900` comprise : intouchable désormais).
- **Serveur web — revue complémentaire (après `597a8b9`, NON poussée)** : 4 mineurs, aucun SQL. `038c9af` web-1 (hôte
  de mini-site : seulement son `/book`, les pages légales s'il sert un mini-site, et `/api/` ; `/book/{autre}` et
  `/rejoindre/…` → 404 neutre), `d1c3304` web-2 (`/api/tls/allowed` : décisions gardées, 300 résolutions / min),
  `f269db7` web-3 (HSTS `includeSubDomains; preload` sur la plateforme seule) et web-4 en partie (`connect-src` sans
  `*.supabase.co` ; CSP à nonce et cookies non lisibles par JS reportés), `a74a039` docs. Contrôle : typecheck ;
  `pnpm test` 177 / 1 968 ; `test:db` 53 / 899 ; build ; preuves rejouées sur le build. Pas de migration `008000` :
  la branche du copilote garde `20260924008000` ou plus.
- **Constats** : 21 (1 critique, 4 majeurs, 16 mineurs), tous reproduits. Critique : position d'un chauffeur en course
  partenaire retrouvée par sa propre organisation (réseau partagé). Majeurs : dispatcher qui modifiait une course
  réglée, notifications reçues après révocation, bannissement révélé par Supabase Auth, jeton Expo d'un autre projet
  qui bloquait les notifications des autres centrales. Tous corrigés dans le code ; l'oracle de Supabase Auth ne se
  ferme qu'avec le bloc Caddy `api.DOMAINE` posé sur le VPS.
- **Commits** : `aa03ae9` (migration `20260924007900_security_audit` + `tests/db/security-audit.test.ts`), `47b6834`,
  `70a17ce`, `565b0ef`, `7bae4f9`, `cf191bf`, `b39be0a`, `0949115`, `edc0e00`, `12f88ea`, `4880c66`, `cf5a9d4`,
  `af3327a`, puis la documentation du contrôle final (`SECURITY.md`, `AUDIT.md`, `CLAUDE.md` § Sécurité).
- **Contrôle final** : typecheck ; `pnpm test` 176 fichiers, 1 958 tests ; `test:db` 53 fichiers, 899 tests ; build ;
  `export:check` ; base neuve comme la CI (81 migrations + seed : 29 / 3 / 1 / dues) ; recette `run-all.sh` + `s10`
  sur le build de production : 112 contrôles OK, 0 échec ; 5 preuves d'exploitation rejouées : toutes échouent. Base
  locale « rydar » sauvegardée puis remise à l'identique (37 comptes, 5 clients, 1 025 courses, 35 visites, toujours en
  `007800`).
- **Migrations** : `20260924007900_security_audit` poussée (correction = nouvelle migration). La branche du copilote
  (`007500` sur sa branche) prendra **`20260924008000` ou plus** à sa fusion.
- **À faire par le propriétaire** : VPS — bloc `api.DOMAINE` après contrôle IPv6, Caddyfile (2 Mo) si
  `Caddyfile.local` le remplace, `GOTRUE_RATE_LIMIT_HEADER` / `DISABLE_SIGNUP` (DEPLOYMENT § 3) ; mise à jour EAS de
  l'app (JS : connexion uniquement par le serveur) ; build stores 1.2.0 (`SYSTEM_ALERT_WINDOW` bloquée, natif) ;
  clé Google Maps Android restreinte ; décider de la signature des mises à jour EAS.
- **Reporté** : réponse identique à « Inviter un membre », refus des positions simulées dans l'app, nodemailer 10,
  Next 16.4, outils de build sans correctif.

## Visite guidée de première connexion : lots T1 à T3, revues UX et RS et contrôle final faits (11/10/2026)

Plan : `docs/TUTORIEL.md` (statuts des lots § 12.1, écarts § 13.3). T1 = base et paquet partagé ; T2 = moteur de visite
et coquille ; T3 = parcours sur les écrans réels (ancres `data-tour`, conditions de réussite, textes contrôlés à
l'écran) et recette complète ; revue UX = corrections UX-01 à UX-09 ; revue RS = corrections RS-01 à RS-03 ; contrôle
final = tous les contrôles sur l'arbre final, recette de non-régression, parcours rejoués et planches de captures. Rien
dans `apps/driver`, `apps/worker`, ni le seed. Reste : décisions du propriétaire (`TUTORIEL.md` § 13.1) ; migration
007800 pas encore poussée.

### Contrôle final

- **Livré** : aucune ligne de la visite à corriger ; `CLAUDE.md` (§ Métier) : ligne « Visite guidée web » (celle du
  § 13.1, point 3, complétée) ; `TUTORIEL.md` (statut, § 12.1, § 13.1, § 13.3). **Correction à part** (commit séparé,
  signalée en T3 « à corriger à part ») : erreur d'hydratation React #418 de Statistiques et d'En direct quand un montant
  compact arrondi finit par « ,0 » — Node 22 (serveur) écrivait « 34,0 k € », Chromium « 34 k € » ; `formatCompactPrice`
  (`packages/shared/src/format.ts`) passe `minimumFractionDigits: 0`, même texte des deux côtés (affichage du navigateur
  inchangé) ; cas ajouté à `format-cache.test.ts` (échoue sans la correction).
- **Contrôles** (arbre final) : `pnpm typecheck` OK ; `pnpm test` 170 fichiers, 1 940 tests (+1) ;
  `TEST_DATABASE_NAME=rydar_test_tuto pnpm test:db` 52 fichiers, 883 tests ; `pnpm build` OK (paquet partagé, worker
  avec `dist/mailer.js`, web) ; build web sur `.next` effacé avec les variables factices de la CI : OK ;
  `pnpm --filter @rydar/driver export:check` OK ; base neuve comme la CI (`scripts/db-local.sh --reset --seed`, base
  `rydar_demo_tuto` supprimée ensuite) : 80 migrations puis le seed, 29 chauffeurs, 3 organisations, 1 signalement
  ouvert, commissions dues, `user_tours` vide (le rattrapage de 007800 passe avant le seed).
- **Recette de non-régression** (`l7/e2e/run-all.sh` : `tour-off.sql` après la réinitialisation et après `s1-create`,
  puis `s10-smoke-standard` ; build de production :3210 joint par :3000) : **112 contrôles OK, 0 échec**, avant et
  après la correction #418 ; mêmes contrôles, résultats et erreurs navigateur connues qu'en T3 (seuls changent les
  identifiants tirés au hasard et, une fois, un délai de dispatch mesuré : 120 s au lieu de 123 s) ; aucune visite
  ouverte pendant la recette (`tour-off` : 170 puis 175 lignes, 0 hors pause).
- **Parcours rejoués** (scénarios TR-01 à TR-10 du lot T3, `scratchpad/tutoriel/e2e/`, clients de recette neufs) :
  passe « f » 473 OK et 5 échecs, tous dans les scripts de recette, aucun dans l'application — TR-06 (4) : contrôle
  écrit avant la revue UX ; au téléphone, sur En direct, la fenêtre passe au-dessus du panneau des courses (UX-02) et
  la cible est visible dessous ; contrôle adapté (cible dégagée de la fenêtre, au-dessus, ou dessous pour les deux
  ancres d'En direct seulement) ; TR-04 (1) : « C'est fait. » en 6,26 s, compté depuis la demande de clic de
  Playwright, qui attend d'abord que « Créer la course » soit cliquable (≈ 1 s, davantage pendant le démarrage du
  worker) ; compté maintenant depuis l'envoi réel du formulaire. Passe « g » : **478 contrôles OK, 0 échec**
  (17 actions réelles, « C'est fait. » 0,2 à 2,7 s après l'enregistrement). Mesure à part
  (`final/debug/ride-timing.mjs`) : course enregistrée 1,1 à 1,7 s après l'envoi, « C'est fait. » 0,1 à 0,15 s plus tard
  (relecture de 1,5 s ou temps réel).
- **Captures** (hors dépôt, `scratchpad/tutoriel/final/`) : `captures/<parcours>/` (accueil ; chaque étape à 1440×900
  sur l'écran réel ; « C'est fait. » après l'action réelle ; chaque étape à 390×844) ; une planche par parcours
  (`planches/1-super_admin.png` à `5-private_fleet.png`, outil `outils/planches.py`) ; 5 captures choisies pour le
  propriétaire, une par profil (`selection/`).
- **Vu, sans correction** : l'alerte du dispatch « Aucun chauffeur pour #… » passe au-dessus de la fenêtre de visite
  quand elles se croisent en haut d'En direct (calque prioritaire voulu, § 6.8 : l'urgence d'abord ; la fenêtre redevient
  lisible dès l'alerte fermée ou traitée). Base de recette : une fois, l'écran des CGV de « Lambert » lu absent juste
  après sa création (`refonte/photo/fp-setup.mjs`, puis `fp-rides.mjs` en échec) ; écran présent au rechargement,
  relancé, script rendu patient (8 s) ; rien côté application.
- **Base locale « rydar »** : après la dernière recette, base de la refonte refaite (`T3/base.sh` : Flotte Privée
  « Lambert », conditions du dispatcher de démonstration, identifiants des listes de pages) ; visites dans l'état
  d'après la migration : 35 lignes en pause, jamais ouvertes ; 5 clients, 37 comptes, aucun e-mail en file ; les
  clients de recette ont disparu avec la réinitialisation.
  Serveur, relais, app chauffeur et worker arrêtés par PID ; `apps/driver/tsconfig.json` (réécrit par Expo) remis.

### Revue RS — corrections RS-01 à RS-03 : fenêtre sortie des calques de Radix

- **Livré** (web seulement, `components/tour/` et un test de la coquille : aucune migration, aucune RPC, garde ou action
  serveur modifiée ; détail et écarts : `TUTORIEL.md` § 6.3, § 6.6, § 6.8 et § 13.3, « Revue RS ») :
  - RS-01 et RS-02, cause commune : le `Popover` non modal faisait de la visite un calque de Radix. Une visite affichée
    après une fenêtre déjà ouverte (réseau lent) prenait son Échap et cassait son piège à focus ; visite dépliée, tout
    Échap de la page arrivait annulé (champs de recherche jamais vidés). Maintenant : positionnement seul par le Popper
    de Radix (`radix-ui/internal`, aucune dépendance ajoutée), dans un portail ; ni `DismissableLayer`, ni `FocusScope`,
    ni gardes de focus (`guardTarget` retiré) ; Échap traité par la fenêtre elle-même, focus dedans (`tourEscape`).
  - RS-01, en complément : ouverture d'office et premier affichage attendus tant qu'une fenêtre, une fenêtre d'alerte ou
    un menu est ouvert (`whenNoLayer`, `tour-dom.ts`). Écart : Radix ne pose pas `aria-modal` ; tout `role="dialog"`
    sauf la visite compte (fenêtres non modales d'En direct et de la cloche comprises).
  - RS-03 : 3 cas de `dashboard-layout.test.ts` (mise à jour des CGV → bloquée ; convention du réseau partagé →
    différée ; dispatcher : ni l'un ni l'autre) ; garde de rendu du fournisseur extraite en `tourVisible`, testée.
- **Contrôles** : `pnpm typecheck` OK ; `pnpm test` 170 fichiers, 1 939 tests (+1 fichier `tour-dom.test.ts`, +13
  tests ; `components/tour` : 130) ; `pnpm --filter @rydar/web build` OK ; 12 mutations (dont les 3 du constat),
  toutes détectées ; pas de `test:db` (aucun SQL).
- **Recette** (hors dépôt, `scratchpad/rs-fix/`, build de production d'une copie isolée :3253, compte « flotte » du
  seed, document réécrit et actions serveur bloquées : aucune écriture) : fenêtre « Nouveau chauffeur » ouverte avant
  l'ouverture d'office, morceau de la visite retardé de 2,5 s ou non (accueil et étape) → aucune visite par-dessus, Tab
  et Échap restent à la fenêtre, puis la visite s'affiche (accueil : focus sur son titre) ; calque de test ouvert 3 s
  dès l'hydratation → ouverture d'office attendue, rien d'écrit avant ; témoin « visite d'abord » :
  gardée dessous ; Échap dans un champ de recherche (Journal, Chauffeurs, Courses) vidé, visite fermée, dépliée,
  réduite ou redépliée ; aucune garde de focus, 120 Tab et 120 Maj+Tab sans arrêt invisible ; mode ancré, téléphone,
  menu du compte et tiroir, « Y aller » (375×667 à 1440×900) inchangés ; aucun calque présent au repos sur les pages
  des menus (flotte, super admin, Flotte Privée). Contre-épreuve : les scripts RS-01 et RS-02 échouent sur le build de
  `305d1bd`.

### Revue UX — corrections UX-01 à UX-09

- **Livré** (web seulement : aucune migration, aucune RPC, garde ou action serveur modifiée ; détail et écarts :
  `TUTORIEL.md` § 13.3, « Revue UX ») :
  - UX-01 (focus caché sous la fenêtre en repli, WCAG 2.2, 2.4.11) : marge de défilement du bas de `<html>` jusqu'au
    haut réel de la fenêtre (rendue au retrait) et filet `focusin` (défilement, sinon pastille). Cause profonde trouvée
    à la recette et corrigée : la fenêtre suivait la barre « Enregistrer » collante quand elle remonte avec la page en
    fin de formulaire ; une barre collante compte maintenant à sa place collée au bas de l'écran, et la réserve de
    défilement va jusqu'à la fenêtre remontée au-dessus d'elle (indépendante du défilement).
  - UX-02 et UX-08 : attributs seuls — panneau d'En direct à éviter (téléphone : fenêtre sur la carte, au-dessus du
    panneau) ; carte en direct du super admin en vue pleine hauteur, légende à éviter.
  - UX-03 : étape faite affichée hors de son écran (« Revoir la visite ») : « Ouvrir … » en secondaire, puis « Suivant ».
  - UX-04 : « Attribuer une course » lit l'attribution elle-même (`ride_events`, `ride.assigned_manually` par
    l'utilisateur, existence sur 30 jours).
  - UX-05 : notifications au-dessus de la fenêtre en repli (`--tour-dock`, `Toaster` : `mobileOffset` et `offset`),
    seulement quand elle est dans leur bande, jamais hors de l'écran.
  - UX-06 : touche N d'En direct depuis la fenêtre de visite (Échap y reste à la visite).
  - UX-07 : gardes de focus de Radix renvoyées (aucun arrêt invisible au clavier).
  - UX-09 : « Y aller » vise `[data-tour-focus]`, puis le filtre affiché, puis la première commande, les liens ensuite.
- **Contrôles** : `pnpm typecheck` OK ; `pnpm test` 169 fichiers, 1 922 tests (+20 ; dossier `components/tour` : 116) ;
  `pnpm --filter @rydar/web build` OK ; 12 mutations des corrections, toutes détectées par les tests ; pas de
  `test:db` (aucun changement SQL).
- **Recette** (hors dépôt, `scratchpad/tutoriel/correction-ux/`, build de production :3237, comptes de la revue,
  `user_tours` et téléphone de l'organisation rendus ensuite) : Tab dans Organisation, Tarifs, Commission (1440 et
  390) et `/admin/legal` : 0 élément focalisé caché, fenêtre restée dépliée ; En direct 390 (flotte 4, centrale 5,
  dispatcher 1 et 2) : onglets, liste et « Nouvelle course » visibles ; paysage 844×390 : étape ancrée inchangée (deux
  onglets du milieu sous la fenêtre) ; « Revoir la visite » hors écran → « Ouvrir … » + « Suivant » ; dispatcher :
  « C'est fait. » d'après ses attributions (et pas sans) ; notifications posées au-dessus de la fenêtre (390 et
  1280) ; N depuis la fenêtre → « Nouvelle course » ; premier Tab → « Aller au contenu », 240 arrêts sans garde
  invisible ; carte du super admin sans réserve ni défilement, fenêtre au-dessus de la légende ; « Y aller » →
  « Sans chauffeur », « Je la prends », premier champ des formulaires ; non-régression TE-11 (Tarifs en saisie, 1440
  et 390) : la fenêtre ne coupe jamais la barre collée en bas, et en bas de page la barre est au-dessus d'elle.

### Vérification de la revue UX — UX-01 (suite) : focus de « Y aller » sur téléphone court

- **Livré** (web seulement, `components/tour/` ; détail : `TUTORIEL.md` § 6.3, § 6.4 et § 13.3, « Vérification de la
  revue UX ») : sous ~750 px de haut, « Y aller » plaçait le focus sur un contrôle caché sous la fenêtre en repli
  (« Je la prends » confirmable sans le voir). Maintenant : position finale calculée d'avance (élément focalisé
  entièrement au-dessus de la fenêtre, sous la barre du haut), un seul défilement en douceur, puis vérification une
  fois le défilement terminé par la fonction du filet, règle « overlap » (2.4.12 visé) : défilement, sinon pastille.
  Règle pure `focusCovered` / `revealWithin` (`tour-model.ts`), aides `revealAboveCard` / `afterScroll`
  (`tour-dom.ts`). Filet du Tab inchangé (2.4.11).
- **Contrôles** : `pnpm typecheck` OK ; `pnpm test` 169 fichiers, 1 926 tests (+4 ; `components/tour` : 120) ;
  `pnpm --filter @rydar/web build` OK ; 6 mutations de la règle, toutes détectées ; pas de `test:db` (aucun SQL).
- **Recette** (`scratchpad/tutoriel/fix-ux01/`, build :3271) : défaut reproduit sur `bd285c3`, puis corrigé à 375×667,
  360×640 et 360×740 (Organisation, Tarifs, Commission, lien d'inscription, réservation Flotte Privée : élément à
  12 px au-dessus de la fenêtre, défilement sans saut) ; 390×844 et bureau inchangés (captures identiques au pixel
  près, hors teinte de survol du bouton) ; 667×375 : au-dessus de la fenêtre ou fenêtre réduite ; mêmes positions
  processeur bridé ×6 et animations réduites ; Tab : 0 élément caché, aucune pastille.

### T3 — Parcours sur les écrans réels, conditions de réussite et recette

- **Livré** (web seulement : aucune migration, aucune RPC, garde ou action serveur modifiée) : les 21 attributs
  `data-tour` du § 9.1 dans 19 fichiers (attribut seul ; `PlanEditor` : `data-tour={plan ? undefined : "sa-new-plan"}`)
  ; `components/tour/tour-checks.ts` : lectures du § 8 avec le client du navigateur (RLS de l'utilisateur, comptages
  `head`, en parallèle, seulement les clés du parcours ; clé absente si la lecture échoue) — `legal_editor` par
  `adminLegalTodo`, `org_identity` par `bookingOperatorGaps`, règles pures `settlementReady` (alignée sur
  `private.settlement_methods_available` : virement avec IBAN ou consignes) et `billingConfigured` ; tests
  `tour-checks.test.ts` (22) et `tour-content.test.ts` (17 : règles du § 7.1, lexique, chaque ancre posée une fois et
  une seule, adresses vers des pages existantes avec `tab` / `filter` connus, pages du menu de chaque profil, Flotte
  Privée jamais vers une page masquée). Moteur, corrigé d'après la recette : relecture des conditions aussi après un
  clic sur un bouton de la page (« Enregistrer » de la commission, « Créer le lien d'inscription », « Je la prends », «
  Attribuer la course » ne sont pas des formulaires), élément de l'étape cherché avant l'affichage (`useLayoutEffect` :
  plus d'image avec l'élément de la page quittée). Trois textes ajustés à l'écran réel : `ce-ride` (« le paiement reçu
  »), `di-messages` (« messages à modérer »), `fp-first-steps` (« Chaque ligne dit quoi faire et où »).
- **Contrôles** : `pnpm typecheck` OK ; `pnpm test` 169 fichiers, 1 902 tests (+2 fichiers, +39 tests ; dossier
  `components/tour` : 96) ; `pnpm --filter @rydar/web build` OK ; `TEST_DATABASE_NAME=rydar_test_t3 pnpm test:db`
  52 fichiers, 883 tests ; `tour-checks.ts` éprouvé par 10 mutations (toutes détectées) ; un attribut retiré
  (`team-add-member`, puis `sa-new-plan`) fait échouer 3 tests de `tour-content.test.ts` (fichiers remis) ;
  `git diff` des 19 fichiers du § 9.1 : 21 lignes `data-tour`, rien d'autre ; rien sous `apps/driver`, `apps/worker`,
  `supabase/`.
- **Recette des parcours** (hors dépôt, `scratchpad/tutoriel/e2e/t3-run-all.sh`, build de production :3210, clients de
  recette neufs) : TR-01 à TR-08 et TR-10, **478 contrôles OK, 0 échec** (super admin 52, flotte 55, clients 6,
  centrale 54, dispatcher 44, Flotte Privée 39, téléphone 135, « Passer l'étape » 28, adresses Flotte Privée 10,
  accessibilité 55). À 1440×900, pour chaque étape : « Ouvrir … » mène à l'écran, la cible porte
  `data-tour-highlight`, contrôle → fenêtre ancrée à côté (aucun chevauchement), zone → repli centré et zone amenée à
  l'écran, « Y aller » → focus dans la cible ; 17 actions réelles (éditeur, coordonnées, offre, client ; identité,
  grille, chauffeur, course, membre ; identité, grille, lien de paiement, lien d'inscription, course ; course créée et
  course attribuée par le dispatcher ; « Je la prends ») → « C'est fait. » en 0,2 à 3,0 s, puis « Suivant ». À 390×844 :
  repli centré partout (16 px de marge), aucun défilement horizontal, cible visible sous la barre du haut, boutons
  ≥ 44 px. « Passer l'étape » seulement (comptes du seed) : `rides`, `drivers`, `organizations`, `pricing_rules`,
  `organization_users`, `api_keys`, `plans` inchangés (nombres et empreintes), seule `user_tours` change. Flotte
  Privée : les 5 adresses en 200, sans redirection (client de recette et « Lambert »). Accessibilité : nom et
  description de la fenêtre, focus sur le titre, boutons-icônes nommés, zone `aria-live`, Échap (fenêtre seulement),
  aucune animation, aucun texte sous 12 px. Aucune erreur navigateur. Captures : `scratchpad/tutoriel/captures/t3/`
  (77 images : accueil, chaque étape à 1440 et 390, étape faite, accessibilité), copie dans `T3/captures/`.
- **Non-régression (TR-09)** : scripts existants adaptés pour passer `tour-off.sql` (copies `.avant-t3` gardées) :
  `l7/e2e/run-all.sh` (après la réinitialisation et après `s1-create`), `refonte/photo/shoot.mjs` et sa copie de fin
  de refonte `refonte/final/shoot-final.mjs`, `refonte/controle/mesure.mjs` (au départ ; sorties et liste de pages
  réglables pour ne jamais réécrire les références) ; enchaînement `scratchpad/tutoriel/T3/recette.sh`, `base.sh`,
  `photo.sh`, `compare.mjs`. Recette L7 puis `s10-smoke-standard` sur base neuve : **112 contrôles OK, 0 échec**
  (110 + 2), mêmes contrôles et mêmes erreurs navigateur connues qu'à la fin de la refonte et au lot T2 ;
  `tour-off.sql` : 170 lignes, puis 175 après `s1-create` ; aucune visite ouverte. Captures des 5 profils (base de
  la refonte, 1440 et 390) : **721 captures** comme la référence, mêmes pages, statuts, redirections, 203 fenêtres et
  113 onglets, aucun débordement ; les 23 écrans des 25 étapes : hauteur et largeur identiques à la référence ; 19 vues
  sur 374 changent de hauteur, toutes sur des listes ou fiches qui dépendent des données du jour. Mesures des
  5 profils : « tout est conforme », 402 mesures comme en R11, barre latérale et tiroir identiques, annexe A tenue
  avec les valeurs de fin de refonte (`/admin` à 390 : 2 206 px, écart connu). **À signaler (antérieur, hors du
  lot)** : erreur React #418 sur Statistiques (flotte, dispatcher) — le serveur écrit « 34,0 k € », le navigateur
  « 34 k € » : `formatCompactPrice` (`packages/shared/src/format.ts`) donne un résultat différent entre l'ICU de
  Node 22 et celui de Chromium quand le montant arrondi finit par « ,0 » (données du jour ; « 29,6 k € » lors de la
  référence) ; à corriger à part (même format des deux côtés). Captures et journaux : `scratchpad/tutoriel/T3/recette/`
  (`shoot/`, `mesure/`, `comparaison.json`, `captures/` de la recette L7).
- **Base locale « rydar »** : après la recette, base de la refonte refaite comme en T2 (`T3/base.sh` : Flotte Privée
  « Lambert », conditions acceptées par le dispatcher de démonstration, identifiants des listes de pages remis à jour
  par `T3/maj-ids.mjs`) ; visites remises dans l'état d'après la migration : 35 lignes en pause, jamais ouvertes ;
  5 clients, 37 comptes, aucun e-mail en file. Les clients de recette du lot ont disparu avec la réinitialisation.
  Serveur, relais, app chauffeur et worker arrêtés par PID ; `apps/driver/tsconfig.json` (réécrit par Expo) remis.
- **Écarts** : `TUTORIEL.md` § 13.3 (T3) — virement « avec IBAN ou consignes » (comme la base), relecture après un
  clic, recherche de l'élément avant l'affichage, trois textes ajustés, règle « une ou deux phrases » non contrôlée
  (trois textes du plan en ont trois, gardés), particularités de la recette (valeurs de Rydar ressaisies par l'écran,
  comptage « Clients » intercepté, délais de dispatch courts sur le client de recette).

### T2 — Moteur de visite et intégration dans la coquille

- **Livré** (web seulement : aucune migration, aucune RPC, garde ou action serveur existante modifiée) : dossier
  `apps/web/components/tour/` — `tour-model.ts` (pur : démarrage, réducteur, écriture à faire, entrée du menu, boutons,
  position du repli, textes `TOUR_UI`), `tour-content.ts` (les 5 parcours du § 7, textes par `fr()`), `tour-checks.ts`
  (squelette : `loadTourChecks` rend `{}`, tout « inconnu » ; `stepDone`), `tour-provider.tsx` (état, ouverture
  d'office ~400 ms après le chargement, jamais pendant une acceptation, une lecture en échec ou une urgence ; écritures
  en série ; toasts ; entrée du menu), `tour-card.tsx` (fenêtre Radix Popover non modale chargée à la demande : ancrée,
  repli centré au-dessus des barres `data-tour-avoid`, pastille ; surlignage ; focus ; Échap ; réserve de défilement
  `--tour-reserve`), `tour-panel.tsx` (contenu sans logique), `tour-dom.ts` ; action serveur `app/visite/actions.ts`
  (`saveTourProgress` → `save_user_tour`). Coquilles : `TourProvider` dans `DashboardShell` et `AdminShell` ;
  « Reprendre la visite » / « Revoir la visite » dans le menu du compte (`Sidebar.accountItems`, avant « Se
  déconnecter », tiroir compris). Mises en page : lecture de `user_tours` en parallèle des autres ; `blocked` (écran ou
  bandeau d'acceptation), `urgent` (courses sans chauffeur, réservations à traiter, convention du réseau ; super admin :
  signalement de fraude ou suppression de compte en échec). `globals.css` : règle `[data-tour-highlight]`. Attributs
  seuls : `data-tour-avoid` (3 barres « Enregistrer », barre de sélection des règlements, compositeur de Messages),
  `data-tour-fullheight` (En direct, Messages). Les ancres `data-tour` sont posées en T3 : d'ici là, chaque étape
  s'affiche en repli centré, en bas de l'écran.
- **Contrôles** : `pnpm typecheck` OK ; `pnpm test` 167 fichiers, 1 863 tests (+3 fichiers, +69 tests :
  `tour-model.test.ts` 41, `tour-panel.test.ts` 11, `tour-actions.test.ts` 5 ; cas ajoutés à `dashboard-layout.test.ts`
  (7), `admin-pages.test.ts` (4) et `cookie-notice.test.ts` (1), aucun retiré) ; `pnpm --filter @rydar/web build` OK ;
  grep du critère 16 vide, aucun `text-[10px]` / `text-[11px]` dans `components/tour`.
- **Bout en bout** (hors dépôt, `scratchpad/tutoriel/e2e/t2-run-all.sh`, build de production :3210, client de recette
  neuf) : TE-01 à TE-14 et complément « ancre » : **159 contrôles OK, 0 échec**. Accueil d'office 1,2 s après le
  chargement, focus sur son titre ; écran des CGV puis bandeau des CGU : ni fenêtre ni entrée de menu, accueil sans
  rechargement après l'acceptation ; « Plus tard », reprise, fin, « Revoir » (`completed_at` gardé) ; liens réels sans
  préchargement et garde « Quitter sans enregistrer ? » ; Échap (fenêtre, champ, dialogue par-dessus) ; pastille de
  44 px ; ouverture différée (Élite, Flotte Privée « Lambert », super admin avec un signalement) ; 390×844 (16 px de
  marge, aucun débordement, reprise depuis le tiroir) ; barres collantes jamais recouvertes, réserve de défilement,
  aucune réserve sur En direct et Messages ; Tab sans piège, focus visible, aucune animation ; aucune requête vers un
  autre hôte, aucune clé de stockage. Captures (60 contrôles OK) : chaque étape des 5 parcours à 1440×900 et 390×844,
  et celles des scénarios — `scratchpad/tutoriel/captures/t2/` (96 images).
- **Recette existante** (critère 17, `scratchpad/tutoriel/T2/recette.sh`) : base recréée (`l7/e2e/reset.sh` :
  migrations, 007800 comprise, puis seed), `tour-off.sql` après la réinitialisation (170 lignes : 34 comptes × 5) et
  après `s1-create` (175), puis les étapes de `run-all.sh` et `s10-smoke-standard` : **112 contrôles OK, 0 échec**
  (110 + 2, comme avant le lot), scripts L7 inchangés ; mêmes contrôles et mêmes erreurs navigateur qu'à la passe R11
  (`/favicon.ico` en 404, 404 voulus de s2, 500 `NETWORK_DISABLED` de l'app : antérieurs) ; aucune visite ouverte
  pendant la recette (aucun `shown_at`, aucune ligne `active`). Captures de la recette dans `T2/recette/captures/` (40),
  celles de la recette L7 rétablies.
- **Base locale « rydar »** : après la recette, base de la refonte refaite comme en R11 (`T2/base.sh` : Flotte Privée
  « Lambert » par `fp-setup.mjs` et `fp-rides.mjs`, conditions acceptées par le dispatcher de démonstration,
  identifiants des listes de pages remis à jour par `T2/maj-ids.mjs`) ; visites remises dans l'état d'après la migration
  (bloc de rattrapage) : 35 lignes (7 comptes super admin ou membres × 5), en pause, jamais ouvertes ; 5 clients, 37
  comptes, réseau partagé fermé, aucun e-mail en file. Les clients de recette du lot ont disparu avec la
  réinitialisation. Serveur, relais, app chauffeur et worker arrêtés par PID ; `apps/driver/tsconfig.json` (réécrit par
  Expo au lancement de l'app web) remis à l'identique.
- **Écarts** : `TUTORIEL.md` § 13.3 (T2) — notamment pas de « Réduire » sur l'accueil, Tab qui sort de la fenêtre
  (Radix y boucle), mode ancré seulement si l'élément est dans l'écran, marge de défilement à 0,75rem (celle de `<html>`
  s'y ajoutait), TE-02 / TE-03 sur un client de recette neuf plutôt que sur le seed.
- **À savoir pour T3** : la fenêtre passe d'elle-même en mode ancré quand `[data-tour="<id>"]` apparaît (contrôle
  visible à l'écran, ≥ 640 px ; vérifié par `e2e/t2-09-ancre.mjs` avec un attribut posé dans le navigateur) ;
  `loadTourChecks` reste à écrire (§ 8) : `stepDone`, les clés de chaque étape et la relecture (`TourChecksSync`) sont
  en place ; outils réutilisables : `e2e/t2-lib.mjs` (fenêtre, pastille, ligne en base, remise à zéro, menu du compte) et
  `T2/recette.sh` (TR-09 : y ajouter `refonte/photo/shoot.mjs` et `mesure.mjs`). `pnpm web` (app chauffeur) réécrit
  `apps/driver/tsconfig.json` : le remettre (`git checkout`) après chaque recette.

### T1 — Base et paquet partagé

- **Livré** : migration `20260924007800_guided_tour.sql` (**pas encore poussée**, modifiable jusqu'au push ; identique
  au § 3) : table `public.user_tours` (utilisateur, parcours, état, étape 0 à 4, première ouverture, première fin ; clé
  `(user_id, tour)`, effacée avec le compte), RLS et politique `user_tours_select_own`, aucun droit pour anon ni le
  service role, SELECT seul pour authenticated ; RPC `public.save_user_tour(p_tour, p_status, p_step)` (security
  definer, `search_path` vide, `FORBIDDEN` sans utilisateur, EXECUTE pour authenticated seulement) ; rattrapage : comptes
  super admin ou membres existants mis en pause sur les 5 parcours, jamais ouverts. `@rydar/shared` : `tour.ts`
  (`TOUR_KEYS`, `TOUR_STATUSES`, `TOUR_MAX_STEPS`, `tourProgressSchema`, `tourKeyFor`, `tourSavedFrom`, types),
  exporté par `index.ts`. Registre RGPD : progression de la visite guidée (données, durée du compte).
- **Contrôles** : `pnpm typecheck` OK ; `pnpm test` 164 fichiers, 1 794 tests (+1 fichier, +18 tests : `tour.test.ts`,
  dont listes et borne comparées au fichier de migration) ; `TEST_DATABASE_NAME=rydar_test_t1 pnpm test:db` 52 fichiers,
  883 tests (+1 fichier, +14 tests : `user-tours.test.ts`, les 10 points du § 11.2 et plus) ; tests éprouvés par
  mutation de la migration (8 altérations pour la base, 3 pour le paquet : chacune fait échouer au moins un test ;
  fichier remis à l'identique, empreinte vérifiée).
- **Base locale « rydar »** : migration appliquée à la main (`psql -v ON_ERROR_STOP=1 -f …`, sans erreur) : 35 lignes
  (7 comptes super admin ou membres × 5 parcours), `shown_at` nul partout ; droits relus (anon : aucun ; authenticated :
  SELECT ; service role : aucun ; RPC : authenticated oui, anon non ; `prosecdef`, `search_path=""`). Cache de schéma
  de PostgREST rechargé à la main (`notify pgrst, 'reload schema'` : la pile locale n'a pas de déclencheur pour cela,
  `TUTORIEL.md` § 13.3, point 4 ; à refaire après chaque migration appliquée à la main).
- **Passerelle** (hors dépôt, `scratchpad/tutoriel/T1/gateway-check.mjs`, résultat `gateway-check.json`) : 25 contrôles
  OK par GoTrue et PostgREST avec les 5 profils de recette : chacun lit ses 5 lignes, et la ligne seule comme la lira la
  mise en page ; aucune ligne d'un autre compte ; RPC (création, fin, « revoir » : `shown_at` et `completed_at` gardés ;
  étape 5 et parcours inconnu → 23514 ; paramètre d'utilisateur refusé) ; insertion, modification et suppression
  directes → 42501 ; anon → 42501 ; table remise ensuite dans l'état d'après la migration (identique à l'instantané).
- **Captures** : sans objet pour T1 (aucun écran touché ; le web ne lit la table qu'à partir de T2).
- **À savoir pour T2 et T3** : sur une base neuve (`l7/e2e/reset.sh`, CI), le rattrapage ne voit aucun compte : chaque
  compte du seed verra la visite d'office (annexe A : `tour-off.sql`, écrit en T2) ; sur « rydar », les 7 comptes
  actuels sont en pause. La migration du copilote (`007500` sur sa branche) prendra `20260924008000` ou plus
  (`007900` : audit p5).
- **Reste** : T2 puis T3 (§ 12) ; décisions du propriétaire (§ 13.1 : comptes existants en pause — retirer le bloc de
  rattrapage avant le push pour qu'ils voient la visite d'office ; mention dans `/confidentialite` avec la prochaine
  version ; ligne de `CLAUDE.md`).

## Refonte des panneaux : lots R1 à R11, revue et contrôle final faits (11/10/2026)

Plan, commits des lots et écarts : `docs/REFONTE-PANELS.md` (§ 8.1, § 8.2). Interface web seulement : aucune
migration, aucune RPC, garde ou action serveur modifiée (seuls ajouts : `revalidatePath` vers les pages déplacées,
`fieldErrors` dans des retours en échec, lectures seules pour des résumés), rien dans `apps/driver` ni `apps/worker` ;
hors `apps/web`, quatre tables de libellés lues par le web seul (`packages/shared/src`).

- **Revue puis contrôle final (après R11)** : revue `6c2ce62` (RV-01 à RV-19 : libellés des frais Rydar alignés sur
  ceux du client, offre Flotte Privée d'après ses limites effectives, 44 px au toucher sous 640 px, « Retour » puis
  une action nommée, pastilles rouges lisibles, un seul bouton plein par écran…) et `682aac8` (zones défilantes du
  super admin : `div role="region"` nommé autour de la liste). Contrôle final : `pnpm typecheck` OK ; `pnpm test`
  163 fichiers, 1 776 tests ; `TEST_DATABASE_NAME=rydar_test_refonte pnpm test:db` 51 fichiers, 869 tests ;
  `pnpm build` OK (dossier `.next` vidé) ; recette `l7/e2e/run-all.sh` puis `s10-smoke-standard` : **112 contrôles
  OK, 0 échec**, trois passes sur base neuve, scripts inchangés (erreurs navigateur relevées : `/favicon.ico` en
  404, antérieur ; 404 voulus de s2 ; 500 `NETWORK_DISABLED` de l'app, connu).
  - **Corrigé** : fenêtre « Relancer » des frais Rydar (`admin-account-actions.tsx`) : l'échec de
    `platformWhatsAppTarget` (réseau coupé, requête interrompue) laissait un rejet non traité (« Failed to fetch »,
    reproduit dans le navigateur) ; échec traité, option WhatsApp masquée comme avant ; test
    `admin-account-actions.test.ts` (échoue sur l'ancien code).
  - **Captures définitives** (hors dépôt, `scratchpad/refonte/final/`, script `shoot-final.mjs`, écritures
    bloquées) : 721 captures des 5 profils, 187 pages à 1440 et 390 (203 fenêtres) ; **aucun débordement
    horizontal** ; annexe A tenue sauf `/admin` à 390 : 2 206 px pour ≤ 2 200 (+26 px depuis R11 : cible de 44 px de
    « Voir les données », RV-06, écart gardé) ; 8 planches avant / après pour le propriétaire dans `final/selection/`.
    Base de recette du § 9.1 recréée ensuite (« Lambert », conditions acceptées, identifiants de `refonte/photo`).

- **Livré** :
  - coquille : menu entier visible sans défiler (une seule zone défilante, liens légaux compacts), sections « Au
    quotidien » / « Gestion », badge « Super admin », composants communs (`Callout`, `Disclosure`, `FilterTabs`,
    `ConfirmDialog`, `DialogFooter`, listes en cartes sous 768 px…), lexique `lib/wording.ts`, pages introuvables dans
    les deux espaces ;
  - super admin : menu Pilotage · Clients · Argent · Plateforme ; « À traiter » en tête de la vue d'ensemble (mêmes
    lectures que les pastilles) ; Clients filtrables et cherchables, un seul « Nouveau client » ; fiche d'un client
    résumée (« À surveiller », replis, « Zone sensible ») ; Frais Rydar et Commissions des centrales sans doublon ;
    Signalements de fraude, E-mails et Réglages de la plateforme sur leur page ; Supervision (Dispatch & erreurs,
    Notifications, E-mails, Sécurité & audit) lisible par un non-technicien ;
  - clients : En direct (« À traiter », chiffres sous 1 400 px, chauffeurs sous xl) ; Courses en cartes sur téléphone,
    fiche et chronologie dans les mots du métier, « Attribuer » groupé ; Chauffeurs (chiffres = filtres, déconnexion
    et désactivation confirmées) ; Statistiques ; Agenda ; espace Flotte Privée ; Encaissements (un seul montant des
    frais Rydar, « J'ai payé » en deux temps), Règlements par course ou par chauffeur, relevés ; Inscriptions, Réseau
    partagé, Messages ; Réglages (onglets, saisie non enregistrée protégée, grille tarifaire en un formulaire), API &
    site web (clés révoquées ou remplacées après confirmation), Mini-site.
- **R11 (code)** : propriété `eyebrow` retirée de `PageHeader` (dernier usage : Réseau partagé, où elle n'était plus
  affichée depuis R1) ; `primitives.test.ts` adapté sans cas retiré : absence de sur-titre vérifiée sur le composant et
  par un parcours des écrans qui l'utilisent (contrôle vérifié en remettant volontairement un sur-titre), lien de
  retour du relevé par `back`.
- **Contrôles** : `pnpm typecheck` OK ; `pnpm test` 160 fichiers, 1 765 tests (148 et 1 568 avant la refonte ; 21
  fichiers de test ajoutés ou complétés, aucun cas retiré, aucun `skip`) ;
  `TEST_DATABASE_NAME=rydar_test_refonte pnpm test:db` 51 fichiers, 869 tests ; `pnpm build` OK ;
  `pnpm --filter @rydar/driver export:check` OK ; `git log --name-only` des commits R1 à R10 : 205 fichiers, aucun dans
  `supabase/`, `apps/driver/` ni `apps/worker/` ; aucune nouvelle clé de stockage local, aucune couleur en dur dans
  les fichiers créés, pages publiques et légales inchangées (hors variante compacte de `legal-links.tsx`).
- **Mesures** (build de production sur :3210, `mesure.mjs`, replis fermés, écritures bloquées ; base identique avant
  et après, relevé à l'appui) : 201 pages × 2 largeurs (super admin 37, flotte 41, centrale 55, dispatcher 39, Flotte
  Privée 29 : listes de la passe « avant », pages découvertes par la passe « après », plus `/dashboard/agenda`,
  `/dashboard/rydar` et `/dashboard/reseau-partage`, en 404 tant que le réseau est fermé) : **aucun débordement à 390
  ni à 1440**. Menus des 5 profils : toutes les entrées visibles sans défiler à 1440×900 (bandeau cookies ouvert) et
  1366×768 (dernière entrée : super admin « Supervision » 622-654 px, centrale « Réglages » 524-556 px), une seule zone
  défilante, 8 liens légaux, texte de 12 px au moins ; tiroir à 390 : entrées de 44 px au moins, toutes atteignables.
- **Annexe A, avant → après (cible)** : `/admin` 390 : 3 645 → 2 180 (≤ 2 200), 1440 : 1 940 → 1 445 (≤ 1 700) ;
  fiches Élite 4 474 → 2 017 (≤ 3 000), Express 4 952 → 2 573 (≤ 3 300), Lambert 4 544 → 2 516 (≤ 3 600) ;
  `/admin/frais` 4 594 → 1 391 (≤ 3 000) ; compte Express 6 785 → 4 148 (≤ 4 500) ; `/admin/audit` 1440 : 7 394 →
  1 121 (≤ 3 000) ; `/admin/reseau` fermé 2 319 → 1 075 (≤ 1 400) ; fiche chauffeur 4 782 → 3 469 (≤ 3 500) ;
  Encaissements, haut de « Règlements » ≈ 3 350 → 932 (≤ 1 400) ; relevé d'octobre 8 066 → 3 277 (≤ 3 500) ;
  Réglages › Dispatch 3 780 → 2 358 (≤ 2 600) ; largeur d'API & site web 434 → 390 et du Mini-site ≈ 1 180 → 390 ;
  dernière entrée de la barre latérale visible pour tous. **Toutes les cibles sont atteintes.**
- **Vocabulaire** : texte visible des 5 profils (402 relevés, replis fermés) sans aucun des 18 mots du critère
  (rattacheur, tenant, RLS, trigger, outbox, worker, MRR, Option 1 / 2, Instantané, Timeline, Debug, DBG, WRN,
  Dashboard, failed, queued, trialing) ; ni « Frais plateforme » chez le super admin, ni « ∞ », « push », statut
  anglais ou code brut ; « centrale » chez une flotte seulement dans la description d'une offre (texte saisi dans
  Offres & limites). Grep complémentaire du code lu : restes = identifiants, noms de tables (`email_outbox`), clés et
  codes (`"failed"`, `"trialing"`, `level: "debug"`), composants Radix (`DropdownMenuTrigger`), chemins `/dashboard`,
  faux positifs (« maintenant », `URLSearchParams`), messages en base traduits par `timeline-labels.ts`, tests et
  commentaires ; « worker » visible seulement dans « Détails techniques » de Suppressions de comptes (replié).
- **`new Intl.` restants** (aucun au rendu) : routes d'export CSV `app/admin/frais/[orgId]/export`,
  `app/admin/frais/[orgId]/factures` (frais à facturer) et `app/dashboard/settlements/rydar/export` ; action serveur
  `orgToday` (`app/dashboard/drivers/actions.ts`) ; `components/booking/zoned-time.ts` (heure saisie dans le fuseau de
  l'organisation, appelé à l'initialisation d'un état et dans un effet, jamais au rendu : mini-site public et
  « Nouvelle course ») ; plus un commentaire (`components/eligibility/format.ts`).
- **Recette** : `scratchpad/l7/e2e/run-all.sh` (base recréée : migrations + seed ; worker ; app chauffeur en rendu web ;
  serveur de production du lot joint par un relais 3000 → 3210) : **110 contrôles OK, 0 échec** (104 à la recette L7),
  après report dans les scripts des adaptations des lots (s2, s3 : onglets « Coordonnées » / « Délais et rappels »,
  grille « Business » à un seul « Enregistrer » ; s7b : « Fixer le prix » / « Modifier le prix » ; s6b : confirmation
  « La prendre ») ; `s10-smoke-standard` (organisation standard) : 2 contrôles OK. L'erreur navigateur relevée par
  s1 est `/favicon.ico` en 404 (le site ne déclare que `/icon.svg`, antérieur à la refonte). Ensuite : Flotte Privée de
  démonstration « Lambert » recréée (`fp-setup.mjs`, `fp-rides.mjs`), conditions acceptées par le dispatcher de
  démonstration, identifiants des listes de pages mis à jour (§ 9.1) ; base de recette : 5 clients, 37 comptes,
  réseau fermé, aucun e-mail en file. Serveurs, worker, relais et app arrêtés par PID.
- **Captures** (hors dépôt, `scratchpad/refonte/apres/R11/`) : 717 pages, onglets et fenêtres des 5 profils (super
  admin 161, flotte 108, centrale 273, dispatcher 87, Flotte Privée 88) à 1440 et 390 ; `mesure/` (25, menus et
  tiroirs) ; `lot-r11/` (20 : fiches à lien de retour, relevé, Réseau partagé ouvert le temps des captures) ;
  `recette/` (40, recette de bout en bout). Scripts : `refonte/controle/` (`shoot-apres.mjs`, `mesure-r11.mjs`,
  `pages-r11.mjs`, `mots-r11.mjs`, `observations-r11.mjs`, `annexe-a-r11.mjs`, `shots-r11*.mjs`) et `refonte/r11work/`.
- **Observations** (hors critères, pour les lots propriétaires des fichiers) : espace ordinaire avant « : » ou « ; »
  dans quelques textes visibles — information cookies (`components/legal/cookie-notice.tsx`, hors refonte), Journal
  du dispatch et fiche course (R7 : « Recherche en cours : », « Vol au départ : », « Espèces : … »), Tarifs (R10 :
  « Aucun tarif : aucun prix proposé. », « … sur le mini-site ; »), Commission & encaissement (« Qui reçoit les
  courses : », « Courses plus chères : »), Délais et rappels (« Ensuite : ») — les explications du dispatch
  (« Prénom N. (1,2 km) : … ») sont des messages écrits en base, hors périmètre ; fenêtre « Centrale changée dans un
  autre onglet » (`components/shell/dashboard-shell.tsx`) : « centrale » aussi pour une flotte (compte à plusieurs
  organisations) ; fenêtre « Relancer » des frais Rydar : corrigée au contrôle final (ci-dessus).
- **Reste** : décisions du propriétaire (`REFONTE-PANELS.md` § 7 : Agenda des flottes et centrales, « Inscriptions »
  pour les centrales, abonnement pendant l'essai, ligne « Design » de CLAUDE.md) ; puis le tutoriel de première
  connexion (§ 10).

## Flotte Privée : pack livré et recetté, lots L1 à L7 faits (10/10/2026)

Spécification, statuts des lots (commits) et écarts livrés : `docs/FLOTTE-PRIVEE.md` (§ 15 et § 15.1). Migrations
`20260924007600_private_fleet` et `20260924007700_private_fleet_owner_settlements` **pas encore poussées** (modifiables
jusqu'au push) ; la migration du copilote (`007500` sur sa branche, en collision avec `007500_eligibility`) prendra
`20260924008000` ou plus à sa fusion (`007800` : visite guidée, `007900` : audit p5).

- **Livré** : organisation flotte marquée `organizations.private_fleet`, dont le propriétaire est l'unique chauffeur
  (même compte, fiche `owner_driver`) ; ni équipe, ni lien d'inscription, ni réseau, ni centrale (gardes en base +
  `org_limits` : 1 chauffeur, 1 accès) ; réservations du site (API v1) proposées « à confirmer » en ligne ou non, quelle
  que soit la distance, avec rappels, « Refusée », dernier appel GPS puis « Non confirmée », « La prendre » jusqu'à 6 h
  après l'heure ; agenda (app `/planning` : Liste, Jour, Semaine, Mois ; web `/dashboard/agenda`) ; espace web épuré
  (le reste masqué ET refusé) ; super admin : création (compte neuf, invitation), clé du site, bascule flotte / centrale
  et retour, création depuis une demande « eligibility » ; API : `POST /api/v1/quotes`, `expected_price_cents`
  (409 `PRICE_CHANGED`), limites des clés navigateur ; en centrale, le gérant ne se doit jamais de commission (007700).
  Documentation : ARCHITECTURE § 14, SECURITY « Flotte Privée », API « Site d'un client Flotte Privée », DEPLOYMENT § 7
  (ordre de déploiement, création d'un client), STORES § 10 ; CLAUDE.md (ligne « Métier » soumise au propriétaire).
- **Déploiement** (DEPLOYMENT § 7) : migrations, puis web et worker (`bash deploy/update-production.sh`, dans cet
  ordre), puis mise à jour EAS de l'app (runtime 1.1.0, JS seul) avant le premier client, puis 1.2.0 des stores.
- **Recette de bout en bout (L7, FLOTTE-PRIVEE § 13.3)** : pile locale complète sur base neuve
  (`scripts/local-stack/setup.sh` puis `start.sh` : migrations jusqu'à 007700 + seed), web en build de production
  (`next start`), worker (`pnpm dev:worker`), app chauffeur en rendu web (`pnpm --filter @rydar/driver web`, :8081), géo
  de dev (`scripts/dev-geo`), Chromium 141 (Playwright 1.56) ; scripts de recette hors dépôt. **114 contrôles, 0 échec** :
  1. super admin : `/admin/legal` rempli (préalable des CGV), « Nouveau client Flotte Privée » (adresse déjà connue
     refusée avant tout compte ; création par invitation : organisation flotte, lien fermé, offre Pro, fiche
     `owner_driver` « Confirmé » sur le compte du propriétaire, profil Flotte Privée, audit avec la référence du
     contrat) ; badge et filtre de la liste ;
  2. client : lien d'invitation → mot de passe → CGV et DPA (avec CGU et confidentialité) avant tout → menu exact du
     § 7.2 et sous-titre « Flotte Privée » ; 7 adresses interdites redirigées, `/dashboard/network` et
     `/dashboard/reseau-partage` en 404 ; Réglages sans Équipe ni Dispatch ; grille « Business » et délai de réponse
     (1 min) réglés par le client ;
  3. super admin : clé navigateur (`https://vtc-moreau-recette.fr` et sa variante www) et clé serveur, affichées une
     fois (en base : préfixe et 4 derniers caractères), audit `api_key.created` ; « Mon site » du client en lecture seule ;
  4. site simulé dans Chromium sous `https://www.vtc-moreau-recette.fr` (appels `fetch` du navigateur : origine et
     CORS réels) : webhook enregistré par la clé serveur ; devis 73 € (Orly → Saint-Lazare, 18,9 km) ; prix attendu
     faux → 409 `PRICE_CHANGED`, rien de créé ; réservation #1001 au prix affiché (201, `OFFERED`) ; autre origine
     bloquée (403 `ORIGIN_NOT_ALLOWED`) ; offre `fleet` à sa fiche, échéance = prise en charge − 60 min, « NOUVELLE
     RÉSERVATION » (`ride_offer_scheduled`), 3 rappels « RÉSERVATION À CONFIRMER », webhook `ride.created` en file ;
  5. app : accueil (pastille « 1 réservation à traiter », « À confirmer (1) », ni Messages ni Signaler), agenda en vue
     Mois avec le bloc « À confirmer », « Confirmer » → `ACCEPTED`, rappels « à confirmer » annulés, rappels de course
     programmés, webhook `ride.accepted` en file ; Mois (« lundi 12 octobre, 1 course ») et Jour (08:30) ;
  6. réservation immédiate #1002 laissée sans réponse : offre de 60 s qui sonne (`ride_offer`), dernier appel GPS, puis
     `NO_DRIVER_FOUND` en 2 min 3 s, « RÉSERVATION NON CONFIRMÉE » sans `data.ride_id`, webhook `ride.no_driver_found` ;
     web : « À traiter » et pastille rouge ; app : « Non confirmées » → « La prendre » (confirmation) → `ACCEPTED`,
     `ride.taken_by_driver`, aucune « COURSE ATTRIBUÉE » vers lui-même, webhook `ride.accepted` ;
  7. agenda web Mois, Semaine, Jour, Liste (téléphone sans défilement horizontal) ; Réservations (filtres), fiche (Je la
     prends, Refuser, Annuler, Modifier le prix ; jamais Attribuer, Relancer, Retirer) ; « Refuser » web → « Refusée »
     sans « non confirmée » ; « Je la prends » web → offre acceptée sans « COURSE ATTRIBUÉE » ; Mon profil chauffeur,
     Activité ;
  8. passage en flotte (offre Pro, note) : profil standard, limites de l'offre, audit, diffusion `platform.updated` et
     `driver.updated`, rien de perdu (courses, fiches, clés, webhooks, tarifs, acceptations) ; menu standard ; 2e
     chauffeur créé par le client ; centrale avec la note (CGV art. 3) et commission de 20 % réglée par le client ;
     courses du gérant terminées dans l'app (glissière, 5 étapes) → aucun règlement (007700), prix affiché sans
     commission ; course d'un autre chauffeur → règlement « dû » (non-régression) ;
  9. retour en Flotte Privée refusé par la base (`model`, `drivers`), raisons en rouge dans le dialogue, rien d'écrit.
  En plus : organisation standard inchangée (rôle sous le nom, textes de la clé navigateur) ; `pnpm dev` (6 pages,
  aucune erreur).
- **Corrigé pendant la recette** (test ajouté pour chacun) : sous-titre « Flotte Privée » de la barre latérale (§ 7.2)
  invisible (simple attribut `title` du logo) → affiché sous le nom de l'organisation (`sidebarOrgCaption`) ;
  `getOrgContext` transmettait la fiche chauffeur d'une autre organisation du compte → filtrée comme dans `requireOrg` ;
  Intégrations : clé navigateur décrite « création de courses uniquement » → « création de courses et devis ».
- **Contrôles** (après les corrections) : `pnpm typecheck` OK ; `pnpm test` 148 fichiers, 1 568 tests ;
  `TEST_DATABASE_NAME=rydar_test_e2e pnpm test:db` 51 fichiers, 869 tests ; `pnpm build` OK ;
  `pnpm --filter @rydar/driver export:check` OK ; `setup.sh` (3 organisations, 29 chauffeurs) puis `start.sh` ;
  `pnpm dev`, `pnpm dev:worker` et `pnpm --filter @rydar/driver web` démarrés et utilisés.
- **Captures** (hors dépôt, `scratchpad/flotte-privee-captures/` de la session) : 01 à 04 super admin (formulaire, adresse
  refusée, fiche, liste filtrée) ; 05 à 14 client (mot de passe, conditions, accueil, 404, onglets, tarifs,
  réservations, clés, Mon site) ; 15 à 22 app (accueil, à confirmer, après confirmation, Mois, Jour, non confirmée,
  après « La prendre ») ; 23 à 25f web (agenda Mois, Jour, téléphone, Réservations, fiche, actions, profil, activité) ;
  26 à 34 bascules (dialogue flotte, fiche, menu standard, 2e chauffeur, confirmation centrale, course du gérant,
  retour refusé) ; 35 organisation standard (clé navigateur).
- **Observations de la recette (non bloquantes)** :
  - « Application utilisée » (accueil web, Premiers pas, carte du super admin) = `drivers.last_seen_at`, posé seulement
    en ligne ou en course : un chauffeur qui confirme depuis ses notifications sans passer en ligne reste
    « application jamais ouverte » (signal plus juste à décider : jeton de notification enregistré, connexion) ;
  - app en rendu web : `Alert.alert` ne fait rien (react-native-web), donc « La prendre » et « Refuser » (confirmés par
    une alerte) n'aboutissent pas dans un navigateur ; la recette a simulé l'alerte native, à refaire sur appareil ;
  - `driver_network_ping` et `driver_network_state` répondent 500 `NETWORK_DISABLED` à chaque ouverture de l'app tant
    que le réseau partagé est fermé (géré par l'app ; une Flotte Privée pourrait s'en passer) ;
  - pile locale : lien d'invitation de GoTrue sans le préfixe `/auth/v1` (`start.sh` ne règle pas
    `GOTRUE_MAILER_URLPATHS_*`) ; `expo start --web` réécrit `apps/driver/tsconfig.json` (rétabli) ; webhooks non
    livrés faute de DNS dans le bac à sable (file et nouvelles tentatives du worker vérifiées).
- **Reste** :
  1. Recette sur appareil (iOS et Android) : notifications réelles et sonnerie, plein écran d'une immédiate, frise du
     jour sous Android, feuille d'annulation avec le clavier, glissière de course.
  2. Propriétaire (FLOTTE-PRIVEE § 16, valeurs « proposées » appliquées) : prix et facturation du pack, contrat
     (conditions particulières et contrat de prestations à faire rédiger et **signer avant toute activation** ;
     acceptation en ligne plus tard, § 12.2), hébergement du site, nom commercial, délais par défaut, plage de silence
     des rappels, entrée « Agenda » du menu des flottes et centrales standard, etc. Portail Stripe : le régler sans
     changement d'offre le retire à toutes les organisations (DEPLOYMENT § 4, étape 6), ou facturer la Flotte Privée hors
     Stripe. `/eligibilite` promet un « suivi des réservations venues de tes pubs » (l. 48) que Rydar ne fournit pas : à
     retirer ou à prévoir.
  3. Points ouverts des lots, hors de leurs chemins :
     - `/api/billing/portal` : aucune configuration de portail propre aux Flottes Privées (voir ci-dessus) ;
     - app : une réservation « à vérifier » n'est signalée que par sa notification ; chauffeur hors ligne avec les
       notifications refusées, l'accueil et l'agenda ne se relisent qu'au retour dans l'app (option : `driver.updated`
       à la mise en file de `ride_unconfirmed`) ;
     - app : `app/account.tsx` (compte en attente, suspendu, refusé) sans texte Flotte Privée (« votre centrale » y
       désigne sa propre entreprise) : à confirmer par le propriétaire ;
     - recréer la fiche suppose une vraie suppression de compte (e-mail de la fiche vidé), sinon l'index
       `drivers_org_email_uidx` refuse avec un message générique ;
     - app : `new Intl.DateTimeFormat` au rendu dans `messages.tsx` et `earnings.tsx` (antérieur au chantier).

## Flotte Privée : page du test d'éligibilité (09/10/2026)

`eligibilite.<domaine>` (proxy.ts → `app/eligibilite`, autres chemins → plateforme ; TLS : `/api/tls/allowed`) : test en
2 étapes (CA VTC, budget pub, zone → coordonnées + accord), verdict et score (`packages/shared/src/eligibility.ts`),
simulateur (budget 150–2 000 €, course 40–80 €, taux 10–35 %, coût par clic 2,50 €, applis 18,50 € − 25 %). Enregistré
comme demande de contact (sujet `eligibility`, migration 007500, /admin/contacts, mêmes e-mails et durées). Données
d'EXEMPLE affichées comme telles, aucun script tiers, applis jamais nommées. DNS : `eligibilite` A → VPS si pas de `*`.

Branche `claude/confident-clarke-rpfwmo`. Le lot « audit de sécurité maximal » est TERMINÉ : rapport complet dans
[`docs/AUDIT.md`](AUDIT.md).

| Contrôle | Résultat |
|---|---|
| Constats d'audit | 170 bruts, 0 réfuté → 129 défauts distincts (7 hauts, 31 moyens, 91 bas), tous corrigés sauf 4 décisions listées dans AUDIT.md |
| Contre-audit | 32 points résiduels → 3 déjà corrigés, 29 corrigés (tour 2) |
| typecheck (web, app, worker, shared) | OK |
| Tests unitaires | 391 |
| Tests DB | 409 |
| Builds de production web et worker | OK |
| Export Android | OK |
| Bout en bout (Chromium, pile locale complète) | 9 parcours OK : course de bout en bout, mini-site, API, équipe et invitations, règlements, super admin, pages publiques, isolation entre centrales (354 contrôles) ; 9 défauts d'ergonomie trouvés, tous corrigés ; test de fumée final OK |

## Relecture juridique (04/10/2026) — branche `legal-review`, NON poussée
Relecture par 4 relecteurs (contrat, utilisateurs, données, public) puis rédaction. Service en bêta : textes corrigés
SUR PLACE, sans nouvelle `LEGAL_VERSION` / `ORG_LEGAL_VERSION` (ni `ORG_LEGAL_CHANGES`, ni page d'archive, ni e-mail
d'annonce). Migration `20260924007400_legal_review` : interdiction plateforme réservée à la fraude / au faux document
et motivée par e-mail (`platform_ban`), `ban_scope` dans `driver_account_state`, CGV et DPA refusés sans identité de
l'éditeur (`LEGAL_EDITOR_MISSING`), vitesse hors historique GPS, e-mail de validation du réseau sans garantie, refus
WhatsApp du propriétaire (`svc_platform_whatsapp_refusal`), coordonnées des clients effacées après 3 ans (ménage
`customer_contacts`), accusé de réception du mini-site (`svc_booking_receipt`). Web : carte du super admin sans nom,
CGV exigées avant le tableau de bord (jamais acceptées), mini-site (identité de l'exploitant, e-mail obligatoire avec
prix, information RGPD, rétractation), vitrine (mini-site coupé signalé, vols, hébergement), suspension motivée,
textes légaux (CGV 9 bis, 10 bis, 18 ; CGU 7 et 11 renumérotées). App (JS seul → EAS Update) : information GPS,
sécurité au volant, case d'inscription, suppression, interdiction plateforme. Docs : `RGPD-REGISTRE.md`, `AIPD.md`.
Reste au propriétaire : remplir `/admin/legal` AVANT toute centrale (sinon CGV/DPA impossibles à accepter) ; relecture
avocat (CGV, CGU, DPA, confidentialité, AIPD, ANDROID_ID, article 22) ; vérifier sur le VPS la région UE et l'oubli à
14 jours des sauvegardes restic ; outil de purge d'une centrale archivée avant la première fin de contrat ; durées à
décider (justificatifs refusés, candidats refusés, signataire, fiche archivée) ; facture par cycle émise à temps ;
nommer le prestataire de la boîte de contact ; à l'ouverture : nouvelle version des textes à chaque changement.
Contrôles : typecheck OK, 1 249 tests unitaires, 809 tests DB, build web OK (/, /services, /faq régénérées toutes les
5 min), export Android OK, migrations + seed sur base neuve OK (29 chauffeurs, 3 organisations).
Contrôle final (relecture adverse) : seed corrigé (son bannissement « commissions impayées » signalé à Rydar était
refusé par `PLATFORM_REPORT_CATEGORY` : plus aucun signalement « open », contrôle de la CI en échec → motif de fraude) ;
e-mail d'interdiction envoyé à l'adresse du COMPTE d'abord (celle qu'annoncent les CGU, art. 11, et l'app), réexamen
« par une personne de l'éditeur » (jamais « une autre personne »), accord du participe ; accusé de réception d'une
demande sans prix = « demande de réservation » ; RLS sur `private.platform_whatsapp_refusals` ; textes : CGV (frais
« ne l'encaisse pas » au lieu de « n'en reçoit aucune part », garantie sans la part due à un manquement de l'éditeur,
obligation d'accepter une course = contrat de la centrale, webhooks « notamment »), confidentialité (accusé de réception
aussi pour une demande sans prix), DPA art. 4 (journal des alertes du super admin nominatif), registre (supervision =
sous-traitance), STORES (phrases à changer avant d'ouvrir le réseau), SECURITY (ne jamais retarder l'archivage).
Toujours à la charge du propriétaire : remplir `/admin/legal` AVANT de déployer 007400 (sinon toute organisation sans
CGV acceptées, « Démo App Review » comprise, reste bloquée sur l'écran d'acceptation) ; « L'accord de traitement des
données ne change pas » (`ORG_LEGAL_CHANGES`, affiché sur /cgv) est inexact depuis les corrections des 3 et 4 octobre.

## Migrations de ce lot
`20260924004300` (droits) à `20260924005600` (offres chauffeur) : 004300 droits, 004400 argent, 004500 dispatch,
004600 bannissement, 004700 comptes, 004800 RGPD, 004900 public, 005000 domaine, 005100 robustesse, 005200 rappels
visite médicale, 005300 jetons d'activation, 005400 contre-audit SQL, 005500 dette avant suppression, 005600 offres.
Depuis : `20260924005700` formulaire de contact (demandes, file d'e-mails), `20260924005800` état du mailer (pause de
la file si le serveur mail est injoignable, relance à son retour), `20260924005900` clôture des planifiées jamais
démarrées, `20260924006000` webhooks sortants, `20260924006100` leur durcissement après revue adverse,
`20260924006200` interrupteur plateforme des mini-sites (coupés), `20260924006300` lien d'inscription des chauffeurs
pour les flottes, `20260924006400` frais Rydar des flottes, `20260924006500` index de performance + `chat_counts`,
`20260924006600` frais Rydar : hausses annoncées 30 jours à l'avance, annonce des CGV, libellés neutres.

## Production au 03/10/2026 (compte rendu du Claude du VPS)
- Déployé : commit `44acb2d` (migrations jusqu'à `20260924007300`, réseau partagé livré COUPÉ), santé OK, worker
  `"accountDeletions":"on"`, mailer `"smtpReady":true` ; app : EAS Update production (runtime 1.1.0, iOS + Android) ;
  stores : iOS 1.1.0 (8) sur TestFlight, Android 1.1.0 (5).
- Serveur (hors dépôt) : `Caddyfile.local` reconstruit depuis `deploy/Caddyfile` (plafonds `request_body`, en-têtes
  d'IP réelle) + bloc `api.DOMAINE` ; Supabase Auth `GOTRUE_RATE_LIMIT_HEADER=X-Forwarded-For` et `DISABLE_SIGNUP=true`
  (DEPLOYMENT § 3) ; Postfix sur 127.0.0.1:25 et 172.18.0.1:25 ; DKIM 1024 bits (TXT de plus de 255 caractères tronqués
  par le DNS) ; e-mails Auth en français par Postfix ; sauvegarde nocturne chiffrée (restic → Object Storage OVH),
  configuration comprise, restauration d'essai OK ; seuls 22 / 80 / 443 ouverts, Studio fermé, aucun AAAA.
- Contrôlé : 797 tests DB, 1 234 unitaires, 19 pages publiques, 10 pages centrale et 17 pages super admin sans erreur.
- Corrigé ensuite (dépôt) : cartes sans WebGL 2 → message « Carte indisponible » au lieu d'une erreur
  (`MapUnavailable`, `useMapLibre().failed`) ; globe de l'accueil : IMAGE du globe servie avec la page pour tous
  (`public/marketing/globe-{640,960,1200}.{avif,webp}`, rendu de la scène, 39 à 89 Ko en AVIF), globe animé three.js
  seulement sur ordinateur bien équipé (souris, 8 cœurs, 8 Go), après le chargement, en fondu par-dessus l'image
  (Lighthouse mobile : blocage 3 150 → 160 ms, score 52 → 81) ; sur ordinateur : 30 images/s sur écran tactile, pause
  pendant le défilement, figé si trop lent. Image à régénérer si la scène change (capture Playwright, fond
  transparent, puis AVIF/WebP) ; `install.sh`
  redémarre Caddy si le Caddyfile monté a changé ; contrôle du plafond de 1 Mo corrigé (DEPLOYMENT § 3).
- Scores Lighthouse (04/10, serveur local, 8 pages publiques) : accessibilité, bonnes pratiques et SEO à 100 partout ;
  performance mobile 87 à 99 (/contact et /tarifs pénalisés ici par une base injoignable), ordinateur 94 à 100.
  Fait pour : zod chargé seulement sur /contact (`@rydar/shared/contact-links` sans zod pour l'en-tête ; locale
  française seule ; `src/zod.ts` configure zod, seul module à effets de bord du paquet, `jitless` : plus d'« eval »
  bloqué par la CSP) ; polices réduites au latin (Mono non préchargée) ; /tarifs sans squelette (CLS 0,12 → 0) ;
  bandeau cookies rendu avec la page, masqué avant la première peinture s'il a été fermé (script de <head>) ;
  apparition au défilement sans fondu (contraste) ; champ piège du formulaire nommé.
- RESTE : parcours chauffeur complet en production (lien d'inscription → validation → en ligne → course →
  encaissement), à refaire dans une nouvelle session sur le VPS ; relecture juridique avant d'activer le réseau partagé.

## Depuis l'audit
- **Lenteur (« le site est lent ») — volet serveur** : plus de rafale de préchargements à chaque page (26 → 1 requête
  Next au chargement de `/dashboard`), proxy : ES256 vérifié sur place (production, inchangé), jeton HS256 vérifié par
  Auth seulement si le JWKS publie une clé asymétrique, lectures de session en parallèle de `getUser()` (qui reste le
  contrôle à chaque rendu ; gain en production : un aller-retour Auth de moins par rendu, deux sur `/admin`), cascades
  supprimées (fiche course, liste centrale, fiche admin), compteur Messages léger (`chat_counts`), 3 index (migration
  006500), IPv4 d'abord vers Supabase, worker de carte en cache, keep-alive Next au-dessus de celui de Caddy. Détail :
  HISTORIQUE.md. Côté VPS (à faire par l'utilisateur, contrôles en lecture seule d'abord) : services Supabase
  inutilisés (Studio, meta, imgproxy, functions, analytics), OSRM local. Pas de journal d'accès Caddy : la politique
  de confidentialité annonce qu'aucun journal des pages consultées n'est tenu (en ajouter un = modifier d'abord
  `/confidentialite` § 4 et § 9, sans adresse IP) ; journaux des conteneurs dans journald, 1 an au plus
  (`docs/DEPLOYMENT.md` § 6, « Ce que les pages légales affirment du serveur »).
- **Frais Rydar aussi pour les flottes** (propriétaire : « un abonnement de 49,99 € et 2 € de commission sur chaque
  course ») : le super admin règle % et / ou € par course pour une flotte comme pour une centrale (fiche du rattacheur,
  création). Dus par la flotte dès la fin de chaque course ; sans prix, seuls les frais fixes ; taux figés à la fin de
  la course (un changement ne vaut que pour les courses terminées après lui) ; prix corrigé = correction (baisse à
  valider par le super admin) ; course annulée = rien ; changement de modèle sans double frais ni frais perdus. Flotte :
  entrée « Frais Rydar » (owner / admin) avec solde, échéance, « J'ai payé », paiements et relevé ; bandeau d'échéance ;
  `/admin/frais` liste les flottes. Chauffeurs : rien ne change. Taux restés d'un ancien passage en centrale remis à 0.
  Serveur (migration `20260924006400` + web), pas de mise à jour de l'app. Détails : SECURITY.md (Frais plateforme),
  ARCHITECTURE.md § 13. Après revue : menu lu par un booléen léger (`org_platform_fees_enabled`), frais / modèle
  changés → tableau de bord relu en direct + alerte « Rydar a mis à jour vos frais par course », bandeau et alertes
  « Frais Rydar » pour une flotte, relance du super admin au nom de « la flotte », signal « courses sans prix » juste
  pour une flotte (part en % perdue seulement), tests de tous les chemins (fin côté serveur, prix corrigé par un
  dispatcher, réglage pendant la fin de course, flotte → centrale sans règlement).
  Réglage des frais d'une flotte : voir « Frais Rydar : hausses annoncées » et « CGV » ci-dessous (une hausse, y compris
  0 → 2 €, est programmée au moins 30 jours après son annonce et pas avant le 5 novembre 2026 sans CGV acceptées, ou
  appliquée sur accord écrit).
- **CGV version 2026-10-02 = `ORG_LEGAL_VERSION`** (frais par course pour les flottes comme pour les centrales, en plus de
  l'abonnement ; décisions du propriétaire du 03/10) : texte réécrit pour dire exactement ce que fait le code (relu
  contre le SQL de 003000, 004400, 006400 et 006600). Préambule : ce qui change, entrée en vigueur dès l'acceptation et
  au plus tard le 5 novembre 2026 (`ORG_LEGAL_EFFECTIVE_AT`) pour une centrale déjà cliente, aucune hausse avant sans
  accord écrit, résiliation sans frais ; art. 3 (flotte : « la centrale organise avec le logiciel », conditions
  convenues avec l'éditeur, modèle changé seulement à la demande de la centrale ou avec son accord écrit) ; art. 4
  (abonnement HT + TVA, préavis de 30 jours sur SON prix) ; art. 5 (frais TTC ; flotte = % + fixe sans plafond ; centrale
  = calculés sur le prix et déduits dans la répartition, plafonnés ; taux appliqués : fin de course en flotte, calcul de
  la répartition en centrale y compris après la course ; changement de modèle ; création et baisse immédiates, hausse
  annoncée 30 jours avant ou accord écrit, annulée / réduite / reportée sans nouveau délai ; résiliation sans frais ;
  avoir ou correction d'une erreur de calcul, rien d'autre sans accord écrit ; facture récapitulative par cycle, le
  relevé n'en est pas une ; blocage exactement comme `private.platform_position` ; relances selon le modèle) ; art. 7
  (résiliation sans préavis avant une hausse), art. 10 (coordonnées à jour), art. 16 (version précédente consultable).
  Version précédente figée sur `/cgv/2026-09-27` (noindex, servie aussi sur les mini-sites). Bandeau « mise à jour »
  définitif. `/tarifs` : préavis de l'abonnement ET des frais par course, frais TTC, « selon les conditions convenues
  avec Rydar ». Versions séparées : `LEGAL_VERSION` reste `2026-09-27` (CGU + confidentialité : aucun chauffeur ni
  dispatcher n'a rien à ré-accepter, aucune mise à jour de l'app) ; `/dpa` : version d'ensemble 2026-10-02, contenu
  inchangé depuis le 27 septembre.
  **À faire par le propriétaire** : (1) déployer puis cliquer « Prévenir par e-mail » (`/admin/legal`) AU PLUS TARD le
  5 octobre 2026 (heure de Paris) : passé ce jour, le bouton est bloqué et la base refuse l'envoi (moins de 30 jours
  avant le 5 novembre, CGV art. 16) — repousser alors `ORG_LEGAL_EFFECTIVE_AT` (`packages/shared/src/features.ts`) et
  redéployer avant d'envoyer ; une organisation ni signataire ni prévenue ne peut recevoir aucune hausse annoncée
  (accord écrit seulement) ; (2) facture récapitulative de chaque cycle, dès sa fin (tâche manuelle) : `/admin/frais/<org>`
  › « Frais à facturer » › cycle écoulé → CSV (frais pris en compte pendant le cycle, TTC) → facture avec la TVA
  détaillée, l'échéance indiquée et les mentions de pénalités et d'indemnité de 40 € ; **ne régler aucun seuil de
  blocage** pour une organisation qui ne reçoit pas cette facture à chaque cycle ou n'a pas accepté les CGV en vigueur
  (blocage, relances et pénalités contestables) ; (3) Stripe : activer Stripe Tax, prix des offres « TVA non comprise »
  et égaux aux offres (DEPLOYMENT § 4) — sans Stripe Tax, le paiement en ligne est refusé ; (4) résiliation pour refus
  d'une hausse ou d'une modification défavorable : rembourser au prorata la part d'abonnement payée d'avance (Stripe,
  remboursement partiel) et archiver l'organisation à la date choisie ; (5) engagements tenus à la main : « Frais
  ajoutés » seulement pour une erreur de calcul (sinon accord écrit), cycle / délai / seuil de blocage changés en sa
  défaveur seulement avec son accord écrit, refus d'une baisse seulement motivé (sinon acceptée d'office au bout de
  30 jours) ; le changement de modèle exige désormais la note « demande / accord écrit » (base) ; (6) vérifier qu'aucune
  organisation n'a un délai de paiement au-delà de 45 jours (`select name, platform_payment_days from organizations
  where platform_payment_days > 45;` — la garde ne réécrit pas un délai déjà enregistré) ; (7) modèle WhatsApp neutre à
  faire approuver pour relancer aussi les flottes (WHATSAPP.md ; l'art. 5 ne prévoit WhatsApp qu'en centrale) ;
  (8) prochaine version de la politique de confidentialité : annoncer la conservation 10 ans des e-mails d'annonce
  (frais Rydar, CGV), aujourd'hui couverte par « actions sur les frais plateforme gardées avec ce registre » ;
  (9) relecture par un juriste. Améliorations possibles : figer les taux en centrale comme en flotte (aujourd'hui :
  taux du calcul de la répartition, y compris après la course) ; suivre les factures dans l'outil (date d'émission →
  échéance et blocage jamais avant la facture + délai) au lieu de la consigne (2).
- **Frais Rydar : hausses annoncées (migration `20260924006600` + web)** : réglage par
  `svc_platform_set_fees` (création : tout de suite ; baisse : tout de suite ; HAUSSE : programmée au plus tôt au premier
  minuit après 30 jours, et pas avant `ORG_LEGAL_EFFECTIVE_AT` si l'organisation n'a pas accepté `ORG_LEGAL_VERSION`, ou
  tout de suite sur « accord écrit reçu » + note), un seul changement en attente (`public.platform_fee_changes`),
  annulable (`svc_platform_cancel_fee_change`), appliqué par le ménage (5 min) ; e-mails aux propriétaires par
  `email_outbox` (annonce, confirmation d'accord écrit, annulation ; contenu fixe) ; owner / admin :
  `account.scheduled_change` ; super admin : `admin_platform_fee_schedule`. Annonce des CGV : `svc_org_terms_notify`
  (une fois par organisation et par version). Textes « réglez vos frais Rydar (menu « Frais Rydar » ou « Encaissements ») »,
  relance WhatsApp de Rydar refusée pour une flotte (WHATSAPP.md). Garde SQL : une hausse écrite directement par le
  service role est refusée (`PLATFORM_FEE_NOTICE_REQUIRED`). Web : `createOrganization` (p_mode `initial`) et
  `updateDispatchModel` / `cancelPlatformFeeChange` passent par les RPC (taux inchangés = modèle seul, l'annonce reste) ;
  fiche super admin (acceptation des CGV, hausse programmée + Annuler, « Programmer avec préavis » + date d'effet ou
  « Accord écrit reçu, appliquer maintenant » + note, confirmation, historique) ; encart « Vos frais par course changent
  le JJ/MM/AAAA » (« Frais Rydar » / « Encaissements ») et bandeau ; alertes en direct selon le modèle (`rates`,
  `rates_scheduled`, `rates_cancelled`) ; relectures par `useLiveSync` ; `/admin/legal` « Prévenir par e-mail » ;
  `fleetPlatformFee` arrondi comme la base (`percentOfCents`). E-mails relus avec les CGV : « au moins 30 jours à
  l'avance » seulement quand c'est vrai (hausse moindre gardant la date déjà annoncée : « ne dépasse pas celui annoncé
  précédemment »), même règle dans l'encart ; seuil de blocage toujours affiché dans la carte des frais.
  **Après revue (3 commits « CGV : corrections après revue »)** : annonce des CGV refusée à moins de 30 jours
  (`TERMS_NOTICE_TOO_SHORT`, `private.notice_min_on` = `noticeMinDay`) ; hausse annoncée seulement si l'organisation a
  accepté ou reçu l'annonce des CGV (`TERMS_NOT_NOTIFIED`), jamais avant la date qu'elle a reçue, et avec une adresse
  e-mail (`NO_EMAIL`) ; appliquée seulement si un e-mail d'annonce est PARTI 30 jours avant (sinon annulée, journal
  « warning » ; `notice_change_id` pour une hausse moindre gardant la date) ; e-mail des frais à la création (fixés une
  fois le propriétaire rattaché) et acceptation des CGV exigée avant la première course d'une organisation qui n'en a
  jamais accepté ; changement de modèle noté (demande / accord écrit, `CONSENT_REQUIRED`) ; principaux changements
  complets (`ORG_LEGAL_CHANGES` : CGV, bandeau, e-mail) ; bandeau « en vigueur depuis » après la date ; résiliation pour
  refus avec remboursement au prorata ; ménage : hausses appliquées en dernier, baisses sans décision acceptées au bout
  de 30 jours ; annonces gardées 10 ans ; délai de paiement 45 jours au plus ; export « Frais à facturer » par cycle
  (`admin_platform_invoice_lines`) ; Stripe Tax au Checkout, prix exact dans l'Abonnement ; « à régler » au lieu de
  « à reverser » ; typographie des messages SQL (`private.fr_typo`).
- **Lenteur ressentie, volet navigateur / temps réel / pages lourdes (10/2026, web seul, AUCUNE migration ni mise à jour
  de l'app)** : centre de commande « En direct » : positions GPS regroupées (au plus un rendu par seconde, rien onglet
  caché), carte mise à jour seulement pour ce qui change (tracés et rayon redessinés si une position utile ou la course
  change, une seule boucle d'animation, aucune réécriture sous le demi-pixel), courses ACCEPTÉES pour plus tard (> 2 h)
  ni épinglées ni reliées au chauffeur (fin de la « toile d'araignée » ; visibles une fois sélectionnées), horloge de
  l'écran à 15 s (heure, compte à rebours des vagues et « vu il y a » restent à la seconde dans de petits composants),
  lignes mémorisées, indicateurs relus seulement sur changement de statut / prix / horaire / présence (2 s au plus),
  instantané relu à la reconnexion du canal, au retour sur l'onglet et toutes les 2 min (au lieu de 45 s ; repli sans
  temps réel 6 → 18 → 30 s, en pause onglet caché), tracés des courses hors instantané (chargés à la sélection,
  `GET /api/dashboard/rides/[id]?route=1`, sauf client à bord). Formateurs Intl mémorisés (`@rydar/shared`). Fiche
  course, fiche chauffeur, Réseau, Encaissements : `useLiveSync` (aucun rafraîchissement onglet caché, un seul au
  retour ; repli seulement « hors ligne », délai croissant) ; liens de la barre latérale sans préchargement.
  Encaissements : une seule ligne par règlement (même balisage carte / tableau), 100 lignes + « Afficher plus », liste
  « à traiter » complète envoyée en version compacte (compteurs, WhatsApp), relecture à l'échéance d'une commission au
  lieu de toutes les 2 min. Chauffeurs : tableau client alimenté par des lignes compactes. Console super admin : horloge
  15 s, âges à la seconde. Mesures A/B : voir HISTORIQUE (« Volet navigateur »).
  Après revue : fiche d'une course non close relue au plus toutes les 30 s sans temps réel (60 s sinon) ;
  Encaissements relus toutes les 5 min même en temps réel (diffusion perdue) ; ligne cochée sortie des 100 premières
  après une relecture gardée cochée (bloc « Sélection conservée ») tant qu'elle reste ouverte et inchangée ; course en
  alerte ouverte épinglée même au-delà de 2 h ; liens des fiches course et Encaissements sans préchargement (il
  repartait à chaque relecture). **À vérifier en production avant fusion** : le témoin « temps réel » du centre de
  commande doit être vert (sinon les écrans vivent sur le repli, plus espacé qu'avant). **À la fusion des volets** : si
  un `app/dashboard/loading.tsx` arrive, rendre leur préchargement aux liens de la barre latérale.
- **Mini-sites coupés pour toute la plateforme (demande du propriétaire, migration 006200)** : jusqu'à réactivation par
  le super admin (Offres & limites, carte « Mini-sites de réservation », confirmation, journal d'audit). Coupé : menu
  « Mini-site » masqué, éditeur remplacé par « Les mini-sites de réservation sont momentanément désactivés par Rydar. »,
  `/book/{slug}`, sous-domaines, domaines personnalisés, devis et réservations refusés (web ET base :
  `BOOKING_SITES_DISABLED`), aucun nouveau certificat. Réglages de chaque centrale conservés (rien n'est réécrit). API v1,
  dashboard, app chauffeur, RYDAR Privé inchangés. Serveur (migration + web), pas de mise à jour de l'app.
  Hôte de mini-site non servi = 404 neutre (`proxy.ts`), « momentanément indisponible » sur /tarifs et l'Abonnement.
  Demandé explicitement par le propriétaire (« désactive les mini-sites de toutes les flottes et centrales »).
- **Lien d'inscription des chauffeurs pour les flottes** (retour du propriétaire : « je ne trouve plus l'onglet avec les
  liens d'invitation à partager ») : l'onglet « Réseau » n'existait qu'en mode centrale. Désormais une flotte a l'entrée
  « Inscriptions » (même page, juste sous « Chauffeurs », pastille des candidatures) et la page Chauffeurs un bouton
  « Lien d'inscription » : créer / couper / régénérer le lien, validation automatique, copier, WhatsApp, Telegram,
  candidatures (valider, refuser, reconsidérer), bannis. Page /rejoindre et app (JS seul → mise à jour EAS) sans mention
  de commission ni « centrale » pour une flotte ; candidat validé par un administrateur = chauffeur « confirmé » comme ceux
  créés par la flotte ; entré par la validation automatique = reste « nouveau » (sans effet en flotte, plafonné si le
  compte passe en centrale : à confirmer dans « Réseau »). Mêmes contrôles
  qu'en centrale (bannis, débiteurs, limite de chauffeurs, rôles, jeton après activation). Changement de modèle par le
  super admin : le lien n'est plus coupé (code, réglages et candidatures conservés). Migration `20260924006300`.
- **Webhooks sortants (en cours : fusion, revue adverse, bout en bout avec RYDAR Privé)** : à chaque changement de
  statut d'une course, POST JSON signé (HMAC-SHA256) vers les adresses https de la centrale (offre avec l'API) ; gestion
  par Dashboard → Intégrations et `/api/v1/webhooks` ; envoi par le worker (garde SSRF, 9 essais sur ~46 h, un envoi en
  cours par adresse, tour de rôle entre centrales). Durcissement 006100 et suite de la revue : tests et renvois bornés
  (`WEBHOOK_TEST_PENDING` 409, `WEBHOOK_TEST_RATE_LIMITED` 429, 10/min/centrale, aussi en Redis côté web), ping jamais
  réessayé, désactivation automatique seulement après ≥ 50 échecs ET 3 jours sans succès (depuis la création si jamais
  réussi), centrale suspendue = envois en pause ; dashboard : envois par adresse (10 derniers échecs, même anciens, avec
  « Renvoyer »), essais comptés réussite comprise, temps relatifs sans écart d'hydratation ; description sans
  caractère de contrôle (NUL → 422, plus 500) ; exemples de vérification de signature (docs/API.md, onglet « Webhook »)
  qui contrôlent le format avant `timingSafeEqual`. Détails : ARCHITECTURE.md (« Webhooks sortants »), API.md.
- Web : lien « Mot de passe oublié » (et invitation) du tableau de bord : après validation, `/auth/callback`
  renvoyait vers l'adresse interne du serveur Next derrière Caddy (`https://0.0.0.0:3000/auth/set-password`).
  Redirection désormais par chemin relatif (`redirect()` : les cookies de session partent avec). Contournement avant la
  mise à jour : remplacer `0.0.0.0:3000` par `rydardrive.com` dans l'adresse (même navigateur, session déjà ouverte).
- Courses planifiées acceptées mais jamais démarrées (retour d'essai : « Hier 06:30 » toujours dans « Mes courses »,
  encore démarrable) : migration `20260924005900` : annulées par le système, motif « Non effectuée », 6 h après l'heure
  de prise en charge (`private.expire_unstarted_rides`, appelée par le ménage toutes les 5 min ; chauffeur prévenu
  « COURSE NON EFFECTUÉE », rien pour un rattrapage de plus de 24 h ; une course démarrée n'est jamais clôturée
  ainsi). Avant ce délai, l'app affiche « Heure de prise en charge dépassée » et l'heure de clôture (Planning, accueil,
  écran de course). Tests : `tests/db/expire-rides.test.ts`, `planning.test.ts`. Serveur (migration) + mise à jour EAS.
- App chauffeur, carte (retour d'essai sur iPhone : « ne se recentre pas quand j'avance, impossible d'orienter la
  vue »). Avant, tout glissement coupait le suivi jusqu'au bouton « Recentrer » et la rotation était bloquée hors
  guidage. Désormais (`components/map/follow.ts`, `rydar-map.tsx`) : un geste suspend le suivi le temps du geste ;
  chauffeur resté près du centre (zoom, rotation, petit glissement) → le suivi continue avec le zoom et l'orientation
  choisis ; carte déplacée ailleurs → « Recentrer », et retour automatique après 10 s sans toucher la carte quand il
  roule (accueil et guidage). Rotation à deux doigts partout, bouton boussole (nord en haut) quand la carte est
  tournée, hors guidage (masquée faute de place ; écran d'offre : carte fixe). Gestes suivis doigt par doigt (un
  pouce posé ailleurs ne compte pas), double appui compris ; relecture indépendante intégrée. Tests : `follow.test.ts`.
  JS seul → mise à jour EAS ; à confirmer sur iPhone et Android.
- App chauffeur : panneau de l'accueil réductible (`CollapsibleSheet`, `components/ui.tsx`) : glisser vers le bas ou
  toucher la poignée → résumé d'une ligne (état + action principale) et carte dégagée ; rouvert par glissé vers le haut,
  appui, ou automatiquement à l'arrivée d'une course. JS seul → mise à jour EAS (docs/STORES.md § 10). Vérifié au
  toucher (rendu web) : hors ligne, en ligne, course en cours ; à confirmer sur un vrai téléphone (Android surtout).
- App chauffeur : point de position figé sur la carte (ex. dans la rue où la voiture est garée, une fois rentré). Le
  flux de la carte (`use-my-position`) gardait la pause automatique iOS (réglage par défaut, non modifiable dans
  expo-location pour ce flux) et n'était jamais relancé. Relancé désormais au retour dans l'app, après 30 s sans point
  ou une erreur ; sans filtre de distance, la précision dégradée à l'intérieur agrandit le cercle ; vieux points en
  cache ignorés. Test : `use-my-position.test.ts`. Le suivi envoyé à la centrale (tâche, jamais en pause) n'était pas
  touché. JS seul → mise à jour EAS.
- Site vitrine en plusieurs pages (`/`, `/services`, `/avantages`, `/tarifs`, `/faq`, `/contact`) ; page Services
  refaite (bloc de code de l'API retiré, aperçu du mini-site) ; « Demander une démo » supprimé, « Demander un tarif » →
  formulaire de contact. Demandes enregistrées (mig `20260924005700`) et traitées dans `/admin/contacts` (statut, note,
  réponse par e-mail, suppression, nouvel essai, e-mail de test, pastille « Demandes de contact »). E-mails mis en
  file (`email_outbox`) et envoyés par le nouveau service `mailer` au serveur mail du VPS (SMTP 127.0.0.1:25).
  Vérifié : 475 tests unitaires, 435 tests DB, build de production, bout en bout (formulaire → base → mailer → faux
  serveur SMTP → panneau admin : envoi, réponse, échec 550, nouvel essai, suppression, limites, piège à robots).

- E-mails jamais reçus en production (« En attente », aucun envoi réussi) : le mailer tournait mais aucun serveur mail
  n'écoutait sur 127.0.0.1:25 (Postfix pas installé). Désormais (mig `20260924005800`) : file en pause tant que le
  serveur mail ne répond pas (aucun essai compté, plus d'échec au bout de 20 h), e-mails relancés dans la minute à son
  retour et au démarrage du mailer ; `/admin/contacts` affiche le service d'envoi (actif, arrêté, jamais démarré), le
  serveur mail (joignable ou motif, conseil Postfix), les derniers e-mails de tout type (dont tests) et « Relancer
  maintenant ». Vérifié : 489 tests unitaires, 439 tests DB, build, bout en bout (mailer sans SMTP → pause visible,
  SMTP démarré → file vidée en 53 s, relance, service arrêté, mobile).
- VPS (compte rendu du 28/09, Supabase auto-hébergé `api.rydardrive.com`, IP 146.59.153.211) : Postfix en écoute
  locale seulement, port 25 sortant ouvert chez OVH, OpenDKIM (sélecteur `rydar`, 2048 bits), seuls 22/80/443 ouverts,
  secrets de Supabase remplacés, sauvegarde nuit (base + fichiers, 14 jours, sur le VPS seulement). Reste : DNS chez OVH
  (SPF `v=spf1 ip4:146.59.153.211 include:mx.ovh.com ~all`, TXT `rydar._domainkey`, `_dmarc` p=none, reverse
  `rydardrive.com`), e-mail qui reçoit les demandes (`contact@rydardrive.com` proposé), modèles Supabase Auth en
  français avec code à 8 chiffres (défaut : anglais, lien sans code → « Mot de passe oublié » de l'app inutilisable),
  copie des sauvegardes hors du VPS, `/admin/legal`, centrale « Démo App Review ».
- VPS au 29/09 (après redémarrage) : sur le commit GitHub `f1aadd2` (commits locaux abandonnés, sauvegarde
  `backup/avant-reprise-20260929-1629`), mises à jour Ubuntu installées, worker `"dbSsl":"disable"`, 0 migration,
  mailer `smtpReady`. Supabase auto-hébergé (`/opt/supabase`) ; worker → `supavisor:5432` par
  `deploy/docker-compose.override.yml` (non versionné, réseau `supabase_default`, `WORKER_DATABASE_URL`, monte aussi
  `Caddyfile.local` pour `api.rydardrive.com`) ; migrations et mailer → `127.0.0.1:5432` (Supavisor publié en local).
  Postfix sert aussi Supabase Auth (modèles français, code à 8 chiffres, DKIM) ; demandes → contact@rydardrive.com ;
  DNS du domaine chez my-ndns (SPF, DKIM `rydar._domainkey`, DMARC), DNS inverse chez OVH. Reste : essais (Gmail
  SPF/DKIM/DMARC PASS, formulaire, mot de passe oublié), clés OVH Object Storage de la copie chiffrée hors VPS,
  `/admin/legal`, « Démo App Review », puis stores (ascAppId 6816428044 dans `eas.json`).

## À faire par l'utilisateur
- Mettre à jour le VPS : `cd /opt/rydar && bash deploy/update-production.sh` (migrations 003600 à 005700, nouveau
  service `mailer`). Si la connexion à la base refuse le certificat (`verify-full`), relancer
  `sudo bash deploy/configure.sh` et accepter le repli proposé.
- E-mails du formulaire de contact : `ss -ltnp | grep ':25 '` doit montrer le serveur mail (Postfix) du VPS, sinon étape
  5 de `deploy/CLAUDE-VPS.md` ; `sudo bash deploy/configure.sh` pour l'e-mail qui reçoit les demandes ; DNS : SPF (et
  DKIM, DMARC, DNS inverse) pour éviter les indésirables ; puis `/admin/contacts` → « Envoyer le test ».
- Publier la mise à jour de l'app (carte : suivi pendant les gestes, rotation, boussole) : depuis `apps/driver`,
  `eas update --channel production --environment production --message "Carte : suivi, rotation, boussole"`.
- Après la mise à jour : les contrôles de `docs/DEPLOYMENT.md` (section « Après la mise à jour de l'audit ») et de
  `docs/AUDIT.md` (« À vérifier en production ») ; Supabase › Authentication : code e-mail à 8 chiffres.
- Remplir `/admin/legal`, puis faire relire les textes par un juriste.
- Publier sur les stores : `docs/STORES.md`.

## Pistes plus tard
- Code e-mail à l'inscription par lien (supprime la révélation « adresse déjà liée à un compte »).
- Purge par le worker des fichiers de justificatifs remplacés ou refusés.
- Carte VTC obligatoire à l'inscription (anti-fraude).
- Frais plateforme : minimum, relances par e-mail. Webhook WhatsApp (statut de remise).
- Empreintes d'identité en HMAC (secret serveur). `invoices` encore en cascade à la suppression d'une organisation.

## Réseau partagé (branche `shared-network`, en cours, interrupteur plateforme coupé)
- Lots faits : 0 (contrats `packages/shared/src/network.ts`), 2 (schéma, gardes, droits : migration `20260924006700`,
  non poussée), 3 (dispatch, migration `20260924006800`, non poussée : 3a éligibilité, étape réseau des immédiates et
  des planifiées, acceptation ; 3b retraits, chien de garde, clôture, contrôles de fin), 4 (argent, migration
  `20260924006900`, non poussée : 4a côté chauffeur ; 4b côté A, blocages, relances, frais Rydar, dette et
  suppression), 5a (accès : RPC du chauffeur, de A et de B, migration `20260924007000`, non poussée), 5b (journaux,
  alertes, positions, temps réel, notifications, webhooks : même migration `20260924007000`), 6 (administration et cycle
  de vie, migration `20260924007100`, non poussée), 7 (tests transverses, relecture adverse, performance : migration
  `20260924007200`, non poussée). **Numéros pris** : 006700 schéma, 006800 dispatch, 006900 argent, 007000 accès, 007100
  administration, 007200 corrections du lot 7, 007300 purges de conservation (conformité, hors réseau) ; prochaine
  migration : **007400** (numéro unique : `migrations.test.ts`, `deploy/migrate.sh`).
- **État au 03/10 (finitions + contrôle complet)** : branche principale fusionnée (audit `20260924006650`, poussée,
  intacte) ; les migrations réseau partent de ses versions (« Dernière définition : 20260924006650_audit_fixes.sql »)
  et gardent ses corrections (test `shared-network-audit-merge`). Web : alertes « Chauffeur partenaire indisponible »
  (« Clôturer la course », owner / admin), course rendue au partenaire puis relancée, course clôturée ; « Annuler »
  masqué pour une course partenaire client à bord (comme la base). App : course partenaire annulée par A → planning ;
  Gains : « Moins commission et frais de la centrale ». Contrôle complet vert (typecheck, unitaires, base complète,
  base neuve + seed comme la CI, build de production, export de l'app). Déploiement : plafond de 1 Mo sur `/api/v1/*`
  (Caddy) ; Supabase Auth (limites par IP, inscriptions coupées) et IPv6 : procédure dans DEPLOYMENT.md § 3,
  « Exposition du serveur », à appliquer sur le VPS.
- **Reste** : (1) lot 10 : relecture juriste (convention, onglet centrale, e-mails `network_review`, articulation de la
  baisse « contestée » avec l'art. 5 des CGV) ; (2) lot 11 : bout en bout, audit final, fusion dans la branche
  principale, push, commandes VPS (migrations 006700 à 007300) et EAS Update (app) ; (3) à valider par le propriétaire :
  bon de réservation sur toutes les courses une fois le réseau ouvert, libellés de l'app (« Course partenaire · {A} »,
  « J'accepte et j'active », onglet « Partenaires ») ; (4) VPS, lecture seule d'abord : justificatifs « medical »
  restants (lot 7), procédure Supabase Auth / `Caddyfile.local` / AAAA (DEPLOYMENT § 3) ; (5) facultatif : bouton
  « Signaler » masqué pendant une course partenaire (refus SQL déjà affiché).
- Écrans faits (lots 8 et 9, fusionnés après la CGV finale) : web = onglet `/dashboard/reseau-partage`, fiche course,
  liste, En direct, alertes, `/suspended/reseau-partage`, `/admin/reseau` + carte de la fiche organisation, pages
  publiques `/reseau-partage/conditions` et `/chauffeur` (servies sur les mini-sites) ; app = offres et courses
  partenaires, conditions, « Courses partenaires », RIB, bon de réservation. Conventions et ajouts au contrat =
  commentaires « Ajout web » / « Ajouts de l'app » de `network.ts`, tenus par le SQL des lots 4 à 7.
- **Fait (lot 3)** — avant d'écrire 006800 : fusionner la branche principale une fois le chantier CGV (`20260924006600`) fusionné, puis
  partir de ses définitions (« Dernière définition : 20260924006600… », contrôlé par `migrations.test.ts`) :
  `public.assign_ride`, `public.redispatch_ride`, `private.apply_flight_status` (lot 3), `private.platform_account`
  (lot 4), `private.housekeeping` (lots 5 et 6 ; il applique les hausses de frais programmées), et
  `private.platform_fees_enabled`, `private.rides_platform_block` si un lot les touche. 006600 ne touche ni à
  `legal_acceptances` ni aux fonctions redéfinies par 006700. À la fusion, ajouter les tests de non-régression :
  `private.housekeeping()` renvoie toujours `platform_fee_changes_applied`, `private.platform_account` toujours
  `scheduled_change`.
- Règles posées par le lot 3a (dispatch) :
  - une offre réseau ne rend jamais le partenaire « sollicité » (`presence` inchangée, `release_offered_drivers` ignore
    les offres réseau) : son organisation peut toujours le solliciter ; un partenaire n'a qu'une offre GPS en attente ;
  - NO_DRIVER_FOUND en phase réseau remet `network_at` à NULL (partage clos « no_driver ») ; la fenêtre réseau d'une
    planifiée se ferme à T-lead (« window_elapsed ») ; une étape réseau en erreur est isolée (3 erreurs : fin) ;
  - `private.network_blocker` (règles locales §10.7) et son message existent déjà (lot argent : à compléter, pas à
    recréer) ; journaux de A écrits pendant une action d'un partenaire : `private.log_partner_event` (sans identifiant).
- Règles posées par le lot 3b (retraits, chien de garde, fin de course) :
  - retirer une course à un partenaire = `private.unassign_network_ride(chauffeur, course, motif)` (removed_by_giver par
    A via `reassign_ride`, executor_released par B via `ban_driver` / `set_driver_status` / retrait du réseau,
    executor_unavailable par le chien de garde) : jamais un UPDATE direct de `rides.driver_id` ; course remise en
    recherche chez A (vagues propres d'abord), notifications du partenaire pour la course supprimées sauf « COURSE
    RETIRÉE — {A} » ; 3 retraits en 30 jours → `driver_network_settings.excluded_until` (+ audit
    `network.driver_auto_excluded`) ;
  - `private.network_watch` tourne à la fin de `private.watch_rides` (worker inchangé) : partenaire ou B indisponible
    (fiche inactive, B suspendue / archivée / suspendue du réseau, retiré par B) → course rendue, ou alerte
    `network.executor_unavailable` si le client est à bord ; offres réseau en attente devenues inacceptables fermées ;
    A suspendue → partenaires prévenus (`network_giver_suspended`) ;
  - `private.assert_network_creditor(org)` (owner / admin, A suspendue ou archivée comprise) existe : le lot argent la
    réutilise ; `public.close_network_ride` (owner / admin de A) ;
  - contrôles de fin (`private.network_completion_checks`, dans `driver_update_ride_status`, AVANT l'écriture du statut)
    posent `suspect_reasons` et `hold_until` (+72 h si prépayée) : le règlement du lot argent les lit à la fin ;
  - `private.delete_driver_account` (redéfinie en 006800 : course partenaire = RIDES_ASSIGNED, jamais libérée par ce
    chemin) : le lot administration part de cette version ;
  - fin d'une course partagée d'une A **centrale** : 23503 tant que le lot argent n'a pas routé `sync_ride_settlement`
    (A flotte : sans objet).
- Règles posées par le lot 4a (argent, côté chauffeur) :
  - fin d'une course partagée : `private.sync_ride_settlement` envoie d'abord vers `private.sync_network_settlement`
    (termes figés de l'exécution « completed », jamais les colonnes vivantes) : ligne `driver_id` NULL, `network_*`,
    « Prénom I. · {B} », « R{n°} », échéance délai de A ≥ 48 h (reversement) ou 7 jours et après la retenue
    (versement) ; empreinte du RIB posée sur l'exécution ; jamais `maybe_promote_driver` ;
  - diffusion : org:{A} = `settlement_json` (bloc « network » des lignes réseau) ; driver:{network_driver_id} =
    `{action, network: true, item}` (`private.network_settlement_item`, un montant par sens) ; jamais org:{B} ;
  - RPC chauffeur indépendantes de l'interrupteur : `driver_network_settlements`, `driver_declare_network_payment`
    (moyens de p_org seulement, lignes d'une autre organisation → FORBIDDEN_TENANT), `driver_dispute_network_settlement`
    (une fois par ligne, `NETWORK_DISPUTE_REASON_INVALID`), `driver_payout_info` / `driver_set_payout_details` /
    `driver_delete_payout_details` (IBAN masqué, `PAYOUT_DETAILS_IN_USE`) ;
  - `private.network_driver_readiness(chauffeur)` (lisibilité complète, contrat NetworkDriverReadiness) : les RPC de
    lisibilité des lots 5 et 6 l'enveloppent ; `driver_home().network` et `driver_earnings` (net par course aux termes
    figés, communes seulement pour une course partenaire) : clés ajoutées seulement quand il y a du réseau.
- Règles posées par le lot 4b (argent, côté A) :
  - toute action d'argent de A sur une ligne réseau passe par `private.assert_network_creditor` (owner / admin, A
    suspendue ou archivée comprise ; jamais un dispatcher, lot mêlé compris) : « Reçu » / « Versé »
    (`confirm_settlements`), « Pas reçu », « Annuler » (refusé sur un versement : `NETWORK_SETTLEMENT_ACTION_FORBIDDEN`,
    il faut contester la course), « Rouvrir » (reversement : nouvelle échéance au délai de A, relances remises à zéro),
    `org_network_payout_info` (RIB d'un versement dû et non retenu, consultation journalisée SANS IBAN et notifiée au
    chauffeur, avertissements `iban_changed` / `recent_change` 72 h), `validate_network_ride`, `contest_network_ride` ;
    seule « Relancer » (`remind_network_driver`) est ouverte à tout membre de p_org ACTIVE (app seulement, une par
    30 min, envers p_org seulement) ;
  - chauffeur partenaire prévenu par `private.network_notify` (ligne chez A, `data.network = true`, jamais commission
    ni frais de A) ; jamais `maybe_promote_driver` pour une ligne réseau, et les courses partenaires ne comptent pas
    dans la promotion chez B ;
  - « Valider » : `ride_network_executions.validated_at / validated_by` (diffusées) ; « Contester la course » (7 jours
    après la fin, motif 5 à 300 caractères, idempotente) : versement ouvert annulé, baisse des frais Rydar `pending`
    (super admin), puis `NETWORK_RIDE_CONTESTED` (plus de « Valider » ni de « Rouvrir » du versement) ;
  - frais Rydar d'une course partagée (`private.sync_platform_fee`) : chez A, au taux des termes figés, libellé
    « Course N · réseau partagé », jamais recalculés ensuite (rien si une écriture existe), dus même si le règlement est
    contesté ; jamais `private.fleet_fee_basis` pour elle ;
  - relances automatiques réseau (`private.settlement_reminders`) : application seulement, 23 h d'écart, 3 au plus,
    A active et chauffeur actif ; clé `network` du résultat seulement s'il y en a ;
  - Encaissements (`org_settlement_overview`, `org_settlements`, mois), `organizations_dispatch_model_guard` et
    `svc_platform_set_fees` (redéfinie en 006900 : le prochain lot qui la touche part de cette version) ignorent les
    lignes réseau (retour en flotte permis avec des lignes réseau ouvertes) ; `admin_centrale_overview` (super admin)
    les compte encore dans l'encours de A : à trancher au lot administration ;
  - blocage : `private.network_identity_block` couvre aussi le débiteur réseau de A revenu sous une autre fiche (mêmes
    empreintes, règle `block_unpaid` de A, chez A seulement) ;
  - suppression : `private.driver_deletion_debt` ajoute `network` (dette par créancière), `private.delete_driver_account`
    garde les empreintes dans `private.network_debtor_identities` par créancière, `private.housekeeping` les purge une
    fois tout réglé : les lots 5 et 6 partent des versions 006900 de ces deux fonctions ;
  - à brancher : lot 5 = `private.network_month(exécution)` pour p_month (fin de course, fuseau de A : même mois chez A
    et B) et `validated_at` dans NetworkExecutionSummary ; lot 6 = `debtor_match` étendu à
    `network_debtor_identities` (sans n° de fiche de B), `scrub_network_traces` ; web et app : rien de plus (journal
    `ride.network_validated` / `ride.network_contested` affiché par son message, `NETWORK_RIDE_CONTESTED` libellé dans
    ERROR_MESSAGES, notifications `settlement_*` avec `data.network` déjà ouvertes sur « Courses partenaires »).
- Règles posées par le lot 5a (accès, `20260924007000`, non poussée) :
  - lectures réseau par RPC seulement (contrats `NetworkRpcs`) : chauffeur `driver_offers_v2` (offres propres =
    `driver_offers()` à l'identique + `network: null`), `driver_ride` (liste blanche ; course partenaire : client dans
    sa fenêtre, lectures comptées, adresse exacte jusqu'à la fin + 1 h), `driver_rides_upcoming` (jamais le client d'une
    course partenaire), `driver_network_state` / `_ping` / `driver_set_network` ; A `org_network_summary`,
    `org_network_given`, `org_network_ride`, `network_partner_names`, exclusions de chauffeurs ; B
    `org_network_received`, `org_network_activity`, `org_network_drivers`, `set_driver_network_allowed` ;
  - réseau fermé : NETWORK_DISABLED sauf `NETWORK_CLOSED_RPCS` et les lectures générales de l'app ; A suspendue :
    owner / admin seulement pour summary / given / partner_names (`private.assert_network_reader`) ;
  - `private.org_network_readiness` (lisibilité de l'organisation, ordre de `ORG_NETWORK_READINESS_CODES`) et
    `private.network_driver_readiness` (lot 4a) : le lot administration les enveloppe en RPC publiques, sans les recréer ;
    `private.driver_label_for` (« Prénom I. · B ») pour les messages de la suite du lot ;
  - statistiques : `driver_stats` / `org_stats` (redéfinies, dernière version : 007000) = chiffres de l'organisation
    seulement, offres réseau hors des taux, clé `network_rides` seulement s'il y en a ;
  - web : « à vérifier » seulement pour une course partagée terminée (`givenToCheck`, fiche course).
- Règles posées par le lot 5b (journaux, alertes, positions, temps réel, `20260924007000`, non poussée) :
  - lignes lisibles par A (journal, historique des statuts, alertes, temps réel org:{A}) : un chauffeur de B n'y figure
    qu'en libellé court (« Prénom I. · B ») — `private.log_event` (devenue plpgsql) passe par
    `private.network_event_scrub` (clés driver_id / previous_driver_id / assigned_driver_id / driver_ids d'un chauffeur
    d'une autre organisation retirées, compteur network_count, driver_number / driver_name / lat / lng retirés, message
    nettoyé) et `private.event_actor` (acteur d'une autre organisation sans identifiant, seulement sur une course passée
    par le réseau : offre réseau, exécution ou chauffeur d'une autre organisation), comme
    `private.track_ride_status` ; tout nouveau message qui cite un chauffeur passe quand même par
    `private.driver_label_for` (le filet ne reconnaît que « Prénom NOM (#n) », « Prénom (#n) » et le nom de famille) ;
  - alertes (`private.apply_ride_alert`, `private.watch_rides`) : chauffeur partenaire → libellé court, ni driver_id ni
    driver_number ni lat / lng dans les données, distance arrondie à 100 m, `network: true` ; diffusion `ride.alert`
    (`private.ride_alert_payload`) sans driver_id (la colonne ride_alerts.driver_id reste : identifiant résiduel) ;
  - annulation d'une course tenue par un partenaire : « COURSE ANNULÉE — {A} » sans n° ni adresse, ses notifications
    précédentes de la course supprimées (comme un retrait) ;
  - positions (Q5) : `update_driver_location` marque `ride_org_id` (organisation de la course en cours si ce n'est pas
    celle du chauffeur ; NULL sinon) ; aucune `driver.location` pendant une course d'une autre organisation ;
    `driver.updated` sur org:{B} : current_ride_id NULL + network + network_giver ; `private.housekeeping` (dernière
    version : 007000) supprime 1 h après la fin de l'exécution (`private.network_ended_traces`) les points marqués et
    les notifications `ride_reminder` / `flight_update` du partenaire, comptés dans history_purged /
    notifications_purged ;
  - temps réel org:{A} : `ride.updated` d'une course tenue par un partenaire = driver_id NULL + network +
    network_execution_id ; jamais de message vers org:{B} / fleet:{B} avec une donnée de A ;
  - notifications : déclencheur `notifications_scrub_money` (BEFORE INSERT, après G1) — commission_cents,
    platform_fee_cents, driver_payout_cents retirés chez un partenaire, et chez un chauffeur de flotte s'ils sont
    renseignés (NULL en flotte aujourd'hui : rien ne change) ; point unique pour toute insertion ;
  - API v1 et webhooks : objet « driver » = colonne calculée `public.ride_public_driver` (EXECUTE service role ;
    `PUBLIC_RIDE_SELECT` se termine par `driver:ride_public_driver`, vérifié avec PostgREST 12.2) — chauffeur de
    l'organisation : objet inchangé (véhicule de sa fiche) ; partenaire : prénom, véhicule de l'instantané, `operator`
    { name : raison sociale validée de B }, NULL 24 h après la fin ; une course partagée n'existe que dans l'API et les
    webhooks de A ;
  - lots suivants : partir des versions 007000 de log_event, track_ride_status, apply_ride_alert, ride_alert_payload,
    watch_rides, cancel_ride_internal, update_driver_location, broadcast_driver_location, broadcast_driver,
    broadcast_ride, housekeeping, webhook_ride_json.
- Règles posées par le lot 6 (administration et cycle de vie, `20260924007100`, non poussée) :
  - super admin : `svc_set_shared_network_enabled`, `svc_network_approve`, `svc_network_suspend` (service role seul,
    `p_actor` revérifié, audit en SQL) et `admin_network_overview` (super admin) ; coupure globale = offres réseau
    fermées ; validation = instantané NORMALISÉ (espaces ; SIRET chiffres seuls) et contrôlé (`IDENTITY_INCOMPLETE`
    + `missing`, jamais 23514), e-mail aux propriétaires (type `network_review` d'`email_outbox`, `EMAIL_KINDS`) ;
    refus = validation et instantané retirés, offres fermées, motif montré ; suspension = offres fermées dans les deux
    sens, courses non commencées de ses chauffeurs rendues (`unassign_network_ride`, « executor_unavailable ») ;
  - organisation : `set_network_settings` (owner / admin, jeton émis après l'activation ; convention de la version EN
    VIGUEUR seulement + preuve `legal_acceptances` « network » ; activer un sens exige une convention valable ; les
    autres conditions ne bloquent pas : sens « en attente » avec ses raisons ; un sens activé ou la convention acceptée
    vaut demande — après un refus aussi, motif effacé ; coupure d'un sens ou assurance retirée = offres fermées),
    `set_network_exclusion` (organisation déjà rencontrée seulement, `{ ok: true }` dans tous les cas, symétrique,
    levée par celle qui l'a posée), `org_network_readiness` / `network_driver_readiness` (enveloppes des aides
    privées) ; réseau fermé : NETWORK_DISABLED ;
  - suppression d'un compte : `private.scrub_network_traces` (appelée par `delete_driver_account`, dernière version :
    007100) efface ses traces chez A avant l'anonymisation ; `private.debtor_match` (dernière version : 007100) renvoie
    aussi les débiteurs réseau de p_org (lignes SANS fiche ni n°) ; `svc_driver_apply` (dernière version : 007100) les
    journalise sans fiche, n° ni nom de B ; `private.housekeeping` inchangé (dernière version : 007000) ;
  - décidé : `admin_centrale_overview` (super admin) garde les reversements réseau dans l'encours de A (sommes réellement
    dues à A) ; `drivers.current_ride_id` lisible par B pendant une course partenaire (UUID opaque) reste au lot 7.
- Règles posées par la revue du lot 4 (corrections dans 006900, non poussée) :
  - la baisse des frais Rydar demandée par « Contester la course » n'est JAMAIS acceptée d'office : redéfinition de
    `private.accept_stale_platform_reductions` (corps 006600 à l'identique + exclusion des courses partagées contestées) ;
    elle attend la décision du super admin (`svc_platform_review_entry`), frais dus jusque-là ; motif = « Course
    contestée : {motif} — {état du règlement} » ; `private.platform_entry_json` (redéfinie, dernière version : 006900)
    ajoute `network_contest {contested_at}` à cette seule écriture, montrée à part dans /admin/frais. **Lot 10
    (juriste)** : la convention (section 6) le dit déjà (« jamais acquise faute de réponse ») ; faire confirmer
    l'articulation avec l'article 5 des CGV (acceptation au bout de 30 jours réservée aux corrections du prix) ;
  - verrous d'une course partagée terminée : TOUJOURS l'exécution, puis le règlement (`validate_network_ride`,
    `contest_network_ride`, `driver_dispute_network_settlement`) ; toute nouvelle fonction qui touche les deux suit cet
    ordre (sinon interblocage 40P01) ;
  - `org_network_payout_info` : audit à chaque consultation, notification au chauffeur une fois par règlement et par 24 h
    (et de nouveau après un changement de son RIB) ; le règlement est verrouillé pendant la consultation ;
  - `driver_earnings` : `commission_cents` d'une période = commission et frais de SON organisation sur ses seules
    courses ; courses partenaires à part (`partner_rides`, `partner_part_cents`, clés présentes seulement s'il y en a),
    affichées dans l'app sous « Part des organisations partenaires », jamais comme une commission.
- Règles posées par la revue du lot 3 :
  - client à bord d'un partenaire (PASSENGER_ONBOARD, IN_PROGRESS) : `cancel_ride` refusé à tous sauf système / super
    admin (`NETWORK_RIDE_IN_PROGRESS` ; `private.cancel_ride_internal` redéfinie en 006800, le lot suivant qui la touche
    part de cette version) ; seule voie : `close_network_ride` puis la contestation (lot argent) ; jusqu'à
    DRIVER_ARRIVED, annulation inchangée ;
  - `close_network_ride` : client à bord seulement (jamais à DRIVER_ARRIVED : « Retirer », ou annuler si client absent) ;
  - `network_at` ne reste jamais posé sur une course tenue par un chauffeur de A (`accept_ride_offer` le remet à NULL
    avec le chauffeur ; `reassign_ride` aussi) ; `network_fleet_step` ne propose aux partenaires que si le partage est
    `open` et la fenêtre atteinte, sinon partage clos « window_elapsed », rouvert à la fenêtre ;
  - `private.network_release_driver` ne touche jamais `current_ride_id` (hors ligne seulement sans course en cours) :
    le masquage Q5 repose dessus ;
  - adresses approximatives (`private.address_area` / `address_city`, une seule expression dans
    `private.address_postcode_city`, à réutiliser telles quelles par `driver_offers_v2`) : commune seulement juste après
    un code postal isolé, en forme de nom de commune (article, « Saint », mots à particules) ET suivie d'une virgule ou
    de la fin ; sinon code postal seul ; jamais le texte libre qui suit ;
  - toute lecture de `ride_settlements` par `network_driver_id` porte `network_driver_org_id is not null` (index
    partiel `ride_settlements_network_driver_idx`).
- Règles posées par la revue du lot 2, pour les lots suivants :
  - course tenue par un partenaire : `network_at` ne change qu'avec le chauffeur (retrait, réattribution) ; prix,
    paiement, adresses, heure, catégorie, passagers, **bagages, n° de vol** verrouillés (G6) ; `apply_flight_status`
    pose `rydar.network_flight_update = on` et ne change alors QUE `pickup_at` ;
  - fin d'exécution : toujours `completed` pour une course terminée (prédicat unique des règlements et frais) ;
    `close_network_ride` ajoute `closed_by_giver` à `suspect_reasons` ;
  - `private.close_network_offers(…, p_ride)` : `terms_changed` / `flight_rescheduled` exigent la course, `driver_busy`
    la course et le chauffeur ;
  - B ne peut plus retirer directement le statut actif d'un chauffeur qui tient une course de A
    (`DRIVER_HAS_NETWORK_OBLIGATIONS`) : `set_driver_status` / `ban_driver` (lot 3) doivent d'abord
    `unassign_network_ride`, ou refuser si le client est à bord ;
  - empreinte du RIB : `ride_network_executions.payout_iban_hash / payout_iban_at` (posée une fois par
    `sync_network_settlement`, lot 4), jamais dans `ride_settlements` (lu par tout membre de A) ;
  - effacement des traces (lot 6) : `rydar.network_scrub = on` pour réécrire `driver_label` et `checks` d'une exécution ;
  - identifiant résiduel accepté chez A : UUID de la fiche exécutante aussi dans `ride_alerts.driver_id` (test n° 31 du
    lot 7) ;
  - `svc_network_approve` (lot 6) : SIRET normalisé (chiffres seuls), chaque champ contrôlé, `IDENTITY_INCOMPLETE` pour
    un champ vide OU invalide (jamais 23514) ;
  - déploiement de 006700 : une transaction, verrous pris d'emblée, `lock_timeout` 5 s (échec propre, à relancer) ;
    au-delà de quelques dizaines de milliers d'offres ou de notifications en production, arrêter le worker pendant
    la migration.
- Règles posées par le lot 7 (`20260924007200`, `20260924007300`, non poussées) :
  - test transverse `tests/db/shared-network-cycle.test.ts` : cycle complet sans 23503, balayage GÉNÉRIQUE des fuites
    (toute table lisible par A, B ou le chauffeur partenaire, lue sous son rôle : un nouvel identifiant ou une nouvelle
    colonne lisible le fera échouer), temps réel par topic ; seuls identifiants de B lisibles par A :
    `rides.driver_id` / `vehicle_id`, `ride_settlements.network_driver_id`, `ride_alerts.driver_id` ; résidu accepté
    chez B : `drivers.current_ride_id` pendant la course (identifiant opaque, sert à son écran En direct) ;
  - pendant une course partenaire, pas de signalement routier sur le fil flotte de B ni de coordonnées dans un message
    (déclencheur `chat_messages_network_guard`, `NETWORK_RIDE_REPORT_BLOCKED`) ;
  - étape réseau : `private.network_candidates(r, rayon, planifiée, limite)` évalue les contrôles du plus proche au plus
    loin et s'arrête à la limite (la version à 3 arguments = liste complète) ; contrôle « banni » par index ; compteur
    `partners_nearby` plafonné à `NETWORK_PARTNERS_NEARBY_MAX` (50) ; interrupteur coupé : comportement identique,
    surcoût mesuré ≈ 0,8 ms par course et par vague (filet du journal, candidats propres extraits) ;
  - conformité (007300, sans décision) : ménage horaire = sessions Auth inactives depuis 400 jours supprimées
    (`auth_sessions_purged`), dernière IP d'une clé d'API effacée après 90 jours (`api_key_ips_purged`) ; plus aucun
    justificatif « medical » (déclencheur `TYPE_NOT_ALLOWED`) ni rappel ; justificatifs médicaux déjà enregistrés en
    production : à contrôler (`select count(*) from public.driver_documents where type = 'medical'`) puis purger
    fichiers compris (Storage, puis lignes).
