# Sécurité et isolation multi-tenant

> Règle d'or : **aucune donnée n'est visible entre deux rattacheurs.** La règle est appliquée **dans la base de données** et **côté serveur**. L'interface ne fait que la refléter.

## Défense en profondeur

| Couche | Mécanisme |
| --- | --- |
| **RLS PostgreSQL** | Activée sur **toutes** les tables, refus par défaut. Chaque policy passe par des fonctions `private.*` (`SECURITY DEFINER`, `search_path=''`) : `member_org_ids()`, `has_org_role()`, `current_driver_id()`, `is_super_admin()`. Une organisation suspendue ou un chauffeur suspendu perd l'accès **immédiatement**. |
| **Droits par colonne** | Les clients ne peuvent modifier que des colonnes listées. `status`, `organization_id`, `driver_id` d'une course ne sont modifiables que par les fonctions du moteur (transitions contrôlées). |
| **Intégrité inter-tenant** | Clés étrangères composites `(organization_id, id)` : une course de A ne peut pas référencer un chauffeur ou un véhicule de B. Le trigger `forbid_org_change` rend `organization_id` **immuable**, même pour un superutilisateur. |
| **Fonctions RPC** | Chaque RPC vérifie explicitement le tenant et le rôle (`assert_org_member`) avant d'agir. `EXECUTE` est révoqué par défaut puis accordé fonction par fonction. |
| **Serveur Next.js** | Validation zod de chaque entrée, contrôle du rôle dans chaque server action. La clé *service role* n'est utilisée que côté serveur (`server-only`), après authentification. |
| **Temps réel** | Canaux privés. Une policy RLS sur `realtime.messages` limite `org:{id}` aux membres de l'organisation et `driver:{id}` au chauffeur concerné. `fleet:{id}` (fil flotte, signalements) est ouvert aux chauffeurs de l'organisation, sans donnée client. |
| **Messagerie** | Lecture par RLS uniquement : un chauffeur ne voit que son fil direct et le fil flotte de **son** organisation. Aucune écriture directe : tout passe par des RPC qui vérifient le tenant et limitent le débit (`PT429`). Le nom de l'auteur est dénormalisé, un chauffeur n'accède donc jamais à la fiche des autres. Les signalements exigent une position ; les votes sont uniques par votant. |
| **Modération du fil « Chauffeurs »** | Signalements de messages (`chat_message_reports`) lisibles par les membres de la centrale, le super admin et leur auteur ; masquages (`chat_blocks`) par le seul chauffeur qui masque (la centrale ne voit pas qui masque qui). Écritures par RPC seulement : `report_chat_message`, `block_chat_author` (chauffeur), `remove_chat_message` et `dismiss_chat_report` (owner, admin, dispatcher ; accès contrôlé avant tout verrou, audit). Un message retiré (`deleted_at`) est exclu par la RLS pour tout le monde. Temps réel `chat.moderation` (`org:`) et `chat.removed` (`fleet:`) : identifiants seulement, jamais le texte. |
| **Moyens de paiement des centrales** | Lien, bénéficiaire, IBAN et BIC de la centrale (`organization_settings`) : modifiables par owner / admin seulement (RLS + droits par colonne, formats vérifiés en base), lisibles par les membres ; un chauffeur ne les reçoit que par `driver_settlements`, pour les moyens cochés **et** renseignés (`private.settlement_methods_available`). Coordonnées de paiement de Rydar (`platform_billing`) : écriture par le super admin seulement. |
| **Documents chauffeur** | Dépôt dans le stockage limité au dossier `<org>/<chauffeur>/` du chauffeur connecté (policy Storage). Validation par la centrale seulement (`review_driver_document`, auteur et date conservés). |
| **Mode centrale : argent** | Modèle d'exploitation et frais plateforme modifiables par le seul super admin (aucun droit client). Répartition calculée en base, règlements écrits uniquement par RPC : le chauffeur ne peut que déclarer **ses** paiements, seule la centrale confirme, conteste ou annule (owner / admin). Prix et commission verrouillés dès qu'un règlement est déclaré ou encaissé. |
| **Bannissement** | Identités stockées **hachées** (sha256 de la valeur normalisée, préfixe fixe et non secret : un hachage de téléphone reste attaquable par force brute par qui lit la base, d'où l'accès limité aux admins de la centrale et au super admin) avec un simple indice masqué ; triggers en base sur `drivers`, `vehicles`, `driver_documents` et `driver_devices` (`IDENTITY_BANNED`, `DRIVER_BANNED`). Un bannissement vaut pour la centrale ; le bannissement de toute la plateforme n'est décidé que par le super admin, sur signalement, et peut être levé. Une fiche d'une **autre** centrale qui partage une identité du signalement n'est bannie que si le super admin la coche, après un aperçu qui date la saisie de chaque identité par la centrale qui signale (migration 004600), pour qu'une centrale ne puisse pas faire bannir le chauffeur d'une autre en recopiant ses coordonnées sur l'une de ses fiches. Compte Auth banni en plus (`ban_duration`) et sessions révoquées ; au niveau plateforme, jamais le compte d'un membre de centrale ou d'un super admin (fiche bannie, connexion conservée). La levée plateforme rend à chaque centrale le bannissement qu'elle avait elle-même posé. Les autres centrales ne voient jamais les bannissements d'une centrale. Empreintes et signalements effacés 3 ans après le bannissement (`private.purge_expired_bans`) ; indices en clair effacés dès la suppression du compte. |

