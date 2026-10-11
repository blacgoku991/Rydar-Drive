# Visite guidée de première connexion (tutoriel web)

> **Statut : conception, prête pour les lots T1 à T3** (§ 12). Rédigée le 11/10/2026 sur `claude/confident-clarke-rpfwmo`
> (HEAD `a104a75`, refonte des panneaux livrée), à partir du § 10 de `docs/REFONTE-PANELS.md` (cahier des charges), des
> choix du propriétaire (§ 1.1) et d'une relecture du code : coquille (`apps/web/components/shell`), menu du compte
> (`sidebar.tsx`), mises en page `app/dashboard/layout.tsx` et `app/admin/layout.tsx`, écrans d'acceptation
> (`components/legal/terms-banner.tsx`, `terms-state.ts`), pages visées par chaque parcours et « Premiers pas » de la
> Flotte Privée (`components/private-fleet/first-steps.ts`). Chaque fichier, ligne et ancre cités ont été vérifiés dans le
> dépôt à cette date (§ 9). Là où le code livré divergera de ce plan, le code fera foi et l'écart sera noté au § 13.3.
>
> Demande du propriétaire : « rajouter un petit tutoriel à la toute première connexion du client pour qu'il mette ses
> réglages etc., que ce soit compréhensible ».

## Sommaire

0. En bref
1. Choix retenus, périmètre et garde-fous
2. Principes et vocabulaire
3. Modèle de données (migration 20260924007800)
4. Écriture et lecture (RPC, droits, action serveur, paquet partagé)
5. Déclenchement
6. Moteur de visite
7. Contenu des parcours
8. Conditions de réussite (lectures en base)
9. Ancres posées dans les pages (vérifiées)
10. « Reprendre la visite » / « Revoir la visite »
11. Tests
12. Lots T1 à T3
13. Décisions, risques, écarts
- Annexe A — SQL de recette (hors dépôt)

---

## 0. En bref

- Une **visite guidée web** de 5 étapes au plus, une par profil : super admin, gérant de flotte, gérant de centrale
  (propriétaire ou administrateur), dispatcher, Flotte Privée. Chaque étape mène à **l'écran réel** et désigne
  **l'élément réel** (bouton, formulaire) ; c'est l'utilisateur qui agit, jamais la visite.
- Elle s'ouvre **d'elle-même à la première connexion** de chaque utilisateur à son espace, **après** les écrans et
  bandeaux d'acceptation CGU / CGV (jamais par-dessus), et jamais quand une action urgente est affichée (courses sans
  chauffeur, réservations à traiter…). Elle se reprend à tout moment depuis le menu du compte : « Reprendre la visite »,
  ou « Revoir la visite » une fois terminée.
- Une **fenêtre non modale** (Radix Popover, déjà dans le projet) ancrée sur l'élément marqué `data-tour="…"`, avec un
  **repli centré en bas d'écran** quand l'élément est absent, sur téléphone ou pour une grande zone ; réductible en
  pastille, fermable par « × » ou Échap ; focus, clavier et lecteur d'écran gérés ; utilisable à 390 px.
- **Progression en base**, par utilisateur et par parcours : table `public.user_tours` (RLS, lecture de ses seules
  lignes, aucune écriture directe), écrite par la RPC `public.save_user_tour` (security definer, `auth.uid()`). Les
  comptes qui existent au moment de la migration sont marqués « en pause » : leur première connexion est passée.
- **Aucun** outil tiers, traceur, clé de stockage du navigateur, vidéo, donnée fictive ; **rien** dans l'app chauffeur,
  le worker, le seed ni les gardes et actions métier.
- 3 lots séquentiels : **T1** base + paquet partagé ; **T2** moteur + intégration dans la coquille ; **T3** parcours
  sur les écrans réels (ancres, conditions de réussite, contrôle des textes) + recette.

---

## 1. Choix retenus, périmètre et garde-fous

### 1.1 Choix du propriétaire (questions du § 10.3 de la refonte, tranchées)

| Question | Choix |
|---|---|
| Déclenchement | D'office à la **première** connexion de chaque utilisateur à son espace (après CGU / CGV, jamais par-dessus) **et** à la demande : « Reprendre la visite » / « Revoir la visite » dans le menu du compte. |
| Mémoire de la progression | **En base**, par utilisateur et par parcours : migration `20260924007800_guided_tour.sql`, RLS, `revoke` anon / authenticated, écriture par RPC `security definer` qui contrôle `auth.uid()`, tests DB. |
| App chauffeur | **Non** : parcours web seulement (une visite dans l'app demanderait une version des stores ou une mise à jour EAS et ses propres règles GPS). |
| Vidéo | **Non**. |
| Outils | Aucun outil tiers de visite guidée ni de mesure d'audience, aucun traceur, aucune donnée fictive créée. |
| Parcours | Super admin, gérant de flotte, gérant de centrale (owner / admin), dispatcher, Flotte Privée ; 5 étapes au plus chacun ; chaque étape → écran réel et action réelle. |

### 1.2 Dans le périmètre

- `supabase/migrations/20260924007800_guided_tour.sql` (table, RLS, droits, RPC, rattrapage des comptes existants) et
  `tests/db/user-tours.test.ts`.
- `packages/shared/src/tour.ts` (+ test) : clés de parcours, états, nombre d'étapes, schéma, choix du parcours.
- `apps/web/components/tour/**` (nouveau dossier : modèle pur, fournisseur, fenêtre, contenus, conditions de réussite),
  `apps/web/app/visite/actions.ts` (action serveur), les deux coquilles, les deux mises en page, la barre latérale (menu
  du compte), une règle de `globals.css`, et des **attributs seuls** (`data-tour`, `data-tour-avoid`,
  `data-tour-fullheight`) dans les pages et composants listés au § 9.
- Documentation : ce document, `docs/EN-COURS.md`, `docs/RGPD-REGISTRE.md` (une mention), `docs/REFONTE-PANELS.md`
  (statut du § 10).

### 1.3 Hors périmètre

- `apps/driver`, `apps/worker`, `supabase/seed.sql` (jamais touché), fonctions SQL existantes, gardes serveur, actions
  serveur métier, calculs, textes juridiques publics (CGU, CGV, DPA, confidentialité : § 13.1), mini-sites et pages
  publiques, « Premiers pas » de la Flotte Privée (inchangés : la visite s'appuie dessus, § 7.6).
- Écran de statistiques de la visite, mesure d'audience, envoi d'e-mails, notifications.

### 1.4 Garde-fous (ne bougent jamais)

1. `CLAUDE.md` s'applique en entier : migrations (numéro unique, jamais modifiée une fois poussée), `set search_path = ''`,
   revoke / grant explicites, RLS partout, conventions web (`submitWith`, `runAction`, `Field`, `prefetch={false}`,
   `useLiveSync`, Intl partagé, `NewTabHint`), jetons de couleur, contraste ≥ 4,5:1, typographie française (`fr()`).
2. Refonte des panneaux (`docs/REFONTE-PANELS.md` § 1.3, § 3, § 4) : lexique, une seule action principale par fenêtre,
   cibles de 44 px sous 640 px, aucune animation en boucle, aucune nouvelle clé de stockage, rien de grave en un clic.
3. **La visite n'agit jamais à la place de l'utilisateur** : ni clic simulé, ni envoi de formulaire, ni création de
   donnée, ni navigation sans clic (seul le défilement jusqu'à l'élément est automatique, après un clic dans la
   fenêtre). Toute navigation passe par un vrai lien `<Link prefetch={false}>` (jamais `router.push`), pour que la garde
   de saisie non enregistrée (`lib/use-unsaved-guard.ts`) s'applique.
4. **Jamais par-dessus une acceptation** : écran `OrgTermsGate` ou bandeau `TermsBanner` / `UserTermsBanner` affiché →
   aucune fenêtre, aucune entrée de menu (§ 5.3).
5. **Flotte Privée** : aucune étape vers une page masquée ET refusée (`lib/private-fleet.ts`, § 7.4 de
   `docs/FLOTTE-PRIVEE.md`) ; « Premiers pas » n'est pas dupliqué.
6. **Données** : la progression ne contient ni donnée métier ni donnée d'un tiers ; jamais lue par un autre compte (pas
   même le super admin) ; effacée avec le compte.
7. **Tests** : aucun test supprimé ou affaibli ; un test qui simule les modules `@/…` reçoit les simulations des
   nouveaux modules dans le même lot.

---

## 2. Principes et vocabulaire

- **Mots à l'écran** : « Visite guidée » (nom de la fonction), « étape », « Reprendre la visite », « Revoir la visite ».
  Le mot « parcours » et les clés (`fleet`, `private_fleet`…) ne s'affichent jamais. Les écrans sont nommés comme dans
  le menu et les en-têtes (lexique du § 4 de la refonte : « Identité de votre entreprise », « Frais Rydar »,
  « Encaissements », « En direct », « Nouvelle course », « Je la prends »…).
- **Premier résultat utile** plutôt que visite des menus (§ 10.1 de la refonte) : premier client créé (super admin),
  première course créée (flotte, centrale, dispatcher), première réservation confirmée (Flotte Privée).
- **Court, interrompable, reprenable, jamais bloquant** : 5 étapes au plus ; on peut passer une étape, revenir, réduire,
  fermer ; la fenêtre ne piège pas le focus et ne recouvre ni bandeau légal ni barre d'enregistrement.
- **Compréhensible** : une étape = un titre court + une ou deux phrases + un bouton qui mène à l'écran ; « C'est fait. »
  quand la base montre que l'action est faite (§ 8) ; un accueil qui liste les 5 étapes avant de commencer.
- **Mesure sans traceur** : uniquement les données déjà en base (première course, Premiers pas complets…) et, en
  agrégé, `user_tours` (annexe A) ; aucun écran de suivi, aucune mesure d'audience.

---

## 3. Modèle de données (migration `20260924007800_guided_tour.sql`)

Numéro : dernier de `supabase/migrations` = `20260924007700` → **`20260924007800`** (contrôlé par
`packages/shared/src/migrations.test.ts` et `deploy/migrate.sh`). Nouvelle fonction, aucune redéfinition : pas de ligne
« Dernière définition » à écrire (vérifié : aucune `save_user_tour` existante).

```sql
-- Visite guidée de première connexion (docs/TUTORIEL.md) : progression par utilisateur et par parcours.
-- Préférence d'interface : aucune donnée métier, jamais lue par un autre compte (pas même le super admin), effacée avec
-- le compte (cascade). Écriture par public.save_user_tour seulement (security definer, utilisateur connecté).

create table public.user_tours (
  user_id uuid not null references public.users (id) on delete cascade,
  tour text not null
    check (tour in ('super_admin', 'fleet', 'centrale', 'dispatcher', 'private_fleet')),
  status text not null default 'active'
    check (status in ('active', 'paused', 'completed')),
  step smallint not null default 0
    check (step between 0 and 4),
  shown_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, tour)
);
comment on table public.user_tours is
  'Visite guidée du tableau de bord et du super admin (docs/TUTORIEL.md) : parcours, étape en cours, état. Écriture : save_user_tour.';
comment on column public.user_tours.step is 'Étape en cours : 0 (première) à 4 (cinquième)';
comment on column public.user_tours.shown_at is 'Première ouverture de la visite ; nul : jamais ouverte (compte antérieur à la visite)';
comment on column public.user_tours.completed_at is 'Première fin de la visite (gardée si elle est revue)';

alter table public.user_tours enable row level security;
create policy user_tours_select_own on public.user_tours for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on public.user_tours from anon, authenticated, service_role;
grant select on public.user_tours to authenticated;

-- Seule écriture : l'utilisateur connecté, sur SES lignes. Valeurs posées par le code du web (jamais saisies) et
-- contrôlées par les contraintes de la table (23514 / 23502 sinon) ; aucun code d'erreur nouveau (FORBIDDEN* exempté
-- de ERROR_MESSAGES).
create or replace function public.save_user_tour(p_tour text, p_status text, p_step integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.user_tours;
begin
  if v_uid is null then
    raise exception 'FORBIDDEN: authentification requise' using errcode = '42501';
  end if;
  insert into public.user_tours as t (user_id, tour, status, step, shown_at, completed_at, updated_at)
  values (v_uid, p_tour, p_status, p_step, now(), case when p_status = 'completed' then now() end, now())
  on conflict (user_id, tour) do update
     set status = excluded.status,
         step = excluded.step,
         shown_at = coalesce(t.shown_at, excluded.shown_at),
         completed_at = coalesce(t.completed_at, excluded.completed_at),
         updated_at = now()
  returning t.* into v_row;
  return jsonb_build_object('tour', v_row.tour, 'status', v_row.status, 'step', v_row.step,
    'shown_at', v_row.shown_at, 'completed_at', v_row.completed_at);
end;
$$;
revoke execute on function public.save_user_tour(text, text, integer) from public, anon;
grant execute on function public.save_user_tour(text, text, integer) to authenticated;

-- rattrapage : début
-- Comptes existant avant la visite : leur première connexion est passée → ni ouverture d'office ni accueil ; la visite
-- reste proposée dans le menu du compte (« Reprendre la visite », qui ouvre alors l'accueil). shown_at nul : jamais ouverte.
insert into public.user_tours (user_id, tour, status, step)
select u.id, t.tour, 'paused', 0
  from public.users u
 cross join (values ('super_admin'), ('fleet'), ('centrale'), ('dispatcher'), ('private_fleet')) as t (tour)
 where u.is_super_admin
    or exists (select 1 from public.organization_users ou where ou.user_id = u.id)
on conflict (user_id, tour) do nothing;
-- rattrapage : fin
```

Sens des colonnes :

| Colonne | Sens | Écrite par |
|---|---|---|
| `tour` | parcours (§ 5.1) | RPC |
| `status` | `active` (visite en cours, rouverte à chaque chargement sauf urgence), `paused` (fermée ou « Plus tard »), `completed` (terminée) | RPC |
| `step` | index de l'étape en cours (0 à 4) ; une étape retirée plus tard est ramenée dans les bornes à la lecture | RPC |
| `shown_at` | première ouverture (accueil ou étape) ; nul = jamais ouverte (rattrapage) | RPC (`coalesce`) |
| `completed_at` | première fin ; gardée si la visite est revue | RPC (`coalesce`) |

Notes :

- SQL éprouvé à la conception (11/10/2026) sur la base locale « rydar », dans une transaction **annulée** : rattrapage de
  35 lignes (7 comptes × 5 parcours, `shown_at` nul) ; écritures successives (`shown_at` gardé, `completed_at` posé puis
  gardé) ; un compte ne voit que ses 5 lignes ; écriture directe refusée ; étape 5 et parcours inconnu refusés (23514) ;
  `FORBIDDEN` sans utilisateur ; EXECUTE refusé à anon ; `prosecdef` vrai et `search_path=""`.
- Un index de plus est inutile : la clé primaire `(user_id, tour)` sert la seule lecture (§ 4.2).
- Les cascades de clé étrangère s'exécutent avec les droits du propriétaire de la table : la suppression d'un compte
  (Auth → `public.users`) efface ses lignes sans droit donné au service role.
- Sur une base neuve (CI, `scripts/local-stack/setup.sh`), le rattrapage ne voit aucun compte : les migrations passent
  **avant** le seed, donc chaque compte du seed verra la visite à sa première connexion (normal ; voir § 11.3 et
  annexe A pour les recettes). Sur la base locale « rydar » déjà remplie, la migration appliquée à la main avec `psql`
  met les comptes du seed en pause.

---

## 4. Écriture et lecture

### 4.1 RPC `public.save_user_tour(p_tour text, p_status text, p_step integer) → jsonb`

- `security definer`, `search_path = ''`, EXECUTE : `authenticated` seulement (révoqué de `public` et `anon`).
- Refus `42501 FORBIDDEN: authentification requise` sans `auth.uid()` (service role compris : il n'a pas d'utilisateur).
- Contrôle d'accès = **l'utilisateur connecté n'écrit que ses lignes** (`user_id = auth.uid()` posé par la fonction, jamais
  reçu en paramètre). Aucune donnée d'organisation n'est lue ni écrite : rien d'autre à contrôler.
