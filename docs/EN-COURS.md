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
la file si le serveur mail est injoignable, relance à son retour).

## Depuis l'audit
- App chauffeur, carte (retour d'essai sur iPhone : « ne se recentre pas quand j'avance, impossible d'orienter la
  vue »). Avant, tout glissement coupait le suivi jusqu'au bouton « Recentrer » et la rotation était bloquée hors
  guidage. Désormais (`components/map/follow.ts`, `rydar-map.tsx`) : un geste suspend le suivi le temps du geste ;
  chauffeur resté près du centre (zoom, rotation, petit glissement) → le suivi continue avec le zoom et l'orientation
  choisis ; carte déplacée ailleurs → « Recentrer », et retour automatique après 10 s sans toucher la carte quand il
  roule (accueil et guidage). Rotation à deux doigts partout, bouton boussole (nord en haut) quand la carte est
  tournée, hors guidage. Tests : `follow.test.ts`. JS seul → mise à jour EAS ; à confirmer sur iPhone et Android.
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