## Scénario obligatoire : A tente de récupérer une course de B

**« Le rattacheur A modifie `organization_id` pour récupérer une course du rattacheur B. »** Le résultat est toujours un refus :

| Tentative | Résultat |
| --- | --- |
| `UPDATE rides SET organization_id = A WHERE id = <course de B>` avec le JWT de A | 0 ligne : la RLS rend la course de B invisible pour A |
| Modifier `organization_id` d'une de ses propres courses | **42501 → 403** (droits par colonne + trigger d'immutabilité) |
| `INSERT` d'une course avec `organization_id = B` | **42501 → 403** (`FORBIDDEN_TENANT`) |
| `cancel_ride` / `assign_ride` sur une course de B | **42501 → 403** |
| API : `organization_id` dans le corps de `POST /rides` | **403 `FORBIDDEN_TENANT_FIELD`**, audité |
| API : `GET` ou `cancel` d'une course de B avec la clé de A | **403 `FORBIDDEN_TENANT`**, audité avec la gravité *critique* (`security.cross_tenant_access`) |
| Chauffeur de A qui accepte une offre de B | refusé |
| S'abonner au canal temps réel `org:B` | refusé |

Chacune de ces lignes est un test automatisé (`tests/db/rls.test.ts`, lancé par la CI). Côté web, `lib/errors.ts` traduit uniformément l'erreur `42501` en **403 « Accès refusé »**.

## Authentification et sessions

