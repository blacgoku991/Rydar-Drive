# Déploiement

Architecture cible :

- **Supabase** : base de données, authentification, temps réel, stockage.
- **Vercel** (ou tout hébergeur Node) : application web.
- **Worker** Node en conteneur (Fly.io, Render, Railway, Scaleway…).
- **Redis** managé.
- **Stripe**.
- **EAS** : builds de l'app chauffeur.

> **Tout sur un VPS** (site + worker + Redis + HTTPS automatique, base chez Supabase) : kit clé en main dans [`deploy/`](../deploy/README.md) — `sudo bash deploy/install.sh`.

## 1. Supabase

1. Créez un projet dans la région UE (par exemple `eu-west-3`, Paris).
2. Appliquez les migrations :

   ```bash
   supabase link --project-ref <ref>
   supabase db push              # applique supabase/migrations/*.sql
   ```

   **Ne chargez jamais `seed.sql` en production** : il contient les comptes de démonstration.

3. **Auth** (Dashboard → Authentication) :
   - désactivez les inscriptions publiques (*Allow new users to sign up* : off) ;
   - *Site URL* = `https://app.votre-domaine` ;
   - *Redirect URLs* : `https://app.votre-domaine/auth/callback` et `/auth/set-password` ;
   - SMTP personnalisé, pour les invitations des chauffeurs et des rattacheurs.
   - *Emails → Templates* : « Reset password » et « Invite user » en français, en gardant le lien `{{ .ConfirmationURL }}`.
     Le modèle « Reset password » doit contenir **le code `{{ .Token }}` et le lien `{{ .ConfirmationURL }}`** : dans l'app chauffeur,
     « Mot de passe oublié » demande le code reçu par e-mail puis le nouveau mot de passe (`POST /api/auth/driver-password-reset/confirm`) ;
     le lien sert aux centrales sur le web et de secours au chauffeur (page `/auth/set-password?app=driver`). Exemple :

     - sujet : `Rydar Drive : votre code pour changer de mot de passe`
     - corps (HTML) :

       ```html
       <p>Bonjour,</p>
       <p>Code à saisir dans l'application Rydar Drive :</p>
       <p style="font-size:28px;font-weight:700;letter-spacing:6px">{{ .Token }}</p>
       <p>Vous pouvez aussi ouvrir ce lien pour choisir un nouveau mot de passe : <a href="{{ .ConfirmationURL }}">changer mon mot de passe</a>.</p>
       <p>Le code et le lien expirent dans une heure ; le premier utilisé annule l'autre. Vous n'êtes pas à l'origine de la demande ? Ignorez ce message.</p>
       ```

   - **Codes envoyés par e-mail** (*Sign In / Providers → Email*) : *Email OTP Length* = **8** chiffres, *Email OTP
     Expiration* laissée à **3600 s** (1 h). Les limites de Rydar (connexion, vérification du code) ne protègent que ses
     propres routes : l'API Auth de Supabase reste appelable directement avec la clé publique, et elle ne compte pas
     les essais par code (seulement une limite par IP). Avec 8 chiffres (100 millions de possibilités), le devinage
     reste hors de portée même depuis de nombreuses adresses IP. Rien à reconstruire : l'app chauffeur et
     `/api/auth/driver-password-reset/confirm` acceptent 6 à 10 chiffres. Ne raccourcissez pas le délai : il vaut
     aussi pour les liens d'invitation des membres (même réglage).
   - *Rate Limits* : la limite des vérifications de code (*token verifications*, par IP) peut être abaissée ; ne
     baissez pas trop celles des connexions et du rafraîchissement des sessions, car les téléphones des chauffeurs
     partagent souvent l'adresse IP de leur opérateur.
   - **Journal d'audit Auth (conservation)** : Supabase Auth inscrit chaque connexion (nom, e-mail, adresse IP) dans
     `auth.audit_log_entries`. `private.housekeeping` (migration 004800, une fois par heure) en efface les lignes de plus
     d'un an, et la file de suppression (`private.complete_account_deletion`) celles d'un chauffeur dès que son compte de
     connexion est supprimé, comme l'annoncent `/confidentialite` et `/suppression-compte`. La table a la RLS activée
     par Supabase : ces suppressions n'agissent que si le rôle `postgres` a `BYPASSRLS` (c'est le cas sur un projet
     hébergé). **Contrôle après déploiement** (SQL Editor) : `select rolbypassrls from pg_roles where rolname = 'postgres';`
     et `select has_table_privilege('postgres', 'auth.audit_log_entries', 'DELETE');` doivent renvoyer `true` ; une heure
     plus tard, `select count(*) from auth.audit_log_entries where created_at < now() - interval '1 year';` doit renvoyer
     0. Un refus de droits apparaît dans le journal du worker (`housekeeping incomplete`, `errors.auth_audit`) ; sans
     `BYPASSRLS`, la suppression n'efface rien, sans erreur. **Alternative** :
     *Authentication → Audit Logs*, désactiver l'écriture des journaux Auth dans la base (*Disable writing auth audit
     logs to project database* ; `GOTRUE_AUDIT_LOG_DISABLE_POSTGRES=true` en auto-hébergé) : les connexions ne sont
     plus gardées que dans les journaux de Supabase (durée de conservation de l'offre) ; purger alors une fois le stock
     (`delete from auth.audit_log_entries;`) et, dans ce cas, remplacer « 1 an » par la durée de conservation des
     journaux de l'hébergeur dans `/confidentialite`, `/dpa` et `/suppression-compte`.
4. **Realtime** (*Realtime → Settings*) : désactivez *Allow public access*. Rydar n'utilise que des canaux privés ; la policy `rydar_realtime_receive` (migrations 0600 et 2300) gère les droits d'écoute des canaux `org:*`, `driver:*` et `fleet:*`.
5. **Storage** : les buckets `org-assets`, `driver-photos` et `driver-documents` et leurs policies sont créés par la migration 0800.
6. Créez le premier **Super Admin** : invitez l'utilisateur depuis le dashboard Supabase, puis exécutez `update public.users set is_super_admin = true where email = '…';` dans le SQL editor.

> Les migrations sont testées en CI sur PostgreSQL 16 + PostGIS, avec des stubs des schémas Supabase (`scripts/sql/local-supabase-stubs.sql`). Elles utilisent uniquement des API Supabase standard : `auth.uid()`, `auth.jwt()`, `realtime.send()` et `storage.buckets`.
>
> Sur Supabase, le rôle `postgres` qui applique les migrations n'est pas super-utilisateur, et les tables `auth.*`, `storage.*` et `realtime.messages` appartiennent aux services. Les migrations n'y créent donc que des policies (autorisées par l'extension supautils) et deux déclencheurs sur `auth.users`, sans jamais modifier ces tables. Elles ont été rejouées avec les droits d'un projet hébergé : image `supabase/postgres`, supautils, schémas Storage, Auth et Realtime.
>
> Les colonnes de `public.organizations` lisibles par les clients (tableau de bord, super admin par sa session) sont accordées une à une (`grant select (…)`, migration 004300) ; les autres (Stripe, relances et conditions de paiement de Rydar, compteurs…) restent réservées au serveur et aux RPC. Toute nouvelle colonne lue par un client doit être ajoutée à ce GRANT par une nouvelle migration, sinon elle est illisible et un `select('*')` échoue (42501).

## 2. Application web (Vercel)

- Projet racine `apps/web`, framework Next.js. Commande de build : `pnpm --filter @rydar/web build`, installation depuis la racine du monorepo.
- Domaines :
  - `app.votre-domaine` pour le dashboard ;
  - `*.votre-domaine` (wildcard) pour les mini-sites `{slug}.votre-domaine` ;
  - les domaines personnalisés des organisations Business, ajoutés dans Vercel.

| Variable | Rôle |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Client Supabase (clé **publique**). `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` est lue à défaut de `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `SUPABASE_SERVICE_ROLE_KEY` | Serveur uniquement : API v1, administration |
| `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_ROOT_DOMAIN` | URL publique, domaine des mini-sites |
| `API_KEY_PEPPER` | Poivre HMAC des clés API, 32 caractères aléatoires ou plus. Le changer invalide toutes les clés |
| `REDIS_URL` | Rate limiting et anti brute force partagés (Upstash, Redis Cloud…) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Abonnements. Webhook : `https://app…/api/stripe/webhook` |
| `DRIVER_APP_ORIGINS` | (optionnel) origines autorisées à appeler les routes de l'app chauffeur (`/api/auth/driver-login`, `/api/auth/driver-password-reset…`) depuis un navigateur |

### Mini-sites : sous-domaines réservés

Depuis la migration 004900, les noms de la plateforme (`admin`, `support`, `api`, `www`…, tout nom commençant par
`rydar`) ne peuvent plus être choisis comme sous-domaine de mini-site. Un nom pris avant reste en place et servi : la
centrale enregistre ses autres réglages, seul un changement vers un autre nom réservé est refusé. Contrôle à faire une
fois en production (SQL editor) :

```sql
select organization_id, subdomain, enabled from public.booking_sites where private.is_reserved_subdomain(subdomain);
```

Si des lignes sortent : prévenez la centrale, puis libérez le nom avec
`update public.booking_sites set subdomain = null where organization_id = '…';` (le mini-site reste joignable par
`/book/{slug}` et son domaine personnalisé ; la centrale choisit un autre sous-domaine).

### Cartographie, adresses et itinéraires

| Variable | Défaut | Production conseillée |
| --- | --- | --- |
| `NEXT_PUBLIC_MAP_TILES_URL` | `https://tiles.openfreemap.org/planet` | OpenFreeMap : gratuit, sans clé, schéma OpenMapTiles. Autre option : MapTiler (TileJSON avec clé) |
| `NEXT_PUBLIC_MAP_GLYPHS_URL` | polices OpenFreeMap | à changer en même temps que les tuiles |
| `NEXT_PUBLIC_MAP_STYLE_URL` | vide | style complet tiers (remplace le style Rydar) |
| `GEOCODER_PROVIDER` | `geopf` | `geopf` : Géoplateforme IGN, gratuit, adresses et lieux en France. Aussi `ban`, `google`, `mapbox` |
| `GEOCODER_URL` | service public | serveur compatible BAN auto-hébergé (addok) |
| `ROUTING_PROVIDER` | `osrm` | `osrm` auto-hébergé, ou `mapbox` / `google` (trafic en temps réel) |
| `OSRM_URL` | serveur de démo OSRM | **à remplacer** : le serveur public de démo est limité. Voir ci-dessous |
| `MAPBOX_TOKEN`, `GOOGLE_MAPS_API_KEY` | | selon le fournisseur choisi |
| `GEO_DAILY_BUDGET` | `20000` | Budget quotidien global d'un fournisseur payant (Google, Mapbox), compté à part pour les adresses et pour les itinéraires (mini-site compris ; guidage des chauffeurs non compté). Sous-plafonds pour qu'un seul consommateur ne l'épuise pas pour tous : visiteur anonyme (mini-site, clé API « navigateur ») 2 % par IP (/64), 10 % par mini-site, 30 % pour tous les anonymes ; 30 % par centrale (tableau de bord, clé API serveur) ; 30 % par utilisateur connecté (adresses). Au-delà : Géoplateforme / BAN pour les adresses ; pour les itinéraires, l'OSRM de l'exploitant si `OSRM_URL` en désigne un (jamais le serveur public de démo), sinon estimation à vol d'oiseau. Une grosse centrale seule sur la plateforme est donc limitée à 30 % : relevez le budget. Compteurs dans Redis |

**OSRM auto-hébergé** (recommandé, sans coût par requête) :

```bash
wget https://download.geofabrik.de/europe/france-latest.osm.pbf
docker run -t -v $PWD:/data ghcr.io/project-osrm/osrm-backend osrm-extract -p /opt/car.lua /data/france-latest.osm.pbf
docker run -t -v $PWD:/data ghcr.io/project-osrm/osrm-backend osrm-partition /data/france-latest.osrm
docker run -t -v $PWD:/data ghcr.io/project-osrm/osrm-backend osrm-customize /data/france-latest.osrm
docker run -p 5000:5000 -v $PWD:/data ghcr.io/project-osrm/osrm-backend osrm-routed --algorithm mld /data/france-latest.osrm
```

Si le routage échoue, la création de course **n'est jamais bloquée**. Rydar utilise alors une estimation (distance à vol d'oiseau × 1,35), et `worker backfill-routes` recalcule les tracés plus tard.

## 3. Worker

```bash
docker build -f apps/worker/Dockerfile -t rydar-worker .
docker run -e DATABASE_URL=postgresql://postgres:…@db.<ref>.supabase.co:5432/postgres \
           -e SUPABASE_URL=https://<ref>.supabase.co \
           -e SUPABASE_SERVICE_ROLE_KEY=… \
           -e EXPO_ACCESS_TOKEN=… rydar-worker
```

| Variable | Rôle |
| --- | --- |
| `DATABASE_URL` | **Requise.** Connexion à la base (voir ci-dessous) |
| `SUPABASE_URL` (à défaut `NEXT_PUBLIC_SUPABASE_URL`), `SUPABASE_SERVICE_ROLE_KEY` (ou `SUPABASE_SECRET_KEY`) | **Requises en production.** API Storage et administration d'Auth, avec la clé service role : le worker termine les suppressions de compte chauffeur restées inachevées (dossier des justificatifs, compte de connexion). Sans elles, il écrit l'erreur `account deletions cannot be completed` au démarrage, puis toutes les heures tant que la file n'est pas vide, et `/admin/suppressions` affiche ces suppressions « en retard ». Le kit VPS les transmet (`deploy/docker-compose.yml`) |
| `DATABASE_SSLMODE`, `DATABASE_CA_FILE` | Chiffrement de la connexion à la base, prioritaire sur le `sslmode` de `DATABASE_URL` : `verify-full` (certificat du serveur vérifié avec la racine `DATABASE_CA_FILE`) ou `no-verify` (repli). Vide : `DATABASE_URL` telle quelle. Voir « Connexion chiffrée à la base » |
| `EXPO_ACCESS_TOKEN` | Pushs par Expo (voir « Pushs » plus bas). **Recommandé en production**, avec l'option Expo *Enhanced Security for Push Notifications* : sans elle, quiconque connaît le jeton push d'un téléphone peut lui envoyer une notification affichée comme venant de Rydar Drive. `FCM_*` / `APNS_*` pour un envoi direct (`APNS_PRODUCTION=false` : serveur sandbox d'Apple) |
| `WHATSAPP_API_VERSION` | Facultative ([WHATSAPP.md](WHATSAPP.md)). Aucun jeton WhatsApp dans l'environnement : ils sont en base, lisibles par le seul service role |
| `*_MS` | Fréquences des tâches (tableau ci-dessous), défauts conseillés |
| `NOTIFICATION_BATCH`, `WHATSAPP_BATCH` | Notifications push (200) et relances WhatsApp (20) réservées par passage |
| `HEALTH_PORT` | Port du point de santé (8080), repris par le `HEALTHCHECK` de l'image |
| `PUSH_DRY_RUN` | `true` : aucun push réellement envoyé (développement, jamais en production) |

Le kit VPS (`deploy/docker-compose.yml`) ne transmet au conteneur que les variables qu'il liste ; les autres (`*_MS`,
`NOTIFICATION_BATCH`, `WHATSAPP_BATCH`, `HEALTH_PORT`, `FLIGHT_BATCH`, `FLIGHT_CONCURRENCY`, `FLIGHT_TIMEOUT_MS`,
`FLIGHT_CACHE_MS`, `FLIGHT_MOCK_DELAYS`, `PUSH_DRY_RUN`) y gardent leur valeur par défaut, même ajoutées à `deploy/.env`.

- `DATABASE_URL` doit être une **connexion directe** (port 5432) et non le pooler transactionnel : le worker utilise `LISTEN/NOTIFY`.
- Vous pouvez lancer plusieurs instances : les tâches sont réparties par `FOR UPDATE SKIP LOCKED` ou protégées par un verrou SQL.
- Le simulateur de flotte (`pnpm --filter @rydar/worker simulate`, développement et recette) n'est pas dans l'image et refuse
  de démarrer si `NODE_ENV=production` (sauf `SIM_ALLOW_PRODUCTION=1`, sur une base jetable) : il agit au nom de vrais chauffeurs.
- Healthcheck : `GET :8080/` (`HEALTH_PORT`) renvoie `{"healthy":true,…}` avec l'état de chaque tâche (`flights`, `watch`, `documents`, `settlements`, `deletions`). `healthy` ne dépend que du tick du dispatch : une panne du fournisseur de vols ne rend pas le worker « malade ». `deletions.enabled` vaut `false` sans l'API Supabase ; `deletions.waiting` compte alors les suppressions bloquées.
- Au démarrage, le journal indique `"accountDeletions":"on"` (ou `off: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing`).

Tâches périodiques :

| Tâche | Fréquence (variable) | Rôle |
| --- | --- | --- |
| `private.dispatch_tick()` | 2 s (`DISPATCH_TICK_MS`) | vagues, délais des offres, bascule des planifiées |
| notifications (outbox) | `LISTEN` + 3 s (`NOTIFICATION_POLL_MS`) | envoi des pushs, accusés Expo toutes les 5 s ; relances WhatsApp (`private.claim_whatsapp`, [WHATSAPP.md](WHATSAPP.md)) |
| `private.housekeeping()` | 5 min (`HOUSEKEEPING_MS`) | durées de conservation (§ 6) : positions, messages, notifications, journaux (celui de Supabase Auth une fois par heure), adresses IP, courses, bannissements (`private.purge_expired_bans`) ; un échec de la purge des courses, des bannissements ou du journal Auth est renvoyé dans `errors` (journal `housekeeping incomplete`, niveau warn) sans bloquer le reste ; ne met jamais un chauffeur hors ligne |
| `private.watch_rides()` | 30 s (`WATCH_RIDES_MS`) | alertes chauffeur en retard, immobile, GPS muet, course non démarrée |
| `private.watch_driver_gps()` | 30 s (`WATCH_DRIVER_GPS_MS`) | application fermée (ni position ni signe de vie depuis 3 min) : chauffeur hors ligne, sans notification (jamais en course) |
| `private.document_reminders()` | au démarrage puis 6 h (`DOCUMENT_REMINDERS_MS`) | documents échus, rappels d'échéance (30 j, 7 j, jour J), jamais avant 9 h locale |
| `private.settlement_reminders()` | au démarrage puis 15 min (`SETTLEMENT_REMINDERS_MS`) | mode centrale : relance des commissions en retard (une par chauffeur toutes les 24 h, 3 au plus) |
| suppressions de compte : `private.claim_account_deletions(10)` → Storage + Auth → `private.complete_account_deletion` | au démarrage puis 5 min (`ACCOUNT_DELETIONS_MS`) | reprend la file `private.account_deletions` quand la route de l'app ou `/admin/suppressions` n'a pas pu finir : purge du dossier `{centrale}/{chauffeur}/` des justificatifs, puis suppression du compte de connexion (sauf s'il sert aussi à gérer une centrale). Nouvel essai espacé de 5 min à 6 h, abandon au 10ᵉ essai (journal d'audit critique, bouton « Réessayer » sur `/admin/suppressions`). Exige l'API Supabase (variables ci-dessus) |
| `private.purge_deleted_driver_bans()` | toutes les 6 h (dans la tâche précédente) | bannissements des comptes supprimés depuis 3 ans : empreintes, signalements et motif effacés (filet de `private.purge_expired_bans`, qui les efface déjà 3 ans après le bannissement) ; fonctionne même sans l'API Supabase |
| vols : `private.flights_to_check(n)` → fournisseur → `private.apply_flight_status(...)` | 60 s (`FLIGHT_POLL_MS`) | horaires des vols, prise en charge recalée, notification au chauffeur |

### Connexion chiffrée à la base

Le worker et `deploy/migrate.sh` vérifient le certificat du serveur PostgreSQL (`DATABASE_SSLMODE=verify-full`, défaut du
kit VPS) avec la racine publique de Supabase, versionnée dans `deploy/supabase-ca.crt` et montée en lecture seule dans le
worker (`/etc/rydar/supabase-ca.crt`). Sans cette vérification, un intermédiaire placé entre le VPS et Supabase pourrait
se faire passer pour la base et obtenir une session `postgres` (RLS contournée). Le mot de passe de la base ne passe
jamais dans une ligne de commande (`PGPASSWORD`, `deploy/pg-url.sh`).

**Contrôle** (une fois après la mise à jour qui introduit la vérification, puis après tout changement de ce réglage) :

1. Racine versionnée : `openssl x509 -in deploy/supabase-ca.crt -noout -subject -enddate -fingerprint -sha256` doit
   afficher `CN = Supabase Root 2021 CA`, `notAfter=Apr 26 10:56:53 2031 GMT` et l'empreinte
   `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`, la même que
   celle du certificat téléchargé dans Supabase (*Project Settings → Database → SSL Configuration → Download certificate*).
2. Certificat présenté par le pooler, sans mot de passe (`HOTE` = hôte de `DATABASE_URL`, par exemple
   `aws-0-eu-west-3.pooler.supabase.com`) :
   `openssl s_client -starttls postgres -connect HOTE:5432 -servername HOTE -verify_hostname HOTE -CAfile deploy/supabase-ca.crt -verify_return_error </dev/null 2>&1 | grep -E 'Verify return code|verify error'`
   doit afficher `Verify return code: 0 (ok)`.
3. `sudo bash deploy/install.sh` : `migrate.sh` se connecte en `verify-full` avant toute migration ou reconstruction, et la
   vérification finale attend un worker sain. Le journal de démarrage du worker indique `"dbSsl":"verify-full"`.

**En cas d'échec** (`certificat du serveur de la base NON vérifié`, `certificate verify failed`, `self-signed certificate`,
`unable to get local issuer certificate`) :

