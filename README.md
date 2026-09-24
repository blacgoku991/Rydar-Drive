# Rydar Drive

**Le dispatch VTC, sans WhatsApp.** Rydar Drive est un SaaS multi-organisation pour les rattacheurs, centrales VTC et gestionnaires de flottes. Une réservation arrive, par votre site ou votre dashboard. Les chauffeurs de **votre** flotte les plus proches sont notifiés en même temps et **le premier qui accepte obtient la course**. La même course ne peut pas être attribuée deux fois. Vous suivez tout en temps réel.

![Poste de pilotage en direct : carte réelle, vrais itinéraires, flotte](docs/screenshots/dashboard-live.jpg)

| Nouvelle course : trajet, durée, prix (forfait) et chauffeurs proches calculés en direct | Détail d'une course sans quitter la carte |
| --- | --- |
| ![Nouvelle course](docs/screenshots/new-ride.jpg) | ![Course sélectionnée](docs/screenshots/dashboard-ride.jpg) |

![App chauffeur : en ligne, offre avec compte à rebours, course guidée](docs/screenshots/driver-app.jpg)

| Fiche course : étapes horodatées + trajet | Courses (miniature du tracé) | Super Admin |
| --- | --- | --- |
| ![Fiche course](docs/screenshots/ride.jpg) | ![Courses](docs/screenshots/rides.jpg) | ![Super Admin](docs/screenshots/admin.jpg) |

## En bref

- **3 profils seulement** : Super Admin (plateforme), Rattacheur (organisation), Chauffeur. **Aucun compte client**, pas d'application passager : le client final ne se connecte jamais.
- **2 sources de courses**
  1. Le **site du rattacheur**, via `POST /api/v1/rides`. La clé API identifie l'organisation.
  2. La **création manuelle** dans le dashboard (« Nouvelle course » : téléphone, hôtel, conciergerie…).

  En option, un **mini-site de réservation** aux couleurs de l'organisation : `slug.rydar.app` ou domaine personnalisé.
- **Dispatch instantané** : chauffeurs de l'organisation, en ligne, disponibles, de catégorie compatible, à moins de **4 km** (PostGIS `ST_DWithin`). S'il n'y a personne, le rayon s'élargit par vagues **4 → 8 → 12 → 16 km** (configurable). Toutes les offres partent en même temps, avec sonnerie, vibration et bouton ACCEPTER.
- **Acceptation atomique** : verrou transactionnel PostgreSQL et index unique partiel. Les autres chauffeurs reçoivent « Course déjà attribuée. ».
- **Courses planifiées** proposées à la flotte, avec rappels à 24 h, 3 h, 1 h et 30 min.
- **Cycle de vie complet** : `CREATED → SEARCHING_DRIVER → OFFERED → ACCEPTED → DRIVER_EN_ROUTE → DRIVER_ARRIVED → PASSENGER_ONBOARD → IN_PROGRESS → COMPLETED`, plus `CANCELLED` et `NO_DRIVER_FOUND`. Chaque étape est horodatée dans une **timeline** par course.
- **Carte temps réel** : chauffeurs disponibles, course proposée, en route, arrivé, en course, hors ligne. On y voit aussi les vrais itinéraires routiers, l'approche du chauffeur avec son heure d'arrivée, le rayon de recherche et les chauffeurs sollicités. Carte sombre ou claire.
- **Adresses, itinéraires et prix calculés** : autocomplétion d'adresses (IGN/BAN), itinéraire routier réel (OSRM, Mapbox ou Google), distance et durée. Le prix suit la grille de l'organisation, et les **forfaits** (Paris ↔ CDG…) sont reconnus automatiquement. Les chauffeurs disponibles s'affichent avec leur temps d'approche. Tout cela vaut aussi pour l'API et pour le mini-site.
- **Multi-tenant strict** : RLS PostgreSQL sur toutes les tables, contrôles serveur et audit. Une tentative d'accès inter-organisation renvoie **403**.
- **Offres SaaS** Starter, Pro et Business avec limites appliquées en base, abonnement Stripe.

## Architecture

```
                 ┌──────────────────────────┐        ┌─────────────────────────┐
 Site du         │  apps/web  (Next.js 16)  │        │  apps/driver (Expo 57)  │
 rattacheur ───▶ │  • API publique /api/v1  │        │  iOS / Android          │
 (clé API)       │  • Dashboard rattacheur  │        │  EN LIGNE · GPS · offres│
                 │  • Super Admin · mini-site│       └───────────┬─────────────┘
                 └────────────┬─────────────┘                    │ RPC (JWT chauffeur)
                              │ RLS (JWT) / service role         │ + Realtime
                 ┌────────────▼──────────────────────────────────▼─────────────┐
                 │  Supabase : PostgreSQL 16 + PostGIS · Auth · Realtime · Storage│
                 │  Moteur de dispatch en PL/pgSQL (vagues, verrous, timeline) │
                 │  Outbox notifications ─ pg_notify('rydar_notifications')    │
                 └────────────┬───────────────────────────────────────────────┘
                              │ LISTEN / NOTIFY + SKIP LOCKED
                 ┌────────────▼─────────────┐
                 │  apps/worker (Node)      │── Expo Push / FCM v1 / APNs HTTP/2
                 │  tick dispatch · rappels │
                 └──────────────────────────┘
```

