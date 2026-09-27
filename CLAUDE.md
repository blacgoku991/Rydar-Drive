# Rydar Drive — mémoire projet (COMPACTE : garder court, détails dans docs/)

**Toujours répondre en français, réponses courtes.** Travail en cours : `docs/EN-COURS.md`. Historique détaillé des jalons,
migrations et listes de RPC : `docs/HISTORIQUE.md` (à lire seulement si besoin). Docs : ARCHITECTURE, API, SECURITY,
DEPLOYMENT, STORES (publication app), WHATSAPP.

## Produit
SaaS de dispatch VTC multi-tenant. Acteurs : super admin (Rydar), centrale / rattacheur (org : owner, admin, dispatcher), chauffeur.
**Aucun compte client.** Courses : dashboard | API `POST /api/v1/rides` (clé API → org) | mini-site `/book/[slug]` (sous-domaine).
**Rydar = simple logiciel de dispatch** : les courses, clients, prix et chauffeurs appartiennent à la centrale (obligations VTC à sa charge).
Deux modèles : `fleet` (flotte) | `centrale` (à commission) : `ride_settlements.direction` = `driver_owes` (client payé en espèces/carte
à bord : commission + frais dus par le chauffeur) | `centrale_owes` (en ligne/facture : part chauffeur due par la centrale) ;
la centrale doit les frais plateforme à Rydar.

## Stack (pnpm workspaces)
- `apps/web` Next 16 App Router (⚠️ API différente : lire `node_modules/next/dist/docs/` à la RACINE), Tailwind v4, UI maison `components/ui`,
  MapLibre 6, Supabase SSR ; `proxy.ts` (mini-sites, pages légales non réécrites).
- `apps/driver` Expo 57 / RN 0.86 / expo-router ; entrée `index.ts` (tâche GPS avant expo-router) ; `src/lib/{location,api,supabase}.ts`.
- `apps/worker` Node : dispatch_tick, file `notifications` → push (Expo/FCM/APNs) + WhatsApp (`src/whatsapp.ts`), rappels, vols.
- `packages/shared` (`@rydar/shared`) : types, schémas zod 4, libellés FR, navigation, centrale, platform-fees, whatsapp.
- `supabase/migrations` = source de vérité (numéro suivant = dernier de `ls supabase/migrations` + 100) ; `tests/db` vitest sur PG réel.
  TypeScript épinglé 5.9.

## Règles impératives
- **Migration poussée = jamais modifiée** : correction dans une NOUVELLE migration (le VPS a pu l'appliquer) ; non poussée = modifiable.
- Redéfinir une fonction SQL : partir de sa DERNIÈRE version (`grep -n 'function public.x(' supabase/migrations/*.sql | tail -1`),
  noter `-- Dernière définition : <migr>` ; signature changée → `drop function` + grants refaits.
- Nouvelle fonction SQL : `set search_path = ''` + revoke/grant explicites (EXECUTE accordé à anon par défaut) ; RPC `public` en
  `security definer` = RLS contournée → contrôler l'accès DANS la fonction (`private.assert_org_member(org, roles)`,
  `private.current_driver_id()`, `private.assert_platform_actor`) ; helpers/triggers `private` sans definer.
- RLS partout, `organization_id` immuable ; nouvelle table : RLS + `revoke all … from anon, authenticated` ; UPDATE client = GRANT
  PAR COLONNE (`grant update (col) on … to authenticated`, jamais sur toute la table) ; écritures sensibles par RPC.
- Super admin : lit via RLS ; écrit en action serveur `requireSuperAdmin()` + `createAdminClient()` + `audit()` (`lib/audit.ts`),
  ou RPC `svc_*` (p_actor revérifié en SQL, audit_logs en SQL).
- Secrets (jetons, clés) : tables `*_secrets` service role seul, jamais renvoyés au navigateur ni journalisés.
- Données requises en prod : par migration, jamais seulement `supabase/seed.sql` (jamais chargé en prod).
- Supabase hébergé : `postgres` non superuser → sur `auth.*`/`storage.*`/`realtime.messages` seulement policies, trigger sur auth.users, DML.
- Env : défaut avec `||`, jamais `??` (Docker passe des variables vides).
- Formulaires web : `onSubmit={submitWith(fn)}`, jamais `<form action>` ; erreurs `fieldErrors` + `describeError`.
  Fichier `"use server"` : n'exporter que des fonctions async.
- Tailwind v4 : classes custom = `@utility`. PG regex : répétition ≤ 255 (`{1,512}` interdit).
- IP client : toujours `ipFromHeaders` (`lib/request.ts`) + `rateLimitAll` ; jamais lire CF-Connecting-IP / X-Real-IP soi-même.
- Export CSV : BOM UTF-8, « ; », cellule commençant par = + - @ tab CR préfixée d'une apostrophe (modèle
  `app/dashboard/settlements/rydar/export/route.ts`).