- rien n'a été modifié : `migrate.sh` s'arrête avant les migrations et la reconstruction, les services en place
  continuent de tourner ;
- vérifiez l'hôte de `DATABASE_URL` (Session pooler, `*.pooler.supabase.com`) et refaites le contrôle 2 depuis une autre
  machine : un résultat différent signale une interception sur le réseau du VPS ;
- si Supabase a changé d'autorité, téléchargez la nouvelle racine dans le tableau de bord et remplacez
  `deploy/supabase-ca.crt` par un commit dans le dépôt (jamais de modification directe sur le serveur), puis contrôle 1 ;
- repli temporaire, décidé par l'exploitant : une seule ligne `DATABASE_SSLMODE=no-verify` dans `deploy/.env` (`sudo nano`,
  en remplaçant la ligne existante, ou la question posée par `sudo bash deploy/configure.sh`), puis `sudo bash deploy/install.sh`. La connexion reste chiffrée
  mais le certificat n'est plus vérifié (ancien mode). Retour : `DATABASE_SSLMODE=verify-full`.

Hors kit VPS : `docker run -e DATABASE_SSLMODE=verify-full -e DATABASE_CA_FILE=/etc/rydar/supabase-ca.crt -v "$PWD/deploy/supabase-ca.crt:/etc/rydar/supabase-ca.crt:ro" …`.

