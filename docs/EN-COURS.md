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
pour les flottes, `20260924006500` index de performance + `chat_counts`.

## Depuis l'audit
- **Lenteur (« le site est lent ») — volet serveur** : plus de rafale de préchargements à chaque page (26 → 1 requête
  Next au chargement de `/dashboard`), plus d'appel à Auth dans le proxy pour un jeton HS256 (production : ES256 vérifié
  sur place, inchangé), lectures de session en parallèle de `getUser()` (qui reste le contrôle à chaque rendu), cascades
  supprimées (fiche course, liste centrale, fiche admin), compteur Messages léger (`chat_counts`), 3 index (migration
  006500), IPv4 d'abord vers Supabase, worker de carte en cache, keep-alive Next au-dessus de celui de Caddy. Détail :
  HISTORIQUE.md. Côté VPS (à faire par l'utilisateur, contrôles en lecture seule d'abord) : services Supabase
  inutilisés (Studio, meta, imgproxy, functions, analytics), OSRM local, journal d'accès Caddy avec durées.
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
