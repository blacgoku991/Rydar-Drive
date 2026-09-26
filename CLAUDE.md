# Rydar Drive — mémoire projet (compacte, à tenir à jour)

**Langue : toujours répondre en français** (réponses, messages d'avancement, résumés, descriptions de commandes).

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
- Offres (plans) FACULTATIVES, créées par le super admin (/admin/plans) ; aucune par défaut en prod (Starter/Pro/Business : démo seed.sql).
  Limites jsonb appliquées par triggers SQL (`private.enforce_plan_limits`) via `private.org_limits` ; sans offre = ni limite ni restriction (mig 002800).

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
- [x] M10 docs (README, docs/ARCHITECTURE|API|SECURITY), CI GitHub verte (3 jobs), révocation sessions (mig 001300)
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
- [x] M12 NOUVEAUTÉS (choix utilisateur 3/6/7/10) — mig 002050→002500, 183 tests DB, 75 unitaires, 55 worker
  - vols 002100 : rides.flight_*, pickup_at_original ; décalage RELATIF (heure demandée + retard), « arrivée + marge » seulement
    sans horaire prévu ou si l'heure demandée précède l'atterrissage ; worker : flights_to_check / apply_flight_status
  - alertes 002200 : ride_alerts (late|stalled|no_gps|not_started), private.watch_rides() 30 s ; la CENTRALE décide :
    acknowledge_ride_alert (Garder), assign_ride (Réattribuer), reassign_ride(ride, reason, expected_driver) (Relancer ;
    DRIVER_CHANGED / UNASSIGNED si dispatch auto off) ; chauffeur retiré = offre closed/removed_by_dispatch (exclu, pas un refus)
  - messagerie 002300 : chat_messages (fil driver:<id> + flotte), signalements (report_type, position, expiration, votes),
    topic realtime fleet:<org> ; send_chat_message, mark_chat_read, chat_overview, driver_chat_overview, vote_fleet_report
  - gains/documents 002400 : driver_earnings, driver_documents, driver_submit_document, review_driver_document,
    org_document_alerts, private.document_reminders() ; commission organization_settings.driver_commission_percent
  - stats 002050 : ride_offers.missed_at (offre géo prolongée/expirée sans réponse = manquée)
  - libellés communs : `@rydar/shared` features.ts (flightBadge, FLEET_REPORT_META, RIDE_ALERT_META, documents)
  - revue SQL (mig 002500 + corrections en place) : fuseau IANA validé, votes anti-abus (OWN_REPORT, 1 min, 3 h max),
    created_at des messages au COMMIT (déclencheur différé), EXPIRY_REQUIRED pour valider une pièce à échéance
  - web : `components/alerts/{dispatch-alerts,ride-alert-ui}`, `components/rides/{flight-info,ride-alert-list}`,
    `/dashboard/messages` + `components/chat/*` (unread-provider), `components/drivers/{driver-documents,driver-earnings}`
  - app : `app/(app)/{messages,earnings,documents}.tsx`, `src/components/{fleet-report,flight}.tsx`, canal fleet:{org}
  - worker : `src/flights/` (aerodatabox|aviationstack|flightaware|mock, FLIGHT_MOCK_DELAYS), watch_rides 30 s,
    document_reminders 6 h, simulateur SIM_REPORTS=1

- [x] M13 OPTION 2 « CENTRALE À COMMISSION » (réseaux WhatsApp/Telegram) — mig 002600, 200 tests DB, 77 unitaires
  - `organizations.dispatch_model` fleet|centrale + `platform_fee_percent/fixed_cents` : super admin seul (service role + audit) ;
    lien d'inscription `join_code/join_enabled/join_auto_approve` via RPC set_join_link (owner/admin)
  - répartition trigger `rides_centrale_split` (commission % + fixe ou saisie `commission_cents`, frais plateforme, `driver_payout_cents`) ;
    PRICE_REQUIRED (dashboard), COMMISSION_TOO_HIGH ; offre + push « Vous gagnez 40 € »
  - `ride_settlements` (trigger `rides_d_settlement` à COMPLETED) : driver_owes (cash/card) | centrale_owes (online/invoice/account) ;
    due→declared→paid | disputed | waived (+ reopen) ; SETTLEMENT_LOCKED ; relances manuelle (30 min) et worker (24 h, 3 max)
  - blocages `private.centrale_blocker` (unpaid | credit_limit | new_driver) dans run_geo_wave / offer_to_fleet / accept (DRIVER_BLOCKED) ;
    trust new→trusted auto (`trust_after_rides`)
  - bans : `banned_identities` (sha256 normalisé, org|platform), `fraud_reports` ; triggers IDENTITY_BANNED / DRIVER_BANNED ;
    appareil d'un banni → compte suspendu / candidature refusée ; ban_driver, lift_driver_ban, svc_platform_ban/unban/dismiss
  - inscription `/rejoindre/{code}` : svc_join_info → svc_identity_check → compte Auth → svc_driver_apply (inactive+pending) →
    approve (aussi « reconsidérer » un refus) / reject ; `driver_account_state()` ; candidat : documents + appareil (current_driver_or_applicant_id)
  - web : `/admin/centrales` (frais, signalements), fiche org (modèle, « Donner un accès »), `/dashboard/settlements` (Encaissements),
    `/dashboard/network` (lien, candidatures, bannis), réglages « Commission & encaissement », répartition dans nouvelle course / fiche /
    command center (`components/settlements/*`, `components/network/*`, `components/admin/*`), alertes temps réel (settlement.updated,
    driver.application, driver.flagged) ; route `api/auth/driver-login` : state active|pending, 403 BANNED|REJECTED|INACTIVE…
  - app : `app/account.tsx` (en attente / refusé / banni / suspendu), `app/(app)/commissions.tsx`, offre « Vous gagnez », fin de course,
    gains « Votre part » ; device id Android = `and-` + ANDROID_ID (bannissement)
  - shared : `centrale.ts` (libellés, lien de paiement {montant}/{montant_centimes}/{reference}, message WhatsApp, schémas) ;
    seed « Centrale Express Paris » contact@centrale-express.fr (tous les états, candidatures, 1 banni signalé), lien express2026demo

- [x] Kit VPS `deploy/` : docker-compose (web standalone `apps/web/Dockerfile`, worker, redis, Caddy HTTPS auto + TLS à la demande
  via `/api/tls/allowed`), `install.sh` (Docker, ufw + port SSH réel, swap, DNS, migrations, build), `migrate.sh` (registre CLI Supabase,
  1 transaction/migration), `configure.sh` (assistant .env : secrets saisis masqués au terminal, vérifiés en direct), `create-admin.sh`
  (Super Admin via API admin), `osrm-prepare.sh`
- **Session Claude sur le VPS de production (`/opt/rydar`) : suivre `deploy/CLAUDE-VPS.md`** (secrets jamais dans le chat, pas de seed,
  pas de code modifié sur le serveur).

## Notes / prochaines étapes
- Seed : bypass via GUC `rydar.bypass_ride_rules=on` (connexion directe seulement). Comptes démo en tête de `supabase/seed.sql`.
- Toute nouvelle fonction SQL : revoke/grant explicites (cf. 0900). `api_key_secrets` = service_role only.
- Données indispensables en production : par MIGRATION, jamais seulement dans seed.sql (jamais chargé en prod).
- Formulaires web : `onSubmit={submitWith(fn)}` (`lib/utils`), jamais `<form action={fn}>` (React 19 vide le formulaire même
  si le serveur répond une erreur) ; erreurs serveur : `fieldErrors(err)` + `describeError(err, LABELS)` (« Champ : message »).
- Supabase hébergé : `postgres` NON super-utilisateur (BYPASSRLS) ; `auth.*`, `storage.*`, `realtime.messages` appartiennent
  aux services → seulement CREATE/DROP POLICY (supautils policy_grants), trigger sur auth.users, DML ; jamais ALTER TABLE/fonction dessus.
- RPC chauffeur : accept_ride_offer, decline_ride_offer, driver_update_ride_status, driver_set_online, update_driver_location, driver_register_device, driver_home, driver_offers ; centrale : driver_settlements, driver_declare_payment, driver_account_state.
- RPC dashboard : cancel_ride, assign_ride, redispatch_ride, reassign_ride, acknowledge_ride_alert, org_kpis, org_stats, driver_stats, org_usage, platform_overview ; svc_cancel_ride (service_role).
  Centrale : org_settlement_overview, org_settlements, confirm/dispute/waive/reopen_settlement, remind_driver_settlements, preview_ride_split,
  ban_driver, lift_driver_ban, lift_identity_ban, set_join_link, approve/reject_driver_application, admin_centrale_overview ;
  service role : svc_join_info, svc_identity_check, svc_driver_apply, svc_platform_ban/unban/dismiss_report.
- Worker (connexion directe PG) : private.dispatch_tick(), private.claim_notifications(n), private.housekeeping(), private.watch_rides(), private.flights_to_check(n)/apply_flight_status(...), private.document_reminders(), private.settlement_reminders() ; LISTEN rydar_notifications.
