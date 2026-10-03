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
  Webhooks sortants (`src/webhooks*`, ARCHITECTURE) : colonne ajoutée à `publicRide` = `PUBLIC_RIDE_SELECT` ET `private.webhook_ride_json`.
  Service `mailer` (même image, `dist/mailer.js`, réseau de l'hôte) : file `email_outbox` → SMTP 127.0.0.1:25 (Postfix du VPS) ;
  SMTP injoignable = file en pause (aucun essai compté), relancée à son retour ; état en base `mailer_status` (/admin/contacts).
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
- Web : relectures temps réel par `useLiveSync` (rien onglet caché) ; Intl via `dateTimeFormat`/`numberFormat` (shared), jamais `new Intl.*` en rendu.
- Conformité (`docs/SECURITY.md`, « Documents légaux ») : aucun traceur non nécessaire ni script/police/vidéo tiers sans
  gestionnaire de consentement CNIL ; nouveau cookie ou clé de stockage → tableau de `/cookies` ; changement
  d'hébergement ou de sous-traitant → `/dpa`, `/confidentialite`, `/mentions-legales` d'abord. Champ de formulaire :
  `Field` (libellé, aide et erreur reliés) ; texte jamais sous 4,5:1 ; lien `target="_blank"` → `NewTabHint`.
- IP client : toujours `ipFromHeaders` (`lib/request.ts`) + `rateLimitAll` ; jamais lire CF-Connecting-IP / X-Real-IP soi-même.
- Perf : `<Link>` du tableau de bord en `prefetch={false}` ; proxy sans appel à Auth sauf jeton HS256 face à un JWKS asymétrique (getUser : /login et rendu).
- Export CSV : BOM UTF-8, « ; », cellule commençant par = + - @ tab CR préfixée d'une apostrophe (modèle
  `app/dashboard/settlements/rydar/export/route.ts`).
- WhatsApp : API officielle Cloud de Meta + modèles approuvés (`WHATSAPP_TEMPLATES`) seulement, jamais d'outil non officiel.
- App chauffeur : position UNIQUEMENT via `requestLocationPermissions()` (information préalable) ; jamais « Toujours »,
  ACCESS_BACKGROUND_LOCATION ni exemption batterie ; iOS UIBackgroundModes = location. `watchPositionAsync` iOS = pause
  automatique (non réglable) : un flux de premier plan doit être relancé (retour dans l'app, chien de garde :
  `use-my-position`). RPC via `rpc()` de `src/lib/api.ts` (réessai JWT expiré) ; effets liés à `userId`, pas à l'objet
  session. Nouvelle `Stack` → `fullScreenGestureEnabled: false` ;
  écran à glissière → `gestureEnabled: false` (iOS 26 : glisser à droite = retour).
- EAS Update : runtimeVersion = version → tout changement natif (module, permission, plugin, icône) = nouvelle version + build
  stores, jamais `eas update` seul.