### Suivi des vols

Une course avec un numéro de vol est suivie de 24 h avant à 3 h après la prise en charge, tant que le vol n'est ni atterri ni annulé. Elle est vérifiée toutes les 30 min, puis toutes les 5 min à moins de 3 h de la prise en charge. Si le départ de la course est un aéroport (mode « arrivée »), la prise en charge suit le retard du vol. Sinon (le client part en avion), le retard est seulement signalé.

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `FLIGHT_PROVIDER` | auto | `aerodatabox`, `aviationstack`, `flightaware`, `mock` ou `off`. En auto, c'est le premier fournisseur dont la clé est définie, dans cet ordre. Sans clé, c'est `mock` en développement, et **le suivi est désactivé en production** (`NODE_ENV=production`), pour ne jamais inventer de retards sur de vraies courses |
| `AERODATABOX_KEY` | | Clé AeroDataBox |
| `AERODATABOX_MARKETPLACE` | `rapidapi` | `rapidapi` : `https://aerodatabox.p.rapidapi.com`, en-têtes `X-RapidAPI-Key` et `X-RapidAPI-Host`. `apimarket` : `https://prod.api.market/api/v1/aedbx/aerodatabox`, en-tête `x-api-market-key` |
| `AERODATABOX_URL` | | Remplace l'URL de base (proxy) |
| `AVIATIONSTACK_KEY` | | Clé aviationstack, passée en paramètre `access_key` |
| `AVIATIONSTACK_URL` | `https://api.aviationstack.com/v1` | L'offre gratuite n'accepte pas le HTTPS : mettez alors `http://api.aviationstack.com/v1`, ou mieux, prenez une offre payante |
| `AVIATIONSTACK_TIMES` | `local` | aviationstack renvoie l'heure locale de l'aéroport suffixée « +00:00 ». Le worker la convertit avec le fuseau `timezone` de la réponse. `utc` pour prendre les heures telles quelles |
| `FLIGHTAWARE_KEY` | | Clé FlightAware AeroAPI v4 (`https://aeroapi.flightaware.com/aeroapi`, en-tête `x-apikey`) |
| `FLIGHTAWARE_URL` | | Remplace l'URL de base |
| `FLIGHT_MOCK_DELAYS` | | Mock seulement. Exemple : `AF1234=35,EK073=-10,BA304=cancelled` (minutes, avance si négatif, `cancelled` ou `diverted`). Les autres vols ont un retard fixe calculé d'après leur numéro, révélé à moins de 6 h du vol |
| `FLIGHT_BATCH` | 30 | Courses réservées par passage |
| `FLIGHT_CONCURRENCY` | 3 | Requêtes simultanées vers le fournisseur |
| `FLIGHT_TIMEOUT_MS` | 5000 | Délai maximal par requête |
| `FLIGHT_CACHE_MS` | 120000 | Cache par numéro, date et mode : plusieurs courses sur le même vol ne coûtent qu'une requête |