- Valeurs hors liste ou hors bornes → violations de contrainte (`23514`, `23502`, `22003`) ; l'action serveur les rend
  impossibles en amont (schéma partagé, § 4.4).
- Pas d'audit : préférence d'interface, aucune donnée métier ni action sensible.

### 4.2 Lecture par les mises en page (une requête, en parallèle des autres)

- `app/dashboard/layout.tsx` (dans `commonReads`) et `app/admin/layout.tsx` (en parallèle de `getAdminTodo`) :
  `supabase.from("user_tours").select("status, step, shown_at").eq("user_id", <utilisateur>).eq("tour", <parcours>).maybeSingle()`,
  sous RLS (politique `user_tours_select_own`).
- Résultat converti par `tourSavedFrom(data, error)` (§ 4.4) : `undefined` = lecture impossible, `null` = aucune ligne
  (jamais vue), sinon `{ status, step, shown }`.
- Les mises en page **ne se rendent pas à chaque navigation** (« Layouts preserve state, remain interactive, and do not
  re-render on navigation », `node_modules/next/dist/docs/01-app/04-glossary.md`) : la valeur lue n'est qu'un point de
  départ ; ensuite l'état du fournisseur (client) fait foi et chaque changement est enregistré (§ 6.2).

### 4.3 Action serveur `saveTourProgress` (`apps/web/app/visite/actions.ts`, nouveau)

```ts
"use server";
// Visite guidée (docs/TUTORIEL.md § 4.3) : enregistre la progression de l'utilisateur connecté (save_user_tour, RLS).
export async function saveTourProgress(input: { tour: string; status: string; step: number }): Promise<{ ok: true } | { ok: false; error: string }>
```

- Valide `input` par `tourProgressSchema` (`@rydar/shared`) → sinon `{ ok: false, error: "Visite guidée : étape inconnue." }`.
- `requireUser()` (`lib/auth.ts`) puis `session.supabase.rpc("save_user_tour", { p_tour, p_status, p_step })` ; erreur →
  `{ ok: false, error: actionError(error, "Progression de la visite non enregistrée.") }`.
- Aucun `revalidatePath` (rien d'affiché par le serveur ne dépend de la progression après le premier rendu), ni client
  service role, ni `audit()`. Fichier « use server » : une seule exportation, asynchrone.
- Emplacement neutre (`app/visite/`, sans `page.tsx` : aucune route) car l'action sert aux deux espaces, comme
  `app/login/actions.ts` (`signOut`).

### 4.4 Paquet partagé (`packages/shared/src/tour.ts`, nouveau, exporté par `index.ts`)

```ts
import { z } from "./zod";
import type { OrgRole } from "./domain";
import type { DispatchModel } from "./types";

export const TOUR_KEYS = ["super_admin", "fleet", "centrale", "dispatcher", "private_fleet"] as const;
export type TourKey = (typeof TOUR_KEYS)[number];
export const TOUR_STATUSES = ["active", "paused", "completed"] as const;
export type TourStatus = (typeof TOUR_STATUSES)[number];
/** Étapes au plus par parcours (contrainte step between 0 and 4 de public.user_tours) */
export const TOUR_MAX_STEPS = 5;

export const tourProgressSchema = z.object({
  tour: z.enum(TOUR_KEYS),
  status: z.enum(TOUR_STATUSES),
  step: z.number().int().min(0).max(TOUR_MAX_STEPS - 1),
});

/** Parcours d'un membre dans son espace (§ 5.1). */
export function tourKeyFor(i: { privateFleet: boolean; model: DispatchModel | null | undefined; role: OrgRole }): TourKey;

/** Ligne lue par une mise en page → progression : undefined = lecture impossible ; null = jamais vue. */
export type TourSaved = { status: TourStatus; step: number; shown: boolean };
export function tourSavedFrom(
  row: { status: string; step: number; shown_at: string | null } | null | undefined,
  error: unknown,
): TourSaved | null | undefined;
```

Pourquoi dans le paquet partagé : les mises en page l'importent comme module de paquet (aucune simulation `@/…` à
ajouter dans `dashboard-layout.test.ts`), et un test du paquet compare ces listes aux contraintes de la migration
(comme `private-fleet-sql.test.ts`). Rien de nouveau n'est importé par l'app chauffeur.

### 4.5 Données personnelles

- Nature : donnée de fonctionnement du compte (comme `users.last_active_org_id`), minimale (parcours, étape, état, trois
  dates), sans profilage ni usage commercial ; base légale : exécution du contrat (6.1.b).
- Lecture : l'utilisateur seul (RLS) ; aucune politique super admin ; aucune exportation.
- Conservation : durée de vie du compte (cascade).
- `docs/RGPD-REGISTRE.md` (T1) : ajouter « progression de la visite guidée (parcours, étape, dates) » aux données de la
  ligne « Comptes et facturation des centrales ». Pages légales publiques : inchangées par les lots (§ 13.1, point 2).
- Aucune nouvelle clé de stockage du navigateur → `/cookies` inchangé.

---

## 5. Déclenchement

### 5.1 Quel parcours pour qui (`tourKeyFor`)

| Espace | Condition | Parcours |
|---|---|---|
| `/admin` (super admin) | toujours | `super_admin` |
| `/dashboard` | organisation Flotte Privée (`isPrivateFleet`) | `private_fleet` |
| `/dashboard` | rôle `dispatcher` (flotte ou centrale) | `dispatcher` |
| `/dashboard` | rôle `owner` ou `admin`, modèle `centrale` | `centrale` |
| `/dashboard` | rôle `owner` ou `admin`, modèle `fleet` (ou absent) | `fleet` |

Un compte membre de plusieurs organisations du même type voit le parcours une fois ; un changement de modèle (flotte ↔
centrale, passage en ou hors Flotte Privée) ou de rôle mène à un autre parcours, donc à sa propre première ouverture
(sauf comptes rattrapés à la migration, § 3). Un super admin aussi membre d'une centrale a deux parcours, un par espace.

### 5.2 Quand la visite s'ouvre d'elle-même

- Au premier rendu de l'espace, si le parcours n'a **aucune ligne** (`saved === null`) : **accueil** (§ 7.1), et la
  ligne est créée aussitôt (`active`, étape 0, `shown_at`) → l'ouverture d'office n'a lieu qu'une fois.
- Si la ligne est `active` : la fenêtre se rouvre à l'étape enregistrée, à chaque chargement complet, jusqu'à ce que
  l'utilisateur la ferme (pause) ou la termine.
- Délai : après le montage du client et la stabilisation de la page (environ 400 ms), jamais pendant l'hydratation.
- Jamais si la lecture a échoué (`saved === undefined`) : seule l'entrée du menu est proposée.

### 5.3 Ce qui bloque (acceptation) et ce qui diffère (urgence)

| Situation (déjà calculée par la mise en page) | Effet sur la visite |
|---|---|
| `gate` : `OrgTermsGate` à la place de la page (owner / admin, CGV jamais acceptées) | **bloquée** : ni fenêtre, ni entrée de menu |
| `termsBanner.kind === "org"` (mise à jour des CGV à accepter) | **bloquée** |
| `termsBanner.kind === "user"` (CGU + confidentialité à accepter, dispatcher compris) | **bloquée** |
| Bandeau de nouvelle convention du réseau partagé (`networkTerms`, owner / admin) | **différée** (pas d'ouverture d'office ; menu disponible) |
| Organisation standard : courses sans chauffeur des 6 dernières heures et à venir (`count` de la mise en page, pastille rouge de « Courses ») > 0 | **différée** |
| Flotte Privée : réservations à traiter (`queue.toTreat`) > 0 | **différée** |
| Super admin : signalements de fraude à examiner ou suppressions de compte en échec (pastilles rouges, `adminNavCounts`) > 0 | **différée** |
| Fenêtre modale ouverte (dialogue, tiroir, `OrgSwitchedDialog`) | la fenêtre de visite (z-40) reste dessous ; elle ne se ferme pas |

- **Bloquée** = `blocked: gate || termsBanner !== null` ; dès l'acceptation (`router.refresh()` de `AcceptBanner`), la
  mise en page se rend de nouveau, `blocked` devient faux et l'ouverture d'office est évaluée sans rechargement.
- **Différée** = `urgent: true` : la visite ne s'ouvre pas d'elle-même (ni accueil, ni reprise d'une visite `active`) ;
  l'entrée du menu reste, et l'ouverture d'office est retentée au chargement suivant.
- Bandeau rouge « Frais Rydar » (`OrgPlatformBanner`, lu côté client) : non pris en compte ; il ne peut pas exister à la
  première connexion (aucune course, donc aucun frais échu), et la fenêtre, en bas d'écran, ne le recouvre jamais (il est
  en haut du contenu).

