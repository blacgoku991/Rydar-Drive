# Rydar Drive — mémoire projet (compacte, à tenir à jour)

SaaS dispatch VTC multi-tenant. Acteurs : super admin, rattacheur (org), chauffeur. **Aucun compte/app client.**
Sources de course : dashboard rattacheur | API `POST /api/v1/rides` (API key → org) | mini-site `/book/[slug]` (option).

## Stack / layout (pnpm workspaces)
- `apps/web` Next 16 App Router, TS, Tailwind v4, composants shadcn-like maison (`components/ui`), MapLibre (style dark CARTO, env `NEXT_PUBLIC_MAP_STYLE_URL`), Supabase SSR.
- `apps/driver` Expo 57 + expo-router, expo-location (bg task), expo-notifications (canal `ride-offers`, action ACCEPTER).
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
  Instantané : vagues rayons `dispatch_radii_m` {3000,5000,8000,12000}, `offer_timeout_seconds`, ST_DWithin sur `driver_locations.location` (geography), filtres org + presence='available' + position fraîche + catégorie compatible + places.
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
- PG16+PostGIS local : `pg_ctlcluster 16 main start` ; Redis `redis-server --daemonize yes`.
- Tests DB : `pnpm test:db` (crée DB `rydar_test`, applique `scripts/sql/local-supabase-stubs.sql` + migrations).

## Avancement (cocher au fil de l'eau)
- [x] M0 scaffold monorepo
- [x] M1 DB : 9 migrations + seed + 32 tests verts (`pnpm test:db`)
- [ ] M2 shared
- [ ] M3 web socle (design system, auth, layouts)
- [ ] M4 super admin
- [ ] M5 rattacheur (command center carte, courses, nouvelle course, chauffeurs, journal, stats, API keys, mini-site, réglages)
- [ ] M6 API v1 + booking site + geocode + rate limit
- [ ] M7 worker
- [ ] M8 app chauffeur
- [ ] M9 Stripe
- [ ] M10 docs + captures + vérif finale

## Notes / prochaines étapes
- Seed : bypass via GUC `rydar.bypass_ride_rules=on` (connexion directe seulement). Comptes démo en tête de `supabase/seed.sql`.
- Toute nouvelle fonction SQL : revoke/grant explicites (cf. 0900). `api_key_secrets` = service_role only.
- RPC chauffeur : accept_ride_offer, decline_ride_offer, driver_update_ride_status, driver_set_online, update_driver_location, driver_register_device, driver_home, driver_offers.
- RPC dashboard : cancel_ride, assign_ride, redispatch_ride, org_kpis, org_stats, driver_stats, org_usage, platform_overview ; svc_cancel_ride (service_role).
- Worker (connexion directe PG) : private.dispatch_tick(), private.claim_notifications(n), private.housekeeping() ; LISTEN rydar_notifications.