- WhatsApp : API officielle Cloud de Meta + modèles approuvés (`WHATSAPP_TEMPLATES`) seulement, jamais d'outil non officiel.
- App chauffeur : position UNIQUEMENT via `requestLocationPermissions()` (information préalable) ; jamais « Toujours »,
  ACCESS_BACKGROUND_LOCATION ni exemption batterie ; iOS UIBackgroundModes = location. RPC via `rpc()` de `src/lib/api.ts`
  (réessai JWT expiré) ; effets liés à `userId`, pas à l'objet session. Nouvelle `Stack` → `fullScreenGestureEnabled: false` ;
  écran à glissière → `gestureEnabled: false` (iOS 26 : glisser à droite = retour).
- EAS Update : runtimeVersion = version → tout changement natif (module, permission, plugin, icône) = nouvelle version + build
  stores, jamais `eas update` seul.
- Git : branche `claude/confident-clarke-rpfwmo` ; `git fetch`/`pull` avant push (l'utilisateur modifie aussi via le VPS) ;
  pas de PR sans demande.
- Jamais de secret dans le chat (l'utilisateur les saisit via `sudo bash /opt/rydar/deploy/configure.sh`). Claude sur le VPS :
  `deploy/CLAUDE-VPS.md` (pas de seed, pas de code modifié sur le serveur).
- Shell : jamais `pkill -f <motif>` si le motif est dans la commande (tue le shell). Sandbox : tuiles/géocodage/routage externes
  bloqués → `scripts/dev-geo/`.

## Métier (l'essentiel)
- Dispatch (PL/pgSQL) : instantané = vagues STRICTES (défaut 4→8→12→16 km `dispatch_radii_m`, une par délai
  `offer_timeout_seconds`), relance (défaut 4→8 km `dispatch_retry_radii_m`), puis
  NO_DRIVER_FOUND + explication ; position fraîche seulement ; planifiée = offre à toute la flotte puis géo à T-lead.
  Accept atomique (`accept_ride_offer`, FOR UPDATE + index unique) → « Course déjà attribuée. »
- Présence : app ouverte (même arrière-plan / verrouillé) = en ligne + GPS en direct ; app fermée → hors ligne après 3 min (15 si app < 1.1.0) sans
  position ni `driver_heartbeat` (`private.watch_driver_gps`, jamais en course), sans notification.
- Centrale : `ride_settlements` (due→declared→paid|disputed|waived) ; moyens chauffeur = lien | virement (RIB) | espèces | autre,
  proposés seulement s'ils sont renseignés ; relances app / WhatsApp / les deux (`reminder_channels`), WhatsApp impossible → app.
- Frais plateforme : dus dès la fin de course (même si le règlement chauffeur est annulé/contesté), registre immuable
  `platform_fee_entries` (changement = correction delta ; BAISSE `pending` jusqu'à validation super admin), paiements FIFO.
- Temps réel : `realtime.send` topics `org:{id}` (lu par TOUT membre, dispatcher compris : rien qu'un dispatcher ne lirait pas via
  RLS ; `platform.updated` = ids seulement), `driver:{id}`, `fleet:{org}`.
- Légal : `platform_legal` (éditeur, /admin/legal), `legal_acceptances` (version `LEGAL_VERSION` dans `apps/web/lib/legal.ts`).

## Design
Sombre « radar », accent lime. Jamais de hex en dur : jetons `apps/web/app/globals.css` (@theme `--color-ink-*`, `fg`, `fg-muted`,
`brand`, `amber`, `blue`, `violet`, `cyan`, `red` → classes `bg-brand`, `text-fg-muted`…) = `apps/driver/src/theme.ts`.
Geist + Geist Mono (chiffres). App chauffeur SOBRE (« pas IA ») : jetons `theme.ts` (poids ≤ 700), aucun emoji
(`FLEET_REPORT_META.ionicon` ; `.emoji` = web), ni animation en boucle, ni lueur/dégradé/flou, ni pastille d'icône teintée ;
casse normale ; couleur = information ; cibles ≥ 48 px (56 en conduite) ; texte d'info `muted`, jamais `subtle` ;
espace insécable avant ? : ; ! (`frTypo`).

## Commandes
- PG local : `pg_ctlcluster 16 main start` ; Redis `redis-server --daemonize yes`.
- Tests : `pnpm test` (unitaires) ; `pnpm test:db` (base `rydar_test`) — en parallèle d'un autre run : `TEST_DATABASE_NAME=autre_nom`.
- Typecheck : `pnpm typecheck` ; CI : typecheck, test, builds web/worker, test:db, migrations + seed sur base neuve (nombre de
  chauffeurs/orgs du seed vérifié dans ci.yml), images Docker.
- Web : `pnpm dev` (le predev copie le worker MapLibre dans `public/vendor/`, non versionné : `npx next dev` seul = carte cassée) ;
  app : `pnpm --filter @rydar/driver web` ; export : `pnpm --filter @rydar/driver export:check`.
- Stack Supabase locale : `bash scripts/local-stack/setup.sh` une fois (RECRÉE la base rydar + seed), puis `start.sh` (affiche
  les clés à copier dans `apps/web/.env.local`).
