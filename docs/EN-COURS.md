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
  de vie, migration `20260924007100`, non poussée). **Numéros réservés** : 006700 schéma, 006800 dispatch, 006900 argent, 007000 accès, 007100
  administration ; prochaine migration hors réseau : **007200** (numéro unique : `migrations.test.ts`, `deploy/migrate.sh`).
- Écrans faits (lots 8 et 9, fusionnés après la CGV finale) : web = onglet `/dashboard/reseau-partage`, fiche course,
  liste, En direct, alertes, `/suspended/reseau-partage`, `/admin/reseau` + carte de la fiche organisation, pages
  publiques `/reseau-partage/conditions` et `/chauffeur` (servies sur les mini-sites) ; app = offres et courses
  partenaires, conditions, « Courses partenaires », RIB, bon de réservation. Ils appellent des RPC des lots 4 à 6 pas
  encore écrites (web : erreur non bloquante ; app : repli PGRST202) : conventions et ajouts au contrat = commentaires
  « Ajout web » / « Ajouts de l'app » de `network.ts`, à respecter par le SQL. Reste au web (suite du lot 3b) : alerte
  et libellé de `network.executor_unavailable` (« Clôturer la course »), `ride.network_unassigned`,
  `ride.network_closed` ; « Annuler » encore proposé sur une course partenaire client à bord (refusé par la base). À
  valider par le propriétaire : bon de réservation sur toutes les courses une fois le réseau ouvert, libellés de l'app
  (« Course partenaire · {A} », « J'accepte et j'active », onglet « Partenaires »), textes centrale de l'onglet (juriste).
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