- **Supabase Auth (JWT)**. Pas d'inscription libre : les rattacheurs et leurs accès sont créés par le Super Admin, les chauffeurs par leur rattacheur (invitation ou mot de passe). Seule exception, pour une centrale comme pour une flotte (migration 006300) : le lien d'inscription `/rejoindre/{code}` (code aléatoire de 64 bits, désactivable et régénérable, créé par un owner / admin). La route serveur limite le débit, contrôle l'identité contre les bannissements avant de créer le compte, et la candidature reste « en attente » sans aucun accès aux courses jusqu'à la validation par la centrale (ou validation automatique choisie par elle).
- **Anti brute force** : sur 15 min, 30 tentatives par IP (IPv6 regroupée par /64), 6 par couple (adresse, IP) et un plafond global par adresse (60 pour la connexion web, `lib/login-limits.ts` ; 50 pour la connexion chauffeur, `/api/auth/driver-login`, compteur partagé avec la suppression de compte). Un tiers qui connaît une adresse ne bloque donc pas son titulaire depuis une autre IP. Compteurs partagés dans Redis. Ces compteurs ne couvrent que les routes Rydar : l'API Auth de Supabase reste appelable directement avec la clé publique (limites par IP seulement) ; d'où le code e-mail à 8 chiffres (valable 1 h, 3600 s : délai partagé avec les liens d'invitation des membres ; 100 millions de possibilités, hors de portée du devinage même depuis de nombreuses IP) ([DEPLOYMENT.md](DEPLOYMENT.md) § 1).
- **Mot de passe oublié (app chauffeur)** : `/api/auth/driver-password-reset` répond toujours de la même façon, que le compte existe ou non (l'e-mail part après la réponse, rien ne se lit dans le temps de réponse) : par heure, 10 demandes par IP, 3 par couple (adresse, IP) et 20 par adresse. Le code reçu est vérifié par `/api/auth/driver-password-reset/confirm` (sur 15 min : 20 par IP, 8 par couple (adresse, IP), 60 par adresse). Le lien de secours ouvre `/auth/set-password?app=driver`, dans un client sans cookie : la session d'un compte déjà connecté au dashboard dans ce navigateur n'est jamais utilisée.
- **Limitation de débit** : IP d'abord, compte ensuite (une requête refusée pour son IP ne consomme pas le quota du compte visé) ; clés de longueur fixe (empreinte SHA-256) ; adresse e-mail limitée à 254 caractères. L'IP est celle de la connexion vue par Caddy (`X-Forwarded-For` réécrit, `X-Real-IP` imposé, `CF-Connecting-IP` retiré) : un client ne peut pas la choisir.
- **Révocation de session** : les refresh tokens sont supprimés en base, automatiquement, dans ces cas :
  - un chauffeur est désactivé, suspendu ou supprimé ;
  - un membre est retiré ou désactivé ;
  - une organisation est suspendue.

  Le changement de mot de passe d'un chauffeur et le bouton **« Déconnecter »** déclenchent aussi la révocation. L'accès aux données, lui, est coupé dès la requête suivante par la RLS (`tests/db/sessions.test.ts`).
- **Contrôle de session du site** : `getUser()` (Auth) à chaque rendu de page, layout et route protégés (`lib/auth.ts`) ;
  les lectures de session partent en même temps mais ne servent que si Auth confirme le même compte que le cookie.
  `proxy.ts` ne fait qu'aiguiller vers `/login` et rafraîchir le jeton : signature vérifiée sur place pour un jeton
  ES256 / RS256 (JWKS) ; tout autre jeton (HS256, alg none…) est vérifié par Auth dès que le JWKS publie une clé
  asymétrique (production : jeton falsifié refusé dès le proxy), et aiguillé sans appel seulement si le JWKS est vide
  (pile en HS256 seul : refusé ensuite au rendu, et par PostgREST) ; `/login` confirme la session par `getUser()` avant
  de renvoyer vers le tableau de bord.
- L'app chauffeur conserve sa session dans le trousseau sécurisé de l'appareil : SecureStore, avec chiffrement AES de la session complète.

## Clés API

- Format `rdk_live_{préfixe}_{secret}`. Seul un **HMAC-SHA-256** poivré (`API_KEY_PEPPER`) est stocké, dans `api_key_secrets`, une table inaccessible à tout rôle client. La comparaison se fait en temps constant.
- Permissions par clé, date d'expiration, révocation immédiate, débit par minute propre à chaque clé (Redis) ; les requêtes non authentifiées (clé absente, inconnue ou invalide) sont limitées par IP (IPv6 regroupée par /64), et leurs échecs journalisés dans une limite fixe. Une clé d'idempotence rejouée par une autre clé renvoie 409 (`IDEMPOTENCY_KEY_CONFLICT`), jamais la course d'une autre intégration. Une clé avec des origines autorisées (clé « navigateur », lisible par tout visiteur) ne sert qu'à créer une course, depuis une origine listée (`ORIGIN_NOT_ALLOWED`), avec le prix et le paiement fixés par la centrale ([API.md](API.md)).
- Chaque requête est journalisée (`api_logs`) : clé, statut, durée, code d'erreur, IP.

## Webhooks sortants

- Adresses (`webhook_endpoints`) et envois (`webhook_deliveries`) : RLS, lecture par owner / admin de la centrale ;
  aucune écriture client : RPC `svc_webhook_*` réservées au service role (appartenance à la centrale revérifiée en base,
  action inscrite dans `audit_logs`), appelées par l'API v1 (permission `webhooks:manage`, refusée aux clés
  « navigateur », sans en-têtes CORS) ou par les actions serveur du dashboard après contrôle du rôle owner / admin.
- Secrets de signature : table `webhook_endpoint_secrets`, aucun droit pour `anon` ni `authenticated` ; affichés une
  seule fois (création, renouvellement), jamais renvoyés ensuite ni journalisés ; lus par le seul worker.
- Chaque envoi est signé : `X-Rydar-Signature: v1=<HMAC-SHA256(secret, "<horodatage>.<corps brut>")>`, horodatage de
  l'essai (le destinataire refuse au-delà de 5 minutes et dédoublonne sur l'identifiant de l'envoi).
- SSRF : adresse `https://` publique seulement (validation zod côté web, revérifiée en base) ; avant chaque envoi, le
  worker résout le nom, refuse si une seule adresse est privée, de boucle locale, de lien local, CGNAT, ULA,
  multidiffusion ou non spécifiée (formes IPv4 dans IPv6 comprises), se connecte à l'adresse vérifiée (pas de DNS
  rebinding), ne suit aucune redirection, coupe à 10 s et ne lit que 2 Ko de réponse. Exception de test seulement :
  `WEBHOOK_ALLOW_PRIVATE_URLS=1`.
