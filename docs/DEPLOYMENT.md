# Déploiement

Architecture cible :

- **Supabase** : base de données, authentification, temps réel, stockage.
- **Vercel** (ou tout hébergeur Node) : application web.
- **Worker** Node en conteneur (Fly.io, Render, Railway, Scaleway…).
- **Redis** managé.
- **Stripe**.
- **EAS** : builds de l'app chauffeur.

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
4. **Realtime** : laissez l'option *private channels* activée. La policy `rydar_realtime_receive` (migration 0600) gère les droits d'écoute des canaux `org:*` et `driver:*`.
5. **Storage** : les buckets `org-assets`, `driver-photos` et `driver-documents` et leurs policies sont créés par la migration 0800.
6. Créez le premier **Super Admin** : invitez l'utilisateur depuis le dashboard Supabase, puis exécutez `update public.users set is_super_admin = true where email = '…';` dans le SQL editor.

> Les migrations sont testées en CI sur PostgreSQL 16 + PostGIS, avec des stubs des schémas Supabase (`scripts/sql/local-supabase-stubs.sql`). Elles utilisent uniquement des API Supabase standard : `auth.uid()`, `auth.jwt()`, `realtime.send()` et `storage.buckets`.

## 2. Application web (Vercel)

- Projet racine `apps/web`, framework Next.js. Commande de build : `pnpm --filter @rydar/web build`, installation depuis la racine du monorepo.
- Domaines :
  - `app.votre-domaine` pour le dashboard ;
  - `*.votre-domaine` (wildcard) pour les mini-sites `{slug}.votre-domaine` ;
  - les domaines personnalisés des organisations Business, ajoutés dans Vercel.

| Variable | Rôle |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Client Supabase (clé **publique**) |
| `SUPABASE_SERVICE_ROLE_KEY` | Serveur uniquement : API v1, administration |
| `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_ROOT_DOMAIN` | URL publique, domaine des mini-sites |
| `API_KEY_PEPPER` | Poivre HMAC des clés API, 32 caractères aléatoires ou plus. Le changer invalide toutes les clés |
| `REDIS_URL` | Rate limiting et anti brute force partagés (Upstash, Redis Cloud…) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Abonnements. Webhook : `https://app…/api/stripe/webhook` |
| `DRIVER_APP_ORIGINS` | (optionnel) origines autorisées à appeler `/api/auth/driver-login` depuis un navigateur |

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
           -e EXPO_ACCESS_TOKEN=… rydar-worker
```

- `DATABASE_URL` doit être une **connexion directe** (port 5432) et non le pooler transactionnel : le worker utilise `LISTEN/NOTIFY`.
- Vous pouvez lancer plusieurs instances : les tâches sont réparties par `FOR UPDATE SKIP LOCKED`.
- Healthcheck : `GET :8080/` renvoie `{"healthy":true,…}`.
- Pushs : l'app chauffeur enregistre des **jetons Expo**, donc **Expo Push est la voie supportée** (`EXPO_ACCESS_TOKEN`) :
  - Android : téléversez la clé de compte de service **FCM v1** dans EAS (`eas credentials`) ;
  - iOS : la **clé APNs** (.p8) dans EAS ;
  - le worker vérifie les accusés de réception Expo (15 s à 5 min après l'envoi) : un jeton `DeviceNotRegistered` est désactivé, et une notification qu'aucun appareil n'a reçue passe en échec ;
  - FCM v1 direct (`FCM_SERVICE_ACCOUNT_B64`) et APNs direct (`APNS_KEY_P8_B64`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`) ne servent qu'à un build spécifique qui enregistre des jetons natifs (provider `fcm` / `apns`).
- Tracés manquants (après une migration ou une panne du routeur) : `node dist/backfill-routes.js --days 30`, avec `OSRM_URL`.

## 4. Stripe

1. Créez un produit par offre (Starter, Pro, Business) avec un prix mensuel et un prix annuel.
2. Renseignez `stripe_price_monthly_id` et `stripe_price_yearly_id` dans la table `plans`, depuis le SQL editor : `update plans set stripe_price_monthly_id = 'price_…' where code = 'pro';`.
3. Webhook vers `/api/stripe/webhook`, avec les événements `customer.subscription.created`, `.updated` et `.deleted`, puis `invoice.finalized`, `invoice.paid` et `invoice.payment_failed`.

## 5. Application chauffeur (EAS)

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

La **localisation en arrière-plan** exige un *development build* ou un build de production : elle ne fonctionne pas dans Expo Go. Sur Android, une notification de service au premier plan indique que le chauffeur est EN LIGNE. Sur iOS, l'autorisation « Toujours » est demandée au premier passage en ligne.

Aperçu navigateur (démo) : `pnpm --filter @rydar/driver web`, ou `export:web` pour une version statique.

## 6. Checklist de mise en production

- [ ] Migrations appliquées, seed **non** chargé, inscriptions publiques désactivées
- [ ] Premier Super Admin créé, offres Stripe reliées
- [ ] `API_KEY_PEPPER` long et secret, `SUPABASE_SERVICE_ROLE_KEY` uniquement côté serveur
- [ ] `REDIS_URL` configuré (sinon le rate limiting reste en mémoire, instance par instance)
- [ ] OSRM auto-hébergé (ou Mapbox / Google) à la place du serveur de démo
- [ ] Worker déployé (connexion directe) et healthcheck surveillé
- [ ] Domaine wildcard pour les mini-sites, domaines personnalisés ajoutés
- [ ] Builds EAS signés, pushs testés sur un vrai téléphone Android et un vrai iPhone