### 5.4 Table de démarrage (`initialTourState`, pure, testée)

| `saved` | `blocked` | `urgent` | Fenêtre au chargement | Entrée du menu du compte |
|---|---|---|---|---|
| tout | oui | — | fermée | aucune |
| `undefined` (lecture impossible) | non | — | fermée | « Reprendre la visite » |
| `null` (jamais vue) | non | non | **accueil** (+ écriture `active`, 0) | « Reprendre la visite » |
| `null` | non | oui | fermée | « Reprendre la visite » |
| `active` | non | non | **étape enregistrée** | « Reprendre la visite » |
| `active` | non | oui | fermée | « Reprendre la visite » |
| `paused` | non | — | fermée | « Reprendre la visite » |
| `completed` | non | — | fermée | « Revoir la visite » |

« Reprendre » ouvre l'**accueil** si la visite n'a jamais été ouverte (`saved` nul ou `shown` faux : comptes
rattrapés), sinon l'étape enregistrée ; « Revoir » repart de l'étape 1.

### 5.5 Comptes existants

Le rattrapage de la migration (§ 3) met chaque compte existant (super admin ou membre d'une organisation, quel que soit
son état) en `paused`, `shown_at` nul, pour les cinq parcours : aucune ouverture d'office pour eux, accueil à la
première demande. Décision réversible tant que la migration n'est pas poussée (§ 13.1, point 1).

---

## 6. Moteur de visite

### 6.1 Fichiers (`apps/web/components/tour/`, nouveau dossier ; voisins importés par chemin relatif `./…`)