- Git : branche `claude/confident-clarke-rpfwmo` ; `git fetch`/`pull` avant push (l'utilisateur modifie aussi via le VPS) ;
  pas de PR sans demande.
- Jamais de secret dans le chat (l'utilisateur les saisit via `sudo bash /opt/rydar/deploy/configure.sh`). Claude sur le VPS :
  `deploy/CLAUDE-VPS.md` (pas de seed, pas de code modifié sur le serveur). Commande à taper par l'utilisateur : ligne
  « COMMANDE À COPIER : » puis un seul bloc bash d'une ligne, sans commentaire.
- Shell : jamais `pkill -f <motif>` si le motif est dans la commande (tue le shell). Sandbox : tuiles/géocodage/routage externes
  bloqués → `scripts/dev-geo/`.

## Sécurité (audit 09/2026, `docs/AUDIT.md` — ne pas réintroduire)
- `organizations` : lecture client par GRANT PAR COLONNE (004300) → une nouvelle colonne lue côté client doit y être ajoutée
  (sinon `select('*')` échoue) ; `drivers.status/trust_level/suspended_reason` réservés owner/admin (trigger).
- Compte EXISTANT nommé gérant (équipe, création de centrale, accès, create-admin.sh) : jamais rattaché directement → adhésion
  `invited` + lien e-mail (`accept_member_invitations`) ; recherche d'e-mail par ÉGALITÉ (jamais `ilike`) ; contrôles d'adhésion
  avec `private.jwt_issued_after` (jeton émis avant l'activation refusé).
- Compte partagé (fiche chauffeur + gestion ou super admin, `svc_login_account_shared`) : la centrale du chauffeur ne touche jamais
  au compte Auth (mot de passe, ban, sessions) ; suspendre une centrale ne bannit personne au niveau Auth.
- Web : action serveur dans `startTransition`/onClick → `runAction` (`lib/run-action.ts`) ; heure saisie = fuseau de la centrale
  (`components/booking/zoned-time.ts`) ; `next` de redirection via `lib/safe-next.ts` ; Host du proxy validé (`lib/hostname.ts`).
- Worker et scripts : base en `verify-full` (`deploy/supabase-ca.crt`), repli `DATABASE_SSLMODE=no-verify` ; `disable` =
  base LOCALE seulement (Supabase auto-hébergé du VPS : `isLocalDbHost` = `pg_local_host`) ; aucun secret en argv.

## Métier (l'essentiel)
- Dispatch (PL/pgSQL) : instantané = vagues STRICTES (défaut 4→8→12→16 km `dispatch_radii_m`, une par délai
  `offer_timeout_seconds`), relance (défaut 4→8 km `dispatch_retry_radii_m`), puis
  NO_DRIVER_FOUND + explication ; position fraîche seulement ; planifiée = offre à toute la flotte puis géo à T-lead.
  Accept atomique (`accept_ride_offer`, verrou course + chauffeur, index unique) → « Course déjà attribuée. » ; course attribuée
  pendant une autre = enchaînée à la fin (`private.release_driver_ride`).
- Planifiée acceptée jamais démarrée : annulée « Non effectuée » 6 h après l'heure de prise en charge
  (`private.expire_unstarted_rides` via le ménage, `UNSTARTED_RIDE_EXPIRY_HOURS`) ; avant, l'app l'affiche « heure dépassée ».
- Présence : app ouverte (même arrière-plan / verrouillé) = en ligne + GPS en direct ; app fermée → hors ligne après 3 min (15 si app < 1.1.0) sans
  position ni `driver_heartbeat` (`private.watch_driver_gps`, jamais en course), sans notification.
- Centrale : `ride_settlements` (due→declared→paid|disputed|waived) ; moyens chauffeur = lien | virement (RIB) | espèces | autre,
  proposés seulement s'ils sont renseignés ; relances app / WhatsApp / les deux (`reminder_channels`), WhatsApp impossible → app.
  Après « Pas reçu » (`disputed_at`), une redéclaration ne débloque plus ; un « déclaré » compte dans le plafond après 72 h.
  Dette ouverte + suppression de compte → empreintes gardées (`private.debtor_identities`) : candidature jamais auto-validée.
- Lien /rejoindre : flotte ET centrale (006300, menu « Inscriptions » / « Réseau », textes `network/join-copy.ts`), jamais coupé par un changement de modèle ;
  flotte : validé à la main = « trusted », validation auto = reste « new » (plafonné si passage en centrale).
- Frais plateforme : dus dès la fin de course (même si le règlement chauffeur est annulé/contesté), registre immuable
  `platform_fee_entries` (changement = correction delta ; BAISSE `pending` : décision super admin, acceptée au bout de 30 j), paiements FIFO.
  Flottes aussi (006400) : % prix (0 sans prix) + fixe, taux figés fin de course (`private.fleet_fee_basis`), menu « Frais Rydar ».
  Taux par `svc_platform_set_fees` (006600) : HAUSSE programmée ≥ 30 j (et ≥ `ORG_LEGAL_EFFECTIVE_AT` sans CGV acceptées,
  refusée sans CGV acceptées ni annoncées ou sans e-mail ; appliquée par le ménage seulement si l'e-mail d'annonce est PARTI
  30 j avant) ou accord écrit, baisse immédiate, hausse en UPDATE direct refusée ; changement de modèle = note d'accord
  obligatoire ; délai de paiement ≤ 45 j ; web : modèle seul = sans taux (taux actuels renvoyés = annonce annulée) ;
  arrondi `percentOfCents`. CGV art. 5, `ORG_LEGAL_CHANGES` et e-mails décrivent CE code : les changer ensemble.
- Temps réel : `realtime.send` topics `org:{id}` (lu par TOUT membre, dispatcher compris : rien qu'un dispatcher ne lirait pas via
  RLS ; `platform.updated` = ids seulement), `driver:{id}`, `fleet:{org}`.
- Légal : `platform_legal` (éditeur, /admin/legal), `legal_acceptances` idempotente ; versions séparées (`@rydar/shared`) :
  `LEGAL_VERSION` = CGU + confidentialité, tous (app embarquée → EAS Update) ; `ORG_LEGAL_VERSION` = CGV + DPA, owner/admin,
  web seul (bandeau « mise à jour », `ORG_LEGAL_EFFECTIVE_AT`) ; version remplacée figée sur `/cgv/AAAA-MM-JJ`.
- Site vitrine multi-pages, sans « démo » ; formulaire `/contact` (`lib/contact.ts` → `svc_contact_submit`, mig 005700) →
  `/admin/contacts`. Le web n'envoie AUCUN e-mail : il écrit dans `email_outbox` (adresses validées comme en base,
  accusé de réception au contenu fixe) ; le mailer envoie.
- Suppression de compte chauffeur : `svc_delete_driver_account` (mig 004000) + file `private.account_deletions` (worker 5 min,
  besoin de SUPABASE_URL/SERVICE_ROLE_KEY) ; fiche supprimée figée (DRIVER_DELETED) ; outil /admin/suppressions.
- Mini-sites : interrupteur `booking_sites_enabled()` (coupé par 006200, /admin/plans), réglages des centrales intacts ; hôte non résolu → 404 neutre (`proxy.ts`).
- Messagerie flotte modérée (004100) ; registre des frais `on delete restrict` (004200) : une centrale avec frais s'archive.
- Bannissement plateforme : les fiches d'AUTRES centrales partageant une identité ne sont bannies que si le super admin les coche
  (`admin_fraud_report_matches`) ; justificatif « Visite médicale » plus déposable (aucune donnée de santé collectée).

## Design
Sombre « radar », accent lime. Jamais de hex en dur : jetons `apps/web/app/globals.css` (@theme `--color-ink-*`, `fg`, `fg-muted`,
`brand`, `amber`, `blue`, `violet`, `cyan`, `red` → classes `bg-brand`, `text-fg-muted`…) = `apps/driver/src/theme.ts`.
Geist + Geist Mono (chiffres). App chauffeur SOBRE (« pas IA ») : jetons `theme.ts` (poids ≤ 700), aucun emoji
(`FLEET_REPORT_META.ionicon` ; `.emoji` = web), ni animation en boucle, ni lueur/dégradé/flou, ni pastille d'icône teintée ;
casse normale ; couleur = information ; cibles ≥ 48 px (56 en conduite) ; texte d'info `muted`, jamais `subtle` ;
espace insécable avant ? : ; ! (`frTypo`).

## Commandes
- PG local : `pg_ctlcluster 16 main start` ; Redis `redis-server --daemonize yes`.
- Tests : `pnpm test` (unitaires, dont app chauffeur `apps/driver/src/**`) ; `pnpm test:db` (base `rydar_test`) — en parallèle
  d'un autre run : `TEST_DATABASE_NAME=autre_nom` ; un code d'erreur SQL levé sans libellé ERROR_MESSAGES fait échouer `pnpm test`.
- Typecheck : `pnpm typecheck` ; CI : typecheck, test, builds web/worker, test:db, migrations + seed sur base neuve (nombre de
  chauffeurs/orgs du seed vérifié dans ci.yml), images Docker.
- Web : `pnpm dev` (le predev copie le worker MapLibre dans `public/vendor/`, non versionné : `npx next dev` seul = carte cassée) ;
  app : `pnpm --filter @rydar/driver web` ; export : `pnpm --filter @rydar/driver export:check`.
- Stack Supabase locale : `bash scripts/local-stack/setup.sh` une fois (RECRÉE la base rydar + seed), puis `start.sh` (affiche
  les clés à copier dans `apps/web/.env.local`).