- Minimisation : aucune charge utile conservée (l'état de la course est lu au moment de l'envoi), aucune donnée client
  (nom, téléphone, e-mail) envoyée ; historique purgé après 30 jours.

## Secrets et navigateur

- Le navigateur ne reçoit que l'URL Supabase et la clé **publique** (anon). Les clés service role, Stripe, FCM, APNs et le poivre des clés API restent sur le serveur ou dans le worker.
- Jetons WhatsApp (Meta) : tables `org_whatsapp_secrets` et `platform_whatsapp_secrets`, lisibles par le seul service role (RLS activée, aucun droit pour `anon` ni `authenticated`). Ils sont lus côté serveur (vérification du numéro, message test) et par le worker (`private.claim_whatsapp`), jamais renvoyés au navigateur ni journalisés. La configuration visible (numéro, modèle, état) est dans `org_whatsapp` (owner / admin de la centrale) et `platform_whatsapp` (super admin).
- En-têtes HTTP : CSP stricte (`frame-ancestors 'none'` hors mini-site), HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.
- Le mini-site public n'expose aucune donnée. Il crée une course par une action serveur limitée en débit, avec pot de miel et consentement.

## Journal d'audit

`audit_logs` enregistre automatiquement, par trigger, les changements sensibles : organisations, chauffeurs, membres, clés API, réglages. Les gravités *warning* et *critical* sont utilisées pour une suspension, une révocation ou une tentative d'accès inter-tenant. Le Super Admin consulte l'audit de toutes les organisations ; un rattacheur ne voit que le sien. Adresse IP et navigateur : effacés au bout d'un an (`private.housekeeping`), et aussitôt pour un chauffeur qui supprime son compte. Journal de Supabase Auth (`auth.audit_log_entries` : connexions avec nom, e-mail, adresse IP) : même durée, et effacé avec le compte de connexion d'un chauffeur ([DEPLOYMENT.md](DEPLOYMENT.md) § 1, contrôle des droits).

