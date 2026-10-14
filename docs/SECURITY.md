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
| **Mode centrale : argent** | Modèle d'exploitation et frais plateforme modifiables par le seul super admin (aucun droit client). Répartition calculée en base, règlements écrits uniquement par RPC : le chauffeur ne peut que déclarer **ses** paiements, seule la centrale confirme, conteste ou annule (owner / admin). Prix et commission verrouillés dès qu'un règlement est déclaré ou encaissé ; avant (règlement « à régler » ou annulé d'office), prix, commission et moyen de paiement d'une course qui a un règlement ne sont modifiables que par owner / admin (`rides_centrale_split`, `FORBIDDEN_ROLE`, 007900 : un dispatcher ne ramène plus une commission à 0 ni ne renverse le sens du règlement). « J'ai payé », retrait et décisions du réseau partagé refusés si la centrale résolue côté serveur n'est pas celle affichée (`rd_view`, `getPayerContext({ action: true })`). |
| **Réseau partagé : position** | Pendant une course pour une autre organisation, l'organisation du chauffeur ne reçoit ni sa position (RLS) ni aucune distance qui en dérive : offre planifiée à toute la flotte (`ride_offers.distance_m` NULL), journal de fin de recherche (« déjà en course », sans distance), alertes de retard, d'immobilité et de GPS de ses propres courses non calculées pendant ce temps. Règle unique `private.driver_on_foreign_ride` (007900). Positions invraisemblables (saut de plus de 1 km au-delà de 250 km/h) ignorées par `update_driver_location` (`LOCATION_IMPLAUSIBLE`, position précédente gardée ; toute position acceptée après 10 min sans position). |
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

- **Supabase Auth (JWT)**. Pas d'inscription libre : les rattacheurs et leurs accès sont créés par le Super Admin, les chauffeurs par leur rattacheur (invitation ou mot de passe), un client Flotte Privée (propriétaire et chauffeur sur un même compte, toujours neuf) par le Super Admin (section « Flotte Privée »). Seule exception, pour une centrale comme pour une flotte (migration 006300) : le lien d'inscription `/rejoindre/{code}` (code aléatoire de 64 bits, désactivable et régénérable, créé par un owner / admin). La route serveur limite le débit, contrôle l'identité contre les bannissements avant de créer le compte, et la candidature reste « en attente » sans aucun accès aux courses jusqu'à la validation par la centrale (ou validation automatique choisie par elle).
- **Anti brute force** : sur 15 min, 30 tentatives par IP (IPv6 regroupée par /64), 6 par couple (adresse, IP) et un plafond global par adresse (60 pour la connexion web, `lib/login-limits.ts` ; 50 pour la connexion chauffeur, `/api/auth/driver-login`, compteur partagé avec la suppression de compte). Un tiers qui connaît une adresse ne bloque donc pas son titulaire depuis une autre IP. Compteurs partagés dans Redis. Ces compteurs ne couvrent que les routes Rydar. **Supabase Auth exposé** (audit p5) : il répond `user_banned` avant de vérifier le mot de passe et `/otp`, `/recover` trahissent l'existence d'un compte ; le navigateur et l'app chauffeur n'appellent donc que le grant `refresh_token`, `/verify` (liens des e-mails) et `/user` — connexion (web : action serveur ; app : `/api/auth/driver-login` seulement, plus aucun repli direct), « Mot de passe oublié », invitations et `/auth/callback` passent par le serveur web — et le bloc Caddy `api.DOMAINE` ([DEPLOYMENT.md](DEPLOYMENT.md) § 3, point 2, obligatoire) réserve au serveur `/token` (hors `refresh_token`) et `/recover`, et ferme `/otp`, `/signup`, `/magiclink`, `/resend`. Le reste de l'API Auth n'a que les limites par IP de Supabase (en auto-hébergé, seulement si `GOTRUE_RATE_LIMIT_HEADER` est réglé : même § 3) ; d'où le code e-mail à 8 chiffres (valable 1 h, 3600 s : délai partagé avec les liens d'invitation des membres ; 100 millions de possibilités, hors de portée du devinage même depuis de nombreuses IP) ([DEPLOYMENT.md](DEPLOYMENT.md) § 1).
- **Mot de passe oublié (app chauffeur)** : `/api/auth/driver-password-reset` répond toujours de la même façon, que le compte existe ou non (l'e-mail part après la réponse, rien ne se lit dans le temps de réponse) : par heure, 10 demandes par IP, 3 par couple (adresse, IP) et 20 par adresse. Le code reçu est vérifié par `/api/auth/driver-password-reset/confirm` (sur 15 min : 20 par IP, 8 par couple (adresse, IP), 60 par adresse). Le lien de secours ouvre `/auth/set-password?app=driver`, dans un client sans cookie : la session d'un compte déjà connecté au dashboard dans ce navigateur n'est jamais utilisée.
- **Mot de passe oublié (tableau de bord)** : action serveur `requestPasswordReset` (`app/forgot-password/actions.ts`), mêmes règles que l'app : réponse identique que le compte existe ou non, e-mail envoyé après la réponse (`after`), par heure 10 demandes par IP, 3 par couple (adresse, IP) et 20 par adresse ; le navigateur n'appelle plus `/auth/v1/recover`.
- **Équipe** : ajout d'un membre et renvoi d'invitation plafonnés à 10 par heure par administrateur et 20 par centrale (sondage en série de l'existence des comptes, e-mails en masse).
- **Limitation de débit** : IP d'abord, compte ensuite (une requête refusée pour son IP ne consomme pas le quota du compte visé) ; clés de longueur fixe (empreinte SHA-256) ; adresse e-mail limitée à 254 caractères. L'IP est celle de la connexion vue par Caddy (`X-Forwarded-For` réécrit, `X-Real-IP` imposé, `CF-Connecting-IP` retiré) : un client ne peut pas la choisir.
- **Révocation de session** : les refresh tokens sont supprimés en base, automatiquement, dans ces cas :
  - un chauffeur est désactivé, suspendu ou supprimé ;
  - un membre est retiré ou désactivé ;
  - une organisation est suspendue.

  Le changement de mot de passe d'un chauffeur et le bouton **« Déconnecter »** déclenchent aussi la révocation. L'accès aux données, lui, est coupé dès la requête suivante par la RLS (`tests/db/sessions.test.ts`).
  Les notifications aussi : chaque jeton push est lié à la session Auth qui l'a enregistré (`push_tokens.session_id`, claim `session_id`) ; session révoquée ou expirée → `private.claim_notifications` ne sert plus ce jeton (007900). Jetons enregistrés avant 007900 (sans session) : servis tant qu'une session ouverte avant leur dernier enregistrement existe, puis réenregistrés avec leur session au lancement suivant de l'app.
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
- Permissions par clé, date d'expiration, révocation immédiate, débit par minute propre à chaque clé (Redis) ; les requêtes non authentifiées (clé absente, inconnue ou invalide) sont limitées par IP (IPv6 regroupée par /64), et leurs échecs journalisés dans une limite fixe. Une clé d'idempotence rejouée par une autre clé renvoie 409 (`IDEMPOTENCY_KEY_CONFLICT`), jamais la course d'une autre intégration. Une clé avec des origines autorisées (clé « navigateur », lisible par tout visiteur) ne sert qu'à créer une course et à demander un devis (`BROWSER_KEY_SCOPES` : `rides:create`, `rides:quote` ; toute autre route : `INSUFFICIENT_SCOPE`), depuis une origine listée (`ORIGIN_NOT_ALLOWED`), avec le prix et le paiement fixés par la centrale (un prix affiché au client se vérifie par `expected_price_cents` : prix recalculé différent → 409 `PRICE_CHANGED`, rien n'est créé). Elle a en plus des limites par adresse IP, par téléphone et pour l'organisation, comptées organisation par organisation et vérifiées avant son débit, lui-même compté à part pour les devis et pour les réservations ([API.md](API.md#limites-dune-clé--navigateur-)).
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
- En-têtes HTTP (`apps/web/next.config.ts`, `lib/security-headers.test.ts`) et CSP **à nonce** posée par `proxy.ts`
  (`lib/csp.ts`, `lib/domaine-proxy.test.ts`, 10/2026, scanner Rustine) : nonce neuf de 128 bits par requête,
  `script-src 'self' 'nonce-…' 'strict-dynamic'` (aucun `'unsafe-inline'` pour les scripts : un script ou un gestionnaire
  `on…` injecté dans le HTML ne s'exécute pas), `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'` hors
  `/book` et `/embed`, `connect-src` limité à l'origine Supabase du build (plus de joker `*.supabase.co`) et aux tuiles ;
  styles en `'unsafe-inline'` (attributs style de React et MapLibre). Condition : TOUTES les pages rendues à la demande
  (`headers()` dans `app/layout.tsx`, qui passe le nonce au script en ligne du bandeau cookies) ; jamais de
  `force-static`, de `revalidate` de page ni de « use cache » sur une page, sans quoi ses scripts sont bloqués ; un
  nouveau script en ligne prend `nonce={nonce}`. Les cookies de session Supabase restent lisibles par JavaScript
  (client navigateur `@supabase/ssr`). HSTS `includeSubDomains; preload` sur les domaines de la plateforme seulement ; domaine personnalisé d'une centrale : `max-age` seul (l'hôte, jamais ses autres sous-domaines). `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.
- Caddy (`deploy/Caddyfile`) : tout corps de requête plafonné à 2 Mo (1 Mo pour `/api/v1/*` et le webhook Stripe : 413 au-delà), en-têtes lus en 10 s au plus, `/api/tls/allowed` (appel interne de Caddy) en 404 depuis Internet ([DEPLOYMENT.md](DEPLOYMENT.md) § 3, point 1) ; la route garde ses décisions (accord 5 min, refus 60 s), relit l'interrupteur des mini-sites au plus toutes les 30 s et plafonne les résolutions en base à 300 par minute (SNI aléatoires : audit p5 web-2).
- Hôte de mini-site (`proxy.ts`) : résolu avant tout chemin hors `/api/` ; pages légales et `/book/{son slug}` servis seulement s'il sert un mini-site ; `/book/{autre slug}` et `/rejoindre/…` jamais servis sous le domaine d'une centrale (404 neutre ; audit p5 web-1).
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
  nocturnes sur le serveur et en copie chiffrée (restic) dans le stockage objet du MÊME hébergeur, dans l'UE, gardées
  14 jours, e-mails envoyés par le Postfix du serveur, aucun relais tiers. Tout changement (base chez Supabase cloud,
  stockage des sauvegardes chez un autre prestataire ou hors UE, relais SMTP, nouveau prestataire) se reporte d'abord
  dans ces pages ; un nouveau sous-traitant est annoncé aux centrales 30 jours avant (accord de traitement, art. 6).
- **Relecture juridique du 4 octobre 2026** (bêta, aucune centrale cliente) : textes corrigés SUR PLACE, sans nouvelle
  `LEGAL_VERSION` / `ORG_LEGAL_VERSION` (décision du propriétaire). Dès l'ouverture, toute modification redevient une
  nouvelle version (préambule, `ORG_LEGAL_CHANGES`, e-mail d'annonce, page figée). Registre, procédure de violation et
  délégué : `docs/RGPD-REGISTRE.md` ; analyses d'impact : `docs/AIPD.md` (DPA, art. 10, y renvoie).
- **Interdiction sur toute la plateforme** (CGU, art. 10 et 11 ; CGV, art. 10 bis ; DSA, art. 17) : seulement pour une
  fraude ou un document faux (`PLATFORM_BAN_CATEGORY`, `PLATFORM_REPORT_CATEGORY`), faits retenus obligatoires,
  e-mail motivé à chaque chauffeur touché (`platform_ban` : motifs, articles 10 et 11 des CGU, recours de 6 mois, juge,
  CNIL), message d'accès refusé distinct (`ban_scope`, connexion et application). Renuméroter les CGU = changer
  l'e-mail dans une nouvelle migration (test `legal-pages.test.ts`).
- **Identité de l'éditeur** : `accept_legal_documents` refuse les CGV et le DPA (`LEGAL_EDITOR_MISSING`) tant que la
  raison sociale, l'adresse et l'immatriculation manquent dans `/admin/legal` (alerte en tête de `/admin`) ; une
  organisation qui n'a jamais accepté les CGV ne voit que l'écran d'acceptation (owner / admin, `orgTermsGate`).
- **Supervision par l'éditeur** (DPA, art. 4) : carte en direct du super admin sans nom, téléphone, plaque, adresse ni
  vitesse ; la vitesse n'est jamais historisée (`update_driver_location`, 007400) ni affichée en km/h.
- **Suspension d'une centrale** (CGV, art. 7) : fondement (mise en demeure de 8 jours au moins, urgence, demande de la
  centrale) et motif obligatoires (`lib/suspension.ts`), montrés au propriétaire et aux administrateurs (`/suspended`) ;
  la base refuse pendant une course en cours (`DRIVER_ON_RIDE`).
- **Relances WhatsApp de Rydar au propriétaire** : refus noté par le super admin (`svc_platform_whatsapp_refusal`,
  `/admin/frais`), respecté par `svc_platform_remind` (`WHATSAPP_OPTED_OUT`). Relances des chauffeurs : intérêt
  légitime de la centrale, opposition auprès d'elle (canal commun à tous ses chauffeurs tant qu'aucun réglage par
  chauffeur n'existe).
- **Coordonnées des clients** : téléphone, e-mail et précisions effacés 3 ans après la fin de l'année de la course
  (ménage quotidien `customer_contacts`) ; nom, trajet et montants gardés 10 ans.
- **Fin du contrat d'une centrale** (CGV, art. 8 ; DPA, art. 11) : suppression promise sous 30 jours, mais **aucun outil
  de purge n'existe encore**. À construire de préférence AVANT l'ouverture, et au plus tard avant la première fin de
  contrat d'une centrale cliente : RPC super admin `svc_purge_archived_org` (organisation archivée depuis 30 jours au
  moins ; chauffeurs et candidats par `private.delete_driver_account` ; coordonnées des clients et précisions effacées
  des courses qui portent des frais plateforme — registre en `on delete restrict` —, autres courses supprimées ;
  messages, positions, mini-site, adhésions ; fiche, registre des frais, paiements et preuves gardés ; audit). Ne jamais
  retarder l'archivage d'une centrale en fin de contrat pour attendre l'outil : l'archivage à la fin du contrat et la
  suppression sous 30 jours sont promis aux centrales (CGV, art. 8) et exigés du sous-traitant (RGPD, art. 28.3.g).
- **Mini-sites (clients particuliers)** : le professionnel est la centrale, Rydar lui donne les moyens d'être conforme :
  bouton « Réserver avec obligation de paiement » (Code de la consommation L221-14, maintenu pour le transport de
  passagers par L221-2), conditions de la centrale (`booking_sites.legal_mentions` : réservation, annulation, moyens de
  paiement, médiateur) affichées avant le bouton, simple information sur les données (aucune case de consentement), prix
  estimé « TTC », aucune promesse affichée qui ne dépende des réglages de la centrale. Mise en ligne et réservation
  refusées sans raison sociale, SIRET, adresse et n° VTC de la centrale (`bookingOperatorGaps`) ; avec un prix,
  e-mail obligatoire ; accusé de réception à contenu fixe dès qu'un e-mail est saisi (« demande de réservation » sans
  prix ; `svc_booking_receipt`, 3 par boîte et par 24 h : « +étiquette » et points Gmail confondus, `private.mailbox_key`) ;
  pas de droit de rétractation (L221-2) rappelé. À relire avant de rouvrir les mini-sites (`booking_sites_enabled()`) ;
  le site vitrine affiche l'indisponibilité tant qu'ils sont coupés ; test `components/legal/legal-pages.test.ts`.

## Limites des offres

Chauffeurs, courses mensuelles, administrateurs, accès API, mini-site et domaine personnalisé sont vérifiés **par des triggers en base** (`PLAN_LIMIT_*`, `PLAN_FEATURE_*`). Contourner l'interface ne permet pas de les dépasser. Chauffeurs et accès sont comptés sous le verrou de la ligne de l'organisation (007900) : deux ajouts simultanés ne dépassent plus la limite, le second attend puis est refusé. Flotte Privée : 1 chauffeur et 1 accès imposés par `private.org_limits` après l'offre et la surcharge (section suivante).

## Flotte Privée (migrations 007600, 007700)

Client chauffeur VTC indépendant : une organisation flotte dont le propriétaire est l'unique fiche chauffeur, sur le
même compte ([ARCHITECTURE.md](ARCHITECTURE.md) § 14, [FLOTTE-PRIVEE.md](FLOTTE-PRIVEE.md)). Les limites du pack sont
des **invariants en base** ; le web et l'app ne font que masquer et expliquer.

- **Drapeau** `organizations.private_fleet` : lisible par les membres (droit par colonne), absent de tout droit UPDATE
  client, comme `drivers.owner_driver`. Seules deux RPC réservées au service role l'écrivent,
  `svc_platform_create_private_fleet` et `svc_platform_set_private_fleet` (auteur super admin revérifié par
  `private.assert_platform_actor`, audit écrit en SQL). Leur marqueur de transaction `rydar.private_fleet_change`
  (identifiant de l'organisation) écarte une écriture involontaire, même en service role (`PRIVATE_FLEET_LOCKED`,
  42501) ; ce n'est qu'une intention : la sécurité repose sur l'absence de droit client et sur ces RPC réservées.
- **Gardes** (dernier rempart pour tous les chemins, service role compris) : modèle flotte et lien d'inscription fermé
  (contrainte et `organizations_private_fleet_guard` : `PRIVATE_FLEET_MODEL`, `PRIVATE_FLEET_RESTRICTED`) ; une seule
  fiche, celle du propriétaire actif (`drivers_aa_private_fleet_guard` : `PRIVATE_FLEET_SINGLE_DRIVER`,
  `PRIVATE_FLEET_DRIVER_OWNER`) ; un seul accès au tableau de bord (`organization_users_private_fleet_guard` et
  `org_limits`) ; aucun réseau partagé (`network_memberships_private_fleet_guard`). Le drapeau y est relu sous verrou
  (ligne de l'organisation pour une fiche ou un nouvel accès, verrou consultatif pour le réseau) : une entrée en Flotte
  Privée en cours est attendue. Entrée refusée tant qu'une raison existe (`PRIVATE_FLEET_NOT_ELIGIBLE`).
- **Limites et Checkout verrouillé** : `private.org_limits` impose 1 chauffeur et 1 accès APRÈS l'offre et la surcharge
  du super admin : ni une offre, ni une surcharge, ni un achat Stripe ne les lèvent. `/api/billing/checkout` relit
  `private_fleet` en service role (jamais d'après la session) et n'accepte que l'offre attribuée par l'équipe
  (`checkoutPlanAllowed`, jamais une offre publique) ; organisation illisible : 503. Reste le portail client Stripe
  (« Gérer ») : sa configuration par défaut sert à toutes les organisations ; s'il permet de changer d'offre, une Flotte
  Privée abonnée par Stripe peut y en prendre une autre, que le webhook écrit dans `plan_id` (1 chauffeur et 1 accès
  toujours imposés, mais l'API peut se perdre) : réglage et choix dans [DEPLOYMENT.md](DEPLOYMENT.md) § 4, étape 6.
  Une offre sans API est refusée à la création, à l'entrée en Flotte Privée et à l'attribution, et l'API ne peut pas
  être retirée d'une offre qu'une Flotte Privée utilise (son site ne pourrait plus réserver).
- **Web, masqué ET bloqué** : chaque page hors du pack est redirigée ou en 404 avant toute lecture
  (`privateFleetPage`), chaque action serveur correspondante refusée avant toute écriture, création de compte ou appel
  externe (`refuseInPrivateFleet` : chauffeurs, inscriptions, réseau partagé, équipe, messagerie, réglages de dispatch,
  de centrale et WhatsApp, attribution, relance et retrait d'une course). Test statique
  `components/shell/private-fleet-guards.test.ts` : toute nouvelle page ou action du tableau de bord y est classée.
- **Clés du site gérées par l'équipe** : les actions de clés et de webhooks du tableau de bord relisent elles-mêmes
  `organizations.private_fleet` et refusent (`PRIVATE_FLEET_RESTRICTED` ; drapeau illisible : « Vérification
  impossible »). Le super admin crée la clé du site (serveur ou navigateur, débit réglable) seulement pour une Flotte
  Privée active dont les CGV et l'accord de traitement en vigueur sont acceptés ; clé complète affichée une seule fois,
  jamais stockée (HMAC poivré) ; révocation immédiate ; audit `api_key.created` / `api_key.revoked` (acteur
  `super_admin`) ; garde `PLAN_FEATURE_API`. Le client voit ses clés en lecture seule (« Mon site » : type, préfixe,
  origines, dernière utilisation).
- **Refus avant toute création de compte Auth** : la création d'un client contrôle l'adresse du propriétaire
  (recherche par égalité, jokers échappés ; lecture en échec = refus), l'identifiant et l'offre AVANT tout compte et tout
  e-mail : une adresse qui a déjà un compte Rydar est refusée (« demandez une autre adresse au client »). Côté client,
  `createDriver` et `inviteMember` refusent en Flotte Privée avant toute recherche ou création de compte (test
  statique).
- **Défense « compte neuf »** : le compte est créé par `createUser` sans confirmation, qui refuse toute adresse déjà
  connue d'Auth (même jamais confirmée), puis invité par e-mail ; la RPC refuse en plus un compte qui a déjà une adhésion
  ou plus d'une heure d'existence (`OWNER_NOT_NEW`), une fiche chauffeur (`ALREADY_REGISTERED`), le super admin
  lui-même (`SELF_NOT_ALLOWED`). Raison : `private.current_driver_id()` ne vérifie ni l'adhésion ni
  `private.jwt_issued_after` ; une fiche active sur un compte existant donnerait accès aux clients sans preuve par
  e-mail. Rattacher un compte existant n'est pas livré (phase 2). Échec après la création du compte : seul ce compte
  est supprimé, et seulement s'il n'a ni adhésion ni fiche (relu), jamais sur un refus qui le dit déjà utilisé. Mot de
  passe provisoire seulement derrière une case explicite (accès connu de l'équipe, à changer par « Mot de passe
  oublié ») ; « Renvoyer le lien d'accès » seulement pour un propriétaire jamais connecté (audit
  `member.invitation_resent`).
- **Support** : l'équipe ne devient jamais membre (« Donner un accès » refusé en Flotte Privée) ; elle lit par la RLS
  du super admin et agit par les cartes de la fiche.
- **Réservations et agenda** : `driver_take_ride` ne prend qu'une réservation de SON organisation (`RIDE_NOT_FOUND`
  sinon), au plus 6 h après l'heure prévue ; sur le web, « Je la prends » l'appelle avec le jeton du propriétaire,
  jamais `assign_ride` (refusé en Flotte Privée). `driver_agenda` ne renvoie une course close qu'au chauffeur membre de
  l'organisation (sinon seulement si elle a changé depuis moins de 24 h, comme la RLS), par la liste blanche
  `private.driver_ride_json`, et `unassigned` seulement à ce membre. La notification `ride_unconfirmed` ne contient
  jamais `ride_id`.
- **Bascule** (`svc_platform_set_private_fleet`) : une transaction, note d'accord du client obligatoire
  (`CONSENT_REQUIRED`), un refus des frais annule tout ; audit `organization.private_fleet_enabled` / `_disabled`
  (gravité warning) ; temps réel `platform.updated` (`model`, identifiants seulement) et `driver.updated`.
- **Contrat** : CGV, DPA et CGU inchangés par ce pack. La référence des conditions particulières et du contrat de
  prestations signés est obligatoire à la création (`CONSENT_REQUIRED`) et gardée dans l'audit
  `organization.private_fleet_created` ; ces textes restent à faire rédiger et signer avant toute activation
  ([FLOTTE-PRIVEE.md](FLOTTE-PRIVEE.md) § 12).

## Formulaire de contact et e-mails

- Public et sans compte : champ piège (robot → faux succès, rien d'enregistré), validation partagée, limites par IP
  (seau /64, 5 par heure), par boîte (3 par jour) et globale (200 par heure), plafond SQL (`CONTACT_BUSY`, 300 par
  heure glissante). L'adresse IP n'est gardée qu'en empreinte HMAC (poivre du serveur), effacée au bout d'un an.
- L'accusé de réception part vers une adresse saisie par un inconnu : contenu FIXE (aucune donnée saisie), un par
  boîte et par 24 h (SQL), 30 par heure en tout. Le formulaire ne peut pas servir à écrire à un tiers.
- **« Par adresse » = par boîte** (audit p5) : toute limite comptée par adresse e-mail saisie par un inconnu (contact,
  éligibilité, accusés du mini-site) passe par `mailboxKey` (`@rydar/shared`, clés Redis) ou `private.mailbox_key`
  (SQL) : minuscules, « +étiquette » retirée, points de Gmail ignorés (`googlemail.com` = `gmail.com`). L'e-mail part
  toujours vers l'adresse saisie ; la clé ne sert qu'à compter.
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
  modifier avec le code (et les e-mails de 006600). Engagements tenus à la main, sans contrôle du code : « Frais
  ajoutés » seulement pour une erreur de calcul (sinon accord écrit), cycle / délai / seuil de blocage changés en sa
  défaveur seulement avec son accord écrit, facture récapitulative de chaque cycle dès sa fin (export « Frais à
  facturer », `admin_platform_invoice_lines` ; pas de seuil de blocage sans cette facture), remboursement au prorata
  d'une résiliation pour refus. Contrôlés par la base : changement de modèle seulement avec la demande ou l'accord écrit
  noté (`svc_platform_set_fees`, `CONSENT_REQUIRED`, journalisé) ; délai de paiement de 45 jours au plus
  (`organizations_platform_payment_days_guard`) ; baisse sans décision acceptée au bout de 30 jours. Organisation qui
  n'a jamais accepté les CGV : acceptation exigée (owner / admin) avant sa première course.
- **Hausse des taux annoncée** (migration 006600) : seulement par `svc_platform_set_fees` (auteur super admin revérifié,
  audit en SQL) ; une hausse s'applique au plus tôt 30 jours après son annonce par e-mail aux propriétaires (et pas avant
  l'entrée en vigueur des CGV qu'une organisation n'a pas acceptées, ni avant la date qui lui a été annoncée ; refusée
  sans CGV acceptées ni annoncées, `TERMS_NOT_NOTIFIED`, ou sans adresse, `NO_EMAIL` ; jamais appliquée si aucun e-mail
  d'annonce n'est parti 30 jours avant : annulée, journal « warning » ; annonce des CGV refusée à moins de 30 jours,
  `TERMS_NOTICE_TOO_SHORT` ; e-mails d'annonce gardés 10 ans), sauf accord écrit noté (journal « warning »,
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