- Une erreur du fournisseur (quota, clé, réseau, délai) est seulement journalisée (`flight lookup failed`). La course revient au créneau suivant, dans 5 ou 30 min. Un vol introuvable n'écrit rien (`flight not found`).
- Volume : environ 40 requêtes par vol suivi dans les 3 h avant la prise en charge, et 2 par heure avant cela. L'offre gratuite d'aviationstack (100 requêtes par mois) ne suffit pas en production.
- Pour choisir le bon tronçon d'un vol à escales, le worker compare les aéroports reconnus dans l'adresse (CDG, ORY, BVA, LBG, NCE…) et l'horaire le plus proche de l'heure demandée.
- Pushs : l'app chauffeur enregistre des **jetons Expo**, donc **Expo Push est la voie supportée** (`EXPO_ACCESS_TOKEN`) :
  - Android : téléversez la clé de compte de service **FCM v1** dans EAS (`eas credentials`) ;
  - iOS : la **clé APNs** (.p8) dans EAS ;
  - production : créez un jeton (expo.dev › réglages du compte › *Access tokens*), renseignez `EXPO_ACCESS_TOKEN`,
    vérifiez qu'un push arrive, **puis** activez *Enhanced Security for Push Notifications* (même page) : Expo refuse
    alors tout envoi sans ce jeton (dans l'ordre inverse, plus aucun push ne part). Les jetons push ne sont lisibles
    par aucun client (migration 004300) et n'apparaissent jamais en entier dans `notifications.last_error` ni dans le
    journal du worker (6 premiers caractères) ;
  - le worker vérifie les accusés de réception Expo (15 s à 5 min après l'envoi) : un jeton `DeviceNotRegistered` est désactivé, et une notification qu'aucun appareil n'a reçue passe en échec ;
  - FCM v1 direct (`FCM_SERVICE_ACCOUNT_B64`) et APNs direct (`APNS_KEY_P8_B64`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`) ne servent qu'à un build spécifique qui enregistre des jetons natifs (provider `fcm` / `apns`) ;
  - chaque envoi est borné dans le temps (10 s par requête FCM ou APNs, 20 s par fournisseur, Expo compris) : un service qui ne répond pas ne bloque plus la file, la notification est réessayée (`PUSH_TIMEOUT`, `APNS_TIMEOUT`).
- Tracés manquants (après une migration ou une panne du routeur) : `node dist/backfill-routes.js --days 30`, avec `OSRM_URL`.

## 4. Stripe

1. Créez un produit par offre (Starter, Pro, Business) avec un prix mensuel et un prix annuel.
2. Renseignez `stripe_price_monthly_id` et `stripe_price_yearly_id` dans la table `plans`, depuis le SQL editor : `update plans set stripe_price_monthly_id = 'price_…' where code = 'pro';`.
3. Webhook vers `/api/stripe/webhook`, avec les événements `customer.subscription.created`, `.updated` et `.deleted`, puis `invoice.finalized`, `invoice.paid` et `invoice.payment_failed`.

## 5. Application chauffeur (EAS)

Publication sur l'App Store et Google Play, fiches, confidentialité, compte de démonstration et mises à jour :
**[docs/STORES.md](STORES.md)**.

```bash
cd apps/driver
eas init                     # renseigne EAS_PROJECT_ID
eas build -p android --profile production
eas build -p ios --profile production
eas submit -p ios
```

| Variable (EAS secrets) | Rôle |
| --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Client Supabase (clé publique) |
| `EXPO_PUBLIC_API_URL` | URL de l'app web (connexion chauffeur protégée) |
| `GOOGLE_MAPS_ANDROID_KEY` | Carte Android (react-native-maps) |
| `EXPO_PUBLIC_MAP_TILES_URL`, `EXPO_PUBLIC_MAP_GLYPHS_URL` | Carte de l'aperçu web uniquement |
| `APP_LINK_DOMAIN` | (optionnel) domaine des liens `https://DOMAINE/rejoindre/{code}` qui ouvrent l'app ; par défaut, celui d'`EXPO_PUBLIC_API_URL` |

La **localisation en arrière-plan** exige un *development build* ou un build de production : elle ne fonctionne pas dans Expo Go. Seule l'autorisation « Pendant l'utilisation » est demandée : app ouverte, le suivi continue en arrière-plan (service de premier plan Android avec la notification « Rydar Drive — EN LIGNE », indicateur de localisation iOS) ; fermer l'app met hors ligne.

Aperçu navigateur (démo) : `pnpm --filter @rydar/driver web`, ou `export:web` pour une version statique.

## 6. Pages légales

Les pages publiques `/mentions-legales`, `/cgu`, `/cgv`, `/confidentialite`, `/cookies`, `/dpa` (accord de
traitement des données) et `/suppression-compte` lisent l'identité de l'éditeur et des hébergeurs dans la base :

- **avant l'ouverture au public**, le Super Admin remplit **`/admin/legal`** (raison sociale, forme, capital, siège,
  RCS, TVA, directeur de la publication, contacts, hébergeur du serveur et des données). Tant qu'un champ manque,
  `/mentions-legales` affiche « à compléter par l'éditeur ». `LEGAL_NAME`, `LEGAL_EMAIL` et `LEGAL_ADDRESS`
  (`deploy/configure.sh`) ne servent que de repli ;
- les textes sont des modèles fidèles au fonctionnement du logiciel (Rydar = éditeur de logiciel, les courses
  appartiennent aux centrales) : **faites-les relire par un juriste** avant l'ouverture ;
- après toute modification importante des textes, changez `LEGAL_VERSION` (valeur commune au site et à l'app
  chauffeur, `packages/shared/src/features.ts`, reprise par `apps/web/lib/legal.ts`) et `LEGAL_UPDATED_AT`
  (`apps/web/lib/legal.ts`). La nouvelle version est alors présentée à tous pour acceptation :
  - tableau de bord : un bandeau (non bloquant) demande à chaque membre, dispatchers compris, d'accepter les CGU et
    la politique de confidentialité ; le propriétaire ou un administrateur accepte en plus, au nom de la centrale,
    les CGV et l'accord de traitement. `/admin/legal` liste les centrales qui n'ont pas encore accepté ;
  - application chauffeur : un écran plein fait accepter les CGU et la politique de confidentialité à chaque
    chauffeur, invité par sa centrale ou inscrit par lien (jamais pendant une offre ou une course ; « J'accepte »
    sans réseau est envoyé dès que possible) ; l'écran de connexion rappelle qu'en se connectant, on les accepte. Les
    règles du fil « Chauffeurs » (CGU § 8), résumées sur cet écran, sont ainsi acceptées avant toute publication dans
    le fil ; à défaut, une feuille « Règles du fil » les fait accepter avant le premier envoi ;
  - **l'app embarque `LEGAL_VERSION`** : après un changement, publiez une mise à jour à distance (EAS Update,
    [STORES.md](STORES.md) § 10), sinon les chauffeurs ne voient pas la nouvelle version ;
- les preuves d'acceptation (`legal_acceptances`) sont en ajout seul : ni modification ni suppression, même en
  service role, et jamais purgées. Un compte supprimé laisse la preuve, détachée du compte (avec l'e-mail du
  signataire pour les CGV et l'accord de traitement) ;
- les durées annoncées par `/confidentialite` (§ 9 et § 10), `/suppression-compte` et `/dpa` (§ 11) sont appliquées
  par le code :
  - `private.housekeeping` (worker, toutes les 5 min ; dernière définition : migration 004800, toute redéfinition
    part de celle-ci) : historique des positions, et position du chauffeur relevée par une alerte close, 30 jours ;
    messages, signalements de la flotte (copie dans le journal comprise) et signalements de messages 180 jours ;
    notifications (90 jours après l'envoi prévu) et journaux d'API 90 jours ; adresse IP et navigateur du journal
    d'audit 1 an ; journal d'audit de Supabase Auth 1 an (§ 1) ; courses 10 ans après la fin de l'année de la prise
    en charge, quel que soit leur statut ; bannissements 3 ans (`private.purge_expired_bans`) ; empreintes d'un
    chauffeur supprimé qui devait des commissions, dès que plus rien n'est dû ;
  - suppression d'un compte chauffeur (`private.delete_driver_account`, migration 004000) : données effacées ou
    anonymisées aussitôt, adresse IP et navigateur de son inscription retirés du journal d'audit, indices en clair
    des empreintes effacés ; bannissements des comptes supprimés depuis 3 ans : `private.purge_deleted_driver_bans`
    (worker, toutes les 6 h) ;
  - jamais purgés : registre des frais plateforme et paiements (immuables), preuves d'acceptation, fiche archivée
    d'une centrale, fiches anonymes « Chauffeur supprimé (#N) ».

  Toute nouvelle durée écrite dans ces pages doit être appliquée par le code ;
- **fin de contrat d'une centrale** (promesse des CGV § 8 et de l'accord de traitement § 11 ; aucun outil de
  fermeture automatique, procédure manuelle du Super Admin) :
  1. ne supprimez jamais la ligne `organizations` : c'est refusé (erreur 23503) dès qu'elle a accepté les conditions
     (`legal_acceptances`, migration 003900) ou qu'elle a des frais plateforme ou des paiements (`platform_fee_entries`,
     `platform_payments` en `on delete restrict`, migration 004200) ; le registre n'a aucun chemin de suppression.
     La centrale s'**archive** (étape 3) ;
  2. export, si la centrale l'a demandé avant la fin : Supabase › *SQL Editor*, une requête par table filtrée sur
     `organization_id` (`rides`, `drivers`, `vehicles`, `ride_settlements`…), résultat exporté en CSV et transmis
     par un moyen sûr (lien à durée limitée, jamais en clair par e-mail). Le relevé des frais plateforme s'exporte
     depuis le tableau de bord (Encaissements) ;
  3. archivage (`/admin/organizations`, fiche de la centrale › « Archiver ») : plus aucun accès au tableau de bord, à
     l'app, au mini-site ni à l'API ;
  4. sous 30 jours, suppression des données traitées pour son compte : chaque chauffeur dans `/admin/suppressions`
     (jamais en SQL : l'outil supprime aussi ses justificatifs, leur dossier de stockage et son compte de
     connexion) ; puis ses courses (journal, offres, alertes et règlements partent avec elles ; le registre des
     frais garde ses écritures), messages, mini-site (`booking_sites`), moyens de paiement proposés aux chauffeurs
     (colonnes `settlement_link`, `settlement_payee_name`, `settlement_iban`, `settlement_bic` et
     `settlement_instructions` d'`organization_settings`, remises à vide), adhésions de l'équipe et comptes de
     connexion qui ne servent à aucune autre centrale, journal d'audit de la centrale (sauf les lignes
     `platform_fee.*` et `platform_payment.*`, qui accompagnent le registre) ;
  5. restent : la fiche archivée, l'abonnement et ses factures, le registre des frais et les paiements avec leurs
     lignes d'audit (10 ans au moins, obligations comptables) et les preuves d'acceptation.

## 7. Checklist de mise en production

- [ ] Migrations appliquées, seed **non** chargé, inscriptions publiques désactivées
- [ ] Auth : code e-mail à 8 chiffres, validité 3600 s (§ 1)
- [ ] Pushs : `EXPO_ACCESS_TOKEN` renseigné, puis *Enhanced Security for Push Notifications* activée chez Expo (§ 3)
- [ ] Realtime : *Allow public access* désactivé (canaux privés uniquement)
- [ ] Premier Super Admin créé, offres Stripe reliées
- [ ] `API_KEY_PEPPER` long et secret, `SUPABASE_SERVICE_ROLE_KEY` uniquement côté serveur
- [ ] `REDIS_URL` configuré (sinon le rate limiting reste en mémoire, instance par instance)
- [ ] OSRM auto-hébergé (ou Mapbox / Google) à la place du serveur de démo
- [ ] Worker déployé (connexion directe) et healthcheck surveillé
- [ ] Worker : `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` transmis (journal de démarrage `"accountDeletions":"on"`).
      Sinon : erreur `account deletions cannot be completed` dans le journal du worker et suppressions « en retard »
      sur `/admin/suppressions`
- [ ] Contact « données personnelles » renseigné dans `/admin/legal` ; demandes de suppression reçues par e-mail
      traitées dans `/admin/suppressions` sous 30 jours ([STORES.md](STORES.md) § 11)
- [ ] Domaine wildcard pour les mini-sites, domaines personnalisés ajoutés
- [ ] Builds EAS signés, pushs testés sur un vrai téléphone Android et un vrai iPhone
- [ ] `/admin/legal` rempli (aucun « à compléter par l'éditeur » sur `/mentions-legales`), textes légaux relus par un juriste