## Suppression du compte chauffeur

- Route `/api/driver/delete-account` : confirmation « SUPPRIMER » ; limitation par IP, puis par adresse (même compteur que la connexion chauffeur), puis par compte ; jeton de l'app, ou e-mail et mot de passe vérifiés par un client isolé (sans cookie, session aussitôt révoquée) ; compte Auth banni : empreinte bcrypt vérifiée en base (`svc_driver_password_check`, service role, fiche non supprimée seulement). Supabase Auth injoignable : 503, jamais « mot de passe incorrect ». Aperçu `{ preview: true }` (avant la confirmation, même depuis l'écran de connexion) : même authentification et mêmes compteurs (hors budget de suppressions du compte), rien n'est supprimé, même avec « SUPPRIMER » ; il renvoie les commissions encore dues (`svc_driver_deletion_debt`, service role). Avec une session, l'app lit `driver_deletion_debt()` : la fiche du compte connecté seulement (`auth.uid()`, sans paramètre), quel que soit son statut ou celui de la centrale.
- SQL (`private.delete_driver_account`) : refus si une course est attribuée (centrale suspendue ou archivée : une course acceptée pas encore commencée est libérée, « à attribuer ») ; commissions encore dues : empreintes hachées du téléphone, des e-mails et de la carte VTC gardées dans `private.debtor_identities` (RLS, aucun droit, service role compris) tant que la dette est ouverte — une candidature par lien qui les porte dans la même centrale n'est jamais validée automatiquement (`svc_driver_apply`) ; effacement et anonymisation dans une seule transaction ; journal d'audit caviardé ; fiche « Chauffeur supprimé (#N) » détachée du compte et **figée** par le garde-fou `DRIVER_DELETED` (42501), quelle que soit la voie (tableau de bord, RPC, service role) : ni réactivation ni suspension, ni coordonnées, ni niveau de confiance, ni nouveau bannissement ou levée par la centrale, ni rattachement à un compte ou à un véhicule, ni nouveau justificatif. Seul le système peut encore l'effacer (purges des bannissements) ; la plateforme bannit ou lève les identités d'un signalement sans toucher la fiche. Un membre de centrale garde son compte de gestion et ses sessions (`rydar.keep_sessions`).
- File `private.account_deletions` : RLS activée et aucun droit, service role compris ; accès par les fonctions `svc_*` et par le worker (propriétaire). Fichiers et compte de connexion supprimés par la route, sinon repris par le worker avec la clé service role (10 essais), puis relance par le super admin (`/admin/suppressions`, `svc_admin_delete_driver`, audités). Une demande reçue par e-mail passe par cet outil, jamais par du SQL.

## Documents légaux

- `platform_legal` (éditeur, hébergeurs) : lecture publique par `public_legal_info()`, écriture par le super admin (`svc_platform_legal_update`, audit).
- `legal_acceptances` : preuve en ajout seul (déclencheur `LEGAL_PROOF_IMMUTABLE` ; le service role ne peut que lire et ajouter). Écriture par `accept_legal_documents` (CGV et accord de traitement : owner / admin de la centrale) ; l'e-mail du signataire est copié par un déclencheur, jamais fourni par l'appelant. Compte supprimé : la preuve reste, détachée du compte ; une centrale qui a accepté ne peut plus être supprimée (`on delete restrict`).
- **Traceurs** : seulement des cookies et stockages strictement nécessaires (art. 82 loi Informatique et Libertés,
  CNIL 2020), donc aucun consentement à demander et un simple bandeau d'information. Aucune mesure d'audience, aucun
  pixel, aucune vidéo, police ou script chargé chez un tiers sur les pages publiques (mesuré le 3 octobre 2026 : zéro
  requête tierce, zéro cookie avant connexion). En ajouter un exige AVANT un gestionnaire de consentement conforme
  (rien déposé avant le choix, « Tout refuser » aussi simple que « Tout accepter », choix gardé 6 mois au plus,
  modifiable par le lien « Cookies ») et la mise à jour de `/cookies`. Tout nouveau cookie ou clé de stockage
  nécessaire est ajouté au tableau de `/cookies` (test `components/legal/legal-pages.test.ts`).
- **Hébergement décrit par les textes** : `/confidentialite` (§ 7 à 9), `/dpa` (art. 5, 6, 7, 11) et
  `/mentions-legales` décrivent la production : serveur de l'éditeur (VPS) avec Supabase auto-hébergé, sauvegardes
  nocturnes gardées 14 jours, e-mails envoyés par le Postfix du serveur, aucun relais tiers. Tout changement (base chez
  Supabase cloud, copie des sauvegardes hors du serveur, relais SMTP, nouveau prestataire) se reporte d'abord dans ces
  pages ; un nouveau sous-traitant est annoncé aux centrales 30 jours avant (accord de traitement, art. 6).

## Limites des offres

Chauffeurs, courses mensuelles, administrateurs, accès API, mini-site et domaine personnalisé sont vérifiés **par des triggers en base** (`PLAN_LIMIT_*`, `PLAN_FEATURE_*`). Contourner l'interface ne permet pas de les dépasser.

## Formulaire de contact et e-mails

- Public et sans compte : champ piège (robot → faux succès, rien d'enregistré), validation partagée, limites par IP
  (seau /64, 5 par heure), par adresse (3 par jour) et globale (200 par heure), plafond SQL (`CONTACT_BUSY`, 300 par
  heure glissante). L'adresse IP n'est gardée qu'en empreinte HMAC (poivre du serveur), effacée au bout d'un an.
- L'accusé de réception part vers une adresse saisie par un inconnu : contenu FIXE (aucune donnée saisie), un par
  adresse et par 24 h (SQL), 30 par heure en tout. Le formulaire ne peut pas servir à écrire à un tiers.
- En-têtes : adresses d'une seule pièce (ni espace, ni séparateur, ni nom affiché : contraintes SQL, mêmes règles côté
  web), sujets nettoyés (`sanitizeHeaderText`) ; enveloppe SMTP explicite à un seul destinataire. Adresse de
  notification mal configurée : ignorée, la demande est quand même enregistrée.
- Lecture de `contact_requests` et `email_outbox` : super admin seul (RLS) ; écritures : service role (web) après
  `requireSuperAdmin()`, journalisées (`audit()`). Le site n'envoie aucun e-mail ; le mailer (réseau de l'hôte) ne publie
  aucun port, son point de santé n'écoute que sur 127.0.0.1, ses journaux ne contiennent ni corps, ni sujet, ni adresse
  complète.

