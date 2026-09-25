# Rydar Drive — mémoire projet (compacte, à tenir à jour)

SaaS dispatch VTC multi-tenant. Acteurs : super admin, rattacheur (org), chauffeur. **Aucun compte/app client.**
Sources de course : dashboard rattacheur | API `POST /api/v1/rides` (API key → org) | mini-site `/book/[slug]` (option).

## Stack / layout (pnpm workspaces)
- `apps/web` Next 16 App Router, TS, Tailwind v4, composants shadcn-like maison (`components/ui`), MapLibre (style dark CARTO, env `NEXT_PUBLIC_MAP_STYLE_URL`), Supabase SSR.
- `apps/driver` Expo 57 + expo-router, expo-location (bg task), expo-notifications (canal `ride-offers-v2`, sonnerie 10 s `ride_offer_v2.wav`, action ACCEPTER), entrée `index.ts` (tâche GPS définie avant expo-router).
- `apps/worker` Node : outbox `notifications` → push (Expo/FCM/APNs), `dispatch_tick()` (vagues/timeout/escalade planifiées), rappels, ménage.
- `packages/shared` (`@rydar/shared`) : statuts, transitions, zod schemas, catégories, format FR.
- `supabase/migrations` SQL (source de vérité), `supabase/seed.sql`, `tests/db` (vitest + pg réel).
- TypeScript pin 5.9 (TS7 natif incompatible outils). zod 4, React 19.3, maplibre 6, recharts 3.

## Décisions clés
- Tenant = `organization_id` sur toutes tables métier. RLS partout + trigger `private.forbid_org_change` (org_id immuable → 42501).
- Helpers RLS dans schéma `private` (SECURITY DEFINER, search_path=''): `is_super_admin()`, `is_org_member(org)`, `has_org_role(org, roles[])`, `current_driver_id()`.
- Super admin : lecture via RLS, écritures via routes serveur (service role) + audit_logs.
- Écritures sensibles via RPC (status, assign, cancel, accept, location) ; colonnes UPDATE restreintes par GRANT.
- Dispatch en PL/pgSQL : trigger AFTER INSERT rides → `private.start_dispatch`. Instantané = pickup_at ≤ now + `instant_threshold_minutes`.
  Instantané : vagues rayons `dispatch_radii_m` {4000,8000,12000,16000} (migr. 1500), `offer_timeout_seconds`, ST_DWithin sur `driver_locations.location` (geography), filtres org + presence='available' + position fraîche + catégorie compatible + places.
  Planifiée : offre à toute la flotte compatible ; si non attribuée à T-`scheduled_dispatch_lead_minutes` → bascule dispatch géo. Rappels {1440,180,60,30} min → notifications planifiées.
- Accept atomique `accept_ride_offer(offer_id)` : `SELECT … FOR UPDATE` ride + CAS (`driver_id is null and status in (SEARCHING_DRIVER,OFFERED)`) + index unique partiel `ride_assignments(ride_id) where is_active`. Perdant → `RIDE_ALREADY_ASSIGNED` « Course déjà attribuée. »
- Journal : `ride_events` (category timeline|dispatch, level, message FR, data jsonb). `ride_status_history` via trigger.
- Temps réel : `realtime.send()` broadcast privé, topics `org:{id}` et `driver:{id}` ; RLS sur `realtime.messages`.
- API keys : `rdk_live_{prefix8}_{secret}` ; stocké prefix + sha256(pepper+key) ; rate limit Redis (fallback mémoire) ; `api_logs`.
- Presence chauffeur : offline|available|offered|en_route|arrived|on_trip (maintenue par fonctions SQL).
- Catégories : standard, business, first, van, green ; upgrade optionnel (`allow_category_upgrade`).
- Plans STARTER/PRO/BUSINESS : limites jsonb, appliquées par triggers SQL (`private.enforce_plan_limit`).

## Design
Sombre premium « radar ». bg #07080B, surfaces #0C0E12/#12151B/#191D25, texte #F4F5F7, muted #8B93A1.
Accent marque lime `--brand`. Statuts : available lime, offered amber #FFB020, en_route blue #4C9DFF, arrived violet #A78BFA, on_trip cyan #22D3EE, offline #5B6270, erreur #FF4D4F.
Fonts Geist + Geist Mono (chiffres). Carte centrale (dashboard = command center).

