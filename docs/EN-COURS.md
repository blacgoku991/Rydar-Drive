# Travail en cours (28/09/2026)

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

## Depuis l'audit
- **Lenteur (« le site est lent ») — volet serveur** : plus de rafale de préchargements à chaque page (26 → 1 requête
  Next au chargement de `/dashboard`), proxy : ES256 vérifié sur place (production, inchangé), jeton HS256 vérifié par
  Auth seulement si le JWKS publie une clé asymétrique, lectures de session en parallèle de `getUser()` (qui reste le
  contrôle à chaque rendu ; gain en production : un aller-retour Auth de moins par rendu, deux sur `/admin`), cascades
  supprimées (fiche course, liste centrale, fiche admin), compteur Messages léger (`chat_counts`), 3 index (migration
  006500), IPv4 d'abord vers Supabase, worker de carte en cache, keep-alive Next au-dessus de celui de Caddy. Détail :
  HISTORIQUE.md. Côté VPS (à faire par l'utilisateur, contrôles en lecture seule d'abord) : services Supabase
  inutilisés (Studio, meta, imgproxy, functions, analytics), OSRM local, journal d'accès Caddy avec durées.
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
  5 octobre 2026 (30 jours avant le 5 novembre, CGV art. 16) ; sinon repousser `ORG_LEGAL_EFFECTIVE_AT`
  (`packages/shared/src/features.ts`) avant de publier ; (2) facture récapitulative des frais de chaque cycle (tâche
  manuelle : montants TTC, TVA détaillée, échéance et mentions de pénalités) ; (3) Stripe : prix des offres réglés pour
  facturer HT + TVA (Stripe Tax ou prix TTC) ; (4) engagements tenus à la main (le code ne les contrôle pas) : modèle
  changé seulement à la demande de l'organisation, « Frais ajoutés » seulement pour une erreur de calcul (sinon accord
  écrit), cycle / délai / seuil de blocage changés en sa défaveur seulement avec son accord écrit ; (5) modèle WhatsApp
  neutre à faire approuver pour relancer aussi les flottes (WHATSAPP.md ; l'art. 5 ne prévoit WhatsApp qu'en centrale) ;
  (6) relecture par un juriste. Amélioration possible : figer les taux en centrale comme en flotte (aujourd'hui : taux
  du calcul de la répartition, y compris après la course).
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
  des planifiées, acceptation ; 3b retraits, chien de garde, clôture, contrôles de fin). **Numéros réservés** : 006700 schéma, 006800 dispatch, 006900 argent, 007000 accès, 007100
  administration ; prochaine migration hors réseau : **007200** (numéro unique : `migrations.test.ts`, `deploy/migrate.sh`).
- **Avant d'écrire 006800** : fusionner la branche principale une fois le chantier CGV (`20260924006600`) fusionné, puis
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