## Frais plateforme (centrales et flottes → Rydar)

- Les frais d'une course terminée sont **dus par la centrale** dès la fin de course (`platform_fee_entries`, trigger
  `rides_e_platform_fee`) : annuler ou contester le règlement du chauffeur n'y change rien.
- **Flottes** (migration 006400) : mêmes règles, frais = % du prix (0 sans prix) + fixe, dus par la flotte ; taux figés à
  la fin de la course (`private.fleet_fee_basis`, aucun droit client ni service role) : un changement de réglage ne
  touche jamais une course déjà terminée. Le modèle à la fin de course décide (règle centrale dès qu'un règlement
  chauffeur existe), toujours par delta : ni double frais ni frais perdus au changement de modèle. Course terminée en
  flotte : ses taux figés restent la règle tant qu'aucun règlement chauffeur n'existe, même après un passage en
  centrale (centrale à 0 % / 0 €, course sans chauffeur). `rides.platform_fee_cents` reste vide en flotte : aucun
  chauffeur de flotte ne voit les frais Rydar.
- Taux (`platform_fee_percent` / `platform_fee_fixed_cents`) **lisibles par tous les membres**, dispatchers compris
  (décision 006400) : ce sont les conditions de l'organisation, pas des montants dus, et les retirer du GRANT par
  colonne casserait tout `select('*')` sur `organizations`. Compte, écritures, paiements, relevé et menu
  (`org_platform_fees_enabled`) restent réservés à l'owner / admin.
