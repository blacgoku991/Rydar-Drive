# Rydar Drive — historique détaillé (ancien CLAUDE.md, archivé le 27/09/2026)

> Non chargé automatiquement : à lire seulement pour le détail d'un jalon, d'une migration ou d'une liste de RPC.
> Le CLAUDE.md compact à la racine fait foi pour les règles.

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
  Instantané : vagues rayons `dispatch_radii_m` {4000,8000,12000,16000} (migr. 1500), `offer_timeout_seconds`, ST_DWithin sur `driver_locations.location` (geography), filtres org + presence='available' + position fraîche (`private.dispatch_location_window`) + catégorie compatible + places.
  STRICT (mig 003200) : une vague par délai même vide ; relance `dispatch_retry_radii_m` {4000,8000} (sans réponse re-sonnés « COURSE TOUJOURS DISPONIBLE ») ; fin de séquence → NO_DRIVER_FOUND + `dispatch.no_driver` + explication ; `max_search_seconds` inutilisé.
  Position en direct seulement (mig 003300 : fenêtre = location_max_age_seconds) ; app fermée → hors ligne (003400).
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
- [x] Retours terrain (sept. 2026) :
  - dispatch : Berline par défaut (nouvelle course, devis, fiche chauffeur ; Business par défaut excluait les Berline) ;
    compteurs « N dispo. » par catégorie dans le formulaire ; mig 002900 `dispatch.excluded` (chronologie : chauffeurs en ligne
    non sollicités + raison) ; durcissement auth (emailSchema max 254, clés de limitation hachées, `rateLimitAll` IP→compte,
    `ipFromHeaders` : X-Forwarded-For d'abord, Caddy impose X-Real-IP et retire CF-Connecting-IP)
  - app chauffeur : GPS partagé (`use-my-position.ts`, BestForNavigation, filtre des points imprécis), cercle de précision
    accroché à la position, suivi + « Recentrer », carte à plat ; en ligne/hors ligne OPTIMISTE (seul l'appel serveur est
    attendu, suivi GPS sans attendre de premier point) ; rechargements regroupés (`refresh` une seule à la fois) ; effets
    liés à `userId` (pas à l'objet session) ; session chiffrée en cache mémoire
  - mot de passe oublié chauffeur : API `/api/auth/driver-password-reset` (réponse neutre, `after()`, flux implicite) → code
    à 6 chiffres dans l'app (`/confirm`, verifyOtp recovery) ou lien `/auth/set-password?app=driver` (client isolé sans cookie)
  - guidage DANS l'app (Waze / Plans restent proposés) : `POST /api/driver/route` (Bearer jeton du chauffeur, fiche drivers
    via RLS, 30/min) → tracé + étapes FR (`computeNavRoute` osrm|mapbox|google, repli estimation = pas de guidage) ;
    `@rydar/shared` navigation.ts (navInstruction, buildNavTrack, locateOnTrack, nextManeuver, remainingTrack, maneuverGlyph) ;
    app `hooks/use-navigation.ts` (recalcul après 2 points à > 40 m du tracé, 10 s min, rafraîchi 3 min) +
    `components/nav-banner.tsx` ; `RydarMap navigation` (suit le chauffeur, carte orientée cap, zoom selon la vitesse ; iOS : la
    flèche tourne de cap − orientation carte) + `routeMuted` (trajet client en pointillé pendant l'approche)
  - glissières (SlideToConfirm) : `fullScreenGestureEnabled: false` sur les piles (iOS 26 : sinon tout glissement vers la
    droite = retour) + `gestureEnabled: false` sur l'écran course ; PanResponder qui ne cède pas le geste
  - À FAIRE (demandé « par la suite ») : code e-mail à l'inscription par lien (OTP GoTrue : createUser email_confirm:false +
    resend signup, verifyOtp type email ; `drivers.email_verified_at` + trigger sur auth.users ; modèle « Confirm signup » avec {{ .Token }})
- [x] M14 FRAIS PLATEFORME (reversement centrale → Rydar, mig 003000 + 003100 corrections de la revue, 19 tests
  `tests/db/platform-fees.test.ts`) — règles d'argent :
  - frais DUS PAR LA CENTRALE dès la fin de course (trigger `rides_e_platform_fee` → `private.sync_platform_fee`), même si la centrale
    annule / conteste le règlement chauffeur ; registre IMMUABLE `platform_fee_entries` (ride | correction | adjustment, trigger
    `platform_entry_guard`) : changement de frais = écriture de correction (delta) ; BAISSE = `pending` (compte seulement si le super admin
    l'accepte, `svc_platform_review_entry`) ; rattrapage des courses déjà terminées dans la migration
  - `platform_payments` : centrale (owner/admin, même suspendue) `declare_platform_payment` / `cancel_platform_payment` ; super admin (service role,
    `svc_platform_*`, p_actor super admin vérifié, audit_logs écrit en SQL) confirme (montant REÇU, partiel possible), refuse (motif), rouvre,
    saisit un paiement, avoir / frais ajoutés (`svc_platform_adjust`), relance (`svc_platform_remind`, 1/h), conditions (`svc_platform_terms`),
    coordonnées (`platform_billing`, `svc_platform_billing_update`)
  - solde = Σ posted − Σ reçus ; échéance = fin du cycle (mois / semaine, fuseau org) + `platform_payment_days` (défaut 5) − 1 s ; paiements
    soldent les échéances les plus anciennes (FIFO) ; `private.platform_account(org)` (échu, retard, déclaré, encaissé non reversé,
    chez les chauffeurs, annulé, signaux 0 € / annulées) ; levier `platform_block_after_days` → `PLATFORM_FEES_OVERDUE` (402) à la création de
    course, suspendu par un paiement déclaré en attente
  - lecture : `org_platform_status` (bandeau), `org_platform_account`, `org_platform_statement` (relevé) ; super admin `admin_platform_overview`,
    `admin_platform_account` ; `admin_centrale_overview` borné au mois choisi + dette envers Rydar ; temps réel `platform.updated` (org:{id})
  - 003100 : `private.platform_position` (paiements ET écritures négatives soldent les échéances les plus anciennes), une nouvelle
    correction de prix REMPLACE la baisse en attente (`superseded`), déclaration « J'ai payé » ne suspend le blocage que 7 j (et pas
    dans les 7 j après un refus), rattrapage sans échéance rétroactive (+ réparation), centrale archivée débitrice toujours listée
  - temps réel `platform.updated` : action + identifiants SEULEMENT (canal org:{id} lisible par les dispatchers) → les écrans relisent
    le détail par `org_platform_account` (owner/admin) ou la RLS super admin ; une migration publiée ne se modifie plus (corrections
    dans une nouvelle migration : le VPS a pu l'appliquer)
  - shared `platform-fees.ts` (types, libellés, schémas, `platformEntryStatusMeta`) ; web : Encaissements (carte Rydar, J'ai payé,
    relevé + CSV), bandeau (`components/platform-fees/org-*`), /suspended, alertes ; `/admin/frais` (+ `/admin/frais/[id]`, CSV,
    `components/platform-fees/admin-*`), colonne « Dû à Rydar » dans /admin/centrales ; seed : paiements démo Centrale Express
  - exports CSV : UTF-8 BOM, « ; », cellules commençant par = + - @ préfixées d'une apostrophe (injection de formules)
- [x] Super admin : effectifs partout (/admin) + carte en direct des chauffeurs en ligne par organisation (`/admin/carte`, `/api/admin/live`)
- [x] App chauffeur : guidage dans l'app (voir Retours terrain) ; véhicule accroché au tracé (`snapToTrack`) ; sens du véhicule sur le point
  (faisceau hors guidage, flèche en guidage, boussole à l'arrêt `watchHeadingAsync`)
- [x] Dispatch strict (mig 003200) + position EN DIRECT (mig 003300 → 003400), 233 tests DB : vagues 4→8→12→16 km une par
  délai, relance 4→8 km, alerte « personne n'a pris » ; dispatch sur position fraîche SEULEMENT (`location_max_age_seconds`).
  RÈGLE UTILISATEUR : app OUVERTE (arrière-plan, verrouillé, autre app) = en ligne + GPS en direct ; app FERMÉE = hors ligne,
  sans notification. `private.watch_driver_gps()` (worker 30 s) : ni position ni `driver_heartbeat()` depuis 3 min → offline
  (15 min si app < 1.1.0, `driver_devices.app_version` ; jamais en course) ; fraîcheur ≥ 2 min ; housekeeping ne met plus jamais hors ligne ; réveils silencieux / « POSITION NON REÇUE » abandonnés
  (colonnes gps_* supprimées). App `location.ts` : trackingState on/off/unknown (relance sans interface = arrêt), battement
  porté par la tâche GPS + heartbeat sans point, jamais de point > 2 min, arrêt si presence=offline ou SIGNED_OUT,
  `killServiceOnDestroy: true` ; `supabase.ts` : écriture de session en 3 temps (clé .next), délai 20 s (hors storage) ;
  `api.ts` rpc : nouvel essai après JWT expiré ; Android : conseil batterie « Non restreinte » (`lib/battery.ts`).
  Revue 003200 corrigée dans 003300 (audit, relance après « Relancer », refus tardif).
- [x] Publication stores (mig 003500, 238 tests DB) : suppression du compte dans l'app (`app/delete-account.tsx`, route
  `/api/driver/delete-account` → `svc_delete_driver_account` : données perso supprimées, fiche anonymisée, courses/règlements
  gardés sans identité, refus si course attribuée, compte Auth conservé s'il gère une centrale) ; pages publiques `/confidentialite`
  et `/suppression-compte` (LEGAL_NAME/EMAIL/ADDRESS, configure.sh) ; `/.well-known/assetlinks.json` (ANDROID_CERT_SHA256) ;
  EAS Update (runtimeVersion = version, `eas update --channel production`) ; eas.json submit ; iOS UIBackgroundModes = location
  seul ; Android SANS ACCESS_BACKGROUND_LOCATION ni exemption batterie (service de premier plan) ; « Toujours » jamais demandé ;
  information préalable avant la 1re demande de position. Guide : docs/STORES.md.
- [x] M15 RELANCES WHATSAPP + MOYENS DE PAIEMENT (mig 003600 canal `whatsapp`, 003700, 003800 ; 246 tests DB, `tests/db/whatsapp.test.ts`)
  - API officielle WhatsApp Business Cloud (Meta), modèles « Utilité » fr : `rappel_commission` (4 variables) et
    `rappel_frais_plateforme` (3 variables), textes dans `@rydar/shared` WHATSAPP_TEMPLATES et docs/WHATSAPP.md ; jamais d'outil non officiel
  - centrale → chauffeurs : `organization_settings.reminder_channels` {app}|{whatsapp}|{app,whatsapp} ; `private.remind_driver` (WhatsApp
    impossible → push) ; `remind_driver_settlements(p_driver_id, p_channels default null)`, `private.settlement_reminders` idem
  - Rydar → propriétaire : `svc_platform_remind(p_org, p_actor, p_note, p_whatsapp default false)` (refus AVANT de consommer la limite
    d'1/h si WhatsApp impossible), destinataire `private.platform_whatsapp_target` (users.phone du owner sinon organizations.phone),
    `admin_platform_whatsapp(org)` (case de la relance)
  - config : `org_whatsapp` / `platform_whatsapp` (RLS owner/admin | super admin), jetons dans `*_whatsapp_secrets` (service role SEUL) ;
    écriture `svc_whatsapp_save|remove|record` (web, après vérification Graph `lib/whatsapp.ts`) ; file `notifications` canal whatsapp →
    worker `src/whatsapp.ts` (`private.claim_whatsapp` / `private.complete_whatsapp` : reprises, état expéditeur, repli push `data.fallback`)
  - web : Réglages › Commission & encaissement › « Relances des chauffeurs » (`components/settlements/reminder-settings.tsx`,
    `components/whatsapp/whatsapp-card.tsx`), /admin/frais « WhatsApp de Rydar » + case dans Relancer
  - moyens de paiement centrale : lien | virement (organization_settings.settlement_payee_name/iban/bic, IBAN vérifié mod 97
    `isValidIban`) | espèces | autre (instructions) ; `private.settlement_methods_available` = cochés ET renseignés (repli espèces) ;
    `driver_settlements.pay.bank` ; app Commissions : RIB copiable ; Rydar garde ses moyens dans platform_billing (/admin/frais)
- **Design app chauffeur (sobre, « pas IA »)** : jetons `theme.ts` (type, weight ≤ 700, radius, space, control, alpha, overlay) ;
  aucun emoji (FLEET_REPORT_META.ionicon dans l'app, .emoji seulement pour le web), aucune animation décorative en boucle, pas de
  lueur/dégradé/flou décoratif, pas de pastille d'icône teintée ; couleur = information ; casse normale ; « Course 1692 » ;
  espace insécable avant ? : ; ! ; cibles ≥ 48 px (56 en conduite) ; texte d'information en `muted`, jamais `subtle`.
- **Carte chauffeur (`components/map/follow.ts`)** : un geste suspend le suivi le temps du geste (contacts RN sur le
  MapView + mouvements de la carte, classe `MapGestures`) ; chauffeur resté près du centre → suivi gardé (zoom,
  orientation) ; carte déplacée ailleurs → « Recentrer » + retour auto après 10 s en roulant ; rotation à deux doigts
  partout, boussole hors guidage (flèche iOS = cap − orientation de la carte).
- **Session Claude sur le VPS de production (`/opt/rydar`) : suivre `deploy/CLAUDE-VPS.md`** (secrets jamais dans le chat, pas de seed,
  pas de code modifié sur le serveur).
- [x] **Audit de sécurité maximal (09/2026, `docs/AUDIT.md`)** : 21 auditeurs → 170 constats → contre-expertise (0 réfuté) →
  129 défauts distincts (7 hauts, 31 moyens, 91 bas) corrigés en copies isolées (migrations 004300–005300), contre-audit
  (32 points, tour 2 : 005400–005600), bout en bout Chromium (9 parcours, isolation 354 contrôles). Nouveaux garde-fous :
  GRANT par colonne d'`organizations`, invitations prouvées par e-mail (`accept_member_invitations`, `jwt_issued_after`,
  `users.super_admin_since`), comptes partagés intouchables, `runAction`, `safe-next`, `hostname`, `zoned-time`,
  `login-limits`, budget géo par consommateur (`lib/geo/budget.ts`), `verify-full` pour la base.
- [x] **Webhooks sortants (10/2026, migrations 006000 puis 006100 durcissement)** : tables `webhook_endpoints` (10 par
  centrale, RLS owner/admin), `webhook_endpoint_secrets` (service role SEUL), `webhook_deliveries` (sans charge utile) ;
  triggers sur `rides` (`private.queue_ride_webhooks`) + `NOTIFY rydar_webhooks` ; worker `src/webhooks*`
  (`private.claim_webhook_deliveries` : un envoi en cours par adresse, tour de rôle entre centrales, centrale suspendue
  en pause ; `private.complete_webhook_delivery` : 9 essais, ping jamais réessayé, désactivation après ≥ 50 échecs ET
  3 jours sans succès, comptés depuis la création si jamais réussi ; `private.purge_webhook_deliveries` 30/45 j ;
  garde SSRF, signature HMAC) ; RPC service role `svc_webhook_upsert|delete|set_enabled|rotate_secret|ping|redeliver`
  (acteur revérifié, audit_logs ; tests et renvois : `WEBHOOK_TEST_PENDING` 409, `WEBHOOK_TEST_RATE_LIMITED` 429,
  10/min/centrale, aussi en Redis côté web) ; API v1 `/api/v1/webhooks` (permission `webhooks:manage`) ; Dashboard →
  Intégrations (`components/dashboard-webhooks.tsx`, envois par adresse). `publicRide` (`@rydar/shared`) partagé API v1
  / worker : toute colonne ajoutée va dans `PUBLIC_RIDE_SELECT` ET `private.webhook_ride_json`. Contrat : docs/API.md.
- [x] **Interrupteur plateforme des mini-sites (10/2026, migration 006200, COUPÉ par la migration)** : table une ligne
  `platform_settings.booking_sites_enabled` (RLS super admin, aucune écriture client), lecture `booking_sites_enabled()`
  (authenticated, service role ; absent = coupé), écriture `svc_set_booking_sites_enabled(p_actor, bool)` (service role,
  acteur revérifié, audit_logs `platform.booking_sites_enabled|disabled`). Coupé : `resolve_booking_host` → null
  (ni réécriture ni certificat), trigger `rides_booking_sites_switch` (course `booking_site` refusée, sauf seed en
  bypass), trigger `booking_sites_platform_switch` (client : aucune modification ; service role/base : jamais
  d'activation ni de vérification, réductions de l'offre acceptées) → `BOOKING_SITES_DISABLED`. Web :
  `lib/booking-sites.ts` (cache React, erreur = coupé) ; menu « Mini-site » masqué (layout → `DashboardShell`), éditeur
  remplacé par une explication, actions refusées, `/book/{slug}` 404, devis 404, `submitBooking` refusé,
  `/api/tls/allowed` 404 ; carte « Mini-sites de réservation » sur `/admin/plans` (confirmation). Réglages des centrales
  jamais touchés. Seed : interrupteur allumé (démo locale). Tests : `tests/db/booking-sites-switch.test.ts`,
  `lib/tls-allowed.test.ts`, `domaine-booking-site.test.ts`, `booking-public.test.ts`.
  Après revue : `proxy.ts` → hôte de mini-site non résolu (coupé, désactivé, centrale suspendue, Supabase injoignable)
  réécrit vers `/_mini-site-indisponible` = 404 neutre (plus jamais l'accueil ni `/login` de la plateforme sous le
  domaine d'une centrale) ; « indisponible » sur `/tarifs`, l'onglet Abonnement et `/admin/plans` (« · coupé ») ;
  compteur de la carte limité aux centrales actives ; test DB de la rétrogradation en service role.
- [x] **Lien d'inscription des chauffeurs pour les flottes (10/2026, migration 006300)** : `set_join_link`,
  `svc_driver_apply` sans restriction de modèle ; flotte : fiche « new » (sans effet en flotte),
  `approve_driver_application` force « confirmé », validation automatique = reste « new » (plafonné si passage en
  centrale ; avertissement dans le dialogue super admin), journal et messages « … la flotte » ; `private.organizations_dispatch_model_guard`
  ne coupe plus le lien (trigger sur `dispatch_model` seul : code, état, validation auto, candidatures conservés ;
  garde SETTLEMENTS_OPEN inchangée). Web : même page `/dashboard/network`, menu « Inscriptions » (flotte, icône
  `userPlus`, pastille des candidatures, juste sous « Chauffeurs ») / « Réseau » (centrale) + bouton « Lien
  d'inscription » sur la page Chauffeurs ; textes par modèle `components/network/join-copy.ts` (page /rejoindre, message
  WhatsApp / Telegram, validation sans niveau de confiance) ; `/api/join/{code}` renvoie `model` (app : textes JS seuls,
  EAS) ; dialogue super admin du modèle mis à jour. Tests : `tests/db/fleet-join.test.ts`, `join-copy.test.ts`.
  Après revue : textes neutres (erreurs de `lib/join.ts` selon le modèle, « propriétaire ou admin », site vitrine sans
  « en mode centrale »), défaut unique `joinInfoModel` (sans modèle → centrale), écran d'attente de l'app sans « Nouveau »
  en flotte, pastille des candidatures sans bannis ni supprimés ; tests `lib/join.test.ts` (route GET + erreurs) et
  `lib/network-actions.test.ts` (validation « confirmé » en flotte).
- [x] **Frais Rydar des flottes (10/2026, migration 006400)** — modèle du propriétaire : abonnement (offres, inchangé) +
  X € / Y % par course, flottes comprises. Mêmes règles d'argent que les centrales (registre immuable, corrections en
  delta, baisses `pending`, paiements FIFO, déclarer / confirmer / refuser / rouvrir, relances, blocage, relevés).
  Flotte : frais = arrondi(prix × % / 100) + fixe (sans prix : fixe seul ; sans plafond au prix, facturés et non
  prélevés), taux FIGÉS à la fin de course dans `private.fleet_fee_basis` (aucune ligne si la flotte n'a ni frais ni
  répartition héritée), prix corrigé → recalcul avec ces taux. Le modèle à la fin de course décide ; règlement chauffeur
  présent (course de flotte repassée en centrale puis repricée) → règle centrale, par delta. Courses terminées avant
  006400 : jamais facturées. `rides.platform_fee_cents` reste NULL en flotte (l'app chauffeur ne voit rien).
  Redéfinies : `private.sync_platform_fee`, `private.platform_account` (+ `dispatch_model`, frais de flotte « encaissés
  par l'organisation »), `private.platform_entry_json` (+ `ride.fleet_fee`), `private.platform_statement`
  (+ `organization.dispatch_model`), `org_platform_account` / `org_platform_status` / `admin_platform_overview` (activés
  par `private.platform_fees_enabled` : centrale, flotte avec des frais, ou historique). Taux hérités d'un ancien passage
  en centrale remis à 0 pour les flottes (audit_logs). Web : super admin → champs des frais pour les deux modèles (fiche
  et création, plus de « sans effet en mode flotte »), `/admin/frais` liste les flottes ; flotte → entrée « Frais Rydar »
  (menu Organisation, owner / admin, si activé : `/dashboard/rydar`, relevé `/dashboard/rydar/releve`, même carte que
  la centrale sans « d'où vient l'argent ») + bandeau d'échéance + renvoi depuis Réglages → Abonnement et Encaissements ;
  chemins par modèle `components/platform-fees/org-platform-paths.ts`. Tests : `tests/db/fleet-platform-fees.test.ts`
  (10), `org-platform-paths.test.ts`, `org-platform-format.test.ts`, `admin-platform-format.test.ts`, `shared.test.ts`
  (`fleetPlatformFee`).
  Après revue (même migration, non poussée) : `public.org_platform_fees_enabled` (booléen léger du menu, owner / admin)
  au lieu de `org_platform_status` dans le layout ; trigger `organizations_platform_rates_broadcast` (frais / modèle
  changés → `platform.updated` `rates` / `model` : layout relu, alerte « Rydar a mis à jour vos frais par course ») ;
  `svc_platform_remind` redéfinie (messages « la flotte » / « la centrale ») ; `month.zero_price_rides` d'une flotte =
  courses sans prix dont la part en % est perdue (centrale inchangée) ; bandeau et alertes « Frais Rydar » en flotte,
  dialogues du super admin au nom de la flotte ; avertissement CGV à côté des champs de frais d'une flotte
  (`CGV_COVERS_FLEET_FEES`) ; `/admin/frais` revalidé après un changement de frais ; taux lisibles par les dispatchers
  (décision documentée, SECURITY.md). Tests : 16 dans `fleet-platform-fees.test.ts` (fin côté serveur, prix d'une course
  terminée baissé puis remonté par un dispatcher, réglage pendant la fin de course, flotte → centrale sans règlement,
  menu, temps réel, relance) + `zeroPriceText`.
- [x] **CGV version 2026-10-02 (frais par course pour tous les modèles + abonnement)** — `/cgv` art. 3 (deux modèles,
  frais par course possibles dans les deux, réseau partagé = convention distincte), art. 4 (abonnement au montant de
  l'offre à la souscription, cumulable avec les frais), art. 5 « Frais plateforme » décrit le SQL : flotte = % + fixe
  sans plafond, fixe seul sans prix, taux figés à la fin de course ; centrale = prélevés, plafonnés au prix, rien sans
  prix, taux du calcul de la répartition ; changement de taux affiché dans le tableau de bord, jamais sur les frais
  inscrits ; dus par l'organisation à qui appartient la course (réseau partagé compris). `/confidentialite` § 7
  (organisations partenaires), `/tarifs` et `pricing.tsx` (flotte comme centrale). `LEGAL_VERSION` → `2026-10-02`
  (nouvelle acceptation web + app), `CGV_UPDATED_AT` / `PRIVACY_UPDATED_AT` ; `CGV_COVERS_FLEET_FEES` et
  l'avertissement du super admin retirés. Aucune version légale en dur en SQL : aucune migration.
- [x] **Lenteur, volet serveur / auth / base (10/2026, migration 006500)** : `proxy.ts` = `getSession()` (cookies,
  rafraîchissement gardé) puis `getClaims(jeton)` pour un jeton ES256/RS256 + kid (vérifié sur place, JWKS) ; jeton
  HS256 : aiguillage sans appel à Auth si le JWKS est vide (pile en HS256 seul, rejeté au rendu), sinon vérifié par
  Auth (voir « après revue ») ; `/login` garde `getUser()`. `lib/auth.ts` : lectures
  de session (users, adhésions, chauffeur) en même temps que `getUser()` (qui fait foi : `user.id` = `sub` du cookie,
  sinon aucune session), contrôle `session_is_super_admin` lancé en parallèle et lu après. `prefetch={false}` sur la
  barre latérale, le logo, les lignes / onglets / pages de la liste des courses ; liens juridiques du bandeau en `<a>`.
  Fiche course : course + données liées en un seul `Promise.all` ; liste centrale : règlement embarqué ; fiche admin
  d'une organisation : organisation et état de connexion des membres dans le `Promise.all`. `public.chat_counts`
  (compteurs du menu Messages, égaux à `chat_overview`) ; index `rides_org_open_pickup_idx` (partiel, non terminées),
  `ride_offers_org_sent_idx`, `ride_events_org_id_idx` (création simple : `migrate.sh` = `psql -1`).
  `server-fetch.ts` : IPv4 d'abord (une requête sur deux échouait sur un conteneur sans IPv6 dès qu'un AAAA existe).
  Worker MapLibre sous `/vendor/maplibre/<version>/`, cache navigateur d'un an ; `KEEP_ALIVE_TIMEOUT=130000` (web,
  au-dessus des 2 min de Caddy). Mesuré (build de prod, +10 ms par appel Supabase) : chargement de `/dashboard`
  26 → 1 requête Next et 28 → 1 appel GoTrue, CPU Next 900 → 520 ms par « chargement + clic ». TTFB : pile HS256,
  −20 à −50 ms (série d'appels 4-7 → 2-3) ; production (ES256 : le proxy n'appelait déjà pas Auth), série 3-4 → 2,
  soit UN aller-retour Auth de moins par rendu (deux sur `/admin`) : −10 à −28 ms à +10 ms par appel, −6 à −8 ms à
  +3 ms (contre-mesure de la revue), en plus de la fin des préchargements. Tests : `lib/proxy-auth.test.ts` (vrai
  auth-js, HS256 et ES256), `lib/auth.test.ts`, `lib/server-fetch.test.ts`, `tests/db/perf-indexes.test.ts`.
  Après revue : jeton non asymétrique (HS256, alg none…) alors que le JWKS publie une clé asymétrique (production :
  jeton d'avant une rotation des clés, ou falsifié) → `getClaims()` le fait vérifier par Auth, refusé dès le proxy
  avec `?next=` (`lib/supabase/jwks.ts` : JWKS lu par processus, gardé 10 min ; illisible → vérification par Auth) ;
  mesuré, JWKS ES256 simulé : jeton HS256 falsifié 4 → 1 appel, TTFB 38 → 19 ms ; jeton HS256 légitime (rotation
  seulement) +1 appel Auth par requête, comme avant ; jeton ES256 inchangé (aucune lecture du JWKS en plus) ; pile
  HS256 seule inchangée (mêmes appels ; TTFB −9 à +13 ms selon la passe, sans tendance). Ancien chemin du worker MapLibre
  (`/vendor/maplibre/maplibre-gl-worker.mjs`) recopié tant que MapLibre reste en 6.11.2 (onglet ouvert pendant le
  déploiement : 404 → 200). `prefetch={false}` aussi sur le relevé des frais (mois, retour, courses) : 15 → 1 requête
  Next au chargement (14 préchargements → 0), CPU Next 360 → 240 ms. Branche fusionnée avec 006400 (frais des flottes).

- [x] **Lenteur ressentie, volet navigateur / temps réel / pages lourdes (10/2026, web seul, sans migration)** — constats
  CR1-CR5, CR8, SD-2, SD-3 (partiel), SD-6, SD-9 de l'analyse de performance :
  - Centre de commande : `driver.location` regroupés (`useRef<Map>`, une action `locations` par seconde, rien onglet caché ;
    position plus ancienne que la connue ignorée) ; réducteur sorti dans `components/command/live-state.ts` (testé).
    `FleetMap` : clés par marqueur (DOM touché seulement si l'état change), une boucle rAF pour toutes les voitures, pas
    de réécriture sous 0,5 px, saut direct onglet caché ; épingles séparées des tracés ; `rd-routes` redessiné seulement
    si une position utile (approche, offres de la course sélectionnée) ou les courses changent ; `rd-radius` si la
    course sélectionnée / son rayon changent ; visibles = sélectionnée ou non terminée et (< 2 h ou en route / à bord) :
    plus d'épingles ni de lignes d'approche pour les ACCEPTED lointaines ; horloge lente 30 s (positions anciennes,
    horizon). `MapDriver` : la carte n'exige que id, numéro, nom, présence, position, plaque.
  - Horloges : `useNow(15_000)` pour l'écran ; `useSharedNow(ms, repli)` (`hooks/use-now.ts`, une minuterie par
    intervalle, `useSyncExternalStore`) pour `LiveClock`, le compte à rebours des vagues (`ride-row.tsx`), « vu il y a »
    (`fleet-panel.tsx`) et la console super admin (`live-console.tsx`, âges, « Actualisé il y a »). `RideRow` et les
    lignes de la flotte mémorisées (rappels stables, chauffeur comparé sur ce qui est affiché).
  - `@rydar/shared` `format.ts` : `dateTimeFormat` / `numberFormat` mémorisés (clé locale + options, 200 au plus),
    sorties identiques (1 117 comparaisons ; `formatRideDate` ×22, `formatPrice` ×30 plus rapides).
  - Synchronisation : `RealtimeProvider` expose `generation` (réabonnements) et une valeur mémorisée ;
    `components/realtime/use-live-sync.ts` (événement → relecture regroupée, différée onglet caché ; réabonnement ou
    retour du temps réel → relecture ; repli « offline » seulement, délai ×3 jusqu'au plafond, en pause onglet caché ;
    sécurité optionnelle en temps réel). Utilisé par `LiveRefresh` (5 → 15 → 45 → 60 s), `NetworkLive`, Encaissements
    (15 s → 2 min ; plus de relecture fixe de 120 s : relecture à la prochaine échéance, une par minute au plus) et le
    centre de commande (instantané : reconnexion, retour après 1 min caché, 2 min en temps réel, repli 6 → 18 → 30 s ;
    KPI 2 s au plus, seulement sur statut / prix / horaire / présence). Compteurs de la barre (120 s) en pause onglet
    caché. `prefetch={false}` sur les liens de la barre latérale et du bandeau des conditions (pages dynamiques sans
    loading.js : le préchargement ne servait à rien et repartait après chaque `router.refresh`).
  - Instantané : `route_polyline` retiré de `RIDE_FIELDS` ; 3e lecture parallèle des tracés des courses client à bord ;
    autres tracés chargés à la demande (`GET /api/dashboard/rides/[id]?route=1`, RLS + `getOrgContext`), gardés par le
    réducteur tant que le trajet est le même ; recadrage si le tracé déborde.
  - Encaissements : `components/settlements/settlement-list.ts` (rang, tri, version compacte) ; une seule variante de
    ligne (`xl:contents` + `xl:order-*`) ; « À traiter » trié côté serveur puis 100 lignes (`n` jusqu'à 500, « Afficher
    plus ») ; règlements ouverts envoyés en version compacte (compteurs, WhatsApp). Les compteurs restent calculés sur la
    liste ouverte (org_settlement_overview n'a ni le nombre de retards ni celui des « à verser » ; pas de migration).
  - Chauffeurs : `components/drivers/drivers-table.tsx` (client, lignes compactes, heure du rendu serveur pour « vu »).
  Mesures (build de prod, base rydar_perf, A = 0cc5c0f, B = ce lot, médianes, A/B alternés, machine partagée) :
  /dashboard CPU ×4 sans canevas, 50 chauffeurs toutes les 5 s : occupation 99,5 → 36,1 %, script 58,4 → 6,5 %, rendus
  de carte 10,3 → 1,0/s, tâches longues 175 → 4 par 30 s ; au repos : 16,3 → 8,7 %, script 7,3 → 1,3 %, tâches
  longues 24 → 0 ; épingles 209 → 15. Serveur : Encaissements (250 à traiter) HTML 3,57 → 1,22 Mo, CPU 660 → 200 ms,
  TTFB 1 048 → 447 ms ; filtre « Encaissés » 1,53 → 1,05 Mo, 250 → 140 ms ; Chauffeurs 1,08 Mo → 576 Ko (RSC 649 → 145 Ko),
  CPU 140 → 90 ms ; Courses CPU 70 → 50 ms. Requêtes en 60 s, temps réel coupé : fiche course 180 → 6, Encaissements 75 → 12,
  « En direct » 10 → 3 instantanés (0 onglet caché). Captures A/B identiques (hors épingles lointaines retirées).
  Corrections après revue (A = 1bce786, B = correctifs, mêmes conditions) :
  - `LiveRefresh` prend `maxPollMs` : fiche d'une course non close (ni terminée ni annulée) relue au plus toutes les
    30 s sans temps réel (60 s sinon) ; course en cours, temps réel coupé, 180 s : 4 → 7 relectures, mais 12 → 7
    requêtes (liens sans préchargement, ci-dessous).
  - Encaissements : relecture de sécurité toutes les 5 min en temps réel (`livePollMs: 300_000`, diffusion perdue sans
    coupure du canal) : 0 → 1 relecture en 310 s (une seule requête de plus, occupation 3,1 % des deux côtés).
  - Sélection des Encaissements : `carrySelection` (`settlement-list.ts`, testé) ; une ligne cochée sortie des lignes
    affichées après une relecture (re-tri des 100 premières) reste cochée, affichée sous « Sélection conservée », tant
    que l'index des ouverts la donne avec le même statut et le même montant ; retirée sinon (vérifié dans Chromium en
    réécrivant la relecture RSC : A perdait les 2 cases sans le dire, B garde la ligne encore ouverte, 1 sélectionné).
  - Carte : `alertRideIds` (alertes ouvertes) : une course en alerte reste épinglée au-delà de 2 h comme dans la liste
    « En cours » (alerte injectée dans l'instantané : 19 → 20 épingles, occupation inchangée 7,1 %).
  - `prefetch={false}` sur les liens des fiches course (retour, chauffeur, règlement) et des Encaissements (onglets,
    cartes, soldes, numéros de course, réglages, relevé) : chaque relecture relançait ~2 (fiche) ou ~10 (Encaissements)
    préchargements de 2,4 Ko inutiles ; temps réel coupé, 120 s : fiche 15 → 5 requêtes, Encaissements 12 → 2 ; temps
    de navigation au clic inchangé (médianes 944-1 600 ms des deux côtés).
  - Barre latérale : commentaire « rendre le préchargement si un app/dashboard/loading.tsx arrive ».

## Notes / prochaines étapes
- Seed : bypass via GUC `rydar.bypass_ride_rules=on` (connexion directe seulement). Comptes démo en tête de `supabase/seed.sql`.
- Toute nouvelle fonction SQL : revoke/grant explicites (cf. 0900). `api_key_secrets` = service_role only.
- Données indispensables en production : par MIGRATION, jamais seulement dans seed.sql (jamais chargé en prod).
- Variables d'environnement : défaut avec `||`, jamais `??` (Docker/Compose passent des variables VIDES, ex. NEXT_PUBLIC_MAP_*
  → carte noire en prod) ; la CI vérifie l'image (CSP tuiles, worker MapLibre, adresse des tuiles).
- Formulaires web : `onSubmit={submitWith(fn)}` (`lib/utils`), jamais `<form action={fn}>` (React 19 vide le formulaire même
  si le serveur répond une erreur) ; erreurs serveur : `fieldErrors(err)` + `describeError(err, LABELS)` (« Champ : message »).
- Supabase hébergé : `postgres` NON super-utilisateur (BYPASSRLS) ; `auth.*`, `storage.*`, `realtime.messages` appartiennent
  aux services → seulement CREATE/DROP POLICY (supautils policy_grants), trigger sur auth.users, DML ; jamais ALTER TABLE/fonction dessus.
- RPC chauffeur : accept_ride_offer, decline_ride_offer, driver_update_ride_status, driver_set_online, update_driver_location, driver_heartbeat, driver_register_device, driver_home, driver_offers ; centrale : driver_settlements, driver_declare_payment, driver_account_state.
- RPC dashboard : cancel_ride, assign_ride, redispatch_ride, reassign_ride, acknowledge_ride_alert, org_kpis, org_stats, driver_stats, org_usage, platform_overview ; svc_cancel_ride (service_role).
  Centrale : org_settlement_overview, org_settlements, confirm/dispute/waive/reopen_settlement, remind_driver_settlements, preview_ride_split,
  ban_driver, lift_driver_ban, lift_identity_ban, set_join_link, approve/reject_driver_application (aussi en flotte, 006300), admin_centrale_overview ;
  service role : svc_join_info, svc_identity_check, svc_driver_apply, svc_platform_ban/unban/dismiss_report.
- Frais plateforme (centrale, et flotte avec des frais depuis 006400) : org_platform_status, org_platform_fees_enabled (menu, 006400), org_platform_account, org_platform_statement, declare/cancel_platform_payment ;
  super admin admin_platform_overview, admin_platform_account ; service role svc_platform_confirm/reject/reopen/record_payment,
  svc_platform_adjust, svc_platform_review_entry, svc_platform_remind, svc_platform_terms, svc_platform_billing_update.
- Worker (connexion directe PG) : private.dispatch_tick(), private.claim_notifications(n), private.housekeeping(), private.watch_rides(), private.watch_driver_gps() (app fermée → hors ligne), private.flights_to_check(n)/apply_flight_status(...), private.document_reminders(), private.settlement_reminders() ; LISTEN rydar_notifications.
- Formulaire de contact (005700) : service role svc_contact_submit (demande + e-mails en une transaction) ; worker
  private.purge_contact_data() (ménage) ; mailer private.claim_emails(n), private.complete_email(id, ok, erreur, définitif) ;
  LISTEN rydar_emails. 005900 : private.expire_unstarted_rides(limite) (planifiées acceptées jamais démarrées,
  annulées 6 h après l'heure, via private.housekeeping). 005800 : mailer private.report_mailer_status(jsonb) (table public.mailer_status, lecture super
  admin), private.release_emails(ids) (lot rendu sans essai compté), private.requeue_waiting_emails() (relance au retour
  du serveur mail et au démarrage).
- Webhooks sortants (006000, 006100) : service role svc_webhook_upsert/delete/set_enabled/rotate_secret/ping/redeliver ;
  worker private.claim_webhook_deliveries(n), private.complete_webhook_delivery(id, ok, code, erreur),
  private.purge_webhook_deliveries() (toutes les heures) ; LISTEN rydar_webhooks.