## Local
- Stack Supabase sans Docker : `bash scripts/local-stack/setup.sh` puis `start.sh` (GoTrue 54332, PostgREST 54331, passerelle 54321) ; clés → `apps/web/.env.local`.
- Dev web : `cd apps/web && npx next dev` ; captures Playwright : scripts scratchpad `shot.cjs` (LOGIN=email:mdp), `final.cjs` (docs/screenshots), `driver-flow.cjs` (app chauffeur :8081).
- ⚠️ Ne jamais `pkill -f <motif>` si le motif apparaît dans la commande en cours (tue le shell) → scratchpad `sim.sh start|stop`.
- Sandbox : tuiles/geocodage/routage externes bloqués (seuls npm, pypi, raw.githubusercontent, GitHub releases, S3 Overture passent) → dev-geo local (voir M11).
- Tailwind v4 : classes custom = `@utility` (sinon pas de variantes `lg:`). MapLibre v6 ESM : worker copié dans public/vendor (predev).
- PG16+PostGIS local : `pg_ctlcluster 16 main start` ; Redis `redis-server --daemonize yes`.
- Tests DB : `pnpm test:db` (crée DB `rydar_test`, applique `scripts/sql/local-supabase-stubs.sql` + migrations).

## Avancement (cocher au fil de l'eau)
- [x] M0 scaffold monorepo
- [x] M1 DB : 9 migrations + seed + 32 tests verts (`pnpm test:db`)
- [x] M2 shared (tests `pnpm test`)
- [x] M3 web socle + command center (`apps/web/components/command`, carte `components/map/fleet-map.tsx`)
- [x] M4 super admin (`apps/web/app/admin`)
- [x] M5 rattacheur (toutes pages)
- [x] M6 API v1 (`apps/web/lib/api/v1.ts`, testée curl 201/200/403/401/422/429) + mini-site `/book/[slug]`
- [x] M7 worker (`apps/worker` : tick, outbox push Expo/FCM/APNs, simulateur `SIM_ORG=elite-paris SIM_NEW_RIDE_EVERY=20 npx tsx src/simulator.ts`)
- [x] M8 app chauffeur (`apps/driver`, Expo 57 / RN 0.86 / React 19.2.3 partout ; `npx expo export --platform android` OK)
- [x] M9 Stripe (checkout/portal/webhook)
- [x] M10 docs (README, docs/ARCHITECTURE|API|SECURITY), CI GitHub verte (3 jobs), 63 tests DB, révocation sessions (mig 001300)
- [x] Audit géoloc/notifs/dispatch : vagues cumulatives (migr. 1700), flotte re-balayée toutes les 5 min (1800), géocodage API avec seuil de confiance (`lib/geocode.ts`, `lib/geo/anchor.ts`), alertes dashboard son + navigateur (`components/alerts`), relais Realtime local (`scripts/local-stack/realtime.mjs`)
- [x] M11 REFONTE (demande utilisateur : épuré, vraie carte, géoloc + calculs, visuels partout, app chauffeur « waw »)
  - géo serveur : `apps/web/lib/geocode.ts` (geopf|ban|google|mapbox, GEOCODER_URL), `lib/geo/routing.ts` (osrm|mapbox|google + repli), `lib/geo/quote.ts`
  - API : /api/quote (dashboard), /api/route, /api/geocode/reverse, /api/book/[slug]/quote (public) ; rides.route_polyline (mig 001400)
  - forfaits : `matchFixedFare` (@rydar/shared/pricing) → devis, mini-site, API sans prix
  - carte : style Rydar (@rydar/shared/map-style, OpenMapTiles/OpenFreeMap), `components/map/{use-maplibre,fleet-map,route-preview,markers}`, thème jour/nuit
  - web : command center (ride-focus, fleet-panel, ride-row, kpi-strip), nouvelle course = WorkspaceContent + RoutePreview, RideProgress, RouteGlyph
  - app chauffeur : home carte plein écran, offre, course (SlideToConfirm, StepDots), `rydar-map(.web).tsx` ; aperçu web `pnpm --filter @rydar/driver web`
  - worker : simulateur sur itinéraires OSRM, `backfill-routes`
  - dev-geo : `scripts/dev-geo/` (tuiles OMT Overture, router :5001, géocodeur :5002) ; env dev dans apps/web/.env.local
- [x] docs/DEPLOYMENT.md + captures docs/screenshots/*.jpg

## Notes / prochaines étapes
- Seed : bypass via GUC `rydar.bypass_ride_rules=on` (connexion directe seulement). Comptes démo en tête de `supabase/seed.sql`.
- Toute nouvelle fonction SQL : revoke/grant explicites (cf. 0900). `api_key_secrets` = service_role only.
- RPC chauffeur : accept_ride_offer, decline_ride_offer, driver_update_ride_status, driver_set_online, update_driver_location, driver_register_device, driver_home, driver_offers.
- RPC dashboard : cancel_ride, assign_ride, redispatch_ride, org_kpis, org_stats, driver_stats, org_usage, platform_overview ; svc_cancel_ride (service_role).
- Worker (connexion directe PG) : private.dispatch_tick(), private.claim_notifications(n), private.housekeeping() ; LISTEN rydar_notifications.