- **CGV** (version 2026-10-02 = `ORG_LEGAL_VERSION`, acceptée par l'owner / admin seulement ; version précédente figée
  sur `/cgv/2026-09-27`) : l'article 5 décrit exactement le code des deux modèles (flotte : % + fixe facturés à la
  flotte, fixe dû sans prix, sans plafond ; centrale : calculés sur le prix et déduits dans la répartition, plafonnés ;
  frais TTC ; hausse annoncée au moins 30 jours avant ou accord écrit ; blocage de `private.platform_position`). Le
  modifier avec le code (et les e-mails de 006600). Engagements tenus à la main, sans contrôle du code : modèle changé
  seulement à la demande de l'organisation, « Frais ajoutés » seulement pour une erreur de calcul (sinon accord écrit),
  cycle / délai / seuil de blocage changés en sa défaveur seulement avec son accord écrit, facture récapitulative de
  chaque cycle.
- **Hausse des taux annoncée** (migration 006600) : seulement par `svc_platform_set_fees` (auteur super admin revérifié,
  audit en SQL) ; une hausse s'applique au plus tôt 30 jours après son annonce par e-mail aux propriétaires (et pas avant
  l'entrée en vigueur des CGV qu'une organisation n'a pas acceptées), sauf accord écrit noté (journal « warning »,
  e-mail de confirmation au propriétaire). Garde `organizations_platform_rates_guard` : une hausse écrite directement
  par le service role ou un client est refusée (`PLATFORM_FEE_NOTICE_REQUIRED`). E-mails à contenu fixe (référence
  issue du slug, jamais le nom saisi par l'organisation), adresses validées comme `email_outbox.to_email`. Tables
  `platform_fee_changes` et `org_terms_notices` : lecture super admin (RLS), aucune écriture directe (RPC seulement).
- **Relance WhatsApp de Rydar** refusée pour une flotte (`WHATSAPP_FLEET_UNSUPPORTED`) : le modèle approuvé renvoie à
  l'onglet « Encaissements », absent d'une flotte (WHATSAPP.md).
- **Registre immuable** : aucune écriture ne se modifie ni ne se supprime (trigger `platform_entry_guard`, même en service
  role) ; tout changement de frais est une nouvelle écriture de correction. Registre et paiements ne partent pas non plus
  avec la centrale : clés étrangères en `on delete restrict` (migration 004200), une centrale qui en a s'archive. Une **baisse** (prix corrigé après la course)
  reste « en attente » et ne compte qu'après l'accord du super admin.
- **Seul le super admin** confirme un paiement (montant réellement reçu), le refuse, le rouvre, saisit un paiement, accorde
  un avoir ou change les conditions : fonctions `svc_platform_*` réservées au service role, auteur super admin vérifié en
  base, chaque action inscrite dans `audit_logs`. La centrale ou la flotte (owner / admin) peut seulement déclarer
  « J'ai payé » et retirer sa déclaration tant que Rydar ne l'a pas traitée ; dispatchers et chauffeurs ne voient rien.
- Colonnes `organizations.platform_*` et table `platform_billing` : jamais modifiables par un rattacheur (absentes des
  droits UPDATE, RLS en lecture seule).
- **Temps réel** : l'événement `platform.updated` ne contient que l'action et des identifiants (le canal `org:{id}` est
  lisible par les dispatchers) ; le détail est relu par des fonctions qui contrôlent le rôle.
- Exports CSV (centrale, super admin) : cellules commençant par `=`, `+`, `-` ou `@` neutralisées (injection de formules).