| Fichier | Rôle | Lot |
|---|---|---|
| `tour-model.ts` (+ `tour-model.test.ts`) | Pur, ni « use client » ni « server-only » : types (`TourBoot`, `TourState`, `TourEvent`), `initialTourState`, `tourReducer`, `tourPersist`, `tourMenuItem`, `samePage`, `tourFooter`, `dockedRect`, textes du moteur `TOUR_UI` (§ 6.10). | T2 |
| `tour-content.ts` | Données des 5 parcours (§ 7) : accueil, étapes (titre, texte, écran, libellé du lien, ancre, condition). Textes passés par `fr()` (`components/marketing/typo.ts`). | T2 (recopie du § 7) ; T3 (contrôle et ajustements) |
| `tour-checks.ts` (+ `tour-checks.test.ts` en T3) | `CheckKey`, `TourChecks`, `loadTourChecks(client, keys, scope)` (§ 8). En T2 : types et fonction qui renvoie `{}` (tout « inconnu ») ; lectures écrites en T3. | T2 (squelette) ; T3 |
| `tour-provider.tsx` | « use client » : contexte, état (`useReducer`), écritures en série (§ 6.2), ouverture d'office, relecture des conditions (§ 6.9), `useTourMenu()` pour le menu du compte. | T2 |
| `tour-card.tsx` | « use client » : fenêtre (Radix Popover), modes ancrée / repli centré / réduite, ancre et surlignage, focus, Échap, téléphone. Chargée à la demande (`next/dynamic`, `ssr: false`, `node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md`) : rien à télécharger tant que la visite est fermée. | T2 |
| `tour-panel.tsx` (+ `tour-panel.test.ts`) | Contenu de la fenêtre, sans logique (en-tête, titre, texte, « C'est fait. », boutons) : testable par `renderToStaticMarkup`. | T2 |
| `tour-dom.ts` | Aides DOM : `findAnchor(id)`, `isVisible(el)`, `focusTarget(el)`, `avoidTop()` ; la part pure (`dockedRect`) est dans `tour-model.ts`. | T2 |
| `tour-content.test.ts` | Contrôle statique des parcours (§ 11.1). | T3 |

### 6.2 États et événements (`tourReducer`, pur)

`TourState = { view: "closed" | "intro" | "step"; status: TourStatus | null; step: number; shown: boolean; minimized: boolean }`

Numérotation : dans le code et en base, les étapes comptent à partir de 0 (`step` 0 à 4) ; à l'écran, « étape 1 sur 5 »
est l'étape 0. Dans ce document, « étape n » d'un tableau d'événements est l'index ; « étape 1 » d'un texte est la
première étape affichée.

| Événement | Origine | Vue après | Écrit (`status`, `step`) |
|---|---|---|---|
| `shown` | affichage de l'accueil (ouverture d'office ou « Reprendre » d'une visite jamais ouverte) | accueil | `active`, 0 |
| `start` | « Commencer » | étape 0 | — (déjà `active`, 0) |
| `later` | « Plus tard » ou Échap / « × » sur l'accueil | fermée | `paused`, 0 |
| `next` | « Suivant » ou « Passer l'étape » (étape n < dernière) | étape n + 1 | `active`, n + 1 |
| `prev` | « Précédent » (n > 0) | étape n − 1 | `active`, n − 1 |
| `finish` | « Terminer » (dernière étape) | fermée | `completed`, n |
| `close` | « × » ou Échap (focus dans la fenêtre) | fermée | `paused`, n |
| `minimize` / `expand` | « Réduire » / pastille | pastille / étape | — (état d'écran seulement, jamais enregistré) |
| `resume` | menu du compte | accueil si jamais ouverte ; étape 0 si `completed` ; sinon étape n | `active`, n (ou 0) |
| `autostart` | fournisseur (§ 5.2) | accueil ou étape enregistrée | (`shown` pour l'accueil) |

- `tourPersist(prev, next)` renvoie l'écriture à faire, ou `null` si `status` et `step` n'ont pas changé.
- **Écritures en série** : une seule action `saveTourProgress` à la fois, dans `start(() => runAction(…))` ; si l'état
  change pendant un envoi, seul le dernier état est envoyé ensuite. Échec (`ok: false` ou exception) : un seul toast par
  session (`TOUR_UI.saveError`) ; la visite continue (l'état du client fait foi jusqu'au prochain chargement).
- Toasts (sonner, déjà monté) : `close` et `later` → `TOUR_UI.paused` ; `finish` → `TOUR_UI.finished`.
- Le fournisseur est **clé** par `${userId}:${tour.key}` (changement d'organisation ou de rôle = nouvel état) ; il
  s'initialise une fois depuis `boot.saved` et lit `boot.blocked` / `boot.urgent` à chaque rendu : quand `blocked` ou
  `urgent` passe de vrai à faux sans que la visite ait déjà été ouverte d'office dans la session, l'ouverture d'office
  est réévaluée (cas de l'acceptation des CGV, § 5.3).

### 6.3 Fenêtre : ancrée, repli centré, réduite

Un seul composant, `TourCard` : `Popover.Root` de `radix-ui` (déjà utilisé : `components/command/command-center.tsx`,
`components/alerts/dispatch-alerts.tsx`), `modal={false}`, `open` contrôlé (`view !== "closed" && !minimized`),
`Popover.Anchor virtualRef={…}` (prise en charge vérifiée : `node_modules/@radix-ui/react-popper/dist/index.d.ts`,
`virtualRef?: React.RefObject<Measurable | null>` ; avec `virtualRef`, l'ancre ne rend rien et est relue à chaque
rendu : changer d'objet suffit pour passer d'une cible à l'autre ou au repli), contenu dans `Popover.Portal`. Laisser
`updatePositionStrategy` à sa valeur par défaut (`optimized`) : jamais de recalcul à chaque image.

| Mode | Quand | Position |
|---|---|---|
| **ancrée** | ancre de type `control` trouvée et visible, écran ≥ 640 px | `virtualRef = { getBoundingClientRect: () => cible.getBoundingClientRect(), contextElement: cible }` ; `side` / `align` de l'étape (défaut `bottom` / `start`) ; `sideOffset={12}` ; `collisionPadding={16}` ; `avoidCollisions` (bascule de côté gérée par Radix) |
| **repli centré** | accueil ; ancre de type `zone` ; ancre absente ou cachée ; écran < 640 px | rectangle virtuel de largeur nulle, **centré horizontalement sur `main#contenu`** (à défaut la fenêtre), à 16 px (< 640 px) ou 24 px (≥ 640 px) du bas, **remonté au-dessus** de tout `[data-tour-avoid]` visible dont le haut est dans la moitié basse de l'écran (`dockedRect`, pur et testé) ; `contextElement` = `main#contenu` (la position suit défilement et redimensionnement) ; `side="top" align="center"` |
| **réduite** | « Réduire » | pastille fixe en bas à gauche de `main#contenu` (16 px), même remontée ; les notifications (sonner) sont en bas à droite |

- Taille : `w-[min(24rem,calc(100vw-2rem))]`, `max-h-[min(32rem,70dvh)] overflow-y-auto` ; `rounded-2xl border
  border-line-strong bg-ink-700 p-4 shadow-float` ; **`z-40`** : sous les fenêtres (`z-50`) et menus (`z-60`), au-dessus
  de la barre du haut sur téléphone (`z-30`). Aucune animation en boucle ; une seule apparition en fondu sous
  `motion-safe:` au plus.
- **Réserve de défilement** : tant que la fenêtre est en repli centré et dépliée, le moteur pose
  `--tour-reserve: <hauteur de la fenêtre + écart>px` sur `document.documentElement` ; `main#contenu` des deux coquilles
  reçoit `pb-[var(--tour-reserve,0px)]` : le bas d'une page qui défile peut toujours passer au-dessus de la fenêtre.
  Les vues pleine hauteur (En direct, Messages) portent `data-tour-fullheight` à leur racine : le moteur n'y pose pas de
  réserve (elles ne défilent pas). Variable retirée à la réduction, à la fermeture et au démontage.
- La fenêtre ne se ferme jamais d'elle-même : `onInteractOutside`, `onPointerDownOutside` et `onFocusOutside` →
  `preventDefault()`.

### 6.4 Ancre, surlignage, défilement

- **Ancre** : `document.querySelector('[data-tour="<id>"]')`, retenue si visible (`getClientRects().length > 0`, aucun
  ancêtre `hidden` ou `inert`). Recherchée au changement d'étape, au changement d'adresse (`usePathname`,
  `useSearchParams` sous `<Suspense fallback={null}>`) et par un `MutationObserver` sur `document.body`
  (`childList`, `subtree`, regroupé à 150 ms), actif seulement quand la fenêtre est dépliée sur une étape ; passage
  téléphone / bureau suivi par `matchMedia("(min-width: 640px)")`.
- **Surlignage** : attribut `data-tour-highlight=""` posé sur la cible tant que la fenêtre est dépliée sur son étape,
  retiré au changement d'étape, à la réduction, à la fermeture et au démontage (une cible remontée par React est
  retrouvée par l'observateur). Règle de `apps/web/app/globals.css`, dans `@layer components` (comme les règles à
  attributs de la carte, `.rd-car[data-selected="true"]`) :
  `[data-tour-highlight] { outline: 2px solid var(--color-brand); outline-offset: 3px; scroll-margin-top: 5rem; scroll-margin-bottom: 1rem; }`
  — statique, aucune transition. Une cible dans un parent `overflow-hidden` peut avoir un contour rogné : sans gêne, la
  fenêtre reste lisible.
- **Défilement** : seulement après un clic dans la fenêtre (Commencer, Ouvrir, Suivant, Passer, Précédent, Y aller,
  Reprendre) et une fois par clic, quand l'ancre est trouvée : `scrollIntoView({ block: zone ? "start" : "center",
  behavior: réduire les animations ? "auto" : "smooth" })`. Jamais pendant que l'utilisateur fait autre chose.
- **« Y aller »** : défilement puis focus sur le premier élément focalisable de la cible (`a[href]`,
  `button:not([disabled])`, `input:not([type=hidden]):not([disabled])`, `select`, `textarea`,
  `[tabindex]:not([tabindex="-1"])`), sinon sur la cible elle-même avec `tabIndex=-1` temporaire (retiré au `blur`).

### 6.5 Boutons de la fenêtre (`tourFooter`, pur, testé)

« Bon écran » = ancre visible, ou `samePage(étape.href, pathname, search)` (même chemin, et chaque paramètre de
l'adresse de l'étape présent avec la même valeur). Ordre du code : secondaires puis principal (un seul bouton plein) ;
sous 640 px, le principal passe en haut, pleine largeur (comme `DialogFooter`).

| Cas | Boutons |
|---|---|
| Accueil | « Plus tard » (secondaire) · **« Commencer »** |
| Étape faite (« C'est fait. ») | « Précédent » (discret, absent à l'étape 1) · **« Suivant »** ou **« Terminer »** |
| Pas sur le bon écran | « Précédent » · « Passer l'étape » (secondaire ; « Terminer » à la dernière) · **« Ouvrir … »** (libellé de l'étape) |
| Bon écran, ancre visible, condition non remplie | « Précédent » · « Passer l'étape » · **« Y aller »** |
| Bon écran sans condition, ou ancre introuvable | « Précédent » · **« Suivant »** ou **« Terminer »** |

- « Commencer », « Suivant », « Passer l'étape » et « Précédent » sont des **liens** (`<Link prefetch={false}>`) vers
  l'écran de l'étape visée quand il diffère de l'écran actuel (un seul clic : on avance ET on y va), sinon des boutons.
  « Ouvrir … » est toujours un lien. Jamais `router.push`.
- Taille : `min-h-11` sous 640 px, `sm:min-h-9` au-delà ; textes ≥ 12 px.

### 6.6 Clavier, focus, lecteur d'écran

- `Popover.Content` porte `role="dialog"` (non modal) ; `aria-labelledby` = compteur + titre, `aria-describedby` = texte ;
  `data-tour-card=""` (repère des scripts de recette).
- **Focus** : vers le titre (`h2`, `tabIndex={-1}`) à l'ouverture d'office de l'accueil, après chaque action dans la
  fenêtre qui change d'étape, et après « Reprendre » ; **jamais** au simple changement de page (la fenêtre suit, sans
  voler le focus). `onOpenAutoFocus` et `onCloseAutoFocus` → `preventDefault()` : le moteur gère le focus. À la
  fermeture : retour à l'élément qui avait le focus avant la fenêtre s'il existe encore, sinon `main#contenu`.
- **Échap** : ferme (pause) seulement si le focus est dans la fenêtre (`onEscapeKeyDown` → sinon `preventDefault()`) :
  Échap reste à la page (désélection d'En direct, fermeture d'un menu ou d'une fenêtre, qui passent avant car au-dessus).
- Les raccourcis d'En direct (touche N, Échap) ignorent déjà une frappe dans `[role=dialog]`
  (`components/command/command-center.tsx:250`).
- « C'est fait. » est dans un `<p aria-live="polite">` toujours présent (vide sinon) : annoncé quand l'action aboutit.
- Boutons-icônes nommés : « Réduire la visite guidée », « Fermer la visite guidée » ; pastille : `aria-expanded="false"`,
  nom « Afficher la visite guidée, étape 2 sur 5 ».
- Contraste (jetons, mesuré sur `ink-700` #16191f) : `fg` 15,4:1, `fg-muted` 7,1:1, `fg-subtle` 5,6:1, `brand` 13,4:1,
  `green` 9,4:1 ; aucune couleur en dur, aucune opacité sur un texte.
- Ordre de tabulation : la fenêtre est en fin de document (portail) ; on l'atteint après le contenu, ou à tout moment par
  « Reprendre la visite » qui y place le focus. Pas de piège : Tab en sort.

### 6.7 Téléphone (< 640 px)

- Toujours en **repli centré** (16 px de marge de chaque côté, `w-[calc(100vw-2rem)]`), au-dessus des barres
  `[data-tour-avoid]` ; cible surlignée et amenée sous la barre du haut (`scroll-margin-top`).
- Aucun défilement horizontal : `document.documentElement.scrollWidth <= 390` à 390×844, fenêtre ouverte ou réduite.
- Menu du compte dans le tiroir : choisir « Reprendre la visite » **ferme le tiroir**, puis ouvre la fenêtre après deux
  `requestAnimationFrame` (sinon le tiroir rendrait le focus à son bouton après la fenêtre).
- « Réduire » libère l'écran en un toucher ; la pastille fait 44 px de haut.

### 6.8 Coexistence avec l'existant

- **Saisie non enregistrée** (`lib/use-unsaved-guard.ts`, écouteur de clics en capture sur `window`) : les liens de la
  fenêtre sont de vrais `<a href>` → la fenêtre « Quitter sans enregistrer ? » s'ouvre au-dessus (z-50) ; « Retour »
  laisse l'étape inchangée (le clic n'a pas atteint le gestionnaire de la fenêtre) ; « Quitter sans enregistrer »
  reclique le même lien → l'étape avance et la page change.
- **Fenêtres et tiroirs** (z-50) : la fenêtre de visite reste dessous, ne se ferme pas, et redevient visible après.
- **Barres collantes « Enregistrer »** et compositeur de Messages : marquées `data-tour-avoid` (§ 9.2), jamais
  recouvertes par le repli centré.
- **Bandeaux** (CGU / CGV, réseau partagé, Frais Rydar) : en haut du contenu ; la fenêtre en repli est en bas ; une
  acceptation en cours bloque la visite (§ 5.3).
- **Notifications** (sonner, en bas à droite) : passagères ; la pastille est à gauche.
- **Temps réel** : le fournisseur est dans `RealtimeProvider` côté tableau de bord ; côté super admin, pas de canal
  (`useRealtimeEvent` sans effet, `useLiveSync` en sondage).

### 6.9 Relecture des conditions de réussite

`loadTourChecks(getBrowserClient(), clésDuParcours, scope)` (§ 8), seulement quand la fenêtre est dépliée sur une étape
et l'onglet visible :

- à l'ouverture et à chaque changement d'étape ;
- à chaque changement d'adresse (chemin ou paramètres) ;
- après tout envoi de formulaire dans la page (écouteur `submit` en capture sur `document` : relecture 1,5 s puis 5 s
  après) — les actions des étapes sont des formulaires (`submitWith`) ;
- sur les événements `ride.updated` et `driver.updated` (tableau de bord) ;
- en secours, par `useLiveSync` (`pollMs: 15_000`, `maxPollMs: 60_000`, `livePollMs: 30_000`, `debounceMs: 600`).

Clé illisible ou absente = « inconnue » : pas de « C'est fait. », le bouton principal reste celui de l'action. Un
changement d'organisation sans changement de parcours (deux flottes, par exemple) garde le fournisseur mais change
`scope.orgId` : les conditions sont alors relues (dépendance de l'effet).

### 6.10 Textes du moteur (`TOUR_UI`, typographie par `fr()`)

| Clé | Texte |
|---|---|
| `name` | Visite guidée |
| `counter` | Visite guidée · étape {n} sur {total} |
| `resume` / `replay` | Reprendre la visite / Revoir la visite |
| `start` / `later` | Commencer / Plus tard |
| `prev` / `skip` / `next` / `finish` / `goto` | Précédent / Passer l'étape / Suivant / Terminer / Y aller |
| `done` | C'est fait. |
| `minimize` / `close` / `expand` | Réduire la visite guidée / Fermer la visite guidée / Afficher la visite guidée, étape {n} sur {total} |
| `pill` | Visite guidée · {n}/{total} |
| `paused` | Visite en pause : reprenez-la depuis votre nom, en bas du menu. |
| `finished` | Visite terminée : vous pouvez la revoir depuis votre nom, en bas du menu. |
| `saveError` | Progression de la visite non enregistrée : elle pourra revenir plus tard. |

« Y aller » porte un complément pour les lecteurs d'écran (`sr-only` : « : {titre de l'étape} »).

### 6.11 Intégration dans la coquille et les mises en page (T2)

- **`TourBoot`** (type, `tour-model.ts`) :
  `{ key: TourKey; saved: TourSaved | null | undefined; blocked: boolean; urgent: boolean; scope: { userId: string; orgId: string | null; driverId: string | null } }`.
- **`app/dashboard/layout.tsx`** : `tourKeyFor({ privateFleet, model: ctx.org.dispatch_model ?? "fleet", role: ctx.role })` ;
  la lecture du § 4.2 dans `commonReads` ; puis
  `tour={{ key, saved: tourSavedFrom(row.data, row.error), blocked: gate || termsBanner !== null, urgent: (privateFleet ? (queue?.toTreat ?? 0) : (count ?? 0)) > 0 || !!networkTerms, scope: { userId: ctx.user.id, orgId: ctx.org.id, driverId: ctx.driverId } }}`
  passé à `DashboardShell`. Type importé par `import type` (effacé : aucune simulation à ajouter au test).
- **`app/admin/layout.tsx`** : lecture du § 4.2 en parallèle de `getAdminTodo` ;
  `tour={{ key: "super_admin", saved, blocked: false, urgent: (counts.openReports ?? 0) > 0 || (counts.deletionsToReview ?? 0) > 0, scope: { userId: session.user.id, orgId: null, driverId: null } }}`.
- **`DashboardShell` / `AdminShell`** : propriété facultative `tour?: TourBoot | null` (absente : aucune visite, rendu
  inchangé — `admin-pages.test.ts` rend `AdminShell` sans elle). `<TourProvider boot={tour}>` entoure le corps de la
  coquille (côté tableau de bord : à l'intérieur de `RealtimeProvider` et `CentraleProvider`) ; le corps appelle
  `useTourMenu()` et passe `accountItems` à `Sidebar`. `main#contenu` reçoit `pb-[var(--tour-reserve,0px)]`.
- **`Sidebar`** (ajout rétrocompatible) : propriété facultative
  `accountItems?: { key: string; label: string; icon: React.ReactNode; onSelect: () => void }[]`, rendue dans le menu du
  compte avant « Se déconnecter », suivie d'un `DropdownMenuSeparator` ; dans le tiroir, le choix ferme le tiroir puis
  appelle `onSelect` après deux `requestAnimationFrame` ; `DropdownMenuContent` reçoit
  `onCloseAutoFocus={(e) => itemChoisi && e.preventDefault()}`. Aucune nouvelle importation `@/…` dans `sidebar.tsx`
  (l'icône `Compass` de `lucide-react` est passée par l'appelant).

---

## 7. Contenu des parcours

### 7.1 Règles de rédaction (contrôlées par `tour-content.test.ts`, T3)

- 5 étapes au plus (`TOUR_MAX_STEPS`) ; identifiants d'étape uniques.
- Titre ≤ 40 caractères ; texte ≤ 180 caractères, une ou deux phrases ; libellé du lien ≤ 32 caractères, commençant par
  « Ouvrir ».
- Accueil : titre ≤ 48 caractères ; texte ≤ 180 caractères, commençant par le nombre d'étapes en lettres (« Cinq
  étapes ») ; la fenêtre d'accueil liste en plus les titres des étapes (`<ol>`).
- Typographie : textes écrits avec des espaces ordinaires et passés par `fr()` (espace insécable avant « : ; ! ? » et
  dans les guillemets) ; aucun « espace ordinaire + ponctuation double » dans les données finales.
- Lexique de la refonte (§ 4) ; jamais : « dashboard », « tenant », « rattacheur », « Option 1 / 2 », « push »,
  « Instantanée », « Créer et dispatcher », « frais plateforme », « webhook », « API ».
- Chaque ancre existe dans le code (§ 9) ; chaque adresse correspond à une page existante et à des paramètres connus
  (`tab` ∈ onglets des Réglages, `filter` ∈ `RIDE_FILTERS`) ; un parcours n'envoie que vers des pages ouvertes à son
  profil (dispatcher : entrées de son menu ; Flotte Privée : entrées de son menu et `/dashboard/settings`).
- Phrase de pause commune : « Vous pouvez arrêter à tout moment : la visite se reprend depuis votre nom, en bas du
  menu. » (le nom et l'e-mail de l'utilisateur sont le bouton du menu du compte, en bas de la barre et du tiroir).

Chaque tableau donne : n°, identifiant, **titre**, texte, écran (adresse), libellé du lien, ancre (type, côté), condition
de réussite (§ 8). Les faits cités ont été vérifiés dans le code : la référence entre crochets ne fait pas partie du
texte affiché.

### 7.2 Super admin (`super_admin`)

Accueil — **Bienvenue dans l'espace super admin** : « Cinq étapes pour préparer la plateforme avant votre premier
client. Vous pouvez arrêter à tout moment : la visite se reprend depuis votre nom, en bas du menu. »

| # | Id | Titre | Texte | Écran | Lien | Ancre | Condition |
|---|---|---|---|---|---|---|---|
| 1 | `sa-legal` | Vos informations légales | Raison sociale, siège et immatriculation de Rydar : sans elles, aucun client ne peut accepter les CGV. Complétez « Éditeur », puis « Enregistrer ». [`LEGAL_EDITOR_MISSING`, 007400 ; `legal-form.tsx`] | `/admin/legal` | Ouvrir Informations légales | `sa-legal-editor` (zone) | `legal_editor` |
| 2 | `sa-billing` | Vos coordonnées de paiement | IBAN ou lien de paiement : vos clients les voient quand ils vous doivent des frais Rydar. WhatsApp et mini-sites se règlent sur la même page, si besoin. [`admin-billing.tsx`, `/admin/reglages`] | `/admin/reglages` | Ouvrir les réglages | `sa-billing` (zone) | `platform_billing` |
| 3 | `sa-plans` | Vos offres | Une offre fixe ce qu'un client peut utiliser : chauffeurs, courses, options. Facultatif : sans offre, un client n'a aucune limite. [`app/admin/plans/page.tsx`] | `/admin/plans` | Ouvrir Offres & limites | `sa-new-plan` (contrôle, bas, fin) | `plans` |
| 4 | `sa-client` | Votre premier client | « Nouveau client » : flotte, centrale à commission ou Flotte Privée. Le propriétaire reçoit un e-mail pour choisir son mot de passe, puis accepte les CGV. [`new-client.tsx` ; « Par défaut, le propriétaire reçoit un e-mail… », `admin-widgets.tsx`] | `/admin/organizations` | Ouvrir Clients | `sa-new-client` (contrôle, bas, fin) | `clients` |
| 5 | `sa-daily` | Chaque jour | « À traiter » liste ce qui attend votre décision : paiements à confirmer, signalements, demandes. Un client signale un problème ? Regardez Supervision. [`admin-todo.ts`] | `/admin` | Ouvrir Vue d'ensemble | `sa-todo` (zone) | — |

### 7.3 Gérant de flotte (`fleet`, propriétaire ou administrateur)

Accueil — **Bienvenue sur Rydar Drive** : « Cinq étapes pour régler votre flotte et créer votre première course. Vous
pouvez arrêter à tout moment : la visite se reprend depuis votre nom, en bas du menu. »

| # | Id | Titre | Texte | Écran | Lien | Ancre | Condition |
|---|---|---|---|---|---|---|---|
| 1 | `fl-identity` | Identité de votre entreprise | Raison sociale, SIRET, adresse et n° d'inscription VTC : ils figurent sur vos factures et dans l'application chauffeur. [`organization-form.tsx`] | `/dashboard/settings?tab=org` | Ouvrir Organisation | `org-identity` (zone) | `org_identity` |
| 2 | `fl-pricing` | Vos tarifs | Votre grille calcule le prix proposé à chaque nouvelle course ; il reste modifiable. Remplissez au moins la catégorie de vos véhicules. [`pricing-editor.tsx`] | `/dashboard/settings?tab=pricing` | Ouvrir Tarifs | `pricing-grid` (zone) | `pricing` |
| 3 | `fl-drivers` | Vos chauffeurs | « Ajouter un chauffeur » : il reçoit un e-mail ou les identifiants que vous lui donnez, puis se connecte à l'application Rydar Drive. [`driver-form-sheet.tsx`] | `/dashboard/drivers` | Ouvrir Chauffeurs | `drivers-add` (contrôle, bas, fin) | `drivers` |
| 4 | `fl-ride` | Votre première course | « Nouvelle course » : elle est proposée aux chauffeurs proches. Suivez-la ici ; l'onglet « À traiter » signale ce qui demande votre aide. [`command-center.tsx`] | `/dashboard` | Ouvrir En direct | `live-new-ride` (contrôle, droite, début) | `first_ride` |
| 5 | `fl-team` | Votre équipe | Invitez un dispatcher ou un administrateur : il reçoit un e-mail pour choisir son mot de passe. Facultatif. [`team-panel.tsx`] | `/dashboard/settings?tab=team` | Ouvrir Équipe | `team-add-member` (contrôle, bas, fin) | `team` |

### 7.4 Gérant de centrale (`centrale`, propriétaire ou administrateur)

Accueil — **Bienvenue sur Rydar Drive** : « Cinq étapes pour régler votre centrale et créer votre première course. Vous
pouvez arrêter à tout moment : la visite se reprend depuis votre nom, en bas du menu. »

| # | Id | Titre | Texte | Écran | Lien | Ancre | Condition |
|---|---|---|---|---|---|---|---|
| 1 | `ce-identity` | Identité de votre entreprise | (texte de `fl-identity`) | `/dashboard/settings?tab=org` | Ouvrir Organisation | `org-identity` (zone) | `org_identity` |
| 2 | `ce-pricing` | Vos tarifs | Votre grille calcule le prix de chaque course. En centrale, le prix est obligatoire : le chauffeur voit sa part avant d'accepter. [`PRICE_REQUIRED`] | `/dashboard/settings?tab=pricing` | Ouvrir Tarifs | `pricing-grid` (zone) | `pricing` |
| 3 | `ce-commission` | Votre commission | Votre part de chaque course, et comment vos chauffeurs vous la règlent : lien de paiement, virement ou espèces. [`centrale-settings-form.tsx`] | `/dashboard/settings?tab=centrale` | Ouvrir la commission | `centrale-commission` (zone) | `settlement` |
| 4 | `ce-drivers` | Vos chauffeurs | Créez votre lien d'inscription et partagez-le : les candidatures arrivent ici. Vous pouvez aussi ajouter un chauffeur depuis Chauffeurs. [`join-link-card.tsx`] | `/dashboard/network` | Ouvrir le lien d'inscription | `join-link` (zone) | `drivers` ou `join_link` |
| 5 | `ce-ride` | Votre première course | « Nouvelle course » : elle est proposée aux chauffeurs proches. Après la course, confirmez la commission reçue dans Encaissements. | `/dashboard` | Ouvrir En direct | `live-new-ride` (contrôle, droite, début) | `first_ride` |

### 7.5 Dispatcher (`dispatcher`, flotte ou centrale)

Accueil — **Bienvenue sur Rydar Drive** : « Cinq étapes pour découvrir les écrans du dispatch. Vous pouvez arrêter à tout
moment : la visite se reprend depuis votre nom, en bas du menu. »

| # | Id | Titre | Texte | Écran | Lien | Ancre | Condition |
|---|---|---|---|---|---|---|---|
| 1 | `di-live` | En direct | La carte montre vos chauffeurs, le panneau les courses du jour. L'onglet « À traiter » signale les retards et les courses sans chauffeur. [onglets « En cours, À venir, À traiter, Chauffeurs »] | `/dashboard` | Ouvrir En direct | `live-panel` (zone) | — |
| 2 | `di-new` | Créer une course | « Nouvelle course », ou la touche N : la course est proposée aux chauffeurs proches, de plus en plus loin si personne n'accepte. [raccourci N ; vagues 4 → 8 → 12 → 16 km] | `/dashboard` | Ouvrir En direct | `live-new-ride` (contrôle, droite, début) | `my_ride` |
| 3 | `di-assign` | Attribuer une course | Le filtre « Sans chauffeur » liste les courses que personne n'a acceptées : ouvrez-en une, puis « Attribuer ». Le chauffeur choisi est prévenu tout de suite. [`RIDE_FILTERS.no_driver`, `ride-actions.tsx`] | `/dashboard/rides?filter=no_driver` | Ouvrir Courses | `rides-filters` (zone) | `my_ride_assigned` |
| 4 | `di-messages` | Messages | Écrivez à un chauffeur ou à toute la flotte. Les messages signalés par les chauffeurs se modèrent ici. [modération ouverte au dispatcher, 004100] | `/dashboard/messages` | Ouvrir Messages | `messages-threads` (zone) | — |
| 5 | `di-journal` | Journal du dispatch | Pour chaque course : chauffeurs prévenus, refus, attributions. Les réglages sont en lecture seule pour vous : demandez au propriétaire ou à un administrateur. [« Lecture seule » des Réglages] | `/dashboard/dispatch` | Ouvrir Journal du dispatch | `dispatch-journal` (zone) | — |

### 7.6 Flotte Privée (`private_fleet`)

La visite **s'appuie sur « Premiers pas »** (entreprise complète, tarifs actifs, documents valides, application utilisée,
site relié : `first-steps.ts`, inchangé) sans le recopier : l'étape 1 désigne la carte et la laisse suivre l'avancement.
Aucune étape vers une page masquée et refusée (Chauffeurs, Inscriptions, Messages, Journal, API & site web…).

Accueil — **Bienvenue dans votre Flotte Privée** : « Cinq étapes pour prendre en main votre espace et confirmer vos
réservations. Vous pouvez arrêter à tout moment : la visite se reprend depuis votre nom, en bas du menu. »

| # | Id | Titre | Texte | Écran | Lien | Ancre | Condition |
|---|---|---|---|---|---|---|---|
| 1 | `fp-first-steps` | Vos premiers pas | Cette liste montre ce qui reste à faire : entreprise, tarifs, documents, application, site. Chaque ligne mène au bon écran ; la liste disparaît quand tout est fait. [`FirstStepsCard`, masquée une fois complète] | `/dashboard` | Ouvrir Accueil | `fp-first-steps` (zone) | — |
| 2 | `fp-confirm` | Confirmer une réservation | Les réservations de votre site arrivent dans « À traiter ». « Je la prends » la confirme, avant l'heure indiquée. Dans l'application : « Confirmer ». [`ToTreat`, « Réponse avant… »] | `/dashboard` | Ouvrir Accueil | `fp-to-treat` (zone) | `fp_taken` |
| 3 | `fp-delays` | Délais et rappels | Le temps que vous avez pour confirmer une réservation, et les rappels avant chaque course. Sans réponse à temps, elle passe « Non confirmée ». [`private-booking-settings.tsx`] | `/dashboard/settings?tab=bookings` | Ouvrir Délais et rappels | `fp-booking-settings` (zone) | — |
| 4 | `fp-agenda` | Votre agenda | Vos réservations par jour, semaine ou mois. Un client vous appelle ? Ajoutez sa réservation avec « Nouvelle réservation (téléphone) ». [`agenda/page.tsx`] | `/dashboard/agenda` | Ouvrir Agenda | `agenda-views` (contrôle, bas, fin) | — |
| 5 | `fp-site` | Mon site | L'état de votre site de réservation et les réservations reçues. Vos prix se règlent dans Tarifs. [`site/page.tsx`, bouton « Vos prix »] | `/dashboard/site` | Ouvrir Mon site | `fp-site-status` (zone) | — |

Quand « Premiers pas » est complet, la carte disparaît : l'étape 1 s'affiche en repli centré et son texte reste juste.

### 7.7 Ce qui n'est pas dans les parcours (5 étapes au plus) et pourquoi

| Sujet du § 10.2 de la refonte | Décision |
|---|---|
| Frais Rydar (flotte, Flotte Privée, « J'ai payé » d'une centrale) | Hors parcours : le bandeau « Frais Rydar » et son menu s'en chargent quand il y a des frais. |
| Zones de recherche du dispatch, API & site web | Hors parcours (réglages avancés, facultatifs) ; joignables par Réglages › Dispatch et le menu. |
| Encaissements (« Reçu », « Pas reçu », relances) | Cité dans l'étape 5 de la centrale ; écran détaillé non visité (aucun paiement avant la première course). |
| Super admin : clé du site d'une Flotte Privée après acceptation des CGV | Hors parcours : la fiche du client Flotte Privée le dit déjà au bon moment. |
| Application chauffeur | Hors tutoriel web (§ 1.1). |

---

## 8. Conditions de réussite (lectures en base)

Lectures faites par `loadTourChecks` avec le client du navigateur (`getBrowserClient()`, RLS de l'utilisateur), en
parallèle, seulement pour les clés du parcours ; comptages en `{ count: "exact", head: true }`. Une lecture en erreur
laisse la clé absente (« inconnue »). Aucune donnée n'est gardée ni envoyée ailleurs.

| Clé | Lecture | Fait si | Politique qui l'autorise (vérifiée) |
|---|---|---|---|
| `legal_editor` | `platform_legal` · `company_name, address, registration` · `.maybeSingle()` | `adminLegalTodo({ error: null, editor: ligne, missingNotices: 0 }).editorMissing === false` (même règle que « À traiter ») | `platform_legal_select` (super admin), 003900 |
| `platform_billing` | `platform_billing` · `iban, payment_link` · `.maybeSingle()` | IBAN ou lien de paiement renseigné (même règle que `BillingCard`) | `platform_billing_select` (super admin), 003000 |
| `plans` | `plans` · `id` · `is_active = true` | au moins 1 | `plans_select` (super admin : tout), 000300 |
| `clients` | `organizations` · `id` · `status <> 'archived'` | au moins 1 | `organizations_select` + grant par colonne (`id`, `status`), 004300 |
| `org_identity` | `organizations` · `legal_name, siret, address, postal_code, city, vtc_registration` · `id = org` | `bookingOperatorGaps(ligne).length === 0` (même règle que la pastille « À compléter » des Réglages) | membre + grant par colonne, 004300 |
| `pricing` | `pricing_rules` · `id` · `organization_id = org`, `is_active = true` | au moins 1 | `pricing_rules_select` (membre), 000300 |
| `drivers` | `drivers` · `id` · `organization_id = org`, `deleted_at is null` | au moins 1 | `drivers_select` (membre), 000300 |
| `join_link` | `organizations` · `join_code, join_enabled` · `id = org` | code non nul et lien actif | membre + grant par colonne, 004300 |
| `settlement` | `organization_settings` · `settlement_methods, settlement_link, settlement_iban, settlement_instructions` · `organization_id = org` | `settlementReady` : un moyen proposé est utilisable (lien + adresse, virement + IBAN, autre + consignes), ou espèces seules choisies (le défaut est « lien + espèces » sans lien) | `organization_settings_select` (membre), 000300 |
| `first_ride` | `rides` · `id` · `organization_id = org` | au moins 1 | `rides_select` (membre), 006700 |
| `team` | `organization_users` · `id` · `organization_id = org` | au moins 2 (le gérant + un membre, invitation comprise) | `organization_users_select` (membre), 005300 |
| `my_ride` | `rides` · `id` · `organization_id = org`, `created_by = utilisateur` (posé par le déclencheur d'insertion, 000400) | au moins 1 | `rides_select` |
| `my_ride_assigned` | idem + `driver_id is not null` | au moins 1 | `rides_select` |
| `fp_taken` | `rides` · `id` · `organization_id = org`, `driver_id = fiche du propriétaire` | au moins 1 (prise par « Je la prends », « Confirmer » ou réservation par téléphone) | `rides_select` |

`stepDone(step, checks)` : `undefined` sans condition ou si toutes les clés de la condition sont inconnues ; `true` si
l'une des clés de `check.any` est vraie ; sinon `false`. Les règles pures (`settlementReady`, `billingConfigured`,
`stepDone`) sont testées (§ 11.1) ; `legal_editor` et `org_identity` réutilisent les fonctions existantes (une seule
source de vérité).

---

## 9. Ancres posées dans les pages (vérifiées sur `a104a75`)

### 9.1 `data-tour` (attribut seul, posé en T3 ; aucun autre changement dans ces fichiers)

| Ancre | Parcours (étape) | Fichier:ligne | Élément | Présent quand |
|---|---|---|---|---|
| `sa-legal-editor` | super admin (1) | `apps/web/components/admin/legal-form.tsx:96` | `<Card>` « Éditeur » | toujours |
| `sa-billing` | super admin (2) | `apps/web/components/platform-fees/admin-billing.tsx:58` | `<Card>` « Coordonnées de paiement de Rydar » | lecture réussie |
| `sa-new-plan` | super admin (3) | `apps/web/components/admin/admin-widgets.tsx:571` | `<Button>` de `PlanEditor` : `data-tour={plan ? undefined : "sa-new-plan"}` (« Nouvelle offre » seulement) | toujours |
| `sa-new-client` | super admin (4) | `apps/web/components/admin/new-client.tsx:49` | `<Button>` « Nouveau client » | toujours |
| `sa-todo` | super admin (5) | `apps/web/app/admin/page.tsx:199` | `<Card id="a-traiter">` | toujours |
| `org-identity` | flotte (1), centrale (1) | `apps/web/components/settings/organization-form.tsx:108` | `<Card>` « Identité de votre entreprise » | onglet `org` |
| `pricing-grid` | flotte (2), centrale (2) | `apps/web/components/settings/pricing-editor.tsx:268` | `<Card>` « Grille tarifaire » | onglet `pricing` |
| `centrale-commission` | centrale (3) | `apps/web/components/settlements/centrale-settings-form.tsx:222` | `<Card>` « Votre commission » | onglet `centrale` |
| `drivers-add` | flotte (3) | `apps/web/components/drivers/driver-form-sheet.tsx:70` | `<Button>` « Ajouter un chauffeur » | owner / admin |
| `join-link` | centrale (4) | `apps/web/components/network/join-link-card.tsx:61` | `<Card>` « Lien d'inscription » | page Réseau / Inscriptions |
| `live-new-ride` | flotte (4), centrale (5), dispatcher (2) | `apps/web/components/command/command-center.tsx:597` | `<Button>` « Nouvelle course » de l'en-tête du panneau | En direct |
| `live-panel` | dispatcher (1) | `apps/web/components/command/command-center.tsx:583` | `<aside>` panneau des courses | En direct |
| `team-add-member` | flotte (5) | `apps/web/components/settings/team-panel.tsx:117` | `<Button>` « Ajouter un membre » | `canInvite` |
| `rides-filters` | dispatcher (3) | `apps/web/app/dashboard/rides/page.tsx:172` | `<div className="space-y-3">` (filtres de statut et de type) | toujours |
| `messages-threads` | dispatcher (4) | `apps/web/components/chat/messages-view.tsx:457` | `<aside>` liste des conversations | liste affichée (téléphone : aucun fil ouvert) |
| `dispatch-journal` | dispatcher (5) | `apps/web/components/dispatch/dispatch-journal.tsx:87` | `<div className="surface …">` du journal | toujours |
| `fp-first-steps` | Flotte Privée (1) | `apps/web/components/private-fleet/private-home.tsx:205` | `<Card>` « Premiers pas » | tant qu'incomplet |
| `fp-to-treat` | Flotte Privée (2) | `apps/web/components/private-fleet/private-home.tsx:56` | `<Card>` « À traiter » | toujours |
| `fp-booking-settings` | Flotte Privée (3) | `apps/web/components/settings/private-booking-settings.tsx:41` | `<Card>` « Délais et rappels » | onglet `bookings` |
| `agenda-views` | Flotte Privée (4) | `apps/web/components/agenda/agenda-views.tsx:58` | `<nav aria-label="Vue de l'agenda">` | toujours |
| `fp-site-status` | Flotte Privée (5) | `apps/web/app/dashboard/site/page.tsx:67` | `<Card>` de l'état du site | toujours |

`Card` et `Button` transmettent les attributs au DOM (`{...props}`, vérifié dans `components/ui/card.tsx` et
`components/ui/button.tsx`). Aucune ancre dans la barre latérale (cachée sur téléphone). Les numéros de ligne sont ceux
de `a104a75` ; le test du § 11.1 contrôle les ancres par leur valeur, pas par leur ligne.

### 9.2 `data-tour-avoid` et `data-tour-fullheight` (attribut seul, posé en T2)

| Attribut | Fichier:ligne | Élément |
|---|---|---|
| `data-tour-avoid` | `apps/web/components/settings/pricing-editor.tsx:306` | barre collante « Enregistrer » de la grille |
| `data-tour-avoid` | `apps/web/components/settings/dispatch-settings-form.tsx:609` | barre collante « Enregistrer » du dispatch |
| `data-tour-avoid` | `apps/web/components/settlements/centrale-settings-form.tsx:380` | barre collante « Enregistrer » de la commission |
| `data-tour-avoid` | `apps/web/components/settlements/settlements-view.tsx:661` | barre collante de la sélection groupée (Encaissements) |
| `data-tour-avoid` | `apps/web/components/chat/composer.tsx:52` | compositeur des messages |
| `data-tour-fullheight` | `apps/web/components/command/command-center.tsx:516` | racine de la vue En direct (`relative flex h-[calc(100dvh-56px)] …`) |
| `data-tour-fullheight` | `apps/web/components/chat/messages-view.tsx:456` | racine de la vue Messages |

---

## 10. « Reprendre la visite » / « Revoir la visite »

- Entrée du **menu du compte** (le bouton nom + e-mail en bas de la barre latérale ; en bas du tiroir sur téléphone),
  avant « Se déconnecter », séparée par un trait ; icône `Compass` ; libellé par `tourMenuItem` (§ 5.4) : « Revoir la
  visite » si `completed`, sinon « Reprendre la visite » ; **absente** quand la visite est bloquée (§ 5.3) ou sans
  coquille de visite (`tour` absent).
- Effet : événement `resume` (§ 6.2) ; si la fenêtre est déjà ouverte, elle est dépliée et reçoit le focus ; le focus va
  au titre de la fenêtre (le menu ne le reprend pas) ; défilement vers l'ancre de l'étape si elle est sur la page.
- Aucune autre entrée (pas de « Visite guidée » dans le menu principal) : le menu principal reste celui de la refonte
  (tests `dashboard-nav.test.ts` et `admin-pages.test.ts` inchangés sur ce point).

---

## 11. Tests

### 11.1 Unitaires (`pnpm test`)

| Test | Lot | Ce qu'il vérifie |
|---|---|---|
| `packages/shared/src/tour.test.ts` | T1 | `TOUR_KEYS`, `TOUR_STATUSES` et `TOUR_MAX_STEPS - 1` identiques aux contraintes `tour in (…)`, `status in (…)`, `step between 0 and N` lues dans `20260924007800_guided_tour.sql` ; `tourKeyFor` (5 cas du § 5.1) ; `tourProgressSchema` (accepte / refuse : clé inconnue, statut inconnu, étape −1, 5, 1,5) ; `tourSavedFrom` (erreur → `undefined`, aucune ligne → `null`, `shown_at` → `shown`). |
| `apps/web/components/tour/tour-model.test.ts` | T2 | table du § 5.4 ligne par ligne ; chaque événement du § 6.2 (vue, état, écriture `tourPersist`, bornes, `resume` d'une visite jamais ouverte / terminée) ; `tourMenuItem` ; `samePage` (chemin, paramètres, ordre, paramètre en plus) ; `tourFooter` (5 cas du § 6.5, lien ou bouton selon l'écran, libellés, un seul principal) ; `dockedRect` (sans barre, avec barre dans la moitié basse, barre en haut ignorée, téléphone / bureau). |
| `apps/web/components/tour/tour-panel.test.ts` | T2 | rendu `renderToStaticMarkup` : accueil (liste des étapes, « Plus tard », « Commencer »), étape (compteur, titre `h2`, `aria-live`, « C'est fait. »), liens `href` attendus, boutons-icônes nommés, aucune couleur en dur, aucune taille < 12 px, espaces insécables. |
| `apps/web/components/tour/tour-actions.test.ts` | T2 | `saveTourProgress` (simulations de `@/lib/auth`, `@/lib/errors`) : entrée invalide refusée sans appel ; appel `rpc("save_user_tour", { p_tour, p_status, p_step })` ; erreur → `ok: false`. |
| `apps/web/components/tour/tour-checks.test.ts` | T3 | `settlementReady` (défaut lien + espèces sans lien → faux ; lien renseigné ; virement + IBAN ; autre + consignes ; espèces seules → vrai) ; `billingConfigured` ; `stepDone` ; `loadTourChecks` avec un client simulé : bonnes tables, colonnes, filtres, `head: true`, erreur → clé absente, rien lu hors des clés demandées. |
| `apps/web/components/tour/tour-content.test.ts` | T3 | règles du § 7.1 pour les 5 parcours ; **chaque ancre présente une fois** sous forme `data-tour="<id>"` (ou `data-tour={… "<id>"}`) dans `apps/web/app` et `apps/web/components` ; chaque adresse → `app/<chemin>/page.tsx` existant ; `tab` ∈ onglets de `app/dashboard/settings/page.tsx`, `filter` ∈ `RIDE_FILTERS` ; Flotte Privée ⊆ menu Flotte Privée (`dashboardNav`) ∪ `/dashboard/settings` ; dispatcher ⊆ menu du dispatcher ; aucune adresse de page refusée en Flotte Privée. |
| Existants adaptés | T2 | `dashboard-layout.test.ts` : nouvelles lectures et propriété `tour` (clé, `blocked` avec l'écran d'acceptation, `urgent` avec les réservations à traiter, filtres `user_id` et `tour`) sans cas retiré ; `admin-pages.test.ts` et `cookie-notice.test.ts` : simulations des nouveaux modules `@/…` seulement. |
| Existants inchangés et verts | T1–T3 | `migrations.test.ts`, `error-messages.test.ts`, `dashboard-links.test.ts` (préchargement, nouvel onglet : couvre `components/tour`), `aria-roles.test.ts`, `dashboard-nav.test.ts`, `private-fleet-guards.test.ts`, `primitives.test.ts`, `first-steps.test.ts`. |

### 11.2 Base (`TEST_DATABASE_NAME=rydar_test_<rôle> pnpm test:db`, T1 : `tests/db/user-tours.test.ts`)

1. Table : RLS active ; `has_table_privilege` : anon aucun droit ; authenticated SELECT seulement (ni INSERT, UPDATE,
   DELETE) ; service_role aucun droit.
2. `save_user_tour` (A) : crée `active`, 0, `shown_at` posé, `completed_at` nul ; puis étape 3 (`shown_at` inchangé,
   `updated_at` avance) ; `paused` ; `completed` (`completed_at` posé) ; de nouveau `active`, 0 (`completed_at` gardé).
3. Isolation : A lit ses lignes, pas celles de B (`select * from public.user_tours` sous A) ; B ne peut pas écrire pour A
   (aucun paramètre d'utilisateur).
4. Écriture directe refusée à authenticated (`insert`, `update`, `delete` → 42501).
5. anon : `select` de la table et appel de la RPC → 42501.
6. authenticated sans `sub` (`auth.uid()` nul) → `FORBIDDEN` 42501.
7. Valeurs invalides : parcours inconnu, statut inconnu, étape −1 et 5 → 23514 ; nuls → 23502.
8. Cascade : suppression du compte (`delete from auth.users`) → lignes effacées.
9. Fonction : `prosecdef`, `'search_path=""' = any (proconfig)` ; `has_function_privilege` : anon non, authenticated oui.
10. Rattrapage : le bloc entre `-- rattrapage : début` et `-- rattrapage : fin` du fichier de migration, rejoué en
    superutilisateur après création de : super admin sans adhésion (5 lignes `paused`, `shown_at` nul), dispatcher d'une
    organisation (5 lignes), compte sans adhésion ni rôle (aucune ligne), compte qui avait déjà une ligne `completed`
    (inchangée : `on conflict do nothing`).

### 11.3 Bout en bout (hors dépôt, `scratchpad/tutoriel/e2e/`)

- Outils : Chromium `executablePath: "/opt/pw-browsers/chromium"`, `playwright-core` (modules de
  `scratchpad/elig/node_modules`) ou les aides de `scratchpad/l7/e2e/lib.mjs` (`webLogin`, `check`, `q`) ; web en build
  de production (`pnpm --filter @rydar/web build` puis `next start --port 3210`, comme la refonte, § 9.1) ; profils et
  identifiants : ceux des scripts existants (`refonte/photo/shoot.mjs`, `l7/e2e/state.json`), **jamais dans le dépôt**.
- **Base de recette** : sur une base neuve (`l7/e2e/reset.sh`), chaque compte du seed verra la visite d'office ; les
  recettes existantes (`l7/e2e/run-all.sh`, `s10-smoke-standard`, `refonte/photo/shoot.mjs`, `mesure.mjs`) passent
  `scratchpad/tutoriel/tour-off.sql` après la réinitialisation **et** après `s1-create` (annexe A). Les scripts de la
  visite remettent à zéro le seul compte testé (`tour-reset.sql`). Le seed contient des courses sans chauffeur récentes :
  pour un gérant du seed, l'ouverture d'office est **différée** (c'est le cas « urgent » à vérifier) ; pour l'ouverture
  d'office, utiliser un client neuf (`s1-create`, Flotte Privée) ou passer ces courses en « Annulée » par SQL.
- Scénarios du moteur (T2, `TE-…`) et des parcours (T3, `TR-…`) : § 12.

---

## 12. Lots T1 à T3

### 12.0 Règles communes

- **Ordre imposé** : T1, puis T2, puis T3 ; un lot ne commence qu'après le précédent. Ne modifier que les chemins
  autorisés du lot ; toute autre nécessité est signalée, pas faite.
- `CLAUDE.md` et § 1.4 s'appliquent. Rien dans `apps/driver`, `apps/worker`, `supabase/seed.sql` ; aucune fonction SQL
  existante redéfinie ; aucune action serveur, garde ou RPC existante modifiée.
- Base locale : `PGPASSWORD=postgres` ; tests DB avec `TEST_DATABASE_NAME=rydar_test_<lot>` ; pile locale : si
  `127.0.0.1:54321` ne répond pas, `pg_ctlcluster 16 main start`, `redis-server --daemonize yes`, puis
  `bash scripts/local-stack/start.sh` et `bash scripts/dev-geo/start.sh` en arrière-plan (`setsid nohup`). La base locale
  « rydar » n'enregistre pas les migrations : appliquer 007800 à la main avec `psql -v ON_ERROR_STOP=1 -f …`.
- Shell : jamais `pkill -f <motif>` si le motif est dans la commande ; arrêt par PID.
- Contrôles minimaux de chaque lot : `pnpm typecheck` ; `pnpm test` ; `pnpm --filter @rydar/web build` (T2, T3) ;
  `TEST_DATABASE_NAME=rydar_test_<lot> pnpm test:db` (T1, T3).
- Commit (si le rôle le demande) : `git add` des seuls fichiers du lot, message en français, terminé par les lignes
  d'attribution de la session ; jamais de push ni de réécriture de l'historique ; chaque lot met à jour le § 12.1 et le
  § 13.3 de ce document et ajoute son compte rendu à `docs/EN-COURS.md`.

### 12.1 Tableau des lots

| Lot | Titre | Dépend de | Statut |
|---|---|---|---|
| T1 | Base et paquet partagé | — | à faire |
| T2 | Moteur de visite et intégration dans la coquille | T1 | à faire |
| T3 | Parcours sur les écrans réels (ancres, conditions, textes) et recette | T2 | à faire |

### T1 — Base et paquet partagé

- **Objectif** : la progression existe en base, protégée, écrite par une seule RPC, et ses valeurs sont partagées et
  contrôlées.
- **Chemins autorisés** : `supabase/migrations/20260924007800_guided_tour.sql` (nouveau) ;
  `tests/db/user-tours.test.ts` (nouveau) ; `packages/shared/src/tour.ts` et `packages/shared/src/tour.test.ts`
  (nouveaux) ; `packages/shared/src/index.ts` (une ligne `export * from "./tour";`) ; `docs/RGPD-REGISTRE.md` (une
  mention, § 4.5) ; `docs/TUTORIEL.md` (§ 12.1, § 13.3) ; `docs/EN-COURS.md`.
- **Changements** : migration du § 3 mot pour mot (commentaires compris, marqueurs de rattrapage) ; module du § 4.4 ;
  tests des § 11.1 (ligne T1) et § 11.2.
- **Critères d'acceptation** :
  1. `ls supabase/migrations | tail -1` = `20260924007800_guided_tour.sql` ; `migrations.test.ts` et
     `error-messages.test.ts` verts (aucun code d'erreur nouveau hors `FORBIDDEN`).
  2. Sur la base locale « rydar » : `psql -v ON_ERROR_STOP=1 -f supabase/migrations/20260924007800_guided_tour.sql`
     sans erreur ; ensuite `select count(*) from public.user_tours` = 5 × (comptes super admin ou membres) et aucune
     ligne `shown_at` non nulle.
  3. `tests/db/user-tours.test.ts` : les 10 points du § 11.2 ; suite `test:db` complète verte.
  4. `packages/shared/src/tour.test.ts` vert ; `tourKeyFor`, `tourProgressSchema`, `tourSavedFrom` exportés par
     `@rydar/shared`.
  5. `git diff --name-only` limité aux chemins autorisés ; rien sous `apps/`.
- **Contrôles** : `pnpm typecheck` ; `pnpm test` ; `TEST_DATABASE_NAME=rydar_test_t1 pnpm test:db` ; application de la
  migration sur « rydar » (critère 2).

### T2 — Moteur de visite et intégration dans la coquille

- **Objectif** : la visite s'ouvre au bon moment, s'enregistre, se reprend depuis le menu du compte, se lit au clavier et
  au lecteur d'écran, et tient à 390 px — avec les données des 5 parcours, en repli centré tant que les ancres ne sont
  pas posées (T3).
- **Chemins autorisés** :
  - nouveaux : `apps/web/components/tour/tour-model.ts`, `tour-model.test.ts`, `tour-content.ts`, `tour-checks.ts`
    (squelette), `tour-provider.tsx`, `tour-card.tsx`, `tour-panel.tsx`, `tour-panel.test.ts`, `tour-dom.ts`,
    `tour-actions.test.ts` ; `apps/web/app/visite/actions.ts` ;
  - coquille et mises en page : `apps/web/components/shell/sidebar.tsx` (propriété `accountItems`),
    `apps/web/components/shell/dashboard-shell.tsx`, `apps/web/components/shell/admin-shell.tsx`,
    `apps/web/app/dashboard/layout.tsx`, `apps/web/app/admin/layout.tsx` ;
  - `apps/web/app/globals.css` (règle `[data-tour-highlight]` dans `@layer components`, rien d'autre) ;
  - **attributs seuls** du § 9.2 : `apps/web/components/settings/pricing-editor.tsx`,
    `apps/web/components/settings/dispatch-settings-form.tsx`, `apps/web/components/settlements/centrale-settings-form.tsx`,
    `apps/web/components/settlements/settlements-view.tsx`, `apps/web/components/chat/composer.tsx`,
    `apps/web/components/command/command-center.tsx`, `apps/web/components/chat/messages-view.tsx` ;
  - tests existants (simulations et cas ajoutés seulement) : `apps/web/components/shell/dashboard-layout.test.ts`,
    `apps/web/components/admin/admin-pages.test.ts`, `apps/web/components/legal/cookie-notice.test.ts` ;
  - `docs/TUTORIEL.md` (§ 12.1, § 13.3), `docs/EN-COURS.md` ; hors dépôt : `scratchpad/tutoriel/**`.
- **Changements** : § 6 en entier, § 10, § 4.3 ; `tour-content.ts` = données du § 7 recopiées (accueils, étapes, ancres
  avec type et côté, conditions), textes par `fr()` ; `tour-checks.ts` = types `CheckKey` / `TourChecks` et
  `loadTourChecks` qui renvoie `{}`.
- **Critères d'acceptation** (navigateur, base locale, build de production) :
  1. **TE-01** Compte neuf (aucune ligne), CGU / CGV acceptées, rien d'urgent : l'accueil s'ouvre seul en moins de 2 s
     après le chargement, focus sur son titre ; en base : `active`, 0, `shown_at` posé ; recharger n'affiche plus
     l'accueil mais l'étape 1.
  2. **TE-02** Gérant dont l'organisation n'a jamais accepté les CGV : écran d'acceptation, **aucune** fenêtre ni entrée
     de menu ; après « Accepter », l'accueil s'ouvre sans recharger la page.
  3. **TE-03** Dispatcher du seed (bandeau des CGU ; ses courses sans chauffeur récentes passées en « Annulée » par SQL
     avant le scénario, sinon l'ouverture est différée comme en TE-09) : aucune fenêtre ni entrée tant que le bandeau est
     là ; après acceptation, l'accueil s'ouvre sans recharger la page.
  4. **TE-04** « Plus tard » : fenêtre fermée, toast « Visite en pause… », base `paused` ; rechargement : rien ; menu du
     compte « Reprendre la visite » : étape 1, focus sur son titre.
  5. **TE-05** « Ouvrir … » mène à l'écran de l'étape (vrai lien, `prefetch={false}`) ; la fenêtre suit ; « Suivant »
     depuis Réglages › Organisation modifié sans enregistrer ouvre « Quitter sans enregistrer ? » ; « Retour » laisse
     l'étape inchangée en base ; « Quitter sans enregistrer » avance et change de page.
  6. **TE-06** Échap avec le focus dans la fenêtre → pause ; Échap dans un champ de la page → la fenêtre reste ; un
     dialogue ouvert par-dessus (ex. « Ajouter un chauffeur ») ne ferme pas la fenêtre.
  7. **TE-07** « Réduire » → pastille 44 px en bas à gauche, rien d'enregistré ; pastille → fenêtre dépliée, même étape.
  8. **TE-08** « Terminer » à la dernière étape → `completed` (`completed_at` posé), toast, menu « Revoir la visite » →
     étape 1, `completed_at` inchangé.
  9. **TE-09** Course `NO_DRIVER_FOUND` récente dans l'organisation (ou réservation à traiter en Flotte Privée) : pas
     d'ouverture d'office ; l'entrée du menu fonctionne.
  10. **TE-10** 390×844 : repli centré, 16 px de marge, `scrollWidth <= 390` fenêtre ouverte et réduite, boutons ≥ 44 px ;
      tiroir → menu du compte → « Reprendre la visite » ferme le tiroir et place le focus sur le titre.
  11. **TE-11** Tarifs avec saisie en cours (barre collante visible) : le rectangle de la fenêtre ne coupe pas celui de la
      barre `[data-tour-avoid]` (1440×900 et 390×844) ; page qui défile : son dernier bouton peut passer au-dessus de la
      fenêtre (réserve `--tour-reserve`) ; En direct et Messages : aucune réserve (`data-tour-fullheight`).
  12. **TE-12** Clavier : tous les boutons atteints au Tab, focus visible ; nom accessible de la fenêtre
      « Visite guidée · étape N sur 5 … » ; aucune animation en boucle (`document.getAnimations()` vide une seconde après
      l'ouverture, hors indicateurs de chargement).
  13. **TE-13** Aucune requête vers un autre hôte que l'application et la pile locale ; aucune nouvelle clé dans
      `localStorage` / `sessionStorage` (liste comparée avant / après une visite complète).
  14. **TE-14** Super admin (ligne effacée) : accueil dans `/admin`, mêmes mécanismes ; un signalement de fraude ouvert
      diffère l'ouverture d'office.
  15. Tests du § 11.1 (lignes T2) verts ; `admin-pages.test.ts`, `dashboard-layout.test.ts`, `cookie-notice.test.ts`,
      `dashboard-links.test.ts`, `aria-roles.test.ts` verts sans cas retiré.
  16. `grep -rnE '#[0-9a-fA-F]{3,8}\b|localStorage|sessionStorage|router\.push|new Intl' apps/web/components/tour apps/web/app/visite`
      vide ; aucun `text-[10px]` / `text-[11px]` dans `components/tour`.
  17. `scratchpad/tutoriel/tour-off.sql` et `tour-reset.sql` écrits (annexe A) ; `l7/e2e/run-all.sh` puis
      `s10-smoke-standard` relancés après `tour-off.sql` : mêmes résultats qu'avant le lot (112 contrôles OK).
- **Contrôles** : `pnpm typecheck` ; `pnpm test` ; `pnpm --filter @rydar/web build` ; scénarios TE-01 à TE-14
  (`scratchpad/tutoriel/e2e/t2-*.mjs`) ; captures 1440×900 et 390×844 de l'accueil, d'une étape en repli, de la pastille
  et du menu du compte (`scratchpad/tutoriel/captures/t2/`) ; recette existante (critère 17).

### T3 — Parcours sur les écrans réels (ancres, conditions, textes) et recette

- **Objectif** : chaque étape des 5 parcours désigne l'élément réel, dit « C'est fait. » d'après la base quand c'est
  possible, et se lit juste sur l'écran ; recette complète et documentation.
- **Chemins autorisés** :
  - **attribut `data-tour` seul** (§ 9.1) : `apps/web/components/admin/legal-form.tsx`,
    `apps/web/components/platform-fees/admin-billing.tsx`, `apps/web/components/admin/admin-widgets.tsx` (bouton de
    `PlanEditor`), `apps/web/components/admin/new-client.tsx`, `apps/web/app/admin/page.tsx`,
    `apps/web/components/settings/organization-form.tsx`, `apps/web/components/settings/pricing-editor.tsx`,
    `apps/web/components/settlements/centrale-settings-form.tsx`, `apps/web/components/drivers/driver-form-sheet.tsx`,
    `apps/web/components/network/join-link-card.tsx`, `apps/web/components/command/command-center.tsx`,
    `apps/web/components/settings/team-panel.tsx`, `apps/web/app/dashboard/rides/page.tsx`,
    `apps/web/components/chat/messages-view.tsx`, `apps/web/components/dispatch/dispatch-journal.tsx`,
    `apps/web/components/private-fleet/private-home.tsx`, `apps/web/components/settings/private-booking-settings.tsx`,
    `apps/web/components/agenda/agenda-views.tsx`, `apps/web/app/dashboard/site/page.tsx` ;
  - `apps/web/components/tour/**` (conditions de réussite, contrôle et ajustement des textes, corrections du moteur
    révélées par la recette, signalées au § 13.3) ; nouveaux `tour-checks.test.ts`, `tour-content.test.ts` ;
  - `docs/TUTORIEL.md`, `docs/EN-COURS.md`, `docs/REFONTE-PANELS.md` (§ 10 et § 7 point 5 : statut et renvoi vers ce
    document) ; hors dépôt : `scratchpad/tutoriel/**`, adaptations des scripts de `scratchpad/l7/e2e` et
    `scratchpad/refonte/photo` (appel de `tour-off.sql`).
- **Changements** : 21 attributs du § 9.1 ; lectures du § 8 dans `loadTourChecks` (+ règles pures) ; textes du § 7
  contrôlés sur chaque écran, ajustés si un fait diffère (écart noté) ; tests du § 11.1 (lignes T3).
- **Critères d'acceptation** :
  1. **TR-01 à TR-05** — chaque parcours parcouru à 1440×900 sur la pile locale : pour chaque étape, « Ouvrir … » mène à
     l'écran ; la cible `[data-tour="<id>"]` porte `data-tour-highlight` ; contrôle : fenêtre ancrée à côté (rectangles
     sans chevauchement) ; zone : repli centré et zone amenée à l'écran ; « Y aller » place le focus dans la cible.
  2. **Actions réelles** (sur la base de recette, par l'utilisateur simulé) : flotte — identité complétée, grille
     enregistrée, chauffeur ajouté, course créée, membre invité ; centrale — identité, grille, lien de paiement, lien
     d'inscription créé, course créée ; dispatcher — course créée, course sans chauffeur attribuée ; Flotte Privée —
     réservation de son site prise par « Je la prends » (`s4-api` / `s6b-take`) ; super admin — éditeur complété,
     coordonnées de paiement, offre créée, client créé : « C'est fait. » apparaît en 6 s au plus après l'enregistrement,
     et le bouton principal devient « Suivant ».
  3. **TR-06** Les 5 parcours à 390×844 : repli centré partout, `scrollWidth <= 390`, cibles surlignées visibles sous la
     barre du haut ; captures de chaque étape (`scratchpad/tutoriel/captures/t3/<parcours>/`).
  4. **TR-07** Parcours complet en « Passer l'étape » seulement : comptes de `rides`, `drivers`, `organizations`,
     `pricing_rules`, `organization_users`, `api_keys`, `plans` identiques avant / après (aucune donnée créée par la
     visite) ; seule `user_tours` change.
  5. **TR-08** Flotte Privée : aucune adresse du parcours ne mène à un 404 ni à une redirection (`privateFleetPage`).
  6. **TR-09** Non-régression : `l7/e2e/run-all.sh` (avec `tour-off.sql`), `s10-smoke-standard`, `refonte/photo/shoot.mjs`
     et `mesure.mjs` pour les 5 profils : mêmes résultats qu'à la fin de la refonte (annexe A de la refonte).
  7. **TR-10** Accessibilité : noms, focus, Échap, `aria-live` vérifiés sur une étape de chaque parcours ; aucune
     animation en boucle ; aucun texte < 12 px.
  8. `tour-content.test.ts` et `tour-checks.test.ts` verts ; un attribut `data-tour` retiré d'un fichier fait échouer
     `tour-content.test.ts` (essayé puis remis).
  9. `git diff --stat` : dans les fichiers du § 9.1, seulement des lignes d'attribut `data-tour`.
- **Contrôles** : `pnpm typecheck` ; `pnpm test` ; `pnpm --filter @rydar/web build` ;
  `TEST_DATABASE_NAME=rydar_test_t3 pnpm test:db` ; scénarios TR-01 à TR-10 ; recette existante (TR-09) ; compte rendu
  dans `docs/EN-COURS.md`, statuts au § 12.1, écarts au § 13.3.

---

## 13. Décisions, risques, écarts

### 13.1 Décisions qui reviennent au propriétaire

1. **Comptes existants mis en pause** (rattrapage du § 3) : les clients actuels ne voient pas la visite d'office ; elle
   est dans leur menu. Pour qu'ils la voient aussi à leur prochaine connexion : retirer le bloc « rattrapage » **avant**
   que la migration soit poussée (ensuite : nouvelle migration).
2. **Pages légales** : la progression est une donnée de fonctionnement du compte, citée dans le registre interne
   (`docs/RGPD-REGISTRE.md`). Ajouter « avancement de la visite guidée » à l'article 4 de `/confidentialite`
   (« Utilisateurs du tableau de bord ») n'est pas fait par les lots : texte juridique, à décider avec la prochaine
   version (`LEGAL_VERSION`, qui ferait ré-accepter chaque utilisateur).
3. **`CLAUDE.md`** (non modifié par les lots) — ligne proposée pour « Métier » : « Visite guidée (007800,
   `docs/TUTORIEL.md`) : progression `user_tours` écrite par `save_user_tour` seulement ; ancres `data-tour`
   (`tour-content.test.ts`) ; jamais par-dessus CGU / CGV ; aucune clé de stockage ni outil tiers. »
4. Ajouter plus tard une étape « Frais Rydar » ou « Encaissements » : possible en remplaçant une étape (5 au plus) ;
   changer l'ordre des étapes déplace la reprise des visites en cours (index borné, sans erreur).

### 13.2 Risques et parades

| Risque | Parade |
|---|---|
| La fenêtre cache un contrôle | Repli centré au-dessus des `[data-tour-avoid]`, réserve de défilement, « Réduire », « × », jamais modale. |
| Recettes existantes gênées par l'ouverture d'office (comptes du seed sur base neuve) | `tour-off.sql` après chaque réinitialisation et après `s1-create` (annexe A) ; repère `data-tour-card` pour les scripts. |
| Mise en page non rendue à la navigation | L'état du fournisseur fait foi ; la mise en page ne fournit que le départ ; écritures en série. |
| Ancre supprimée par un futur changement d'écran | `tour-content.test.ts` échoue ; à défaut, repli centré (la visite reste utilisable). |
| Tests qui résolvent `@/…` à la main | Voisins de `components/tour` importés en relatif ; simulations ajoutées dans le même lot (T2). |
| Saisie perdue en suivant la visite | Navigation par vrais liens : la garde de saisie non enregistrée s'applique (TE-05). |
| Lecture des conditions coûteuse | 2 à 5 comptages `head`, seulement fenêtre dépliée et onglet visible ; rien quand la visite est fermée. |
| Déploiement du web avant la migration | Lecture en erreur → `saved` inconnu → aucune ouverture d'office ; écriture en échec → un toast ; aucun écran cassé. |

### 13.3 Écarts entre ce plan et le code livré

Aucun pour l'instant (rempli par chaque lot ; le code fait foi).

---

## Annexe A — SQL de recette (hors dépôt, `scratchpad/tutoriel/`)

`tour-off.sql` — met en pause la visite de tous les comptes (recettes qui ne testent pas la visite) :

```sql
insert into public.user_tours (user_id, tour, status, step)
select u.id, t.tour, 'paused', 0
  from public.users u
 cross join (values ('super_admin'), ('fleet'), ('centrale'), ('dispatcher'), ('private_fleet')) as t (tour)
on conflict (user_id, tour) do update set status = 'paused';
```

`tour-reset.sql` — rend « neuf » un seul compte (`psql -v email=… -f tour-reset.sql`) :

```sql
delete from public.user_tours where user_id = (select id from public.users where lower(email) = lower(:'email'));
```

Mesure sans traceur (en superutilisateur sur la base, agrégé, jamais affiché dans l'application) :

```sql
select tour, status, count(*) as comptes, count(shown_at) as ouvertes, count(completed_at) as terminees
  from public.user_tours group by tour, status order by tour, status;
```
