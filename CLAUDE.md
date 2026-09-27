# Rydar Drive — mémoire projet (COMPACTE : garder court, détails dans docs/)

**Toujours répondre en français, réponses courtes.** Travail en cours : `docs/EN-COURS.md`. Historique détaillé des jalons,
migrations et listes de RPC : `docs/HISTORIQUE.md` (à lire seulement si besoin). Docs : ARCHITECTURE, API, SECURITY,
DEPLOYMENT, STORES (publication app), WHATSAPP.

## Produit
SaaS de dispatch VTC multi-tenant. Acteurs : super admin (Rydar), centrale / rattacheur (org : owner, admin, dispatcher), chauffeur.
**Aucun compte client.** Courses : dashboard | API `POST /api/v1/rides` (clé API → org) | mini-site `/book/[slug]` (sous-domaine).
**Rydar = simple logiciel de dispatch** : les courses, clients, prix et chauffeurs appartiennent à la centrale (obligations VTC à sa charge).
Deux modèles : `fleet` (flotte) | `centrale` (à commission : le chauffeur doit commission + frais à la centrale ; la centrale doit
les frais plateforme à Rydar).

## Stack (pnpm workspaces)
- `apps/web` Next 16 App Router (⚠️ API différente : lire `node_modules/next/dist/docs/`), Tailwind v4, UI maison `components/ui`,
  MapLibre 6, Supabase SSR ; `proxy.ts` (mini-sites, pages légales non réécrites).
- `apps/driver` Expo 57 / RN 0.86 / expo-router ; entrée `index.ts` (tâche GPS avant expo-router) ; `src/lib/{location,api,supabase}.ts`.
- `apps/worker` Node : dispatch_tick, file `notifications` → push (Expo/FCM/APNs) + WhatsApp (`src/whatsapp.ts`), rappels, vols.
- `packages/shared` (`@rydar/shared`) : types, schémas zod 4, libellés FR, navigation, centrale, platform-fees, whatsapp.
- `supabase/migrations` = source de vérité (dernière : 003900) ; `tests/db` vitest sur PG réel. TypeScript épinglé 5.9.

## Règles impératives
- **Migration publiée = jamais modifiée** : toute correction dans une NOUVELLE migration (le VPS a pu l'appliquer).
- Nouvelle fonction SQL : `security definer`, `set search_path = ''`, revoke/grant explicites (deny-by-default).
- RLS partout, `organization_id` immuable ; écritures sensibles par RPC ; super admin : écritures par service role (`svc_*`, p_actor vérifié, audit_logs).
- Secrets (jetons, clés) : tables `*_secrets` service role seul, jamais renvoyés au navigateur ni journalisés.
- Données requises en prod : par migration, jamais seulement `supabase/seed.sql` (jamais chargé en prod).
- Supabase hébergé : `postgres` non superuser → sur `auth.*`/`storage.*`/`realtime.messages` seulement policies, trigger sur auth.users, DML.
- Env : défaut avec `||`, jamais `??` (Docker passe des variables vides).
- Formulaires web : `onSubmit={submitWith(fn)}`, jamais `<form action>` ; erreurs `fieldErrors` + `describeError`.
  Fichier `"use server"` : n'exporter que des fonctions async.
- Tailwind v4 : classes custom = `@utility`. PG regex : répétition ≤ 255 (`{1,512}` interdit).
- Git : branche `claude/confident-clarke-rpfwmo` ; `git fetch`/`pull` avant push (l'utilisateur modifie aussi via le VPS) ;
  pas de PR sans demande ; pas d'identifiant de modèle dans les commits.
- Jamais de secret dans le chat (l'utilisateur les saisit via `sudo bash /opt/rydar/deploy/configure.sh`). Claude sur le VPS :
  `deploy/CLAUDE-VPS.md` (pas de seed, pas de code modifié sur le serveur).
- Shell : jamais `pkill -f <motif>` si le motif est dans la commande (tue le shell). Sandbox : tuiles/géocodage/routage externes
  bloqués → `scripts/dev-geo/`.

## Métier (l'essentiel)
- Dispatch (PL/pgSQL) : instantané = vagues STRICTES 4→8→12→16 km (une par délai `offer_timeout_seconds`), relance 4→8 km, puis
  NO_DRIVER_FOUND + explication ; position fraîche seulement ; planifiée = offre à toute la flotte puis géo à T-lead.
  Accept atomique (`accept_ride_offer`, FOR UPDATE + index unique) → « Course déjà attribuée. »
- Présence : app ouverte (même arrière-plan / verrouillé) = en ligne + GPS en direct ; app fermée → hors ligne après 3 min sans
  position ni `driver_heartbeat` (`private.watch_driver_gps`, jamais en course), sans notification.
- Centrale : `ride_settlements` (due→declared→paid|disputed|waived) ; moyens chauffeur = lien | virement (RIB) | espèces | autre,
  proposés seulement s'ils sont renseignés ; relances app / WhatsApp / les deux (`reminder_channels`), WhatsApp impossible → app.
- Frais plateforme : dus dès la fin de course, registre immuable `platform_fee_entries`, paiements FIFO, relance super admin (+ WhatsApp).
- Temps réel : `realtime.send` topics `org:{id}`, `driver:{id}`, `fleet:{org}` (payload minimal, relire le détail).
- Légal : `platform_legal` (éditeur, /admin/legal), `legal_acceptances` (version `LEGAL_VERSION` dans `apps/web/lib/legal.ts`).

## Design
Sombre « radar » : bg #07080B, surfaces #0C0E12/#12151B/#191D25, texte #F4F5F7, muted #8B93A1, accent lime `--brand` ;
statuts available lime, offered #FFB020, en_route #4C9DFF, arrived #A78BFA, on_trip #22D3EE, offline #5B6270, erreur #FF4D4F.
Geist + Geist Mono (chiffres). App chauffeur SOBRE : jetons `theme.ts`, aucun emoji, aucune animation décorative, couleur =
information, cibles ≥ 48 px (56 en conduite), texte d'info en `muted`, espace insécable avant ? : ; ! (`frTypo`).

## Commandes
- PG local : `pg_ctlcluster 16 main start` ; Redis `redis-server --daemonize yes`.
- Tests : `pnpm test` (unitaires) ; `pnpm test:db` (base `rydar_test`) — en parallèle d'un autre run : `TEST_DATABASE_NAME=autre_nom`.
- Typecheck : `pnpm typecheck` ; CI : typecheck, test, builds web/worker, test:db, image Docker.
- Web : `cd apps/web && npx next dev` ; app : `pnpm --filter @rydar/driver web` ; export `npx expo export --platform android`.
- Stack Supabase locale sans Docker : `bash scripts/local-stack/setup.sh` puis `start.sh` (clés → `apps/web/.env.local`).