Toute la logique critique (qui voit quoi, qui reçoit quelle offre, qui obtient la course) vit **dans la base de données**. Le web, le worker et l'app chauffeur ne peuvent pas la contourner. Détails : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

| Dossier | Contenu |
| --- | --- |
| `apps/web` | Next.js 16 (App Router, Tailwind v4, Radix, MapLibre, Recharts) : dashboard, Super Admin, API v1, mini-site, Stripe |
| `apps/driver` | Application chauffeur React Native / Expo (expo-router, localisation en arrière-plan, notifications, cartes) |
| `apps/worker` | Worker Node : tick du dispatch, envoi des pushs (Expo / FCM / APNs), ménage, simulateur de flotte |
| `packages/shared` | Domaine partagé : statuts, schémas zod (FR), formatage, géo, tarifs |
| `supabase/` | Migrations SQL (tables, RLS, dispatch, temps réel, limites, audit), seed de démonstration |
| `tests/db` | Tests d'intégration PostgreSQL : isolation, dispatch, concurrence, limites, worker, indicateurs |

## Démarrage rapide (local)

Prérequis : Node 22+, pnpm 10, PostgreSQL 16 avec PostGIS 3. Le CLI Supabase (Docker) est optionnel.

```bash
pnpm install
cp .env.example apps/web/.env.local   # puis compléter
```

**Option A — Supabase CLI (recommandé si Docker est disponible)**

```bash
supabase start          # applique supabase/migrations + seed.sql
# reporter l'URL et les clés affichées dans apps/web/.env.local
pnpm dev                # http://localhost:3000
```

**Option B — sans Docker** (PostgreSQL local, GoTrue et PostgREST en binaires, passerelle Node)

```bash
bash scripts/db-local.sh --reset --seed     # base « rydar » : stubs Supabase + migrations + seed
bash scripts/local-stack/setup.sh           # télécharge GoTrue / PostgREST, génère les clés JWT
bash scripts/local-stack/start.sh           # passerelle http://localhost:54321
pnpm dev
```

**Worker et simulateur de flotte** (dans deux autres terminaux) :

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/rydar PUSH_DRY_RUN=true pnpm dev:worker
SIM_NEW_RIDE_EVERY=30 pnpm --filter @rydar/worker simulate    # chauffeurs qui roulent, acceptent, terminent
```

**App chauffeur** : `cp apps/driver/.env.example apps/driver/.env`, puis `pnpm dev:driver` (Expo), ou `pnpm --filter @rydar/driver web` pour l'aperçu navigateur. Voir [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#5-application-chauffeur-eas).

**Carte, adresses et itinéraires en local, avec de vraies données** (facultatif, hors ligne) : `bash scripts/dev-geo/build.sh && bash scripts/dev-geo/start.sh`. Ces scripts génèrent, à partir d'Overture Maps (Paris et Nice), des tuiles au schéma OpenMapTiles, un routeur compatible OSRM et un géocodeur compatible BAN. Voir [scripts/dev-geo/README.md](scripts/dev-geo/README.md).

### Comptes de démonstration (seed)

| Profil | Identifiant | Mot de passe |
| --- | --- | --- |
| Super Admin | `admin@rydar.app` | `Rydar!Admin2026` |
| Rattacheur « Élite Chauffeurs Paris » (Business) | `direction@elite-paris.fr` · `dispatch@elite-paris.fr` | `Rydar!Demo2026` |
| Rattacheur « Riviera Prestige VTC » (Starter) | `contact@riviera-prestige.fr` | `Rydar!Demo2026` |
| Chauffeurs (19, Paris & Nice) | voir la page Chauffeurs du dashboard | `Rydar!Driver2026` |

> Ces comptes n'existent que dans le seed local. Ne chargez jamais `seed.sql` en production.

## Tests

```bash
pnpm test         # tests unitaires (domaine, clés API, worker)
pnpm test:db      # tests PostgreSQL : recrée une base vierge (stubs + migrations) à chaque run
pnpm typecheck    # shared, web, worker, app chauffeur
```

Les tests `tests/db` prouvent notamment :

- **isolation** : le rattacheur A ne lit ni ne modifie rien de B. Changer `organization_id` est refusé en 42501, soit 403 côté API.
- **dispatch** : seuls les chauffeurs éligibles à moins de 4 km reçoivent l'offre, les vagues s'élargissent, `NO_DRIVER_FOUND` à l'échéance.
- **concurrence** : 10 chauffeurs acceptent en même temps et **un seul** obtient la course.
- **limites des offres, rôles, audit, file de notifications, indicateurs**.

La CI (`.github/workflows/ci.yml`) exécute tout cela sur PostGIS. Elle compile aussi le web et le worker, puis construit et démarre l'image Docker du worker.

## Documentation

- [Architecture et moteur de dispatch](docs/ARCHITECTURE.md)
- [API publique v1 et mini-site](docs/API.md)
- [Sécurité et multi-tenant](docs/SECURITY.md)
- [Déploiement (Supabase, Vercel, worker, Stripe, push, EAS)](docs/DEPLOYMENT.md)
